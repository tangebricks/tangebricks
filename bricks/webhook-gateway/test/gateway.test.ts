import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_webhook_gateway.sql?raw";
import {
  createWebhookRoutes,
  WebhookService,
  signHmacSha256,
  signStripeWebhookPayload,
  verifyWithScheme,
  type WebhookSignatureScheme,
} from "../src/index.ts";
import type { WebhookEnv } from "../src/routes.ts";
import type { WebhookGatewayAdapter } from "../src/gateway.ts";

const db = env.DB as D1Like;
const WS_A = "ws_wh_alpha";
const WS_B = "ws_wh_beta";

async function resetDb(): Promise<void> {
  for (const table of [
    "px_webhook_deliveries",
    "wh_subscriptions",
    "px_connections",
    "wh_deliveries",
    "wh_endpoints",
  ]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Webhook HMAC Cryptography", () => {
  it("generates and verifies HMAC-SHA256 signatures accurately in constant time", async () => {
    const payload = JSON.stringify({ event: "order.created", amount: 1500 });
    const secret = "whsec_test_secret_key_12345678901234567890";

    const sig = await signHmacSha256(payload, secret);
    expect(sig).toHaveLength(64);

    const scheme: WebhookSignatureScheme = {
      algorithm: "hmac-sha256",
      signedPayload: "{body}",
      signatureHeader: "x-signature",
      encoding: "hex",
    };

    // Valid
    const valid = await verifyWithScheme(scheme, { rawBody: payload, headers: { "x-signature": sig } }, secret);
    expect(valid.ok).toBe(true);
    // With sha256= prefix
    const prefixedScheme: WebhookSignatureScheme = { ...scheme, prefix: "sha256=" };
    const prefixed = await verifyWithScheme(prefixedScheme, { rawBody: payload, headers: { "x-signature": `sha256=${sig}` } }, secret);
    expect(prefixed.ok).toBe(true);

    // Tampered payload
    const tampered = await verifyWithScheme(scheme, { rawBody: payload + "tamper", headers: { "x-signature": sig } }, secret);
    expect(tampered.ok).toBe(false);
    // Wrong secret
    const wrongSecret = await verifyWithScheme(scheme, { rawBody: payload, headers: { "x-signature": sig } }, "wrong_secret");
    expect(wrongSecret.ok).toBe(false);
  });
});

