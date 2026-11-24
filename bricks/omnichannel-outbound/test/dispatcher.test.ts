import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_omnichannel_outbound.sql?raw";
import { createMessageRoutes, executeSendOutboundMessage, MessageDispatcherService, MockDeliveryAdapter } from "../src/index.ts";
import type { MessageEnv } from "../src/routes.ts";

const db = env.DB as D1Like;
const WS_A = "ws_msg_alpha";
const WS_B = "ws_msg_beta";

async function resetDb(): Promise<void> {
  for (const table of ["msg_dispatches", "msg_channels"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Omnichannel Outbound Dispatcher Core Engine", () => {
  it("creates messaging channels and delivers outbound email successfully", async () => {
    const adapter = new MockDeliveryAdapter();
    const service = new MessageDispatcherService(db, adapter);

    const channelRes = await service.createChannel(
      WS_A,
      "email",
      "resend",
      "no-reply@example.com",
      { apiKey: "secret_resend_key" }
    );
    expect(channelRes.ok).toBe(true);
    if (!channelRes.ok) return;

    // Send email
    const sendRes = await service.sendMessage(
      WS_A,
      "email",
      "customer@test.com",
      "Welcome to ProjectX!",
      "Welcome"
    );

    expect(sendRes.ok).toBe(true);
    if (!sendRes.ok) return;

    expect(sendRes.dispatch.status).toBe("sent");
    expect(sendRes.dispatch.external_id).toMatch(/^msg_/);
    expect(sendRes.dispatch.sent_at).not.toBeNull();

    // Verify mock adapter received message
    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0].message.recipient).toBe("customer@test.com");
    expect(adapter.sentMessages[0].message.subject).toBe("Welcome");

    // Verify persisted record in D1
    const history = await service.listDispatches(WS_A);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("sent");
    expect(history[0].body_text).toBe("Welcome to ProjectX!");
  });

  it("handles delivery failure gracefully and logs error in D1", async () => {
    const adapter = new MockDeliveryAdapter();
    adapter.shouldFail = true; // Simulate network outage
    const service = new MessageDispatcherService(db, adapter);

    await service.createChannel(WS_A, "sms", "twilio", "+18005550199");

    const sendRes = await service.sendMessage(
      WS_A,
      "sms",
      "+15551234567",
      "Your verification code is 123456"
    );

    expect(sendRes.ok).toBe(true);
    if (!sendRes.ok) return;

    expect(sendRes.dispatch.status).toBe("failed");
    expect(sendRes.dispatch.error_text).toContain("Mock provider connection refused");
    expect(sendRes.dispatch.sent_at).toBeNull();
  });

  it("refuses messages to unconfigured channels with 404", async () => {
    const service = new MessageDispatcherService(db);
    const sendRes = await service.sendMessage(WS_A, "whatsapp", "+15551234567", "Hello");

    expect(sendRes.ok).toBe(false);
    if (sendRes.ok) return;
    expect(sendRes.code).toBe(404);
    expect(sendRes.error).toMatch(/No active channel found/i);
  });

  it("enforces multi-tenant isolation: Workspace B cannot see or send via Workspace A channels", async () => {
    const service = new MessageDispatcherService(db);
    await service.createChannel(WS_A, "slack", "slack_webhook", "https://hooks.slack.com/services/123");

    // Workspace B lists channels -> 0 channels
    const channelsB = await service.listChannels(WS_B);
    expect(channelsB).toHaveLength(0);

    // Workspace B cannot send via Slack
    const sendB = await service.sendMessage(WS_B, "slack", "#alerts", "Unauthorized alert");
    expect(sendB.ok).toBe(false);
  });
});

