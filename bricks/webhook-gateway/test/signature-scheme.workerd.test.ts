import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { WebhookSignatureSchemeSchema } from "@poc/assembler";
import migration from "../migrations/0001_webhook_gateway.sql?raw";
import {
  createWebhookRoutes,
  WebhookService,
} from "../src/index.ts";
import type { WebhookEnv, WebhookRouteOptions } from "../src/routes.ts";
import {
  verifyWithScheme,
  type WebhookSignatureScheme,
} from "../src/signature-scheme.ts";

const db = env.DB as D1Like;
const WS_A = "ws_sig_scheme_test";

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

// Helper to compute HMAC in tests using WebCrypto
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
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

describe("Declarative Webhook Signature Schemes (UC4.1)", () => {
  const slackScheme: WebhookSignatureScheme = {
    algorithm: "hmac-sha256",
    signedPayload: "v0:{timestamp}:{body}",
    signatureHeader: "X-Slack-Signature",
    timestampHeader: "X-Slack-Request-Timestamp",
    encoding: "hex",
    prefix: "v0=",
    toleranceSec: 300,
  };

  const secret = "whsec_slack_test_secret_12345";
  const body = JSON.stringify({ event: { type: "message", text: "hello world" } });

  describe("Task 1: verifyWithScheme core engine", () => {
    it("validates a request signed with the Slack scheme object", async () => {
      const timestamp = 1700000000;
      const nowSeconds = 1700000030;
      const signedPayload = `v0:${timestamp}:${body}`;
      const sigHex = await computeHmac("SHA-256", secret, signedPayload, "hex");

      const result = await verifyWithScheme(
        slackScheme,
        {
          rawBody: body,
          headers: {
            "x-slack-signature": `v0=${sigHex}`,
            "x-slack-request-timestamp": String(timestamp),
          },
        },
        secret,
        nowSeconds,
      );

      expect(result).toEqual({ ok: true });
    });

    it("returns WEBHOOK_SIGNATURE_HEADER_MISSING when signature header is missing", async () => {
      const timestamp = 1700000000;
      const result = await verifyWithScheme(
        slackScheme,
        {
          rawBody: body,
          headers: {
            "x-slack-request-timestamp": String(timestamp),
          },
        },
        secret,
        1700000030,
      );

      expect(result).toEqual({
        ok: false,
        reason: "WEBHOOK_SIGNATURE_HEADER_MISSING",
      });
    });

    it("returns WEBHOOK_TIMESTAMP_MISSING when timestamp header is missing", async () => {
      const result = await verifyWithScheme(
        slackScheme,
        {
          rawBody: body,
          headers: {
            "x-slack-signature": "v0=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        },
        secret,
        1700000030,
      );

      expect(result).toEqual({
        ok: false,
        reason: "WEBHOOK_TIMESTAMP_MISSING",
      });
    });

    it("returns WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE when timestamp is older than toleranceSec", async () => {
      const timestamp = 1700000000;
      const nowSeconds = 1700000400; // 400s > 300s
      const signedPayload = `v0:${timestamp}:${body}`;
      const sigHex = await computeHmac("SHA-256", secret, signedPayload, "hex");

      const result = await verifyWithScheme(
        slackScheme,
        {
          rawBody: body,
          headers: {
            "x-slack-signature": `v0=${sigHex}`,
            "x-slack-request-timestamp": String(timestamp),
          },
        },
        secret,
        nowSeconds,
      );

      expect(result).toEqual({
        ok: false,
        reason: "WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE",
      });
    });

    it("returns WEBHOOK_SIGNATURE_MALFORMED when signature prefix is missing or encoding is invalid", async () => {
      const timestamp = 1700000000;
      const signedPayload = `v0:${timestamp}:${body}`;
      const sigHex = await computeHmac("SHA-256", secret, signedPayload, "hex");

      // Missing "v0=" prefix
      const resultNoPrefix = await verifyWithScheme(
        slackScheme,
        {
          rawBody: body,
          headers: {
            "x-slack-signature": sigHex,
            "x-slack-request-timestamp": String(timestamp),
          },
        },
        secret,
        1700000030,
      );
      expect(resultNoPrefix).toEqual({
        ok: false,
        reason: "WEBHOOK_SIGNATURE_MALFORMED",
      });

      // Non-hex characters
      const resultBadHex = await verifyWithScheme(
        slackScheme,
        {
          rawBody: body,
          headers: {
            "x-slack-signature": "v0=not-a-valid-hex-signature-string!!",
            "x-slack-request-timestamp": String(timestamp),
          },
        },
        secret,
        1700000030,
      );
      expect(resultBadHex).toEqual({
        ok: false,
        reason: "WEBHOOK_SIGNATURE_MALFORMED",
      });
    });

    it("returns WEBHOOK_SIGNATURE_MISMATCH when signature, body, or secret does not match", async () => {
      const timestamp = 1700000000;
      const nowSeconds = 1700000030;
      const signedPayload = `v0:${timestamp}:${body}`;
      const sigHex = await computeHmac("SHA-256", secret, signedPayload, "hex");

      // Wrong secret
      const resWrongSecret = await verifyWithScheme(
        slackScheme,
        {
          rawBody: body,
          headers: {
            "x-slack-signature": `v0=${sigHex}`,
            "x-slack-request-timestamp": String(timestamp),
          },
        },
        "wrong_secret",
        nowSeconds,
      );
      expect(resWrongSecret).toEqual({
        ok: false,
        reason: "WEBHOOK_SIGNATURE_MISMATCH",
      });

      // Tampered body
      const resTampered = await verifyWithScheme(
        slackScheme,
        {
          rawBody: body + '{"evil":true}',
          headers: {
            "x-slack-signature": `v0=${sigHex}`,
            "x-slack-request-timestamp": String(timestamp),
          },
        },
        secret,
        nowSeconds,
      );
      expect(resTampered).toEqual({
        ok: false,
        reason: "WEBHOOK_SIGNATURE_MISMATCH",
      });
    });

    it("verifies hmac-sha1, hmac-sha512, and base64 encoded schemes", async () => {
      // 1. hmac-sha1 scheme
      const sha1Scheme: WebhookSignatureScheme = {
        algorithm: "hmac-sha1",
        signedPayload: "{body}",
        signatureHeader: "X-Hub-Signature",
        encoding: "hex",
        prefix: "sha1=",
      };
      const sha1Sig = await computeHmac("SHA-1", secret, body, "hex");
      const sha1Result = await verifyWithScheme(
        sha1Scheme,
        { rawBody: body, headers: { "x-hub-signature": `sha1=${sha1Sig}` } },
        secret,
      );
      expect(sha1Result).toEqual({ ok: true });

      // 2. hmac-sha512 scheme
      const sha512Scheme: WebhookSignatureScheme = {
        algorithm: "hmac-sha512",
        signedPayload: "{body}",
        signatureHeader: "X-Signature-512",
        encoding: "hex",
      };
      const sha512Sig = await computeHmac("SHA-512", secret, body, "hex");
      const sha512Result = await verifyWithScheme(
        sha512Scheme,
        { rawBody: body, headers: { "x-signature-512": sha512Sig } },
        secret,
      );
      expect(sha512Result).toEqual({ ok: true });

      // 3. timestamp+body base64 scheme
      const b64Scheme: WebhookSignatureScheme = {
        algorithm: "hmac-sha256",
        signedPayload: "{timestamp}{body}",
        signatureHeader: "X-Cashfree-Signature",
        timestampHeader: "X-Cashfree-Timestamp",
        encoding: "base64",
        toleranceSec: 300,
      };
      const ts = 1700000000;
      const b64Sig = await computeHmac("SHA-256", secret, `${ts}${body}`, "base64");
      const b64Result = await verifyWithScheme(
        b64Scheme,
        {
          rawBody: body,
          headers: {
            "x-cashfree-signature": b64Sig,
            "x-cashfree-timestamp": String(ts),
          },
        },
        secret,
        1700000020,
      );
      expect(b64Result).toEqual({ ok: true });
    });

    it("supports signatureFormat kv-list with multiple candidate signatures", async () => {
      const kvScheme: WebhookSignatureScheme = {
        algorithm: "hmac-sha256",
        signedPayload: "{timestamp}.{body}",
        signatureHeader: "Stripe-Signature",
        encoding: "hex",
        signatureFormat: {
          kind: "kv-list",
          pairSeparator: ",",
          kvSeparator: "=",
          timestampKey: "t",
          signatureKey: "v1",
        },
        toleranceSec: 300,
      };

      const ts = 1700000000;
      const validSig = await computeHmac("SHA-256", secret, `${ts}.${body}`, "hex");
      const oldSig = "0000000000000000000000000000000000000000000000000000000000000000";

      // Header has old rotated signature and current valid signature
      const headerVal = `t=${ts},v1=${oldSig},v1=${validSig}`;
      const res = await verifyWithScheme(
        kvScheme,
        {
          rawBody: body,
          headers: { "stripe-signature": headerVal },
        },
        secret,
        1700000020,
      );
      expect(res).toEqual({ ok: true });

      // Header missing v1 key
      const badHeader = `t=${ts},v0=123`;
      const resBad = await verifyWithScheme(
        kvScheme,
        {
          rawBody: body,
          headers: { "stripe-signature": badHeader },
        },
        secret,
        1700000020,
      );
      expect(resBad).toEqual({
        ok: false,
        reason: "WEBHOOK_SIGNATURE_MALFORMED",
      });
    });
  });

  describe("AC2: Schema validation of signedPayload tokens and literals", () => {
    it("accepts valid scheme objects with allowed tokens {body}, {timestamp}, {id}, {url}", () => {
      const valid = WebhookSignatureSchemeSchema.safeParse({
        algorithm: "hmac-sha256",
        signedPayload: "v0:{timestamp}:{body}:{id}:{url}",
        signatureHeader: "X-Test-Sig",
        timestampHeader: "X-Test-Ts",
        idHeader: "X-Test-Id",
        encoding: "hex",
        prefix: "v0=",
        toleranceSec: 300,
      });
      expect(valid.success).toBe(true);
    });

    it("rejects unknown tokens with WEBHOOK_SCHEME_UNKNOWN_TOKEN", () => {
      const invalidToken = WebhookSignatureSchemeSchema.safeParse({
        algorithm: "hmac-sha256",
        signedPayload: "v0:{timestamp}:{secret}:{body}",
        signatureHeader: "X-Test-Sig",
        encoding: "hex",
      });
      expect(invalidToken.success).toBe(false);
      if (!invalidToken.success) {
        expect(
          invalidToken.error.issues.some((i) =>
            i.message.includes("WEBHOOK_SCHEME_UNKNOWN_TOKEN"),
          ),
        ).toBe(true);
      }
    });

    it("rejects illegal literal characters in signedPayload template", () => {
      const invalidChars = WebhookSignatureSchemeSchema.safeParse({
        algorithm: "hmac-sha256",
        signedPayload: "{timestamp}:{body}$%^&*",
        signatureHeader: "X-Test-Sig",
        encoding: "hex",
      });
      expect(invalidChars.success).toBe(false);
    });
  });

  describe("AC1 & AC3: End-to-end /api/webhooks/in/:subscriptionId", () => {
    const createApp = (options: WebhookRouteOptions = {}) => {
      const app = new Hono<WebhookEnv>();
      app.use("*", async (c, next) => {
        c.set("workspace", { id: WS_A, role: "admin" });
        c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: WS_A, role: "admin" }));
        c.set("user", { uid: "usr_alice", email: "alice@test.com" });
        await next();
      });
      app.route("/api", createWebhookRoutes(options));
      return app;
    };

    it("verifies matching webhook request through /api/webhooks/in/:subscriptionId and rejects invalid requests with 401", async () => {
      let currentMockTime = 1700000050;
      const app = createApp({
        adapter: {
          nowSeconds: () => currentMockTime,
          integrations: {
            slack: {
              manifest: {
                manifestVersion: 2,
                kind: "integration",
                app: "slack",
                version: "1.0.0",
                ui: {
                  displayName: "Slack",
                  category: "chat",
                  icon: "message-square",
                  docsUrl: "https://api.slack.com",
                  summary: "Slack workspace integration",
                  maturity: "production",
                  behaviourTest: "test/slack.test.ts",
                },
                auth: {
                  type: "oauth2",
                  scopes: ["channels:read"],
                  authorizeUrl: "https://slack.com/oauth/v2/authorize",
                  tokenUrl: "https://slack.com/api/oauth.v2.access",
                  headerName: "Authorization",
                  prefix: "Bearer",
                },
                baseUrl: "https://slack.com/api",
                allowedHosts: ["slack.com"],
                operations: [],
                triggers: [
                  {
                    id: "slack-events",
                    label: "Slack Events API",
                    summary: "Fires on Slack events callback",
                    verifier: slackScheme,
                    signatureHeader: "X-Slack-Signature",
                    eventIdPath: "event_id",
                    outputs: [{ id: "out", label: "Payload", dataType: "object" }],
                  },
                ],
              } as any,
            },
          },
        },
      });

      const service = new WebhookService(db);
      await service.registerSubscription({
        id: "sub_slack_tracer",
        workspaceId: WS_A,
        app: "slack",
        triggerId: "slack-events",
        workflowId: "wf-slack-events",
        signingSecret: secret,
        verifier: "hmac-sha256",
        signatureHeader: "X-Slack-Signature",
        eventIdPath: "$.event_id",
      });

      const timestamp = 1700000000;
      const eventPayload = JSON.stringify({
        event_id: "evt_slack_999",
        event: { type: "app_mention", text: "bot help" },
      });
      const signedPayload = `v0:${timestamp}:${eventPayload}`;
      const validSig = await computeHmac("SHA-256", secret, signedPayload, "hex");

      // 1. Valid request -> 200 { received: true, deduplicated: false }
      const resValid = await app.fetch(
        new Request("http://localhost/api/webhooks/in/sub_slack_tracer", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Signature": `v0=${validSig}`,
            "X-Slack-Request-Timestamp": String(timestamp),
          },
          body: eventPayload,
        }),
        { DB: db },
      );
      expect(resValid.status).toBe(200);
      const jsonValid = (await resValid.json()) as { received: boolean; eventId: string };
      expect(jsonValid).toMatchObject({
        received: true,
        eventId: "evt_slack_999",
      });

      // 2. Tampered body -> 401 WEBHOOK_SIGNATURE_MISMATCH
      const resTampered = await app.fetch(
        new Request("http://localhost/api/webhooks/in/sub_slack_tracer", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Signature": `v0=${validSig}`,
            "X-Slack-Request-Timestamp": String(timestamp),
          },
          body: eventPayload + "tamper",
        }),
        { DB: db },
      );
      expect(resTampered.status).toBe(401);
      const jsonTampered = (await resTampered.json()) as { error: string };
      expect(jsonTampered.error).toBe("WEBHOOK_SIGNATURE_MISMATCH");
      // AC3: Ensure error never leaks secret or expected signature
      expect(JSON.stringify(jsonTampered)).not.toContain(secret);
      expect(JSON.stringify(jsonTampered)).not.toContain(validSig);

      // 3. Missing header -> 401 WEBHOOK_SIGNATURE_HEADER_MISSING
      const resMissingHeader = await app.fetch(
        new Request("http://localhost/api/webhooks/in/sub_slack_tracer", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Request-Timestamp": String(timestamp),
          },
          body: eventPayload,
        }),
        { DB: db },
      );
      expect(resMissingHeader.status).toBe(401);
      const jsonMissingHeader = (await resMissingHeader.json()) as { error: string };
      expect(jsonMissingHeader.error).toBe("WEBHOOK_SIGNATURE_HEADER_MISSING");

      // 4. Stale timestamp -> 401 WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE
      const staleTimestamp = timestamp - 600; // 600s ago > 300s tolerance
      const staleSigned = `v0:${staleTimestamp}:${eventPayload}`;
      const staleSig = await computeHmac("SHA-256", secret, staleSigned, "hex");
      const resStale = await app.fetch(
        new Request("http://localhost/api/webhooks/in/sub_slack_tracer", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Signature": `v0=${staleSig}`,
            "X-Slack-Request-Timestamp": String(staleTimestamp),
          },
          body: eventPayload,
        }),
        { DB: db },
      );
      expect(resStale.status).toBe(401);
      const jsonStale = (await resStale.json()) as { error: string };
      expect(jsonStale.error).toBe("WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE");
    });
  });
});