describe("Webhook Ingress Gateway Core Logic", () => {
  it("ingests webhook with valid HMAC signature and stores delivery log in D1", async () => {
    const service = new WebhookService(db);
    const created = await service.createEndpoint(WS_A, "Stripe Hook", "stripe-orders");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const payload = JSON.stringify({ id: "evt_123", type: "charge.succeeded" });
    const signature = await signHmacSha256(payload, created.endpoint.signing_secret);

    const ingest = await service.ingestWebhook("stripe-orders", payload, { "user-agent": "Stripe/1.0" }, signature);
    expect(ingest.ok).toBe(true);
    if (!ingest.ok) return;
    expect(ingest.status).toBe(200);

    // Check delivery logs
    const deliveries = await service.listDeliveries(WS_A, created.endpoint.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status_code).toBe(200);
    expect(deliveries[0].signature_verified).toBe(true);
    expect(deliveries[0].payload_truncated).toBe(false);
  });

  it("rejects invalid HMAC signatures with 401 before storing anything (story 0.6: no delivery row for a rejected call)", async () => {
    const service = new WebhookService(db);
    const created = await service.createEndpoint(WS_A, "GitHub Hook", "github-push");
    if (!created.ok) return;

    const payload = "bad data";
    const invalidSig = "0000000000000000000000000000000000000000000000000000000000000000";

    const ingest = await service.ingestWebhook("github-push", payload, {}, invalidSig);
    expect(ingest.ok).toBe(false);
    expect(ingest.status).toBe(401);

    const deliveries = await service.listDeliveries(WS_A, created.endpoint.id);
    expect(deliveries).toHaveLength(0);

    // INGRESS_UNSIGNED: no signature at all is refused the same way, and nothing lands in any workspace.
    const unsigned = await service.ingestWebhook("github-push", payload, {}, "");
    expect(unsigned.ok).toBe(false);
    expect(unsigned.status).toBe(401);
    const all = await db.prepare("SELECT COUNT(*) AS n FROM wh_deliveries").first<{ n: number }>();
    expect(Number(all?.n)).toBe(0);
  });

  it("safely truncates payloads over 16KB to prevent D1 row exhaustion DoS", async () => {
    const service = new WebhookService(db);
    const created = await service.createEndpoint(WS_A, "Big Hook", "big-payload");
    if (!created.ok) return;

    // 25KB string
    const largePayload = "X".repeat(25000);
    const signature = await signHmacSha256(largePayload, created.endpoint.signing_secret);

    const ingest = await service.ingestWebhook("big-payload", largePayload, {}, signature);
    expect(ingest.ok).toBe(true);

    const deliveries = await service.listDeliveries(WS_A, created.endpoint.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload_truncated).toBe(true);
    expect(deliveries[0].payload_text?.length).toBe(16384);
  });

  it("supports zero-downtime secret rotation with grace period", async () => {
    const service = new WebhookService(db, 24); // 24 hours grace
    const created = await service.createEndpoint(WS_A, "Rotatable Hook", "rotatable");
    if (!created.ok) return;
    const oldSecret = created.endpoint.signing_secret;

    // Rotate secret
    const rotated = await service.rotateSecret(WS_A, created.endpoint.id);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    const payload = "test rotation payload";

    // 1. Signature with OLD secret still passes during grace period
    const oldSig = await signHmacSha256(payload, oldSecret);
    const oldIngest = await service.ingestWebhook("rotatable", payload, {}, oldSig);
    expect(oldIngest.ok).toBe(true);

    // 2. Signature with NEW secret passes immediately
    const newSig = await signHmacSha256(payload, rotated.newSecret);
    const newIngest = await service.ingestWebhook("rotatable", payload, {}, newSig);
    expect(newIngest.ok).toBe(true);
  });

  it("enforces multi-tenant isolation: Workspace B cannot see Workspace A endpoints or deliveries", async () => {
    const service = new WebhookService(db);
    const created = await service.createEndpoint(WS_A, "Alpha Hook", "alpha-wh");
    if (!created.ok) return;

    expect(await service.getEndpoint(WS_B, created.endpoint.id)).toBeNull();
    const listB = await service.listEndpoints(WS_B);
    expect(listB).toHaveLength(0);
  });
});

