import { describe, expect, it, vi } from "vitest";
import type { IntegrationManifestFile, IntegrationOperation } from "@poc/assembler";
import type { ExecutionContext } from "@poc/sdk";
import { redactTelemetryPayload, redactTelemetryString, REDACTED_PLACEHOLDER } from "@poc/telemetry";
import { createIntegrationOperationExecutor } from "../src/index.ts";

describe("UC1.5 — Manifest-derived redaction plus value-pattern scrubbing", () => {
  const privateTokenVal = "pvtok_secret_998877";
  const clientSecretVal = "cs_secret_445566";
  const stripeKey = "sk_" + "live_51Hxxxxxxxxxxxxxxxxxxxxxxx";
  const slackToken = "xox" + "b-1234-5678-abcdef";
  const githubPat = "ghp" + "_012345678901234567890123456789012345";
  const jwtToken = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc";
  const awsKey = "AKI" + "AIOSFODNN7EXAMPLE";

  const ALL_SECRETS = [
    privateTokenVal,
    clientSecretVal,
    stripeKey,
    slackToken,
    githubPat,
    jwtToken,
    awsKey,
  ];

  const manifest: IntegrationManifestFile = {
    manifestVersion: 2,
    kind: "integration",
    app: "custom_service",
    version: "1.0.0",
    ui: {
      displayName: "Custom Service",
      category: "developer",
      summary: "Custom service with custom auth header and sensitive param",
      maturity: "production",
    },
    auth: {
      type: "apiKey",
      in: "header",
      headerName: "PRIVATE-TOKEN",
    },
    baseUrl: "https://api.custom.example.com",
    allowedHosts: ["api.custom.example.com"],
    operations: [
      {
        operationId: "execute_action",
        label: "Execute Action",
        summary: "Execute action with sensitive param",
        method: "POST",
        path: "/v1/action",
        params: [
          {
            name: "x_client_secret",
            in: "header",
            dataType: "string",
            required: true,
            sensitive: true,
          },
        ],
        body: {
          contentType: "application/json",
          fields: [],
        },
        response: {
          dataPath: "data",
          outputs: [],
        },
        sideEffects: "write",
      },
    ],
    fidelity: {
      specHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      importerVersion: "2.0.0",
      level: "exact",
      unsupported: [],
    },
  };

  it("redacts auth.headerName, sensitive params, and value patterns from error messages and emitted logs on 400", async () => {
    const errorPayload = {
      err: "Bad Request",
      pt: privateTokenVal,
      cs: clientSecretVal,
      sk: stripeKey,
      sl: slackToken,
      gh: githubPat,
      jwt: jwtToken,
      ak: awsKey,
    };

    const fetcher = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify(errorPayload), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });

    const executor = createIntegrationOperationExecutor(
      manifest,
      manifest.operations[0]!,
      { fetcher, resolveHost: undefined },
    );

    const emittedLogs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    const ctx: ExecutionContext = { workspaceId: "ws_test",
      nodeId: "test_node_redaction",
      runId: "run_redaction_test",
      idempotencyKey: "run_redaction_test:test_node_redaction",
      data: {},
      inputs: {
        x_client_secret: clientSecretVal,
      },
      payload: {},
      secret: () => { throw new Error("not configured"); },
      binding: () => { throw new Error("not configured"); },
      connection: ((_name: unknown) => ({
        token: privateTokenVal,
      })) as ExecutionContext["connection"],
      log: {
        debug: async (message, fields) => { emittedLogs.push({ level: "debug", message, fields }); },
        info: async (message, fields) => { emittedLogs.push({ level: "info", message, fields }); },
        warn: async (message, fields) => { emittedLogs.push({ level: "warn", message, fields }); },
        error: async (message, fields) => { emittedLogs.push({ level: "error", message, fields }); },
      },
    };

    let thrownError: Error | undefined;
    try {
      await executor(ctx);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(thrownError).toBeDefined();
    const errorMessage = thrownError?.message ?? "";
    expect(errorMessage).toMatch(/INTEGRATION_HTTP_ERROR.*HTTP 400/);

    // None of the sensitive strings must appear in the thrown message
    for (const secret of ALL_SECRETS) {
      expect(
        errorMessage.includes(secret),
        `Expected error message not to leak secret "${secret}", but found it in: ${errorMessage}`,
      ).toBe(false);
    }

    // None of the sensitive strings must appear in emitted telemetry logs
    const fullLogsDump = JSON.stringify(emittedLogs);
    for (const secret of ALL_SECRETS) {
      expect(
        fullLogsDump.includes(secret),
        `Expected logs not to leak secret "${secret}", but found it in: ${fullLogsDump}`,
      ).toBe(false);
    }
  });

  it("redacts auth.headerName, sensitive params, and value patterns in redactTelemetryPayload", () => {
    const output = {
      data: {
        token: privateTokenVal,
        x_client_secret: clientSecretVal,
        note: `Upstream error with ${stripeKey} and slack ${slackToken}`,
        nested: {
          pat: githubPat,
          session: jwtToken,
          credentials: awsKey,
        },
      },
      safeField: "public_information",
    };

    const scrubbed = redactTelemetryPayload(output, {
      secretValues: new Set([privateTokenVal, clientSecretVal]),
      secretFieldNames: new Set(["private-token", "x_client_secret"]),
    }) as typeof output;

    const dump = JSON.stringify(scrubbed);
    for (const secret of ALL_SECRETS) {
      expect(
        dump.includes(secret),
        `Expected redacted payload not to leak "${secret}", but found it in: ${dump}`,
      ).toBe(false);
    }
    expect(scrubbed.safeField).toBe("public_information");
    expect(dump).toContain(REDACTED_PLACEHOLDER);
  });

  it("redacts all SECRET_VALUE_PATTERNS in redactTelemetryString while preserving UUIDs, ISO dates, and 40-hex SHAs (AC2, AC3)", () => {
    // Test each pattern
    const testCases = [
      { name: "JWT", input: `token ${jwtToken}` },
      { name: "sk_live", input: `key ${stripeKey}` },
      { name: "sk_test", input: `key sk_${""}test_51Hxxxxxxxxxxxxxxxxxxxxxxx` },
      { name: "rk_live", input: `restricted rk_${""}live_51Hxxxxxxxxxxxxxxxxxxxxxxx` },
      { name: "rk_test", input: `restricted rk_${""}test_51Hxxxxxxxxxxxxxxxxxxxxxxx` },
      { name: "whsec", input: `webhook whs${""}ec_99999999999999999999999999999999` },
      { name: "xoxb", input: `slack ${slackToken}` },
      { name: "xoxp", input: `slack xox${""}p-1234567890-1234567890-1234567890-abcdef` },
      { name: "ghp", input: `github ${githubPat}` },
      { name: "github_pat", input: `github git${""}hub_pat_11AAAAAAA0000000000000_123456789012345678901234567890` },
      { name: "AKIA", input: `aws ${awsKey}` },
      { name: "AIza", input: `google AIz${""}aSyA12345678901234567890123456789012` },
      { name: "PEM", input: `cert ---${""}--BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----` },
    ];

    for (const tc of testCases) {
      const result = redactTelemetryString(tc.input);
      expect(result).not.toContain(tc.input);
      expect(result).toMatch(/\[REDACTED:[a-z_]+\]/);
    }

    // AC3: False-positive guard - UUIDs, ISO dates, and 40-hex SHAs are preserved
    const safeUuid = "123e4567-e89b-12d3-a456-426614174000";
    const safeIsoDate = "2026-11-04T12:00:00.000Z";
    const safe40HexSha = "bf2d7f1156cb97f74b139e17fb783f2dbe817254";

    const nonSecretString = `commit ${safe40HexSha} at ${safeIsoDate} for task ${safeUuid}`;
    const preservedResult = redactTelemetryString(nonSecretString);

    expect(preservedResult).toBe(nonSecretString);
    expect(preservedResult).toContain(safeUuid);
    expect(preservedResult).toContain(safeIsoDate);
    expect(preservedResult).toContain(safe40HexSha);
  });
});
