import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

describe("UC3.9 — Typed gateway adapter pattern: static architecture checks", () => {
  it("AC1 — bricks/credit-wallet/src/** has no import of @poc/runtime or integrations/*", () => {
    const srcDir = resolve(repoRoot, "bricks/credit-wallet/src");
    const files: string[] = [];

    function traverse(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          traverse(full);
        } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
          files.push(full);
        }
      }
    }
    traverse(srcDir);

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expect(content, `${file} must not import @poc/runtime`).not.toMatch(/@poc\/runtime/);
      expect(content, `${file} must not import from integrations/`).not.toMatch(/from\s+["'].*integrations\//);
    }
  });

  it("AC2 — the adapter contains no fetch(, URL building, or header code", () => {
    const adapterFile = resolve(__dirname, "../src/stripe-payment-gateway.ts");
    const content = readFileSync(adapterFile, "utf8");

    // No fetch calls
    expect(content, "adapter must not call fetch()").not.toMatch(/\bfetch\s*\(/);
    // No URL or URLSearchParams construction
    expect(content, "adapter must not construct new URL").not.toMatch(/\bnew\s+URL\b/);
    expect(content, "adapter must not construct new URLSearchParams").not.toMatch(/\bnew\s+URLSearchParams\b/);
    expect(content, "adapter must not contain http(s) URL literals").not.toMatch(/https?:\/\//);
    // No direct HTTP header setting or Idempotency-Key header literal
    expect(content, "adapter must not mention Idempotency-Key directly (handled by callOperation)").not.toMatch(/Idempotency-Key/i);
    expect(content, "adapter must not set headers directly").not.toMatch(/\bheaders\b/);
  });
});
