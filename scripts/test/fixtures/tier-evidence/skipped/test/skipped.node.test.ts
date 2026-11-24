import { describe, expect, it } from "vitest";

describe("fixture skipped behaviour test", () => {
  it.skip("is completely skipped", () => {
    expect(true).toBe(true);
  });
});
