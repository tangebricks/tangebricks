import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { PX_RATE_LIMITS_DDL, applyMigration } from "@poc/sdk";
import type { D1Like, DeliveryResult } from "@poc/sdk";
import migration from "../migrations/0001_omnichannel_outbound.sql?raw";
import migration2 from "../migrations/0002_sender_verification_and_credentials.sql?raw";
import {
  createMessageRoutes,
  createSendOutboundMessageExecutor,
  executeSendOutboundMessage,
  MessageDispatcherService,
  MockDeliveryAdapter,
  parsePaging,
} from "../src/index.ts";
import type { DispatcherOptions } from "../src/index.ts";
import type { MessageEnv } from "../src/routes.ts";
import manifest from "../brick.manifest.json";

const db = env.DB as D1Like;
const WS_A = "ws_msg_alpha";
const WS_B = "ws_msg_beta";
const KEY = "test-channel-credentials-key-0123456789";
const noSleep = async () => {};

async function resetDb(): Promise<void> {
  for (const table of ["msg_dispatches", "msg_dispatches_v2", "msg_channels", "px_rate_limits"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
  await applyMigration(db, migration2);
  // The SDK limiter's table (the assembler emits it): the workspace-wide code-mail cap counts there.
  await applyMigration(db, PX_RATE_LIMITS_DDL);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

function service(adapter?: MockDeliveryAdapter, extra: Partial<DispatcherOptions> = {}) {
  return new MessageDispatcherService(db, {
    ...(adapter ? { adapters: { mockmail: adapter } } : {}),
    credentialsKey: KEY,
    sleep: noSleep,
    ...extra,
  });
}

async function verifiedEmailChannel(adapter: MockDeliveryAdapter, ws = WS_A, options: { workflowSendAllowed?: boolean } = {}) {
  const res = await service(adapter).createChannel(ws, "email", "mockmail", "no-reply@example.com", { region: "com" }, { apiKey: "sk_live_secret" }, options);
  if (!res.ok) throw new Error(res.error);
  expect(res.channel.verified).toBe(true);
  return res.channel;
}

describe("Omnichannel Outbound Dispatcher Core Engine", () => {
  it("creates a verified channel and delivers outbound email: sent with the provider id, attempts 1", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    const sendRes = await service(adapter).sendMessage(WS_A, "email", { recipient: "customer@test.com", body: "Welcome to ProjectX!", subject: "Welcome" });
    expect(sendRes.ok).toBe(true);
    if (!sendRes.ok) return;
    expect(sendRes.dispatch.status).toBe("sent");
    expect(sendRes.dispatch.external_id).toMatch(/^msg_/);
    expect(sendRes.dispatch.attempts).toBe(1);
    expect(sendRes.dispatch.sent_at).not.toBeNull();
    // The adapter got the decrypted credentials, the message, and a channel without any secret in it.
    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0]!.credentials).toEqual({ apiKey: "sk_live_secret" });
    expect(adapter.sentMessages[0]!.message).toMatchObject({ recipient: "customer@test.com", subject: "Welcome" });
    expect(JSON.stringify(adapter.sentMessages[0]!.channel)).not.toContain("sk_live_secret");

    const history = await service(adapter).listDispatches(WS_A);
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("sent");
  });

  it("a hard provider error (400) is recorded failed after one attempt, never sent", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    adapter.script = [{ status: "failed", error: "PROVIDER_HTTP_400", retryable: false }];
    const res = await service(adapter).sendMessage(WS_A, "email", { recipient: "a@example.com", body: "hi" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dispatch).toMatchObject({ status: "failed", external_id: null, sent_at: null, attempts: 1, error_text: "PROVIDER_HTTP_400" });
    expect(adapter.calls).toBe(1);
  });

  it("retries 429 then succeeds: sent with attempts 2, waiting the provider's Retry-After capped at 2 s", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    adapter.script = [{ status: "failed", error: "PROVIDER_HTTP_429", retryable: true, retryAfterMs: 30_000 }];
    const waits: number[] = [];
    const res = await service(adapter, { sleep: async (ms) => void waits.push(ms) }).sendMessage(WS_A, "email", { recipient: "a@example.com", body: "hi" });
    expect(res.ok && res.dispatch.status).toBe("sent");
    if (!res.ok) return;
    expect(res.dispatch.attempts).toBe(2);
    expect(waits).toEqual([2000]);
  });

  it("retries only throttling (429, or 503 with Retry-After) with backoff, at most 3 attempts, then records failed once", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    // What the adapters report for a 503 with Retry-After and for a 429: retryable. A plain 5xx is not (next tests).
    const busy: DeliveryResult = { status: "failed", error: "PROVIDER_HTTP_503", retryable: true };
    const throttled: DeliveryResult = { status: "failed", error: "PROVIDER_HTTP_429", retryable: true };
    adapter.script = [busy, throttled, throttled, throttled];
    const waits: number[] = [];
    const res = await service(adapter, { sleep: async (ms) => void waits.push(ms) }).sendMessage(WS_A, "email", { recipient: "a@example.com", body: "hi" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dispatch).toMatchObject({ status: "failed", attempts: 3, external_id: null });
    expect(adapter.calls).toBe(3);
    expect(waits).toEqual([250, 1000]);
    expect(await service(adapter).listDispatches(WS_A)).toHaveLength(1);
  });

  it("an adapter that says sent without an id is recorded failed (NO_PROVIDER_ID)", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    adapter.script = [{ status: "sent", externalId: "" }];
    const res = await service(adapter).sendMessage(WS_A, "email", { recipient: "a@example.com", body: "hi" });
    expect(res.ok && res.dispatch).toMatchObject({ status: "failed", error_text: "NO_PROVIDER_ID", external_id: null });
  });

  it("a thrown adapter error is UNKNOWN_OUTCOME: recorded failed once and never retried (it may have been delivered)", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    adapter.send = async () => {
      adapter.calls += 1;
      throw new Error("socket hang up sk_live_secret");
    };
    const res = await service(adapter).sendMessage(WS_A, "email", { recipient: "a@example.com", body: "hi" });
    expect(res.ok && res.dispatch).toMatchObject({ status: "failed", error_text: "ADAPTER_ERROR_UNKNOWN_OUTCOME", attempts: 1 });
    expect(adapter.calls).toBe(1);
    expect(JSON.stringify(res)).not.toContain("sk_live_secret");
  });

  it("a non-retryable failure (an ambiguous 5xx the adapter marks so) is not retried", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    adapter.script = [{ status: "failed", error: "PROVIDER_HTTP_502", retryable: false }];
    const res = await service(adapter).sendMessage(WS_A, "email", { recipient: "a@example.com", body: "hi" });
    expect(res.ok && res.dispatch).toMatchObject({ status: "failed", attempts: 1 });
    expect(adapter.calls).toBe(1);
  });

  it("with less than the adapter timeout (10 s) left in the 20 s budget no attempt starts: send is never called", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    // Each clock read moves 10 001 ms, so the budget left at the first attempt is under 10 s.
    let t = Date.parse("2026-11-25T10:00:00Z");
    const now = () => (t += 10_001);
    const res = await service(adapter, { now }).sendMessage(WS_A, "email", { recipient: "a@example.com", body: "hi" });
    expect(res.ok && res.dispatch).toMatchObject({ status: "failed", error_text: "SEND_BUDGET_EXHAUSTED", attempts: 0, external_id: null });
    expect(adapter.calls).toBe(0);
  });

  it("a throttled attempt that cannot be retried inside the budget is recorded as that definite failure, not UNKNOWN_OUTCOME", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    let t = Date.parse("2026-11-25T10:00:00Z");
    const now = () => t;
    adapter.send = async () => {
      adapter.calls += 1;
      t += 9_500; // the attempt took 9.5 s: 10.5 s left, less than a 1 s wait plus a 10 s attempt
      return { status: "failed", error: "PROVIDER_THROTTLED", retryable: true, retryAfterMs: 1000 };
    };
    const waits: number[] = [];
    const res = await service(adapter, { now, sleep: async (ms) => void waits.push(ms) }).sendMessage(WS_A, "email", {
      recipient: "a@example.com",
      body: "hi",
    });
    expect(res.ok && res.dispatch).toMatchObject({ status: "failed", error_text: "PROVIDER_THROTTLED", attempts: 1, external_id: null });
    expect(adapter.calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("template send passes the template to the adapter", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    const res = await service(adapter).sendMessage(WS_A, "email", {
      recipient: "a@example.com",
      template: { name: "welcome_v2", language: "en_US", variables: { name: "Asha", "1": "x" } },
    });
    expect(res.ok && res.dispatch.status).toBe("sent");
    expect(adapter.sentMessages[0]!.message.template).toEqual({ name: "welcome_v2", language: "en_US", variables: { name: "Asha", "1": "x" } });
    if (res.ok) expect(res.dispatch.body_text).toBe("template:welcome_v2");
  });

  it("refuses messages to unconfigured channels with 404", async () => {
    const sendRes = await service(new MockDeliveryAdapter()).sendMessage(WS_A, "whatsapp", { recipient: "+15551234567", body: "Hello" });
    expect(sendRes.ok).toBe(false);
    if (sendRes.ok) return;
    expect(sendRes.code).toBe(404);
  });

  it("multi-tenant isolation: workspace B cannot see or send via workspace A channels", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    expect(await service(adapter).listChannels(WS_B)).toHaveLength(0);
    const sendB = await service(adapter).sendMessage(WS_B, "email", { recipient: "a@example.com", body: "x" });
    expect(sendB.ok).toBe(false);
  });
});

