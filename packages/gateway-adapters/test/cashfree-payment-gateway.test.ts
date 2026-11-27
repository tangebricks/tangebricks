import { describe, expect, it } from "vitest";
import { NotConfiguredError } from "@poc/sdk";
import { decimalToMinor, minorToDecimal } from "../src/cashfree-payment-gateway.ts";
import { createCashfreePaymentGateway, type CashfreePaymentGatewayOptions } from "../src/cashfree-payment-gateway.ts";
import { hmacSha256, toBase64 } from "../src/webhook-signature.ts";
import createOrderFixture from "./fixtures/cashfree/create-order.response.json";
import errorFixture from "./fixtures/cashfree/error.authentication.json";
import activeFixture from "./fixtures/cashfree/fetch-order.active.json";
import expiredFixture from "./fixtures/cashfree/fetch-order.expired.json";
import paidFixture from "./fixtures/cashfree/fetch-order.paid.json";
import webhookFixture from "./fixtures/cashfree/webhook.payment-success.json";

// Story 2.3: the Cashfree adapter against Cashfree's documented response and webhook shapes. The fixtures are
// documented samples, not live recordings (fixtures/cashfree/README.md). No request leaves the test: every call goes to
// the injected fetch, and host resolution is off.

const NOW = Date.parse("2026-11-25T10:00:00Z");
const SECRET = "cfsk_contract_test_secret";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

function adapter(answer: (seen: Seen) => Response | Promise<Response>, overrides: Partial<CashfreePaymentGatewayOptions> = {}) {
  const seen: Seen[] = [];
  const gateway = createCashfreePaymentGateway({
    environment: "sandbox",
    clientId: "cf_client_contract",
    clientSecret: SECRET,
    apiVersion: "2023-08-01",
    customerDetails: (customerId) => ({ customer_phone: "9999999999", customer_email: `${customerId}@example.com` }),
    notifyUrl: "https://app.example.com/api/payments/webhook",
    fetch: async (url, init) => {
      const s = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : null };
      seen.push(s);
      return answer(s);
    },
    resolveHost: null,
    now: () => NOW,
    ...overrides,
  });
  return { gateway, seen };
}

async function signed(body: string, timestamp = String(NOW), secret = SECRET) {
  return new Headers({ "x-webhook-timestamp": timestamp, "x-webhook-signature": toBase64(await hmacSha256(secret, timestamp + body)) });
}

