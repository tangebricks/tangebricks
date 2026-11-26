import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { assemble } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { semanticHash } from "@poc/blueprint";
import type { BlueprintBundle } from "@poc/blueprint";
import aiCreditsPresetRaw from "../../../presets/ai-credits-saas.blueprint.json?raw";
import b2bWorkspacePresetRaw from "../../../presets/b2b-workspace-app.blueprint.json?raw";
import marketplacePresetRaw from "../../../presets/marketplace.blueprint.json?raw";
import { app as studioApp, computeBuildHash } from "../src/index.ts";
import type { ProjectStatePayload, StudioApiEnv } from "../src/index.ts";
import { ensureTestAuthForPath } from "./project-token.ts";
import { isApprovalGatedPath, postOpsWithReview, sendWithOwnerApproval, withApprovalId } from "./human-session.ts";

const studioEnv = env as unknown as StudioApiEnv;
const rawDo = studioEnv.BLUEPRINT_DO;

function scopedEnv(scope: string): StudioApiEnv {
  return {
    ...studioEnv,
    BLUEPRINT_DO: {
      idFromName: (name: string) => rawDo.idFromName(`${scope}:${name}`),
      get: (id: DurableObjectId) => rawDo.get(id),
    } as unknown as DurableObjectNamespace,
  };
}

async function studioReq(
  path: string,
  init: RequestInit = {},
  targetEnv: StudioApiEnv = studioEnv,
): Promise<Response> {
  const { headers: authHeaders } = await ensureTestAuthForPath(targetEnv, path);
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(authHeaders)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  // AD-V8: an MCP token's import needs a Studio approval; the owner approves and the call is retried with its id.
  if (isApprovalGatedPath(path) && (init.method ?? "GET") === "POST") {
    const project = /\/api\/projects\/([^/]+)/.exec(path)![1]!;
    return sendWithOwnerApproval(targetEnv, project, async (approvalId) =>
      studioApp.request(path, { ...init, headers, body: withApprovalId(init.body, approvalId) as RequestInit["body"] }, targetEnv),
    );
  }
  return studioApp.request(path, { ...init, headers }, targetEnv);
}

async function postOps(
  project: string,
  ops: unknown[],
  targetEnv: StudioApiEnv = studioEnv,
) {
  // AD-V8: the token's edit applies when preview-safe; otherwise it is proposed and the owner accepts it in Studio.
  const { headers: authHeaders } = await ensureTestAuthForPath(targetEnv, `/api/projects/${project}/ops`);
  return postOpsWithReview(targetEnv, project, authHeaders, { author: { type: "human", id: "alice" }, ops });
}

