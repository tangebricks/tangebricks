import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_outbound_webhooks.sql?raw";
import {
  OutboundWebhookService,
  signWebhookPayload,
  createOutboundWebhookRoutes,
} from "../src/index.ts";
import type { OutboundWebhookEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_owh_alpha";
const WS_BETA = "ws_owh_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS owh_deliveries").run();
  await db.prepare("DROP TABLE IF EXISTS owh_endpoints").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Outbound Webhook Signatures & Core Logic", () => {
  it("generates HMAC-SHA256 signature with timestamp", async () => {
    const secret = "whsec_test_secret_12345678901234567890";
    const ts = 1729850000;
    const sig = await signWebhookPayload(secret, ts, JSON.stringify({ event: "ping" }));

    expect(sig).toMatch(/^t=1729850000,v1=[a-f0-9]{64}$/);
  });

  it("creates endpoint with generated whsec_ secret and wildcard subscription", async () => {
    const service = new OutboundWebhookService(db);
    const ep = await service.createEndpoint({
      workspaceId: WS_ALPHA,
      targetUrl: "https://api.acme.com/webhooks",
      description: "Acme Main Receiver",
    });

    expect(ep.id).toMatch(/^whep_[a-f0-9]{32}$/);
    expect(ep.secret).toMatch(/^whsec_[a-f0-9]{48}$/);
    expect(ep.events).toEqual(["*"]);
    expect(ep.is_active).toBe(true);

    const list = await service.listEndpoints(WS_ALPHA);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(ep.id);
  });

  it("dispatches event to matching endpoints and logs delivery details", async () => {
    // Mock fetch that records calls and returns 200 OK
    const recordedCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const mockFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      recordedCalls.push({
        url,
        headers: (init?.headers as Record<string, string>) || {},
        body: String(init?.body || ""),
      });
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    };

    // Offline resolver for the SSRF guard: every test host resolves to a public documentation-free address.
    const service = new OutboundWebhookService(db, mockFetch, { resolveHost: async () => ["93.184.216.34"] });

    // Endpoint 1: Subscribed to all events
    await service.createEndpoint({
      workspaceId: WS_ALPHA,
      targetUrl: "https://wildcard.example.com/hook",
      events: ["*"],
    });

    // Endpoint 2: Subscribed only to 'invoice.paid'
    await service.createEndpoint({
      workspaceId: WS_ALPHA,
      targetUrl: "https://billing.example.com/hook",
      events: ["invoice.paid"],
    });

    // Endpoint 3: Subscribed only to 'user.created' (should NOT receive invoice.paid)
    await service.createEndpoint({
      workspaceId: WS_ALPHA,
      targetUrl: "https://auth.example.com/hook",
      events: ["user.created"],
    });

    // Dispatch 'invoice.paid' event
    const deliveries = await service.dispatchEvent(WS_ALPHA, "invoice.paid", { invoiceId: "inv_9988" });

    // Should dispatch to 2 endpoints (wildcard + billing)
    expect(deliveries).toHaveLength(2);
    expect(recordedCalls).toHaveLength(2);

    expect(deliveries[0]?.success).toBe(true);
    expect(deliveries[0]?.status_code).toBe(200);
    // WEBHOOK_BODY: the endpoint's response body is never stored (status code is kept).
    expect(deliveries[0]?.response_body).toBeNull();
    expect(deliveries[0]?.attempt_number).toBe(1);

    // Verify headers sent
    expect(recordedCalls[0]?.headers["X-ProjectX-Event"]).toBe("invoice.paid");
    expect(recordedCalls[0]?.headers["X-ProjectX-Signature"]).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    // Replay delivery
    // deliveries has length 2 (asserted above), so [0] exists.
    const replay = await service.replayDelivery(deliveries[0]!.id, WS_ALPHA);
    expect(replay).not.toBeNull();
    expect(replay?.attempt_number).toBe(2);
    expect(replay?.success).toBe(true);
  });

  it("strictly isolates webhook subscriptions between workspaces", async () => {
    const service = new OutboundWebhookService(db);
    await service.createEndpoint({ workspaceId: WS_ALPHA, targetUrl: "https://alpha.com/hook" });
    await service.createEndpoint({ workspaceId: WS_BETA, targetUrl: "https://beta.com/hook" });

    const epsAlpha = await service.listEndpoints(WS_ALPHA);
    const epsBeta = await service.listEndpoints(WS_BETA);

    expect(epsAlpha).toHaveLength(1);
    expect(epsBeta).toHaveLength(1);
    expect(epsAlpha[0]?.target_url).toBe("https://alpha.com/hook");
    expect(epsBeta[0]?.target_url).toBe("https://beta.com/hook");
  });
});

