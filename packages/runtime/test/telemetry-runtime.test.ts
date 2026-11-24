import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { createRegistry } from "@poc/sdk";
import type { D1Like, Executor } from "@poc/sdk";
import {
  TELEMETRY_SIGNATURE_HEADER,
  ensureTelemetryTables,
  getRunRecord,
  listStepEventsForRun,
  verifyTelemetrySignature,
} from "@poc/telemetry";
import { GraphWorkflow, toyExecutors } from "../src/index.ts";
import type { Graph } from "../src/index.ts";

const db = (env as unknown as { DB: D1Like }).DB;

const CANARY_STRIPE_KEY = "sk_live_canary_runtime_9988776655";
const CANARY_CONN_SECRET = "xox" + "b-canary-connection-token-445566";
const CANARY_WIDGET_SECRET = "whsec_canary_widget_secret_112233";

const testRegistry = createRegistry([
  {
    type: "trigger.manual",
    category: "trigger",
    inputs: [],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({}),
    secrets: [],
  },
  {
    type: "action.secret_enrich",
    category: "action",
    inputs: [{ id: "in", dataType: "json" }],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({
      signingSecret: z.string().optional(),
      endpoint: z.string().optional(),
    }),
    secrets: ["STRIPE_SECRET_KEY"],
    secretFields: ["signingSecret"],
  },
  {
    type: "action.flaky_fail",
    category: "action",
    sideEffects: "none",
    inputs: [{ id: "in", dataType: "json" }],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({}),
    secrets: ["STRIPE_SECRET_KEY"],
  },
  {
    type: "sink.result",
    category: "action",
    inputs: [{ id: "in", dataType: "json" }],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({}),
    secrets: [],
  },
]);