describe("sender ownership (B8)", () => {
  it("an unverified sender is refused 409 SENDER_NOT_VERIFIED and nothing is sent or recorded", async () => {
    const adapter = new MockDeliveryAdapter();
    adapter.verification = { method: "credential", verified: false };
    const created = await service(adapter).createChannel(WS_A, "email", "mockmail", "ceo@example.com");
    expect(created.ok && created.channel.verified).toBe(false);
    const res = await service(adapter).sendMessage(WS_A, "email", { recipient: "victim@example.com", body: "hi" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(409);
    expect(res.errorCode).toBe("SENDER_NOT_VERIFIED");
    expect(adapter.calls).toBe(0);
    expect(await service(adapter).listDispatches(WS_A)).toHaveLength(0);
  });

  it("credential verify: the provider's no keeps it unverified; a later yes verifies it", async () => {
    const adapter = new MockDeliveryAdapter();
    adapter.verification = { method: "credential", verified: false };
    const created = await service(adapter).createChannel(WS_A, "whatsapp", "mockmail", "1234567890", {}, { accessToken: "t" });
    if (!created.ok) throw new Error(created.error);
    expect(created.channel.verified).toBe(false);
    adapter.verification = { method: "credential", verified: true };
    const again = await service(adapter).startVerification(WS_A, created.channel.id);
    expect(again.ok && again.channel.verified).toBe(true);
    expect((await service(adapter).listChannels(WS_A))[0]!.verified).toBe(true);
  });

  async function codeChannel(now: () => number = () => Date.now()) {
    const adapter = new MockDeliveryAdapter();
    adapter.verification = { method: "code" };
    const created = await service(adapter, { now }).createChannel(WS_A, "email", "mockmail", "team@example.com");
    if (!created.ok) throw new Error(created.error);
    expect(created.channel.verified).toBe(false);
    // The code went to the sender address itself.
    const mail = adapter.sentMessages.at(-1)!;
    expect(mail.message.recipient).toBe("team@example.com");
    const code = /(\d{6})/.exec(mail.message.body)![1]!;
    return { adapter, id: created.channel.id, code };
  }

  it("code verify: the right code verifies; the code is stored hashed, never in clear", async () => {
    const { adapter, id, code } = await codeChannel();
    const row = await db.prepare("SELECT * FROM msg_channels WHERE id = ?").bind(id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row!.verify_code_hash).toMatch(/^[0-9a-f]{64}$/);
    const res = await service(adapter).confirmVerification(WS_A, id, code);
    expect(res.ok && res.channel.verified).toBe(true);
    const send = await service(adapter).sendMessage(WS_A, id, { recipient: "a@example.com", body: "hi" });
    expect(send.ok && send.dispatch.status).toBe("sent");
  });

  it("code verify: a wrong code is refused and the channel stays unverified", async () => {
    const { adapter, id, code } = await codeChannel();
    const wrong = code === "000000" ? "000001" : "000000";
    const res = await service(adapter).confirmVerification(WS_A, id, wrong);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe("INVALID_CODE");
    expect((await service(adapter).listChannels(WS_A))[0]!.verified).toBe(false);
  });

  it("code verify: an expired code is refused (15 minutes)", async () => {
    let clock = Date.parse("2026-11-25T10:00:00Z");
    const { adapter, id, code } = await codeChannel(() => clock);
    clock += 15 * 60 * 1000 + 1;
    const res = await service(adapter, { now: () => clock }).confirmVerification(WS_A, id, code);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe("CODE_EXPIRED");
  });

  it("code verify: after 5 wrong attempts even the right code is refused; a new code resets", async () => {
    const { adapter, id, code } = await codeChannel();
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i += 1) {
      const r = await service(adapter).confirmVerification(WS_A, id, wrong);
      expect(r.ok === false && r.errorCode).toBe("INVALID_CODE");
    }
    const sixth = await service(adapter).confirmVerification(WS_A, id, code);
    expect(sixth.ok === false && sixth.errorCode).toBe("TOO_MANY_ATTEMPTS");
    expect((await service(adapter).listChannels(WS_A))[0]!.verified).toBe(false);
    const again = await service(adapter).startVerification(WS_A, id);
    expect(again.ok && again.codeSent).toBe(true);
    const fresh = /(\d{6})/.exec(adapter.sentMessages.at(-1)!.message.body)![1]!;
    expect((await service(adapter).confirmVerification(WS_A, id, fresh)).ok).toBe(true);
  });

  it("another workspace cannot verify or confirm a channel it does not own", async () => {
    const { adapter, id, code } = await codeChannel();
    expect((await service(adapter).confirmVerification(WS_B, id, code)).ok).toBe(false);
    expect((await service(adapter).startVerification(WS_B, id)).ok).toBe(false);
  });
});

describe("credentials (B9)", () => {
  it("are stored encrypted, bound to the channel, and never listed", async () => {
    const adapter = new MockDeliveryAdapter();
    const channel = await verifiedEmailChannel(adapter);
    expect(channel.hasCredentials).toBe(true);
    expect(JSON.stringify(channel)).not.toContain("sk_live_secret");
    const row = await db.prepare("SELECT credentials_ciphertext FROM msg_channels WHERE id = ?").bind(channel.id).first<{ credentials_ciphertext: string }>();
    expect(row!.credentials_ciphertext).not.toContain("sk_live_secret");
    expect(JSON.parse(row!.credentials_ciphertext)).toMatchObject({ v: 1 });
    const listed = await service(adapter).listChannels(WS_A);
    expect(JSON.stringify(listed)).not.toContain("sk_live_secret");
    expect(JSON.stringify(listed)).not.toContain("credentials_ciphertext");
    expect(listed[0]).toMatchObject({ hasCredentials: true, verified: true });
  });

  it("a ciphertext copied to another channel does not open (associated data workspace:channel)", async () => {
    const adapter = new MockDeliveryAdapter();
    const a = await verifiedEmailChannel(adapter);
    const b = await service(adapter).createChannel(WS_A, "email", "mockmail", "other@example.com");
    if (!b.ok) throw new Error(b.error);
    await db
      .prepare("UPDATE msg_channels SET credentials_ciphertext = (SELECT credentials_ciphertext FROM msg_channels WHERE id = ?) WHERE id = ?")
      .bind(a.id, b.channel.id)
      .run();
    const res = await service(adapter).sendMessage(WS_A, b.channel.id, { recipient: "x@example.com", body: "hi" });
    expect(res.ok === false && res.errorCode).toBe("CREDENTIALS_UNREADABLE");
  });

  it("secret-like keys in config are refused 400", async () => {
    for (const config of [{ apiKey: "x" }, { token: "x" }, { nested: { client_secret: "x" } }, { Password: "x" }, { authorization: "x" }]) {
      const res = await service(new MockDeliveryAdapter()).createChannel(WS_A, "email", "mockmail", "a@example.com", config);
      expect(res.ok === false && res.code).toBe(400);
    }
  });

  it("without the key, a channel with credentials is refused 503 NOT_CONFIGURED", async () => {
    const res = await service(new MockDeliveryAdapter(), { credentialsKey: undefined }).createChannel(
      WS_A,
      "email",
      "mockmail",
      "a@example.com",
      {},
      { apiKey: "x" },
    );
    expect(res.ok === false && res.code).toBe(503);
    expect(res.ok === false && res.errorCode).toBe("NOT_CONFIGURED");
    expect(await service().listChannels(WS_A)).toHaveLength(0);
  });

  it("an unknown provider is refused at creation when adapters are configured", async () => {
    const res = await service(new MockDeliveryAdapter()).createChannel(WS_A, "email", "nosuchprovider", "a@example.com");
    expect(res.ok === false && res.code).toBe(400);
  });
});

describe("input checks (B10)", () => {
  it("refuses CR/LF/NUL in subject and recipient, multiple recipients, and bad formats", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    const s = service(adapter);
    const bad = [
      { recipient: "a@example.com\r\nBcc: evil@example.com", body: "x" },
      { recipient: "a@example.com", subject: "Hi\r\nBcc: evil@example.com", body: "x" },
      { recipient: "a@example.com", subject: "Hi\nthere", body: "x" },
      { recipient: "a@example.com", subject: "Hi\0", body: "x" },
      { recipient: "a@x.com,b@x.com", body: "x" },
      { recipient: "a@x.com;b@x.com", body: "x" },
      { recipient: "not-an-email", body: "x" },
    ];
    for (const input of bad) {
      const res = await s.sendMessage(WS_A, "email", input);
      expect(res.ok === false && res.code).toBe(400);
    }
    expect(adapter.calls).toBe(0);
  });

  it("WhatsApp recipients must be E.164", async () => {
    const adapter = new MockDeliveryAdapter();
    const created = await service(adapter).createChannel(WS_A, "whatsapp", "mockmail", "1234567890");
    if (!created.ok) throw new Error(created.error);
    for (const recipient of ["5551234567", "+0123456789", "+1 555 123 4567", "+15551234567,+15551234568"]) {
      const res = await service(adapter).sendMessage(WS_A, "whatsapp", { recipient, body: "x" });
      expect(res.ok === false && res.code).toBe(400);
    }
    const ok = await service(adapter).sendMessage(WS_A, "whatsapp", { recipient: "+15551234567", body: "x" });
    expect(ok.ok && ok.dispatch.status).toBe("sent");
  });

  it("email senders must be valid addresses", async () => {
    const res = await service(new MockDeliveryAdapter()).createChannel(WS_A, "email", "mockmail", "no reply@example.com");
    expect(res.ok === false && res.code).toBe(400);
  });
});