describe("Webhook Routes Integration (/api/webhooks/*)", () => {
  const createApp = (wsId = WS_A) => {
    const app = new Hono<WebhookEnv>();

    // Mock workspace & user context
    app.use("*", async (c, next) => {
      c.set("workspace", { id: wsId, role: "owner" });
      c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: wsId, role: "owner" }));
      c.set("user", { uid: "usr_alice", email: "alice@test.com" });
      await next();
    });

    app.route("/api", createWebhookRoutes());
    return app;
  };

  it("story 0.11 ID_GUESS: GET /webhooks/endpoints/:id/deliveries answers 404 for another workspace's endpoint id, 200 for its own", async () => {
    const service = new WebhookService(db);
    const created = await service.createEndpoint(WS_A, "Alpha Only", "alpha-only");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const req = () => new Request(`http://localhost/api/webhooks/endpoints/${created.endpoint.id}/deliveries`);

    expect((await createApp(WS_B).fetch(req(), { DB: db })).status).toBe(404);

    const own = await createApp(WS_A).fetch(req(), { DB: db });
    expect(own.status).toBe(200);
    expect(((await own.json()) as { deliveries: unknown[] }).deliveries).toEqual([]);
  });

  it("story 0.11: GET /webhooks/endpoints/:slug/deliveries resolves the slug to the endpoint and returns its deliveries", async () => {
    const service = new WebhookService(db);
    const created = await service.createEndpoint(WS_A, "Slug Hook", "slug-hook");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const payload = JSON.stringify({ id: "evt_slug" });
    const signature = await signHmacSha256(payload, created.endpoint.signing_secret);
    expect((await service.ingestWebhook("slug-hook", payload, {}, signature)).ok).toBe(true);

    const bySlug = await createApp(WS_A).fetch(new Request("http://localhost/api/webhooks/endpoints/slug-hook/deliveries"), { DB: db });
    expect(bySlug.status).toBe(200);
    const { deliveries } = (await bySlug.json()) as { deliveries: Array<{ endpoint_id: string }> };
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.endpoint_id).toBe(created.endpoint.id);

    expect((await createApp(WS_B).fetch(new Request("http://localhost/api/webhooks/endpoints/slug-hook/deliveries"), { DB: db })).status).toBe(404);
  });

  it("POST /api/webhooks/ingress/:slug -> processes inbound call without auth header", async () => {
    const app = createApp(WS_A);
    const service = new WebhookService(db);
    const created = await service.createEndpoint(WS_A, "Public Ingress", "public-in");
    if (!created.ok) return;

    const body = JSON.stringify({ hello: "world" });
    const sig = await signHmacSha256(body, created.endpoint.signing_secret);

    const res = await app.fetch(
      new Request("http://localhost/api/webhooks/ingress/public-in", {
        method: "POST",
        headers: { "X-Signature-SHA256": sig },
        body,
      }),
      { DB: db }
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { received: boolean };
    expect(json.received).toBe(true);
  });

  it("POST /api/webhooks/in/:subscriptionId -> verifies Stripe signature (5-min replay window), unseals px_connections secret, deduplicates in px_webhook_deliveries, and triggers workflow + telemetry", async () => {
    const triggeredRuns: Array<{ workflowId: string; eventPayload: unknown; providerEventId: string }> = [];
    const emittedTelemetry: Array<{ kind: string; subscriptionId: string; providerEventId: string }> = [];
    const adapter: WebhookGatewayAdapter = {
      onTriggerWorkflow: async (input) => {
        const runId = `run_${triggeredRuns.length + 1}`;
        triggeredRuns.push({
          workflowId: input.workflowId,
          eventPayload: input.eventPayload,
          providerEventId: input.providerEventId,
        });
        return { runId };
      },
      onEmitTelemetry: async (evt) => {
        emittedTelemetry.push({
          kind: evt.kind,
          subscriptionId: evt.subscriptionId,
          providerEventId: evt.providerEventId,
        });
      },
    };

    const app = new Hono<WebhookEnv>();
    app.route("/api", createWebhookRoutes({ adapter }));

    // Seal a Stripe webhook signing secret into px_connections using AES-GCM with PX_CONN_KEY
    const pxConnKey = "test-px-conn-master-key-for-stripe-webhook-12345";
    const webhookSecret = "whsec_stripe_live_signing_secret_987654321";
    const rawKeyMaterial = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`projectx-studio-vault-v1:${pxConnKey}`),
    );
    const aesKey = await crypto.subtle.importKey(
      "raw",
      rawKeyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      new TextEncoder().encode(JSON.stringify({ webhookSecret })),
    );
    const toBase64 = (u8: Uint8Array) => {
      let bin = "";
      for (const b of u8) bin += String.fromCharCode(b);
      return btoa(bin);
    };

    await db
      .prepare(
        `INSERT INTO px_connections (ref, project_id, env_name, workspace_id, app, auth_type, label, scopes_json, ciphertext_b64, iv_b64, key_hint, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', datetime('now'))`,
      )
      .bind(
        "conn_stripe_wh",
        "default",
        "preview",
        WS_A,
        "stripe",
        "webhook-secret",
        "Stripe Webhook Secret",
        "[]",
        toBase64(new Uint8Array(cipherBuf)),
        toBase64(iv),
        "••••4321",
      )
      .run();

    const service = new WebhookService(db);
    await service.registerSubscription({
      id: "sub_stripe_invoice_paid",
      workspaceId: WS_A,
      app: "stripe",
      triggerId: "invoice.paid",
      workflowId: "wf-invoice-paid",
      connectionRef: "conn_stripe_wh",
      verificationScheme: "stripe-signature",
      signatureHeader: "Stripe-Signature",
      eventIdPath: "$.id",
    });

    const eventBody = JSON.stringify({
      id: "evt_stripe_001",
      type: "invoice.paid",
      data: { object: { id: "in_001", amount_paid: 4900 } },
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const validStripeHeader = await signStripeWebhookPayload(eventBody, webhookSecret, nowSec);

    // 1. Valid novel delivery -> 200 { received: true, deduplicated: false, runId: "run_1" }
    const res1 = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_stripe_invoice_paid", {
        method: "POST",
        headers: { "Stripe-Signature": validStripeHeader, "Content-Type": "application/json" },
        body: eventBody,
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as { received: boolean; deduplicated: boolean; runId?: string };
    expect(json1).toMatchObject({
      received: true,
      deduplicated: false,
      runId: "run_1",
      providerEventId: "evt_stripe_001",
    });
    expect(triggeredRuns).toHaveLength(1);
    expect(triggeredRuns[0].workflowId).toBe("wf-invoice-paid");
    expect(emittedTelemetry).toHaveLength(1);
    expect(emittedTelemetry[0]).toEqual({
      kind: "trigger.fired",
      subscriptionId: "sub_stripe_invoice_paid",
      providerEventId: "evt_stripe_001",
    });

    // 2. Duplicate delivery with same provider_event_id -> 200 { received: true, deduplicated: true } without starting a duplicate run
    const resDup = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_stripe_invoice_paid", {
        method: "POST",
        headers: { "Stripe-Signature": validStripeHeader, "Content-Type": "application/json" },
        body: eventBody,
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(resDup.status).toBe(200);
    const jsonDup = (await resDup.json()) as { received: boolean; deduplicated: boolean };
    expect(jsonDup).toMatchObject({
      received: true,
      deduplicated: true,
      providerEventId: "evt_stripe_001",
    });
    expect(triggeredRuns).toHaveLength(1);

    // 3. Stale timestamp (> 5-minute / 300s window) -> 401
    const staleStripeHeader = await signStripeWebhookPayload(eventBody, webhookSecret, nowSec - 360);
    const resStale = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_stripe_invoice_paid", {
        method: "POST",
        headers: { "Stripe-Signature": staleStripeHeader, "Content-Type": "application/json" },
        body: eventBody,
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(resStale.status).toBe(401);

    // 4. Tampered signature -> 401
    const resTampered = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_stripe_invoice_paid", {
        method: "POST",
        headers: {
          "Stripe-Signature": `t=${nowSec},v1=0000000000000000000000000000000000000000000000000000000000000000`,
          "Content-Type": "application/json",
        },
        body: eventBody,
      }),
      { DB: db, PX_CONN_KEY: pxConnKey },
    );
    expect(resTampered.status).toBe(401);
  });

  it("POST /api/webhooks/in/:subscriptionId -> supports shared-secret verification scheme", async () => {
    const app = new Hono<WebhookEnv>();
    app.route("/api", createWebhookRoutes());

    const service = new WebhookService(db);
    await service.registerSubscription({
      id: "sub_shared_secret",
      workspaceId: WS_A,
      app: "custom-hook",
      triggerId: "ping",
      workflowId: "wf-ping",
      signingSecret: "shared_token_xyz_999",
      verificationScheme: "shared-secret",
      signatureHeader: "X-Webhook-Token",
      eventIdPath: "$.eventId",
    });

    const body = JSON.stringify({ eventId: "ping_1", ok: true });
    const badRes = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_shared_secret", {
        method: "POST",
        headers: { "X-Webhook-Token": "wrong_token" },
        body,
      }),
      { DB: db },
    );
    expect(badRes.status).toBe(401);

    const okRes = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_shared_secret", {
        method: "POST",
        headers: { "X-Webhook-Token": "shared_token_xyz_999" },
        body,
      }),
      { DB: db },
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toMatchObject({
      received: true,
      deduplicated: false,
      providerEventId: "ping_1",
    });
  });
});

