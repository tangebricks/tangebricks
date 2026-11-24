import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration0001 from "../migrations/0001_webhook_gateway.sql?raw";
import migration0002 from "../migrations/0002_webhook_signature_scheme.sql?raw";
import {
  createWebhookRoutes,
  WebhookService,
} from "../src/index.ts";
import type { WebhookEnv, WebhookRouteOptions } from "../src/routes.ts";
import type { WebhookGatewayAdapter } from "../src/gateway.ts";

const db = env.DB as D1Like;
const WS_DEFAULT = "ws_scheme_mig";

async function signHmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signStripePayload(secret: string, timestamp: number, payload: string): Promise<string> {
  const signed = `${timestamp}.${payload}`;
  const sig = await signHmacSha256Hex(secret, signed);
  return `t=${timestamp},v1=${sig}`;
}

const createApp = (options: WebhookRouteOptions = {}, wsId = WS_DEFAULT) => {
  const app = new Hono<WebhookEnv>();
  app.use("*", async (c, next) => {
    c.set("workspace", { id: wsId, role: "admin" });
    c.set("ctx", Object.freeze({ userId: "usr_migrator", workspaceId: wsId, role: "admin" }));
    c.set("user", { uid: "usr_migrator", email: "migrator@test.com" });
    await next();
  });
  app.route("/api", createWebhookRoutes(options));
  return app;
};

