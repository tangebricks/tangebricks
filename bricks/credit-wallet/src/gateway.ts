import type { GatewayOrder, PaymentGateway, WebhookVerification } from "@poc/sdk";

/**
 * What the wallet needs from a payment provider: create an order, fetch it, and verify a webhook's signature. The
 * shape is provider-neutral and lives in `@poc/sdk` so checkout-gateway can take the same object without importing
 * this brick. Amounts on it are minor units (`amountMinor`). A real provider is an adapter (see
 * `@poc/gateway-adapters`); the proof uses the fake below.
 */
export type { GatewayOrder, PaymentGateway, WebhookVerification };

/** A gateway whose orders and statuses the test sets directly. It makes no network call. */
export interface FakeGateway extends PaymentGateway {
  /**
   * Sets an order's fields, creating it if needed. Fields left out keep what `createOrder` recorded, so
   * `setOrder(id, { status: "PAID" })` marks a created order paid with its own id, amount (minor units), currency and
   * customer.
   */
  setOrder(orderId: string, order: Partial<GatewayOrder>): void;
  /** Makes fetchOrder fail, as a gateway outage would. */
  failFetches(failing: boolean): void;
  /** Makes createOrder fail, as a gateway outage would. */
  failCreates(failing: boolean): void;
  /**
   * Test signing helper: a webhook body and headers that this fake's `verifyWebhook` accepts. With an order id it names
   * that order; with null it is a correctly signed event about no order (which verifies as "ignored").
   */
  signWebhook(orderId: string | null): Promise<{ body: string; headers: Headers }>;
}

/** The header the fake's webhook signature travels in. */
export const FAKE_WEBHOOK_SIGNATURE_HEADER = "x-fake-signature";

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The provider reference the fake gives an order. */
const refFor = (orderId: string) => `ref_${orderId}`;

export function createFakeGateway(): FakeGateway {
  const orders = new Map<string, GatewayOrder>();
  // A per-instance signing key: a webhook signed for one fake is forged for any other. Made on first use, because a
  // Worker may create the fake at module load, where generating random values is not allowed.
  let secretValue: string | undefined;
  const secret = () => (secretValue ??= crypto.randomUUID());
  let failing = false;
  let failingCreates = false;
  return {
    async createOrder({ orderId, amountMinor, currency, customerId }) {
      if (failingCreates) throw new Error("gateway unavailable");
      orders.set(orderId, { orderId, status: "ACTIVE", amountMinor, currency, customerId });
      return { paymentSessionId: `session_${orderId}`, orderId, providerRef: refFor(orderId) };
    },
    async fetchOrder(orderId, providerRef) {
      if (failing) throw new Error("gateway unavailable");
      const order = orders.get(orderId);
      // Like a real provider, a reference that is not this order's finds nothing.
      if (!order || (providerRef !== undefined && providerRef !== refFor(orderId))) throw new Error(`gateway has no order ${orderId}`);
      return { ...order };
    },
    async verifyWebhook(rawBody, headers): Promise<WebhookVerification> {
      const signature = headers.get(FAKE_WEBHOOK_SIGNATURE_HEADER);
      if (!signature || !sameText(signature, await hmacHex(secret(), rawBody))) return { kind: "invalid" };
      try {
        const parsed = JSON.parse(rawBody) as { order_id?: unknown };
        return typeof parsed.order_id === "string" && parsed.order_id.length > 0
          ? { kind: "order", orderId: parsed.order_id, providerRef: refFor(parsed.order_id) }
          : { kind: "ignored" };
      } catch {
        return { kind: "ignored" };
      }
    },
    async signWebhook(orderId) {
      const body = JSON.stringify(orderId === null ? { event: "something_else" } : { order_id: orderId });
      return { body, headers: new Headers({ "content-type": "application/json", [FAKE_WEBHOOK_SIGNATURE_HEADER]: await hmacHex(secret(), body) }) };
    },
    setOrder(orderId, order) {
      const existing = orders.get(orderId) ?? { orderId, status: "ACTIVE", amountMinor: 0, currency: "", customerId: "" };
      orders.set(orderId, { ...existing, ...order });
    },
    failFetches(value) {
      failing = value;
    },
    failCreates(value) {
      failingCreates = value;
    },
  };
}