describe("paging (B12)", () => {
  it("limit 1..100 (default 50) and offset 0..100000; anything else is refused", () => {
    expect(parsePaging(undefined, undefined)).toEqual({ limit: 50, offset: 0 });
    expect(parsePaging("100", "100000")).toEqual({ limit: 100, offset: 100000 });
    for (const [limit, offset] of [
      ["-1", undefined],
      ["1000", undefined],
      ["abc", undefined],
      ["0", undefined],
      ["Infinity", undefined],
      ["1.5", undefined],
      ["10", "-1"],
      ["10", "100001"],
      ["10", "x"],
    ] as const) {
      expect(parsePaging(limit, offset)).toBeNull();
    }
  });
});

describe("Message Route Handlers (/api/messages/*)", () => {
  const createApp = (adapter: MockDeliveryAdapter, wsId = WS_A, role: string | null = "owner") => {
    const app = new Hono<MessageEnv>();
    app.use("/api/messages/*", async (c, next) => {
      if (role && !c.req.path.startsWith("/api/message-webhooks/")) {
        c.set("workspace", { id: wsId, role });
        c.set("user", { uid: "usr_alice", email: "alice@test.com" });
        c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: wsId, role }));
      }
      await next();
    });
    app.route("/api", createMessageRoutes({ adapters: { mockmail: adapter } }));
    return app;
  };
  const ENV = { DB: db, PX_CHANNEL_CREDENTIALS_KEY: KEY };
  const post = (app: Hono<MessageEnv>, path: string, body: unknown, envOverride: Record<string, unknown> = ENV) =>
    app.fetch(
      new Request(`http://localhost/api/messages/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      envOverride,
    );
  const get = (app: Hono<MessageEnv>, path: string) => app.fetch(new Request(`http://localhost/api/messages/${path}`), ENV);

  it("POST channels (with credentials) -> 201 without secrets; send -> 200 sent; history lists it", async () => {
    const adapter = new MockDeliveryAdapter();
    const app = createApp(adapter);
    const chanRes = await post(app, "channels", {
      channelType: "email",
      provider: "mockmail",
      senderAddress: "team@projectx.dev",
      config: { region: "com" },
      credentials: { apiKey: "sk_live_route" },
    });
    expect(chanRes.status).toBe(201);
    const chanText = await chanRes.text();
    expect(chanText).not.toContain("sk_live_route");
    expect(JSON.parse(chanText).channel).toMatchObject({ verified: true, hasCredentials: true });

    const sendRes = await post(app, "send", { channel: "email", recipient: "user@example.com", subject: "Report", body: "All good." });
    expect(sendRes.status).toBe(200);
    expect(((await sendRes.json()) as { dispatch: { status: string } }).dispatch.status).toBe("sent");

    const histRes = await get(app, "history");
    expect(histRes.status).toBe(200);
    expect(((await histRes.json()) as { history: unknown[] }).history).toHaveLength(1);

    // A member lists channels: no credential anywhere in the answer.
    const member = createApp(adapter, WS_A, "member");
    const list = await get(member, "channels");
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).not.toContain("sk_live_route");
    expect(listText).toContain('"hasCredentials":true');
  });

  it("secret-like config keys 400; credentials without the key 503", async () => {
    const app = createApp(new MockDeliveryAdapter());
    expect((await post(app, "channels", { channelType: "email", provider: "mockmail", senderAddress: "a@projectx.dev", config: { apiKey: "x" } })).status).toBe(
      400,
    );
    const res = await post(
      app,
      "channels",
      { channelType: "email", provider: "mockmail", senderAddress: "a@projectx.dev", credentials: { apiKey: "x" } },
      { DB: db },
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_CONFIGURED");
  });

  it("history paging: limit=-1, 1000, abc and offset out of range are 400", async () => {
    const app = createApp(new MockDeliveryAdapter());
    for (const q of ["limit=-1", "limit=1000", "limit=abc", "limit=Infinity", "offset=-5", "offset=100001"]) {
      expect((await get(app, `history?${q}`)).status).toBe(400);
    }
    expect((await get(app, "history?limit=100&offset=0")).status).toBe(200);
  });

  it("send: CR/LF in subject and multi-recipient are 400; an unverified sender is 409", async () => {
    const adapter = new MockDeliveryAdapter();
    const app = createApp(adapter);
    await post(app, "channels", { channelType: "email", provider: "mockmail", senderAddress: "team@projectx.dev" });
    expect((await post(app, "send", { recipient: "a@x.com", subject: "a\r\nBcc: b@x.com", body: "x" })).status).toBe(400);
    expect((await post(app, "send", { recipient: "a@x.com,b@x.com", body: "x" })).status).toBe(400);

    adapter.verification = { method: "credential", verified: false };
    const resChan = await post(app, "channels", { channelType: "sms", provider: "mockmail", senderAddress: "+15550000000" });
    const id = ((await resChan.json()) as { channel: { id: string } }).channel.id;
    const res = await post(app, "send", { channel: id, recipient: "+15551234567", body: "x" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("SENDER_NOT_VERIFIED");
  });

  it("POST channels/:id/verify: code flow, members refused", async () => {
    const adapter = new MockDeliveryAdapter();
    adapter.verification = { method: "code" };
    const app = createApp(adapter);
    const created = await post(app, "channels", { channelType: "email", provider: "mockmail", senderAddress: "team@projectx.dev" });
    const id = ((await created.json()) as { channel: { id: string; verified: boolean } }).channel.id;
    const code = /(\d{6})/.exec(adapter.sentMessages.at(-1)!.message.body)![1]!;

    const member = createApp(adapter, WS_A, "member");
    expect((await post(member, `channels/${id}/verify`, { code })).status).toBe(403);
    expect((await post(app, `channels/${id}/verify`, { code: code === "999999" ? "999998" : "999999" })).status).toBe(400);
    const ok = await post(app, `channels/${id}/verify`, { code });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { verified: boolean }).verified).toBe(true);
    // The verify answer never carries the code.
    const resend = await post(app, `channels/${id}/verify`, "");
    expect(resend.status).toBe(200);
    expect(await resend.text()).not.toMatch(/\b\d{6}\b/);
  });

  it("story 0.6: channel create and send refuse no user (401) and a plain member (403, before validation); admin may", async () => {
    const adapter = new MockDeliveryAdapter();
    const channel = { channelType: "email", provider: "mockmail", senderAddress: "ceo@projectx.dev" };
    const send = { channel: "email", recipient: "victim@example.com", body: "hi" };
    for (const [role, status] of [
      [null, 401],
      ["member", 403],
    ] as const) {
      const app = createApp(adapter, WS_A, role);
      expect((await post(app, "channels", channel)).status).toBe(status);
      expect((await post(app, "channels", "{bad")).status).toBe(status);
      expect((await post(app, "send", send)).status).toBe(status);
      expect((await post(app, "send", "{bad")).status).toBe(status);
    }
    expect(await service(adapter).listChannels(WS_A)).toHaveLength(0);
    expect(await service(adapter).listDispatches(WS_A)).toHaveLength(0);

    const admin = createApp(adapter, WS_A, "admin");
    expect((await post(admin, "channels", channel)).status).toBe(201);
    expect((await post(admin, "send", send)).status).toBe(200);
  });
});