describe("Story 1.6 — Deterministic saas.blueprint.json export and import round-trip", () => {
  test("project with bricks, configured settings, entities, workflows, and secretRefs exported from project-a and imported into project-b produces identical semanticHash and assemble() buildHash (AC 1, AC 2, AC 3, AC 4)", async () => {
    const projectA = "export-project-a";
    const projectB = "import-project-b";

    const setupOps = [
      { opId: "s-1", type: "enable_brick", brickId: "multi-workspace" },
      { opId: "s-2", type: "enable_brick", brickId: "core-auth" },
      { opId: "s-3", type: "set_identity", identity: "core-auth" },
      {
        opId: "s-4",
        type: "enable_brick",
        brickId: "credit-wallet",
        config: { creditsPerUnit: 25, minOrderAmount: 100 },
      },
      { opId: "s-5", type: "enable_brick", brickId: "dynamic-entities" },
      {
        opId: "s-6",
        type: "add_entity",
        entity: {
          name: "customers",
          fields: [
            { name: "email", type: "text", required: true, maxLength: 255 },
            { name: "tier", type: "enum", required: true, values: ["free", "pro", "enterprise"] },
          ],
        },
      },
      {
        opId: "s-7",
        type: "add_entity",
        entity: {
          name: "invoices",
          fields: [
            { name: "customer_email", type: "text", required: true, maxLength: 255 },
            { name: "amount_cents", type: "number", required: true, min: 0 },
          ],
        },
      },
      {
        opId: "s-8",
        type: "add_workflow",
        workflow: {
          id: "wf-invoice",
          name: "Invoice Processing",
          trigger: { kind: "manual" },
          nodes: [
            { id: "t1", type: "trigger.manual", label: "Trigger", data: {} },
            { id: "n1", type: "transform.pick", label: "Pick Customer", data: { path: "customer" } },
          ],
          edges: [{ id: "e1", source: "t1", target: "n1", sourceHandle: "out", targetHandle: "in" }],
        },
      },
      {
        opId: "s-9",
        type: "bind_secret_ref",
        ref: "sec_wallet_webhook",
        targetKind: "brick",
        targetId: "credit-wallet",
        secretName: "WEBHOOK_SECRET",
      },
      {
        opId: "s-9b",
        type: "bind_secret_ref",
        ref: "sec_better_auth_secret",
        targetKind: "brick",
        targetId: "core-auth",
        secretName: "BETTER_AUTH_SECRET",
      },
      {
        opId: "s-9c",
        type: "bind_secret_ref",
        ref: "sec_github_client_id",
        targetKind: "brick",
        targetId: "core-auth",
        secretName: "GITHUB_CLIENT_ID",
      },
      {
        opId: "s-9d",
        type: "bind_secret_ref",
        ref: "sec_github_client_secret",
        targetKind: "brick",
        targetId: "core-auth",
        secretName: "GITHUB_CLIENT_SECRET",
      },
      {
        opId: "s-10",
        type: "set_metadata",
        metadata: {
          displayName: "Roundtrip SaaS",
          layout: { t1: { x: 100, y: 120 }, n1: { x: 340, y: 120 } },
          viewport: { x: 0, y: 0, zoom: 1.0 },
        },
      },
    ];

    const seedRes = await postOps(projectA, setupOps);
    expect(seedRes.status).toBe(200);
    const stateA = (await seedRes.json()) as ProjectStatePayload;
    expect(stateA.revision).toBe(1);

    // Export from project-a
    const exportARes = await studioReq(
      `/api/projects/${projectA}/export`,
      { method: "GET" },
      studioEnv,
    );
    expect(exportARes.status).toBe(200);
    const bundleA = (await exportARes.json()) as BlueprintBundle;
    expect(bundleA.schemaVersion).toBe(2);
    expect(bundleA.project).toBe(projectA);
    expect(bundleA.exportedRevision).toEqual({
      revision: 1,
      semanticHash: stateA.semanticHash,
    });

    // Import into project-b (renamed slug)
    const importBRes = await studioReq(
      `/api/projects/${projectB}/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundle: bundleA,
          author: { type: "human", id: "bob" },
          mode: "create",
        }),
      },
      studioEnv,
    );
    expect(importBRes.status).toBe(200);
    const stateB = (await importBRes.json()) as ProjectStatePayload;
    expect(stateB.project).toBe(projectB);
    expect(stateB.revision).toBe(1);
    expect(stateB.readiness.ready).toBe(true);

    // Modulo project slug, semanticHash is identical
    expect(semanticHash({ ...stateB.state, project: projectA })).toBe(stateA.semanticHash);
    expect({ ...stateB.state, project: projectA }).toEqual(stateA.state);

    // Also import into an isolated DO namespace under the exact same project slug (`projectA`) to verify identical semanticHash and assemble() buildHash
    const targetIsoEnv = scopedEnv("imported-copy");
    const importSameSlugRes = await studioReq(
      `/api/projects/${projectA}/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundle: bundleA,
          author: { type: "human", id: "bob" },
          mode: "create",
        }),
      },
      targetIsoEnv,
    );
    expect(importSameSlugRes.status).toBe(200);
    const stateSameSlug = (await importSameSlugRes.json()) as ProjectStatePayload;
    expect(stateSameSlug.semanticHash).toBe(stateA.semanticHash);

    const buildARes = await studioReq(
      `/api/projects/${projectA}/build`,
      { method: "POST" },
      studioEnv,
    );
    const buildSameSlugRes = await studioReq(
      `/api/projects/${projectA}/build`,
      { method: "POST" },
      targetIsoEnv,
    );
    expect(buildARes.status).toBe(200);
    expect(buildSameSlugRes.status).toBe(200);
    const buildA = (await buildARes.json()) as { buildHash: string; files: number; bytes: number };
    const buildSameSlug = (await buildSameSlugRes.json()) as {
      buildHash: string;
      files: number;
      bytes: number;
    };
    expect(buildSameSlug.buildHash).toBe(buildA.buildHash);
    expect(buildSameSlug.files).toBe(buildA.files);
    expect(buildSameSlug.bytes).toBe(buildA.bytes);

    // Verify mode: "create" rejects importing over an existing project with 409
    const duplicateCreate = await studioReq(
      `/api/projects/${projectB}/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundle: bundleA,
          author: { type: "human", id: "bob" },
          mode: "create",
        }),
      },
      studioEnv,
    );
    expect(duplicateCreate.status).toBe(409);

    // Verify mode: "replace" overwrites an existing project cleanly at revision 2
    const replaceRes = await studioReq(
      `/api/projects/${projectB}/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundle: bundleA,
          author: { type: "human", id: "bob" },
          mode: "replace",
        }),
      },
      studioEnv,
    );
    expect(replaceRes.status).toBe(200);
    const replacedState = (await replaceRes.json()) as ProjectStatePayload;
    expect(replacedState.revision).toBe(2);
    expect(replacedState.semanticHash).toBe(stateB.semanticHash);
  });

  test("all 3 CP0 preset blueprints (ai-credits-saas, b2b-workspace-app, marketplace) import cleanly into BlueprintDO and assemble with the same buildHash as direct assemble() (AC 2, AC 3, AC 4)", async () => {
    const presets: Array<{ slug: string; rawJson: string }> = [
      { slug: "ai-credits-saas", rawJson: aiCreditsPresetRaw },
      { slug: "b2b-workspace-app", rawJson: b2bWorkspacePresetRaw },
      { slug: "marketplace", rawJson: marketplacePresetRaw },
    ];

    for (const preset of presets) {
      const presetObj = JSON.parse(preset.rawJson) as Record<string, unknown>;
      const directAssembled = assemble(presetObj, catalog);
      expect(directAssembled.ok, `direct assemble(${preset.slug}) should succeed`).toBe(true);
      if (!directAssembled.ok) continue;
      const directHash = await computeBuildHash(directAssembled.files);

      const importRes = await studioReq(
        `/api/projects/${preset.slug}/import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bundle: presetObj,
            author: { type: "human", id: "preset-loader" },
            mode: "create",
          }),
        },
        studioEnv,
      );
      expect(importRes.status, `import(${preset.slug}) should succeed with 200`).toBe(200);
      const imported = (await importRes.json()) as ProjectStatePayload;
      expect(imported.revision).toBe(1);
      expect(
        imported.readiness.needs.filter((n) => n.code !== "UNBOUND_BRICK_SECRET"),
      ).toEqual([]);

      const buildRes = await studioReq(
        `/api/projects/${preset.slug}/build`,
        { method: "POST" },
        studioEnv,
      );
      expect(buildRes.status).toBe(200);
      const built = (await buildRes.json()) as {
        project: string;
        revision: number;
        buildHash: string;
        files: number;
      };
      expect(built.buildHash, preset.slug).toBe(directHash);
      expect(built.files, preset.slug).toBe(Object.keys(directAssembled.files).length);
    }
  });

  test("export output contains zero raw credential strings and import rejects planted secret fixtures (AC 1, AC 4)", async () => {
    const project = "secret-hygiene-proj";
    const seed = await postOps(project, [
      { opId: "sh-1", type: "enable_brick", brickId: "multi-workspace" },
      { opId: "sh-2", type: "enable_brick", brickId: "credit-wallet" },
      {
        opId: "sh-3",
        type: "bind_secret_ref",
        ref: "sec_cashfree_webhook_secret",
        targetKind: "brick",
        targetId: "credit-wallet",
        secretName: "CASHFREE_WEBHOOK_SECRET",
      },
    ]);
    expect(seed.status).toBe(200);

    const exportRes = await studioReq(
      `/api/projects/${project}/export`,
      { method: "GET" },
      studioEnv,
    );
    expect(exportRes.status).toBe(200);
    const exportedText = await exportRes.text();
    expect(exportedText).toContain("sec_cashfree_webhook_secret");
    expect(exportedText).not.toMatch(
      /sk_live_|sk_test_|whsec_|ghp_|AKIA[0-9A-Z]{8,}|Bearer\s|-----BEGIN/i,
    );

    // Planted raw secret fixtures in import payload must be rejected with 422 VALIDATION_FAILED
    const plantedFixtures = [
      {
        project: "bad-secret-proj",
        bricks: ["credit-wallet"],
        secretRefs: [
          {
            ref: "sk_" + "live_51Nabc1234567890planted",
            targetKind: "brick",
            targetId: "credit-wallet",
            secretName: "STRIPE_SECRET",
          },
        ],
      },
      {
        project: "bad-secret-proj",
        bricks: [
          {
            id: "credit-wallet",
            config: { webhookSecret: "whs" + "ec_plantedRawWebhookSecretValue123" },
          },
        ],
      },
    ];

    for (const badBundle of plantedFixtures) {
      const badImport = await studioReq(
        `/api/projects/bad-secret-proj/import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bundle: badBundle,
            author: { type: "human", id: "mallory" },
          }),
        },
        studioEnv,
      );
      expect(badImport.status).toBe(422);
      const errBody = (await badImport.json()) as {
        error: { code: string; issues: Array<{ code: string }> };
      };
      expect(errBody.error.code).toBe("VALIDATION_FAILED");
      expect(errBody.error.issues.map((i) => i.code)).toContain("INVALID_SECRET_REF");
    }
  });
});