async function resetDb(): Promise<void> {
  for (const table of [
    "px_webhook_deliveries",
    "wh_subscriptions_v2",
    "wh_subscriptions",
    "px_connections",
    "wh_deliveries",
    "wh_endpoints",
    "px_logs",
  ]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
}

describe("Story UC4.5 — Persist scheme configs and migrate stored subscriptions", () => {
  beforeEach(async () => {
    expect.hasAssertions();
    await resetDb();
  });

  it("migrates 0001 subscriptions to 0002 schema with scheme_json and disabled_reason", async () => {
    await applyMigration(db, migration0001);

    // Seed pre-migration rows using 0001 schema
    await db
      .prepare(
        `INSERT INTO wh_subscriptions (
          id, workspace_id, workflow_id, app, trigger_id, verifier, signature_header, signing_secret, enabled, created_at
        ) VALUES
          (?, ?, ?, ?, ?, 'hmac-sha256', 'X-Custom-Signature', 'sec_hmac_123', 1, '2026-01-01 00:00:00'),
          (?, ?, ?, ?, ?, 'stripe-signature', 'Stripe-Signature', 'whsec_stripe_123', 1, '2026-01-02 00:00:00'),
          (?, ?, ?, ?, ?, 'shared-secret', 'X-Webhook-Secret', 'shared_secret_123', 1, '2026-01-03 00:00:00'),
          (?, ?, ?, ?, ?, 'none', 'X-None', NULL, 1, '2026-01-04 00:00:00'),
          (?, ?, ?, ?, ?, 'ed25519', 'X-Signature-Ed25519', 'ed_shared_secret', 1, '2026-01-05 00:00:00')`,
      )
      .bind(
        "sub_mig_hmac", "ws_hmac", "wf_hmac", "github", "push",
        "sub_mig_stripe", "ws_stripe", "wf_stripe", "stripe", "payment",
        "sub_mig_shared", "ws_shared", "wf_shared", "custom", "event",
        "sub_mig_none", "ws_none", "wf_none", "custom", "test",
        "sub_mig_ed25519", "ws_ed", "wf_ed", "discord", "interaction",
      )
      .run();

    // Apply migration 0002
    await applyMigration(db, migration0002);

    interface SubMigratedRow {
      id: string;
      workspace_id: string;
      workflow_id: string;
      verifier: string;
      signature_header: string;
      scheme_json: string;
      disabled_reason: string | null;
      enabled: number;
      created_at: string;
    }

    const { results } = await db
      .prepare("SELECT * FROM wh_subscriptions ORDER BY id ASC")
      .all<SubMigratedRow>();

    const rowsById = new Map(results.map((r) => [r.id, r]));

    // 1. hmac-sha256 -> scheme_json preset with custom signature_header preserved
    const rowHmac = rowsById.get("sub_mig_hmac")!;
    expect(rowHmac).toBeDefined();
    expect(rowHmac.workspace_id).toBe("ws_hmac");
    expect(rowHmac.created_at).toBe("2026-01-01 00:00:00");
    expect(rowHmac.enabled).toBe(1);
    expect(rowHmac.disabled_reason).toBeNull();
    const hmacScheme = JSON.parse(rowHmac.scheme_json);
    expect(hmacScheme.preset).toBe("github-hmac-sha256");
    expect(hmacScheme.signatureHeader).toBe("X-Custom-Signature");

    // 2. stripe-signature -> preset
    const rowStripe = rowsById.get("sub_mig_stripe")!;
    expect(rowStripe).toBeDefined();
    expect(rowStripe.workspace_id).toBe("ws_stripe");
    expect(rowStripe.created_at).toBe("2026-01-02 00:00:00");
    expect(rowStripe.enabled).toBe(1);
    expect(rowStripe.disabled_reason).toBeNull();
    const stripeScheme = JSON.parse(rowStripe.scheme_json);
    expect(stripeScheme.preset).toBe("stripe-signature");

    // 3. shared-secret -> preset
    const rowShared = rowsById.get("sub_mig_shared")!;
    expect(rowShared).toBeDefined();
    expect(rowShared.workspace_id).toBe("ws_shared");
    expect(rowShared.created_at).toBe("2026-01-03 00:00:00");
    expect(rowShared.enabled).toBe(1);
    expect(rowShared.disabled_reason).toBeNull();
    const sharedScheme = JSON.parse(rowShared.scheme_json);
    expect(sharedScheme.preset).toBe("shared-secret");

    // 4. none -> enabled = 0, disabled_reason = 'WEBHOOK_VERIFIER_NONE_FORBIDDEN'
    const rowNone = rowsById.get("sub_mig_none")!;
    expect(rowNone).toBeDefined();
    expect(rowNone.workspace_id).toBe("ws_none");
    expect(rowNone.created_at).toBe("2026-01-04 00:00:00");
    expect(rowNone.enabled).toBe(0);
    expect(rowNone.disabled_reason).toBe("WEBHOOK_VERIFIER_NONE_FORBIDDEN");

    // 5. ed25519 -> enabled = 0, disabled_reason = 'WEBHOOK_ED25519_PUBLIC_KEY_REQUIRED'
    const rowEd = rowsById.get("sub_mig_ed25519")!;
    expect(rowEd).toBeDefined();
    expect(rowEd.workspace_id).toBe("ws_ed");
    expect(rowEd.created_at).toBe("2026-01-05 00:00:00");
    expect(rowEd.enabled).toBe(0);
    expect(rowEd.disabled_reason).toBe("WEBHOOK_ED25519_PUBLIC_KEY_REQUIRED");
  });

  it("AC1: previously enabled hmac-sha256, stripe-signature and shared-secret verify pre-migration signed requests", async () => {
    await applyMigration(db, migration0001);
    await db
      .prepare(
        `INSERT INTO wh_subscriptions (
          id, workspace_id, workflow_id, app, trigger_id, verifier, signature_header, signing_secret, enabled, created_at
        ) VALUES
          ('sub_ac1_hmac', 'ws_hmac', 'wf_hmac', 'github', 'push', 'hmac-sha256', 'X-Custom-Signature', 'sec_hmac_123', 1, '2026-01-01 00:00:00'),
          ('sub_ac1_stripe', 'ws_stripe', 'wf_stripe', 'stripe', 'payment', 'stripe-signature', 'Stripe-Signature', 'whsec_stripe_123', 1, '2026-01-02 00:00:00'),
          ('sub_ac1_shared', 'ws_shared', 'wf_shared', 'custom', 'event', 'shared-secret', 'X-Webhook-Secret', 'shared_secret_123', 1, '2026-01-03 00:00:00')`,
      )
      .run();
    await applyMigration(db, migration0002);

    const triggeredWorkflows: string[] = [];
    const adapter: WebhookGatewayAdapter = {
      onTriggerWorkflow: async ({ workflowId }) => {
        triggeredWorkflows.push(workflowId);
        return { runId: `run_${workflowId}` };
      },
    };

    const app = createApp({ adapter });

    // 1. Replay pre-migration signed HMAC request with custom header
    const hmacPayload = JSON.stringify({ id: "evt_hmac_1", action: "opened" });
    const hmacSigHex = await signHmacSha256Hex("sec_hmac_123", hmacPayload);
    const hmacRes = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_ac1_hmac", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Custom-Signature": `sha256=${hmacSigHex}`,
        },
        body: hmacPayload,
      }),
      { DB: db },
    );
    expect(hmacRes.status).toBe(200);
    expect(await hmacRes.json()).toMatchObject({ received: true });
    expect(triggeredWorkflows).toContain("wf_hmac");

    // 2. Replay pre-migration signed Stripe request
    const nowSec = Math.floor(Date.now() / 1000);
    const stripePayload = JSON.stringify({ id: "evt_stripe_1", type: "charge.succeeded" });
    const stripeSig = await signStripePayload("whsec_stripe_123", nowSec, stripePayload);
    const stripeRes = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_ac1_stripe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": stripeSig,
        },
        body: stripePayload,
      }),
      { DB: db },
    );
    expect(stripeRes.status).toBe(200);
    expect(await stripeRes.json()).toMatchObject({ received: true });
    expect(triggeredWorkflows).toContain("wf_stripe");

    // 3. Replay pre-migration shared secret request
    const sharedPayload = JSON.stringify({ id: "evt_shared_1", data: "test" });
    const sharedRes = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_ac1_shared", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": "shared_secret_123",
        },
        body: sharedPayload,
      }),
      { DB: db },
    );
    expect(sharedRes.status).toBe(200);
    expect(await sharedRes.json()).toMatchObject({ received: true });
    expect(triggeredWorkflows).toContain("wf_shared");
  });

  it("AC2: none and ed25519 rows are disabled and their ingress returns 401 with their disabled_reason code", async () => {
    await applyMigration(db, migration0001);
    await db
      .prepare(
        `INSERT INTO wh_subscriptions (
          id, workspace_id, workflow_id, app, trigger_id, verifier, signature_header, signing_secret, enabled, created_at
        ) VALUES
          ('sub_ac2_none', 'ws_none', 'wf_none', 'custom', 'test', 'none', 'X-None', NULL, 1, '2026-01-04 00:00:00'),
          ('sub_ac2_ed25519', 'ws_ed', 'wf_ed', 'discord', 'interaction', 'ed25519', 'X-Signature-Ed25519', 'ed_shared_secret', 1, '2026-01-05 00:00:00')`,
      )
      .run();
    await applyMigration(db, migration0002);

    let triggered = false;
    const adapter: WebhookGatewayAdapter = {
      onTriggerWorkflow: async () => {
        triggered = true;
        return { runId: "run_never" };
      },
    };

    const app = createApp({ adapter });

    // Ingress on disabled 'none' row returns 401 with WEBHOOK_VERIFIER_NONE_FORBIDDEN
    const resNone = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_ac2_none", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "evt_none_1" }),
      }),
      { DB: db },
    );
    expect(resNone.status).toBe(401);
    const bodyNone = (await resNone.json()) as { error?: string };
    expect(bodyNone.error).toBe("WEBHOOK_VERIFIER_NONE_FORBIDDEN");
    expect(triggered).toBe(false);

    // Ingress on disabled 'ed25519' row returns 401 with WEBHOOK_ED25519_PUBLIC_KEY_REQUIRED
    const resEd = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_ac2_ed25519", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "evt_ed_1" }),
      }),
      { DB: db },
    );
    expect(resEd.status).toBe(401);
    const bodyEd = (await resEd.json()) as { error?: string };
    expect(bodyEd.error).toBe("WEBHOOK_ED25519_PUBLIC_KEY_REQUIRED");
    expect(triggered).toBe(false);
  });

  it("AC3: registering a subscription with an invalid scheme returns 400 WEBHOOK_SCHEME_INVALID with the zod path", async () => {
    await applyMigration(db, migration0001);
    await applyMigration(db, migration0002);

    const app = createApp();

    // 1. Invalid algorithm in scheme object
    const resBadAlgo = await app.fetch(
      new Request("http://localhost/api/webhooks/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app: "stripe",
          triggerId: "charge.succeeded",
          workflowId: "wf-1",
          verifier: {
            algorithm: "invalid-sha-bogus",
            signedPayload: "{body}",
            signatureHeader: "x-sig",
            encoding: "hex",
          },
        }),
      }),
      { DB: db },
    );
    expect(resBadAlgo.status).toBe(400);
    const bodyBadAlgo = (await resBadAlgo.json()) as { error?: string; path?: string };
    expect(bodyBadAlgo.error).toBe("WEBHOOK_SCHEME_INVALID");
    expect(bodyBadAlgo.path).toContain("algorithm");

    // 2. Invalid signedPayload token in scheme object
    const resBadPayload = await app.fetch(
      new Request("http://localhost/api/webhooks/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app: "github",
          triggerId: "push",
          workflowId: "wf-2",
          verifier: {
            algorithm: "hmac-sha256",
            signedPayload: "{unknown_token}",
            signatureHeader: "x-hub-signature-256",
            encoding: "hex",
          },
        }),
      }),
      { DB: db },
    );
    expect(resBadPayload.status).toBe(400);
    const bodyBadPayload = (await resBadPayload.json()) as { error?: string; path?: string };
    expect(bodyBadPayload.error).toBe("WEBHOOK_SCHEME_INVALID");
    expect(bodyBadPayload.path).toContain("signedPayload");

    // 3. Direct registerSubscription throws with code WEBHOOK_SCHEME_INVALID and path
    const service = new WebhookService(db);
    await expect(
      service.registerSubscription({
        app: "test",
        triggerId: "trig",
        workflowId: "wf-3",
        verifier: {
          algorithm: "hmac-sha256",
          signedPayload: "",
          signatureHeader: "x-sig",
          encoding: "hex",
        },
      }),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SCHEME_INVALID",
      path: expect.stringContaining("signedPayload"),
    });
  });

  it("registers subscriptions with presets and full schemes, storing scheme_json and verifying ingress", async () => {
    await applyMigration(db, migration0001);
    await applyMigration(db, migration0002);

    const triggeredWorkflows: string[] = [];
    const adapter: WebhookGatewayAdapter = {
      onTriggerWorkflow: async ({ workflowId }) => {
        triggeredWorkflows.push(workflowId);
        return { runId: `run_${workflowId}` };
      },
    };

    const service = new WebhookService(db);

    // Register with preset
    const subPreset = await service.registerSubscription({
      id: "sub_new_slack",
      workspaceId: WS_DEFAULT,
      app: "slack",
      triggerId: "app_mention",
      workflowId: "wf_slack",
      verifier: "slack-v0",
      signingSecret: "slack_sec_123",
    });
    expect(subPreset.scheme_json).toBeDefined();

    // Verify DB row
    const rowPreset = await db
      .prepare("SELECT * FROM wh_subscriptions WHERE id = ?")
      .bind("sub_new_slack")
      .first<{ scheme_json: string }>();
    expect(rowPreset?.scheme_json).toBeDefined();
    expect(JSON.parse(rowPreset!.scheme_json).preset).toBe("slack-v0");

    // Register with full custom scheme
    const subCustom = await service.registerSubscription({
      id: "sub_new_custom",
      workspaceId: WS_DEFAULT,
      app: "custom_app",
      triggerId: "hook",
      workflowId: "wf_custom",
      verifier: {
        algorithm: "hmac-sha256",
        signedPayload: "{timestamp}.{body}",
        signatureHeader: "X-My-Sig",
        timestampHeader: "X-My-Time",
        encoding: "hex",
        toleranceSec: 300,
      },
      signingSecret: "custom_sec_123",
    });
    expect(subCustom.scheme_json).toBeDefined();

    // Ingress test on the custom scheme
    const app = createApp({ adapter });
    const nowSec = Math.floor(Date.now() / 1000);
    const bodyStr = JSON.stringify({ id: "evt_c1", message: "hi" });
    const sigHex = await signHmacSha256Hex("custom_sec_123", `${nowSec}.${bodyStr}`);

    const res = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_new_custom", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-My-Sig": sigHex,
          "X-My-Time": String(nowSec),
        },
        body: bodyStr,
      }),
      { DB: db },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });
    expect(triggeredWorkflows).toContain("wf_custom");
  });
});
