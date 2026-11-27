import type { IntegrationManifestFile } from "@poc/assembler";
import type { GatewayOrder, PaymentGateway, WebhookVerification } from "@poc/credit-wallet";
import { NotConfiguredError } from "@poc/sdk";
import { IntegrationCallError, callOperation, type IntegrationFetcher } from "@poc/runtime";
import { WEBHOOK_TOLERANCE_MS, constantTimeEqual, hmacSha256, toHex } from "./webhook-signature.ts";

export interface StripePaymentGatewayOptions {
  manifest: IntegrationManifestFile;
  connection?: Record<string, unknown> | null;
  fetcher: IntegrationFetcher;
  /**
   * Story 2.3: the endpoint's signing secret (`whsec_...`). Required when webhooks are used: without it
   * `verifyWebhook` fails NOT_CONFIGURED instead of accepting anything.
   */
  webhookSecret?: string;
  /** The clock used for the webhook timestamp window. Tests inject one. */
  now?: () => number;
}

/**
 * Currencies whose Stripe amount convention differs from ISO 4217's minor unit (Stripe treats them specially: whole
 * units sent with two zero decimals, or amounts that must be divisible by 100). The interface's `amountMinor` cannot be
 * passed through for them, so they are refused rather than charged a wrong amount.
 */
export const STRIPE_UNSUPPORTED_CURRENCIES: readonly string[] = Object.freeze(["HUF", "ISK", "MGA", "TWD", "UGX"]);