describe("status webhook", () => {
  const SIG = "x-test-signature";

  function signingAdapter() {
    const adapter = new MockDeliveryAdapter();
    // Accepts only bodies "signed" with the channel's own appSecret; reports the statuses in the body.
    adapter.webhook = async (rawBody, headers, credentials) => {
      if (!credentials.appSecret || headers.get(SIG) !== `${credentials.appSecret}:${rawBody.length}`) return { kind: "invalid" };
      const parsed = JSON.parse(rawBody) as { updates: Array<{ externalId: string; status: "delivered" | "read" | "failed" }> };
      return parsed.updates.length > 0 ? { kind: "status", updates: parsed.updates } : { kind: "ignored" };
    };
    return adapter;
  }

  const app = (adapter: MockDeliveryAdapter) => {
    const a = new Hono<MessageEnv>();
    a.route("/api", createMessageRoutes({ adapters: { mockmail: adapter } }));
    return a;
  };
  const hook = (a: Hono<MessageEnv>, channelId: string, body: string, signature?: string) =>
    a.fetch(new Request(`http://localhost/api/message-webhooks/${channelId}`, { method: "POST", headers: signature ? { [SIG]: signature } : {}, body }), {
      DB: db,
      PX_CHANNEL_CREDENTIALS_KEY: KEY,
    });

  async function sentDispatch(adapter: MockDeliveryAdapter, ws: string, secret: string) {
    const created = await service(adapter).createChannel(ws, "email", "mockmail", "team@example.com", {}, { apiKey: "k", appSecret: secret });
    if (!created.ok) throw new Error(created.error);
    const sent = await service(adapter).sendMessage(ws, created.channel.id, { recipient: "a@example.com", body: "hi" });
    if (!sent.ok) throw new Error(sent.error);
    return { channelId: created.channel.id, dispatch: sent.dispatch };
  }

  it("a valid signature moves sent -> delivered -> read; no regression back to delivered", async () => {
    const adapter = signingAdapter();
    const a = app(adapter);
    const { channelId, dispatch } = await sentDispatch(adapter, WS_A, "app_secret_a");
    const body = (status: string) => JSON.stringify({ updates: [{ externalId: dispatch.external_id, status }] });
    const send = (status: string) => hook(a, channelId, body(status), `app_secret_a:${body(status).length}`);

    expect((await send("delivered")).status).toBe(200);
    expect((await service(adapter).listDispatches(WS_A))[0]!.status).toBe("delivered");
    expect((await send("read")).status).toBe(200);
    expect((await service(adapter).listDispatches(WS_A))[0]!.status).toBe("read");
    const back = await send("delivered");
    expect(back.status).toBe(200);
    expect(((await back.json()) as { updated: number }).updated).toBe(0);
    expect((await service(adapter).listDispatches(WS_A))[0]!.status).toBe("read");
    // failed only from sent
    expect((await send("failed")).status).toBe(200);
    expect((await service(adapter).listDispatches(WS_A))[0]!.status).toBe("read");
  });

  it("a forged signature is 401 and changes nothing", async () => {
    const adapter = signingAdapter();
    const a = app(adapter);
    const { channelId, dispatch } = await sentDispatch(adapter, WS_A, "app_secret_a");
    const body = JSON.stringify({ updates: [{ externalId: dispatch.external_id, status: "delivered" }] });
    expect((await hook(a, channelId, body, `wrong:${body.length}`)).status).toBe(401);
    expect((await hook(a, channelId, body)).status).toBe(401);
    expect((await service(adapter).listDispatches(WS_A))[0]!.status).toBe("sent");
  });

  it("another workspace's dispatch is untouched, even with its external id, through the other channel", async () => {
    const adapter = signingAdapter();
    const a = app(adapter);
    const victim = await sentDispatch(adapter, WS_A, "secret_a");
    const attacker = await sentDispatch(adapter, WS_B, "secret_b");
    // B signs correctly for its own channel but names A's dispatch id.
    const body = JSON.stringify({ updates: [{ externalId: victim.dispatch.external_id, status: "delivered" }] });
    const res = await hook(a, attacker.channelId, body, `secret_b:${body.length}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { updated: number }).updated).toBe(0);
    expect((await service(adapter).listDispatches(WS_A))[0]!.status).toBe("sent");
  });

  it("unknown channel and unknown dispatch answer 200 ignored; an oversized body 413", async () => {
    const adapter = signingAdapter();
    const a = app(adapter);
    expect((await hook(a, "chn_00000000000000000000000000000000", "{}")).status).toBe(200);
    expect((await hook(a, "not-a-channel", "{}")).status).toBe(200);
    const { channelId } = await sentDispatch(adapter, WS_A, "s");
    const body = JSON.stringify({ updates: [{ externalId: "nope", status: "delivered" }] });
    const res = await hook(a, channelId, body, `s:${body.length}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, status: "ignored", updated: 0 });
    expect((await hook(a, channelId, "x".repeat(64 * 1024 + 1), "s:1")).status).toBe(413);
  });
});

