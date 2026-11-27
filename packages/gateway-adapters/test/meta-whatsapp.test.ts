import { describe, expect, it } from "vitest";
import type { DeliveryChannel } from "@poc/sdk";
import { createMetaWhatsAppAdapter } from "../src/meta-whatsapp.ts";
import { hmacSha256, toHex } from "../src/webhook-signature.ts";
import invalidParameter from "./fixtures/meta-whatsapp/error.invalid-parameter.json";
import rateLimit from "./fixtures/meta-whatsapp/error.rate-limit.json";
import phoneNumber from "./fixtures/meta-whatsapp/phone-number.json";
import templateSuccess from "./fixtures/meta-whatsapp/send-template.success.json";
import sendSuccess from "./fixtures/meta-whatsapp/send.success.json";
import inbound from "./fixtures/meta-whatsapp/webhook.inbound-message.json";
import delivered from "./fixtures/meta-whatsapp/webhook.status-delivered.json";
import failedStatus from "./fixtures/meta-whatsapp/webhook.status-failed.json";
import read from "./fixtures/meta-whatsapp/webhook.status-read.json";

// Story 2.4: the WhatsApp Cloud API adapter against Meta's documented response and webhook shapes. The fixtures are
// documented samples, not live recordings (fixtures/meta-whatsapp/README.md). No request leaves the test.

const TOKEN = "EAAG_contract_test_token";
const APP_SECRET = "meta_contract_app_secret";
const PN = phoneNumber.id;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

// A fetch that never answers but honours its abort signal (as the platform fetch does).
const hangingFetch = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
// A response whose headers arrive but whose body never ends.
const endlessBody = (status = 201) => new Response(new ReadableStream({ start() {} }), { status, headers: { "content-type": "application/json" } });

function adapter(answer: (seen: Seen) => Response | Promise<Response>, timeoutMs?: number) {
  const seen: Seen[] = [];
  const a = createMetaWhatsAppAdapter({
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    fetch: async (url, init) => {
      const s = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : null };
      seen.push(s);
      return answer(s);
    },
    resolveHost: null,
  });
  return { a, seen };
}

const channel = (config: Record<string, unknown> = { apiVersion: "v21.0" }, sender = PN): DeliveryChannel => ({
  id: "chn_1",
  workspace_id: "ws_1",
  channel_type: "whatsapp",
  provider: "meta-whatsapp",
  sender_address: sender,
  config,
});
const creds = { accessToken: TOKEN, appSecret: APP_SECRET, verifyToken: "verify-me-123" };

async function signature(body: string, secret = APP_SECRET) {
  return `sha256=${toHex(await hmacSha256(secret, body))}`;
}

