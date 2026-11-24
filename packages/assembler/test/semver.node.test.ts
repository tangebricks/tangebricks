import { describe, expect, test } from "vitest";
import { compare, parse, satisfies } from "../src/semver.ts";

describe("semver helpers", () => {
  test("parse valid and invalid semver strings", () => {
    expect(parse("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parse("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parse("1.2")).toBeNull();
    expect(parse("v1.2.3")).toBeNull();
    expect(parse("1.2.3-alpha")).toBeNull();
  });

  test("compare semver versions correctly", () => {
    expect(compare("1.0.0", "1.0.0")).toBe(0);
    expect(compare("1.0.0", "1.0.1")).toBe(-1);
    expect(compare("1.1.0", "1.0.9")).toBe(1);
    expect(compare("2.0.0", "1.99.99")).toBe(1);
  });

  test("satisfies exact version and wildcard", () => {
    expect(satisfies("1.0.0", "1.0.0")).toBe(true);
    expect(satisfies("1.0.1", "1.0.0")).toBe(false);
    expect(satisfies("1.0.0", "*")).toBe(true);
    expect(satisfies("2.3.4", "*")).toBe(true);
  });

  test("satisfies caret ranges (^)", () => {
    expect(satisfies("2.0.0", "^2.0.0")).toBe(true);
    expect(satisfies("2.4.1", "^2.0.0")).toBe(true);
    expect(satisfies("1.4.0", "^2.0.0")).toBe(false);
    expect(satisfies("3.0.0", "^2.0.0")).toBe(false);

    // 0.x.x
    expect(satisfies("0.1.2", "^0.1.0")).toBe(true);
    expect(satisfies("0.2.0", "^0.1.0")).toBe(false);

    // 0.0.x
    expect(satisfies("0.0.1", "^0.0.1")).toBe(true);
    expect(satisfies("0.0.2", "^0.0.1")).toBe(false);
  });

  test("satisfies tilde ranges (~)", () => {
    expect(satisfies("1.2.0", "~1.2.0")).toBe(true);
    expect(satisfies("1.2.5", "~1.2.0")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.0")).toBe(false);
  });

  test("satisfies comparison ranges (>=, <=, >, <)", () => {
    expect(satisfies("1.4.0", ">=1.4.0")).toBe(true);
    expect(satisfies("1.5.0", ">=1.4.0")).toBe(true);
    expect(satisfies("1.3.9", ">=1.4.0")).toBe(false);

    expect(satisfies("1.4.0", "<=1.4.0")).toBe(true);
    expect(satisfies("1.3.9", "<=1.4.0")).toBe(true);
    expect(satisfies("1.4.1", "<=1.4.0")).toBe(false);

    expect(satisfies("1.5.0", ">1.4.0")).toBe(true);
    expect(satisfies("1.4.0", ">1.4.0")).toBe(false);

    expect(satisfies("1.3.0", "<1.4.0")).toBe(true);
    expect(satisfies("1.4.0", "<1.4.0")).toBe(false);
  });
});
