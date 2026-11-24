import { describe, expect, it } from "vitest";
import * as assembler from "@poc/assembler";
import type { IntegrationManifestFile } from "@poc/assembler";
import {
  callOperation,
  createIntegrationOperationExecutor,
  IntegrationCallError,
} from "../src/index.ts";

describe("UC3.8: integration response semantics and pagination", () => {
  const baseUi = {
    displayName: "Test App",
    category: "testing",
    summary: "Response semantics testing",
    maturity: "beta" as const,
    maturityReason: "Test fixture",
    behaviourTest: "packages/runtime/test/integration-response-semantics.test.ts",
  };

  const baseAuth = {
    type: "none" as const,
  };

  describe("errorWhen and successWhen predicates", () => {
    it("HTTP 200 {ok:false, error:'channel_not_found'} with errorWhen:{path:'ok', equals:false} and errorShape.codePath:'error' rejects INTEGRATION_PROVIDER_ERROR with providerCode:'channel_not_found'", async () => {
      const manifest: IntegrationManifestFile = {
        manifestVersion: 2,
        kind: "integration",
        app: "slack",
        version: "1.0.0",
        ui: baseUi,
        auth: baseAuth,
        baseUrl: "https://api.slack.com",
        allowedHosts: ["api.slack.com"],
        operations: [
          {
            operationId: "getChannel",
            label: "Get Channel",
            method: "GET",
            path: "/api/conversations.info",
            errorWhen: { path: "ok", equals: false },
            response: {
              errorShape: {
                codePath: "error",
              },
            },
            sideEffects: "read",
          },
        ],
      } as any;

      const fetcher = async () =>
        new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      await expect(
        callOperation(manifest, "getChannel", {}, { connection: null, fetcher }),
      ).rejects.toMatchObject({
        code: "INTEGRATION_PROVIDER_ERROR",
        providerCode: "channel_not_found",
      });

      // Node wrapper (AC2)
      const executor = createIntegrationOperationExecutor(manifest, manifest.operations[0]!, {
        fetcher,
      });
      await expect(
        executor({
          nodeId: "n1",
          runId: "r1",
          idempotencyKey: "k1",
          data: {},
          inputs: {},
          payload: {},
          connection: null as any,
          secret: () => "",
          binding: () => ({} as any),
        }),
      ).rejects.toThrow(/INTEGRATION_PROVIDER_ERROR/);
    });

    it("manifest-level errorWhen applies as default to operations", async () => {
      const manifest: IntegrationManifestFile = {
        manifestVersion: 2,
        kind: "integration",
        app: "slack",
        version: "1.0.0",
        ui: baseUi,
        auth: baseAuth,
        baseUrl: "https://api.slack.com",
        allowedHosts: ["api.slack.com"],
        errorWhen: { path: "ok", equals: false },
        operations: [
          {
            operationId: "listUsers",
            label: "List Users",
            method: "GET",
            path: "/api/users.list",
            response: {
              errorShape: {
                codePath: "error",
              },
            },
            sideEffects: "read",
          },
        ],
      } as any;

      const fetcher = async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      await expect(
        callOperation(manifest, "listUsers", {}, { connection: null, fetcher }),
      ).rejects.toMatchObject({
        code: "INTEGRATION_PROVIDER_ERROR",
        providerCode: "invalid_auth",
      });
    });

    it("successWhen:{path:'status', in:['succeeded','processing']} with any other status rejects", async () => {
      const manifest: IntegrationManifestFile = {
        manifestVersion: 2,
        kind: "integration",
        app: "custom",
        version: "1.0.0",
        ui: baseUi,
        auth: baseAuth,
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
        operations: [
          {
            operationId: "checkJob",
            label: "Check Job",
            method: "GET",
            path: "/jobs/{id}",
            params: [{ name: "id", in: "path", dataType: "string", required: true }],
            successWhen: { path: "status", in: ["succeeded", "processing"] },
            sideEffects: "read",
          },
        ],
      } as any;

      const failingFetcher = async () =>
        new Response(JSON.stringify({ status: "failed", error: "Job crashed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      await expect(
        callOperation(manifest, "checkJob", { id: "j1" }, { connection: null, fetcher: failingFetcher }),
      ).rejects.toMatchObject({
        code: "INTEGRATION_PROVIDER_ERROR",
      });

      const succeedingFetcher = async () =>
        new Response(JSON.stringify({ status: "succeeded", result: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      const res = await callOperation(
        manifest,
        "checkJob",
        { id: "j1" },
        { connection: null, fetcher: succeedingFetcher },
      );
      expect(res.ok).toBe(true);
      expect((res.data as any).status).toBe("succeeded");
    });
  });

  describe("Pagination styles", () => {
    it("offset pagination fetches 3 pages", async () => {
      const offsetsCalled: number[] = [];
      const fetcher = async (input: any) => {
        const u = new URL(String(input));
        const offset = Number(u.searchParams.get("offset") ?? "0");
        offsetsCalled.push(offset);
        return new Response(
          JSON.stringify({
            items: [
              { id: `item_${offset + 1}` },
              { id: `item_${offset + 2}` },
            ],
            total: 10,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const manifest: IntegrationManifestFile = {
        manifestVersion: 2,
        kind: "integration",
        app: "custom",
        version: "1.0.0",
        ui: baseUi,
        auth: baseAuth,
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
        operations: [
          {
            operationId: "listItems",
            label: "List Items",
            method: "GET",
            path: "/items",
            pagination: {
              style: "offset",
              paramName: "offset",
              limitParam: "limit",
              pageSize: 2,
              responsePath: "items",
              maxPages: 3,
            },
            sideEffects: "read",
          },
        ],
      } as any;

      const res = await callOperation(manifest, "listItems", {}, { connection: null, fetcher });
      expect(res.pagesFetched).toBe(3);
      expect(offsetsCalled).toEqual([0, 2, 4]);
      expect((res.body as any).items).toHaveLength(6);
      expect(res.truncated).toBe(true);
      expect(res.nextCursor).toBe("6");
    });

    it("bodyNextUrl pointing at a host outside allowedHosts rejects INTEGRATION_HOST_FORBIDDEN", async () => {
      let pageCount = 0;
      const fetcher = async () => {
        pageCount++;
        return new Response(
          JSON.stringify({
            items: [{ id: 1 }],
            next: "https://unauthorized-evil.com/page2",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const manifest: IntegrationManifestFile = {
        manifestVersion: 2,
        kind: "integration",
        app: "custom",
        version: "1.0.0",
        ui: baseUi,
        auth: baseAuth,
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
        operations: [
          {
            operationId: "listData",
            label: "List Data",
            method: "GET",
            path: "/data",
            pagination: {
              style: "bodyNextUrl",
              nextUrlPath: "next",
              responsePath: "items",
              maxPages: 3,
            },
            sideEffects: "read",
          },
        ],
      } as any;

      await expect(
        callOperation(manifest, "listData", {}, { connection: null, fetcher }),
      ).rejects.toMatchObject({
        code: "INTEGRATION_HOST_FORBIDDEN",
      });
      expect(pageCount).toBe(1);
    });

    it("headerToken reads X-Next-Page-Token", async () => {
      const tokensReceived: (string | null)[] = [];
      let page = 0;
      const fetcher = async (input: any) => {
        page++;
        const u = new URL(String(input));
        tokensReceived.push(u.searchParams.get("pageToken"));
        const headers = new Headers({ "content-type": "application/json" });
        if (page === 1) {
          headers.set("X-Next-Page-Token", "tok_abc_123");
        }
        return new Response(
          JSON.stringify({
            items: [{ id: `item_${page}` }],
          }),
          { status: 200, headers },
        );
      };

      const manifest: IntegrationManifestFile = {
        manifestVersion: 2,
        kind: "integration",
        app: "custom",
        version: "1.0.0",
        ui: baseUi,
        auth: baseAuth,
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
        operations: [
          {
            operationId: "listWithToken",
            label: "List With Token",
            method: "GET",
            path: "/tokens",
            pagination: {
              style: "headerToken",
              tokenHeader: "X-Next-Page-Token",
              paramName: "pageToken",
              responsePath: "items",
              maxPages: 3,
            },
            sideEffects: "read",
          },
        ],
      } as any;

      const res = await callOperation(manifest, "listWithToken", {}, { connection: null, fetcher });
      expect(res.pagesFetched).toBe(2);
      expect(tokensReceived).toEqual([null, "tok_abc_123"]);
      expect(res.truncated).toBe(false);
      expect(res.nextCursor).toBeNull();
    });

    it("lastItemCursor sends starting_after=<last data[].id> while has_more is true", async () => {
      const startingAfterValues: (string | null)[] = [];
      const fetcher = async (input: any) => {
        const u = new URL(String(input));
        const after = u.searchParams.get("starting_after");
        startingAfterValues.push(after);
        if (after === null) {
          return new Response(
            JSON.stringify({
              data: [{ id: "cus_1" }, { id: "cus_2" }],
              has_more: true,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            data: [{ id: "cus_3" }],
            has_more: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const manifest: IntegrationManifestFile = {
        manifestVersion: 2,
        kind: "integration",
        app: "stripe",
        version: "1.0.0",
        ui: baseUi,
        auth: baseAuth,
        baseUrl: "https://api.stripe.com",
        allowedHosts: ["api.stripe.com"],
        operations: [
          {
            operationId: "listCustomers",
            label: "List Customers",
            method: "GET",
            path: "/v1/customers",
            pagination: {
              style: "lastItemCursor",
              paramName: "starting_after",
              responsePath: "data",
              itemIdPath: "id",
              hasMorePath: "has_more",
              maxPages: 5,
            },
            sideEffects: "read",
          },
        ],
      } as any;

      const res = await callOperation(manifest, "listCustomers", {}, { connection: null, fetcher });
      expect(res.pagesFetched).toBe(2);
      expect(startingAfterValues).toEqual([null, "cus_2"]);
      expect((res.body as any).data).toHaveLength(3);
      expect(res.truncated).toBe(false);
      expect(res.nextCursor).toBeNull();
    });

    it("hitting maxPages while more data exists gives truncated:true, nextCursor:'<token>'; exhausting gives truncated:false, nextCursor:null", async () => {
      const fetcher = async (input: any) => {
        const u = new URL(String(input));
        const cursor = u.searchParams.get("cursor");
        const idx = cursor ? Number(cursor) : 1;
        return new Response(
          JSON.stringify({
            items: [{ id: `item_${idx}` }],
            next_cursor: String(idx + 1),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const manifest: IntegrationManifestFile = {
        manifestVersion: 2,
        kind: "integration",
        app: "custom",
        version: "1.0.0",
        ui: baseUi,
        auth: baseAuth,
        baseUrl: "https://api.example.com",
        allowedHosts: ["api.example.com"],
        operations: [
          {
            operationId: "listCapped",
            label: "List Capped",
            method: "GET",
            path: "/capped",
            pagination: {
              style: "cursor",
              paramName: "cursor",
              responsePath: "items",
              nextCursorPath: "next_cursor",
              maxPages: 2,
            },
            sideEffects: "read",
          },
        ],
      } as any;

      const res = await callOperation(manifest, "listCapped", {}, { connection: null, fetcher });
      expect(res.pagesFetched).toBe(2);
      expect(res.truncated).toBe(true);
      expect(res.nextCursor).toBe("3");

      // Node wrapper output ports exposure (AC1)
      const executor = createIntegrationOperationExecutor(manifest, manifest.operations[0]!, {
        fetcher,
      });
      const nodeRes = await executor({
        nodeId: "n1",
        runId: "r1",
        idempotencyKey: "k1",
        data: {},
        inputs: {},
        payload: {},
        connection: null as any,
        secret: () => "",
        binding: () => ({} as any),
      });
      expect(nodeRes.truncated).toBe(true);
      expect(nodeRes.nextCursor).toBe("3");
      expect(nodeRes.pagesFetched).toBe(2);
    });
  });

  describe("AC3: PredicateSchema", () => {
    const PredicateSchema = (assembler as any).PredicateSchema;

    it("defines PredicateSchema rejecting anything outside vocabulary, including __proto__ and deep nesting", () => {
      expect(PredicateSchema, "PredicateSchema must be exported").toBeDefined();

      // Valid leaves
      expect(PredicateSchema.safeParse({ path: "ok", equals: false }).success).toBe(true);
      expect(PredicateSchema.safeParse({ path: "status", in: ["succeeded", "processing"] }).success).toBe(true);
      expect(PredicateSchema.safeParse({ path: "data", exists: true }).success).toBe(true);

      // Valid combinators depth 1 and 2
      expect(
        PredicateSchema.safeParse({
          all: [
            { path: "ok", equals: true },
            { path: "count", equals: 5 },
          ],
        }).success,
      ).toBe(true);

      expect(
        PredicateSchema.safeParse({
          all: [
            {
              any: [
                { path: "status", equals: "ready" },
                { path: "status", equals: "done" },
              ],
            },
          ],
        }).success,
      ).toBe(true);

      // Rejects __proto__, constructor, prototype in dot paths
      expect(PredicateSchema.safeParse({ path: "__proto__.polluted", equals: true }).success).toBe(false);
      expect(PredicateSchema.safeParse({ path: "a.__proto__.b", equals: false }).success).toBe(false);
      expect(PredicateSchema.safeParse({ path: "constructor", exists: true }).success).toBe(false);
      expect(PredicateSchema.safeParse({ path: "prototype.test", equals: 1 }).success).toBe(false);

      // Rejects unknown operators outside fixed vocabulary
      expect(PredicateSchema.safeParse({ path: "ok", regex: ".*" }).success).toBe(false);
      expect(PredicateSchema.safeParse({ path: "ok", expr: "true" }).success).toBe(false);

      // Rejects depth > 2
      expect(
        PredicateSchema.safeParse({
          all: [
            {
              any: [
                {
                  all: [
                    { path: "too.deep", equals: true },
                  ],
                },
              ],
            },
          ],
        }).success,
      ).toBe(false);
    });
  });
});
