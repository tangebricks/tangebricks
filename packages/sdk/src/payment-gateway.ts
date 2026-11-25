/**
 * The provider-neutral payment gateway contract (story 2.3). A brick that takes payments (credit-wallet,
 * checkout-gateway) depends on this shape only; each provider (Cashfree, Stripe, ...) is an adapter outside the
 * bricks. Nothing here names a provider.
 *
 * THE UNIT RULE: every amount that crosses this interface (`createOrder`'s `amountMinor`, `GatewayOrder.amountMinor`)
 * is a whole number in the currency's MINOR unit, the smallest one (paise, cents; yen for a zero-decimal currency;
 * fils for a three-decimal one). A brick that keeps major units converts with `toMinorUnits`; an adapter whose provider
 * speaks major units converts exactly at its own edge and never rounds. The field is named `amountMinor` so an adapter
 * written for the earlier `amount` contract fails to compile instead of silently charging the wrong amount.
 */

/** What a provider says about one order when asked. */
export interface GatewayOrder {
  /** The provider's answer for the order id it was asked about. Must equal the id the brick created. */
  orderId: string;
  /** "PAID" is the only status that counts as paid. Anything else (ACTIVE, EXPIRED, FAILED, ...) does not. */
  status: string;
  /** A whole number in the currency's minor unit (see the unit rule above). Anything else never matches. */
  amountMinor: number;
  /** ISO 4217 code as the provider reports it (compared case-insensitively). */
  currency: string;
  /** The customer the provider holds the order for. Must equal the one the brick created it for. */
  customerId: string;
}

/** What `verifyWebhook` found. */
export type WebhookVerification =
  /** Missing, forged or stale signature: the route answers 401 and acts on nothing. */
  | { kind: "invalid" }
  /** Correctly signed, but not a payment event this brick acts on (or it names no order): answered 200 so the provider stops retrying. */
  | { kind: "ignored" }
  /** Correctly signed and about this order. Only a hint: the caller re-fetches the order and checks it before acting. */
  | { kind: "order"; orderId: string; providerRef?: string };

export interface PaymentGateway {
  /**
   * `amountMinor` is a whole number in the currency's minor unit; `currency` is ISO 4217, upper case. `providerRef` is
   * the provider's own reference for the order (a Stripe payment intent id, a Cashfree order id); the brick stores it
   * and passes it back to `fetchOrder`.
   */
  createOrder(input: { orderId: string; amountMinor: number; currency: string; customerId: string }): Promise<{
    paymentSessionId: string;
    orderId: string;
    providerRef: string;
  }>;
  /** `providerRef` is what `createOrder` returned; undefined only for a row stored before the brick kept it. */
  fetchOrder(orderId: string, providerRef: string | undefined): Promise<GatewayOrder>;
  /** Checks a webhook's signature over the exact raw body. */
  verifyWebhook(rawBody: string, headers: Headers): Promise<WebhookVerification>;
}

/** The order as the brick stored it: what a provider's answer has to match before anything is credited. */
export interface ExpectedPayment {
  orderId: string;
  /** In the currency's minor unit, like `GatewayOrder.amountMinor`. */
  amountMinor: number;
  currency: string;
  customerId: string;
}

export type PaymentMismatchField = "orderId" | "amount" | "currency" | "customerId";

export type PaymentCheck = { ok: true } | { ok: false; field: PaymentMismatchField };

/**
 * Compares a provider's answer with the order the brick stored: same order id, exactly the same amount, the same
 * currency (case-insensitive) and the same customer. The first field that differs is named, so a caller can log
 * which one failed without logging any value. It does not look at the status; the caller checks "PAID" itself.
 */
export function checkGatewayOrder(expected: ExpectedPayment, actual: GatewayOrder): PaymentCheck {
  if (typeof actual.orderId !== "string" || !expected.orderId || actual.orderId !== expected.orderId) return { ok: false, field: "orderId" };
  if (typeof actual.amountMinor !== "number" || !Number.isSafeInteger(actual.amountMinor) || actual.amountMinor !== expected.amountMinor) {
    return { ok: false, field: "amount" };
  }
  if (
    typeof actual.currency !== "string" ||
    typeof expected.currency !== "string" ||
    expected.currency.length === 0 ||
    actual.currency.toUpperCase() !== expected.currency.toUpperCase()
  ) {
    return { ok: false, field: "currency" };
  }
  // An empty stored customer matches nothing: a provider answer with no customer is never "the same customer".
  if (typeof actual.customerId !== "string" || !expected.customerId || actual.customerId !== expected.customerId) return { ok: false, field: "customerId" };
  return { ok: true };
}

/**
 * ISO 4217 active currencies with a minor unit, and its number of decimal places. Codes not in this table (precious
 * metals, testing codes, withdrawn currencies, typos) are not payment currencies.
 */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  ...Object.fromEntries(
    (
      "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF " +
      "CHW CNY COP COU CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF " +
      "IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN " +
      "MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS " +
      "SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XCD XCG YER ZAR ZMW ZWG"
    )
      .split(" ")
      .map((code) => [code, 2]),
  ),
  ...Object.fromEntries("BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF".split(" ").map((code) => [code, 0])),
  ...Object.fromEntries("BHD IQD JOD KWD LYD OMR TND".split(" ").map((code) => [code, 3])),
  ...Object.fromEntries("CLF UYW".split(" ").map((code) => [code, 4])),
});

/** Every code in the table, sorted. */
export const PAYMENT_CURRENCIES: readonly string[] = Object.freeze(Object.keys(MINOR_UNIT_EXPONENTS).sort());

/** A configured payment currency: an upper-case ISO 4217 code from the table. Anything else is "not configured". */
export function isPaymentCurrency(value: unknown): value is string {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MINOR_UNIT_EXPONENTS, value);
}

/** How many decimal places the currency's minor unit has (0 for JPY, 2 for INR, 3 for KWD, 4 for CLF). Throws for an unknown code. */
export function minorUnitExponent(currency: string): number {
  const code = typeof currency === "string" ? currency.toUpperCase() : "";
  if (!isPaymentCurrency(code)) throw new RangeError("not an ISO 4217 payment currency");
  return MINOR_UNIT_EXPONENTS[code]!;
}

/** A whole number of major units (rupees, dollars) in minor units (paise, cents), exactly. Throws on anything else. */
export function toMinorUnits(major: number, currency: string): number {
  if (!Number.isSafeInteger(major)) throw new RangeError("a major amount must be a whole number");
  const minor = major * 10 ** minorUnitExponent(currency);
  if (!Number.isSafeInteger(minor)) throw new RangeError("the amount is too large to convert exactly");
  return minor;
}

/** Minor units back to whole major units, exactly. Throws when the amount is not a whole number of major units. */
export function fromMinorUnits(minor: number, currency: string): number {
  if (!Number.isSafeInteger(minor)) throw new RangeError("a minor amount must be a whole number");
  const factor = 10 ** minorUnitExponent(currency);
  if (minor % factor !== 0) throw new RangeError("the amount is not a whole number of major units");
  return minor / factor;
}

/** The largest webhook body the payment routes read (64 KiB). */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/**
 * Reads a request body as text, refusing (null) a declared Content-Length over `maxBytes` and stopping as soon as more
 * than `maxBytes` have arrived, so an oversized webhook is refused before any of it is hashed.
 */
export async function readBoundedText(request: Request, maxBytes: number = MAX_WEBHOOK_BODY_BYTES): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}