describe("POST /api/webhooks/subscriptions takes the workspace from the verified context only", () => {
  const subscribe = (app: Hono<WebhookEnv>, body: Record<string, unknown>) =>
    app.fetch(
      new Request("http://localhost/api/webhooks/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: "stripe", triggerId: "charge.succeeded", workflowId: "wf-1", verifier: "hmac-sha256", ...body }),
      }),
      { DB: db },
    );

  it("refuses (401) when no user or workspace context was set, instead of falling back to a 'default' workspace", async () => {
    const app = new Hono<WebhookEnv>();
    app.route("/api", createWebhookRoutes());
    const res = await subscribe(app, { workspaceId: WS_A });
    expect(res.status).toBe(401);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM wh_subscriptions").first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("a body workspaceId naming another workspace is ignored: the row lands in the context's workspace", async () => {
    const app = new Hono<WebhookEnv>();
    app.use("*", async (c, next) => {
      c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: WS_A, role: "admin" }));
      await next();
    });
    app.route("/api", createWebhookRoutes());
    const res = await subscribe(app, { workspaceId: WS_B });
    expect(res.status).toBe(201);
    const rows = await db.prepare("SELECT workspace_id FROM wh_subscriptions").all<{ workspace_id: string }>();
    expect(rows.results.map((r) => r.workspace_id)).toEqual([WS_A]);
  });

  it("story 0.6: a plain member is refused (403, before validation) and nothing is written (audit risk 8)", async () => {
    const app = new Hono<WebhookEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { uid: "usr_carol" });
      c.set("ctx", Object.freeze({ userId: "usr_carol", workspaceId: WS_A, role: "member" }));
      await next();
    });
    app.route("/api", createWebhookRoutes());
    expect((await subscribe(app, {})).status).toBe(403);
    expect((await subscribe(app, { verifier: 42 })).status).toBe(403);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM wh_subscriptions").first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });
});

