import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { IntegrationCallError } from "@poc/runtime";
import { applyMigration, type D1Like } from "@poc/sdk";
import { createFakeGateway, createWallet } from "@poc/credit-wallet";
import type { IntegrationManifestFile } from "@poc/assembler";
import { createStripePaymentGateway } from "../src/stripe-payment-gateway.ts";

const db = env.DB as D1Like;

// Minimal valid stripe manifest fixture matching Stripe pack createPaymentIntent & getPaymentIntent
const stripeManifest: IntegrationManifestFile = {
  manifestVersion: 2,
  kind: "integration",
  app: "stripe",
  version: "1.0.0",
  baseUrl: "https://api.stripe.com",
  allowedHosts: ["api.stripe.com"],
  auth: {
    type: "apiKey",
    headerName: "Authorization",
    prefix: "Bearer",
  },
  ui: {
    displayName: "Stripe",
    category: "billing",
    summary: "Stripe payment integration",
    maturity: "beta",
    maturityReason: "Stripe payment gateway adapter verification",
  },
  fidelity: {
    specHash: `sha256:${"0".repeat(64)}`,
    importerVersion: "2.0.0",
    level: "curated",
    unsupported: [],
  },
  operations: [
    {
      operationId: "createPaymentIntent",
      label: "Create payment intent",
      summary: "Create payment intent",
      method: "POST",
      path: "/v1/payment_intents",
      body: {
        contentType: "application/x-www-form-urlencoded",
        fields: [
          { name: "amount", dataType: "number", required: true },
          { name: "currency", dataType: "string", required: true },
          { name: "customer", dataType: "string" },
          { name: "metadata", dataType: "object" },
        ],
      },
      response: {
        status: 200,
        outputs: [
          { id: "id", dataType: "string" },
          { id: "client_secret", dataType: "string" },
          { id: "status", dataType: "string" },
          { id: "amount", dataType: "number" },
        ],
        errorShape: {
          codePath: "error.code",
          messagePath: "error.message",
          typePath: "error.type",
        },
      },
      idempotency: {
        header: "Idempotency-Key",
      },
      sideEffects: "write",
    },
    {
      operationId: "getPaymentIntent",
      label: "Retrieve payment intent",
      summary: "Retrieve payment intent",
      method: "GET",
      path: "/v1/payment_intents/{intentId}",
      params: [
        { name: "intentId", in: "path", dataType: "string", required: true },
      ],
      response: {
        status: 200,
        outputs: [
          { id: "id", dataType: "string" },
          { id: "status", dataType: "string" },
          { id: "amount", dataType: "number" },
        ],
        errorShape: {
          codePath: "error.code",
          messagePath: "error.message",
          typePath: "error.type",
        },
      },
      sideEffects: "read",
    },
  ],
};