describe("no delivery adapter (story 0.9, B11)", () => {
  it("OUTBOUND_NO_ADAPTER: the service refuses with 503 NOT_CONFIGURED and records nothing as sent", async () => {
    const s = new MessageDispatcherService(db);
    await s.createChannel(WS_A, "email", "workers_mail", "noreply@projectx.dev");
    const res = await s.sendMessage(WS_A, "email", { recipient: "user@example.com", body: "Hello" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe(503);
    expect(res.errorCode).toBe("NOT_CONFIGURED");
    expect(await s.listDispatches(WS_A)).toHaveLength(0);
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
    await expect(executeSendOutboundMessage({ nodeId: "n_send", data: { channel: "slack" }, inputs: { in: { text: "hi" } } })).rejects.toThrow(
      /^NOT_CONFIGURED: omnichannel-outbound\.send_message/,
    );
  });
});

describe("workflow node with adapters (story 2.4)", () => {
  // Behaves like the runtime (packages/runtime/src/run.ts): only secrets and bindings the node declares in the manifest
  // are handed over; an undeclared one throws.
  const node = manifest.nodes.find((n) => n.type === "omnichannel-outbound.send_message")! as { secrets?: string[]; bindings?: string[] };
  const ctxFor = (inputs: Record<string, unknown>, env: Record<string, unknown> = { PX_CHANNEL_CREDENTIALS_KEY: KEY, DB: db }) => ({
    nodeId: "n_send",
    workspaceId: WS_A,
    data: { channel: "email" },
    inputs,
    secret: (name: string) => {
      if (!(node.secrets ?? []).includes(name)) throw new Error(`secret "${name}" is not declared by omnichannel-outbound.send_message`);
      const value = env[name];
      if (typeof value !== "string") throw new Error(`secret "${name}" is declared by omnichannel-outbound.send_message but was not provided`);
      return value;
    },
    binding: <T>(name: string) => {
      if (!(node.bindings ?? []).includes(name)) throw new Error(`binding "${name}" is not declared by omnichannel-outbound.send_message`);
      const value = env[name];
      if (value === undefined) throw new Error(`binding "${name}" is declared by omnichannel-outbound.send_message but was not provided`);
      return value as T;
    },
  });

  it("the node declares the credentials secret and the DB binding (the runtime refuses undeclared ones)", () => {
    expect(node.secrets).toContain("PX_CHANNEL_CREDENTIALS_KEY");
    expect(node.bindings).toContain("DB");
  });

  it("a credentialed channel sends from a workflow when the channel allows workflow sends", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter, WS_A, { workflowSendAllowed: true });
    const exec = createSendOutboundMessageExecutor({ adapters: { mockmail: adapter }, sleep: noSleep });
    const out = await exec(ctxFor({ in: { recipient: "a@example.com", body: "hi" } }));
    expect(out.out).toMatchObject({ dispatched: true, attempts: 1 });
    expect(adapter.sentMessages[0]!.credentials).toEqual({ apiKey: "sk_live_secret" });
    expect(await service(adapter).listDispatches(WS_A)).toHaveLength(1);
  });

  it("a channel without workflowSendAllowed (the default) refuses workflow sends; nothing is sent", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    const exec = createSendOutboundMessageExecutor({ adapters: { mockmail: adapter }, sleep: noSleep });
    await expect(exec(ctxFor({ in: { recipient: "a@example.com", body: "hi" } }))).rejects.toThrow(/WORKFLOW_SEND_NOT_ALLOWED/);
    expect(adapter.calls).toBe(0);
    expect(await service(adapter).listDispatches(WS_A)).toHaveLength(0);
  });

  it("without the key set by the host, a credentialed channel fails NOT_CONFIGURED", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter, WS_A, { workflowSendAllowed: true });
    const exec = createSendOutboundMessageExecutor({ adapters: { mockmail: adapter }, sleep: noSleep });
    await expect(exec(ctxFor({ in: { recipient: "a@example.com", body: "hi" } }, { DB: db }))).rejects.toThrow(/^NOT_CONFIGURED/);
  });

  it("sends through the same dispatcher path in the run's workspace", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter, WS_A, { workflowSendAllowed: true });
    const exec = createSendOutboundMessageExecutor({ adapters: { mockmail: adapter }, sleep: noSleep });
    const out = await exec(ctxFor({ in: { recipient: "a@example.com", body: "hi" } }));
    expect(out.out).toMatchObject({ dispatched: true, attempts: 1 });
    expect(await service(adapter).listDispatches(WS_A)).toHaveLength(1);
  });

  it("a provider failure throws; it never reports dispatched", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter, WS_A, { workflowSendAllowed: true });
    adapter.script = [{ status: "failed", error: "PROVIDER_HTTP_400", retryable: false }];
    const exec = createSendOutboundMessageExecutor({ adapters: { mockmail: adapter }, sleep: noSleep });
    await expect(exec(ctxFor({ in: { recipient: "a@example.com", body: "hi" } }))).rejects.toThrow(/delivery failed \(PROVIDER_HTTP_400\)/);
  });

  it("an unverified sender throws SENDER_NOT_VERIFIED", async () => {
    const adapter = new MockDeliveryAdapter();
    adapter.verification = { method: "credential", verified: false };
    await service(adapter).createChannel(WS_A, "email", "mockmail", "x@example.com");
    const exec = createSendOutboundMessageExecutor({ adapters: { mockmail: adapter }, sleep: noSleep });
    await expect(exec(ctxFor({ in: { recipient: "a@example.com", body: "hi" } }))).rejects.toThrow(/SENDER_NOT_VERIFIED/);
    expect(adapter.calls).toBe(0);
  });
});

