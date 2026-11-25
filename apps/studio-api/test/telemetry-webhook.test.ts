import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { GraphWorkflow, handleTelemetryEventsPullRequest, toyExecutors } from "@poc/runtime";
import type { Graph } from "@poc/runtime";
import { createRegistry } from "@poc/sdk";
import type { D1Like, Executor } from "@poc/sdk";
import {
  TELEMETRY_SIGNATURE_HEADER,
  TelemetryWsFrameSchema,
  ensureTelemetryTables,
  getRunRecord,
  insertStepEvent,
  insertStructuredLog,
  listStepEventsForRun,
  checkControlPlaneSignature,
  deriveProjectSecret,
  deriveProjectTelemetrySecret,
  signControlPlaneRequest,
  signTelemetryPayload,
  signTelemetryWebhook,
  upsertRunRecord,
} from "@poc/telemetry";
import { app, ensureStudioD1Schema } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { ensureTestProjectToken } from "./project-token.ts";

const rawEnv = env as unknown as StudioApiEnv;
const studioDb = rawEnv.STUDIO_DB as D1Like;
const workerDb = (rawEnv.DB ?? rawEnv.STUDIO_DB) as D1Like;

const TELEMETRY_SECRET = "px-studio-webhook-hmac-secret-2026";
const CANARY_SECRET_1 = "sk_live_canary_webhook_secret_102938";
const CANARY_SECRET_2 = "xox" + "b-canary-slack-bot-token-564738";
const CANARY_SECRET_3 = "whsec_canary_widget_signing_847362";

const testEnv: StudioApiEnv = {
  ...rawEnv,
  PX_TELEMETRY_SECRET: TELEMETRY_SECRET,
  BETTER_AUTH_SECRET: "studio-test-better-auth-secret-0123456789abcdef",
  PX_VAULT_KEY: "studio-test-aes-gcm-256-vault-master-key-99887766",
};

const workflowRegistry = createRegistry([
  {
    type: "trigger.manual",
    category: "trigger",
    inputs: [],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({}),
    secrets: [],
  },
  {
    type: "action.charge_customer",
    category: "action",
    sideEffects: "write",
    idempotent: true,
    inputs: [{ id: "in", dataType: "json" }],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({
      webhookSigningSecret: z.string().optional(),
    }),
    secrets: ["STRIPE_API_KEY"],
    secretFields: ["webhookSigningSecret"],
  },
  {
    type: "action.notify_slack",
    category: "action",
    inputs: [{ id: "in", dataType: "json" }],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({}),
    secrets: [],
  },
]);

