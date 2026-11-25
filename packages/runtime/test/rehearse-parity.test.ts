import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createRegistry } from "@poc/sdk";
import type { D1Like, Executor } from "@poc/sdk";
import {
  TELEMETRY_SIGNATURE_HEADER,
  ensureTelemetryTables,
  getRunRecord,
  listStepEventsForRun,
  signControlPlaneRequest,
} from "@poc/telemetry";
import {
  GraphWorkflow,
  PLACEHOLDER_BRICK_EXECUTOR_MODULES,
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  handleStepRehearsalRequest,
} from "../src/index.ts";
import type { StepRehearsalResult } from "../src/index.ts";

const db = (env as unknown as { DB: D1Like }).DB;
const TELEMETRY_SECRET = "px-rehearsal-parity-hmac-secret-2026";
const CANARY_SECRET = "sk_live_canary_rehearse_parity_778899";

const baseRegistry = buildRegistryFromCatalog();
// Story 0.9: brick action placeholders are test-only and injected explicitly here.
const baseExecutors = buildExecutorsFromCatalog(undefined, PLACEHOLDER_BRICK_EXECUTOR_MODULES);

describe("POST /__px/rehearse — 3-node-type parity with GraphWorkflow, preview guard, and secret redaction", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await ensureTelemetryTables(db);
    await db.batch([
      db.prepare("DELETE FROM px_step_events"),
      db.prepare("DELETE FROM px_runs"),
    ]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function callRehearseEndpoint(
    payload: Record<string, unknown>,
    opts?: {
      pxEnv?: string;
      signatureOverride?: string | null;
      extraEnv?: Record<string, unknown>;
    },
  ): Promise<Response> {
    // The signer always names the verified workspace (story 1.1); a call that names none uses the test's preview workspace.
    // Story 1.17: the control-plane signature over method, path, time and body, with a one-time requestId.
    const rawBody = JSON.stringify({ requestId: crypto.randomUUID(), workspaceId: "ws_test", ...payload });
    const signed = await signControlPlaneRequest(TELEMETRY_SECRET, "POST", "/__px/rehearse", rawBody);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...signed,
    };
    if (opts?.signatureOverride === null) {
      delete headers[TELEMETRY_SIGNATURE_HEADER];
    } else if (opts?.signatureOverride !== undefined) {
      headers[TELEMETRY_SIGNATURE_HEADER] = opts.signatureOverride;
    }

    const req = new Request("http://preview-worker.local/__px/rehearse", {
      method: "POST",
      headers,
      body: rawBody,
    });

    const res = await handleStepRehearsalRequest(req, {
      registry: baseRegistry,
      executors: baseExecutors,
      db,
      pxEnv: opts?.pxEnv ?? "preview",
      telemetrySecret: TELEMETRY_SECRET,
      env: {
        DB: db,
        PX_ENV: opts?.pxEnv ?? "preview",
        ...(opts?.extraEnv ?? {}),
      },
    });
    expect(res).not.toBeNull();
    return res!;
  }

  test("blocks POST /__px/rehearse with HTTP 403 when PX_ENV === 'production' and HTTP 401 on missing/forged HMAC signature", async () => {
    const body = {
      workflowId: "wf_guard",
      revision: 1,
      nodeId: "step_debit",
      nodeType: "credit-wallet.debit",
      config: { amount: 10 },
      input: { balance: 100, workspaceId: "ws_1" },
    };

    const prodRes = await callRehearseEndpoint(body, { pxEnv: "production" });
    expect(prodRes.status).toBe(403);
    const prodJson = (await prodRes.json()) as { error: { code: string } };
    expect(prodJson.error.code).toBe("REHEARSAL_FORBIDDEN_IN_PRODUCTION");

    const missingSigRes = await callRehearseEndpoint(body, {
      signatureOverride: null,
    });
    expect(missingSigRes.status).toBe(401);

    const forgedSigRes = await callRehearseEndpoint(body, {
      signatureOverride: "deadbeef00112233445566778899aabbccddeeff",
    });
    expect(forgedSigRes.status).toBe(401);
  });

  test("proves deep output equality between POST /__px/rehearse and full GraphWorkflow production trigger across 3 distinct node types", async () => {
    // Install deterministic fixture handler for outbound HTTP node (http://fixture.local/*)
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith("http://fixture.local/")) {
        const parsedReqBody = init?.body ? JSON.parse(String(init.body)) : null;
        return new Response(
          JSON.stringify({
            fixture: "order-verification-v1",
            method: init?.method ?? "POST",
            path: new URL(urlStr).pathname,
            echoedPayload: parsedReqBody,
            verified: true,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return originalFetch(input, init);
    };

    const workflow = new GraphWorkflow(baseRegistry, baseExecutors);

    // (a) Node Type 1: Brick Action (credit-wallet.debit)
    const walletInput = { balance: 250, workspaceId: "ws_acme_tenant" };
    const walletConfig = { amount: 35 };

    const rehearseBrickRes = await callRehearseEndpoint({
      workflowId: "wf_parity_brick",
      revision: 2,
      nodeId: "node_wallet_debit",
      nodeType: "credit-wallet.debit",
      config: walletConfig,
      input: walletInput,
      workspaceId: "ws_acme_tenant",
    });
    expect(rehearseBrickRes.status).toBe(200);
    const rehearseBrickBody = (await rehearseBrickRes.json()) as StepRehearsalResult;
    expect(rehearseBrickBody.status).toBe("succeeded");
    expect(rehearseBrickBody.runId.startsWith("rehearsal:")).toBe(true);

    const prodBrickRun = await workflow.start({ workspaceId: "ws_acme_tenant",
      graph: {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          { id: "node_wallet_debit", type: "credit-wallet.debit", data: walletConfig },
        ],
        edges: [
          { id: "e1", source: "trig", sourceHandle: "out", target: "node_wallet_debit", targetHandle: "in" },
        ],
      },
      payload: walletInput,
    });
    expect(prodBrickRun.ok).toBe(true);
    expect(rehearseBrickBody.output).toEqual(prodBrickRun.outputs.node_wallet_debit);
    expect(JSON.parse(rehearseBrickBody.outputPreview)).toEqual(
      prodBrickRun.outputs.node_wallet_debit,
    );

    // Verify px_step_events and px_runs rows were written with run_id = "rehearsal:<uuid>"
    const brickRunRow = await getRunRecord(db, rehearseBrickBody.runId, { workspaceId: "ws_acme_tenant" });
    expect(brickRunRow?.triggerType).toBe("rehearsal");
    const brickEvents = await listStepEventsForRun(db, rehearseBrickBody.runId, { workspaceId: "ws_acme_tenant" });
    expect(brickEvents).toHaveLength(1);
    expect(brickEvents[0]?.nodeId).toBe("node_wallet_debit");
    expect(brickEvents[0]?.status).toBe("succeeded");

    // (b) Node Type 2: Core Logic / Transform Node (core.if)
    const logicInput = { plan: "enterprise", seats: 25 };
    const logicConfig = { field: "plan", operator: "eq", value: "enterprise" };

    const rehearseLogicRes = await callRehearseEndpoint({
      workflowId: "wf_parity_logic",
      revision: 3,
      nodeId: "node_if_plan",
      nodeType: "core.if",
      config: logicConfig,
      input: logicInput,
    });
    expect(rehearseLogicRes.status).toBe(200);
    const rehearseLogicBody = (await rehearseLogicRes.json()) as StepRehearsalResult;
    expect(rehearseLogicBody.status).toBe("succeeded");

    const prodLogicRun = await workflow.start({ workspaceId: "ws_test",
      graph: {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          { id: "node_if_plan", type: "core.if", data: logicConfig },
        ],
        edges: [
          { id: "e1", source: "trig", sourceHandle: "out", target: "node_if_plan", targetHandle: "in" },
        ],
      },
      payload: logicInput,
    });
    expect(prodLogicRun.ok).toBe(true);
    expect(rehearseLogicBody.output).toEqual(prodLogicRun.outputs.node_if_plan);

    // (c) Node Type 3: Outbound HTTP Node (core.http_request against deterministic fixture server)
    const httpInput = {
      body: { invoiceId: "inv_9001", totalCents: 19900 },
    };
    const httpConfig = {
      method: "post",
      url: "http://fixture.local/orders/verify",
      timeoutMs: 3000,
    };

    const rehearseHttpRes = await callRehearseEndpoint({
      workflowId: "wf_parity_http",
      revision: 4,
      nodeId: "node_http_verify",
      nodeType: "core.http_request",
      config: httpConfig,
      input: httpInput,
    });
    expect(rehearseHttpRes.status).toBe(200);
    const rehearseHttpBody = (await rehearseHttpRes.json()) as StepRehearsalResult;
    expect(rehearseHttpBody.status).toBe("succeeded");

    const prodHttpRun = await workflow.start({ workspaceId: "ws_test",
      graph: {
        nodes: [
          { id: "trig", type: "trigger.manual", data: {} },
          { id: "node_http_verify", type: "core.http_request", data: httpConfig },
        ],
        edges: [
          { id: "e1", source: "trig", sourceHandle: "out", target: "node_http_verify", targetHandle: "in" },
        ],
      },
      payload: httpInput,
    });
    expect(prodHttpRun.ok).toBe(true);
    expect(rehearseHttpBody.output).toEqual(prodHttpRun.outputs.node_http_verify);
  });

  test("scrubs declared secrets, widget:secret fields, and auth headers via redactTelemetryPayload() during rehearsal", async () => {
    const customRegistry = createRegistry([
      ...baseRegistry.values(),
      {
        type: "action.secret_rehearsal_probe",
        category: "action",
        inputs: [{ id: "in", dataType: "json" }],
        outputs: [{ id: "out", dataType: "json" }],
        configSchema: z.object({ apiSecretWidget: z.string().optional() }),
        secrets: ["PROBE_API_SECRET"],
        secretFields: ["apiSecretWidget"],
      },
    ]);

    const probeExecutor: Executor = ({ secret, data, inputs }) => {
      const secVal = secret("PROBE_API_SECRET");
      return {
        out: {
          echoInput: inputs.in,
          leakedPlain: `token=${secVal}`,
          leakedBase64: btoa(secVal),
          widgetEcho: data.apiSecretWidget,
          headers: {
            Authorization: `Bearer ${secVal}`,
          },
        },
      };
    };

    const customExecutors = new Map<string, Executor>([
      ...baseExecutors,
      ["action.secret_rehearsal_probe", probeExecutor],
    ]);

    const payload = JSON.stringify({
      workflowId: "wf_sec_probe",
      revision: 1,
      nodeId: "node_probe",
      nodeType: "action.secret_rehearsal_probe",
      config: { apiSecretWidget: "whsec_widget_canary_554433" },
      input: { userId: "u_1" },
      workspaceId: "ws_test",
      requestId: crypto.randomUUID(),
    });

    const res = await handleStepRehearsalRequest(
      new Request("http://preview-worker.local/__px/rehearse", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await signControlPlaneRequest(TELEMETRY_SECRET, "POST", "/__px/rehearse", payload)),
        },
        body: payload,
      }),
      {
        registry: customRegistry,
        executors: customExecutors,
        db,
        telemetrySecret: TELEMETRY_SECRET,
        env: {
          DB: db,
          PROBE_API_SECRET: CANARY_SECRET,
        },
      },
    );

    expect(res?.status).toBe(200);
    const bodyText = await res!.text();
    expect(bodyText).not.toContain(CANARY_SECRET);
    expect(bodyText).not.toContain(btoa(CANARY_SECRET));
    expect(bodyText).not.toContain("whsec_widget_canary_554433");
    expect(bodyText).toContain("[REDACTED]");
  });
});
