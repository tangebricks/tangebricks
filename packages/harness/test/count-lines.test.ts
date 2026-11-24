import { describe, expect, test } from "vitest";
import { countCodeLines } from "../src/index.ts";

describe("countCodeLines (the H1 counting rule)", () => {
  test("skips blank lines and comment-only lines", () => {
    const source = ["", "// note", "const a = 1;", "   ", "  // another", "const b = 2;"].join("\n");
    expect(countCodeLines(source)).toBe(2);
  });

  test("counts a code line that has a trailing comment", () => {
    expect(countCodeLines("const a = 1; // why")).toBe(1);
  });

  test("skips multi-line block comments but counts code after one closes", () => {
    const source = ["/*", " * header", " */", "const a = 1;", "/* open", "still comment */ const b = 2;"].join("\n");
    expect(countCodeLines(source)).toBe(2);
  });

  test("skips a one-line doc comment", () => {
    expect(countCodeLines("/** doc */\nconst a = 1;")).toBe(1);
  });

  test("handles Windows line endings", () => {
    expect(countCodeLines("const a = 1;\r\n// c\r\nconst b = 2;\r\n")).toBe(2);
  });
});
