import { describe, expect, it } from "vitest";
import type { DeliveryChannel } from "@poc/sdk";
import { EgressForbiddenError } from "@poc/sdk";
import { thrownErrorCode } from "../src/delivery-http.ts";
import { createZeptoMailAdapter } from "../src/zeptomail.ts";
import invalidToken from "./fixtures/zeptomail/error.invalid-token.json";
import mandatoryField from "./fixtures/zeptomail/error.mandatory-field.json";
import templateSuccess from "./fixtures/zeptomail/send-template.success.json";
import sendSuccess from "./fixtures/zeptomail/send.success.json";

// Story 2.4: the ZeptoMail adapter against ZeptoMail's documented response shapes. The fixtures are documented samples,
// not live recordings (fixtures/zeptomail/README.md). No request leaves the test: every call goes to the injected
// fetch, and host resolution is off.

const TOKEN = "zm_contract_test_token";
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
  const a = createZeptoMailAdapter({
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

const channel = (config: Record<string, unknown> = { region: "in" }): DeliveryChannel => ({
  id: "chn_1",
  workspace_id: "ws_1",
  channel_type: "email",
  provider: "zeptomail",
  sender_address: "noreply@example.com",
  config,
});

describe("ZeptoMail adapter: send", () => {
  it("POSTs /v1.1/email on the configured region with the Zoho-enczapikey header; 201 request_id is sent", async () => {
    const { a, seen } = adapter(() => json(sendSuccess, 201));
    const result = await a.send(
      channel({ region: "in", fromName: "Example" }),
      { recipient: "asha@example.org", subject: "Hello", body: "Hi Asha" },
      { apiKey: TOKEN },
    );
    expect(result).toEqual({ status: "sent", externalId: sendSuccess.request_id });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.zeptomail.in/v1.1/email");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.get("authorization")).toBe(`Zoho-enczapikey ${TOKEN}`);
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      from: { address: "noreply@example.com", name: "Example" },
      to: [{ email_address: { address: "asha@example.org" } }],
      subject: "Hello",
      textbody: "Hi Asha",
    });
  });

  it("a token given with its prefix is not prefixed twice; bodyFormat html sends htmlbody", async () => {
    const { a, seen } = adapter(() => json(sendSuccess, 201));
    await a.send(
      channel({ region: "com", bodyFormat: "html" }),
      { recipient: "a@example.org", subject: "S", body: "<p>x</p>" },
      { apiKey: `Zoho-enczapikey ${TOKEN}` },
    );
    expect(seen[0]!.url).toBe("https://api.zeptomail.com/v1.1/email");
    expect(seen[0]!.headers.get("authorization")).toBe(`Zoho-enczapikey ${TOKEN}`);
    expect(JSON.parse(seen[0]!.body!).htmlbody).toBe("<p>x</p>");
  });

  it("a template goes to /v1.1/email/template with mail_template_key and merge_info", async () => {
    const { a, seen } = adapter(() => json(templateSuccess, 201));
    const result = await a.send(
      channel({ region: "eu" }),
      { recipient: "a@example.org", body: "", template: { name: "2d6f.tmpl.key", variables: { name: "Asha", plan: "Pro" } } },
      { apiKey: TOKEN },
    );
    expect(result).toEqual({ status: "sent", externalId: templateSuccess.request_id });
    expect(seen[0]!.url).toBe("https://api.zeptomail.eu/v1.1/email/template");
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      from: { address: "noreply@example.com" },
      to: [{ email_address: { address: "a@example.org" } }],
      mail_template_key: "2d6f.tmpl.key",
      merge_info: { name: "Asha", plan: "Pro" },
    });
  });

  it("400 is failed, not retryable, with a short code and no provider text or token", async () => {
    const { a } = adapter(() => json(mandatoryField, 400));
    const result = await a.send(channel(), { recipient: "a@example.org", body: "x" }, { apiKey: TOKEN });
    expect(result).toEqual({ status: "failed", error: "ZEPTOMAIL_HTTP_400_TM_3201", retryable: false });
    expect(JSON.stringify(result)).not.toMatch(/Mandatory|zm_contract/);
  });

  it("401 is failed, not retryable", async () => {
    const { a } = adapter(() => json(invalidToken, 401));
    expect(await a.send(channel(), { recipient: "a@example.org", body: "x" }, { apiKey: TOKEN })).toEqual({
      status: "failed",
      error: "ZEPTOMAIL_HTTP_401_TM_3301",
      retryable: false,
    });
  });

  it("429 and a 503 with Retry-After are retryable; any other 5xx and a network error are not (the outcome may be unknown)", async () => {
    expect(await adapter(() => json({}, 429, { "retry-after": "1" })).a.send(channel(), { recipient: "a@example.org", body: "x" }, { apiKey: TOKEN })).toEqual({
      status: "failed",
      error: "ZEPTOMAIL_HTTP_429",
      retryable: true,
      retryAfterMs: 1000,
    });
    expect(
      await adapter(() => new Response("busy", { status: 503, headers: { "retry-after": "1" } })).a.send(
        channel(),
        { recipient: "a@example.org", body: "x" },
        { apiKey: TOKEN },
      ),
    ).toMatchObject({
      status: "failed",
      error: "ZEPTOMAIL_HTTP_503",
      retryable: true,
    });
    for (const status of [500, 502, 503]) {
      expect(
        await adapter(() => new Response("oops", { status })).a.send(channel(), { recipient: "a@example.org", body: "x" }, { apiKey: TOKEN }),
      ).toMatchObject({
        status: "failed",
        error: `ZEPTOMAIL_HTTP_${status}`,
        retryable: false,
      });
    }
    const down = adapter(() => {
      throw new TypeError(`connect ECONNRESET ${TOKEN}`);
    });
    const result = await down.a.send(channel(), { recipient: "a@example.org", body: "x" }, { apiKey: TOKEN });
    expect(result).toEqual({ status: "failed", error: "ZEPTOMAIL_UNKNOWN_OUTCOME", retryable: false });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("a fetch that times out is UNKNOWN_OUTCOME (not egress-refused), and so is a body that never finishes", async () => {
    const timedOut = createZeptoMailAdapter({ fetch: hangingFetch, resolveHost: null, timeoutMs: 30 });
    expect(await timedOut.send(channel(), { recipient: "a@example.org", body: "x" }, { apiKey: TOKEN })).toEqual({
      status: "failed",
      error: "ZEPTOMAIL_UNKNOWN_OUTCOME",
      retryable: false,
    });
    const slowBody = adapter(() => endlessBody(), 30);
    expect(await slowBody.a.send(channel(), { recipient: "a@example.org", body: "x" }, { apiKey: TOKEN })).toEqual({
      status: "failed",
      error: "ZEPTOMAIL_UNKNOWN_OUTCOME",
      retryable: false,
    });
  });

  it("thrownErrorCode: the guard's EGRESS_TIMEOUT is UNKNOWN_OUTCOME; its pre-send refusals are EGRESS_REFUSED", () => {
    expect(thrownErrorCode("X", new EgressForbiddenError("EGRESS_TIMEOUT", "timed out"))).toBe("X_UNKNOWN_OUTCOME");
    expect(thrownErrorCode("X", new EgressForbiddenError("EGRESS_FORBIDDEN", "private"))).toBe("X_EGRESS_REFUSED");
    expect(thrownErrorCode("X", new EgressForbiddenError("EGRESS_TOO_MANY_REDIRECTS", "redirect"))).toBe("X_EGRESS_REFUSED");
    expect(thrownErrorCode("X", new TypeError("reset"))).toBe("X_UNKNOWN_OUTCOME");
  });

  it("a host the egress guard refuses before sending is EGRESS_REFUSED", async () => {
    const refused = createZeptoMailAdapter({ fetch: async () => new Response("{}"), resolveHost: async () => ["10.0.0.1"] });
    expect(await refused.send(channel(), { recipient: "a@example.org", body: "x" }, { apiKey: TOKEN })).toEqual({
      status: "failed",
      error: "ZEPTOMAIL_EGRESS_REFUSED",
      retryable: false,
    });
  });

  it("a 2xx without request_id is never sent", async () => {
    expect(await adapter(() => json({ message: "OK" }, 201)).a.send(channel(), { recipient: "a@example.org", body: "x" }, { apiKey: TOKEN })).toEqual({
      status: "failed",
      error: "ZEPTOMAIL_NO_REQUEST_ID",
      retryable: false,
    });
  });

  it("a redirect is not followed (the token would travel with it)", async () => {
    const { a, seen } = adapter(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
    const result = await a.send(channel(), { recipient: "a@example.org", body: "x" }, { apiKey: TOKEN });
    expect(result.status).toBe("failed");
    expect(seen).toHaveLength(1);
  });

  it("no region, no token: nothing is sent (no defaults)", async () => {
    const { a, seen } = adapter(() => json(sendSuccess, 201));
    expect(await a.send(channel({}), { recipient: "a@example.org", body: "x" }, { apiKey: TOKEN })).toMatchObject({
      status: "failed",
      error: "ZEPTOMAIL_NOT_CONFIGURED",
    });
    expect(await a.send(channel(), { recipient: "a@example.org", body: "x" }, {})).toMatchObject({ status: "failed", error: "ZEPTOMAIL_NOT_CONFIGURED" });
    expect(seen).toHaveLength(0);
    expect(a.checkConfig!({ channel_type: "email", sender_address: "a@b.co", config: {} })).toMatch(/region/);
    expect(a.checkConfig!({ channel_type: "email", sender_address: "a@b.co", config: { region: "evil.com/x" } })).toMatch(/region/);
    expect(a.checkConfig!({ channel_type: "whatsapp", sender_address: "1", config: { region: "com" } })).not.toBeNull();
    expect(a.checkConfig!({ channel_type: "email", sender_address: "a@b.co", config: { region: "com" } })).toBeNull();
    for (const fromName of ["Evil\r\nBcc: x@y.z", "A\nB", "A\u0000B"]) {
      expect(a.checkConfig!({ channel_type: "email", sender_address: "a@b.co", config: { region: "com", fromName } })).toMatch(/fromName/);
    }
    expect(a.checkConfig!({ channel_type: "email", sender_address: "a@b.co", config: { region: "com", fromName: "Example Store" } })).toBeNull();
  });

  it("sender verification is by code and has no status webhook", async () => {
    const { a, seen } = adapter(() => json(sendSuccess, 201));
    expect(await a.verifySender(channel(), { apiKey: TOKEN })).toEqual({ method: "code" });
    expect(seen).toHaveLength(0);
    expect(a.parseStatusWebhook).toBeUndefined();
  });
});