describe("the test-only mock is refused in production (story 0.9)", () => {
  it("with PX_ENVIRONMENT=production an injected MockDeliveryAdapter is not used: 503 NOT_CONFIGURED, nothing sent", async () => {
    const adapter = new MockDeliveryAdapter();
    await verifiedEmailChannel(adapter);
    const app = new Hono<MessageEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_A, role: "owner" });
      c.set("user", { uid: "usr_alice" });
      c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: WS_A, role: "owner" }));
      await next();
    });
    app.route("/api", createMessageRoutes({ adapters: { mockmail: adapter } }));
    const res = await app.fetch(
      new Request("http://localhost/api/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "email", recipient: "user@example.com", body: "Hello" }),
      }),
      { DB: db, PX_ENVIRONMENT: "production", PX_CHANNEL_CREDENTIALS_KEY: KEY },
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_CONFIGURED");
    expect(adapter.sentMessages).toHaveLength(0);
    expect(await service().listDispatches(WS_A)).toHaveLength(0);
  });
});

describe("review hardening (story 2.4)", () => {
  async function codeChannel() {
    const adapter = new MockDeliveryAdapter();
    adapter.verification = { method: "code" };
    const created = await service(adapter).createChannel(WS_A, "email", "mockmail", "team@example.com");
    if (!created.ok) throw new Error(created.error);
    const code = /(\d{6})/.exec(adapter.sentMessages.at(-1)!.message.body)![1]!;
    return { adapter, id: created.channel.id, code };
  }

  it("parallel guesses all count: of 20 concurrent wrong codes at most 5 are compared, the rest refused", async () => {
    const { adapter, id, code } = await codeChannel();
    const wrong = code === "000000" ? "000001" : "000000";
    const results = await Promise.all(Array.from({ length: 20 }, () => service(adapter).confirmVerification(WS_A, id, wrong)));
    const invalid = results.filter((r) => !r.ok && r.errorCode === "INVALID_CODE").length;
    expect(invalid).toBeLessThanOrEqual(5);
    expect(results.every((r) => !r.ok)).toBe(true);
    const row = await db.prepare("SELECT verify_code_attempts FROM msg_channels WHERE id = ?").bind(id).first<{ verify_code_attempts: number }>();
    expect(row!.verify_code_attempts).toBe(5);
    // The right code is now refused too.
    const right = await service(adapter).confirmVerification(WS_A, id, code);
    expect(right.ok === false && right.errorCode).toBe("TOO_MANY_ATTEMPTS");
  });

  it("a code superseded by a newer one is refused, never verified", async () => {
    const { adapter, id, code } = await codeChannel();
    await service(adapter).startVerification(WS_A, id);
    const res = await service(adapter).confirmVerification(WS_A, id, code);
    expect(res.ok).toBe(false);
    expect((await service(adapter).listChannels(WS_A))[0]!.verified).toBe(false);
  });

  it("at most 5 codes per channel per hour across create and re-verify", async () => {
    let clock = Date.parse("2026-11-25T10:00:00Z");
    const now = () => clock;
    const adapter = new MockDeliveryAdapter();
    adapter.verification = { method: "code" };
    const created = await service(adapter, { now }).createChannel(WS_A, "email", "mockmail", "team@example.com");
    if (!created.ok) throw new Error(created.error);
    for (let i = 0; i < 4; i += 1) expect((await service(adapter, { now }).startVerification(WS_A, created.channel.id)).ok).toBe(true);
    const sixth = await service(adapter, { now }).startVerification(WS_A, created.channel.id);
    expect(sixth.ok === false && sixth.code).toBe(429);
    expect(sixth.ok === false && sixth.errorCode).toBe("TOO_MANY_CODES");
    expect(adapter.sentMessages).toHaveLength(5);
    clock += 60 * 60 * 1000 + 1;
    expect((await service(adapter, { now }).startVerification(WS_A, created.channel.id)).ok).toBe(true);
    expect(adapter.sentMessages).toHaveLength(6);
  });

  it("a provider that cannot answer leaves verified unchanged and answers 502", async () => {
    const adapter = new MockDeliveryAdapter();
    const channel = await verifiedEmailChannel(adapter);
    adapter.verification = { method: "unavailable", error: "PROVIDER_HTTP_503" };
    const res = await service(adapter).startVerification(WS_A, channel.id);
    expect(res.ok === false && res.code).toBe(502);
    expect((await service(adapter).listChannels(WS_A))[0]!.verified).toBe(true);
    adapter.verifySender = async () => {
      throw new Error("boom");
    };
    expect((await service(adapter).startVerification(WS_A, channel.id)).ok).toBe(false);
    expect((await service(adapter).listChannels(WS_A))[0]!.verified).toBe(true);
  });

  it("config nested too deep or too wide is refused, never passed unchecked", async () => {
    let deep: Record<string, unknown> = { apiKey: "hidden" };
    for (let i = 0; i < 12; i += 1) deep = { n: deep };
    const wide = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, 1]));
    for (const config of [deep, wide]) {
      const res = await service(new MockDeliveryAdapter()).createChannel(WS_A, "email", "mockmail", "a@example.com", config);
      expect(res.ok === false && res.code).toBe(400);
    }
  });

  it("credentials over 16 entries or 10240 bytes are refused 400 (service and route)", async () => {
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`c${i}`, "x"]));
    const big = { apiKey: "x".repeat(4000), other: "y".repeat(4000), third: "z".repeat(4000) };
    for (const credentials of [many, big]) {
      const res = await service(new MockDeliveryAdapter()).createChannel(WS_A, "email", "mockmail", "a@example.com", {}, credentials);
      expect(res.ok === false && res.code).toBe(400);
    }
    const app = new Hono<MessageEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_A, role: "owner" });
      c.set("user", { uid: "usr_alice" });
      c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: WS_A, role: "owner" }));
      await next();
    });
    app.route("/api", createMessageRoutes({ adapters: { mockmail: new MockDeliveryAdapter() } }));
    for (const credentials of [many, big]) {
      const res = await app.fetch(
        new Request("http://localhost/api/messages/channels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelType: "email", provider: "mockmail", senderAddress: "a@example.com", credentials }),
        }),
        { DB: db, PX_CHANNEL_CREDENTIALS_KEY: KEY },
      );
      expect(res.status).toBe(400);
    }
    expect(await service().listChannels(WS_A)).toHaveLength(0);
  });

  it("send by type prefers a verified channel over an older unverified one", async () => {
    const adapter = new MockDeliveryAdapter();
    adapter.verification = { method: "credential", verified: false };
    let clock = Date.parse("2026-11-25T09:00:00Z");
    await service(adapter, { now: () => clock }).createChannel(WS_A, "email", "mockmail", "old@example.com");
    clock += 60_000;
    adapter.verification = { method: "credential", verified: true };
    const newer = await service(adapter, { now: () => clock }).createChannel(WS_A, "email", "mockmail", "new@example.com");
    if (!newer.ok) throw new Error(newer.error);
    const res = await service(adapter).sendMessage(WS_A, "email", { recipient: "a@example.com", body: "hi" });
    expect(res.ok && res.dispatch.channel_id).toBe(newer.channel.id);
  });

  it("PATCH /messages/channels/:id sets workflowSendAllowed: owner/admin only, default false", async () => {
    const adapter = new MockDeliveryAdapter();
    const channel = await verifiedEmailChannel(adapter);
    expect(channel.workflowSendAllowed).toBe(false);
    const appAs = (role: string) => {
      const app = new Hono<MessageEnv>();
      app.use("*", async (c, next) => {
        c.set("workspace", { id: WS_A, role });
        c.set("user", { uid: "usr_x" });
        c.set("ctx", Object.freeze({ userId: "usr_x", workspaceId: WS_A, role }));
        await next();
      });
      app.route("/api", createMessageRoutes({ adapters: { mockmail: adapter } }));
      return app;
    };
    const patch = (role: string, body: unknown, id = channel.id) =>
      appAs(role).fetch(
        new Request(`http://localhost/api/messages/channels/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        { DB: db, PX_CHANNEL_CREDENTIALS_KEY: KEY },
      );
    expect((await patch("member", { workflowSendAllowed: true })).status).toBe(403);
    expect((await service(adapter).listChannels(WS_A))[0]!.workflowSendAllowed).toBe(false);
    expect((await patch("admin", { workflowSendAllowed: "yes" })).status).toBe(400);
    expect((await patch("admin", { workflowSendAllowed: true }, "chn_00000000000000000000000000000000")).status).toBe(404);
    const ok = await patch("admin", { workflowSendAllowed: true });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { channel: { workflowSendAllowed: boolean } }).channel.workflowSendAllowed).toBe(true);
    // Another workspace cannot change it.
    expect((await service(adapter).setWorkflowSendAllowed(WS_B, channel.id, false)).ok).toBe(false);
  });

  it("webhook errors answer a generic 503 with no secret name or detail", async () => {
    const adapter = new MockDeliveryAdapter();
    const channel = await verifiedEmailChannel(adapter);
    const app = new Hono<MessageEnv>();
    app.route("/api", createMessageRoutes({ adapters: { mockmail: adapter } }));
    // No PX_CHANNEL_CREDENTIALS_KEY in the env, so the channel's credentials cannot be opened.
    const res = await app.fetch(new Request(`http://localhost/api/message-webhooks/${channel.id}`, { method: "POST", body: "{}" }), { DB: db });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/PX_CHANNEL_CREDENTIALS_KEY|NOT_CONFIGURED|credential/i);
  });
});

