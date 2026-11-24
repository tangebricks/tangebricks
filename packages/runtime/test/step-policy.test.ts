import { describe, expect, test } from "vitest";
import { stepPolicyFor } from "../src/step-policy.ts";

describe("stepPolicyFor (UC7.2 AC1)", () => {
  test("none: 5 retries, 1 second exponential, 30 second timeout", () => {
    expect(stepPolicyFor({ sideEffects: "none" }, { idempotent: false })).toEqual({ retries: { limit: 5, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" });
  });
  test("read: 4 retries, 2 seconds exponential, 60 second timeout", () => {
    expect(stepPolicyFor({ sideEffects: "read" }, { idempotent: false })).toEqual({ retries: { limit: 4, delay: "2 seconds", backoff: "exponential" }, timeout: "60 seconds" });
  });
  test("write with idempotency: 3 retries, 5 seconds exponential, 60 second timeout", () => {
    expect(stepPolicyFor({ sideEffects: "write" }, { idempotent: true })).toEqual({ retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "60 seconds" });
  });
  test("write without idempotency: limit 0, 60 second timeout, and no manifest override raises it", () => {
    expect(stepPolicyFor({ sideEffects: "write" }, { idempotent: false })).toEqual({ retries: { limit: 0, delay: 0 }, timeout: "60 seconds" });
    expect(stepPolicyFor({ sideEffects: "write", retry: { limit: 9 } }, { idempotent: false }).retries.limit).toBe(0);
  });
  test("a node with no declared sideEffects is treated as a write", () => {
    expect(stepPolicyFor({}, { idempotent: false }).retries.limit).toBe(0);
  });
  test("a manifest retry lowers the limit but never raises it", () => {
    expect(stepPolicyFor({ sideEffects: "read", retry: { limit: 1 } }, { idempotent: false }).retries.limit).toBe(1);
    expect(stepPolicyFor({ sideEffects: "none", retry: { limit: 0 } }, { idempotent: false }).retries.limit).toBe(0);
    expect(stepPolicyFor({ sideEffects: "read", retry: { limit: 99 } }, { idempotent: false }).retries.limit).toBe(4);
    expect(stepPolicyFor({ sideEffects: "write", retry: { limit: 2 } }, { idempotent: true }).retries.limit).toBe(2);
  });
});