const walletMigration = `
CREATE TABLE IF NOT EXISTS credit_wallets (
  workspace_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)
);

CREATE TABLE IF NOT EXISTS credit_orders (
  order_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL,
  metadata TEXT,
  idempotency_key TEXT UNIQUE
);
`;

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS credit_ledger").run();
  await db.prepare("DROP TABLE IF EXISTS credit_orders").run();
  await db.prepare("DROP TABLE IF EXISTS credit_wallets").run();
  await applyMigration(db, walletMigration);
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
      currency: "usd",
    });

    const result = await gateway.createOrder({
      orderId: "o1",
      amount: 500,
      customerId: "c1",
    });

    expect(capturedUrl).toBe("https://api.stripe.com/v1/payment_intents");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders["idempotency-key"]).toBe("wallet:o1");
    expect(capturedHeaders["content-type"]).toBe("application/x-www-form-urlencoded");

    // Form body: amount=500&currency=usd&metadata[order_id]=o1&metadata[customer_id]=c1
    const formParams = new URLSearchParams(capturedBody);
    expect(formParams.get("amount")).toBe("500");
    expect(formParams.get("currency")).toBe("usd");
    expect(formParams.get("metadata[order_id]")).toBe("o1");
    expect(formParams.get("metadata[customer_id]")).toBe("c1");

    expect(result).toEqual({
      paymentSessionId: "pi_sec_o1_secret_token",
      orderId: "o1",
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
      currency: "usd",
    });

    // Case 1: succeeded -> PAID
    currentStatus = "succeeded";
    const paidOrder = await gateway.fetchOrder("pi_o1");
    expect(paidOrder).toEqual({
      status: "PAID",
      amount: 500,
    });

    // Case 2: requires_payment_method passes through
    currentStatus = "requires_payment_method";
    const pendingOrder = await gateway.fetchOrder("pi_o1");
    expect(pendingOrder).toEqual({
      status: "requires_payment_method",
      amount: 500,
    });

    // Case 3: processing passes through
    currentStatus = "processing";
    const processingOrder = await gateway.fetchOrder("pi_o1");
    expect(processingOrder).toEqual({
      status: "processing",
      amount: 500,
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
      currency: "usd",
    });

    let caughtError: unknown;
    try {
      await gateway.createOrder({
        orderId: "o_fail",
        amount: 100,
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
    const fakeWallet = createWallet(db, fakeGateway);

    await fakeWallet.openWallet(WS_FAKE, 0);
    const fakeOrder = await fakeWallet.createOrder({
      workspaceId: WS_FAKE,
      userId: "usr_fake_payer",
      amount: 250,
    });
    expect(fakeOrder.orderId).toBeDefined();

    fakeGateway.setOrder(fakeOrder.orderId, { status: "PAID", amount: 250 });
    const fakeConf = await fakeWallet.confirmOrder(fakeOrder.orderId);
    expect(fakeConf.status).toBe("PAID");
    expect(fakeConf.credited).toBe(true);
    expect(await fakeWallet.getBalance(WS_FAKE)).toBe(250);

    // Duplicate confirmation does not credit again
    const fakeDup = await fakeWallet.confirmOrder(fakeOrder.orderId);
    expect(fakeDup.status).toBe("already_processed");
    expect(fakeDup.credited).toBe(false);
    expect(await fakeWallet.getBalance(WS_FAKE)).toBe(250);

    // 2. Run identical wallet lifecycle against Stripe adapter backed by recorded fixtures
    const orderStore = new Map<string, { status: string; amount: number; secret: string }>();

    const stripeRecordingFetcher = async (input: Request | string | URL, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const method = init?.method ?? "GET";

      if (u.pathname === "/v1/payment_intents" && method === "POST") {
        const params = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        const orderId = params.get("metadata[order_id]") ?? "unknown";
        const amount = Number(params.get("amount") ?? "0");
        const secret = `sec_${orderId}_live`;
        orderStore.set(orderId, { status: "succeeded", amount, secret });

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
      currency: "usd",
    });

    const stripeWallet = createWallet(db, stripeGateway);
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
    expect(await stripeWallet.getBalance(WS_STRIPE)).toBe(250);

    // Duplicate confirmation does not credit again
    const stripeDup = await stripeWallet.confirmOrder(stripeOrder.orderId);
    expect(stripeDup.status).toBe("already_processed");
    expect(stripeDup.credited).toBe(false);
    expect(await stripeWallet.getBalance(WS_STRIPE)).toBe(250);
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
    const wallet = createWallet(db, gateway);
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
      await gateway.createOrder({ orderId: "o_empty", amount: 100, customerId: "c_1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IntegrationCallError);
    expect((caught as IntegrationCallError).code).toBe("PROVIDER_ERROR");

    const wallet = createWallet(db, gateway);
    await wallet.openWallet(WS, 0);
    await expect(wallet.createOrder({ workspaceId: WS, userId: "usr_x", amount: 100 })).rejects.toThrow(/PROVIDER_ERROR/);
    expect(await orderCount()).toBe(0);
  });
});
