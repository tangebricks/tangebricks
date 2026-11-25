// Story 2.5: credit amounts with up to three decimals, held as whole thousandths of a credit ("milli-credits").
//
// Floating point cannot hold 0.2 or 0.5 sums exactly, so a credit amount is converted once, at the edge, from its
// decimal text to an integer number of thousandths, and every sum, comparison and stored value after that is an
// integer. A number is converted through its shortest decimal text (`String(value)`), so 0.2 is "0.2" and becomes 200
// exactly, while 0.1 + 0.2 (0.30000000000000004) has more than three decimals and is refused rather than rounded.

/** Thousandths per credit. */
export const MILLI_PER_CREDIT = 1000;

/** The most decimals a credit amount may have. */
export const CREDIT_DECIMALS = 3;

export interface ToMilliOptions {
  /** Accept a leading "-" (a signed delta). Default false: a negative amount is refused. */
  allowNegative?: boolean;
}

export type CreditRounding = "half-up" | "down";

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

function parts(value: number | string, allowNegative: boolean): { negative: boolean; whole: string; fraction: string } {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("a credit amount must be a finite number");
    text = String(value);
  } else if (typeof value === "string") {
    text = value;
  } else {
    throw new RangeError("a credit amount must be a number or a decimal string");
  }
  // Exponent notation ("1e-3", or a number String() prints that way), a sign of "+", spaces, ".5" and "5." are all refused.
  const match = DECIMAL.exec(text);
  if (!match) throw new RangeError(`"${text.slice(0, 40)}" is not a plain decimal credit amount`);
  const negative = match[1] === "-";
  if (negative && !allowNegative) throw new RangeError("a credit amount may not be negative here");
  return { negative, whole: match[2]!, fraction: match[3] ?? "" };
}

function assemble(negative: boolean, whole: string, fraction3: string): number {
  const digits = `${whole}${fraction3}`.replace(/^0+(?=\d)/, "");
  const magnitude = Number(digits);
  // Exact only while the digits fit a safe integer: compare the printed value with the digits it came from.
  if (!Number.isSafeInteger(magnitude) || String(magnitude) !== digits) throw new RangeError("a credit amount is too large");
  return negative && magnitude !== 0 ? -magnitude : magnitude;
}

/**
 * Converts a credit amount (a number, or decimal text such as "12.345") to whole thousandths, exactly. Refuses more than
 * three decimals, a negative amount (unless `allowNegative`), NaN, Infinity, exponent notation and anything whose
 * thousandths are not a safe integer. Throws RangeError.
 */
export function toMilli(value: number | string, options: ToMilliOptions = {}): number {
  const { negative, whole, fraction } = parts(value, options.allowNegative === true);
  if (fraction.length > CREDIT_DECIMALS) throw new RangeError(`a credit amount may have at most ${CREDIT_DECIMALS} decimals`);
  return assemble(negative, whole, fraction.padEnd(CREDIT_DECIMALS, "0"));
}

/** `toMilli` that answers instead of throwing: `{ ok: true, milli }` or `{ ok: false, error }`. */
export function parseMilli(value: unknown, options: ToMilliOptions = {}): { ok: true; milli: number } | { ok: false; error: string } {
  try {
    if (typeof value !== "number" && typeof value !== "string") return { ok: false, error: "a credit amount must be a number or a decimal string" };
    return { ok: true, milli: toMilli(value, options) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Like `toMilli`, but a value with more than three decimals is rounded to the thousandth instead of refused, by decimal
 * digits (never through a float): "half-up" rounds a remainder of 5 or more away from zero, "down" drops it. Says
 * whether rounding changed the value.
 */
export function toMilliRounded(value: number | string, rounding: CreditRounding, options: ToMilliOptions = {}): { milli: number; rounded: boolean } {
  const { negative, whole, fraction } = parts(value, options.allowNegative === true);
  if (fraction.length <= CREDIT_DECIMALS) return { milli: assemble(negative, whole, fraction.padEnd(CREDIT_DECIMALS, "0")), rounded: false };
  const kept = fraction.slice(0, CREDIT_DECIMALS);
  const dropped = fraction.slice(CREDIT_DECIMALS);
  const truncated = assemble(negative, whole, kept);
  const changed = /[1-9]/.test(dropped);
  if (rounding === "down" || dropped[0]! < "5") return { milli: truncated, rounded: changed };
  const up = Math.abs(truncated) + 1;
  if (!Number.isSafeInteger(up)) throw new RangeError("a credit amount is too large");
  return { milli: negative ? -up : up, rounded: true };
}

/** Thousandths to a number of credits, for display and JSON. Exact for every value `toMilli` produces. */
export function fromMilli(milli: number): number {
  if (!Number.isSafeInteger(milli)) throw new RangeError("milli-credits must be a safe integer");
  return milli / MILLI_PER_CREDIT;
}

/** Thousandths to decimal text with no trailing zeros: 12345 is "12.345", 200 is "0.2", 7000 is "7", -1500 is "-1.5". */
export function formatMilli(milli: number): string {
  if (!Number.isSafeInteger(milli)) throw new RangeError("milli-credits must be a safe integer");
  const sign = milli < 0 ? "-" : "";
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / MILLI_PER_CREDIT);
  const fraction = String(abs % MILLI_PER_CREDIT).padStart(CREDIT_DECIMALS, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}