describe("WhatsApp Cloud API adapter: send", () => {
  it("POSTs a text message to /<version>/<phone-number-id>/messages with the bearer token; messages[0].id is sent", async () => {
    const { a, seen } = adapter(() => json(sendSuccess));
    const result = await a.send(channel(), { recipient: "+919876543210", body: "Hello Asha" }, creds);
    expect(result).toEqual({ status: "sent", externalId: sendSuccess.messages[0]!.id });
    expect(seen[0]!.url).toBe(`https://graph.facebook.com/v21.0/${PN}/messages`);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "text",
      text: { body: "Hello Asha" },
    });
  });

  it("a template carries name, language and positional body parameters", async () => {
    const { a, seen } = adapter(() => json(templateSuccess));
    const result = await a.send(
      channel(),
      { recipient: "+919876543210", body: "", template: { name: "order_update", language: "en_US", variables: { "2": "shipped", "1": "Asha" } } },
      creds,
    );
    expect(result).toEqual({ status: "sent", externalId: templateSuccess.messages[0]!.id });
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919876543210",
      type: "template",
      template: {
        name: "order_update",
        language: { code: "en_US" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Asha" },
              { type: "text", text: "shipped" },
            ],
          },
        ],
      },
    });
  });

  it("named variables become named parameters; a template without a language is refused before any request", async () => {
    const { a, seen } = adapter(() => json(templateSuccess));
    await a.send(channel(), { recipient: "+919876543210", body: "", template: { name: "t", language: "en", variables: { first_name: "Asha" } } }, creds);
    expect(JSON.parse(seen[0]!.body!).template.components[0].parameters).toEqual([{ type: "text", parameter_name: "first_name", text: "Asha" }]);
    expect(await a.send(channel(), { recipient: "+919876543210", body: "", template: { name: "t" } }, creds)).toEqual({
      status: "failed",
      error: "META_TEMPLATE_LANGUAGE_REQUIRED",
      retryable: false,
    });
    expect(seen).toHaveLength(1);
  });

  it("error 100 (400) is not retryable; 130429 and 429 are; a plain 5xx and a network error are not (unknown outcome)", async () => {
    const hard = await adapter(() => json(invalidParameter, 400)).a.send(channel(), { recipient: "+919876543210", body: "x" }, creds);
    expect(hard).toEqual({ status: "failed", error: "META_HTTP_400_100", retryable: false });
    expect(JSON.stringify(hard)).not.toMatch(/Invalid parameter|EAAG/);
    expect(await adapter(() => json(rateLimit, 400)).a.send(channel(), { recipient: "+919876543210", body: "x" }, creds)).toEqual({
      status: "failed",
      error: "META_HTTP_400_130429",
      retryable: true,
    });
    expect(await adapter(() => json({}, 429, { "retry-after": "2" })).a.send(channel(), { recipient: "+919876543210", body: "x" }, creds)).toEqual({
      status: "failed",
      error: "META_HTTP_429",
      retryable: true,
      retryAfterMs: 2000,
    });
    expect(await adapter(() => new Response("bad gateway", { status: 502 })).a.send(channel(), { recipient: "+919876543210", body: "x" }, creds)).toMatchObject(
      {
        status: "failed",
        retryable: false,
      },
    );
    expect(
      await adapter(() => new Response("busy", { status: 503, headers: { "retry-after": "1" } })).a.send(
        channel(),
        { recipient: "+919876543210", body: "x" },
        creds,
      ),
    ).toMatchObject({
      status: "failed",
      retryable: true,
    });
    const down = adapter(() => {
      throw new TypeError("network down");
    });
    expect(await down.a.send(channel(), { recipient: "+919876543210", body: "x" }, creds)).toEqual({
      status: "failed",
      error: "META_UNKNOWN_OUTCOME",
      retryable: false,
    });
  });

  it("a fetch that times out, or a body that never finishes, is UNKNOWN_OUTCOME for send and unavailable for verify", async () => {
    const timedOut = createMetaWhatsAppAdapter({ fetch: hangingFetch, resolveHost: null, timeoutMs: 30 });
    expect(await timedOut.send(channel(), { recipient: "+919876543210", body: "x" }, creds)).toEqual({
      status: "failed",
      error: "META_UNKNOWN_OUTCOME",
      retryable: false,
    });
    expect(await timedOut.verifySender(channel(), creds)).toEqual({ method: "unavailable", error: "META_UNKNOWN_OUTCOME" });
    expect(await adapter(() => endlessBody(200), 30).a.send(channel(), { recipient: "+919876543210", body: "x" }, creds)).toEqual({
      status: "failed",
      error: "META_UNKNOWN_OUTCOME",
      retryable: false,
    });
    expect(await adapter(() => endlessBody(200), 30).a.verifySender(channel(), creds)).toEqual({ method: "unavailable", error: "META_UNKNOWN_OUTCOME" });
  });

  it("a 2xx without messages[0].id is never sent", async () => {
    expect(
      await adapter(() => json({ messaging_product: "whatsapp", messages: [] })).a.send(channel(), { recipient: "+919876543210", body: "x" }, creds),
    ).toEqual({
      status: "failed",
      error: "META_NO_MESSAGE_ID",
      retryable: false,
    });
  });

  it("no API version or no token: nothing is sent (no defaults)", async () => {
    const { a, seen } = adapter(() => json(sendSuccess));
    expect((await a.send(channel({}), { recipient: "+919876543210", body: "x" }, creds)).status).toBe("failed");
    expect((await a.send(channel(), { recipient: "+919876543210", body: "x" }, {})).status).toBe("failed");
    expect(seen).toHaveLength(0);
    expect(a.checkConfig!({ channel_type: "whatsapp", sender_address: PN, config: {} })).toMatch(/apiVersion/);
    expect(a.checkConfig!({ channel_type: "whatsapp", sender_address: "+9198", config: { apiVersion: "v21.0" } })).toMatch(/phone-number id/);
    expect(a.checkConfig!({ channel_type: "whatsapp", sender_address: PN, config: { apiVersion: "v21.0/../x" } })).toMatch(/apiVersion/);
    expect(a.checkConfig!({ channel_type: "whatsapp", sender_address: PN, config: { apiVersion: "v21.0" } })).toBeNull();
    expect(a.checkConfig!({ channel_type: "whatsapp", sender_address: PN, config: { apiVersion: "v21.0", defaultLanguage: "en_US" } })).toBeNull();
    for (const defaultLanguage of ["en US", "english-language-x", 5, "e"]) {
      expect(a.checkConfig!({ channel_type: "whatsapp", sender_address: PN, config: { apiVersion: "v21.0", defaultLanguage } })).toMatch(/defaultLanguage/);
    }
  });
});

