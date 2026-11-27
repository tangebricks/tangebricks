import { describe, expect, it, vi } from "vitest";
import { IntegrationManifestSchema, projectIntegrationToNodes } from "@poc/assembler";
import type { Catalog, IntegrationManifestFile } from "@poc/assembler";
import { applyOp, createEmptyBlueprint } from "@poc/blueprint";
import type { BlueprintState } from "@poc/blueprint";
import { TOOLS } from "@poc/mcp-server";
import { createIntegrationOperationExecutor } from "../src/integration-executor.ts";
import type { ExecutionContext } from "@poc/sdk";

const testManifestWithBlockingOp: IntegrationManifestFile = IntegrationManifestSchema.parse({
  manifestVersion: 2,
  kind: "integration",
  app: "stripe",
  version: "1.0.0",
  ui: {
    displayName: "Stripe",
    category: "billing",
    summary: "Stripe payment integration",
    maturity: "production",
    behaviourTest: "test/stripe.test.ts",
  },
  auth: {
    type: "apiKey",
    headerName: "Authorization",
    prefix: "Bearer",
  },
  baseUrl: "https://api.stripe.com",
  allowedHosts: ["api.stripe.com"],
  operations: [
    {
      operationId: "createLink",
      label: "Create Link",
      summary: "Create an account link",
      method: "POST",
      path: "/v1/account_links",
      body: {
        contentType: "application/json",
        fields: [
          { name: "account", dataType: "string", required: true },
          { name: "refresh_url", dataType: "string", required: true },
        ],
      },
      response: {
        outputs: [{ id: "url", dataType: "string" }],
      },
    },
    {
      operationId: "getBalance",
      label: "Get Balance",
      summary: "Get account balance",
      method: "GET",
      path: "/v1/balance",
      response: {
        outputs: [{ id: "available", dataType: "object" }],
      },
    },
  ],
  fidelity: {
    specHash: "sha256:" + "0".repeat(64),
    importerVersion: "1.0.0",
    level: "partial",
    unsupported: [
      {
        op: "createLink",
        code: "BODY_REQUIRED_FIELD_CAPPED",
        pointer: "#/paths/~1v1~1account_links/post/requestBody",
        blocking: true,
      },
      {
        op: "getBalance",
        code: "PARAM_ENUM_DROPPED",
        pointer: "#/paths/~1v1~1balance/get/parameters/0",
        blocking: false,
      },
    ],
  },
});

