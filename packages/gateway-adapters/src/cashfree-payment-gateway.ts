import { NotConfiguredError, createPublicUrlFetch, isPaymentCurrency, minorUnitExponent } from "@poc/sdk";
import type { BaseFetcher, GatewayOrder, HostResolver, PaymentGateway, WebhookVerification } from "@poc/sdk";
import { WEBHOOK_TOLERANCE_MS, constantTimeEqual, hmacSha256, toBase64 } from "./webhook-signature.ts";

/**
 * Cashfree Payment Gateway (PG API) behind the provider-neutral `PaymentGateway` (story 2.3).
 *
 * Every option is required and none has a default: the environment, the keys, the API version and how to find a
 * customer's phone number (Cashfree refuses an order without one) all come from the host. Requests go through the
 * SDK's public-URL egress guard. Errors carry a code and an HTTP status, never a key or the provider's own text.
 */
export interface CashfreePaymentGatewayOptions {
  /** "sandbox" (https://sandbox.cashfree.com/pg) or "production" (https://api.cashfree.com/pg). */
  environment: "sandbox" | "production";
  /** The `x-client-id` (App ID). From a secret. */
  clientId: string;
  /** The `x-client-secret`. From a secret. It also signs Cashfree's webhooks. */
  clientSecret: string;
  /** The `x-api-version` the responses are shaped by, e.g. "2023-08-01". */
  apiVersion: string;
  /** The contact details Cashfree requires for an order's customer. `customer_id` is always the wallet's own. */
  customerDetails: (customerId: string) => CashfreeCustomerDetails | Promise<CashfreeCustomerDetails>;
  /**
   * Required. The https URL Cashfree notifies about this adapter's orders (sent as `order_meta.notify_url` on every
   * order). Build one adapter per brick, each with that brick's own webhook URL, so a checkout session's payment is
   * never delivered to the wallet's webhook (where it would be acknowledged and dropped), or the reverse.
   */
  notifyUrl: string;
  /** The fetch the egress guard wraps. Tests inject one; a Worker passes nothing and gets the platform's fetch. */
  fetch?: BaseFetcher;
  /** Host resolution for the egress guard. Tests pass `null` (no DNS) to stay offline. */
  resolveHost?: HostResolver | null;
  /** The clock used for the webhook timestamp window. Tests inject one. */
  now?: () => number;
}

export interface CashfreeCustomerDetails {
  customer_phone: string;
  customer_email?: string;
  customer_name?: string;
}

const BASE_URLS = {
  sandbox: "https://sandbox.cashfree.com/pg",
  production: "https://api.cashfree.com/pg",
} as const;

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** A provider failure with no provider text and no secret in it. */
function providerError(text: string, status?: number): NotConfiguredError {
  const error = new NotConfiguredError(`Cashfree ${text}${status !== undefined ? ` (HTTP ${status})` : ""}`, "PROVIDER_ERROR");
  if (status !== undefined) Object.assign(error, { status });
  return error;
}

/**
 * The interface carries minor units (paise); Cashfree's `order_amount` is a decimal in the major unit (rupees). This
 * writes the exact decimal with the currency's own number of places: 12345 paise is "123.45", 50000 is "500.00", and
 * 500 yen is "500". No floating-point arithmetic is involved.
 */
export function minorToDecimal(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError("an amount must be a whole, non-negative number of minor units");
  const places = minorUnitExponent(currency);
  if (places === 0) return String(minor);
  const digits = String(minor).padStart(places + 1, "0");
  return `${digits.slice(0, -places)}.${digits.slice(-places)}`;
}

/**
 * Cashfree's `order_amount` back in minor units, exactly. A number is read through its shortest decimal form (which is
 * the literal Cashfree sent). An amount with more decimal places than the currency has (123.456 rupees), a negative,
 * exponent or non-numeric value, or a missing one is NaN, which never equals a stored amount: a mismatch, never a
 * rounding.
 */
