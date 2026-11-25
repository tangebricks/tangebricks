import { describe, expect, it } from "vitest";
import { formatMilli, fromMilli, parseMilli, toMilli, toMilliRounded } from "../src/credits.ts";

// Story 2.5: credit amounts are converted once, exactly, to whole thousandths; nothing after that is a float.
describe("toMilli", () => {
  it.each([
    ["12.345", 12345],
    ["0.2", 200],
    ["0.5", 500],
    ["7", 7000],
    ["0.001", 1],
    ["0", 0],
    ["007.10", 7100],
    [0.2, 200],
    [0.5, 500],
    [1.5, 1500],
    [12.345, 12345],
    [7, 7000],
    [0.001, 1],
    [1_000_000_000, 1_000_000_000_000],
  ] as const)("%j is %d thousandths", (value, milli) => {
    expect(toMilli(value)).toBe(milli);
  });

  it.each([
    ["0.0001", "more than three decimals"],
    [0.0001, "more than three decimals (as a number)"],
    [0.1 + 0.2, "a float sum that is not a three-decimal value"],
    ["1e-3", "exponent notation"],
    ["1E3", "exponent notation"],
    [1e-7, "a number String() prints in exponent notation"],
    [1e21, "a number String() prints in exponent notation"],
    ["-1", "a negative amount"],
    [-0.5, "a negative number"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
    ["", "empty text"],
    [" 1", "leading space"],
    ["1 ", "trailing space"],
    ["+1", "a plus sign"],
    [".5", "no whole part"],
    ["5.", "no fraction digits"],
    ["1,5", "a comma"],
    ["0x10", "hexadecimal"],
    ["abc", "letters"],
    ["9007199254740.992", "thousandths beyond a safe integer"],
    ["99999999999999999999", "a whole part beyond a safe integer"],
  ] as Array<[number | string, string]>)("refuses %j (%s)", (value) => {
    expect(() => toMilli(value)).toThrow(RangeError);
  });

  it("accepts a negative amount only when asked", () => {
    expect(toMilli("-1.5", { allowNegative: true })).toBe(-1500);
    expect(toMilli(-0.2, { allowNegative: true })).toBe(-200);
    expect(toMilli("-0", { allowNegative: true })).toBe(0);
  });

  it("refuses a value that is neither a number nor a string", () => {
    expect(() => toMilli(null as unknown as string)).toThrow(RangeError);
    expect(() => toMilli({} as unknown as string)).toThrow(RangeError);
  });

  it("parseMilli answers instead of throwing", () => {
    expect(parseMilli("0.2")).toEqual({ ok: true, milli: 200 });
    expect(parseMilli("0.0001")).toMatchObject({ ok: false });
    expect(parseMilli(true)).toMatchObject({ ok: false });
    expect(parseMilli(undefined)).toMatchObject({ ok: false });
  });
});

describe("toMilliRounded", () => {
  it("leaves a value with three decimals or fewer alone", () => {
    expect(toMilliRounded("12.345", "half-up")).toEqual({ milli: 12345, rounded: false });
    expect(toMilliRounded("7", "down")).toEqual({ milli: 7000, rounded: false });
  });

  it("rounds half-up and down by decimal digits", () => {
    expect(toMilliRounded("1.2345", "half-up")).toEqual({ milli: 1235, rounded: true });
    expect(toMilliRounded("1.2345", "down")).toEqual({ milli: 1234, rounded: true });
    expect(toMilliRounded("1.2344999", "half-up")).toEqual({ milli: 1234, rounded: true });
    expect(toMilliRounded("0.9995", "half-up")).toEqual({ milli: 1000, rounded: true });
    expect(toMilliRounded("0.0004", "half-up")).toEqual({ milli: 0, rounded: true });
  });

  it("trailing zeros past the third decimal round to the same value and are not counted as rounded", () => {
    expect(toMilliRounded("1.2340000", "half-up")).toEqual({ milli: 1234, rounded: false });
  });

  it("still refuses what is not a plain decimal", () => {
    expect(() => toMilliRounded("1e-3", "half-up")).toThrow(RangeError);
    expect(() => toMilliRounded("-1.2345", "down")).toThrow(RangeError);
  });
});

describe("fromMilli and formatMilli", () => {
  it.each([
    [12345, 12.345, "12.345"],
    [200, 0.2, "0.2"],
    [7000, 7, "7"],
    [1, 0.001, "0.001"],
    [0, 0, "0"],
    [-1500, -1.5, "-1.5"],
    [1010, 1.01, "1.01"],
  ])("%d thousandths is %d credits, %s", (milli, credits, text) => {
    expect(fromMilli(milli)).toBe(credits);
    expect(formatMilli(milli)).toBe(text);
  });

  it("round-trips every thousandth from 0 to 10 credits through text and number", () => {
    for (let milli = 0; milli <= 10_000; milli += 1) {
      expect(toMilli(formatMilli(milli))).toBe(milli);
      expect(toMilli(fromMilli(milli))).toBe(milli);
    }
  });

  it("refuses a value that is not a safe integer", () => {
    expect(() => fromMilli(1.5)).toThrow(RangeError);
    expect(() => formatMilli(Number.NaN)).toThrow(RangeError);
  });
});
