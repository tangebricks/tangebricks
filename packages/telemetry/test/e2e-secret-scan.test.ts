import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { BrickManifest, D1Like, Executor, Executors, Registry } from "@poc/sdk";
import {
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  handleStepRehearsalRequest,
  handleWorkflowRerunRequest,
  handleWorkflowRunRequest,
} from "@poc/runtime";
import {
  REDACTED_PLACEHOLDER,
  TelemetryWsFrameSchema,
  ensureTelemetryTables,
  handleTelemetryEventsPullRequest,
  redactTelemetryPayload,
  signControlPlaneRequest,
} from "../src/index.ts";
import type { StepEvent, TelemetryWebhookPayload, TelemetryWsFrame } from "../src/index.ts";

const db = (env as unknown as { DB: D1Like }).DB;

const CANARY_BRICK_SECRET = "px_canary_brick_secret_9f8e7d6c5b4a3210_do_not_leak";
const CANARY_WIDGET_SECRET = "px_canary_widget_secret_1a2b3c4d5e6f7890_do_not_leak";
const CANARY_CONN_BEARER = "px_canary_conn_bearer_77889900aabbccdd_do_not_leak";
const CANARY_HTTP_AUTH = "px_canary_http_auth_header_556677889900_do_not_leak";
const CANARY_HTTP_COOKIE = "px_canary_http_cookie_header_1122334455_do_not_leak";
const CANARY_HTTP_X_API_KEY = "px_canary_http_x_api_key_9988776655_do_not_leak";

const CANARY_PATTERN_CORPUS = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  "sk_" + "live_51Hcanarysecretstripekey123",
  "rk_" + "live_51Hzzzzzzzzzzzzzzzzzzzzzzz",
  "whs" + "ec_1234567890abcdef1234567890abcdef",
  "ghp" + "_0123456789abcdef0123456789abcdef0123",
  "git" + "hub_pat_11AAAAAAA0000000000000_123456789012345678901234567890",
  "xox" + "b-123456789-987654321-abcdef123456",
  "AKI" + "AIOSFODNN7EXAMPLE",
  "AIz" + "aSyA12345678901234567890123456789012",
  "supersecretkey123",
] as const;

const ALL_CANARY_SECRETS = [
  CANARY_BRICK_SECRET,
  CANARY_WIDGET_SECRET,
  CANARY_CONN_BEARER,
  CANARY_HTTP_AUTH,
  CANARY_HTTP_COOKIE,
  CANARY_HTTP_X_API_KEY,
  ...CANARY_PATTERN_CORPUS,
] as const;

function buildAllCanaryVariants(canaries: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const raw of canaries) {
    variants.add(raw);
    const b64 = btoa(raw);
    variants.add(b64);
    variants.add(b64.replace(/=+$/g, ""));
    variants.add(b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""));
    variants.add(encodeURIComponent(raw));
  }
  return [...variants];
}

function assertZeroCanaryMatches(surfaceName: string, content: string): void {
  const variants = buildAllCanaryVariants(ALL_CANARY_SECRETS);
  for (const variant of variants) {
    expect(content.includes(variant), `[SECURITY LEAK] Surface "${surfaceName}" contained canary secret variant "${variant}"`).toBe(false);
  }
}

function renderReplayInspectorDomSnapshot(events: StepEvent[]): string {
  return events
    .map(
      (ev) => `
      <div data-testid="inspector-run-replay-panel" data-node-id="${ev.nodeId}" data-status="${ev.status}">
        <span data-testid="replay-node-status">${ev.status}</span>
        <span data-testid="replay-node-duration">${Math.round(ev.durationMs)} ms</span>
        <span data-testid="replay-node-retries">${ev.retries} retries</span>
        <pre data-testid="replay-node-input-preview">${ev.inputPreview}</pre>
        <pre data-testid="replay-node-output-preview">${ev.outputPreview}</pre>
        ${ev.errorStack ? `<pre data-testid="replay-node-error-stack">${ev.errorStack}</pre>` : ""}
      </div>`,
    )
    .join("\n");
}