export function decimalToMinor(value: unknown, currency: string): number {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : typeof value === "string" ? value.trim() : "";
  const match = /^(\d{1,15})(?:\.(\d+))?$/.exec(text);
  if (!match || !isPaymentCurrency(currency.toUpperCase())) return Number.NaN;
  const places = minorUnitExponent(currency);
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > places) return Number.NaN;
  const minor = Number(match[1]) * 10 ** places + Number(fraction.padEnd(places, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : Number.NaN;
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** `x-webhook-timestamp` is in milliseconds; a value that looks like seconds is accepted as seconds. */
function timestampMs(value: string): number | null {
  if (!/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return n < 1e12 ? n * 1000 : n;
}

export function createCashfreePaymentGateway(options: CashfreePaymentGatewayOptions): PaymentGateway {
  const missing: string[] = [];
  if (options?.environment !== "sandbox" && options?.environment !== "production") missing.push('environment ("sandbox" or "production")');
  if (!nonEmpty(options?.clientId)) missing.push("clientId");
  if (!nonEmpty(options?.clientSecret)) missing.push("clientSecret");
  if (!nonEmpty(options?.apiVersion)) missing.push("apiVersion");
  if (typeof options?.customerDetails !== "function") missing.push("customerDetails");
  if (!isHttpsUrl(options?.notifyUrl)) missing.push("notifyUrl (an absolute https URL: this brick's own webhook)");
  if (missing.length > 0) throw new NotConfiguredError(`the Cashfree adapter needs ${missing.join(", ")}; it has no defaults`);

  const baseUrl = BASE_URLS[options.environment];
  const { clientId, clientSecret, apiVersion } = options;
  const now = options.now ?? (() => Date.now());
  const guarded = createPublicUrlFetch(options.fetch ?? ((url, init) => fetch(url, init)), {
    ...(options.resolveHost !== undefined ? { resolveHost: options.resolveHost } : {}),
    // The keys travel in headers a cross-origin redirect would not strip, so no redirect is ever followed.
    maxRedirects: 0,
  });

  const authHeaders = (): Record<string, string> => ({
    "x-client-id": clientId,
    "x-client-secret": clientSecret,
    "x-api-version": apiVersion,
    accept: "application/json",
  });

  async function call(what: string, path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await guarded(`${baseUrl}${path}`, init);
    } catch {
      throw providerError(`${what} could not be reached`);
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      throw providerError(`${what} was refused`, response.status);
    }
    try {
      const body = (await response.json()) as unknown;
      if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw providerError(`${what} returned no JSON object`, response.status);
  }

  return {
    async createOrder({ orderId, amountMinor, currency, customerId }) {
      const details = await options.customerDetails(customerId);
      if (!details || !nonEmpty(details.customer_phone)) {
        throw new NotConfiguredError("customerDetails returned no customer_phone, which Cashfree requires; no order was created");
      }
      // order_amount is written as the exact decimal literal (12345 paise -> 123.45), not a float JSON.stringify chose.
      const orderAmount = minorToDecimal(amountMinor, currency);
      // Every other value is JSON-encoded; the amount is a digits-and-point literal minorToDecimal built.
      const json =
        `{"order_id":${JSON.stringify(orderId)},"order_amount":${orderAmount},"order_currency":${JSON.stringify(currency)},` +
        `"customer_details":${JSON.stringify({ ...details, customer_id: customerId })}` +
        `,"order_meta":${JSON.stringify({ notify_url: options.notifyUrl })}` +
        "}";
      const body = await call("create order", "/orders", {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json", "x-idempotency-key": `order:${orderId}` },
        body: json,
      });
      // Only an answer that names a payment session counts as created; anything else means no order is recorded.
      if (!nonEmpty(body.payment_session_id)) throw providerError("create order returned no payment_session_id; no order was created");
      // Cashfree's own reference; its API is still addressed by our order id, which is the fallback.
      const ref = body.cf_order_id;
      const providerRef = typeof ref === "string" && ref.length > 0 ? ref : typeof ref === "number" ? String(ref) : orderId;
      return { paymentSessionId: body.payment_session_id, orderId, providerRef };
    },

    // Cashfree's PG API is addressed by the merchant order id, so the stored reference is not needed to fetch.
    async fetchOrder(orderId): Promise<GatewayOrder> {
      const body = await call("fetch order", `/orders/${encodeURIComponent(orderId)}`, { method: "GET", headers: authHeaders() });
      const customer = body.customer_details && typeof body.customer_details === "object" ? (body.customer_details as Record<string, unknown>) : {};
      const currency = typeof body.order_currency === "string" ? body.order_currency : "";
      return {
        orderId: typeof body.order_id === "string" ? body.order_id : "",
        status: body.order_status === "PAID" ? "PAID" : typeof body.order_status === "string" ? body.order_status : "",
        // Cashfree's major-unit decimal back to minor units, in the currency Cashfree reports (a different currency is
        // refused by the caller's currency check anyway).
        amountMinor: decimalToMinor(body.order_amount, currency),
        currency,
        customerId: typeof customer.customer_id === "string" ? customer.customer_id : "",
      };
    },

    // x-webhook-signature = base64(HMAC-SHA256(x-webhook-timestamp + rawBody, clientSecret)), and the timestamp
    // within five minutes of now. Only then is the body read for data.order.order_id.
    // Signed events that name no order (a test ping, a settlement or account event) are "ignored": acknowledged, not
    // retried. Every payment event names data.order.order_id and is re-fetched by the caller before anything happens.
    async verifyWebhook(rawBody, headers): Promise<WebhookVerification> {
      const signature = headers.get("x-webhook-signature");
      const timestamp = headers.get("x-webhook-timestamp");
      if (!signature || !timestamp) return { kind: "invalid" };
      const sentAt = timestampMs(timestamp.trim());
      if (sentAt === null || Math.abs(now() - sentAt) > WEBHOOK_TOLERANCE_MS) return { kind: "invalid" };
      const expected = toBase64(await hmacSha256(clientSecret, timestamp + rawBody));
      if (!constantTimeEqual(signature.trim(), expected)) return { kind: "invalid" };
      try {
        const event = JSON.parse(rawBody) as { data?: { order?: { order_id?: unknown }; payment_gateway_details?: { gateway_order_id?: unknown } } };
        const id = event?.data?.order?.order_id;
        if (!nonEmpty(id)) return { kind: "ignored" };
        const ref = event?.data?.payment_gateway_details?.gateway_order_id;
        return { kind: "order", orderId: id, ...(nonEmpty(ref) ? { providerRef: ref } : {}) };
      } catch {
        return { kind: "ignored" };
      }
    },
  };
}
