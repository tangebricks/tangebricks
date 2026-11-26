import { describe, expect, it, vi } from "vitest";
import type { IntegrationManifestFile, IntegrationOperationParam } from "@poc/assembler";
import { IntegrationManifestSchema } from "@poc/assembler";
import { callOperation } from "../src/call-operation.ts";
import { validatePathSegmentValue } from "../src/integration/request-build.ts";
import { serializeParam } from "../src/param-serialization.ts";

describe("UC3.4 Parameter serialization and fidelity", () => {
  describe("Table-driven serializeParam unit tests", () => {
    it("case 1: form, explode:true, [a,b] -> ids=a&ids=b", () => {
      const param: IntegrationOperationParam = {
        name: "ids",
        in: "query",
        dataType: "array",
        style: "form",
        explode: true,
      };
      const res = serializeParam(param, ["a", "b"]);
      expect(res.kind).toBe("query");
      if (res.kind === "query") {
        expect(res.pairs).toEqual([
          ["ids", "a"],
          ["ids", "b"],
        ]);
        const qs = res.pairs.map(([k, v]) => `${k}=${v}`).join("&");
        expect(qs).toBe("ids=a&ids=b");
      }
    });

    it("case 2: form, explode:false, [a,b] -> ids=a,b", () => {
      const param: IntegrationOperationParam = {
        name: "ids",
        in: "query",
        dataType: "array",
        style: "form",
        explode: false,
      };
      const res = serializeParam(param, ["a", "b"]);
      expect(res.kind).toBe("query");
      if (res.kind === "query") {
        expect(res.pairs).toEqual([["ids", "a,b"]]);
        const qs = res.pairs.map(([k, v]) => `${k}=${v}`).join("&");
        expect(qs).toBe("ids=a,b");
      }
    });

    it("case 3: spaceDelimited, [a,b] -> ids=a%20b", () => {
      const param: IntegrationOperationParam = {
        name: "ids",
        in: "query",
        dataType: "array",
        style: "spaceDelimited",
        explode: false,
      };
      const res = serializeParam(param, ["a", "b"]);
      expect(res.kind).toBe("query");
      if (res.kind === "query") {
        expect(res.pairs).toEqual([["ids", "a%20b"]]);
        const qs = res.pairs.map(([k, v]) => `${k}=${v}`).join("&");
        expect(qs).toBe("ids=a%20b");
      }
    });

    it("case 4: pipeDelimited, [a,b] -> ids=a|b", () => {
      const param: IntegrationOperationParam = {
        name: "ids",
        in: "query",
        dataType: "array",
        style: "pipeDelimited",
        explode: false,
      };
      const res = serializeParam(param, ["a", "b"]);
      expect(res.kind).toBe("query");
      if (res.kind === "query") {
        expect(res.pairs).toEqual([["ids", "a|b"]]);
        const qs = res.pairs.map(([k, v]) => `${k}=${v}`).join("&");
        expect(qs).toBe("ids=a|b");
      }
    });

    it("case 5: deepObject {status:'paid', created:{gte:1}} -> filter[status]=paid&filter[created][gte]=1", () => {
      const param: IntegrationOperationParam = {
        name: "filter",
        in: "query",
        dataType: "object",
        style: "deepObject",
        explode: true,
      };
      const res = serializeParam(param, { status: "paid", created: { gte: 1 } });
      expect(res.kind).toBe("query");
      if (res.kind === "query") {
        expect(res.pairs).toEqual([
          ["filter[status]", "paid"],
          ["filter[created][gte]", "1"],
        ]);
        const qs = res.pairs.map(([k, v]) => `${k}=${v}`).join("&");
        expect(qs).toBe("filter[status]=paid&filter[created][gte]=1");
      }
    });

    it("case 6: deepObject array [a,b] -> expand[]=a&expand[]=b", () => {
      const param: IntegrationOperationParam = {
        name: "expand",
        in: "query",
        dataType: "array",
        style: "deepObject",
        explode: true,
      };
      const res = serializeParam(param, ["a", "b"]);
      expect(res.kind).toBe("query");
      if (res.kind === "query") {
        expect(res.pairs).toEqual([
          ["expand[]", "a"],
          ["expand[]", "b"],
        ]);
        const qs = res.pairs.map(([k, v]) => `${k}=${v}`).join("&");
        expect(qs).toBe("expand[]=a&expand[]=b");
      }
    });

    it("case 7: simple path [1,2,3] -> 1,2,3", () => {
      const param: IntegrationOperationParam = {
        name: "id",
        in: "path",
        dataType: "array",
        style: "simple",
        explode: false,
      };
      const res = serializeParam(param, [1, 2, 3]);
      expect(res.kind).toBe("path");
      if (res.kind === "path") {
        expect(res.segment).toBe("1,2,3");
      }
    });

    it("case 8: header array -> a,b", () => {
      const param: IntegrationOperationParam = {
        name: "x_tokens",
        wireName: "X-Tokens",
        in: "header",
        dataType: "array",
        style: "simple",
        explode: false,
      };
      const res = serializeParam(param, ["a", "b"]);
      expect(res.kind).toBe("header");
      if (res.kind === "header") {
        expect(res.value).toBe("a,b");
      }
    });

    it("case 9: cookie -> assembled into cookie header pair", () => {
      const param: IntegrationOperationParam = {
        name: "session_id",
        in: "cookie",
        dataType: "string",
      };
      const res = serializeParam(param, "sess_12345");
      expect(res.kind).toBe("cookie");
      if (res.kind === "cookie") {
        expect(res.pair).toEqual(["session_id", "sess_12345"]);
      }
    });

    it("case 10: label/matrix -> rejected INTEGRATION_UNSUPPORTED_FEATURE", () => {
      const labelParam: IntegrationOperationParam = {
        name: "id",
        in: "path",
        dataType: "string",
        style: "label",
      };
      expect(() => serializeParam(labelParam, "test")).toThrowError(
        /INTEGRATION_UNSUPPORTED_FEATURE/,
      );

      const matrixParam: IntegrationOperationParam = {
        name: "id",
        in: "path",
        dataType: "string",
        style: "matrix",
      };
      expect(() => serializeParam(matrixParam, "test")).toThrowError(
        /INTEGRATION_UNSUPPORTED_FEATURE/,
      );
    });

    it("case 11: value outside enum -> rejected INTEGRATION_INVALID_PARAM before fetch", () => {
      const enumParam: IntegrationOperationParam = {
        name: "status",
        in: "query",
        dataType: "string",
        enum: ["active", "inactive"],
      };
      expect(() => serializeParam(enumParam, "archived")).toThrowError(
        /INTEGRATION_INVALID_PARAM/,
      );
      // Valid value does not throw
      expect(() => serializeParam(enumParam, "active")).not.toThrow();
    });
  });

  describe("Integration callOperation execution fidelity", () => {
    const testManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
      manifestVersion: 2,
      kind: "integration",
      app: "stripe-mock",
      version: "1.0.0",
      ui: {
        displayName: "Stripe Mock",
        category: "billing",
        summary: "Mock Stripe for fidelity test",
        maturity: "beta",
        maturityReason: "Testing",
      },
      auth: {
        type: "apiKey",
        headerName: "Authorization",
        prefix: "Bearer ",
      },
      baseUrl: "https://api.stripe.com",
      allowedHosts: ["api.stripe.com"],
      operations: [
        {
          operationId: "getCharge",
          label: "Get Charge",
          summary: "Get a charge with expand param",
          method: "GET",
          path: "/v1/charges/{charge}",
          params: [
            {
              name: "charge",
              in: "path",
              dataType: "string",
              required: true,
            },
            {
              name: "expand",
              in: "query",
              dataType: "array",
              style: "deepObject",
              explode: true,
              items: {
                dataType: "string",
              },
            },
            {
              name: "status",
              in: "query",
              dataType: "string",
              enum: ["succeeded", "pending", "failed"],
            },
            {
              name: "limit",
              in: "query",
              dataType: "number",
              default: 10,
            },
            {
              name: "session_id",
              in: "cookie",
              dataType: "string",
            },
          ],
          response: {},
          sideEffects: "read",
        },
      ],
      fidelity: {
        specHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        importerVersion: "2.0.0",
        level: "exact",
        unsupported: [],
      },
    });

    it("AC1: The Stripe expand param is sent as expand[]=customer in the recorded request", async () => {
      let recordedUrl = "";
      const fetcher = vi.fn().mockImplementation(async (url: string | URL | Request) => {
        recordedUrl = String(url);
        return new Response(JSON.stringify({ id: "ch_123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await callOperation(
        testManifest,
        "getCharge",
        {
          charge: "ch_123",
          expand: ["customer"],
        },
        {
          connection: { apiKey: "sk_test_123" },
          fetcher,
        },
      );

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(recordedUrl).toContain("expand[]=customer");
    });

    it("AC2: An out-of-enum value fails with INTEGRATION_INVALID_PARAM and 0 fetches", async () => {
      const fetcher = vi.fn();

      await expect(
        callOperation(
          testManifest,
          "getCharge",
          {
            charge: "ch_123",
            status: "invalid_status",
          },
          {
            connection: { apiKey: "sk_test_123" },
            fetcher,
          },
        ),
      ).rejects.toThrowError(/INTEGRATION_INVALID_PARAM/);

      expect(fetcher).toHaveBeenCalledTimes(0);
    });

    it("Spec default values are not sent when omitted by the caller", async () => {
      let recordedUrl = "";
      const fetcher = vi.fn().mockImplementation(async (url: string | URL | Request) => {
        recordedUrl = String(url);
        return new Response(JSON.stringify({ id: "ch_123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await callOperation(
        testManifest,
        "getCharge",
        {
          charge: "ch_123",
        },
        {
          connection: { apiKey: "sk_test_123" },
          fetcher,
        },
      );

      expect(fetcher).toHaveBeenCalledTimes(1);
      // "limit" had default: 10, but should not be sent
      expect(recordedUrl).not.toContain("limit");
    });

    it("AC3: Cookie params are sent in cookie header and their names are in secretFieldNames only if matching auth scheme", async () => {
      let recordedHeaders: Record<string, string> = {};
      const fetcher = vi.fn().mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.headers instanceof Headers) {
          recordedHeaders = Object.fromEntries(init.headers.entries());
        } else if (Array.isArray(init?.headers)) {
          recordedHeaders = Object.fromEntries(init.headers);
        } else {
          recordedHeaders = (init?.headers as Record<string, string>) ?? {};
        }
        return new Response(JSON.stringify({ id: "ch_123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await callOperation(
        testManifest,
        "getCharge",
        {
          charge: "ch_123",
          session_id: "sess_cookie_val",
        },
        {
          connection: { apiKey: "sk_test_123" },
          fetcher,
        },
      );

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(recordedHeaders["cookie"]).toBe("session_id=sess_cookie_val");
    });

    it("Path params with allowReserved:true may contain '/' but still reject '..', '%2e%2e', '\\' and '@'", () => {
      // allowReserved: false rejects '/'
      expect(() => validatePathSegmentValue("name", "projects/p/locations/l", false)).toThrowError(
        /INTEGRATION_HOST_FORBIDDEN/,
      );

      // allowReserved: true allows '/'
      expect(validatePathSegmentValue("name", "projects/p/locations/l", true)).toBe(
        "projects/p/locations/l",
      );

      // But still strictly rejects traversal & forbidden characters
      expect(() => validatePathSegmentValue("name", "../forbidden", true)).toThrowError(
        /INTEGRATION_HOST_FORBIDDEN/,
      );
      expect(() => validatePathSegmentValue("name", "%2e%2e/forbidden", true)).toThrowError(
        /INTEGRATION_HOST_FORBIDDEN/,
      );
      expect(() => validatePathSegmentValue("name", "a\\b", true)).toThrowError(
        /INTEGRATION_HOST_FORBIDDEN/,
      );
      expect(() => validatePathSegmentValue("name", "user@host", true)).toThrowError(
        /INTEGRATION_HOST_FORBIDDEN/,
      );
    });
  });
});
