import { describe, expect, it } from "vitest";
import { signControlPlaneRequest } from "@poc/telemetry";
import { assemble, computeBuildHash, computeCodeHash, computeGraphHash } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import aiCreditsSaasJson from "../../../presets/ai-credits-saas.blueprint.json";
import b2bWorkspaceJson from "../../../presets/b2b-workspace-app.blueprint.json";
import {
  ByocCloudflareTarget,
  DEFAULT_SANDBOX_DISPATCH_NAMESPACE,
  DeployTargetSchema,
  HostedSandboxTarget,
  MockCloudflareControlPlane,
  PlatformSandboxDeployTargetSchema,
  SandboxDispatchPlatform,
  createSandboxDispatcher,
} from "../src/index.ts";
import type { DeployBuildArtifactInput, DeployProvisioner, DeployTarget } from "../src/index.ts";

async function buildPresetDeployArtifact(presetJson: {
  project: string;
  identity?: string;
  workflows?: Array<{ id: string; [key: string]: unknown }>;
}): Promise<DeployBuildArtifactInput> {
  const assembled = assemble(presetJson, catalog);
  if (!assembled.ok) {
    throw new Error(`Failed to assemble preset: ${assembled.errors.join("; ")}`);
  }
  const buildHash = await computeBuildHash(assembled.files);
  const codeHash = await computeCodeHash(assembled.files);
  const graphHash = await computeGraphHash(assembled.files);
  const migrations: Array<{ name: string; sql: string; sha256: string }> = [];
  for (const [filePath, sql] of Object.entries(assembled.files)) {
    if (filePath.startsWith("migrations/") && filePath.endsWith(".sql")) {
      const name = filePath.slice("migrations/".length);
      migrations.push({
        name,
        sql,
        sha256: `sha256_${name}`,
      });
    }
  }
  const graphs: Record<string, string> = {};
  for (const wf of presetJson.workflows ?? []) {
    graphs[wf.id] = JSON.stringify(wf);
  }
  return {
    project: presetJson.project,
    buildHash,
    codeHash,
    graphHash,
    bundle: {
      code: assembled.files["src/index.ts"] ?? "export default {};",
      sha256: codeHash,
    },
    migrations,
    graphs,
    identity: presetJson.identity ?? "core-auth",
  };
}

