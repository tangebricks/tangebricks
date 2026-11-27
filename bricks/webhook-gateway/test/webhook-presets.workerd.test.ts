import { describe, expect, it } from "vitest";
import { PRESETS } from "../src/presets.ts";
import { verifyWithScheme } from "../src/signature-scheme.ts";
import discordFixture from "./fixtures/webhook-vectors/discord.json";
import githubFixture from "./fixtures/webhook-vectors/github.json";
import metaFixture from "./fixtures/webhook-vectors/meta.json";
import slackFixture from "./fixtures/webhook-vectors/slack.json";
import stripeFixture from "./fixtures/webhook-vectors/stripe.json";
import timestampBodyBase64Fixture from "./fixtures/webhook-vectors/timestamp-body-base64.json";
import gatewaySource from "../src/gateway.ts?raw";
import signatureSchemeSource from "../src/signature-scheme.ts?raw";

interface WebhookVectorCase {
  name: string;
  preset: string;
  secret: string;
  headers: Record<string, string>;
  rawBody: string;
  nowSeconds?: number;
  expect: "ok" | string;
  provenance?: {
    source: string;
    generationCommand?: string;
    docUrl?: string;
  };
}

interface WebhookVectorFixture {
  preset: string;
  provenance: {
    source: string;
    generationCommand?: string;
    docUrl?: string;
  };
  cases?: WebhookVectorCase[];
  [key: string]: unknown;
}

const fixtures: WebhookVectorFixture[] = [
  stripeFixture as unknown as WebhookVectorFixture,
  githubFixture as unknown as WebhookVectorFixture,
  metaFixture as unknown as WebhookVectorFixture,
  slackFixture as unknown as WebhookVectorFixture,
  discordFixture as unknown as WebhookVectorFixture,
  timestampBodyBase64Fixture as unknown as WebhookVectorFixture,
];

describe("Story UC4.3 — Presets and known-answer vectors", () => {
  describe("AC1: At least 3 vectors per preset (1 valid, at least 2 invalid) with provenance", () => {
    for (const fixture of fixtures) {
      const cases: WebhookVectorCase[] = Array.isArray(fixture.cases)
        ? fixture.cases
        : [
            {
              name: "default case",
              preset: fixture.preset,
              secret: String(fixture.secret ?? ""),
              headers: (fixture.headers as Record<string, string>) ?? {},
              rawBody: String(fixture.rawBody ?? ""),
              nowSeconds: fixture.nowSeconds as number | undefined,
              expect: (fixture.expect as string) ?? "ok",
              provenance: fixture.provenance,
            },
          ];

      describe(`Preset: ${fixture.preset}`, () => {
        it("contains at least 3 vectors (1 valid, at least 2 invalid) and top-level provenance", () => {
          expect(fixture.provenance).toBeDefined();
          expect(fixture.provenance.source).toBeDefined();
          expect(fixture.provenance.source.length).toBeGreaterThan(0);

          const validCases = cases.filter((c) => c.expect === "ok");
          const invalidCases = cases.filter((c) => c.expect !== "ok");

          expect(cases.length).toBeGreaterThanOrEqual(3);
          expect(validCases.length).toBeGreaterThanOrEqual(1);
          expect(invalidCases.length).toBeGreaterThanOrEqual(2);

          for (const vc of validCases) {
            expect(vc.provenance).toBeDefined();
            expect(vc.provenance?.source).toBeDefined();
            expect(vc.provenance?.source.length).toBeGreaterThan(0);
          }
        });

        for (const testCase of cases) {
          it(`verifies case "${testCase.name}" -> ${testCase.expect}`, async () => {
            const scheme = (PRESETS as Record<string, any>)?.[testCase.preset];
            expect(scheme).toBeDefined();

            const res = await verifyWithScheme(scheme, { rawBody: testCase.rawBody, headers: testCase.headers }, testCase.secret, testCase.nowSeconds);

            if (testCase.expect === "ok") {
              expect(res.ok).toBe(true);
            } else {
              expect(res.ok).toBe(false);
              if (!res.ok) {
                expect(res.reason).toBe(testCase.expect);
              }
            }
          });
        }
      });
    }
  });

  describe("AC2: Slack docs and GitHub docs examples verify with presets", () => {
    it("Slack docs example verifies with preset slack-v0", async () => {
      const slackScheme = (PRESETS as Record<string, any>)?.["slack-v0"];
      expect(slackScheme).toBeDefined();

      const slackCase = (slackFixture as unknown as WebhookVectorFixture).cases?.find((c) => c.name === "valid Slack docs example");
      expect(slackCase).toBeDefined();

      const res = await verifyWithScheme(slackScheme, { rawBody: slackCase!.rawBody, headers: slackCase!.headers }, slackCase!.secret, slackCase!.nowSeconds);
      expect(res.ok).toBe(true);
    });

    it("GitHub docs example verifies with preset github-hmac-sha256", async () => {
      const ghScheme = (PRESETS as Record<string, any>)?.["github-hmac-sha256"];
      expect(ghScheme).toBeDefined();

      const ghCase = (githubFixture as unknown as WebhookVectorFixture).cases?.find((c) => c.name === "valid GitHub docs example");
      expect(ghCase).toBeDefined();

      const res = await verifyWithScheme(ghScheme, { rawBody: ghCase!.rawBody, headers: ghCase!.headers }, ghCase!.secret, ghCase!.nowSeconds);
      expect(res.ok).toBe(true);
    });
  });

  describe("AC3: No provider names in gateway.ts or signature-scheme.ts", () => {
    it("checks that gateway.ts and signature-scheme.ts contain 0 occurrences of provider names", () => {
      const forbiddenPattern = /\b(cashfree|slack|discord|stripe|github)\b/i;

      const gatewayMatches: string[] = [];
      const linesGateway = gatewaySource.split("\n");
      linesGateway.forEach((line, idx) => {
        if (forbiddenPattern.test(line)) {
          gatewayMatches.push(`gateway.ts:${idx + 1}: ${line.trim()}`);
        }
      });

      const signatureSchemeMatches: string[] = [];
      const linesSignatureScheme = signatureSchemeSource.split("\n");
      linesSignatureScheme.forEach((line, idx) => {
        if (forbiddenPattern.test(line)) {
          signatureSchemeMatches.push(`signature-scheme.ts:${idx + 1}: ${line.trim()}`);
        }
      });

      expect(gatewayMatches).toEqual([]);
      expect(signatureSchemeMatches).toEqual([]);
    });
  });
});