describe("UC2.6 — Runtime refusal of unsupported operations and multi-layer enforcement", () => {
  it("AC1: refuses blocking operation at run time with INTEGRATION_UNSUPPORTED_FEATURE (0 fetches, 0 connection lookups)", async () => {
    const mockFetcher = vi.fn();
    const mockConnection = vi.fn();

    const executor = createIntegrationOperationExecutor(testManifestWithBlockingOp, testManifestWithBlockingOp.operations[0]!, { fetcher: mockFetcher as any });

    const ctx: ExecutionContext = {
      workspaceId: "ws_test",
      nodeId: "n_create_link",
      runId: "run_test",
      idempotencyKey: "run_test:n_create_link",
      data: {
        connectionRef: { scope: "project", ref: "conn_stripe" },
      },
      inputs: {
        account: "acct_12345",
        refresh_url: "https://example.com/refresh",
      },
      payload: {},
      secret: () => "",
      binding: () => ({}) as any,
      connection: mockConnection as any,
    };

    await expect(executor(ctx)).rejects.toThrow(
      'INTEGRATION_UNSUPPORTED_FEATURE: Integration "stripe" operation "createLink" cannot run faithfully: BODY_REQUIRED_FIELD_CAPPED at #/paths/~1v1~1account_links/post/requestBody',
    );

    expect(mockFetcher).toHaveBeenCalledTimes(0);
    expect(mockConnection).toHaveBeenCalledTimes(0);
  });

  it("AC3: non-blocking approximated/unsupported entries execute normally", async () => {
    const mockFetcher = vi.fn().mockResolvedValue(Response.json({ available: [{ amount: 5000, currency: "usd" }] }, { status: 200 }));
    const mockConnection = vi.fn().mockReturnValue({
      apiKey: "sk_test_mock_stripe_key",
    });

    const executor = createIntegrationOperationExecutor(testManifestWithBlockingOp, testManifestWithBlockingOp.operations[1]!, { fetcher: mockFetcher as any });

    const ctx: ExecutionContext = {
      workspaceId: "ws_test",
      nodeId: "n_get_balance",
      runId: "run_test",
      idempotencyKey: "run_test:n_get_balance",
      data: {
        connectionRef: { scope: "project", ref: "conn_stripe" },
      },
      inputs: {},
      payload: {},
      secret: () => "",
      binding: () => ({}) as any,
      connection: mockConnection as any,
    };

    const res = await executor(ctx);
    expect(res).toBeDefined();
    expect(mockFetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses operations when manifest has document-level blocking loss (op: null)", async () => {
    const docLevelBlockingManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
      ...testManifestWithBlockingOp,
      fidelity: {
        specHash: "sha256:" + "0".repeat(64),
        importerVersion: "1.0.0",
        level: "partial",
        unsupported: [
          {
            op: null,
            code: "SWAGGER2_BODY_DROPPED",
            pointer: "#/paths",
            blocking: true,
          },
        ],
      },
    });

    const mockFetcher = vi.fn();
    const mockConnection = vi.fn();

    const executor = createIntegrationOperationExecutor(docLevelBlockingManifest, docLevelBlockingManifest.operations[1]!, { fetcher: mockFetcher as any });

    const ctx: ExecutionContext = {
      workspaceId: "ws_test",
      nodeId: "n_balance",
      runId: "run_test",
      idempotencyKey: "run_test:n_balance",
      data: { connectionRef: { scope: "project", ref: "conn_stripe" } },
      inputs: {},
      payload: {},
      secret: () => "",
      binding: () => ({}) as any,
      connection: mockConnection as any,
    };

    await expect(executor(ctx)).rejects.toThrow(
      'INTEGRATION_UNSUPPORTED_FEATURE: Integration "stripe" operation "getBalance" cannot run faithfully: SWAGGER2_BODY_DROPPED at #/paths',
    );
    expect(mockFetcher).toHaveBeenCalledTimes(0);
    expect(mockConnection).toHaveBeenCalledTimes(0);
  });

  it("lists every blocking entry when an operation has multiple blocking losses", async () => {
    const multiBlockingManifest: IntegrationManifestFile = IntegrationManifestSchema.parse({
      ...testManifestWithBlockingOp,
      fidelity: {
        specHash: "sha256:" + "0".repeat(64),
        importerVersion: "1.0.0",
        level: "partial",
        unsupported: [
          {
            op: "createLink",
            code: "BODY_REQUIRED_FIELD_CAPPED",
            pointer: "#/paths/~1v1~1account_links/post/requestBody",
            blocking: true,
          },
          {
            op: "createLink",
            code: "CONTENT_TYPE_UNSUPPORTED",
            pointer: "#/paths/~1v1~1account_links/post/requestBody/content",
            blocking: true,
          },
        ],
      },
    });

    const executor = createIntegrationOperationExecutor(multiBlockingManifest, multiBlockingManifest.operations[0]!);

    const ctx: ExecutionContext = {
      workspaceId: "ws_test",
      nodeId: "n_multi",
      runId: "run_test",
      idempotencyKey: "run_test:n_multi",
      data: {},
      inputs: {},
      payload: {},
      secret: () => "",
      binding: () => ({}) as any,
    };

    await expect(executor(ctx)).rejects.toThrow(
      'INTEGRATION_UNSUPPORTED_FEATURE: Integration "stripe" operation "createLink" cannot run faithfully: BODY_REQUIRED_FIELD_CAPPED at #/paths/~1v1~1account_links/post/requestBody, CONTENT_TYPE_UNSUPPORTED at #/paths/~1v1~1account_links/post/requestBody/content',
    );
  });

  it("projectIntegrationToNodes sets availability: 'unsupported' for blocking operations and 'available' for supported operations", () => {
    const nodes = projectIntegrationToNodes(testManifestWithBlockingOp);
    const linkNode = nodes.find((n) => n.type === "int:stripe.createLink");
    const balanceNode = nodes.find((n) => n.type === "int:stripe.getBalance");

    expect(linkNode).toBeDefined();
    expect(linkNode?.availability).toBe("unsupported");

    expect(balanceNode).toBeDefined();
    expect(balanceNode?.availability).toBe("available");
  });

  it("AC2: Blueprint editor add_node and update_node refuse unsupported operations with INTEGRATION_OPERATION_UNSUPPORTED", () => {
    const catalog: Catalog = {
      bricks: {},
      nodePacks: {},
      integrations: {
        stripe: {
          manifest: testManifestWithBlockingOp,
          nodes: projectIntegrationToNodes(testManifestWithBlockingOp),
        },
      },
    };

    const state: BlueprintState = createEmptyBlueprint("test-unsupported", {
      workflows: [
        {
          id: "wf-1",
          name: "Workflow 1",
          nodes: [{ id: "trigger", type: "trigger.manual", data: {} }],
          edges: [],
        },
      ],
    });

    // 1. add_node with unsupported operation
    const addRes = applyOp(
      state,
      {
        opId: "op-add-unsupported",
        type: "add_node",
        workflowId: "wf-1",
        node: {
          id: "node-link",
          type: "int:stripe.createLink",
          data: {},
        },
      },
      catalog,
    );

    expect(addRes.ok).toBe(false);
    if (!addRes.ok) {
      expect(addRes.errors).toHaveLength(1);
      expect(addRes.errors[0]?.code).toBe("INTEGRATION_OPERATION_UNSUPPORTED");
      expect(addRes.errors[0]?.path).toBe("workflows.wf-1.nodes.node-link");
      expect(addRes.errors[0]?.suggestedFix).toContain("BODY_REQUIRED_FIELD_CAPPED");
    }

    // 2. update_node to unsupported operation
    const updateRes = applyOp(
      state,
      {
        opId: "op-update-unsupported",
        type: "update_node",
        workflowId: "wf-1",
        nodeId: "trigger",
        patch: {
          type: "int:stripe.createLink",
        },
      },
      catalog,
    );

    expect(updateRes.ok).toBe(false);
    if (!updateRes.ok) {
      expect(updateRes.errors).toHaveLength(1);
      expect(updateRes.errors[0]?.code).toBe("INTEGRATION_OPERATION_UNSUPPORTED");
      expect(updateRes.errors[0]?.path).toBe("workflows.wf-1.nodes.trigger");
      expect(updateRes.errors[0]?.suggestedFix).toContain("BODY_REQUIRED_FIELD_CAPPED");
    }
  });

  it("MCP server tools get_node returns availability and search_nodes filters unsupported operations unless includeUnsupported is true", async () => {
    const catalog: Catalog = {
      bricks: {},
      nodePacks: {},
      integrations: {
        stripe: {
          manifest: testManifestWithBlockingOp,
          nodes: projectIntegrationToNodes(testManifestWithBlockingOp),
        },
      },
    };

    const getNodeTool = TOOLS.find((t) => t.name === "get_node");
    expect(getNodeTool).toBeDefined();

    const getNodeRes = (await (getNodeTool!.run as any)(
      { catalog },
      {
        type: "int:stripe.createLink",
      },
    )) as { text: string; isError?: boolean };

    expect(getNodeRes.isError).toBeFalsy();
    const nodeData = JSON.parse(getNodeRes.text);
    expect(nodeData.availability).toBe("unsupported");

    const searchNodesTool = TOOLS.find((t) => t.name === "search_nodes");
    expect(searchNodesTool).toBeDefined();

    // Default search excludes unsupported nodes
    const searchDefaultRes = (await (searchNodesTool!.run as any)(
      { catalog },
      {
        query: "createLink",
      },
    )) as { text: string; isError?: boolean };

    expect(searchDefaultRes.isError).toBeFalsy();
    const defaultData = JSON.parse(searchDefaultRes.text);
    expect(defaultData.items).toHaveLength(0);

    // search with includeUnsupported: true returns unsupported nodes
    const searchAllRes = (await (searchNodesTool!.run as any)(
      { catalog },
      {
        query: "createLink",
        includeUnsupported: true,
      },
    )) as { text: string; isError?: boolean };

    expect(searchAllRes.isError).toBeFalsy();
    const allData = JSON.parse(searchAllRes.text);
    expect(allData.items).toHaveLength(1);
    expect(allData.items[0]?.type).toBe("int:stripe.createLink");
  });
});
