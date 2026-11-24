import { describe, it } from "vitest";

describe("fixture zero expects behaviour test", () => {
  it("runs without any expect calls", () => {
    const value = "zero" + "expects";
    if (value !== "zeroexpects") throw new Error("assertion failure");
  });
});