describe("webhook endpoint create and rotate need owner/admin (story 0.6)", () => {
  function appAs(role: string | null): Hono<WebhookEnv> {
    const app = new Hono<WebhookEnv>();
    app.use("*", async (c, next) => {
      if (role) {
        c.set("user", { uid: "usr_x" });
        c.set("ctx", Object.freeze({ userId: "usr_x", workspaceId: WS_A, role }));
      }
      await next();
    });
    app.route("/api", createWebhookRoutes());
    return app;
  }
  const create = (role: string | null, body = JSON.stringify({ name: "Hook", slug: "hook-a" })) =>
    appAs(role).fetch(new Request("http://localhost/api/webhooks/endpoints", { method: "POST", headers: { "Content-Type": "application/json" }, body }), { DB: db });
  const rotate = (role: string | null, id: string) =>
    appAs(role).fetch(new Request(`http://localhost/api/webhooks/endpoints/${id}/rotate`, { method: "POST" }), { DB: db });

  it("UNAUTH 401, MEMBER 403 (before validation), ADMIN creates and rotates", async () => {
    const service = new WebhookService(db);
    expect((await create(null)).status).toBe(401);
    expect((await create("member")).status).toBe(403);
    expect((await create("member", "{bad")).status).toBe(403);
    expect(await service.listEndpoints(WS_A)).toHaveLength(0);
    const res = await create("admin");
    expect(res.status).toBe(201);
    const { endpoint } = (await res.json()) as { endpoint: { id: string; signing_secret: string } };
    expect((await rotate(null, endpoint.id)).status).toBe(401);
    expect((await rotate("member", endpoint.id)).status).toBe(403);
    expect((await service.getEndpoint(WS_A, endpoint.id))?.signing_secret).toBe(endpoint.signing_secret);
    expect((await rotate("admin", endpoint.id)).status).toBe(200);
  });
});

describe("POST /api/webhooks/ingress/:slug refuses unsigned calls before writing (story 0.6)", () => {
  it("INGRESS_UNSIGNED: unsigned and bad-signature calls get 401 and leave no delivery row; a signed call is stored", async () => {
    const service = new WebhookService(db);
    const created = await service.createEndpoint(WS_B, "B hook", "b-hook");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const app = new Hono<WebhookEnv>();
    app.route("/api", createWebhookRoutes());
    const body = JSON.stringify({ forged: true });
    const ingress = (headers: Record<string, string>) =>
      app.fetch(new Request("http://localhost/api/webhooks/ingress/b-hook", { method: "POST", headers, body }), { DB: db });

    expect((await ingress({})).status).toBe(401);
    expect((await ingress({ "X-Signature-SHA256": "deadbeef" })).status).toBe(401);
    expect((await ingress({ "x-test-user": "alice", "x-workspace-id": WS_B })).status).toBe(401);
    expect(await service.listDeliveries(WS_B, created.endpoint.id)).toHaveLength(0);

    const sig = await signHmacSha256(body, created.endpoint.signing_secret);
    expect((await ingress({ "X-Signature-SHA256": sig })).status).toBe(200);
    expect(await service.listDeliveries(WS_B, created.endpoint.id)).toHaveLength(1);
  });
});
