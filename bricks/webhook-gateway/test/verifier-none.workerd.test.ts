import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_webhook_gateway.sql?raw";
import { createWebhookRoutes, WebhookService } from "../src/index.ts";
import type { WebhookEnv, WebhookRouteOptions } from "../src/routes.ts";
import type { WebhookGatewayAdapter } from "../src/gateway.ts";

const db = env.DB as D1Like;
const WS_A = "ws_wh_verifier_none";

async function resetDb(): Promise<void> {
  for (const table of ["px_webhook_deliveries", "wh_subscriptions", "px_connections", "wh_deliveries", "wh_endpoints", "px_logs"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Webhook verifier none fails closed (UC1.7)", () => {
  const createApp = (options: WebhookRouteOptions = {}, wsId = WS_A) => {
    const app = new Hono<WebhookEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: wsId, role: "admin" });
      c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: wsId, role: "admin" }));
      c.set("user", { uid: "usr_alice", email: "alice@test.com" });
      await next();
    });
    app.route("/api", createWebhookRoutes(options));
    return app;
  };

  it("(a) rejects registration with verifier 'none' with 400 WEBHOOK_VERIFIER_NONE_FORBIDDEN by default", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request("http://localhost/api/webhooks/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app: "stripe",
          triggerId: "invoice.paid",
          workflowId: "wf-invoice-paid",
          verifier: "none",
        }),
      }),
      { DB: db },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("WEBHOOK_VERIFIER_NONE_FORBIDDEN");
  });

  it("(b) directly inserted subscription with verifier='none' returns 401 WEBHOOK_VERIFIER_NONE_FORBIDDEN and does not trigger workflow", async () => {
    let triggered = false;
    const adapter: WebhookGatewayAdapter = {
      onTriggerWorkflow: async () => {
        triggered = true;
        return { runId: "run_test" };
      },
    };

    await db
      .prepare(
        `INSERT INTO wh_subscriptions (
          id, workspace_id, workflow_id, app, trigger_id, verifier, signature_header, enabled
        ) VALUES (?, ?, ?, ?, ?, 'none', 'X-None', 1)`,
      )
      .bind("sub_direct_none", WS_A, "wf-direct", "custom", "test.event")
      .run();

    const app = createApp({ adapter });
    const res = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_direct_none", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "evt_direct_1", hello: "world" }),
      }),
      { DB: db },
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("WEBHOOK_VERIFIER_NONE_FORBIDDEN");
    expect(triggered).toBe(false);
  });

  it("(c) with allowUnsignedForDev: true (or PX_WEBHOOK_ALLOW_UNSIGNED='dev'), unsigned subscription ingress is accepted and emits telemetry warning", async () => {
    let triggered = false;
    const emittedTelemetry: Array<{ kind: string; subscriptionId: string }> = [];
    const adapter: WebhookGatewayAdapter = {
      onTriggerWorkflow: async () => {
        triggered = true;
        return { runId: "run_dev_1" };
      },
      onEmitTelemetry: async (evt) => {
        emittedTelemetry.push({
          kind: evt.kind,
          subscriptionId: evt.subscriptionId,
        });
      },
    };

    await db
      .prepare(
        `INSERT INTO wh_subscriptions (
          id, workspace_id, workflow_id, app, trigger_id, verifier, signature_header, enabled
        ) VALUES (?, ?, ?, ?, ?, 'none', 'X-None', 1)`,
      )
      .bind("sub_dev_none", WS_A, "wf-dev", "custom", "test.dev")
      .run();

    const app = createApp({ adapter, allowUnsignedForDev: true });
    const res = await app.fetch(
      new Request("http://localhost/api/webhooks/in/sub_dev_none", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "evt_dev_1", dev: true }),
      }),
      { DB: db, PX_WEBHOOK_ALLOW_UNSIGNED: "dev" },
    );

    expect(res.status).toBe(200);
    expect(triggered).toBe(true);
    expect(emittedTelemetry).toContainEqual(
      expect.objectContaining({
        kind: "webhook.unsigned_accepted",
        subscriptionId: "sub_dev_none",
      }),
    );
  });

  it("(c2) with allowUnsignedForDev: true, unsigned endpoint ingress is accepted and delivery row records signature_verified = 0", async () => {
    const service = new WebhookService(db, { allowUnsignedForDev: true } as any);
    const created = await service.createEndpoint(WS_A, "Dev Ingress", "dev-in");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const ingest = await service.ingestWebhook("dev-in", JSON.stringify({ ping: true }), {});
    expect(ingest.ok).toBe(true);
    expect(ingest.status).toBe(200);

    const deliveries = await service.listDeliveries(WS_A, created.endpoint.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status_code).toBe(200);
    expect(deliveries[0]?.signature_verified).toBe(false);
  });
});
