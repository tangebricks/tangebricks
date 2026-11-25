// .tsx like the other studio-web tests, so only the jsdom (dom) project picks it up, not the workers project.
import { describe, expect, it } from "vitest";
import { safeHref } from "../src/safe-href.ts";

describe("safeHref (PROPOSED-12 / C7): server-supplied hrefs are rendered only when http(s)", () => {
  it("returns http and https URLs unchanged", () => {
    const cf = "https://dash.cloudflare.com/profile/api-tokens?name=ProjectX+Studio+Deploy";
    expect(safeHref(cf)).toBe(cf);
    expect(safeHref("http://localhost:8787/x")).toBe("http://localhost:8787/x");
    expect(safeHref("HTTPS://EXAMPLE.COM/")).toBe("HTTPS://EXAMPLE.COM/");
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["mixed-case javascript:", "JaVaScRiPt:alert(1)"],
    ["javascript: with leading whitespace", "  javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["relative path", "/profile/api-tokens"],
    ["protocol-relative", "//evil.example/x"],
    ["garbage", "not a url at all"],
    ["empty", ""],
    ["whitespace", "   "],
    ["undefined", undefined],
    ["null", null],
  ])("refuses %s", (_label, input) => {
    expect(safeHref(input)).toBeUndefined();
  });
});
