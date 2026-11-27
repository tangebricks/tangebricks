import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WH_SRC = join(ROOT, "bricks", "webhook-gateway", "src");

describe("UC4.6 — Refactor sweep (UC4)", () => {
  it("AC1: grep for verifyHmacSignature and verifyStripeSignature in bricks/webhook-gateway/src returns nothing", () => {
    const hits: { file: string; line: number; text: string }[] = [];

    function scan(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
          const lines = readFileSync(full, "utf8").split(/\r?\n/);
          lines.forEach((line, idx) => {
            if (/verifyHmacSignature|verifyStripeSignature/.test(line)) {
              hits.push({
                file: full.replace(/\\/g, "/"),
                line: idx + 1,
                text: line.trim(),
              });
            }
          });
        }
      }
    }

    scan(WH_SRC);
    expect(hits, `Expected no occurrences of verifyHmacSignature or verifyStripeSignature in ${WH_SRC}, but found: ${JSON.stringify(hits, null, 2)}`).toEqual(
      [],
    );
  });

  it("Task 2: superseded helpers are not exported from crypto.ts or index.ts, while required sign helpers remain", async () => {
    const cryptoModule = await import("../../bricks/webhook-gateway/src/crypto.ts");
    const indexModule = await import("../../bricks/webhook-gateway/src/index.ts");

    // Superseded helpers must NOT be exported
    expect((cryptoModule as Record<string, unknown>).verifyHmacSignature, "verifyHmacSignature must not be exported from crypto.ts").toBeUndefined();
    expect((cryptoModule as Record<string, unknown>).verifyStripeSignature, "verifyStripeSignature must not be exported from crypto.ts").toBeUndefined();
    expect((indexModule as Record<string, unknown>).verifyHmacSignature, "verifyHmacSignature must not be exported from index.ts").toBeUndefined();
    expect((indexModule as Record<string, unknown>).verifyStripeSignature, "verifyStripeSignature must not be exported from index.ts").toBeUndefined();

    // Required sign helpers used by tests must remain exported
    expect(typeof cryptoModule.signHmacSha256).toBe("function");
    expect(typeof cryptoModule.signStripeWebhookPayload).toBe("function");
  });

  it("Task 2: WebhookVerifierType in gateway.ts is not a plain string type", () => {
    const gatewaySrc = readFileSync(join(WH_SRC, "gateway.ts"), "utf8");
    const verifierTypeMatch = gatewaySrc.match(/export type WebhookVerifierType\s*=\s*([^;]+);/);
    expect(verifierTypeMatch, "WebhookVerifierType type alias should exist").not.toBeNull();
    const typeDef = verifierTypeMatch![1]!.trim();
    expect(
      typeDef,
      "WebhookVerifierType must not be a plain string type, but use schema type (PresetName | WebhookSignatureScheme or WebhookVerifierPreset | WebhookSignatureScheme)",
    ).not.toBe("string");
  });
});
