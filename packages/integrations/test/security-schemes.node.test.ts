import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IntegrationAuthSchema, IntegrationManifestSchema } from "@poc/assembler";
import { analyzeSpec, importIntegrationSpec } from "../src/index.ts";

const FIXTURES_DIR = resolve(__dirname, "fixtures/security");

function loadFixture(name: string): Record<string, unknown> {
  const p = resolve(FIXTURES_DIR, `${name}.openapi.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("Story UC3.3 — Security schemes, auth requirements model, and curation validation", () => {
  it("imports stripe-min: extracts schemes and 2 alternative requirements, reports mapped AUTH_SCHEME for bearerAuth (AC2)", () => {
    const spec = loadFixture("stripe-min");
    const result = importIntegrationSpec({
      spec,
      curation: {
        app: "stripe",
        specProvenance: "upstream",
        ui: {
          displayName: "Stripe",
          category: "billing",
          summary: "Stripe payments",
          maturity: "beta",
          maturityReason: "test",
          behaviourTest: "test/stripe.test.ts",
        },
        auth: {
          type: "oauth2",
          headerName: "Authorization",
          prefix: "Bearer",
        },
        baseUrl: "https://api.stripe.com",
        allowedHosts: ["api.stripe.com"],
      },
      format: "openapi3",
    });

    // manifest.auth.schemes and manifest.auth.requirements must match spec
    expect(result.manifest.auth.schemes).toEqual({
      basicAuth: {
        type: "http",
        scheme: "basic",
      },
      bearerAuth: {
        type: "http",
        scheme: "bearer",
      },
    });
    expect(result.manifest.auth.requirements).toEqual([[{ scheme: "basicAuth" }], [{ scheme: "bearerAuth" }]]);

    // Curation satisfies bearerAuth alternative -> mapped AUTH_SCHEME
    const authReport = result.report.entries.find((e) => e.element === "auth" && e.code === "AUTH_SCHEME");
    expect(authReport).toBeDefined();
    expect(authReport?.status).toBe("mapped");
  });

  it("imports cashfree-pg-min: extracts composite header auth requirements and satisfies with multi-header curation", () => {
    const spec = loadFixture("cashfree-pg-min");
    const result = importIntegrationSpec({
      spec,
      curation: {
        app: "cashfree",
        specProvenance: "upstream",
        ui: {
          displayName: "Cashfree",
          category: "billing",
          summary: "Cashfree payments",
          maturity: "beta",
          maturityReason: "test",
          behaviourTest: "test/cashfree.test.ts",
        },
        auth: {
          type: "headers",
          headers: {
            "x-client-id": "{{conn.clientId}}",
            "x-client-secret": "{{conn.clientSecret}}",
            "x-api-version": "2023-08-01",
          },
        },
        baseUrl: "https://sandbox.cashfree.com/pg",
        allowedHosts: ["sandbox.cashfree.com"],
      },
      format: "openapi3",
    });

    expect(result.manifest.auth.schemes).toEqual({
      XClientId: {
        type: "apiKey",
        name: "x-client-id",
        in: "header",
      },
      XClientSecret: {
        type: "apiKey",
        name: "x-client-secret",
        in: "header",
      },
      XApiVersion: {
        type: "apiKey",
        name: "x-api-version",
        in: "header",
      },
    });
    expect(result.manifest.auth.requirements).toEqual([[{ scheme: "XClientId" }, { scheme: "XClientSecret" }, { scheme: "XApiVersion" }]]);

    const authReport = result.report.entries.find((e) => e.element === "auth" && e.code === "AUTH_SCHEME");
    expect(authReport).toBeDefined();
    expect(authReport?.status).toBe("mapped");
  });

  it("imports discord-min: satisfies BotToken apiKey header alternative", () => {
    const spec = loadFixture("discord-min");
    const result = importIntegrationSpec({
      spec,
      curation: {
        app: "discord",
        specProvenance: "upstream",
        ui: {
          displayName: "Discord",
          category: "communication",
          summary: "Discord bot",
          maturity: "beta",
          maturityReason: "test",
          behaviourTest: "test/discord.test.ts",
        },
        auth: {
          type: "apiKey",
          headerName: "Authorization",
          prefix: "Bot",
        },
        baseUrl: "https://discord.com/api/v10",
        allowedHosts: ["discord.com"],
      },
      format: "openapi3",
    });

    expect(result.manifest.auth.schemes?.BotToken).toEqual({
      type: "apiKey",
      name: "Authorization",
      in: "header",
    });
    expect(result.manifest.auth.schemes?.OAuth2).toEqual({
      type: "oauth2",
    });

    const authReport = result.report.entries.find((e) => e.element === "auth" && e.code === "AUTH_SCHEME");
    expect(authReport).toBeDefined();
    expect(authReport?.status).toBe("mapped");
  });

  it("handles public-op: maps security: [] as AUTH_NONE, and cookie-apiKey as unsupported AUTH_SCHEME_UNSUPPORTED with blocking:true", () => {
    const spec = loadFixture("public-op");
    const report = analyzeSpec({
      spec,
      format: "openapi3",
      appName: "public-api",
      curation: {
        app: "public-api",
        specProvenance: "upstream",
        ui: {
          displayName: "Public API",
          category: "developer",
          summary: "test",
          maturity: "beta",
        },
        auth: {
          type: "oauth2",
        },
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
      },
    });

    // Public op getHealth has security: [] -> mapped AUTH_NONE
    const publicReport = report.entries.find((e) => e.op === "getHealth" && e.code === "AUTH_NONE");
    expect(publicReport).toBeDefined();
    expect(publicReport?.status).toBe("mapped");

    // Cookie auth op checkSession -> unsupported AUTH_SCHEME_UNSUPPORTED with blocking: true
    const cookieReport = report.entries.find((e) => e.op === "checkSession" && e.code === "AUTH_SCHEME_UNSUPPORTED");
    expect(cookieReport).toBeDefined();
    expect(cookieReport?.status).toBe("unsupported");
    expect(cookieReport?.blocking).toBe(true);
  });

  it("reports curated AUTH_FROM_CURATION when curation scheme is not declared in spec", () => {
    const spec = loadFixture("stripe-min");
    const report = analyzeSpec({
      spec,
      format: "openapi3",
      appName: "stripe",
      curation: {
        app: "stripe",
        specProvenance: "upstream",
        ui: {
          displayName: "Stripe",
          category: "billing",
          summary: "test",
          maturity: "beta",
        },
        auth: {
          type: "apiKey",
          headerName: "x-api-custom",
        },
        baseUrl: "https://api.stripe.com",
        allowedHosts: ["api.stripe.com"],
      },
    });

    const curationReport = report.entries.find((e) => e.element === "auth" && e.code === "AUTH_FROM_CURATION");
    expect(curationReport).toBeDefined();
    expect(curationReport?.status).toBe("curated");
  });

  it("schema validation: AC3 validates templates in IntegrationAuthSchema and defaultHeaders in IntegrationManifestSchema", () => {
    // Valid {{conn.identifier}} placeholders are accepted
    const validAuth = IntegrationAuthSchema.safeParse({
      type: "headers",
      headers: {
        "x-client-id": "{{conn.clientId}}",
        "x-api-version": "2023-08-01",
      },
    });
    expect(validAuth.success).toBe(true);

    // Expressions outside {{conn.identifier}} grammar are rejected (AC3)
    const invalidAuth1 = IntegrationAuthSchema.safeParse({
      type: "headers",
      headers: {
        "x-calc": "{{1 + 1}}",
      },
    });
    expect(invalidAuth1.success).toBe(false);

    const invalidAuth2 = IntegrationAuthSchema.safeParse({
      type: "headers",
      headers: {
        "x-conn": "{{conn.a + conn.b}}",
      },
    });
    expect(invalidAuth2.success).toBe(false);

    const invalidAuth3 = IntegrationAuthSchema.safeParse({
      type: "headers",
      headers: {
        "x-naked": "{{someVar}}",
      },
    });
    expect(invalidAuth3.success).toBe(false);

    // Manifest defaultHeaders validation:
    // Disallowed headers (authorization, cookie, host, content-length) are rejected
    for (const forbidden of ["authorization", "Authorization", "cookie", "Cookie", "host", "Host", "content-length", "Content-Length"]) {
      const parsed = IntegrationManifestSchema.safeParse({
        manifestVersion: 2,
        kind: "integration",
        app: "test-app",
        version: "1.0.0",
        ui: {
          displayName: "Test",
          summary: "Test",
          maturity: "beta",
          maturityReason: "test",
          behaviourTest: "test/test.test.ts",
        },
        auth: { type: "none" },
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
        defaultHeaders: {
          [forbidden]: "some-value",
        },
        operations: [
          {
            operationId: "testOp",
            label: "Test Op",
            method: "GET",
            path: "/test",
            response: {},
            sideEffects: "none",
          },
        ],
        fidelity: {
          specHash: "sha256:" + "0".repeat(64),
          importerVersion: "2.0.0",
          level: "exact",
          unsupported: [],
        },
      });
      expect(parsed.success).toBe(false);
    }

    // defaultHeaders with {{ templates are rejected
    const templateInDefaultHeaders = IntegrationManifestSchema.safeParse({
      manifestVersion: 2,
      kind: "integration",
      app: "test-app",
      version: "1.0.0",
      ui: {
        displayName: "Test",
        summary: "Test",
        maturity: "beta",
        maturityReason: "test",
        behaviourTest: "test/test.test.ts",
      },
      auth: { type: "none" },
      baseUrl: "https://api.example.com",
      allowedHosts: ["api.example.com"],
      defaultHeaders: {
        "x-api-version": "{{conn.version}}",
      },
      operations: [
        {
          operationId: "testOp",
          label: "Test Op",
          method: "GET",
          path: "/test",
          response: {},
          sideEffects: "none",
        },
      ],
      fidelity: {
        specHash: "sha256:" + "0".repeat(64),
        importerVersion: "2.0.0",
        level: "exact",
        unsupported: [],
      },
    });
    expect(templateInDefaultHeaders.success).toBe(false);
  });
});