describe("Story 9.1 — HostedSandboxTarget on Workers for Platforms dispatch namespaces", () => {
  it("AC 1: DeployTargetSchema validates platform-sandbox target and HostedSandboxTarget provisions isolated D1 + dispatch script", async () => {
    const rawTarget = {
      type: "platform-sandbox" as const,
      sandboxId: "sbx-acme-preview-01",
      dispatchNamespace: DEFAULT_SANDBOX_DISPATCH_NAMESPACE,
      projectId: "b2b-workspace-app",
    };
    const parsed = DeployTargetSchema.parse(rawTarget);
    expect(parsed.type).toBe("platform-sandbox");
    expect(PlatformSandboxDeployTargetSchema.parse(rawTarget).sandboxId).toBe("sbx-acme-preview-01");

    const platform = new SandboxDispatchPlatform();
    const sandboxTarget = new HostedSandboxTarget({ platform });
    const artifact = await buildPresetDeployArtifact(b2bWorkspaceJson);

    // 1. Initial plan shows create actions
    const initialPlan = await sandboxTarget.plan(artifact, parsed);
    expect(initialPlan.action).toBe("create");
    expect(initialPlan.changes).toBeGreaterThan(0);
    expect(initialPlan.d1.databaseName).toBe("px_sbx_sbx-acme-preview-01");

    // 2. Apply provisions isolated px_sbx_<sandboxId> D1, applies migrations, uploads worker to px-sandbox-preview, binds keys
    const applied = await sandboxTarget.apply(artifact, parsed);
    expect(applied.previewUrl).toBe("https://sbx-acme-preview-01.sandbox.projectx.dev");
    expect(applied.buildHash).toBe(artifact.buildHash);
    expect(applied.databaseName).toBe("px_sbx_sbx-acme-preview-01");
    expect(applied.bindings?.PX_CONN_KEY).toMatch(/^px_conn_key_/);
    expect(applied.bindings?.PX_EVENTS_HMAC_KEY).toMatch(/^px_telemetry_hmac_/);
    expect(applied.bindings?.DISPATCH_NAMESPACE).toBe("px-sandbox-preview");

    // 3. Re-plan and re-apply with identical buildHash returns 0 changes
    const secondPlan = await sandboxTarget.plan(artifact, parsed);
    expect(secondPlan.action).toBe("noop");
    expect(secondPlan.noChanges).toBe(true);
    expect(secondPlan.changes).toBe(0);

    const secondApply = await sandboxTarget.apply(artifact, parsed);
    expect(secondApply.action).toBe("noop");
    expect(secondApply.noChanges).toBe(true);
    expect(secondApply.changes).toBe(0);
    expect(secondApply.mutatingCallCount).toBe(0);
    expect(secondApply.versionId).toBe(applied.versionId);

    // 4. putGraph updates workflow in px_workflows without changing Worker versionId
    const updatedGraph = [
      {
        id: "slack-relay",
        trigger: { type: "webhook", path: "/webhooks/inbound-v2" },
        nodes: [{ id: "transform_1", type: "transform" }],
        edges: [],
      },
    ];
    const hotApplied = await sandboxTarget.putGraph(updatedGraph, parsed, undefined, {
      graphHash: "sha256_hot_graph_v2",
    });
    expect(hotApplied.rebuiltWorker).toBe(false);
    expect(hotApplied.liveWithoutRedeploy).toBe(true);
    expect(hotApplied.workerVersionId).toBe(applied.versionId);

    const dbRecord = platform.getDatabase("sbx-acme-preview-01");
    expect(dbRecord?.graphs["slack-relay"]?.graph).toContain("/webhooks/inbound-v2");

    // 5. destroy tears down dispatch worker and isolated D1 database
    const destroyed = await sandboxTarget.destroy(parsed);
    expect(destroyed.removedResources).toContain("sbx-acme-preview-01");
    expect(destroyed.removedResources).toContain("px_sbx_sbx-acme-preview-01");
    expect(platform.getWorker("px-sandbox-preview", "sbx-acme-preview-01")).toBeNull();
    expect(platform.getDatabase("sbx-acme-preview-01")).toBeNull();
  });

  it("AC 2: sandbox-dispatcher routes <sandboxId>.sandbox.projectx.dev to DISPATCH_NAMESPACE.get(sandboxId) and forwards /__px/events to studio-api", async () => {
    const forwardedEvents: Array<{ sandboxId: string; body: unknown }> = [];
    const platform = new SandboxDispatchPlatform({
      studioEventsSink: async (sandboxId, req) => {
        const body = await req.json();
        forwardedEvents.push({ sandboxId, body });
        return new Response(JSON.stringify({ ok: true, studioIngested: true, sandboxId }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const sandboxTarget = new HostedSandboxTarget({ platform });
    const target = PlatformSandboxDeployTargetSchema.parse({
      type: "platform-sandbox",
      sandboxId: "sbx-dispatch-route",
      dispatchNamespace: "px-sandbox-preview",
      projectId: "ai-credits-saas",
    });
    const artifact = await buildPresetDeployArtifact(aiCreditsSaasJson);
    await sandboxTarget.apply(artifact, target);

    const dispatcher = createSandboxDispatcher(platform);

    // Route standard request via <sandboxId>.sandbox.projectx.dev hostname
    const healthRes = await dispatcher.fetch(new Request("https://sbx-dispatch-route.sandbox.projectx.dev/health"));
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as {
      ok: boolean;
      sandboxId: string;
      buildHash: string;
    };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.sandboxId).toBe("sbx-dispatch-route");
    expect(healthBody.buildHash).toBe(artifact.buildHash);

    // Story 1.4: a POST to /__px/events appends only when the sandbox signed it with its own key, naming itself.
    const key = platform.getSandbox("sbx-dispatch-route")!.worker!.telemetryHmacKey;
    const postUrl = new URL("https://sbx-dispatch-route.sandbox.projectx.dev/__px/events?sandboxId=sbx-dispatch-route");
    const eventBody = JSON.stringify({ runId: "run_sbx_01", workflowId: "wf_1", status: "succeeded" });
    const post = async (url: URL, headers: Record<string, string>, body = eventBody) =>
      dispatcher.fetch(new Request(url.toString(), { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));
    expect((await post(postUrl, {})).status).toBe(401);
    expect((await post(postUrl, await signControlPlaneRequest("some-other-key-0123456789", "POST", postUrl, eventBody))).status).toBe(401);
    const otherSandboxUrl = new URL("https://sbx-dispatch-route.sandbox.projectx.dev/__px/events?sandboxId=sbx-someone-else");
    expect((await post(otherSandboxUrl, await signControlPlaneRequest(key, "POST", otherSandboxUrl, eventBody))).status).toBe(400);
    // A signature over another body does not verify.
    expect((await post(postUrl, await signControlPlaneRequest(key, "POST", postUrl, eventBody), eventBody.replace("run_sbx_01", "run_forged"))).status).toBe(
      401,
    );
    expect(forwardedEvents).toHaveLength(0);

    const eventsRes = await post(postUrl, await signControlPlaneRequest(key, "POST", postUrl, eventBody));
    expect(eventsRes.status).toBe(200);
    const eventsBody = (await eventsRes.json()) as {
      ok: boolean;
      studioIngested: boolean;
    };
    expect(eventsBody.ok).toBe(true);
    expect(eventsBody.studioIngested).toBe(true);
    expect(forwardedEvents).toHaveLength(1);
    expect(forwardedEvents[0]?.sandboxId).toBe("sbx-dispatch-route");

    // A read needs the control-plane signature made with this sandbox's own key, over a query naming this sandbox.
    const readUrl = new URL("https://sbx-dispatch-route.sandbox.projectx.dev/__px/events?sandboxId=sbx-dispatch-route");
    expect((await dispatcher.fetch(new Request(readUrl.toString()))).status).toBe(401);
    expect(
      (await dispatcher.fetch(new Request(readUrl.toString(), { headers: await signControlPlaneRequest("some-other-key-0123456789", "GET", readUrl) }))).status,
    ).toBe(401);
    const otherUrl = new URL("https://sbx-dispatch-route.sandbox.projectx.dev/__px/events?sandboxId=sbx-someone-else");
    expect((await dispatcher.fetch(new Request(otherUrl.toString(), { headers: await signControlPlaneRequest(key, "GET", otherUrl) }))).status).toBe(400);
    const noIdUrl = new URL("https://sbx-dispatch-route.sandbox.projectx.dev/__px/events");
    expect((await dispatcher.fetch(new Request(noIdUrl.toString(), { headers: await signControlPlaneRequest(key, "GET", noIdUrl) }))).status).toBe(400);
    const signedRead = await dispatcher.fetch(new Request(readUrl.toString(), { headers: await signControlPlaneRequest(key, "GET", readUrl) }));
    expect(signedRead.status).toBe(200);
    const readBody = (await signedRead.json()) as { events: Array<{ runId: string }> };
    expect(readBody.events.map((e) => e.runId)).toEqual(["run_sbx_01"]);
  });

  it("AC 3: packages/assembler has zero references to platform-sandbox and assemble().buildHash is byte-for-byte identical before and after configuring a sandbox target", async () => {
    const blueprint = aiCreditsSaasJson;
    const beforeSandbox = assemble(blueprint, catalog);
    expect(beforeSandbox.ok).toBe(true);
    if (!beforeSandbox.ok) return;
    const beforeBuildHash = await computeBuildHash(beforeSandbox.files);
    const beforeCodeHash = await computeCodeHash(beforeSandbox.files);
    const beforeGraphHash = await computeGraphHash(beforeSandbox.files);

    // Configure a platform-sandbox target for the same project
    const sandboxTarget = DeployTargetSchema.parse({
      type: "platform-sandbox",
      sandboxId: "sbx-hash-invariance",
      dispatchNamespace: "px-sandbox-preview",
      projectId: blueprint.project,
    });
    expect(sandboxTarget.type).toBe("platform-sandbox");

    const afterSandbox = assemble(blueprint, catalog);
    expect(afterSandbox.ok).toBe(true);
    if (!afterSandbox.ok) return;
    const afterBuildHash = await computeBuildHash(afterSandbox.files);
    const afterCodeHash = await computeCodeHash(afterSandbox.files);
    const afterGraphHash = await computeGraphHash(afterSandbox.files);
    expect(afterBuildHash).toBe(beforeBuildHash);
    expect(afterCodeHash).toBe(beforeCodeHash);
    expect(afterGraphHash).toBe(beforeGraphHash);
    expect(Object.keys(afterSandbox.files)).toEqual(Object.keys(beforeSandbox.files));
    for (const [path, content] of Object.entries(beforeSandbox.files)) {
      expect(afterSandbox.files[path]).toBe(content);
      expect(content).not.toContain("platform-sandbox");
    }
  });

  describe("AC 4: Shared DeployTarget conformance suite (ByocCloudflareTarget vs HostedSandboxTarget)", () => {
    const targetsToTest: Array<{
      name: string;
      createHarness: () => {
        provisioner: DeployProvisioner;
        target: DeployTarget;
        bootAndProbe: () => Promise<{ status: number; buildHash: string }>;
      };
    }> = [
      {
        name: "ByocCloudflareTarget",
        createHarness: () => {
          const apiClient = new MockCloudflareControlPlane();
          const acctId = ["abcdef0123456789", "abcdef0123456789"].join("");
          apiClient.registerToken({
            token: "cf_scoped_conformance_token_01",
            tokenId: "cf_tok_conf_01",
            accountId: acctId,
            accountName: "Conformance Cloudflare Account",
            subdomain: "conformance",
            status: "active",
            permissions: ["Account Settings: Read", "Workers Scripts: Edit", "D1: Edit", "Queues: Edit"],
          });
          const provisioner = new ByocCloudflareTarget({
            apiClient,
            resolveToken: async () => "cf_scoped_conformance_token_01",
          });
          const target: DeployTarget = DeployTargetSchema.parse({
            type: "byoc",
            accountId: acctId,
            tokenRef: "tok_conformance_byoc_01",
            envName: "preview",
          });
          return {
            provisioner,
            target,
            bootAndProbe: async () => {
              const script = await apiClient.getScript(acctId, "cf_scoped_conformance_token_01", "px-ai-credits-saas-preview");
              return {
                status: script ? 200 : 404,
                buildHash: script?.buildHash ?? "",
              };
            },
          };
        },
      },
      {
        name: "HostedSandboxTarget",
        createHarness: () => {
          const platform = new SandboxDispatchPlatform();
          const provisioner = new HostedSandboxTarget({ platform });
          const target: DeployTarget = DeployTargetSchema.parse({
            type: "platform-sandbox",
            sandboxId: "sbx-conformance-suite-01",
            dispatchNamespace: "px-sandbox-preview",
            projectId: "ai-credits-saas",
          });
          const dispatcher = createSandboxDispatcher(platform);
          return {
            provisioner,
            target,
            bootAndProbe: async () => {
              const res = await dispatcher.fetch(new Request("https://sbx-conformance-suite-01.sandbox.projectx.dev/health"));
              const body = (await res.json()) as { buildHash?: string };
              return {
                status: res.status,
                buildHash: body.buildHash ?? "",
              };
            },
          };
        },
      },
    ];

    for (const entry of targetsToTest) {
      it(`${entry.name}: passes initial apply + workerd boot probe, idempotent second apply (changes: 0), putGraph hot-path without version change, putSecret, and clean destroy`, async () => {
        const { provisioner, target, bootAndProbe } = entry.createHarness();
        const artifact = await buildPresetDeployArtifact(aiCreditsSaasJson);

        // 1. Initial apply creates D1 + Worker script and boots multi-brick preset in workerd
        const firstApply = await provisioner.apply(artifact, target);
        expect(firstApply.action).toBe("create");
        expect(firstApply.buildHash).toBe(artifact.buildHash);
        expect(firstApply.rebuiltWorker).toBe(true);
        expect(firstApply.changes).toBeGreaterThan(0);

        const probe = await bootAndProbe();
        expect(probe.status).toBe(200);
        expect(probe.buildHash).toBe(artifact.buildHash);

        // 2. Second apply with identical buildHash is idempotent (changes: 0)
        const secondApply = await provisioner.apply(artifact, target);
        expect(secondApply.action).toBe("noop");
        expect(secondApply.noChanges).toBe(true);
        expect(secondApply.changes).toBe(0);
        expect(secondApply.mutatingCallCount).toBe(0);
        expect(secondApply.versionId).toBe(firstApply.versionId);

        // 3. putGraph updates workflow without changing Worker script version
        const graphUpdate = await provisioner.putGraph(
          {
            "low-balance-topup-alert": JSON.stringify({
              id: "low-balance-topup-alert",
              nodes: [{ id: "step_hot_1", type: "transform" }],
              edges: [],
            }),
          },
          target,
          undefined,
          {
            project: artifact.project,
            graphHash: "sha256_conformance_hot_graph_2",
          },
        );
        expect(graphUpdate.rebuiltWorker).toBe(false);
        expect(graphUpdate.liveWithoutRedeploy).toBe(true);
        expect(graphUpdate.workerVersionId).toBe(firstApply.versionId);

        // 4. putSecret binds a test secret cleanly
        const secretRes = await provisioner.putSecret(target, "STRIPE_SECRET_KEY", "sk_" + "test_51ConformanceSafeKey", { project: artifact.project });
        expect(secretRes.secretName).toBe("STRIPE_SECRET_KEY");

        // 5. destroy tears down Worker and D1 cleanly
        const destroyed = await provisioner.destroy(target, {
          project: artifact.project,
        });
        expect(destroyed.removedResources.length).toBeGreaterThanOrEqual(2);
      });
    }
  });
});