describe("apps/studio-api — Telemetry HMAC webhook, BlueprintDO WebSocket broadcast, and cursor reconciliation", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioDb);
    await ensureTelemetryTables(workerDb);
    await studioDb.batch([
      studioDb.prepare("DELETE FROM px_step_events"),
      studioDb.prepare("DELETE FROM px_runs"),
    ]);
  });

  test("rejects missing or forged X-Px-Signature on POST /api/projects/:project/telemetry/webhook with HTTP 401", async () => {
    const project = "telemetry-auth-guard";
    const payload = JSON.stringify({
      project,
      events: [
        {
          eventId: "run_1:node_1:running:1",
          runId: "run_1",
          workflowId: "wf_1",
          revision: 1,
          workspaceId: "ws_test",
          nodeId: "node_1",
          status: "running",
          durationMs: 0,
          retries: 0,
          inputPreview: "{}",
          outputPreview: "{}",
          errorStack: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    // Missing X-Px-Signature -> 401
    const missingSigRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/telemetry/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
      testEnv,
    );
    expect(missingSigRes.status).toBe(401);

    // Forged X-Px-Signature -> 401
    const forgedSigRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/telemetry/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TELEMETRY_SIGNATURE_HEADER]:
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        },
        body: payload,
      }),
      testEnv,
    );
    expect(forgedSigRes.status).toBe(401);

    // WEBHOOK_PROJECT (story 1.4): a correctly signed payload that names another project, or none, is refused with 400
    // and nothing is written; the same payload naming this project is accepted and stamped with it.
    // Story 1.4: each project's webhook is signed with its own derived secret.
    const projectSecret = await deriveProjectTelemetrySecret(TELEMETRY_SECRET, project);
    const postSigned = (body: string) =>
      signTelemetryWebhook(body, projectSecret).then((sig) =>
        app.fetch(
          new Request(`http://localhost/api/projects/${project}/telemetry/webhook`, {
            method: "POST",
            headers: { "content-type": "application/json", [TELEMETRY_SIGNATURE_HEADER]: sig },
            body,
          }),
          testEnv,
        ),
      );
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const otherProject = await postSigned(JSON.stringify({ ...parsed, project: "some-other-project" }));
    expect(otherProject.status).toBe(400);
    expect(((await otherProject.json()) as { error: { code: string } }).error.code).toBe("PROJECT_MISMATCH");
    const { project: _omitted, ...withoutProject } = parsed;
    const noProject = await postSigned(JSON.stringify(withoutProject));
    expect(noProject.status).toBe(400);
    expect(((await noProject.json()) as { error: { code: string } }).error.code).toBe("PROJECT_REQUIRED");
    const written = await studioDb.prepare("SELECT COUNT(*) AS c FROM px_step_events WHERE run_id = 'run_1'").first<{ c: number }>();
    expect(Number(written?.c ?? 0)).toBe(0);

    const sameProject = await postSigned(payload);
    expect(sameProject.status).toBe(200);
    const stamped = await studioDb
      .prepare("SELECT project_id, workspace_id FROM px_step_events WHERE run_id = 'run_1'")
      .first<{ project_id: string; workspace_id: string }>();
    expect(stamped).toEqual({ project_id: project, workspace_id: "ws_test" });

    // The shared root secret signs no project's webhook.
    const rootSigned = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/telemetry/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryPayload(payload, TELEMETRY_SECRET) },
        body: payload,
      }),
      testEnv,
    );
    expect(rootSigned.status).toBe(401);
    // Without Studio's root secret the webhook cannot be verified: 503 NOT_CONFIGURED, not a 500.
    const noRoot = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/telemetry/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryWebhook(payload, projectSecret) },
        body: payload,
      }),
      { ...testEnv, PX_TELEMETRY_SECRET: undefined } as unknown as StudioApiEnv,
    );
    expect(noRoot.status).toBe(503);
    // Story 1.17: nor does the root secret with the webhook domain, nor a body-only HMAC with the project's own secret, nor
    // a control-plane signature made with it (cross-purpose).
    for (const headers of [
      { [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryWebhook(payload, TELEMETRY_SECRET) },
      { [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryPayload(payload, projectSecret) },
      await signControlPlaneRequest(projectSecret, "POST", `/api/projects/${project}/telemetry/webhook`, payload),
      await signControlPlaneRequest(await deriveProjectSecret(TELEMETRY_SECRET, project, "control-plane"), "POST", `/api/projects/${project}/telemetry/webhook`, payload),
    ]) {
      const refused = await app.fetch(
        new Request(`http://localhost/api/projects/${project}/telemetry/webhook`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: payload,
        }),
        testEnv,
      );
      expect(refused.status).toBe(401);
    }

    // ID_COLLISION: another project's webhook reusing this event's id is refused with 409, writes nothing and
    // broadcasts nothing; this project's row is unchanged.
    const other = "telemetry-auth-guard-other";
    const otherPayload = JSON.stringify({
      ...parsed,
      project: other,
      events: [{ ...(parsed.events as Array<Record<string, unknown>>)[0], status: "failed" }],
    });
    const collided = await app.fetch(
      new Request(`http://localhost/api/projects/${other}/telemetry/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryWebhook(otherPayload, await deriveProjectTelemetrySecret(TELEMETRY_SECRET, other)),
        },
        body: otherPayload,
      }),
      testEnv,
    );
    expect(collided.status).toBe(409);
    const collidedBody = (await collided.json()) as { error: { code: string }; broadcastedCount?: number };
    expect(collidedBody.error.code).toBe("ID_COLLISION");
    expect(collidedBody.broadcastedCount).toBeUndefined();
    const kept = await studioDb
      .prepare("SELECT project_id, status FROM px_step_events WHERE event_id = 'run_1:node_1:running:1'")
      .all<{ project_id: string; status: string }>();
    expect(kept.results).toEqual([{ project_id: project, status: "running" }]);
  });

  test("3-node workflow (happy path & failing retry path) pushes signed webhooks to BlueprintDO, broadcasts telemetry frames over WebSockets, and never leaks canary secrets", async () => {
    const project = "telemetry-live-ws";
    const { headers: authHeaders } = await ensureTestProjectToken(testEnv, project);

    // Initialize project state
    const initRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/ops`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          author: { type: "human", id: "alice" },
          ops: [
            {
              opId: "op-init-1",
              type: "enable_brick",
              brickId: "multi-workspace",
            },
          ],
        }),
      }),
      testEnv,
    );
    expect(initRes.status).toBe(200);

    // Connect a hibernating WebSocket subscribed to the project
    const wsRes = await app.fetch(
      new Request(`http://localhost/api/projects/${project}/ws`, {
        headers: {
          ...authHeaders,
          Upgrade: "websocket",
        },
      }),
      testEnv,
    );
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket!;
    expect(ws).toBeDefined();
    ws.accept();

    const receivedFrames: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (evt) => {
      const data = typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer);
      receivedFrames.push(JSON.parse(data) as Record<string, unknown>);
    });

    // 1. Run 3-node happy-path workflow that accesses secrets and connections
    const happyExecutors = new Map<string, Executor>([
      ...toyExecutors,
      [
        "action.charge_customer",
        ({ inputs, secret, connection }) => {
          const stripeKey = secret("STRIPE_API_KEY");
          const slackConn = connection ? connection<{ token: string }>("slack") : { token: "" };
          return {
            out: {
              order: inputs.in,
              chargeId: "ch_999",
              authorizationEcho: `Bearer ${stripeKey}`,
              b64Echo: btoa(stripeKey),
              urlEncodedConn: encodeURIComponent(slackConn.token),
              headers: {
                Authorization: `Bearer ${stripeKey}`,
                "X-Api-Key": slackConn.token,
              },
            },
          };
        },
      ],
      [
        "action.notify_slack",
        ({ inputs }) => ({
          out: { notified: true, details: inputs.in },
        }),
      ],
    ]);

    const graph: Graph = {
      nodes: [
        { id: "step_trigger", type: "trigger.manual", data: {} },
        {
          id: "step_charge",
          type: "action.charge_customer",
          data: { webhookSigningSecret: CANARY_SECRET_3 },
        },
        { id: "step_notify", type: "action.notify_slack", data: {} },
      ],
      edges: [
        {
          id: "e1",
          source: "step_trigger",
          sourceHandle: "out",
          target: "step_charge",
          targetHandle: "in",
        },
        {
          id: "e2",
          source: "step_charge",
          sourceHandle: "out",
          target: "step_notify",
          targetHandle: "in",
        },
      ],
    };

    const happyWorkflow = new GraphWorkflow(workflowRegistry, happyExecutors);
    const happyResult = await happyWorkflow.start({ workspaceId: "ws_test",
      graph,
      payload: { customer: "cust_42", totalCents: 4900 },
      env: {
        DB: workerDb,
        STRIPE_API_KEY: CANARY_SECRET_1,
        PX_TELEMETRY_SECRET: TELEMETRY_SECRET,
      },
      connections: {
        slack: { token: CANARY_SECRET_2 },
      },
      telemetry: {
        db: workerDb,
        runId: "run_ws_happy_1",
        workflowId: "wf_billing",
        revision: 1,
        project,
        telemetrySecret: TELEMETRY_SECRET,
        webhookSecret: await deriveProjectTelemetrySecret(TELEMETRY_SECRET, project),
        webhookUrl: `http://localhost/api/projects/${project}/telemetry/webhook`,
        webhookFetcher: async (input, init) =>
          app.fetch(new Request(String(input), init), testEnv),
      },
    });

    expect(happyResult.ok).toBe(true);

    const telemetryFrames = receivedFrames.filter((f) => f.type === "telemetry");
    // 3 nodes * 3 statuses (queued, running, succeeded) = 9 telemetry WebSocket frames
    expect(telemetryFrames.length).toBeGreaterThanOrEqual(9);

    for (const frame of telemetryFrames) {
      const parsed = TelemetryWsFrameSchema.parse(frame);
      expect(parsed.project).toBe(project);
      expect(parsed.rev).toBe(1);
      expect(parsed.runId).toBe("run_ws_happy_1");
      expect(parsed.workflowId).toBe("wf_billing");
    }

    // 2. Run 3-node failing workflow with retries (limit: 2)
    let failAttempts = 0;
    const failingExecutors = new Map<string, Executor>([
      ...toyExecutors,
      [
        "action.charge_customer",
        ({ secret }) => {
          failAttempts += 1;
          const stripeKey = secret("STRIPE_API_KEY");
          throw new Error(`Card processor declined with credential ${stripeKey} (try ${failAttempts})`);
        },
      ],
      ["action.notify_slack", ({ inputs }) => ({ out: inputs.in })],
    ]);

    const failingWorkflow = new GraphWorkflow(workflowRegistry, failingExecutors);
    const failResult = await failingWorkflow.start({ workspaceId: "ws_test",
      graph,
      payload: { customer: "cust_fail", totalCents: 9900 },
      env: {
        DB: workerDb,
        STRIPE_API_KEY: CANARY_SECRET_1,
        PX_TELEMETRY_SECRET: TELEMETRY_SECRET,
      },
      connections: {
        slack: { token: CANARY_SECRET_2 },
      },
      telemetry: {
        db: workerDb,
        runId: "run_ws_fail_2",
        workflowId: "wf_billing",
        revision: 1,
        project,
        telemetrySecret: TELEMETRY_SECRET,
        webhookSecret: await deriveProjectTelemetrySecret(TELEMETRY_SECRET, project),
        stepRetries: {
          step_charge: { limit: 2, delayMs: 1 },
        },
        webhookUrl: `http://localhost/api/projects/${project}/telemetry/webhook`,
        webhookFetcher: async (input, init) =>
          app.fetch(new Request(String(input), init), testEnv),
      },
    });

    expect(failResult.ok).toBe(false);
    expect(failAttempts).toBe(3);

    // Check D1 run & step event rows for both runs
    const storedHappyRun = await getRunRecord(studioDb, "run_ws_happy_1", { projectId: project });
    expect(storedHappyRun?.status).toBe("succeeded");

    const storedFailRun = await getRunRecord(studioDb, "run_ws_fail_2", { projectId: project });
    expect(storedFailRun?.status).toBe("failed");
    expect(storedFailRun?.retries).toBe(2);
    expect(storedFailRun?.errorStack).toContain("[REDACTED]");

    const failEvents = await listStepEventsForRun(studioDb, "run_ws_fail_2", { projectId: project });
    const failedStep = failEvents.find(
      (e) => e.nodeId === "step_charge" && e.status === "failed",
    );
    expect(failedStep?.retries).toBe(2);
    const skippedStep = failEvents.find(
      (e) => e.nodeId === "step_notify" && e.status === "skipped",
    );
    expect(skippedStep).toBeDefined();

    // Verify ZERO canary secrets appear anywhere in WebSocket frames or D1 tables
    const wsDump = JSON.stringify(receivedFrames);
    const d1Dump = JSON.stringify({
      storedHappyRun,
      storedFailRun,
      happyEvents: await listStepEventsForRun(studioDb, "run_ws_happy_1", { projectId: project }),
      failEvents,
    });

    for (const canary of [
      CANARY_SECRET_1,
      btoa(CANARY_SECRET_1),
      CANARY_SECRET_2,
      encodeURIComponent(CANARY_SECRET_2),
      CANARY_SECRET_3,
    ]) {
      expect(wsDump).not.toContain(canary);
      expect(d1Dump).not.toContain(canary);
    }

    ws.close();
  });

  test("Worker GET /__px/events?after=<cursor>&limit=<n> and studio-api GET /api/projects/:project/telemetry/events support cursor pull reconciliation", async () => {
    const project = "telemetry-cursor-reconcile";
    const { headers: authHeaders } = await ensureTestProjectToken(testEnv, project);

    // Ensure project exists
    await app.fetch(
      new Request(`http://localhost/api/projects/${project}/ops`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          author: { type: "human", id: "alice" },
          ops: [
            {
              opId: "op-init-reconcile",
              type: "enable_brick",
              brickId: "multi-workspace",
            },
          ],
        }),
      }),
      testEnv,
    );

    // Run a 3-node workflow that pushes events
    const workflow = new GraphWorkflow(workflowRegistry, new Map([
      ...toyExecutors,
      ["action.charge_customer", ({ inputs }) => ({ out: inputs.in })],
      ["action.notify_slack", ({ inputs }) => ({ out: inputs.in })],
    ]));

    await workflow.start({ workspaceId: "ws_test",
      graph: {
        nodes: [
          { id: "n1", type: "trigger.manual", data: {} },
          { id: "n2", type: "action.charge_customer", data: {} },
          { id: "n3", type: "action.notify_slack", data: {} },
        ],
        edges: [
          { id: "e1", source: "n1", sourceHandle: "out", target: "n2", targetHandle: "in" },
          { id: "e2", source: "n2", sourceHandle: "out", target: "n3", targetHandle: "in" },
        ],
      },
      payload: { hello: "world" },
      env: {
        DB: workerDb,
        PX_TELEMETRY_SECRET: TELEMETRY_SECRET,
      },
      telemetry: {
        db: workerDb,
        runId: "run_reconcile_1",
        workflowId: "wf_reconcile",
        revision: 2,
        project,
        telemetrySecret: TELEMETRY_SECRET,
        webhookSecret: await deriveProjectTelemetrySecret(TELEMETRY_SECRET, project),
        webhookUrl: `http://localhost/api/projects/${project}/telemetry/webhook`,
        webhookFetcher: async (input, init) =>
          app.fetch(new Request(String(input), init), testEnv),
      },
    });

    // Verify Worker shell GET /__px/events?workspaceId=ws_test&after=0&limit=4 with a valid control-plane signature
    const pullUrl = new URL("http://worker.local/__px/events?workspaceId=ws_test&after=0&limit=4");
    const workerPullRes = await handleTelemetryEventsPullRequest(
      new Request(pullUrl.toString(), {
        headers: await signControlPlaneRequest(TELEMETRY_SECRET, "GET", pullUrl),
      }),
      { db: workerDb, telemetrySecret: TELEMETRY_SECRET },
    );
    expect(workerPullRes?.status).toBe(200);
    const workerPullBody = (await workerPullRes!.json()) as {
      ok: boolean;
      events: Array<{ runId: string }>;
      nextCursor: number;
      hasMore: boolean;
    };
    expect(workerPullBody.ok).toBe(true);
    expect(workerPullBody.events).toHaveLength(4);
    expect(workerPullBody.hasMore).toBe(true);

    // Query studio-api GET /api/projects/:project/telemetry/events?after=0&limit=20
    const studioEventsRes = await app.fetch(
      new Request(
        `http://localhost/api/projects/${project}/telemetry/events?runId=run_reconcile_1`,
        {
          headers: authHeaders,
        },
      ),
      testEnv,
    );
    expect(studioEventsRes.status).toBe(200);
    const studioEventsBody = (await studioEventsRes.json()) as {
      project: string;
      events: Array<{ nodeId: string; status: string }>;
    };
    expect(studioEventsBody.project).toBe(project);
    expect(studioEventsBody.events).toHaveLength(9);
  });

  test("story 1.4: a colliding id refuses the whole write with 409 (webhook, reconcile, health seed); reconcile without a signing secret is 503", async () => {
    const owner = "telemetry-collision-owner";
    const intruder = "telemetry-collision-intruder";
    const now = new Date().toISOString();
    const ownerRun = { runId: "run_owned_by_owner", workflowId: "wf", revision: 0, triggerType: "manual", workspaceId: "ws_default", status: "succeeded" as const, durationMs: 1, retries: 0, startedAt: now };
    await upsertRunRecord(studioDb, ownerRun, { projectId: owner });
    await insertStepEvent(
      studioDb,
      { eventId: "ev_owned_by_owner", runId: ownerRun.runId, workflowId: "wf", revision: 0, workspaceId: "ws_default", nodeId: "n", status: "succeeded", durationMs: 1, retries: 0, inputPreview: "{}", outputPreview: "{}", errorStack: null, createdAt: now },
      { projectId: owner },
    );
    await insertStructuredLog(studioDb, { logId: "log_owned_by_owner", level: "info", message: "owner", workspaceId: "ws_default" }, {}, { projectId: owner });
    const runStored = async (runId: string) =>
      Number((await studioDb.prepare("SELECT COUNT(*) AS c FROM px_runs WHERE run_id = ?").bind(runId).first<{ c: number }>())?.c ?? 0);

    // Webhook: a fresh run with a colliding event id (or log id) is refused whole; the fresh run is not stored.
    const intruderSecret = await deriveProjectTelemetrySecret(TELEMETRY_SECRET, intruder);
    const postWebhook = async (body: Record<string, unknown>) => {
      const text = JSON.stringify(body);
      return app.fetch(
        new Request(`http://localhost/api/projects/${intruder}/telemetry/webhook`, {
          method: "POST",
          headers: { "content-type": "application/json", [TELEMETRY_SIGNATURE_HEADER]: await signTelemetryWebhook(text, intruderSecret) },
          body: text,
        }),
        testEnv,
      );
    };
    const freshRun = { ...ownerRun, runId: "run_fresh_intruder" };
    const evCollision = await postWebhook({
      project: intruder,
      run: freshRun,
      events: [{ eventId: "ev_owned_by_owner", runId: freshRun.runId, workflowId: "wf", revision: 0, workspaceId: "ws_default", nodeId: "n", status: "failed", durationMs: 1, retries: 0, inputPreview: "{}", outputPreview: "{}", errorStack: null, createdAt: now }],
    });
    expect(evCollision.status).toBe(409);
    expect(((await evCollision.json()) as { error: { code: string } }).error.code).toBe("ID_COLLISION");
    expect(await runStored(freshRun.runId)).toBe(0);
    const logCollision = await postWebhook({
      project: intruder,
      run: freshRun,
      events: [],
      logs: [{ logId: "log_owned_by_owner", ts: now, level: "info", message: "intruder", workspaceId: "ws_default", fields: {}, fieldsJson: "{}" }],
    });
    expect(logCollision.status).toBe(409);
    expect(await runStored(freshRun.runId)).toBe(0);

    // Health seed: a run id held by another project is 409 (not 500) and nothing of the seed is written.
    const { headers: intruderHeaders } = await ensureTestProjectToken(testEnv, intruder);
    const seed = await app.fetch(
      new Request(`http://localhost/api/projects/${intruder}/environments/preview/health/seed`, {
        method: "POST",
        headers: { ...intruderHeaders, "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws_default", runs: [ownerRun, { ...ownerRun, runId: "run_seed_fresh" }] }),
      }),
      testEnv,
    );
    expect(seed.status).toBe(409);
    expect(await runStored("run_seed_fresh")).toBe(0);

    // Reconcile: pulls from the project's registered target only; a colliding pulled id is 409, nothing written.
    const orgRow = await studioDb.prepare("SELECT org_id FROM projects WHERE project_id = ?").bind(intruder).first<{ org_id: string }>();
    await studioDb
      .prepare(
        `INSERT INTO project_deployments (deploy_id, project_id, org_id, env_name, revision, build_hash, code_hash, graph_hash, action, worker_url, version_id, database_id, actor_id, state_json, created_at)
         VALUES (?, ?, ?, 'preview', 1, 'b', 'c', 'g', 'deploy', 'https://intruder-target.example', 'v', 'd', 'a', '{}', ?)`,
      )
      .bind(`dep_${crypto.randomUUID()}`, intruder, orgRow!.org_id, now)
      .run();
    const reconcile = (env: StudioApiEnv) =>
      app.fetch(
        new Request(`http://localhost/api/projects/${intruder}/telemetry/reconcile`, {
          method: "POST",
          headers: { ...intruderHeaders, "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: "ws_default" }),
        }),
        env,
      );
    const noSecret = await reconcile({ ...testEnv, PX_TELEMETRY_SECRET: undefined } as unknown as StudioApiEnv);
    expect(noSecret.status).toBe(503);
    expect(((await noSecret.json()) as { error: { code: string } }).error.code).toBe("NOT_CONFIGURED");

    const realFetch = globalThis.fetch;
    const pulledFrom: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      pulledFrom.push(String(input instanceof Request ? input.url : input));
      return Response.json({
        runs: [{ ...ownerRun, runId: "run_reconcile_fresh" }],
        events: [{ eventId: "ev_owned_by_owner", runId: "run_reconcile_fresh", workflowId: "wf", revision: 0, workspaceId: "ws_default", nodeId: "n", status: "failed", durationMs: 1, retries: 0, inputPreview: "{}", outputPreview: "{}", errorStack: null, createdAt: now }],
      });
    }) as typeof fetch;
    try {
      const collided = await reconcile(testEnv);
      expect(collided.status).toBe(409);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(pulledFrom[0]).toMatch(/^https:\/\/intruder-target\.example\/__px\/events\?workspaceId=ws_default/);
    expect(await runStored("run_reconcile_fresh")).toBe(0);

    // Story 1.17: a valid tenant workspace Studio has never seen is accepted and pulled; the pull is signed with the
    // project's derived control-plane secret (never the root), and only the pulled workspace's rows are kept, stamped
    // with the project.
    const unseen = "ws_never_seen_by_studio";
    const pulls: Request[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      pulls.push(new Request(String(input instanceof Request ? input.url : input), init));
      return Response.json({
        runs: [
          { ...ownerRun, runId: "run_unseen_ws_1", workspaceId: unseen },
          { ...ownerRun, runId: "run_unseen_other_ws", workspaceId: "ws_someone_else" },
        ],
        events: [],
      });
    }) as typeof fetch;
    try {
      const unseenRes = await app.fetch(
        new Request(`http://localhost/api/projects/${intruder}/telemetry/reconcile`, {
          method: "POST",
          headers: { ...intruderHeaders, "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: unseen }),
        }),
        testEnv,
      );
      expect(unseenRes.status).toBe(200);
      const malformed = await app.fetch(
        new Request(`http://localhost/api/projects/${intruder}/telemetry/reconcile`, {
          method: "POST",
          headers: { ...intruderHeaders, "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: "ws a" }),
        }),
        testEnv,
      );
      expect(malformed.status).toBe(400);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(pulls).toHaveLength(1);
    const derived = await deriveProjectSecret(TELEMETRY_SECRET, intruder, "control-plane");
    expect(await checkControlPlaneSignature(pulls[0]!, { secret: derived })).toBeNull();
    expect(await checkControlPlaneSignature(pulls[0]!, { secret: TELEMETRY_SECRET })).not.toBeNull();
    // Another project's worker (holding its own derived secret) refuses the pull Studio signed for this project.
    expect(await checkControlPlaneSignature(pulls[0]!, { secret: await deriveProjectSecret(TELEMETRY_SECRET, owner, "control-plane") })).not.toBeNull();
    const kept = await studioDb
      .prepare("SELECT run_id, project_id, workspace_id FROM px_runs WHERE run_id IN ('run_unseen_ws_1', 'run_unseen_other_ws')")
      .all<{ run_id: string; project_id: string; workspace_id: string }>();
    expect(kept.results).toEqual([{ run_id: "run_unseen_ws_1", project_id: intruder, workspace_id: unseen }]);
  });
});
