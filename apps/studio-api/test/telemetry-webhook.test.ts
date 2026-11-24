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
  canonicalEventsCursorPayload,
  ensureTelemetryTables,
  getRunRecord,
  listStepEventsForRun,
  signTelemetryPayload,
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
    const storedHappyRun = await getRunRecord(studioDb, "run_ws_happy_1");
    expect(storedHappyRun?.status).toBe("succeeded");

    const storedFailRun = await getRunRecord(studioDb, "run_ws_fail_2");
    expect(storedFailRun?.status).toBe("failed");
    expect(storedFailRun?.retries).toBe(2);
    expect(storedFailRun?.errorStack).toContain("[REDACTED]");

    const failEvents = await listStepEventsForRun(studioDb, "run_ws_fail_2");
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
      happyEvents: await listStepEventsForRun(studioDb, "run_ws_happy_1"),
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
        webhookUrl: `http://localhost/api/projects/${project}/telemetry/webhook`,
        webhookFetcher: async (input, init) =>
          app.fetch(new Request(String(input), init), testEnv),
      },
    });

    // Verify Worker shell GET /__px/events?after=0&limit=4 with valid HMAC signature
    const sig = await signTelemetryPayload(
      canonicalEventsCursorPayload(0, 4),
      TELEMETRY_SECRET,
    );
    const workerPullRes = await handleTelemetryEventsPullRequest(
      new Request("http://worker.local/__px/events?after=0&limit=4", {
        headers: { [TELEMETRY_SIGNATURE_HEADER]: sig },
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
});
