import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { IntegrationCallError } from "@poc/runtime";
import { applyMigration, type D1Like } from "@poc/sdk";
import { createFakeGateway, createWallet } from "@poc/credit-wallet";
import walletMigration from "../../../bricks/credit-wallet/migrations/0001_credit_wallet.sql?raw";
import walletMigration0002 from "../../../bricks/credit-wallet/migrations/0002_workspace_scoped_idempotency.sql?raw";
import walletMigration0003 from "../../../bricks/credit-wallet/migrations/0003_order_currency.sql?raw";
import walletMigration0004 from "../../../bricks/credit-wallet/migrations/0004_milli_credits.sql?raw";
import { stripeManifest } from "./support/stripe-manifest.ts";
import { createStripePaymentGateway } from "../src/stripe-payment-gateway.ts";

const db = env.DB as D1Like;

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS credit_ledger").run();
  await db.prepare("DROP TABLE IF EXISTS credit_orders").run();
  await db.prepare("DROP TABLE IF EXISTS credit_wallets").run();
  await db.prepare("DROP TABLE IF EXISTS credit_action_costs").run();
  await applyMigration(db, walletMigration);
  await applyMigration(db, walletMigration0002);
  await applyMigration(db, walletMigration0003);
  await applyMigration(db, walletMigration0004);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("UC3.9 — Typed gateway adapter pattern: credit-wallet PaymentGateway over callOperation", () => {
  it("createOrder calls createPaymentIntent with form body, idempotency header, and returns client_secret", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: string | undefined;

    const recordingFetcher = async (input: Request | string | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      capturedMethod = init?.method ?? "GET";
      const headers = init?.headers;
      if (headers) {
        if (headers instanceof Headers) {
          headers.forEach((v, k) => {
            capturedHeaders[k.toLowerCase()] = v;
          });
        } else if (Array.isArray(headers)) {
          for (const [k, v] of headers) capturedHeaders[k.toLowerCase()] = v;
        } else {
          for (const [k, v] of Object.entries(headers)) capturedHeaders[k.toLowerCase()] = String(v);
        }
      }
      capturedBody = typeof init?.body === "string" ? init.body : undefined;

      return new Response(
        JSON.stringify({
          id: "pi_order_o1",
          client_secret: "pi_sec_o1_secret_token",
          status: "requires_payment_method",
          amount: 500,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const gateway = createStripePaymentGateway({
      manifest: stripeManifest,
      connection: { apiKey: "sk_test_fake_stripe_key" },
      fetcher: recordingFetcher,
    });

    const result = await gateway.createOrder({
      orderId: "o1",
      amountMinor: 500,
      currency: "USD",
      customerId: "c1",
    });

    expect(capturedUrl).toBe("https://api.stripe.com/v1/payment_intents");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders["idempotency-key"]).toBe("order:o1");
    expect(capturedHeaders["content-type"]).toBe("application/x-www-form-urlencoded");

    // Form body: amount=500&currency=usd&metadata[order_id]=o1&metadata[customer_id]=c1
    const formParams = new URLSearchParams(capturedBody);
    expect(formParams.get("amount")).toBe("500");
    expect(formParams.get("currency")).toBe("usd");
    expect(formParams.get("metadata[order_id]")).toBe("o1");
    expect(formParams.get("metadata[customer_id]")).toBe("c1");
    // Story 2.3: the brick's user id is not a Stripe customer (cus_...), so it is never sent as `customer`.
    expect(formParams.get("customer")).toBeNull();

    // The intent id is the provider reference the brick stores and fetches by.
    expect(result).toEqual({
      paymentSessionId: "pi_sec_o1_secret_token",
      orderId: "o1",
      providerRef: "pi_order_o1",
    });
  });

  it("fetchOrder maps status:'succeeded' -> 'PAID' and leaves other statuses unchanged", async () => {
    let currentStatus = "succeeded";

    const recordingFetcher = async (input: Request | string | URL) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(u).toBe("https://api.stripe.com/v1/payment_intents/pi_o1");

      return new Response(
        JSON.stringify({
          id: "pi_o1",
          status: currentStatus,
          amount: 500,
          currency: "usd",
          metadata: { order_id: "o1", customer_id: "c1" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const gateway = createStripePaymentGateway({
      manifest: stripeManifest,
      connection: { apiKey: "sk_test_fake_stripe_key" },
      fetcher: recordingFetcher,
    });

    // Case 1: succeeded -> PAID
    currentStatus = "succeeded";
    const paidOrder = await gateway.fetchOrder("o1", "pi_o1");
    expect(paidOrder).toEqual({
      orderId: "o1",
      status: "PAID",
      amountMinor: 500,
      currency: "USD",
      customerId: "c1",
    });

    // Case 2: requires_payment_method passes through
    currentStatus = "requires_payment_method";
    const pendingOrder = await gateway.fetchOrder("o1", "pi_o1");
    expect(pendingOrder).toEqual({
      orderId: "o1",
      status: "requires_payment_method",
      amountMinor: 500,
      currency: "USD",
      customerId: "c1",
    });

    // Case 3: processing passes through
    currentStatus = "processing";
    const processingOrder = await gateway.fetchOrder("o1", "pi_o1");
    expect(processingOrder).toEqual({
      orderId: "o1",
      status: "processing",
      amountMinor: 500,
      currency: "USD",
      customerId: "c1",
    });
  });

  it("provider error surfaces as IntegrationCallError with providerCode", async () => {
    const errorFetcher = async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "card_declined",
            message: "Your card was declined",
            type: "card_error",
          },
        }),
        {
          status: 402,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const gateway = createStripePaymentGateway({
      manifest: stripeManifest,
      connection: { apiKey: "sk_test_fake_stripe_key" },
      fetcher: errorFetcher,
    });

    let caughtError: unknown;
    try {
      await gateway.createOrder({
        orderId: "o_fail",
        amountMinor: 100,
        currency: "USD",
        customerId: "c_fail",
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(IntegrationCallError);
    const callErr = caughtError as IntegrationCallError;
    expect(callErr.providerCode).toBe("card_declined");
  });



  it("AC3 — Wallet behaviour tests pass against both the fake gateway and the adapter backed by recorded Stripe fixtures", async () => {
    const WS_FAKE = "ws_fake_test";
    const WS_STRIPE = "ws_stripe_test";

    // 1. Run wallet lifecycle against fake gateway
    const fakeGateway = createFakeGateway();
    const fakeWallet = createWallet(db, fakeGateway, { currency: "USD" });

    await fakeWallet.openWallet(WS_FAKE, 0);
    const fakeOrder = await fakeWallet.createOrder({
      workspaceId: WS_FAKE,
      userId: "usr_fake_payer",
      amount: 250,
    });
    expect(fakeOrder.orderId).toBeDefined();

    fakeGateway.setOrder(fakeOrder.orderId, { status: "PAID" });
    const fakeConf = await fakeWallet.confirmOrder(fakeOrder.orderId);
    expect(fakeConf.status).toBe("PAID");
    expect(fakeConf.credited).toBe(true);
    expect(await fakeWallet.getBalanceMilli(WS_FAKE)).toBe(250_000);

    // Duplicate confirmation does not credit again
    const fakeDup = await fakeWallet.confirmOrder(fakeOrder.orderId);
    expect(fakeDup.status).toBe("already_processed");
    expect(fakeDup.credited).toBe(false);
    expect(await fakeWallet.getBalanceMilli(WS_FAKE)).toBe(250_000);

    // 2. Run identical wallet lifecycle against Stripe adapter backed by recorded fixtures
    const orderStore = new Map<string, { orderId: string; status: string; amount: number; secret: string; currency: string; customerId: string }>();

    const stripeRecordingFetcher = async (input: Request | string | URL, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method ?? "GET";

      if (u.pathname === "/v1/payment_intents" && method === "POST") {
        const params = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        const orderId = params.get("metadata[order_id]") ?? "unknown";
        const amount = Number(params.get("amount") ?? "0");
        const secret = `sec_${orderId}_live`;
        orderStore.set(`pi_${orderId}`, { orderId, status: "succeeded", amount, secret, currency: params.get("currency") ?? "", customerId: params.get("metadata[customer_id]") ?? "" });

        return new Response(
          JSON.stringify({
            id: `pi_${orderId}`,
            client_secret: secret,
            status: "requires_payment_method",
            amount,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (u.pathname.startsWith("/v1/payment_intents/") && method === "GET") {
        const intentId = u.pathname.replace("/v1/payment_intents/", "");
        const entry = orderStore.get(intentId);
        if (!entry) {
          return new Response(JSON.stringify({ error: { code: "resource_missing" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            id: intentId,
            status: entry.status,
            amount: entry.amount,
            currency: entry.currency,
            metadata: { order_id: entry.orderId, customer_id: entry.customerId },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    };

    const stripeGateway = createStripePaymentGateway({
      manifest: stripeManifest,
      connection: { apiKey: "sk_test_fake" },
      fetcher: stripeRecordingFetcher,
    });

    const stripeWallet = createWallet(db, stripeGateway, { currency: "USD" });
    await stripeWallet.openWallet(WS_STRIPE, 0);

    const stripeOrder = await stripeWallet.createOrder({
      workspaceId: WS_STRIPE,
      userId: "usr_stripe_payer",
      amount: 250,
    });
    expect(stripeOrder.orderId).toBeDefined();
    expect(stripeOrder.paymentSessionId).toBe(`sec_${stripeOrder.orderId}_live`);

    // Confirm order -> adapter fetchOrder returns status:'succeeded' -> 'PAID'
    const stripeConf = await stripeWallet.confirmOrder(stripeOrder.orderId);
    expect(stripeConf.status).toBe("PAID");
    expect(stripeConf.credited).toBe(true);
    expect(await stripeWallet.getBalanceMilli(WS_STRIPE)).toBe(250_000);

    // Duplicate confirmation does not credit again
    const stripeDup = await stripeWallet.confirmOrder(stripeOrder.orderId);
    expect(stripeDup.status).toBe("already_processed");
    expect(stripeDup.credited).toBe(false);
    expect(await stripeWallet.getBalanceMilli(WS_STRIPE)).toBe(250_000);
  });
});

describe("story 0.9 (A21): no order is recorded unless Stripe created one", () => {
  const WS = "ws_stripe_error";
  const orderCount = async () =>
    (await db.prepare("SELECT COUNT(*) AS n FROM credit_orders WHERE workspace_id = ?").bind(WS).first<{ n: number }>())?.n;

  it("STRIPE_ERROR: a non-2xx answer fails createOrder and the wallet records no order", async () => {
    const gateway = createStripePaymentGateway({
      manifest: stripeManifest,
      connection: { apiKey: "sk_test_fake_stripe_key" },
      fetcher: async () =>
        new Response(JSON.stringify({ error: { code: "api_error", message: "boom", type: "api_error" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    });
    const wallet = createWallet(db, gateway, { currency: "USD" });
    await wallet.openWallet(WS, 0);
    await expect(wallet.createOrder({ workspaceId: WS, userId: "usr_x", amount: 100 })).rejects.toBeInstanceOf(IntegrationCallError);
    expect(await orderCount()).toBe(0);
  });

  it("STRIPE_ERROR: a 2xx answer with no intent id or client secret is a PROVIDER_ERROR, not an empty session", async () => {
    const gateway = createStripePaymentGateway({
      manifest: stripeManifest,
      connection: { apiKey: "sk_test_fake_stripe_key" },
      fetcher: async () => new Response(JSON.stringify({ status: "requires_payment_method" }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    let caught: unknown;
    try {
      await gateway.createOrder({ orderId: "o_empty", amountMinor: 100, currency: "USD", customerId: "c_1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IntegrationCallError);
    expect((caught as IntegrationCallError).code).toBe("PROVIDER_ERROR");

    const wallet = createWallet(db, gateway, { currency: "USD" });
    await wallet.openWallet(WS, 0);
    await expect(wallet.createOrder({ workspaceId: WS, userId: "usr_x", amount: 100 })).rejects.toThrow(/PROVIDER_ERROR/);
    expect(await orderCount()).toBe(0);
  });
});

describe("story 2.3: Stripe-Signature webhook verification", () => {
  const SECRET = "whsec_unit_test_only";
  const NOW = Date.parse("2026-11-25T10:00:00Z");
  const gateway = createStripePaymentGateway({ manifest: stripeManifest, connection: { apiKey: "sk_test_x" }, fetcher: async () => new Response("{}"), webhookSecret: SECRET, now: () => NOW });
  const event = (type: string) => JSON.stringify({ id: "evt_1", type, data: { object: { id: "pi_1", metadata: { order_id: "order_abc" } } } });
  const sign = async (body: string, t: number, secret = SECRET) => {
    const { hmacSha256, toHex } = await import("../src/webhook-signature.ts");
    return new Headers({ "stripe-signature": `t=${t},v1=${toHex(await hmacSha256(secret, `${t}.${body}`))}` });
  };
  const t = Math.floor(NOW / 1000);

  it("a payment_intent event signed with the endpoint secret names the intent's order", async () => {
    const body = event("payment_intent.succeeded");
    expect(await gateway.verifyWebhook(body, await sign(body, t))).toEqual({ kind: "order", orderId: "order_abc", providerRef: "pi_1" });
  });

  it("refuses (invalid) a forged signature, a stale or future timestamp and a missing header; ignores a signed non-payment_intent event", async () => {
    const body = event("payment_intent.succeeded");
    expect(await gateway.verifyWebhook(body, await sign(body, t, "whsec_other"))).toEqual({ kind: "invalid" });
    expect(await gateway.verifyWebhook(body, await sign(body, t - 301))).toEqual({ kind: "invalid" });
    expect(await gateway.verifyWebhook(body, await sign(body, t + 301))).toEqual({ kind: "invalid" });
    expect(await gateway.verifyWebhook(body, new Headers())).toEqual({ kind: "invalid" });
    const other = event("charge.refunded");
    expect(await gateway.verifyWebhook(other, await sign(other, t))).toEqual({ kind: "ignored" });
  });

  it("without a webhook secret, verification fails NOT_CONFIGURED instead of accepting anything", async () => {
    const unconfigured = createStripePaymentGateway({ manifest: stripeManifest, connection: { apiKey: "sk_test_x" }, fetcher: async () => new Response("{}") });
    const body = event("payment_intent.succeeded");
    await expect(unconfigured.verifyWebhook(body, await sign(body, t))).rejects.toThrow(/NOT_CONFIGURED/);
  });
});

describe("story 2.3: Stripe currencies whose convention differs from ISO 4217 are refused", () => {
  it.each(["HUF", "TWD", "ISK", "UGX", "MGA"])("%s fails NOT_SUPPORTED before any request", async (currency) => {
    let called = false;
    const gateway = createStripePaymentGateway({ manifest: stripeManifest, connection: { apiKey: "sk_test_x" }, fetcher: async () => ((called = true), new Response("{}")) });
    await expect(gateway.createOrder({ orderId: "o1", amountMinor: 100, currency, customerId: "c1" })).rejects.toThrow(/^NOT_SUPPORTED/);
    expect(called).toBe(false);
  });

  it("fetchOrder without a stored intent id fails (it never looks an intent up by the brick's order id)", async () => {
    let called = false;
    const gateway = createStripePaymentGateway({ manifest: stripeManifest, connection: { apiKey: "sk_test_x" }, fetcher: async () => ((called = true), new Response("{}")) });
    await expect(gateway.fetchOrder("order_1", undefined)).rejects.toThrow(/PROVIDER_ERROR/);
    expect(called).toBe(false);
  });
});
