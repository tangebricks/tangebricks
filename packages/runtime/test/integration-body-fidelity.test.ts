import { describe, expect, it, vi } from "vitest";
import type { IntegrationManifestFile } from "@poc/assembler";
import { callOperation, IntegrationCallError } from "../src/call-operation.ts";

describe("UC3.5 Request body fidelity runtime tests", () => {
  const baseManifest: IntegrationManifestFile = {
    manifestVersion: 2,
    kind: "integration",
    version: "1.0.0",
    app: "test-app",
    baseUrl: "https://api.test.com",
    allowedHosts: ["api.test.com"],
    auth: { type: "none" },
    ui: {
      displayName: "Test App",
      category: "communication",
      summary: "Test App for body fidelity",
      maturity: "beta",
    },
    fidelity: {
      specHash: "abc",
      importerVersion: "1.0.0",
      level: "exact",
      unsupported: [],
    },
    operations: [
      {
        operationId: "createNestedJson",
        label: "Create Nested JSON",
        method: "POST",
        path: "/nested-json",
        sideEffects: "write",
        response: {},
        body: {
          contentType: "application/json",
          fields: [
            {
              name: "metadata",
              dataType: "object",
              schema: {
                dataType: "object",
                properties: {
                  env: { dataType: "string" },
                  version: { dataType: "number" },
                },
              },
            },
          ],
        },
      },
      {
        operationId: "createFormNested",
        label: "Create Form Nested",
        method: "POST",
        path: "/form-nested",
        sideEffects: "write",
        response: {},
        body: {
          contentType: "application/x-www-form-urlencoded",
          fields: [
            {
              name: "collection_options",
              dataType: "object",
              schema: {
                dataType: "object",
                properties: {
                  fields: { dataType: "string" },
                },
              },
            },
            {
              name: "items",
              dataType: "array",
              schema: {
                dataType: "array",
                items: {
                  dataType: "object",
                  properties: {
                    price: { dataType: "string" },
                  },
                },
              },
            },
          ],
          encoding: {
            collection_options: { style: "deepObject", explode: true },
            items: { style: "deepObject", explode: true },
          },
        },
      },
      {
        operationId: "uploadBatchArray",
        label: "Upload Batch Array",
        method: "POST",
        path: "/batch",
        sideEffects: "write",
        response: {},
        body: {
          contentType: "application/json",
          root: {
            dataType: "array",
            schema: {
              dataType: "array",
              items: { dataType: "string" },
            },
          },
        },
      },
      {
        operationId: "sendDiscriminated",
        label: "Send Discriminated Variant",
        method: "POST",
        path: "/discriminated",
        sideEffects: "write",
        response: {},
        body: {
          contentType: "application/json",
          fields: [
            {
              name: "payload",
              dataType: "any",
              schema: {
                dataType: "any",
                discriminator: "kind",
                variants: [
                  {
                    dataType: "object",
                    properties: {
                      kind: { dataType: "string", enum: ["text"] },
                      textVal: { dataType: "string" },
                    },
                  },
                  {
                    dataType: "object",
                    properties: {
                      kind: { dataType: "string", enum: ["number"] },
                      numVal: { dataType: "number" },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      {
        operationId: "createAccountLink",
        label: "Create Account Link",
        method: "POST",
        path: "/v1/account_links",
        sideEffects: "write",
        response: {},
        body: {
          contentType: "application/json",
          fields: [
            {
              name: "account",
              dataType: "string",
            },
            {
              name: "type",
              dataType: "string",
              required: true,
            },
          ],
        },
      },
    ],
  };

  it("A nested JSON object is sent nested", async () => {
    let capturedBody = "";
    const fetcher = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await callOperation(
      baseManifest,
      "createNestedJson",
      {
        metadata: { env: "prod", version: 1 },
      },
      { connection: null, fetcher },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(capturedBody);
    expect(parsed.metadata).toEqual({ env: "prod", version: 1 });
  });

  it("A form-urlencoded nested object and array are sent as collection_options[fields]=eventually_due&items[0][price]=p_1", async () => {
    let capturedBody = "";
    const fetcher = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await callOperation(
      baseManifest,
      "createFormNested",
      {
        collection_options: { fields: "eventually_due" },
        items: [{ price: "p_1" }],
      },
      { connection: null, fetcher },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    // Bracket form encoding
    expect(capturedBody).toContain("collection_options%5Bfields%5D=eventually_due");
    expect(capturedBody).toContain("items%5B0%5D%5Bprice%5D=p_1");
  });

  it("A top-level array body is sent as a JSON array", async () => {
    let capturedBody = "";
    const fetcher = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await callOperation(
      baseManifest,
      "uploadBatchArray",
      {
        body: ["itemA", "itemB"],
      },
      { connection: null, fetcher },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(capturedBody);
    expect(parsed).toEqual(["itemA", "itemB"]);
  });

  it("A value that matches no oneOf variant rejects INTEGRATION_INVALID_PARAM", async () => {
    const fetcher = vi.fn();

    await expect(
      callOperation(
        baseManifest,
        "sendDiscriminated",
        {
          payload: { kind: "invalid_kind", unknownField: true },
        },
        { connection: null, fetcher },
      ),
    ).rejects.toThrowError(/INTEGRATION_INVALID_PARAM/);

    expect(fetcher).toHaveBeenCalledTimes(0);
  });

  it("AC1: Stripe account_links-style fixture: omission of required type fails INTEGRATION_MISSING_PARAM with 0 fetches", async () => {
    const fetcher = vi.fn();

    await expect(
      callOperation(
        baseManifest,
        "createAccountLink",
        {
          account: "acct_123",
          // 'type' is omitted
        },
        { connection: null, fetcher },
      ),
    ).rejects.toThrowError(/INTEGRATION_MISSING_PARAM/);

    expect(fetcher).toHaveBeenCalledTimes(0);
  });
});