/** Thrown for a currency this adapter refuses (see `STRIPE_UNSUPPORTED_CURRENCIES`). */
export class GatewayNotSupportedError extends Error {
  readonly code = "NOT_SUPPORTED" as const;
  constructor(message: string) {
    super(`NOT_SUPPORTED: ${message}`);
    this.name = "GatewayNotSupportedError";
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function createStripePaymentGateway(options: StripePaymentGatewayOptions): PaymentGateway {
  const { manifest, connection = null, fetcher, webhookSecret } = options;
  const now = options.now ?? (() => Date.now());

  return {
    async createOrder(input: {
      orderId: string;
      amountMinor: number;
      currency: string;
      customerId: string;
    }): Promise<{ paymentSessionId: string; orderId: string; providerRef: string }> {
      if (STRIPE_UNSUPPORTED_CURRENCIES.includes(input.currency.toUpperCase())) {
        throw new GatewayNotSupportedError(`Stripe's amount convention for ${input.currency.toUpperCase()} differs from ISO 4217; no order was created`);
      }
      const res = await callOperation(
        manifest,
        "createPaymentIntent",
        {
          // The interface's minor units are Stripe's own smallest-unit amount: passed through unchanged.
          amount: input.amountMinor,
          // Story 2.3: the brick's own currency; the adapter has none of its own. Stripe takes it in lower case.
          currency: input.currency.toLowerCase(),
          // The brick's user id is not a Stripe customer (`cus_...`), so it travels only in metadata, where
          // fetchOrder reads it back for the brick's customer check.
          metadata: {
            order_id: input.orderId,
            customer_id: input.customerId,
          },
          "metadata[order_id]": input.orderId,
          "metadata[customer_id]": input.customerId,
        },
        {
          connection,
          fetcher,
          idempotencyKey: `order:${input.orderId}`,
        },
      );

      // Story 0.9 (A21): only a 2xx answer that names an intent counts as created. Anything else is a provider
      // error, so the brick records no order.
      if (res.status < 200 || res.status >= 300) {
        throw new IntegrationCallError(`PROVIDER_ERROR: Stripe createPaymentIntent answered HTTP ${res.status}; no order was created`, {
          code: "PROVIDER_ERROR",
          status: res.status,
        });
      }
      const body = (res.body ?? res.data ?? {}) as Record<string, unknown>;
      const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);
      // The intent id (`pi_...`) is the provider reference: the intent is fetched by it, never by the brick's order id.
      const intentId = nonEmpty(body.id);
      if (!intentId) {
        throw new IntegrationCallError("PROVIDER_ERROR: Stripe createPaymentIntent returned no payment intent id or client secret; no order was created", {
          code: "PROVIDER_ERROR",
          status: res.status,
        });
      }
      return {
        paymentSessionId: nonEmpty(body.client_secret) ?? intentId,
        orderId: input.orderId,
        providerRef: intentId,
      };
    },

    async fetchOrder(orderId: string, providerRef: string | undefined): Promise<GatewayOrder> {
      // Stripe has no lookup by the brick's order id: without the intent id there is nothing to fetch.
      if (!providerRef) {
        throw new IntegrationCallError(`PROVIDER_ERROR: no Stripe payment intent id is stored for order ${orderId}`, { code: "PROVIDER_ERROR", status: 0 });
      }
      const res = await callOperation(
        manifest,
        "getPaymentIntent",
        {
          intentId: providerRef,
        },
        {
          connection,
          fetcher,
        },
      );
      if (res.status < 200 || res.status >= 300) {
        throw new IntegrationCallError(`PROVIDER_ERROR: Stripe getPaymentIntent answered HTTP ${res.status}`, { code: "PROVIDER_ERROR", status: res.status });
      }

      const body = (res.body ?? res.data ?? {}) as Record<string, unknown>;
      const rawStatus = (body.status as string) ?? "";
      const status = rawStatus === "succeeded" ? "PAID" : rawStatus;
      const amountMinor = typeof body.amount === "number" && Number.isSafeInteger(body.amount) ? body.amount : Number.NaN;
      // Story 2.3 (A20, PROPOSED-13): the order id and customer come from the intent's own metadata, set when the
      // brick created it, so the brick can check the intent really is the order it is confirming.
      const metadata = body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {};
      return {
        orderId: text(metadata.order_id),
        status,
        amountMinor,
        currency: text(body.currency).toUpperCase(),
        customerId: text(metadata.customer_id),
      };
    },

    // The Stripe-Signature scheme: `t=<unix seconds>,v1=<hex>`, where v1 is HMAC-SHA256 of `${t}.${rawBody}` with the
    // endpoint secret, and t within five minutes of now. A payment_intent.* event names its intent's order_id; any
    // other correctly signed event is "ignored" (acknowledged, not retried).
    async verifyWebhook(rawBody: string, incoming: Headers): Promise<WebhookVerification> {
      if (typeof webhookSecret !== "string" || webhookSecret.length === 0) {
        throw new NotConfiguredError("the Stripe adapter has no webhookSecret; webhooks cannot be verified");
      }
      const signatureHeader = incoming.get("stripe-signature");
      if (!signatureHeader) return { kind: "invalid" };
      let timestamp: string | undefined;
      const candidates: string[] = [];
      for (const part of signatureHeader.split(",")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key === "t") timestamp = value;
        else if (key === "v1") candidates.push(value);
      }
      if (!timestamp || !/^\d{1,12}$/.test(timestamp) || candidates.length === 0) return { kind: "invalid" };
      if (Math.abs(now() - Number(timestamp) * 1000) > WEBHOOK_TOLERANCE_MS) return { kind: "invalid" };
      const expected = toHex(await hmacSha256(webhookSecret, `${timestamp}.${rawBody}`));
      let matched = false;
      for (const candidate of candidates) matched = constantTimeEqual(candidate, expected) || matched;
      if (!matched) return { kind: "invalid" };
      try {
        const event = JSON.parse(rawBody) as { type?: unknown; data?: { object?: { id?: unknown; metadata?: { order_id?: unknown } } } };
        if (typeof event.type !== "string" || !event.type.startsWith("payment_intent.")) return { kind: "ignored" };
        const id = event.data?.object?.metadata?.order_id;
        if (typeof id !== "string" || id.length === 0) return { kind: "ignored" };
        const intentId = event.data?.object?.id;
        return { kind: "order", orderId: id, ...(typeof intentId === "string" && intentId.length > 0 ? { providerRef: intentId } : {}) };
      } catch {
        return { kind: "ignored" };
      }
    },
  };
}
