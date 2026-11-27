import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_webhook_gateway.sql?raw";
import { createWebhookRoutes, WebhookService } from "../src/index.ts";
import type { WebhookEnv, WebhookRouteOptions } from "../src/routes.ts";
import { verifyWithScheme, type WebhookSignatureScheme } from "../src/signature-scheme.ts";
import discordVector from "./fixtures/webhook-vectors/discord.json";

const db = env.DB as D1Like;
const WS_ED25519 = "ws_ed25519_test";

async function resetDb(): Promise<void> {
  for (const table of ["px_webhook_deliveries", "wh_subscriptions", "px_connections", "wh_deliveries", "wh_endpoints", "px_logs"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
  vi.restoreAllMocks();
});

describe("UC4.2 — Real Ed25519 verification via WebCrypto", () => {
  // RFC 8032 §7.1 TEST 1: empty message
  const rfc8032Test1 = {
    publicKeyHex: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    message: "",
    signatureHex: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  };

  // RFC 8032 §7.1 TEST 2: 1-byte message 'r' (0x72)
  const rfc8032Test2 = {
    publicKeyHex: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    message: "r",
    signatureHex: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  };

  describe("AC1: RFC 8032 TEST 1 and TEST 2 known-answer vectors", () => {
    const rawScheme: WebhookSignatureScheme = {
      algorithm: "ed25519",
      signedPayload: "{body}",
      signatureHeader: "X-Signature-Ed25519",
      encoding: "hex",
    };

    it("verifies RFC 8032 TEST 1 (empty message)", async () => {
      const res = await verifyWithScheme(
        rawScheme,
        {
          rawBody: rfc8032Test1.message,
          headers: { "x-signature-ed25519": rfc8032Test1.signatureHex },
        },
        rfc8032Test1.publicKeyHex,
      );
      expect(res).toEqual({ ok: true });
    });

    it("verifies RFC 8032 TEST 2 (single-byte message)", async () => {
      const res = await verifyWithScheme(
        rawScheme,
        {
          rawBody: rfc8032Test2.message,
          headers: { "x-signature-ed25519": rfc8032Test2.signatureHex },
        },
        rfc8032Test2.publicKeyHex,
      );
      expect(res).toEqual({ ok: true });
    });

    it("verifies Discord-shaped vector with {timestamp}{body}", async () => {
      const discordScheme: WebhookSignatureScheme = {
        algorithm: "ed25519",
        signedPayload: "{timestamp}{body}",
        signatureHeader: "X-Signature-Ed25519",
        timestampHeader: "X-Signature-Timestamp",
        encoding: "hex",
        toleranceSec: 300,
      };

      const res = await verifyWithScheme(
        discordScheme,
        {
          rawBody: discordVector.rawBody,
          headers: discordVector.headers,
        },
        discordVector.publicKey,
        discordVector.nowSeconds,
      );
      expect(res).toEqual({ ok: true });
    });

    it("returns WEBHOOK_SIGNATURE_MISMATCH on 1-bit flip in body, timestamp, or signature", async () => {
      const discordScheme: WebhookSignatureScheme = {
        algorithm: "ed25519",
        signedPayload: "{timestamp}{body}",
        signatureHeader: "X-Signature-Ed25519",
        timestampHeader: "X-Signature-Timestamp",
        encoding: "hex",
      };

      // 1. Tampered body
      const resBadBody = await verifyWithScheme(
        discordScheme,
        {
          rawBody: discordVector.rawBody + " ",
          headers: discordVector.headers,
        },
        discordVector.publicKey,
      );
      expect(resBadBody).toEqual({ ok: false, reason: "WEBHOOK_SIGNATURE_MISMATCH" });

      // 2. Tampered timestamp
      const resBadTs = await verifyWithScheme(
        discordScheme,
        {
          rawBody: discordVector.rawBody,
          headers: {
            ...discordVector.headers,
            "X-Signature-Timestamp": "1700000001",
          },
        },
        discordVector.publicKey,
      );
      expect(resBadTs).toEqual({ ok: false, reason: "WEBHOOK_SIGNATURE_MISMATCH" });

      // 3. Flipped bit in signature hex (change last char from 'f' to 'e')
      const tamperedSig = discordVector.signature.slice(0, -1) + (discordVector.signature.endsWith("f") ? "e" : "f");
      const resBadSig = await verifyWithScheme(
        discordScheme,
        {
          rawBody: discordVector.rawBody,
          headers: {
            ...discordVector.headers,
            "X-Signature-Ed25519": tamperedSig,
          },
        },
        discordVector.publicKey,
      );
      expect(resBadSig).toEqual({ ok: false, reason: "WEBHOOK_SIGNATURE_MISMATCH" });

      // 4. Wrong public key
      const wrongKey = rfc8032Test2.publicKeyHex;
      const resWrongKey = await verifyWithScheme(
        discordScheme,
        {
          rawBody: discordVector.rawBody,
          headers: discordVector.headers,
        },
        wrongKey,
      );
      expect(resWrongKey).toEqual({ ok: false, reason: "WEBHOOK_SIGNATURE_MISMATCH" });
    });

    it("returns WEBHOOK_SIGNATURE_MALFORMED on malformed signature or key length", async () => {
      const discordScheme: WebhookSignatureScheme = {
        algorithm: "ed25519",
        signedPayload: "{timestamp}{body}",
        signatureHeader: "X-Signature-Ed25519",
        timestampHeader: "X-Signature-Timestamp",
        encoding: "hex",
      };

      // Non-hex signature
      const resNonHex = await verifyWithScheme(
        discordScheme,
        {
          rawBody: discordVector.rawBody,
          headers: {
            ...discordVector.headers,
            "X-Signature-Ed25519": "not-hex-at-all!!",
          },
        },
        discordVector.publicKey,
      );
      expect(resNonHex).toEqual({ ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" });

      // Truncated signature (< 64 bytes / 128 hex chars)
      const resTruncSig = await verifyWithScheme(
        discordScheme,
        {
          rawBody: discordVector.rawBody,
          headers: {
            ...discordVector.headers,
            "X-Signature-Ed25519": discordVector.signature.slice(0, 64),
          },
        },
        discordVector.publicKey,
      );
      expect(resTruncSig).toEqual({ ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" });

      // Invalid public key length (!== 32 bytes / 64 hex chars)
      const resBadKey = await verifyWithScheme(
        discordScheme,
        {
          rawBody: discordVector.rawBody,
          headers: discordVector.headers,
        },
        "0123456789abcdef", // 16 hex chars = 8 bytes
      );
      expect(resBadKey).toEqual({ ok: false, reason: "WEBHOOK_SIGNATURE_MALFORMED" });
    });
  });

  describe("AC2: No code path computes HMAC for an ed25519 scheme", () => {
    it("never calls crypto.subtle.sign when verifying ed25519 scheme", async () => {
      const signSpy = vi.spyOn(crypto.subtle, "sign");
      const verifySpy = vi.spyOn(crypto.subtle, "verify");

      const discordScheme: WebhookSignatureScheme = {
        algorithm: "ed25519",
        signedPayload: "{timestamp}{body}",
        signatureHeader: "X-Signature-Ed25519",
        timestampHeader: "X-Signature-Timestamp",
        encoding: "hex",
      };

      const res = await verifyWithScheme(
        discordScheme,
        {
          rawBody: discordVector.rawBody,
          headers: discordVector.headers,
        },
        discordVector.publicKey,
      );

      expect(res).toEqual({ ok: true });
      expect(signSpy).not.toHaveBeenCalled();
      expect(verifySpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("AC3: End-to-end /api/webhooks/in/:subscriptionId", () => {
    const discordScheme: WebhookSignatureScheme = {
      algorithm: "ed25519",
      signedPayload: "{timestamp}{body}",
      signatureHeader: "X-Signature-Ed25519",
      timestampHeader: "X-Signature-Timestamp",
      encoding: "hex",
      toleranceSec: 300,
    };

    const createApp = (options: WebhookRouteOptions = {}) => {
      const app = new Hono<WebhookEnv>();
      app.use("*", async (c, next) => {
        c.set("workspace", { id: WS_ED25519, role: "admin" });
        c.set("ctx", Object.freeze({ userId: "usr_alice", workspaceId: WS_ED25519, role: "admin" }));
        c.set("user", { uid: "usr_alice", email: "alice@test.com" });
        await next();
      });
      app.route("/api", createWebhookRoutes(options));
      return app;
    };

    it("starts workflow on valid Ed25519 signature and returns 401 on HMAC forgery", async () => {
      let triggeredEvent: { app: string; triggerId: string; eventId: string } | null = null;

      const app = createApp({
        adapter: {
          nowSeconds: () => discordVector.nowSeconds,
          onTriggerWorkflow: (ctx) => {
            triggeredEvent = { app: ctx.app, triggerId: ctx.triggerId, eventId: ctx.eventId };
            return { runId: "run_discord_123" };
          },
          integrations: {
            discord: {
              manifest: {
                manifestVersion: 2,
                kind: "integration",
                app: "discord",
                version: "1.0.0",
                ui: {
                  displayName: "Discord",
                  category: "chat",
                  icon: "message-square",
                  docsUrl: "https://discord.com/developers/docs",
                  summary: "Discord bot and interactions",
                  maturity: "production",
                  behaviourTest: "test/discord.test.ts",
                },
                auth: {
                  type: "apiKey",
                  headerName: "Authorization",
                  prefix: "Bot",
                },
                baseUrl: "https://discord.com/api/v10",
                allowedHosts: ["discord.com"],
                operations: [],
                triggers: [
                  {
                    id: "interaction",
                    label: "Discord Interaction",
                    summary: "Fires on Discord interaction webhook",
                    verifier: discordScheme,
                    signatureHeader: "X-Signature-Ed25519",
                    eventIdPath: "id",
                    outputs: [{ id: "out", label: "Interaction", dataType: "object" }],
                  },
                ],
              } as any,
            },
          },
        },
      });

      const service = new WebhookService(db);
      await service.registerSubscription({
        id: "sub_discord_ed25519",
        workspaceId: WS_ED25519,
        app: "discord",
        triggerId: "interaction",
        workflowId: "wf-discord-bot",
        signingSecret: discordVector.publicKey,
        verifier: discordScheme,
        signatureHeader: "X-Signature-Ed25519",
        eventIdPath: "$.id",
      });

      // 1. Valid Ed25519 signature starts workflow -> 200
      const resValid = await app.fetch(
        new Request("http://localhost/api/webhooks/in/sub_discord_ed25519", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": discordVector.headers["X-Signature-Ed25519"],
            "X-Signature-Timestamp": discordVector.headers["X-Signature-Timestamp"],
          },
          body: discordVector.rawBody,
        }),
        { DB: db },
      );

      expect(resValid.status).toBe(200);
      const jsonValid = (await resValid.json()) as { received: boolean };
      expect(jsonValid.received).toBe(true);
      expect(triggeredEvent).toMatchObject({
        app: "discord",
        triggerId: "interaction",
      });

      // 2. HMAC signature (simulating attacker attempting HMAC forgery or old broken behavior)
      // Attempting HMAC-SHA256 over rawBody using public key as secret
      const enc = new TextEncoder();
      const hmacKey = await crypto.subtle.importKey("raw", enc.encode(discordVector.publicKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const hmacSig = await crypto.subtle.sign("HMAC", hmacKey, enc.encode(discordVector.rawBody));
      const hmacHex = Array.from(new Uint8Array(hmacSig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const resHmac = await app.fetch(
        new Request("http://localhost/api/webhooks/in/sub_discord_ed25519", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Signature-Ed25519": hmacHex,
            "X-Signature-Timestamp": discordVector.headers["X-Signature-Timestamp"],
          },
          body: discordVector.rawBody,
        }),
        { DB: db },
      );

      expect(resHmac.status).toBe(401);
      const jsonHmac = (await resHmac.json()) as { error: string };
      // 32-byte HMAC hex is 64 hex chars, but Ed25519 signature must be 64 bytes (128 hex chars)
      expect(["WEBHOOK_SIGNATURE_MALFORMED", "WEBHOOK_SIGNATURE_MISMATCH"]).toContain(jsonHmac.error);
    });
  });
});
