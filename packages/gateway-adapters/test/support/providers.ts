// Test-only stand-ins for the payment providers, reached through each adapter's injected fetch. Nothing here calls
// Cashfree or Stripe. The Cashfree responses are built from the documented samples in ../fixtures/cashfree (see the
// README there: documented shapes, not live recordings).
import { createFakeGateway } from "@poc/credit-wallet";
import type { GatewayOrder, PaymentGateway } from "@poc/sdk";
import { createCashfreePaymentGateway } from "../../src/cashfree-payment-gateway.ts";
import { createStripePaymentGateway } from "../../src/stripe-payment-gateway.ts";
import { hmacSha256, toBase64, toHex } from "../../src/webhook-signature.ts";
import createOrderFixture from "../fixtures/cashfree/create-order.response.json";
import fetchOrderFixture from "../fixtures/cashfree/fetch-order.paid.json";
import webhookFixture from "../fixtures/cashfree/webhook.payment-success.json";
import { stripeManifest } from "./stripe-manifest.ts";

/** The provider-side fields a test may tamper with, in the wallet's terms. */
export type TamperField = "orderId" | "amount" | "currency" | "customerId" | "amountTimes100" | "amountOver100";

export interface TestProvider {
  name: "fake" | "cashfree" | "stripe";
  gateway: PaymentGateway;
  /** The provider now reports the order as paid. */
  markPaid(orderId: string): void | Promise<void>;
  /** The provider now reports a different value for one field of the order. */
  tamper(orderId: string, field: TamperField): void | Promise<void>;
  /** A webhook for the order, signed the way this provider signs. */
  signedWebhook(orderId: string): Promise<{ body: string; headers: Headers }>;
  /** The same webhook with a signature made with the wrong key. */
  forgedWebhook(orderId: string): Promise<{ body: string; headers: Headers }>;
  /** Makes the provider answer every request with HTTP 503. */
  goDown(): void;
}

export const NOW = Date.parse("2026-11-25T10:00:00Z");
export const CASHFREE_SECRET = "cfsk_test_only_not_a_real_secret";
export const STRIPE_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface StoredOrder {
  orderId: string;
  status: string;
  amount: number | string;
  currency: string;
  customerId: string;
}

const tampered = (order: StoredOrder, field: TamperField): StoredOrder => {
  switch (field) {
    case "orderId":
      return { ...order, orderId: `${order.orderId}_other` };
    case "amount":
      return { ...order, amount: typeof order.amount === "number" ? order.amount + 1 : order.amount };
    // The unit bugs: a provider amount a hundred times too big or too small (major read as minor, or the reverse).
    case "amountTimes100":
      return { ...order, amount: Number(order.amount) * 100 };
    case "amountOver100":
      return { ...order, amount: Number(order.amount) / 100 };
    case "currency":
      return { ...order, currency: order.currency.toUpperCase() === "USD" ? "EUR" : "USD" };
    case "customerId":
      return { ...order, customerId: `${order.customerId}-intruder` };
  }
};

export function fakeProvider(): TestProvider {
  const fake = createFakeGateway();
  let down = false;
  const gateway: PaymentGateway = {
    createOrder: (input) => fake.createOrder(input),
    fetchOrder: async (orderId, providerRef) => {
      if (down) throw new Error("gateway unavailable");
      return fake.fetchOrder(orderId, providerRef);
    },
    verifyWebhook: (rawBody, headers) => fake.verifyWebhook(rawBody, headers),
  };
  return {
    name: "fake",
    gateway,
    markPaid: (orderId) => fake.setOrder(orderId, { status: "PAID" }),
    tamper: async (orderId: string, field: TamperField) => {
      const current = await fake.fetchOrder(orderId, undefined);
      const changed = tampered({ ...current, amount: current.amountMinor }, field);
      fake.setOrder(orderId, {
        orderId: changed.orderId,
        amountMinor: Number(changed.amount),
        currency: changed.currency,
        customerId: changed.customerId,
      } satisfies Partial<GatewayOrder>);
    },
    signedWebhook: (orderId) => fake.signWebhook(orderId),
    forgedWebhook: async (orderId) => createFakeGateway().signWebhook(orderId),
    goDown: () => {
      down = true;
    },
  };
}