describe("Outbound webhook SSRF guard and stored response", () => {
  const publicResolver = async () => ["93.184.216.34"];

  it("SSRF: refuses internal-address targets and records the delivery as failed with the guard code", async () => {
    const calls: string[] = [];
    const mockFetch = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response("internal secret page", { status: 200 });
    };
    const service = new OutboundWebhookService(db, mockFetch, { resolveHost: publicResolver });
    for (const targetUrl of [
      "http://127.0.0.1/hook",
      "http://10.0.0.5/hook",
      "http://[::1]/hook",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost/hook",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      await service.createEndpoint({ workspaceId: WS_ALPHA, targetUrl });
    }

    const deliveries = await service.dispatchEvent(WS_ALPHA, "invoice.paid", { invoiceId: "inv_1" });
    expect(deliveries).toHaveLength(6);
    expect(calls).toHaveLength(0);
    for (const d of deliveries) {
      expect(d.success).toBe(false);
      expect(d.status_code).toBe(0);
      expect(d.response_body).toBe("EGRESS_FORBIDDEN");
    }
    const stored = await service.listDeliveries(WS_ALPHA);
    expect(stored).toHaveLength(6);
    expect(stored.every((d) => !d.success && d.response_body === "EGRESS_FORBIDDEN")).toBe(true);
  });

  it("SSRF: refuses a public endpoint that redirects to an internal address", async () => {
    const calls: string[] = [];
    const mockFetch = async (url: string): Promise<Response> => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    };
    const service = new OutboundWebhookService(db, mockFetch, { resolveHost: publicResolver });
    await service.createEndpoint({ workspaceId: WS_ALPHA, targetUrl: "https://example.com/hook" });

    const [delivery] = await service.dispatchEvent(WS_ALPHA, "invoice.paid", {});
    expect(calls).toEqual(["https://example.com/hook"]);
    expect(delivery!.success).toBe(false);
    expect(delivery!.response_body).toBe("EGRESS_FORBIDDEN");
  });

  it("WEBHOOK_BODY: stores a null response body but keeps the status code, for success and failure", async () => {
    const mockFetch = async (url: string): Promise<Response> =>
      url.includes("fail")
        ? new Response("upstream error details: db=10.0.0.9", { status: 500 })
        : new Response("upstream body with secrets", { status: 202 });
    const service = new OutboundWebhookService(db, mockFetch, { resolveHost: publicResolver });
    await service.createEndpoint({ workspaceId: WS_ALPHA, targetUrl: "https://ok.example.com/hook" });
    await service.createEndpoint({ workspaceId: WS_ALPHA, targetUrl: "https://fail.example.com/hook" });

    await service.dispatchEvent(WS_ALPHA, "order.completed", { orderId: "o_1" });
    const stored = await service.listDeliveries(WS_ALPHA);
    expect(stored).toHaveLength(2);
    const byStatus = Object.fromEntries(stored.map((d) => [d.status_code, d]));
    expect(byStatus[202]!.success).toBe(true);
    expect(byStatus[202]!.response_body).toBeNull();
    expect(byStatus[500]!.success).toBe(false);
    expect(byStatus[500]!.response_body).toBeNull();
    const raw = await db.prepare("SELECT response_body FROM owh_deliveries").all<{ response_body: string | null }>();
    expect(raw.results.every((r) => r.response_body === null)).toBe(true);
  });
});

describe("Outbound Webhooks HTTP API", () => {
  it("provides full HTTP workflow for endpoints, dispatch, and delivery replay", async () => {
    const app = new Hono<OutboundWebhookEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createOutboundWebhookRoutes());

    // 1. POST /subscriptions/webhooks
    const createRes = await app.request("/api/subscriptions/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        targetUrl: "https://test.customer.com/webhooks",
        description: "Customer API",
        events: ["order.completed"],
      }),
    }, { DB: db });
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as { endpoint: { id: string } };
    const epId = createJson.endpoint.id;

    // 2. GET /subscriptions/webhooks
    const listRes = await app.request("/api/subscriptions/webhooks", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { endpoints: unknown[] };
    expect(listJson.endpoints).toHaveLength(1);

    // 3. POST /subscriptions/webhooks/dispatch
    const dispatchRes = await app.request("/api/subscriptions/webhooks/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        eventType: "order.completed",
        payload: { orderId: "ord_123" },
      }),
    }, { DB: db });
    expect(dispatchRes.status).toBe(200);
    const dispatchJson = (await dispatchRes.json()) as { deliveries: Array<{ id: string }> };
    expect(dispatchJson.deliveries).toHaveLength(1);
    // deliveries has length 1 (asserted on the line above), so [0] exists.
    const delId = dispatchJson.deliveries[0]!.id;

    // 4. GET /subscriptions/webhooks/deliveries
    const deliveriesRes = await app.request("/api/subscriptions/webhooks/deliveries", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(deliveriesRes.status).toBe(200);
    const deliveriesJson = (await deliveriesRes.json()) as { deliveries: unknown[] };
    expect(deliveriesJson.deliveries).toHaveLength(1);

    // 5. POST /subscriptions/webhooks/deliveries/:id/replay
    const replayRes = await app.request(`/api/subscriptions/webhooks/deliveries/${delId}/replay`, {
      method: "POST",
      headers: { "x-workspace-id": WS_ALPHA },
    }, { DB: db });
    expect(replayRes.status).toBe(200);

    // 6. DELETE /subscriptions/webhooks/:id
    const delRes = await app.request(`/api/subscriptions/webhooks/${epId}`, {
      method: "DELETE",
      headers: { "x-workspace-id": WS_ALPHA },
    }, { DB: db });
    expect(delRes.status).toBe(200);
  });
});
