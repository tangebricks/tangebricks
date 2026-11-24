import { describe, expect, test, vi } from "vitest";
import { assemble, BlueprintSchema } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";
import { verifyTelemetrySignature, TELEMETRY_SIGNATURE_HEADER } from "@poc/telemetry";

describe("UC9.4 — Observability preset: Workers Logs, Logpush and a Tail Worker alert path", () => {
  const baseBlueprint = {
    project: "observed-app",
    bricks: ["multi-workspace", "credit-wallet"],
  };

  test("Red: BlueprintSchema accepts observability preset configuration", () => {
    const blueprintWithObs = {
      ...baseBlueprint,
      observability: {
        logs: true,
        logpush: true,
        alerts: { webhookSecret: "PX_ALERT_WEBHOOK_URL" },
      },
    };

    const parseResult = BlueprintSchema.safeParse(blueprintWithObs);
    expect(parseResult.success).toBe(true);
  });

  test("AC1: Assembly with observability preset emits wrangler.jsonc with observability, logpush, tail_consumers and emits tail worker files", () => {
    const blueprintWithObs = {
      ...baseBlueprint,
      observability: {
        logs: true,
        logpush: true,
        alerts: { webhookSecret: "PX_ALERT_WEBHOOK_URL" },
      },
    };

    const result = assemble(blueprintWithObs, catalog);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("; "));

    const wrangler = JSON.parse(result.files["wrangler.jsonc"]!.replace(/^\/\/.*\n/, ""));
    expect(wrangler.observability).toEqual({ enabled: true });
    expect(wrangler.logpush).toBe(true);
    expect(wrangler.tail_consumers).toEqual([{ service: "observed-app-tail" }]);

    expect(result.files["tail/src/index.ts"]).toBeDefined();
    expect(result.files["tail/wrangler.jsonc"]).toBeDefined();

    const tailWrangler = JSON.parse(result.files["tail/wrangler.jsonc"]!.replace(/^\/\/.*\n/, ""));
    expect(tailWrangler.name).toBe("observed-app-tail");
    expect(tailWrangler.main).toBe("src/index.ts");
  });

  test("AC1: Without observability preset, no observability/logpush/tail_consumers are added and no tail files emitted", () => {
    const result = assemble(baseBlueprint, catalog);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("; "));

    const wrangler = JSON.parse(result.files["wrangler.jsonc"]!.replace(/^\/\/.*\n/, ""));
    expect(wrangler.observability).toBeUndefined();
    expect(wrangler.logpush).toBeUndefined();
    expect(wrangler.tail_consumers).toBeUndefined();

    expect(result.files["tail/src/index.ts"]).toBeUndefined();
    expect(result.files["tail/wrangler.jsonc"]).toBeUndefined();
  });

  test("AC2: Tail handler filters alerts, scrubs sk_live_... secret from exception, signs payload, and drops when webhook unset", async () => {
    const { handleTail } = (await import("../src/index.ts")) as any;
    expect(typeof handleTail).toBe("function");

    const sentRequests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const mockFetcher = async (url: string | URL | Request, init?: RequestInit) => {
      sentRequests.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return new Response("ok", { status: 200 });
    };

    const webhookSecretName = "PX_ALERT_WEBHOOK_URL";
    const secretKey = "sec_test_telemetry_signing_secret_123456";
    const env = {
      [webhookSecretName]: "https://alerts.example.com/webhook",
      PX_ALERT_SIGNING_SECRET: secretKey,
    };

    // 1. Exception event containing sk_live_ stripe secret
    const secret = "sk_" + "live_51OzX1234567890abcdefghijklmnopqrstuvwxyz";
    const exceptionEvent = {
      outcome: "exception",
      scriptName: "observed-app",
      eventTimestamp: 1700000000000,
      exceptions: [
        {
          name: "StripeError",
          message: `Stripe charge failed with apiKey ${secret}: insufficient funds`,
          timestamp: 1700000000000,
        },
      ],
      event: {
        request: { url: "https://observed-app.workers.dev/api/checkout", method: "POST" },
        response: { status: 500 },
      },
    };

    // Normal ok event that should NOT trigger an alert
    const okEvent = {
      outcome: "ok",
      scriptName: "observed-app",
      eventTimestamp: 1700000000000,
      exceptions: [],
      event: {
        request: { url: "https://observed-app.workers.dev/healthz", method: "GET" },
        response: { status: 200 },
      },
    };

    await handleTail([okEvent, exceptionEvent], env, mockFetcher);

    expect(sentRequests.length).toBe(1);
    const sent = sentRequests[0]!;
    expect(sent.url).toBe("https://alerts.example.com/webhook");

    // Must have HMAC signature header
    const signature = sent.headers[TELEMETRY_SIGNATURE_HEADER];
    expect(signature).toBeDefined();
    const verified = await verifyTelemetrySignature(sent.body, signature, secretKey);
    expect(verified).toBe(true);

    // AC2: Alert body has the exception and NO secret
    expect(sent.body).toContain("Stripe charge failed with apiKey");
    expect(sent.body).toContain("[REDACTED:stripe]");
    expect(sent.body).not.toContain(secret);

    // 2. Only ok events -> drops (0 requests sent)
    sentRequests.length = 0;
    await handleTail([okEvent], env, mockFetcher);
    expect(sentRequests.length).toBe(0);

    // 3. Webhook unset -> drops (0 requests sent)
    sentRequests.length = 0;
    await handleTail([exceptionEvent], {}, mockFetcher);
    expect(sentRequests.length).toBe(0);
  });
});