/** The Cashfree PG API as the adapter sees it: POST /pg/orders and GET /pg/orders/{id} on the sandbox host. */
export function cashfreeProvider() {
  const orders = new Map<string, StoredOrder>();
  const requests: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];
  let down = false;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    const method = init?.method ?? "GET";
    requests.push({ url, method, headers, body });
    if (down) return json({ message: "service unavailable", code: "internal_error", type: "api_error" }, 503);
    const u = new URL(url);
    if (u.hostname !== "sandbox.cashfree.com") return json({ message: "wrong host" }, 404);
    if (u.pathname === "/pg/orders" && method === "POST") {
      const sent = JSON.parse(body ?? "{}") as { order_id: string; order_amount: number; order_currency: string; customer_details: { customer_id: string } };
      orders.set(sent.order_id, {
        orderId: sent.order_id,
        status: "ACTIVE",
        amount: sent.order_amount,
        currency: sent.order_currency,
        customerId: sent.customer_details.customer_id,
      });
      return json({
        ...createOrderFixture,
        order_id: sent.order_id,
        order_amount: sent.order_amount,
        order_currency: sent.order_currency,
        customer_details: { ...createOrderFixture.customer_details, ...sent.customer_details },
      });
    }
    const match = /^\/pg\/orders\/([^/]+)$/.exec(u.pathname);
    if (match && method === "GET") {
      const order = orders.get(decodeURIComponent(match[1]!));
      if (!order) return json({ message: "order not found", code: "order_not_found", type: "invalid_request_error" }, 404);
      return json({
        ...fetchOrderFixture,
        order_id: order.orderId,
        order_status: order.status,
        order_amount: order.amount,
        order_currency: order.currency,
        customer_details: { ...fetchOrderFixture.customer_details, customer_id: order.customerId },
      });
    }
    return json({ message: "not found" }, 404);
  };
  const gateway = createCashfreePaymentGateway({
    environment: "sandbox",
    clientId: "cf_test_client_id",
    clientSecret: CASHFREE_SECRET,
    apiVersion: "2023-08-01",
    customerDetails: () => ({ customer_phone: "9999999999" }),
    notifyUrl: "https://app.example.com/api/payments/webhook",
    fetch: fetchImpl,
    resolveHost: null,
    now: () => NOW,
  });
  const sign = async (orderId: string, secret: string) => {
    const body = JSON.stringify({ ...webhookFixture, data: { ...webhookFixture.data, order: { ...webhookFixture.data.order, order_id: orderId } } });
    const timestamp = String(NOW);
    const signature = toBase64(await hmacSha256(secret, timestamp + body));
    return {
      body,
      headers: new Headers({
        "content-type": "application/json",
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signature,
        "x-webhook-version": "2023-08-01",
      }),
    };
  };
  const provider: TestProvider & { orders: typeof orders; requests: typeof requests; setRaw(orderId: string, patch: Partial<StoredOrder>): void } = {
    name: "cashfree",
    gateway,
    orders,
    requests,
    markPaid: (orderId) => {
      orders.set(orderId, { ...orders.get(orderId)!, status: "PAID" });
    },
    tamper: (orderId, field) => {
      orders.set(orderId, tampered(orders.get(orderId)!, field));
    },
    setRaw: (orderId, patch) => {
      orders.set(orderId, { ...orders.get(orderId)!, ...patch });
    },
    signedWebhook: (orderId) => sign(orderId, CASHFREE_SECRET),
    forgedWebhook: (orderId) => sign(orderId, "not-the-client-secret"),
    goDown: () => {
      down = true;
    },
  };
  return provider;
}

/**
 * Stripe's payment intents as the adapter's integration manifest reaches them. Like real Stripe, an intent is keyed by
 * its own random `pi_...` id: a lookup by the wallet's order id is a 404. A `customer` that is not a `cus_...` id is
 * refused with 400, as Stripe refuses it.
 */
export function stripeProvider(): TestProvider & { sentAmounts: number[] } {
  const intents = new Map<string, StoredOrder>();
  const intentOf = new Map<string, string>(); // test helpers address an order by the wallet's id
  const orders = {
    get: (orderId: string) => intents.get(intentOf.get(orderId) ?? ""),
    set: (orderId: string, order: StoredOrder) => intents.set(intentOf.get(orderId)!, order),
  };
  const sentAmounts: number[] = [];
  let down = false;
  const fetcher = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    if (down) return json({ error: { code: "api_error", message: "down", type: "api_error" } }, 503);
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    if (u.pathname === "/v1/payment_intents" && method === "POST") {
      const params = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      const orderId = params.get("metadata[order_id]") ?? "";
      const customer = params.get("customer");
      if (customer !== null && !customer.startsWith("cus_"))
        return json({ error: { code: "resource_missing", message: "No such customer", type: "invalid_request_error" } }, 400);
      sentAmounts.push(Number(params.get("amount")));
      const intentId = `pi_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
      intentOf.set(orderId, intentId);
      intents.set(intentId, {
        orderId,
        status: "requires_payment_method",
        amount: Number(params.get("amount")),
        currency: params.get("currency") ?? "",
        customerId: params.get("metadata[customer_id]") ?? "",
      });
      return json({ id: intentId, client_secret: `${intentId}_secret_x`, status: "requires_payment_method", amount: Number(params.get("amount")) });
    }
    if (u.pathname.startsWith("/v1/payment_intents/") && method === "GET") {
      const id = decodeURIComponent(u.pathname.slice("/v1/payment_intents/".length));
      const order = intents.get(id);
      if (!order) return json({ error: { code: "resource_missing", message: "no such intent", type: "invalid_request_error" } }, 404);
      return json({
        id,
        object: "payment_intent",
        status: order.status,
        amount: order.amount,
        currency: order.currency,
        metadata: { order_id: order.orderId, customer_id: order.customerId },
      });
    }
    return json({ error: { code: "not_found" } }, 404);
  };
  const gateway = createStripePaymentGateway({
    manifest: stripeManifest,
    connection: { apiKey: "sk_test_fake_stripe_key" },
    fetcher,
    webhookSecret: STRIPE_WEBHOOK_SECRET,
    now: () => NOW,
  });
  const sign = async (orderId: string, secret: string) => {
    const body = JSON.stringify({
      id: "evt_test",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: { id: intentOf.get(orderId) ?? "pi_unknown", object: "payment_intent", metadata: { order_id: orderId } } },
    });
    const t = String(Math.floor(NOW / 1000));
    const v1 = toHex(await hmacSha256(secret, `${t}.${body}`));
    return { body, headers: new Headers({ "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` }) };
  };
  return {
    name: "stripe",
    sentAmounts,
    gateway,
    markPaid: (orderId) => {
      orders.set(orderId, { ...orders.get(orderId)!, status: "succeeded" });
    },
    tamper: (orderId, field) => {
      orders.set(orderId, tampered(orders.get(orderId)!, field));
    },
    signedWebhook: (orderId) => sign(orderId, STRIPE_WEBHOOK_SECRET),
    forgedWebhook: (orderId) => sign(orderId, "whsec_wrong"),
    goDown: () => {
      down = true;
    },
  };
}