describe("CP4 End-to-End Canary Secret-Redaction Scan across D1, WebSocket Frames, HTTP Responses, and Replay DOM", () => {
  beforeEach(async () => {
    await ensureTelemetryTables(db);
    await db.batch([db.prepare("DELETE FROM px_step_events"), db.prepare("DELETE FROM px_runs")]);
  });

  test("plants canary secrets across ctx.secret(), widget:'secret' manifest settings, ctx.connection() bearer tokens, and HTTP Authorization/Cookie/X-Api-Key headers, executes passing + failing workflows and Test Step rehearsal, and proves 0 canary matches across D1, WebSocket broadcasts, HTTP API responses, and Replay DOM", async () => {
    const telemetrySecret = "px-cp4-gate-hmac-secret-2026";
    const recordedWsFrames: TelemetryWsFrame[] = [];
    const recordedWebhookBodies: string[] = [];

    // Custom test node manifest declaring `CANARY_BRICK_SECRET` and a `widget: "secret"` field `apiSecretKey`
    const canaryActionManifest: BrickManifest = {
      type: "canary.secret_probe",
      label: "Canary Secret Probe",
      category: "action",
      inputs: [{ id: "in", dataType: "any" }],
      outputs: [{ id: "out", dataType: "any" }],
      configSchema: z.object({
        mode: z.enum(["pass", "fail"]).default("pass"),
        apiSecretKey: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
      secrets: ["CANARY_BRICK_SECRET"],
      secretFields: ["apiSecretKey"],
    };

    const registryMap = new Map(buildRegistryFromCatalog());
    registryMap.set("canary.secret_probe", canaryActionManifest);
    const registry: Registry = registryMap;

    const probeExecutor: Executor = async (ctx) => {
      const brickSecretVal = ctx.secret("CANARY_BRICK_SECRET");
      const conn = ctx.connection?.("billing_conn") ?? {};
      const widgetSecretVal = String(ctx.data.apiSecretKey ?? "");
      const headers = (ctx.data.headers ?? {}) as Record<string, string>;

      const diagnosticEcho = {
        brickSecretEcho: brickSecretVal,
        brickSecretBase64: btoa(brickSecretVal),
        widgetSecretEcho: widgetSecretVal,
        connBearerEcho: conn.bearerToken,
        patternCorpusEcho: {
          note: `Provider log with JWT ${CANARY_PATTERN_CORPUS[0]} and Stripe ${CANARY_PATTERN_CORPUS[1]}`,
          webhookCallback: `https://api.partner.com/events?key=${CANARY_PATTERN_CORPUS[9]}&env=prod`,
          slackIntegration: `${CANARY_PATTERN_CORPUS[6]}`,
          githubToken: `${CANARY_PATTERN_CORPUS[4]}`,
          awsAccessKey: `${CANARY_PATTERN_CORPUS[7]}`,
          googleKey: `${CANARY_PATTERN_CORPUS[8]}`,
        },
        outboundHeaders: {
          Authorization: headers.Authorization ?? `Bearer ${CANARY_HTTP_AUTH}`,
          Cookie: headers.Cookie ?? `session=${CANARY_HTTP_COOKIE}`,
          "X-Api-Key": headers["X-Api-Key"] ?? CANARY_HTTP_X_API_KEY,
          "Content-Type": "application/json",
        },
        safeSummary: "canary-probe-executed",
      };

      if (ctx.data.mode === "fail") {
        throw new Error(
          `Upstream API rejected credentials: brick=${brickSecretVal} widget=${widgetSecretVal} conn=${String(conn.bearerToken)} auth=${headers.Authorization} cookie=${headers.Cookie} xApiKey=${headers["X-Api-Key"]} stripe=${CANARY_PATTERN_CORPUS[1]} callback=https://partner.com?key=${CANARY_PATTERN_CORPUS[9]}`,
        );
      }

      return {
        out: diagnosticEcho,
      };
    };

    const executorsMap = new Map(buildExecutorsFromCatalog());
    executorsMap.set("canary.secret_probe", probeExecutor);
    const executors: Executors = executorsMap;

    const workerEnv = {
      CANARY_BRICK_SECRET,
      PX_TELEMETRY_SECRET: telemetrySecret,
    };

    const workerConnections = {
      billing_conn: {
        bearerToken: CANARY_CONN_BEARER,
        authorization: `Bearer ${CANARY_CONN_BEARER}`,
      },
    };

    const webhookFetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      recordedWebhookBodies.push(bodyText);
      const parsed = JSON.parse(bodyText) as TelemetryWebhookPayload;
      for (const ev of parsed.events ?? []) {
        const wsFrame = TelemetryWsFrameSchema.parse({
          type: "telemetry",
          project: parsed.project ?? "cp4-canary-proj",
          rev: ev.revision,
          runId: ev.runId,
          workflowId: ev.workflowId,
          nodeId: ev.nodeId,
          status: ev.status,
          durationMs: ev.durationMs,
          retries: ev.retries,
          inputPreview: ev.inputPreview,
          outputPreview: ev.outputPreview,
          errorStack: ev.errorStack ?? null,
          runStatus: parsed.run?.status,
          timestamp: ev.createdAt,
          fromPinned: ev.fromPinned,
          reused: ev.reused,
        });
        recordedWsFrames.push(wsFrame);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const nodeConfigBase = {
      apiSecretKey: CANARY_WIDGET_SECRET,
      headers: {
        Authorization: `Bearer ${CANARY_HTTP_AUTH}`,
        Cookie: `sid=${CANARY_HTTP_COOKIE}`,
        "X-Api-Key": CANARY_HTTP_X_API_KEY,
      },
    };

    // 1. Run a passing workflow via POST /__px/runs
    const passingRunPayload = JSON.stringify({
      requestId: crypto.randomUUID(),
      runId: "run_canary_pass",
      project: "cp4-canary-proj",
      workflowId: "wf_canary",
      revision: 1,
      triggerType: "manual",
      triggerPayload: {
        orderId: "ord_pass_1",
        Authorization: `Bearer ${CANARY_HTTP_AUTH}`,
        Cookie: `sid=${CANARY_HTTP_COOKIE}`,
        "X-Api-Key": CANARY_HTTP_X_API_KEY,
      },
      workspaceId: "ws_canary",
      graph: {
        nodes: [
          { id: "step_trigger", type: "core.webhook", data: { method: "post" } },
          {
            id: "step_probe",
            type: "canary.secret_probe",
            data: { ...nodeConfigBase, mode: "pass" },
          },
        ],
        edges: [
          {
            id: "e1",
            source: "step_trigger",
            sourceHandle: "out",
            target: "step_probe",
            targetHandle: "in",
          },
        ],
      },
    });
    const passingRunRes = await handleWorkflowRunRequest(
      new Request("http://preview.local/__px/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await signControlPlaneRequest(telemetrySecret, "POST", "/__px/runs", passingRunPayload)),
        },
        body: passingRunPayload,
      }),
      {
        registry,
        executors,
        db,
        env: workerEnv,
        connections: workerConnections,
        telemetrySecret,
        telemetryWebhookUrl: "http://studio-api.local/api/projects/cp4-canary-proj/telemetry/webhook",
        telemetryWebhookFetcher: webhookFetcher,
      },
    );
    expect(passingRunRes?.status).toBe(200);
    const passingHttpText = await passingRunRes!.text();

    // 2. Run a failing workflow (echoing all secrets in its thrown Error) via POST /__px/runs
    const failingRunPayload = JSON.stringify({
      requestId: crypto.randomUUID(),
      runId: "run_canary_fail",
      project: "cp4-canary-proj",
      workflowId: "wf_canary",
      revision: 1,
      triggerType: "webhook",
      triggerPayload: {
        orderId: "ord_fail_2",
        Authorization: `Bearer ${CANARY_HTTP_AUTH}`,
      },
      workspaceId: "ws_canary",
      graph: {
        nodes: [
          { id: "step_trigger", type: "core.webhook", data: { method: "post" } },
          {
            id: "step_probe",
            type: "canary.secret_probe",
            data: { ...nodeConfigBase, mode: "fail" },
          },
        ],
        edges: [
          {
            id: "e1",
            source: "step_trigger",
            sourceHandle: "out",
            target: "step_probe",
            targetHandle: "in",
          },
        ],
      },
    });
    const failingRunRes = await handleWorkflowRunRequest(
      new Request("http://preview.local/__px/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await signControlPlaneRequest(telemetrySecret, "POST", "/__px/runs", failingRunPayload)),
        },
        body: failingRunPayload,
      }),
      {
        registry,
        executors,
        db,
        env: workerEnv,
        connections: workerConnections,
        telemetrySecret,
        telemetryWebhookUrl: "http://studio-api.local/api/projects/cp4-canary-proj/telemetry/webhook",
        telemetryWebhookFetcher: webhookFetcher,
      },
    );
    expect(failingRunRes?.status).toBe(200);
    const failingHttpText = await failingRunRes!.text();

    // 3. Run a single-node Test Step rehearsal (both pass and fail) via POST /__px/rehearse
    const rehearsePassPayload = JSON.stringify({
      requestId: crypto.randomUUID(),
      workspaceId: "ws_canary",
      workflowId: "wf_canary",
      revision: 1,
      nodeId: "step_probe",
      nodeType: "canary.secret_probe",
      config: { ...nodeConfigBase, mode: "pass" },
      input: {
        Authorization: `Bearer ${CANARY_HTTP_AUTH}`,
        Cookie: `sid=${CANARY_HTTP_COOKIE}`,
        "X-Api-Key": CANARY_HTTP_X_API_KEY,
      },
    });
    const rehearsePassRes = await handleStepRehearsalRequest(
      new Request("http://preview.local/__px/rehearse", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await signControlPlaneRequest(telemetrySecret, "POST", "/__px/rehearse", rehearsePassPayload)),
        },
        body: rehearsePassPayload,
      }),
      {
        registry,
        executors,
        db,
        env: workerEnv,
        connections: workerConnections,
        pxEnv: "preview",
        telemetrySecret,
      },
    );
    expect(rehearsePassRes?.status).toBe(200);
    const rehearsePassHttpText = await rehearsePassRes!.text();

    const rehearseFailPayload = JSON.stringify({
      requestId: crypto.randomUUID(),
      workspaceId: "ws_canary",
      workflowId: "wf_canary",
      revision: 1,
      nodeId: "step_probe",
      nodeType: "canary.secret_probe",
      config: { ...nodeConfigBase, mode: "fail" },
      input: {
        Authorization: `Bearer ${CANARY_HTTP_AUTH}`,
      },
    });
    const rehearseFailRes = await handleStepRehearsalRequest(
      new Request("http://preview.local/__px/rehearse", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await signControlPlaneRequest(telemetrySecret, "POST", "/__px/rehearse", rehearseFailPayload)),
        },
        body: rehearseFailPayload,
      }),
      {
        registry,
        executors,
        db,
        env: workerEnv,
        connections: workerConnections,
        pxEnv: "preview",
        telemetrySecret,
      },
    );
    expect(rehearseFailRes?.status).toBe(200);
    const rehearseFailHttpText = await rehearseFailRes!.text();

    // 4. Re-run the failed run from `step_probe` via POST /__px/runs/rerun
    const rerunPayload = JSON.stringify({
      requestId: crypto.randomUUID(),
      workspaceId: "ws_canary",
      runId: "run_canary_rerun_ok",
      sourceRunId: "run_canary_fail",
      fromNodeId: "step_probe",
      project: "cp4-canary-proj",
      workflowId: "wf_canary",
      revision: 2,
      graph: {
        nodes: [
          { id: "step_trigger", type: "core.webhook", data: { method: "post" } },
          {
            id: "step_probe",
            type: "canary.secret_probe",
            data: { ...nodeConfigBase, mode: "pass" },
          },
        ],
        edges: [
          {
            id: "e1",
            source: "step_trigger",
            sourceHandle: "out",
            target: "step_probe",
            targetHandle: "in",
          },
        ],
      },
    });
    const rerunRes = await handleWorkflowRerunRequest(
      new Request("http://preview.local/__px/runs/rerun", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await signControlPlaneRequest(telemetrySecret, "POST", "/__px/runs/rerun", rerunPayload)),
        },
        body: rerunPayload,
      }),
      {
        registry,
        executors,
        db,
        env: workerEnv,
        connections: workerConnections,
        telemetrySecret,
        telemetryWebhookUrl: "http://studio-api.local/api/projects/cp4-canary-proj/telemetry/webhook",
        telemetryWebhookFetcher: webhookFetcher,
      },
    );
    expect(rerunRes?.status).toBe(200);
    const rerunHttpText = await rerunRes!.text();

    // 5. Pull events cursor via GET /__px/events?workspaceId=ws_canary&after=0&limit=100 (control-plane signed)
    const pullUrl = new URL("http://preview.local/__px/events?workspaceId=ws_canary&after=0&limit=100");
    const pullEventsRes = await handleTelemetryEventsPullRequest(
      new Request(pullUrl.toString(), {
        headers: await signControlPlaneRequest(telemetrySecret, "GET", pullUrl),
      }),
      { db, telemetrySecret },
    );
    expect(pullEventsRes?.status).toBe(200);
    const pullEventsHttpText = await pullEventsRes!.text();

    // 6. Scan full SQLite D1 dump of `px_runs` and `px_step_events`
    const allRunsRows = await db.prepare("SELECT * FROM px_runs").all();
    const allEventsRows = await db.prepare("SELECT * FROM px_step_events").all();
    const d1DumpText = JSON.stringify({
      px_runs: allRunsRows.results,
      px_step_events: allEventsRows.results,
    });
    expect((allRunsRows.results ?? []).length).toBeGreaterThanOrEqual(3);
    expect((allEventsRows.results ?? []).length).toBeGreaterThanOrEqual(6);
    assertZeroCanaryMatches("D1 dump (px_runs + px_step_events)", d1DumpText);
    expect(d1DumpText).toContain(REDACTED_PLACEHOLDER);

    // 7. Scan all recorded WebSocket broadcast frames and webhook payloads
    expect(recordedWsFrames.length).toBeGreaterThan(0);
    const wsDumpText = JSON.stringify({
      wsFrames: recordedWsFrames,
      webhooks: recordedWebhookBodies,
    });
    assertZeroCanaryMatches("WebSocket broadcast frames & webhook payloads", wsDumpText);

    // 8. Scan all HTTP API responses
    const combinedHttpResponses = [passingHttpText, failingHttpText, rehearsePassHttpText, rehearseFailHttpText, rerunHttpText, pullEventsHttpText].join("\n");
    assertZeroCanaryMatches("HTTP API responses", combinedHttpResponses);
    expect(combinedHttpResponses).toContain(REDACTED_PLACEHOLDER);

    // 9. Scan rendered Studio Replay DOM & pinned node output redaction
    const parsedPull = JSON.parse(pullEventsHttpText) as { events: StepEvent[] };
    const replayDomHtml = renderReplayInspectorDomSnapshot(parsedPull.events);
    const redactedPin = JSON.stringify(
      redactTelemetryPayload(
        {
          apiSecretKey: CANARY_WIDGET_SECRET,
          Authorization: `Bearer ${CANARY_HTTP_AUTH}`,
          Cookie: `sid=${CANARY_HTTP_COOKIE}`,
          "X-Api-Key": CANARY_HTTP_X_API_KEY,
          nested: {
            brickSecret: CANARY_BRICK_SECRET,
            connToken: CANARY_CONN_BEARER,
            freeTextWithPatternSecrets: `Embedded secrets: ${CANARY_PATTERN_CORPUS[0]} and ${CANARY_PATTERN_CORPUS[1]} and ?key=${CANARY_PATTERN_CORPUS[9]}`,
          },
        },
        {
          secretValues: ALL_CANARY_SECRETS,
          secretFieldNames: ["apiSecretKey"],
        },
      ),
    );
    assertZeroCanaryMatches("Rendered Studio Replay DOM", replayDomHtml);
    assertZeroCanaryMatches("Pinned Node Output Store", redactedPin);
  });
});
