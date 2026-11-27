import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  PAYMENT_CURRENCIES,
  checkGatewayOrder,
  fromMinorUnits,
  isPaymentCurrency,
  minorUnitExponent,
  readBoundedText,
  toMinorUnits,
} from "../src/payment-gateway.ts";

// Story 2.3: the one provider-neutral comparison credit-wallet and checkout-gateway both run before acting on a payment.
const expected = { orderId: "order_1", amountMinor: 150, currency: "INR", customerId: "user-1" };
const paid = { orderId: "order_1", status: "PAID", amountMinor: 150, currency: "inr", customerId: "user-1" };

describe("checkGatewayOrder", () => {
  it("matches the same id, exact amount, currency (any case) and customer", () => {
    expect(checkGatewayOrder(expected, paid)).toEqual({ ok: true });
  });

  it.each([
    ["orderId", { orderId: "order_2" }],
    ["amount", { amountMinor: 151 }],
    ["amount", { amountMinor: 150.0000001 }],
    ["amount", { amountMinor: Number.NaN }],
    ["amount", { amountMinor: "150" as unknown as number }],
    ["currency", { currency: "USD" }],
    ["currency", { currency: "" }],
    ["customerId", { customerId: "user-2" }],
  ] as const)("names %s when it differs", (field, patch) => {
    expect(checkGatewayOrder(expected, { ...paid, ...patch })).toEqual({ ok: false, field });
  });

  it("an empty stored order id, currency or customer matches nothing", () => {
    expect(checkGatewayOrder({ ...expected, orderId: "" }, { ...paid, orderId: "" })).toEqual({ ok: false, field: "orderId" });
    expect(checkGatewayOrder({ ...expected, currency: "" }, { ...paid, currency: "" })).toEqual({ ok: false, field: "currency" });
    expect(checkGatewayOrder({ ...expected, customerId: "" }, { ...paid, customerId: "" })).toEqual({ ok: false, field: "customerId" });
  });
});

describe("isPaymentCurrency", () => {
  it("accepts three uppercase letters only", () => {
    expect(isPaymentCurrency("INR")).toBe(true);
    for (const value of ["", "inr", "INRR", "IN", undefined, 356, "ABC", "XAU", "XTS", "HRK"]) expect(isPaymentCurrency(value)).toBe(false);
  });

  it("the paymentCurrency setting pattern in both manifests accepts exactly the table's codes (and empty)", () => {
    for (const manifest of ["bricks/credit-wallet/brick.manifest.json", "bricks/checkout-gateway/brick.manifest.json"]) {
      const pattern = new RegExp(JSON.parse(readFileSync(new URL(`../../../${manifest}`, import.meta.url), "utf8")).settings.paymentCurrency.pattern);
      expect(pattern.test("")).toBe(true);
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const accepted: string[] = [];
      for (const a of letters) for (const b of letters) for (const c of letters) if (pattern.test(a + b + c)) accepted.push(a + b + c);
      expect(accepted).toEqual([...PAYMENT_CURRENCIES]);
    }
  });
});

describe("minor units: every amount on the gateway interface is in the currency's smallest unit", () => {
  it("knows each currency's exponent", () => {
    expect(minorUnitExponent("INR")).toBe(2);
    expect(minorUnitExponent("usd")).toBe(2);
    for (const c of ["JPY", "KRW", "VND", "CLP"]) expect(minorUnitExponent(c)).toBe(0);
    for (const c of ["BHD", "KWD", "OMR", "JOD", "TND"]) expect(minorUnitExponent(c)).toBe(3);
    for (const c of ["CLF", "UYW"]) expect(minorUnitExponent(c)).toBe(4);
    expect(() => minorUnitExponent("ABC")).toThrow(RangeError);
  });

  it("converts whole major units exactly, both ways", () => {
    expect(toMinorUnits(500, "INR")).toBe(50000);
    expect(toMinorUnits(500, "JPY")).toBe(500);
    expect(toMinorUnits(500, "KWD")).toBe(500000);
    expect(fromMinorUnits(50000, "INR")).toBe(500);
    expect(fromMinorUnits(500, "JPY")).toBe(500);
    expect(fromMinorUnits(500000, "KWD")).toBe(500);
  });

  it("never rounds: a fraction or an unsafe number throws", () => {
    expect(() => toMinorUnits(1.5, "INR")).toThrow(RangeError);
    expect(() => toMinorUnits(Number.MAX_SAFE_INTEGER, "INR")).toThrow(RangeError);
    expect(() => fromMinorUnits(12345, "INR")).toThrow(RangeError);
    expect(() => fromMinorUnits(1.5, "JPY")).toThrow(RangeError);
  });
});

describe("readBoundedText (webhook bodies)", () => {
  it("reads a body within the limit and refuses one over it, declared or not", async () => {
    expect(await readBoundedText(new Request("http://x/", { method: "POST", body: "hello" }), 10)).toBe("hello");
    expect(await readBoundedText(new Request("http://x/", { method: "POST", body: "x".repeat(11) }), 10)).toBeNull();
    expect(await readBoundedText(new Request("http://x/", { method: "POST", body: "small", headers: { "content-length": "999999" } }), 10)).toBeNull();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 20; i += 1) controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    expect(await readBoundedText(new Request("http://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit), 8 * 1024)).toBeNull();
  });
});
