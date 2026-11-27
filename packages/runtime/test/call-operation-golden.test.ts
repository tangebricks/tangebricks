import { describe, expect, it } from "vitest";
import type { IntegrationManifestFile, IntegrationOperation } from "@poc/assembler";
import { callOperation } from "../src/index.ts";
import type { IntegrationFetcher } from "../src/index.ts";

import stripeManifest from "../../../integrations/stripe/integration.json";
import githubManifest from "../../../integrations/github/integration.json";
import discordManifest from "../../../integrations/discord/integration.json";
import slackManifest from "../../../integrations/slack/integration.json";
import googleManifest from "../../../integrations/google/integration.json";
import expectedGolden from "./golden/call-operation-golden.json";

import executorSource from "../src/integration-executor.ts?raw";
import authSource from "../src/integration/auth.ts?raw";
import bodyEncodingSource from "../src/integration/body-encoding.ts?raw";
import errorsSource from "../src/integration/errors.ts?raw";
import paginationSource from "../src/integration/pagination.ts?raw";
import paramSerializationSource from "../src/integration/param-serialization.ts?raw";
import redactionSource from "../src/integration/redaction.ts?raw";
import requestBuildSource from "../src/integration/request-build.ts?raw";
import responseDecodingSource from "../src/integration/response-decoding.ts?raw";
import retrySource from "../src/integration/retry.ts?raw";

interface RecordedOp {
  app: string;
  op: string;
  method: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  } | null;
  error: string | null;
}

const PACKS: Array<{ name: string; manifest: IntegrationManifestFile }> = [
  { name: "stripe", manifest: stripeManifest as unknown as IntegrationManifestFile },
  { name: "github", manifest: githubManifest as unknown as IntegrationManifestFile },
  { name: "discord", manifest: discordManifest as unknown as IntegrationManifestFile },
  { name: "slack", manifest: slackManifest as unknown as IntegrationManifestFile },
  { name: "google", manifest: googleManifest as unknown as IntegrationManifestFile },
];

function generateSyntheticArgs(op: IntegrationOperation): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const p of op.params ?? []) {
    const dt = p.dataType as unknown as string;
    if (dt === "number" || dt === "integer") args[p.name] = 1;
    else if (dt === "boolean") args[p.name] = true;
    else if (dt === "array") args[p.name] = ["test"];
    else if (dt === "object") args[p.name] = { key: "val" };
    else args[p.name] = "test";
  }
  if (op.body?.fields) {
    for (const f of op.body.fields) {
      const dt = f.dataType as unknown as string;
      if (dt === "number" || dt === "integer") args[f.name] = 1;
      else if (dt === "boolean") args[f.name] = true;
      else if (dt === "array") args[f.name] = ["test"];
      else if (dt === "object") args[f.name] = { key: "val" };
      else args[f.name] = "test";
    }
  }
  return args;
}