describe("review follow-up (story 2.4)", () => {
  it("a failed code mail clears only its own code, never a newer one stored meanwhile (race)", async () => {
    const adapter = new MockDeliveryAdapter();
    adapter.verification = { method: "code" };
    const created = await service(adapter).createChannel(WS_A, "email", "mockmail", "team@example.com");
    if (!created.ok) throw new Error(created.error);
    const id = created.channel.id;
    const send = adapter.send.bind(adapter);
    let first = true;
    adapter.send = async (channel, message, credentials) => {
      if (first) {
        first = false;
        // While this code mail is in flight, an admin asks again: a newer code is stored and mailed.
        const again = await service(adapter).startVerification(WS_A, id);
        expect(again.ok).toBe(true);
        return { status: "failed", error: "PROVIDER_HTTP_400", retryable: false };
      }
      return send(channel, message, credentials);
    };
    const res = await service(adapter).startVerification(WS_A, id);
    expect(res.ok === false && res.errorCode).toBe("VERIFICATION_NOT_SENT");
    const newer = /(\d{6})/.exec(adapter.sentMessages.at(-1)!.message.body)![1]!;
    const row = await db.prepare("SELECT verify_code_hash FROM msg_channels WHERE id = ?").bind(id).first<{ verify_code_hash: string | null }>();
    expect(row!.verify_code_hash).not.toBeNull();
    expect((await service(adapter).confirmVerification(WS_A, id, newer)).ok).toBe(true);
  });

  it("a code mail with an unknown outcome keeps the code (it may have arrived) and answers 502", async () => {
    const adapter = new MockDeliveryAdapter();
    adapter.verification = { method: "code" };
    adapter.script = [{ status: "failed", error: "PROVIDER_UNKNOWN_OUTCOME", retryable: false }];
    const created = await service(adapter).createChannel(WS_A, "email", "mockmail", "team@example.com");
    if (!created.ok) throw new Error(created.error);
    const row = await db
      .prepare("SELECT verify_code_hash FROM msg_channels WHERE id = ?")
      .bind(created.channel.id)
      .first<{ verify_code_hash: string | null }>();
    expect(row!.verify_code_hash).toMatch(/^[0-9a-f]{64}$/);
    adapter.script = [{ status: "failed", error: "SEND_TIMEOUT_UNKNOWN_OUTCOME", retryable: false }];
    const res = await service(adapter).startVerification(WS_A, created.channel.id);
    expect(res.ok === false && res.code).toBe(502);
    expect(res.ok === false && res.errorCode).toBe("VERIFICATION_OUTCOME_UNKNOWN");
    expect(res.ok === false && res.error).toMatch(/inbox/);
  });

  it("at most 20 code mails per workspace per hour across channels", async () => {
    const adapter = new MockDeliveryAdapter();
    adapter.verification = { method: "code" };
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await service(adapter).createChannel(WS_A, "email", "mockmail", `team${i}@example.com`);
      if (!created.ok) throw new Error(created.error);
      ids.push(created.channel.id);
    }
    for (const id of ids) for (let i = 0; i < 3; i += 1) expect((await service(adapter).startVerification(WS_A, id)).ok).toBe(true);
    expect(adapter.sentMessages).toHaveLength(20);
    const refused = await service(adapter).startVerification(WS_A, ids[0]!);
    expect(refused.ok === false && refused.errorCode).toBe("TOO_MANY_CODES");
    expect(adapter.sentMessages).toHaveLength(20);
    // Another workspace has its own count.
    const other = await service(adapter).createChannel(WS_B, "email", "mockmail", "b@example.com");
    expect(other.ok).toBe(true);
    expect(adapter.sentMessages).toHaveLength(21);
  });

  it("the credential cap counts UTF-8 bytes: multi-byte text over 10240 bytes is refused (service and route)", async () => {
    const multibyte = { apiKey: "\u00e9".repeat(6000) }; // 6000 characters, 12000 bytes
    expect(JSON.stringify(multibyte).length).toBeLessThan(10_240);
    const res = await service(new MockDeliveryAdapter()).createChannel(WS_A, "email", "mockmail", "a@example.com", {}, multibyte);
    expect(res.ok === false && res.code).toBe(400);
    const app = new Hono<MessageEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_A, role: "owner" });
      c.set("user", { uid: "usr_alice" });
      c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: WS_A, role: "owner" }));
      await next();
    });
    app.route("/api", createMessageRoutes({ adapters: { mockmail: new MockDeliveryAdapter() } }));
    const viaRoute = await app.fetch(
      new Request("http://localhost/api/messages/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelType: "email",
          provider: "mockmail",
          senderAddress: "a@example.com",
          credentials: { apiKey: "\u00e9".repeat(4000), other: "\u00e9".repeat(1500) },
        }),
      }),
      { DB: db, PX_CHANNEL_CREDENTIALS_KEY: KEY },
    );
    expect(viaRoute.status).toBe(400);
    // At the cap the sealed envelope still fits the column.
    const atCap = await service(new MockDeliveryAdapter()).createChannel(WS_A, "email", "mockmail", "a@example.com", {}, { apiKey: "x".repeat(10_240 - 13) });
    expect(atCap.ok).toBe(true);
  });

  it("a workflow send by type prefers a channel opened to workflows", async () => {
    const adapter = new MockDeliveryAdapter();
    let clock = Date.parse("2026-11-25T09:00:00Z");
    await service(adapter, { now: () => clock }).createChannel(WS_A, "email", "mockmail", "old@example.com");
    clock += 60_000;
    const open = await service(adapter, { now: () => clock }).createChannel(WS_A, "email", "mockmail", "wf@example.com", {}, undefined, {
      workflowSendAllowed: true,
    });
    if (!open.ok) throw new Error(open.error);
    const viaWorkflow = await service(adapter).sendMessage(WS_A, "email", { recipient: "a@example.com", body: "hi", viaWorkflow: true });
    expect(viaWorkflow.ok && viaWorkflow.dispatch.channel_id).toBe(open.channel.id);
    // A route send keeps the plain order (verified, then oldest).
    const plain = await service(adapter).sendMessage(WS_A, "email", { recipient: "a@example.com", body: "hi" });
    expect(plain.ok && plain.dispatch.channel_id).not.toBe(open.channel.id);
  });
});