describe("Message Route Handlers (/api/messages/*)", () => {
  const adapter = new MockDeliveryAdapter();

  const createApp = (wsId = WS_A, role: string | null = "owner") => {
    const app = new Hono<MessageEnv>();

    // Mock workspace & user context (role null = nobody signed in)
    app.use("*", async (c, next) => {
      if (role) {
        c.set("workspace", { id: wsId, role });
        c.set("user", { uid: "usr_alice", email: "alice@test.com" });
        c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: wsId, role }));
      }
      await next();
    });

    app.route("/api", createMessageRoutes({ adapter }));
    return app;
  };

  it("POST /api/messages/channels -> configures channel and POST /api/messages/send dispatches", async () => {
    const app = createApp(WS_A);

    // 1. Create channel
    const chanRes = await app.fetch(
      new Request("http://localhost/api/messages/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelType: "email",
          provider: "workers_mail",
          senderAddress: "team@projectx.dev",
        }),
      }),
      { DB: db }
    );
    expect(chanRes.status).toBe(201);

    // 2. Send message
    const sendRes = await app.fetch(
      new Request("http://localhost/api/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "email",
          recipient: "user@example.com",
          subject: "Your Monthly Report",
          body: "Everything is operating cleanly at 100%.",
        }),
      }),
      { DB: db }
    );
    expect(sendRes.status).toBe(200);
    const sendJson = (await sendRes.json()) as { dispatch: { status: string; recipient: string } };
    expect(sendJson.dispatch.status).toBe("sent");
    expect(sendJson.dispatch.recipient).toBe("user@example.com");

    // 3. Inspect history via GET /api/messages/history
    const histRes = await app.fetch(
      new Request("http://localhost/api/messages/history"),
      { DB: db }
    );
    expect(histRes.status).toBe(200);
    const histJson = (await histRes.json()) as { history: unknown[] };
    expect(histJson.history).toHaveLength(1);
  });

  it("story 0.6: channel create and send refuse no user (401) and a plain member (403, before validation); admin may", async () => {
    const post = (app: Hono<MessageEnv>, path: string, body: string) =>
      app.fetch(new Request(`http://localhost/api/messages/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body }), { DB: db });
    const channel = JSON.stringify({ channelType: "email", provider: "workers_mail", senderAddress: "ceo@projectx.dev" });
    const send = JSON.stringify({ channel: "email", recipient: "victim@example.com", body: "hi" });
    for (const [role, status] of [[null, 401], ["member", 403]] as const) {
      const app = createApp(WS_A, role);
      expect((await post(app, "channels", channel)).status).toBe(status);
      expect((await post(app, "channels", "{bad")).status).toBe(status);
      expect((await post(app, "send", send)).status).toBe(status);
      expect((await post(app, "send", "{bad")).status).toBe(status);
    }
    const service = new MessageDispatcherService(db, adapter);
    expect(await service.listChannels(WS_A)).toHaveLength(0);
    expect(await service.listDispatches(WS_A)).toHaveLength(0);

    const admin = createApp(WS_A, "admin");
    expect((await post(admin, "channels", channel)).status).toBe(201);
    expect((await post(admin, "send", send)).status).toBe(200);
  });
});

describe("no delivery adapter (story 0.9, B11)", () => {
  it("OUTBOUND_NO_ADAPTER: the service refuses with 503 NOT_CONFIGURED and records nothing as sent", async () => {
    const service = new MessageDispatcherService(db);
    await service.createChannel(WS_A, "email", "workers_mail", "noreply@projectx.dev");
    const res = await service.sendMessage(WS_A, "email", "user@example.com", "Hello");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(503);
    expect(res.errorCode).toBe("NOT_CONFIGURED");
    expect(await service.listDispatches(WS_A)).toHaveLength(0);
  });

  it("OUTBOUND_NO_ADAPTER: the route as the assembled app mounts it (no adapter) answers 503 NOT_CONFIGURED", async () => {
    const app = new Hono<MessageEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_A, role: "owner" });
      c.set("user", { uid: "usr_alice" });
      c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: WS_A, role: "owner" }));
      await next();
    });
    app.route("/api", createMessageRoutes());
    await new MessageDispatcherService(db).createChannel(WS_A, "email", "workers_mail", "noreply@projectx.dev");
    const res = await app.fetch(
      new Request("http://localhost/api/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "email", recipient: "user@example.com", body: "Hello" }),
      }),
      { DB: db },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; dispatch?: unknown };
    expect(body.code).toBe("NOT_CONFIGURED");
    expect(body.dispatch).toBeUndefined();
  });

  it("OUTBOUND_NO_ADAPTER: the workflow node fails NOT_CONFIGURED instead of returning dispatched: true", async () => {
    await expect(
      executeSendOutboundMessage({ nodeId: "n_send", data: { channel: "slack" }, inputs: { in: { text: "hi" } } }),
    ).rejects.toThrow(/^NOT_CONFIGURED: omnichannel-outbound\.send_message/);
  });
});

describe("the test-only mock is refused in production (story 0.9)", () => {
  it("with PX_ENVIRONMENT=production an injected MockDeliveryAdapter is not used: 503 NOT_CONFIGURED, nothing sent", async () => {
    const adapter = new MockDeliveryAdapter();
    const app = new Hono<MessageEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_A, role: "owner" });
      c.set("user", { uid: "usr_alice" });
      c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: WS_A, role: "owner" }));
      await next();
    });
    app.route("/api", createMessageRoutes({ adapter }));
    await new MessageDispatcherService(db).createChannel(WS_A, "email", "workers_mail", "noreply@projectx.dev");
    const res = await app.fetch(
      new Request("http://localhost/api/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "email", recipient: "user@example.com", body: "Hello" }),
      }),
      { DB: db, PX_ENVIRONMENT: "production" },
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_CONFIGURED");
    expect(adapter.sentMessages).toHaveLength(0);
    expect(await new MessageDispatcherService(db).listDispatches(WS_A)).toHaveLength(0);
  });
});