describe("UC3.10 — Refactor sweep (UC3)", () => {
  describe("AC1: Golden request recordings across all 61 pack ops are byte-identical", () => {
    it("executes all 61 operations across the 5 packs and matches golden recordings exactly", async () => {
      const actualRecordings: RecordedOp[] = [];

      for (const { name, manifest } of PACKS) {
        for (const op of manifest.operations) {
          let captured: RecordedOp["request"] = null;
          let thrown: string | null = null;

          const fetcher: IntegrationFetcher = async (url, init) => {
            const headers: Record<string, string> = {};
            const h = new Headers(init?.headers);
            for (const k of Array.from(h.keys()).sort()) {
              headers[k] = h.get(k)!;
            }
            let body: string | null = null;
            if (typeof init?.body === "string") {
              body = init.body;
            } else if (init?.body instanceof Uint8Array) {
              body = new TextDecoder().decode(init.body);
            }
            captured = {
              url: String(url),
              method: init?.method ?? "GET",
              headers,
              body,
            };
            return new Response(JSON.stringify({ ok: true, data: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          };

          const syntheticArgs = generateSyntheticArgs(op);
          try {
            await callOperation(manifest, op.operationId, syntheticArgs, {
              connection: {
                token: "golden_token_123",
                apiKey: "golden_key_123",
                accessToken: "golden_token_123",
              },
              fetcher,
            });
          } catch (err) {
            thrown = err instanceof Error ? err.message : String(err);
          }

          actualRecordings.push({
            app: name,
            op: op.operationId,
            method: op.method,
            request: captured,
            error: thrown,
          });
        }
      }

      expect(actualRecordings.length).toBe(61);
      expect(actualRecordings).toEqual(expectedGolden);
    });
  });

  describe("AC2: Line counts and modular decomposition constraints", () => {
    it("packages/runtime/src/integration-executor.ts line count is <= 300 lines", () => {
      const lines = executorSource.split(/\r?\n/).length;
      expect(lines, `integration-executor.ts must be <= 300 lines (actual: ${lines})`).toBeLessThanOrEqual(300);
    });

    it("no file in packages/runtime/src/integration/* is > 350 lines", () => {
      const integrationFiles: Record<string, string> = {
        "auth.ts": authSource,
        "body-encoding.ts": bodyEncodingSource,
        "errors.ts": errorsSource,
        "pagination.ts": paginationSource,
        "param-serialization.ts": paramSerializationSource,
        "redaction.ts": redactionSource,
        "request-build.ts": requestBuildSource,
        "response-decoding.ts": responseDecodingSource,
        "retry.ts": retrySource,
      };

      for (const [filename, source] of Object.entries(integrationFiles)) {
        const fileLines = source.split(/\r?\n/).length;
        expect(fileLines, `${filename} must be <= 350 lines (actual: ${fileLines})`).toBeLessThanOrEqual(350);
      }
    });

    it("split modules exist under packages/runtime/src/integration/ and export their responsibilities", async () => {
      // Dynamic imports to verify split modules exist and export expected functions
      const authMod = await import("../src/integration/auth.ts");
      expect(typeof authMod.applyConnectionAuth).toBe("function");

      const bodyMod = await import("../src/integration/body-encoding.ts");
      expect(typeof bodyMod.encodeRequestBody).toBe("function");

      const pagMod = await import("../src/integration/pagination.ts");
      expect(typeof pagMod.parseLinkNextUrl).toBe("function");

      const respMod = await import("../src/integration/response-decoding.ts");
      expect(typeof respMod.decodeResponseBody).toBe("function");

      const paramMod = await import("../src/integration/param-serialization.ts");
      expect(typeof paramMod.serializeParam).toBe("function");
    });
  });

  describe("AC3: fidelity.unsupported lists contain only codes that no UC3 story covers", () => {
    it("verifies 5 pack manifests have only uncovered codes in fidelity.unsupported", () => {
      const UC3_COVERED_CODES = new Set([
        "RESPONSE_SCHEMA_IGNORED",
        "BODY_FIELD_CAPPED",
        "BODY_REQUIRED_FIELD_CAPPED",
        "SWAGGER2_BODY_DROPPED",
        "CONTENT_TYPE_UNSUPPORTED",
        "PARAM_STYLE_UNHONOURED",
        "PARAM_LOCATION_UNSUPPORTED",
        "PATH_PLACEHOLDER_PARAM_MISMATCH",
        "OP_METHOD_COERCED_GET",
        "BODY_NESTED_FLATTENED",
        "BODY_COMPOSED_DROPPED",
      ]);

      for (const { name, manifest } of PACKS) {
        const unsupported = manifest.fidelity?.unsupported ?? [];
        for (const entry of unsupported) {
          expect(UC3_COVERED_CODES.has(entry.code), `Pack ${name} operation ${entry.op} contains unsupported code ${entry.code} which was covered by UC3`).toBe(
            false,
          );
        }
      }
    });
  });
});
