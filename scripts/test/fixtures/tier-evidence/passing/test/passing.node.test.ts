import { describe, expect, it } from "vitest";

describe("fixture passing behaviour test", () => {
  it("makes three passing assertions", () => {
    expect(1 + 1).toBe(2);
    expect("alpha").toBe("alpha");
    expect([1, 2, 3]).toHaveLength(3);
  });
});