describe("WhatsApp Cloud API adapter: sender verification (credential)", () => {
  it("GET /<version>/<phone-number-id> answering that id verifies", async () => {
    const { a, seen } = adapter(() => json(phoneNumber));
    expect(await a.verifySender(channel(), creds)).toEqual({ method: "credential", verified: true });
    expect(seen[0]!.url).toBe(`https://graph.facebook.com/v21.0/${PN}?fields=id`);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("an error, another id, or no token does not verify", async () => {
    expect(await adapter(() => json(invalidParameter, 400)).a.verifySender(channel(), creds)).toEqual({ method: "credential", verified: false });
    expect(await adapter(() => json({ ...phoneNumber, id: "999" })).a.verifySender(channel(), creds)).toEqual({ method: "credential", verified: false });
    const none = adapter(() => json(phoneNumber));
    expect(await none.a.verifySender(channel(), {})).toEqual({ method: "credential", verified: false });
    expect(none.seen).toHaveLength(0);
  });

  it("429, 5xx and network errors are 'unavailable', not a no", async () => {
    for (const status of [429, 500, 503]) {
      expect(await adapter(() => json({}, status)).a.verifySender(channel(), creds)).toEqual({ method: "unavailable", error: `META_HTTP_${status}` });
    }
    const down = adapter(() => {
      throw new TypeError("network down");
    });
    expect(await down.a.verifySender(channel(), creds)).toEqual({ method: "unavailable", error: "META_UNKNOWN_OUTCOME" });
  });
});

describe("WhatsApp Cloud API adapter: status webhook", () => {
  it("a valid X-Hub-Signature-256 maps delivered, read and failed", async () => {
    const { a } = adapter(() => json({}));
    for (const [fixture, expected] of [
      [delivered, [{ externalId: sendSuccess.messages[0]!.id, status: "delivered" }]],
      [read, [{ externalId: sendSuccess.messages[0]!.id, status: "read" }]],
      [failedStatus, [{ externalId: templateSuccess.messages[0]!.id, status: "failed", error: "META_DELIVERY_FAILED_131026" }]],
    ] as const) {
      const body = JSON.stringify(fixture);
      const result = await a.parseStatusWebhook!(body, new Headers({ "x-hub-signature-256": await signature(body) }), creds, channel());
      expect(result).toEqual({ kind: "status", updates: expected });
    }
  });

  it("a forged, missing or wrong-secret signature is invalid; no app secret means invalid", async () => {
    const { a } = adapter(() => json({}));
    const body = JSON.stringify(delivered);
    expect(await a.parseStatusWebhook!(body, new Headers(), creds, channel())).toEqual({ kind: "invalid" });
    expect(await a.parseStatusWebhook!(body, new Headers({ "x-hub-signature-256": await signature(body, "other") }), creds, channel())).toEqual({
      kind: "invalid",
    });
    expect(await a.parseStatusWebhook!(`${body} `, new Headers({ "x-hub-signature-256": await signature(body) }), creds, channel())).toEqual({
      kind: "invalid",
    });
    expect(await a.parseStatusWebhook!(body, new Headers({ "x-hub-signature-256": await signature(body) }), { accessToken: TOKEN }, channel())).toEqual({
      kind: "invalid",
    });
  });

  it("statuses for another phone-number id, and inbound messages, are ignored", async () => {
    const { a } = adapter(() => json({}));
    const body = JSON.stringify(delivered);
    expect(await a.parseStatusWebhook!(body, new Headers({ "x-hub-signature-256": await signature(body) }), creds, channel(undefined, "5550001"))).toEqual({
      kind: "ignored",
    });
    const inboundBody = JSON.stringify(inbound);
    expect(await a.parseStatusWebhook!(inboundBody, new Headers({ "x-hub-signature-256": await signature(inboundBody) }), creds, channel())).toEqual({
      kind: "ignored",
    });
  });

  it("the GET verify challenge echoes hub.challenge only for the channel's verify token", () => {
    const { a } = adapter(() => json({}));
    const q = (token: string, challenge = "1158201444", mode = "subscribe") =>
      new URLSearchParams({ "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge });
    expect(a.answerWebhookChallenge!(q("verify-me-123"), creds, channel())).toBe("1158201444");
    expect(a.answerWebhookChallenge!(q("wrong"), creds, channel())).toBeNull();
    expect(a.answerWebhookChallenge!(q("verify-me-123", "1", "unsubscribe"), creds, channel())).toBeNull();
    expect(a.answerWebhookChallenge!(q("verify-me-123", "<script>"), creds, channel())).toBeNull();
    expect(a.answerWebhookChallenge!(q(""), { accessToken: TOKEN }, channel())).toBeNull();
  });
});