describe("Cashfree adapter: create order", () => {
  it("POSTs /pg/orders on the sandbox host with the keys, API version and idempotency key, and returns payment_session_id", async () => {
    const { gateway, seen } = adapter(() => json(createOrderFixture));
    const created = await gateway.createOrder({ orderId: "order_0123456789abcdef", amountMinor: 15000, currency: "INR", customerId: "user-123" });

    // cf_order_id is Cashfree's own reference for the order
    expect(created).toEqual({ orderId: "order_0123456789abcdef", paymentSessionId: createOrderFixture.payment_session_id, providerRef: "2149460581" });
    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req!.url).toBe("https://sandbox.cashfree.com/pg/orders");
    expect(req!.method).toBe("POST");
    expect(req!.headers.get("x-client-id")).toBe("cf_client_contract");
    expect(req!.headers.get("x-client-secret")).toBe(SECRET);
    expect(req!.headers.get("x-api-version")).toBe("2023-08-01");
    expect(req!.headers.get("x-idempotency-key")).toBe("order:order_0123456789abcdef");
    expect(req!.headers.get("content-type")).toBe("application/json");
    // 15000 paise go out as the exact major-unit decimal 150.00, never as 15000 rupees.
    expect(req!.body).toContain('"order_amount":150.00,');
    expect(JSON.parse(req!.body!)).toEqual({
      order_id: "order_0123456789abcdef",
      order_amount: 150,
      order_currency: "INR",
      customer_details: { customer_id: "user-123", customer_phone: "9999999999", customer_email: "user-123@example.com" },
      order_meta: { notify_url: "https://app.example.com/api/payments/webhook" },
    });
  });

  it("production uses the production host", async () => {
    const { gateway, seen } = adapter(() => json(createOrderFixture), { environment: "production" });
    await gateway.createOrder({ orderId: "o1", amountMinor: 1, currency: "INR", customerId: "u1" });
    expect(seen[0]!.url).toBe("https://api.cashfree.com/pg/orders");
  });

  it("the customer id is always the wallet's own, whatever customerDetails returns", async () => {
    const { gateway, seen } = adapter(() => json(createOrderFixture), {
      customerDetails: () => ({ customer_phone: "9999999999", customer_id: "someone-else" }) as never,
    });
    await gateway.createOrder({ orderId: "o1", amountMinor: 1, currency: "INR", customerId: "u1" });
    expect(JSON.parse(seen[0]!.body!).customer_details.customer_id).toBe("u1");
  });

  it("PROVIDER_ERROR on a non-2xx answer, without the provider's text or any key", async () => {
    const { gateway } = adapter(() => json(errorFixture, 401));
    const error = await gateway.createOrder({ orderId: "o1", amountMinor: 1, currency: "INR", customerId: "u1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotConfiguredError);
    expect((error as NotConfiguredError).code).toBe("PROVIDER_ERROR");
    expect((error as { status?: number }).status).toBe(401);
    const message = (error as Error).message;
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("cf_client_contract");
    expect(message).not.toContain(errorFixture.message);
  });

  it("PROVIDER_ERROR on a 2xx answer without payment_session_id", async () => {
    const { payment_session_id: _, ...noSession } = createOrderFixture;
    const { gateway } = adapter(() => json(noSession));
    await expect(gateway.createOrder({ orderId: "o1", amountMinor: 1, currency: "INR", customerId: "u1" })).rejects.toThrow(/PROVIDER_ERROR/);
  });

  it("PROVIDER_ERROR when the network call itself fails, and the cause's text is not passed on", async () => {
    const { gateway } = adapter(() => {
      throw new Error(`socket hang up near ${SECRET}`);
    });
    const error = (await gateway.createOrder({ orderId: "o1", amountMinor: 1, currency: "INR", customerId: "u1" }).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/^PROVIDER_ERROR/);
    expect(error.message).not.toContain(SECRET);
  });

  it("a redirect is never followed, so the keys cannot be carried to another host", async () => {
    const { gateway, seen } = adapter(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/steal" } }));
    await expect(gateway.createOrder({ orderId: "o1", amountMinor: 1, currency: "INR", customerId: "u1" })).rejects.toThrow(/PROVIDER_ERROR/);
    expect(seen).toHaveLength(1);
  });

  it("refuses to create an order without the customer's phone number", async () => {
    const { gateway, seen } = adapter(() => json(createOrderFixture), { customerDetails: () => ({ customer_phone: "" }) });
    await expect(gateway.createOrder({ orderId: "o1", amountMinor: 1, currency: "INR", customerId: "u1" })).rejects.toThrow(/NOT_CONFIGURED/);
    expect(seen).toHaveLength(0);
  });
});

describe("Cashfree adapter: fetch order", () => {
  it("GETs /pg/orders/{order_id} with the keys and maps a PAID order", async () => {
    const { gateway, seen } = adapter(() => json(paidFixture));
    const order = await gateway.fetchOrder("order_0123456789abcdef", undefined);
    expect(seen[0]!.url).toBe("https://sandbox.cashfree.com/pg/orders/order_0123456789abcdef");
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers.get("x-client-secret")).toBe(SECRET);
    // order_amount 150.00 rupees comes back as 15000 paise
    expect(order).toEqual({ orderId: "order_0123456789abcdef", status: "PAID", amountMinor: 15000, currency: "INR", customerId: "user-123" });
  });

  it.each([
    ["ACTIVE", activeFixture],
    ["EXPIRED", expiredFixture],
  ])("an %s order keeps its status (only PAID credits)", async (status, fixture) => {
    const { gateway } = adapter(() => json(fixture));
    expect((await gateway.fetchOrder("order_0123456789abcdef", undefined)).status).toBe(status);
  });

  it("maps the amount, currency, customer and order id from the response", async () => {
    const { gateway } = adapter(() =>
      json({
        ...paidFixture,
        order_id: "order_other",
        order_amount: 999,
        order_currency: "USD",
        customer_details: { ...paidFixture.customer_details, customer_id: "user-999" },
      }),
    );
    expect(await gateway.fetchOrder("order_0123456789abcdef", undefined)).toEqual({
      orderId: "order_other",
      status: "PAID",
      amountMinor: 99900,
      currency: "USD",
      customerId: "user-999",
    });
  });

  it.each([
    [150.505, "a fraction of a paisa"],
    ["150.505", "a fraction of a paisa, as text"],
    [-150, "a negative amount"],
    [1e21, "an exponent"],
    [null, "no amount"],
    ["abc", "not a number"],
  ] as Array<[unknown, string]>)("an amount of %s (%s) maps to NaN, which never equals a stored amount", async (amount, _why) => {
    const { gateway } = adapter(() => json({ ...paidFixture, order_amount: amount }));
    expect((await gateway.fetchOrder("order_0123456789abcdef", undefined)).amountMinor).toBeNaN();
  });

  it('an amount written as "150.00" is exactly 15000 paise, and 123.45 is 12345', async () => {
    const { gateway } = adapter(() => json({ ...paidFixture, order_amount: "150.00" }));
    expect((await gateway.fetchOrder("order_0123456789abcdef", undefined)).amountMinor).toBe(15000);
    const { gateway: other } = adapter(() => json({ ...paidFixture, order_amount: 123.45 }));
    expect((await other.fetchOrder("order_0123456789abcdef", undefined)).amountMinor).toBe(12345);
  });

  it("PROVIDER_ERROR on a non-2xx answer", async () => {
    const { gateway } = adapter(() => json({ message: "order not found", code: "order_not_found", type: "invalid_request_error" }, 404));
    await expect(gateway.fetchOrder("order_x", undefined)).rejects.toThrow(/^PROVIDER_ERROR/);
  });

  it("the order id is encoded into the path, so it cannot change the request", async () => {
    const { gateway, seen } = adapter(() => json(paidFixture));
    await gateway.fetchOrder("../payments?x=1", undefined);
    expect(seen[0]!.url).toBe("https://sandbox.cashfree.com/pg/orders/..%2Fpayments%3Fx%3D1");
  });
});

describe("Cashfree adapter: webhook", () => {
  const body = JSON.stringify(webhookFixture);

  it("a valid signature over timestamp + raw body names the order", async () => {
    const { gateway, seen } = adapter(() => json({}));
    expect(await gateway.verifyWebhook(body, await signed(body))).toEqual({ kind: "order", orderId: "order_0123456789abcdef", providerRef: "2149460581" });
    expect(seen).toHaveLength(0); // verifying is local; the order is re-fetched by the caller
  });

  it("a timestamp in seconds is accepted too", async () => {
    const { gateway } = adapter(() => json({}));
    expect(await gateway.verifyWebhook(body, await signed(body, String(Math.floor(NOW / 1000))))).toEqual({
      kind: "order",
      orderId: "order_0123456789abcdef",
      providerRef: "2149460581",
    });
  });

  it("a forged signature (another key) is refused", async () => {
    const { gateway } = adapter(() => json({}));
    expect(await gateway.verifyWebhook(body, await signed(body, String(NOW), "not-the-secret"))).toEqual({ kind: "invalid" });
  });

  it("a body changed after signing is refused", async () => {
    const { gateway } = adapter(() => json({}));
    const headers = await signed(body);
    expect(await gateway.verifyWebhook(body.replace("order_0123456789abcdef", "order_fedcba9876543210"), headers)).toEqual({ kind: "invalid" });
  });

  it("a stale timestamp (more than five minutes old) is refused even with a valid signature", async () => {
    const { gateway } = adapter(() => json({}));
    const stale = String(NOW - 5 * 60 * 1000 - 1);
    expect(await gateway.verifyWebhook(body, await signed(body, stale))).toEqual({ kind: "invalid" });
    const future = String(NOW + 5 * 60 * 1000 + 1);
    expect(await gateway.verifyWebhook(body, await signed(body, future))).toEqual({ kind: "invalid" });
  });

  it("missing signature or timestamp headers are refused", async () => {
    const { gateway } = adapter(() => json({}));
    expect(await gateway.verifyWebhook(body, new Headers())).toEqual({ kind: "invalid" });
    const headers = await signed(body);
    headers.delete("x-webhook-timestamp");
    expect(await gateway.verifyWebhook(body, headers)).toEqual({ kind: "invalid" });
  });

  it("a correctly signed body with no order id is ignored (acknowledged), not invalid", async () => {
    const { gateway } = adapter(() => json({}));
    const noOrder = JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: {} });
    expect(await gateway.verifyWebhook(noOrder, await signed(noOrder))).toEqual({ kind: "ignored" });
  });
});

