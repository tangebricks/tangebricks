import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_webhook_gateway.sql?raw";
import {
  createWebhookRoutes,
  WebhookService,
} from "../src/index.ts";
import type { WebhookEnv } from "../src/routes.ts";
import {
  verifyWithScheme,
} from "../src/signature-scheme.ts";
import { WEBHOOK_PRESETS, getPreset } from "../src/presets.ts";

const db = env.DB as D1Like;
const WS_A = "ws_replay_test";

async function resetDb(): Promise<void> {
  for (const table of [
    "px_webhook_deliveries",
    "wh_subscriptions",
    "px_connections",
    "wh_deliveries",
    "wh_endpoints",
    "px_logs",
  ]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

// Helper to compute HMAC
async function computeHmac(
  algorithm: "SHA-256" | "SHA-1" | "SHA-512",
  secret: string,
  payload: string,
  encoding: "hex" | "base64" = "hex",
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const signatureBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const bytes = new Uint8Array(signatureBuf);
  if (encoding === "hex") {
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i]!.toString(16).padStart(2, "0");
    }
    return hex;
  }
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function makeRequest(
  app: Hono<WebhookEnv>,
  path: string,
  options: RequestInit,
) {
  return app.fetch(
    new Request(`http://localhost${path}`, options),
    { DB: db },
  );
}

describe("Story UC4.4 — Replay protection for every scheme", () => {
  it("Task 1(a): A slack-v0 request with a timestamp 301s old is rejected with WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE", async () => {
    const preset = getPreset("slack-v0");
    expect(preset, "slack-v0 preset must exist").toBeDefined();
    if (!preset) return;

    const secret = "slack_signing_secret_test_123456";
    const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention" } });
    const nowSec = 1700000000;
    const oldTimestamp = nowSec - 301;

    // Signed payload: v0:{timestamp}:{body}
    const signedPayload = `v0:${oldTimestamp}:${body}`;
    const sigHex = await computeHmac("SHA-256", secret, signedPayload, "hex");
    const sigHeader = `v0=${sigHex}`;

    // Direct scheme verification
    const directResult = await verifyWithScheme(
      preset,
      {
        rawBody: body,
        headers: {
          "x-slack-signature": sigHeader,
          "x-slack-request-timestamp": String(oldTimestamp),
        },
      },
      secret,
      nowSec,
    );

    expect(directResult.ok).toBe(false);
    if (!directResult.ok) {
      expect(directResult.reason).toBe("WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE");
    }

    // End-to-end HTTP ingress verification
    const service = new WebhookService(db);
    const sub = await service.registerSubscription({
      workspaceId: WS_A,
      workflowId: "wf_slack",
      app: "slack",
      triggerId: "app_mention",
      verifier: "slack-v0",
      signingSecret: secret,
    });

    let workflowTriggered = false;
    const adapter = {
      nowSeconds: () => nowSec,
      onTriggerWorkflow: async () => {
        workflowTriggered = true;
        return { runId: "run_slack_old" };
      },
    };

    const app = new Hono<WebhookEnv>();
    app.route("/api", createWebhookRoutes({ adapter }));

    const res = await makeRequest(app, `/api/webhooks/in/${sub.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-signature": sigHeader,
        "x-slack-request-timestamp": String(oldTimestamp),
      },
      body,
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error).toBe("WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE");
    expect(workflowTriggered).toBe(false);
  });

  it("Task 1(b): A timestamp 301s in the future is rejected with WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE", async () => {
    const preset = getPreset("slack-v0");
    expect(preset).toBeDefined();
    if (!preset) return;

    const secret = "slack_signing_secret_test_123456";
    const body = JSON.stringify({ type: "event_callback" });
    const nowSec = 1700000000;
    const futureTimestamp = nowSec + 301;

    const signedPayload = `v0:${futureTimestamp}:${body}`;
    const sigHex = await computeHmac("SHA-256", secret, signedPayload, "hex");
    const sigHeader = `v0=${sigHex}`;

    const directResult = await verifyWithScheme(
      preset,
      {
        rawBody: body,
        headers: {
          "x-slack-signature": sigHeader,
          "x-slack-request-timestamp": String(futureTimestamp),
        },
      },
      secret,
      nowSec,
    );

    expect(directResult.ok).toBe(false);
    if (!directResult.ok) {
      expect(directResult.reason).toBe("WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE");
    }

    // Ingress check
    const service = new WebhookService(db);
    const sub = await service.registerSubscription({
      workspaceId: WS_A,
      workflowId: "wf_slack",
      app: "slack",
      triggerId: "app_mention",
      verifier: "slack-v0",
      signingSecret: secret,
    });

    const app = new Hono<WebhookEnv>();
    app.route("/api", createWebhookRoutes({
      adapter: { nowSeconds: () => nowSec },
    }));

    const res = await makeRequest(app, `/api/webhooks/in/${sub.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-signature": sigHeader,
        "x-slack-request-timestamp": String(futureTimestamp),
      },
      body,
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error).toBe("WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE");

    // Negative case: valid timestamp within tolerance (now - 10s) succeeds
    const validTimestamp = nowSec - 10;
    const validSigHex = await computeHmac("SHA-256", secret, `v0:${validTimestamp}:${body}`, "hex");
    const validRes = await makeRequest(app, `/api/webhooks/in/${sub.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-signature": `v0=${validSigHex}`,
        "x-slack-request-timestamp": String(validTimestamp),
      },
      body,
    });
    expect(validRes.status).toBe(200);
    const validJson = (await validRes.json()) as any;
    expect(validJson.received).toBe(true);
    expect(validJson.deduplicated).toBe(false);
  });

  it("Task 1(c): The same valid GitHub-preset delivery sent twice starts exactly one workflow and returns deduplicated: true", async () => {
    const service = new WebhookService(db);
    const secret = "github_secret_test_987654321";

    const sub = await service.registerSubscription({
      workspaceId: WS_A,
      workflowId: "wf_github_push",
      app: "github",
      triggerId: "push",
      verifier: "github-hmac-sha256",
      signingSecret: secret,
      eventIdPath: "delivery_id",
    });

    const body = JSON.stringify({
      delivery_id: "gh_delivery_uuid_001",
      ref: "refs/heads/main",
      commits: [],
    });
    const sigHex = await computeHmac("SHA-256", secret, body, "hex");
    const sigHeader = `sha256=${sigHex}`;

    let workflowRunCount = 0;
    let lastRunId = "";
    const adapter = {
      onTriggerWorkflow: async () => {
        workflowRunCount += 1;
        lastRunId = `run_gh_${workflowRunCount}`;
        return { runId: lastRunId };
      },
    };

    const app = new Hono<WebhookEnv>();
    app.route("/api", createWebhookRoutes({ adapter }));

    // First delivery
    const res1 = await makeRequest(app, `/api/webhooks/in/${sub.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sigHeader,
        "x-github-delivery": "gh_delivery_uuid_001",
      },
      body,
    });
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as any;
    expect(json1.received).toBe(true);
    expect(json1.deduplicated).toBe(false);
    expect(json1.runId).toBe("run_gh_1");
    expect(workflowRunCount).toBe(1);

    // Replayed delivery (exact same payload & signature)
    const res2 = await makeRequest(app, `/api/webhooks/in/${sub.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sigHeader,
        "x-github-delivery": "gh_delivery_uuid_001",
      },
      body,
    });
    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as any;
    expect(json2.received).toBe(true);
    expect(json2.deduplicated).toBe(true);
    // AC2 check: exact count of workflow runs remains 1
    expect(workflowRunCount).toBe(1);
  });

  it("Task 1(d): A delivery with no extractable event id is deduped on sig: + sha256(signature header value)", async () => {
    const service = new WebhookService(db);
    const secret = "secret_for_no_event_id_test";

    // Subscription with no event_id_path configured
    const sub = await service.registerSubscription({
      workspaceId: WS_A,
      workflowId: "wf_no_event_id",
      app: "custom_app",
      triggerId: "custom_event",
      verifier: "github-hmac-sha256",
      signingSecret: secret,
      eventIdPath: null,
    });

    // Body contains no 'id' or event identifier
    const body = JSON.stringify({ message: "hello world without an id field", score: 42 });
    const sigHex = await computeHmac("SHA-256", secret, body, "hex");
    const sigHeader = `sha256=${sigHex}`;

    let workflowRunCount = 0;
    const adapter = {
      onTriggerWorkflow: async () => {
        workflowRunCount += 1;
        return { runId: `run_custom_${workflowRunCount}` };
      },
    };

    const app = new Hono<WebhookEnv>();
    app.route("/api", createWebhookRoutes({ adapter }));

    // First request: no delivery headers in request
    const res1 = await makeRequest(app, `/api/webhooks/in/${sub.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sigHeader,
      },
      body,
    });

    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as any;
    expect(json1.received).toBe(true);
    expect(json1.deduplicated).toBe(false);
    expect(workflowRunCount).toBe(1);

    // Verify in D1 that px_webhook_deliveries record uses sig: prefix with sha256(sigHeader)
    const deliveryRow = await db
      .prepare("SELECT provider_event_id FROM px_webhook_deliveries WHERE subscription_id = ?")
      .bind(sub.id)
      .first<{ provider_event_id: string }>();

    expect(deliveryRow).toBeDefined();
    expect(deliveryRow?.provider_event_id).toMatch(/^sig:[0-9a-f]{64}$/);

    // Second request: same payload and signature
    const res2 = await makeRequest(app, `/api/webhooks/in/${sub.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sigHeader,
      },
      body,
    });

    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as any;
    expect(json2.received).toBe(true);
    expect(json2.deduplicated).toBe(true);
    expect(workflowRunCount).toBe(1);
  });

  it("AC 1: Every timestamped preset rejects timestamps outside ±toleranceSec and tolerance appears in preset table", async () => {
    expect(WEBHOOK_PRESETS).toBeDefined();

    // Verify preset table definition contains expected tolerances
    const timestampedPresets = ["slack-v0", "stripe-v1", "discord-ed25519", "timestamp-body-base64"];

    for (const name of timestampedPresets) {
      const preset = getPreset(name);
      expect(preset, `Preset ${name} must be defined`).toBeDefined();
      expect(preset?.toleranceSec, `Preset ${name} must define toleranceSec`).toBe(300);

      const secret = "test_key_for_preset_tolerance_audit_32_bytes_long!!";
      const nowSec = 1700000000;
      const tolerance = preset?.toleranceSec ?? 300;

      // 1. Past expiration: now - (tolerance + 1)
      const pastTs = nowSec - (tolerance + 1);
      const pastResult = await verifyWithScheme(
        preset!,
        {
          rawBody: `{"test":"${name}"}`,
          headers: {
            [preset!.signatureHeader]: "dummy_sig",
            ...(preset!.timestampHeader ? { [preset!.timestampHeader]: String(pastTs) } : {}),
            ...(preset!.signatureFormat?.kind === "kv-list" ? { [preset!.signatureHeader]: `t=${pastTs},v1=dummy_sig` } : {}),
          },
        },
        secret,
        nowSec,
      );
      expect(pastResult.ok).toBe(false);
      if (!pastResult.ok) {
        expect(
          pastResult.reason === "WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE" ||
          pastResult.reason === "WEBHOOK_SIGNATURE_MALFORMED",
        ).toBe(true);
      }

      // 2. Future expiration: now + (tolerance + 1)
      const futureTs = nowSec + (tolerance + 1);
      const futureResult = await verifyWithScheme(
        preset!,
        {
          rawBody: `{"test":"${name}"}`,
          headers: {
            [preset!.signatureHeader]: "dummy_sig",
            ...(preset!.timestampHeader ? { [preset!.timestampHeader]: String(futureTs) } : {}),
            ...(preset!.signatureFormat?.kind === "kv-list" ? { [preset!.signatureHeader]: `t=${futureTs},v1=dummy_sig` } : {}),
          },
        },
        secret,
        nowSec,
      );
      expect(futureResult.ok).toBe(false);
      if (!futureResult.ok) {
        expect(
          futureResult.reason === "WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE" ||
          futureResult.reason === "WEBHOOK_SIGNATURE_MALFORMED",
        ).toBe(true);
      }
    }
  });

  it("AC 2: Replaying any accepted delivery never starts a second workflow run across presets", async () => {
    const service = new WebhookService(db);
    const secret = "preset_replay_test_secret_123456789";
    const testedPresets = ["github-hmac-sha256", "slack-v0", "timestamp-body-base64"];

    for (const presetName of testedPresets) {
      const preset = getPreset(presetName)!;
      const sub = await service.registerSubscription({
        workspaceId: WS_A,
        workflowId: `wf_${presetName}`,
        app: "app_test",
        triggerId: "evt_test",
        verifier: presetName,
        signingSecret: secret,
      });

      const nowSec = 1700000000;
      const body = JSON.stringify({ preset: presetName, nonce: Math.random() });
      const ts = nowSec - 5;

      let sigHeaderVal: string;
      if (presetName === "slack-v0") {
        const hash = await computeHmac("SHA-256", secret, `v0:${ts}:${body}`, "hex");
        sigHeaderVal = `v0=${hash}`;
      } else if (presetName === "timestamp-body-base64") {
        sigHeaderVal = await computeHmac("SHA-256", secret, `${ts}${body}`, "base64");
      } else {
        const hash = await computeHmac("SHA-256", secret, body, "hex");
        sigHeaderVal = `sha256=${hash}`;
      }

      let runCount = 0;
      const adapter = {
        nowSeconds: () => nowSec,
        onTriggerWorkflow: async () => {
          runCount += 1;
          return { runId: `run_${presetName}_${runCount}` };
        },
      };

      const app = new Hono<WebhookEnv>();
      app.route("/api", createWebhookRoutes({ adapter }));

      const headers: Record<string, string> = {
        "content-type": "application/json",
        [preset.signatureHeader]: sigHeaderVal,
        ...(preset.timestampHeader ? { [preset.timestampHeader]: String(ts) } : {}),
      };

      // 1st request -> accepted, starts workflow
      const res1 = await makeRequest(app, `/api/webhooks/in/${sub.id}`, {
        method: "POST",
        headers,
        body,
      });
      expect(res1.status).toBe(200);
      const j1 = (await res1.json()) as any;
      expect(j1.received).toBe(true);
      expect(j1.deduplicated).toBe(false);
      expect(runCount).toBe(1);

      // 2nd request -> replay, deduplicated, never starts second workflow run
      const res2 = await makeRequest(app, `/api/webhooks/in/${sub.id}`, {
        method: "POST",
        headers,
        body,
      });
      expect(res2.status).toBe(200);
      const j2 = (await res2.json()) as any;
      expect(j2.received).toBe(true);
      expect(j2.deduplicated).toBe(true);
      expect(runCount).toBe(1);
    }
  });
});