describe("@poc/runtime — 3-node GraphWorkflow telemetry, retries, and secret redaction", () => {
  beforeEach(async () => {
    await ensureTelemetryTables(db);
    await db.batch([
      db.prepare("DELETE FROM px_step_events"),
      db.prepare("DELETE FROM px_runs"),
    ]);
  });

  test("3-node happy-path workflow records queued, running, and succeeded events, updates px_runs, signs webhooks, and scrubs canary secrets", async () => {
    const webhookCalls: Array<{ bodyText: string; signature: string | null }> = [];
    const telemetrySecret = "px-runtime-hmac-test-secret-key";

    const enrichExecutor: Executor = ({ inputs, data, secret, connection }) => {
      const apiKey = secret("STRIPE_SECRET_KEY");
      const conn = connection ? connection<{ botToken: string }>("slack") : { botToken: "" };
      return {
        out: {
          received: inputs.in,
          endpointUsed: data.endpoint,
          leakedPlain: `Bearer ${apiKey}`,
          leakedBase64: btoa(apiKey),
          leakedUrlEncoded: encodeURIComponent(conn.botToken),
          headers: {
            Authorization: `Bearer ${conn.botToken}`,
            "X-Api-Key": apiKey,
          },
          status: "charged",
        },
      };
    };

    const sinkExecutor: Executor = ({ inputs }) => ({
      out: {
        finalStatus: "completed",
        upstream: inputs.in,
      },
    });

    const executors = new Map<string, Executor>([
      ...toyExecutors,
      ["action.secret_enrich", enrichExecutor],
      ["sink.result", sinkExecutor],
    ]);

    const graph: Graph = {
      nodes: [
        { id: "n1_trigger", type: "trigger.manual", data: {} },
        {
          id: "n2_enrich",
          type: "action.secret_enrich",
          data: {
            signingSecret: CANARY_WIDGET_SECRET,
            endpoint: "https://api.stripe.com/v1/charges",
          },
        },
        { id: "n3_sink", type: "sink.result", data: {} },
      ],
      edges: [
        {
          id: "e1",
          source: "n1_trigger",
          sourceHandle: "out",
          target: "n2_enrich",
          targetHandle: "in",
        },
        {
          id: "e2",
          source: "n2_enrich",
          sourceHandle: "out",
          target: "n3_sink",
          targetHandle: "in",
        },
      ],
    };

    const workflow = new GraphWorkflow(testRegistry, executors);
    const runResult = await workflow.start({
      graph,
      payload: { orderId: "ord_101", amount: 2500 },
      env: {
        DB: db,
        STRIPE_SECRET_KEY: CANARY_STRIPE_KEY,
        PX_TELEMETRY_SECRET: telemetrySecret,
      },
      connections: {
        slack: {
          botToken: CANARY_CONN_SECRET,
        },
      },
      telemetry: {
        db,
        runId: "run_happy_3node",
        workflowId: "wf_checkout",
        revision: 4,
        project: "acme-checkout",
        telemetrySecret,
        webhookUrl: "http://studio-api/api/projects/acme-checkout/telemetry/webhook",
        webhookFetcher: async (_url, init) => {
          const headers = new Headers(init?.headers);
          webhookCalls.push({
            bodyText: String(init?.body ?? ""),
            signature: headers.get(TELEMETRY_SIGNATURE_HEADER),
          });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });

    expect(runResult.ok).toBe(true);
    expect(runResult.runId).toBe("run_happy_3node");

    const runRow = await getRunRecord(db, "run_happy_3node");
    expect(runRow).not.toBeNull();
    expect(runRow?.workflowId).toBe("wf_checkout");
    expect(runRow?.revision).toBe(4);
    expect(runRow?.status).toBe("succeeded");
    expect(runRow?.retries).toBe(0);
    expect(runRow?.errorStack).toBeNull();
    expect(runRow?.endedAt).toBeTruthy();

    const events = await listStepEventsForRun(db, "run_happy_3node");
    // 3 nodes * 3 transitions (queued, running, succeeded) = 9 events
    expect(events).toHaveLength(9);

    for (const nodeId of ["n1_trigger", "n2_enrich", "n3_sink"]) {
      const statuses = events
        .filter((e) => e.nodeId === nodeId)
        .map((e) => e.status);
      expect(statuses).toEqual(["queued", "running", "succeeded"]);
    }

    // Verify all webhook payloads carry valid HMAC-SHA256 signatures and zero canary secrets
    expect(webhookCalls.length).toBeGreaterThanOrEqual(9);
    for (const call of webhookCalls) {
      expect(
        await verifyTelemetrySignature(call.bodyText, call.signature, telemetrySecret),
      ).toBe(true);
      expect(call.bodyText).not.toContain(CANARY_STRIPE_KEY);
      expect(call.bodyText).not.toContain(btoa(CANARY_STRIPE_KEY));
      expect(call.bodyText).not.toContain(CANARY_CONN_SECRET);
      expect(call.bodyText).not.toContain(encodeURIComponent(CANARY_CONN_SECRET));
      expect(call.bodyText).not.toContain(CANARY_WIDGET_SECRET);
    }

    // Verify D1 rows contain zero canary secrets
    const allEventsDump = JSON.stringify(events);
    expect(allEventsDump).not.toContain(CANARY_STRIPE_KEY);
    expect(allEventsDump).not.toContain(btoa(CANARY_STRIPE_KEY));
    expect(allEventsDump).not.toContain(CANARY_CONN_SECRET);
    expect(allEventsDump).not.toContain(CANARY_WIDGET_SECRET);
    expect(allEventsDump).toContain("[REDACTED]");
  });

  test("3-node failing workflow with retries records retry count, marks downstream node skipped, and scrubs secrets from errorStack", async () => {
    let attempts = 0;
    const flakyExecutor: Executor = ({ secret }) => {
      attempts += 1;
      const key = secret("STRIPE_SECRET_KEY");
      throw new Error(`Upstream gateway rejected key ${key} on attempt ${attempts}`);
    };

    const executors = new Map<string, Executor>([
      ...toyExecutors,
      ["action.flaky_fail", flakyExecutor],
      ["sink.result", ({ inputs }) => ({ out: inputs.in })],
    ]);

    const graph: Graph = {
      nodes: [
        { id: "n1_trigger", type: "trigger.manual", data: {} },
        { id: "n2_flaky", type: "action.flaky_fail", data: {} },
        { id: "n3_downstream", type: "sink.result", data: {} },
      ],
      edges: [
        {
          id: "e1",
          source: "n1_trigger",
          sourceHandle: "out",
          target: "n2_flaky",
          targetHandle: "in",
        },
        {
          id: "e2",
          source: "n2_flaky",
          sourceHandle: "out",
          target: "n3_downstream",
          targetHandle: "in",
        },
      ],
    };

    const workflow = new GraphWorkflow(testRegistry, executors);
    const result = await workflow.start({
      graph,
      payload: { test: "retry-failure" },
      env: {
        DB: db,
        STRIPE_SECRET_KEY: CANARY_STRIPE_KEY,
      },
      telemetry: {
        db,
        runId: "run_fail_retry_3node",
        workflowId: "wf_flaky",
        revision: 7,
        stepRetries: {
          n2_flaky: { limit: 2, delayMs: 2 },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBe(3); // 1 initial + 2 retries
    expect(result.skipped).toEqual(["n3_downstream"]);

    const runRow = await getRunRecord(db, "run_fail_retry_3node");
    expect(runRow?.status).toBe("failed");
    expect(runRow?.retries).toBe(2);
    expect(runRow?.errorStack).toContain("[REDACTED]");
    expect(runRow?.errorStack).not.toContain(CANARY_STRIPE_KEY);

    const events = await listStepEventsForRun(db, "run_fail_retry_3node");
    const flakyFailed = events.find(
      (e) => e.nodeId === "n2_flaky" && e.status === "failed",
    );
    expect(flakyFailed).toBeDefined();
    expect(flakyFailed?.retries).toBe(2);
    expect(flakyFailed?.errorStack).toContain("[REDACTED]");
    expect(flakyFailed?.errorStack).not.toContain(CANARY_STRIPE_KEY);

    const downstreamSkipped = events.find(
      (e) => e.nodeId === "n3_downstream" && e.status === "skipped",
    );
    expect(downstreamSkipped).toBeDefined();
  });
});