describe("Cashfree adapter: configuration", () => {
  const complete: CashfreePaymentGatewayOptions = {
    environment: "sandbox",
    clientId: "id",
    clientSecret: "secret",
    apiVersion: "2023-08-01",
    customerDetails: () => ({ customer_phone: "9999999999" }),
    notifyUrl: "https://app.example.com/api/payments/webhook",
  };

  it.each(["environment", "clientId", "clientSecret", "apiVersion", "customerDetails", "notifyUrl"] as const)("a missing %s throws at construction", (name) => {
    const { [name]: _, ...rest } = complete;
    expect(() => createCashfreePaymentGateway(rest as CashfreePaymentGatewayOptions)).toThrow(NotConfiguredError);
    expect(() => createCashfreePaymentGateway(rest as CashfreePaymentGatewayOptions)).toThrow(new RegExp(name));
  });

  it("an unknown environment throws at construction", () => {
    expect(() => createCashfreePaymentGateway({ ...complete, environment: "staging" as never })).toThrow(/environment/);
  });

  it("the construction error never contains the secret", () => {
    let message = "";
    try {
      createCashfreePaymentGateway({ ...complete, clientId: "", clientSecret: "super-secret-value" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/clientId/);
    expect(message).not.toContain("super-secret-value");
  });
});

describe("Cashfree adapter: amounts (minor units on the interface, major-unit decimals at Cashfree)", () => {
  it.each([
    [12345, "INR", "123.45"],
    [50000, "INR", "500.00"],
    [5, "INR", "0.05"],
    [0, "INR", "0.00"],
    [500, "JPY", "500"],
    [12345, "KWD", "12.345"],
    [7, "BHD", "0.007"],
  ] as const)("%i in %s is written as %s and read back exactly", (minor, currency, decimal) => {
    expect(minorToDecimal(minor, currency)).toBe(decimal);
    expect(decimalToMinor(decimal, currency)).toBe(minor);
    expect(decimalToMinor(Number(decimal), currency)).toBe(minor);
  });

  it("refuses a fraction the currency cannot hold, never rounding it", () => {
    expect(decimalToMinor("123.456", "INR")).toBeNaN();
    expect(decimalToMinor(500.5, "JPY")).toBeNaN();
    expect(decimalToMinor("1.2345", "KWD")).toBeNaN();
    expect(decimalToMinor("123.4500", "INR")).toBe(12345); // trailing zeros are not extra precision
    expect(() => minorToDecimal(1.5, "INR")).toThrow(RangeError);
  });

  it("a 12345-paise checkout total is sent as 123.45 and fetched back as 12345", async () => {
    const { gateway, seen } = adapter((req) =>
      req.method === "POST" ? json(createOrderFixture) : json({ ...paidFixture, order_id: "cs_1", order_amount: 123.45 }),
    );
    await gateway.createOrder({ orderId: "cs_1", amountMinor: 12345, currency: "INR", customerId: "user-123" });
    expect(seen[0]!.body).toContain('"order_amount":123.45,');
    expect(JSON.parse(seen[0]!.body!).order_amount).toBe(123.45);
    expect((await gateway.fetchOrder("cs_1", undefined)).amountMinor).toBe(12345);
  });

  it("a zero-decimal currency sends whole yen", async () => {
    const { gateway, seen } = adapter(() => json(createOrderFixture));
    await gateway.createOrder({ orderId: "o_jpy", amountMinor: 500, currency: "JPY", customerId: "u1" });
    expect(seen[0]!.body).toContain('"order_amount":500,');
  });
});

describe("Cashfree adapter: notifyUrl (one adapter per brick, each notifying its own webhook)", () => {
  it("is sent as order_meta.notify_url on every order", async () => {
    const { gateway, seen } = adapter(() => json(createOrderFixture), { notifyUrl: "https://app.example.com/api/checkout/webhook" });
    await gateway.createOrder({ orderId: "cs_1", amountMinor: 100, currency: "INR", customerId: "u1" });
    expect(JSON.parse(seen[0]!.body!).order_meta).toEqual({ notify_url: "https://app.example.com/api/checkout/webhook" });
  });

  it("is required: an adapter without it would let another brick's webhook acknowledge and drop these payments", () => {
    expect(() =>
      createCashfreePaymentGateway({
        environment: "sandbox",
        clientId: "id",
        clientSecret: "s",
        apiVersion: "2023-08-01",
        customerDetails: () => ({ customer_phone: "1" }),
      } as never),
    ).toThrow(/notifyUrl/);
  });

  it.each(["http://app.example.com/hook", "not a url", "https://user:pw@app.example.com/hook", ""])("refuses %s at construction", (notifyUrl) => {
    expect(() =>
      createCashfreePaymentGateway({
        environment: "sandbox",
        clientId: "id",
        clientSecret: "s",
        apiVersion: "2023-08-01",
        customerDetails: () => ({ customer_phone: "1" }),
        notifyUrl,
      }),
    ).toThrow(/notifyUrl/);
  });
});