describe("migration 0002 keeps existing dispatches", () => {
  it("rows written under 0001 survive 0002 with attempts set, and the indexes exist", async () => {
    for (const table of ["msg_dispatches", "msg_dispatches_v2", "msg_channels"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    await applyMigration(db, migration);
    await db
      .prepare("INSERT INTO msg_channels (id, workspace_id, channel_type, provider, sender_address) VALUES ('chn_old', ?, 'email', 'legacy', 'a@example.com')")
      .bind(WS_A)
      .run();
    const insert =
      "INSERT INTO msg_dispatches (id, workspace_id, channel_id, recipient, subject, body_text, status, external_id, error_text, sent_at) VALUES (?, ?, 'chn_old', ?, ?, ?, ?, ?, ?, ?)";
    await db.prepare(insert).bind("dsp_1", WS_A, "x@example.com", "Hi", "body one", "sent", "ext_1", null, "2026-01-01T00:00:00Z").run();
    await db.prepare(insert).bind("dsp_2", WS_A, "y@example.com", null, "body two", "failed", null, "boom", null).run();
    await db.prepare(insert).bind("dsp_3", WS_A, "z@example.com", null, "body three", "queued", null, null, null).run();

    await applyMigration(db, migration2);

    const rows = (
      await db.prepare("SELECT id, recipient, subject, body_text, status, external_id, error_text, sent_at, attempts FROM msg_dispatches ORDER BY id").all()
    ).results;
    expect(rows).toEqual([
      {
        id: "dsp_1",
        recipient: "x@example.com",
        subject: "Hi",
        body_text: "body one",
        status: "sent",
        external_id: "ext_1",
        error_text: null,
        sent_at: "2026-01-01T00:00:00Z",
        attempts: 1,
      },
      {
        id: "dsp_2",
        recipient: "y@example.com",
        subject: null,
        body_text: "body two",
        status: "failed",
        external_id: null,
        error_text: "boom",
        sent_at: null,
        attempts: 1,
      },
      {
        id: "dsp_3",
        recipient: "z@example.com",
        subject: null,
        body_text: "body three",
        status: "queued",
        external_id: null,
        error_text: null,
        sent_at: null,
        attempts: 0,
      },
    ]);
    const indexes = (
      await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'msg_dispatches' ORDER BY name").all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(["msg_dispatches_workspace_idx", "msg_dispatches_status_idx", "msg_dispatches_external_idx"]));
    expect((await db.prepare("SELECT name FROM sqlite_master WHERE name = 'msg_dispatches_v2'").all()).results).toHaveLength(0);
    const channel = await db.prepare("SELECT verified, workflow_send_allowed, verify_code_attempts FROM msg_channels WHERE id = 'chn_old'").first();
    expect(channel).toEqual({ verified: 0, workflow_send_allowed: 0, verify_code_attempts: 0 });
    // The new status is accepted.
    await db.prepare("UPDATE msg_dispatches SET status = 'read' WHERE id = 'dsp_1'").run();
  });
});
