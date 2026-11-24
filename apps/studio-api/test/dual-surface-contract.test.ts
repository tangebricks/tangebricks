import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import { createMcpApp } from "@poc/mcp-server";
import { TEST_TOKEN_USER_ID, testToken, testTokenId, testTokenVerifier } from "../../../packages/mcp-server/test/support/test-verifier.ts";
import type { BlueprintDoNamespaceLike } from "@poc/mcp-server";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import mcpMigrationSql from "../../../packages/mcp-server/migrations/0001_mcp_server.sql?raw";
import { app as studioApp } from "../src/index.ts";
import type { ProjectStatePayload, StudioApiEnv } from "../src/index.ts";
import { ensureTestProjectToken } from "./project-token.ts";

const studioEnv = env as unknown as StudioApiEnv;
const mcpDb = (env as unknown as { DB: D1Like }).DB;
const rawDo = (env as unknown as { BLUEPRINT_DO: BlueprintDoNamespaceLike }).BLUEPRINT_DO;
const mcpDo: BlueprintDoNamespaceLike = {
  idFromName: (name: string) => rawDo.idFromName(`mcp-surface:${name}`),
  get: (id) => rawDo.get(id),
};
const mcpStudioEnv: StudioApiEnv = {
  ...studioEnv,
  BLUEPRINT_DO: mcpDo as unknown as StudioApiEnv["BLUEPRINT_DO"],
};

// Story 0.15: the standalone MCP server has no shared bearer; each call presents a token bound to the project it
// names, and the author comes from that token, not from x-mcp-client headers.
const mcpApp = createMcpApp({ catalog, callsPerMinute: 10_000, verifyToken: testTokenVerifier });

let rpcId = 1;
async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await mcpApp.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${testToken(String(args.project ?? "default-project"), undefined, "claude-code")}`,
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    {
      DB: mcpDb,
      BLUEPRINT_DO: mcpDo,
    },
  );
  expect(response.status).toBe(200);
  const rpc = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ type: string; text: string }> };
  };
  const text = rpc.result.content[0]?.text ?? "";
  return {
    isError: rpc.result.isError === true,
    text,
    json: <T = Record<string, unknown>>() => JSON.parse(text) as T,
  };
}

async function postHttpOps(
  project: string,
  body: {
    baseRevision?: number;
    author?: { type: "human" | "agent"; id: string; client?: string };
    summary?: string;
    ops: unknown[];
  },
) {
  const { headers: authHeaders } = await ensureTestProjectToken(studioEnv, project);
  return studioApp.request(
    `/api/projects/${project}/ops`,
    {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        author: { type: "human", id: "alice" },
        ...body,
      }),
    },
    studioEnv,
  );
}

beforeEach(async () => {
  for (const table of ["mcp_files", "mcp_builds", "mcp_projects", "mcp_rate"]) {
    await mcpDb.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(mcpDb, mcpMigrationSql);
});

describe("Story 1.4 — Stateless MCP server over BlueprintDO & dual-surface contract suite", () => {
  test("6-step build script via MCP tools vs Studio HTTP API produces identical revision 6 state, parent chains, semanticHash, and buildHash (AC 1, AC 2, AC 3, AC 5, AC 6)", async () => {
    const mcpProject = "dual-surface-saas";
    const httpProject = "dual-surface-saas";

    const customersEntity = {
      name: "customers",
      fields: [
        { name: "email", type: "text", required: true, maxLength: 255 },
        { name: "company", type: "text", required: false, maxLength: 120 },
      ],
    };
    const invoicesEntity = {
      name: "invoices",
      fields: [
        { name: "customer_email", type: "text", required: true, maxLength: 255 },
        { name: "amount_cents", type: "number", required: true, min: 0 },
        { name: "status", type: "enum", required: true, values: ["draft", "sent", "paid"] },
      ],
    };

    // --- Step 1 (Revision 1): Enable 3 bricks ---
    const mcpStep1 = await callMcpTool("enable_brick", {
      project: mcpProject,
      bricks: ["multi-workspace", "credit-wallet", "dynamic-entities"],
    });
    expect(mcpStep1.isError).toBe(false);
    expect(mcpStep1.json()).toMatchObject({
      project: mcpProject,
      revision: 1,
      enabled: ["credit-wallet", "dynamic-entities", "multi-workspace"],
      entities: [],
      needs: [],
    });

    const httpStep1 = await postHttpOps(httpProject, {
      ops: [
        { opId: "h-1a", type: "enable_brick", brickId: "multi-workspace" },
        { opId: "h-1b", type: "enable_brick", brickId: "credit-wallet" },
        { opId: "h-1c", type: "enable_brick", brickId: "dynamic-entities" },
      ],
    });
    expect(httpStep1.status).toBe(200);

    // --- Step 2 (Revision 2): Configure brick settings on credit-wallet ---
    const mcpStep2 = await callMcpTool("enable_brick", {
      project: mcpProject,
      bricks: [{ id: "credit-wallet", config: { creditsPerUnit: 25, minOrderAmount: 100 } }],
    });
    expect(mcpStep2.isError).toBe(false);
    expect(mcpStep2.json().revision).toBe(2);

    const httpStep2 = await postHttpOps(httpProject, {
      ops: [
        {
          opId: "h-2",
          type: "configure_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 25, minOrderAmount: 100 },
          replace: true,
        },
      ],
    });
    expect(httpStep2.status).toBe(200);

    // --- Step 3 (Revision 3): Add 2 entities ---
    const mcpStep3 = await callMcpTool("define_entity", {
      project: mcpProject,
      entities: [customersEntity, invoicesEntity],
    });
    expect(mcpStep3.isError).toBe(false);
    expect(mcpStep3.json()).toMatchObject({
      project: mcpProject,
      revision: 3,
      enabled: ["credit-wallet", "dynamic-entities", "multi-workspace"],
      entities: ["customers", "invoices"],
      needs: [],
    });

    const httpStep3 = await postHttpOps(httpProject, {
      ops: [
        { opId: "h-3a", type: "add_entity", entity: customersEntity },
        { opId: "h-3b", type: "add_entity", entity: invoicesEntity },
      ],
    });
    expect(httpStep3.status).toBe(200);

    // --- Step 4 (Revision 4): Add workflow with 3 nodes ---
    const wfNodes = [
      { id: "t1", type: "trigger.manual", label: "Trigger", data: {} },
      { id: "n1", type: "transform.pick", label: "Pick Customer", data: { path: "customer" } },
      {
        id: "n2",
        type: "transform.pick",
        label: "Pick Email",
        data: { path: "{{$node.n1.email}}" },
      },
    ];
    const mcpStep4 = await callMcpTool("apply_ops", {
      project: mcpProject,
      summary: "Create invoice workflow with 3 nodes",
      ops: [
        {
          opId: "m-4",
          type: "add_workflow",
          workflow: {
            id: "wf-invoice",
            name: "Invoice Processing",
            trigger: { kind: "manual" },
            nodes: wfNodes,
            edges: [],
          },
        },
      ],
    });
    expect(mcpStep4.isError).toBe(false);
    expect(mcpStep4.json().revision).toBe(4);

    const httpStep4 = await postHttpOps(httpProject, {
      ops: [
        {
          opId: "h-4",
          type: "add_workflow",
          workflow: {
            id: "wf-invoice",
            name: "Invoice Processing",
            trigger: { kind: "manual" },
            nodes: wfNodes,
            edges: [],
          },
        },
      ],
    });
    expect(httpStep4.status).toBe(200);

    // --- Step 5 (Revision 5): Connect 2 edges across the 3 nodes ---
    const wfEdges = [
      { id: "e1", source: "t1", target: "n1", sourceHandle: "out", targetHandle: "in" },
      { id: "e2", source: "n1", target: "n2", sourceHandle: "out", targetHandle: "in" },
    ];
    const mcpStep5 = await callMcpTool("apply_ops", {
      project: mcpProject,
      summary: "Connect workflow edges",
      ops: [
        {
          opId: "m-5",
          type: "connect_edges",
          workflowId: "wf-invoice",
          edges: wfEdges,
        },
      ],
    });
    expect(mcpStep5.isError).toBe(false);
    expect(mcpStep5.json().revision).toBe(5);

    const httpStep5 = await postHttpOps(httpProject, {
      ops: [
        {
          opId: "h-5",
          type: "connect_edges",
          workflowId: "wf-invoice",
          edges: wfEdges,
        },
      ],
    });
    expect(httpStep5.status).toBe(200);

    // --- Step 6 (Revision 6): Bind a secret ref ---
    const secretBinding = {
      type: "bind_secret_ref",
      ref: "sec_invoice_webhook_key",
      targetKind: "brick",
      targetId: "credit-wallet",
      secretName: "WEBHOOK_SECRET",
    };
    const mcpStep6 = await callMcpTool("apply_ops", {
      project: mcpProject,
      summary: "Bind workflow secret ref",
      ops: [{ opId: "m-6", ...secretBinding }],
    });
    expect(mcpStep6.isError).toBe(false);
    expect(mcpStep6.json().revision).toBe(6);

    const httpStep6 = await postHttpOps(httpProject, {
      ops: [{ opId: "h-6", ...secretBinding }],
    });
    expect(httpStep6.status).toBe(200);

    // Both surfaces use the same project name, so one project token reads both.
    const { headers: authHeaders } = await ensureTestProjectToken(studioEnv, httpProject);

    // Verify revision 1..6 parent chains, state, and semanticHash match identically on both surfaces
    for (let rev = 1; rev <= 6; rev += 1) {
      const mcpRevRes = await studioApp.request(
        `/api/projects/${mcpProject}/revisions/${rev}`,
        { method: "GET", headers: authHeaders },
        mcpStudioEnv,
      );
      const httpRevRes = await studioApp.request(
        `/api/projects/${httpProject}/revisions/${rev}`,
        { method: "GET", headers: authHeaders },
        studioEnv,
      );
      expect(mcpRevRes.status).toBe(200);
      expect(httpRevRes.status).toBe(200);

      const mcpRev = (await mcpRevRes.json()) as ProjectStatePayload;
      const httpRev = (await httpRevRes.json()) as ProjectStatePayload;

      expect(mcpRev.revision).toBe(rev);
      expect(httpRev.revision).toBe(rev);
      expect(mcpRev.parentRevision).toBe(rev - 1);
      expect(httpRev.parentRevision).toBe(rev - 1);
      expect(mcpRev.semanticHash).toBe(httpRev.semanticHash);
      expect(mcpRev.state).toEqual(httpRev.state);
      expect(mcpRev.author).toEqual({
        type: "agent",
        id: testTokenId(mcpProject, "claude-code"),
        client: "claude-code",
        onBehalfOf: TEST_TOKEN_USER_ID,
      });
    }

    // --- Build both surfaces and verify identical buildHash, files, and bytes ---
    const mcpBuild = await callMcpTool("build_project", { project: mcpProject });
    expect(mcpBuild.isError).toBe(false);
    const mcpBuildJson = mcpBuild.json<{
      project: string;
      revision: number;
      files: number;
      bytes: number;
      hash: string;
    }>();
    expect(mcpBuildJson.revision).toBe(6);
    expect(mcpBuildJson.files).toBe(15); // story 0.21: credit-wallet's rate limits add the px_rate_limits migration

    const httpBuild = await studioApp.request(
      `/api/projects/${httpProject}/build`,
      { method: "POST", headers: authHeaders },
      studioEnv,
    );
    expect(httpBuild.status).toBe(200);
    const httpBuildJson = (await httpBuild.json()) as {
      project: string;
      revision: number;
      buildHash: string;
      files: number;
      bytes: number;
    };
    expect(httpBuildJson.revision).toBe(6);
    expect(httpBuildJson.buildHash).toBe(mcpBuildJson.hash);
    expect(httpBuildJson.files).toBe(mcpBuildJson.files);
    expect(httpBuildJson.bytes).toBe(mcpBuildJson.bytes);

    // Verify mcp_projects has 0 rows (AC 5)
    const mcpProjectsCount = await mcpDb
      .prepare("SELECT COUNT(*) AS n FROM mcp_projects")
      .first<{ n: number }>();
    expect(mcpProjectsCount?.n).toBe(0);
  });

  test("all R10 failing validation fixtures and stale baseRevision conflicts reject with matching error codes across MCP and HTTP without advancing revision (AC 4, AC 6)", async () => {
    const mcpProj = "r10-mcp-proj";
    const httpProj = "r10-http-proj";

    // Seed both projects at revision 1 with multi-workspace, credit-wallet, document-parsing, and entity "orders"
    const seedOps = [
      { opId: "seed-1", type: "enable_brick", brickId: "multi-workspace" },
      { opId: "seed-2", type: "enable_brick", brickId: "credit-wallet" },
      { opId: "seed-3", type: "enable_brick", brickId: "document-parsing" },
      {
        opId: "seed-4",
        type: "add_entity",
        entity: {
          name: "orders",
          fields: [{ name: "title", type: "text", required: true, maxLength: 100 }],
        },
      },
    ];

    const seedMcp = await callMcpTool("apply_ops", { project: mcpProj, ops: seedOps });
    expect(seedMcp.isError).toBe(false);
    const seedHttp = await postHttpOps(httpProj, { ops: seedOps });
    expect(seedHttp.status).toBe(200);

    const failingFixtures: Array<{ name: string; expectedCode: string; op: Record<string, unknown> }> = [
      {
        name: "unknown brick id",
        expectedCode: "UNKNOWN_BRICK",
        op: { opId: "f-1", type: "enable_brick", brickId: "non-existent-brick" },
      },
      {
        name: "invalid brick setting value",
        expectedCode: "INVALID_BRICK_CONFIG",
        op: {
          opId: "f-2",
          type: "configure_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 0 },
        },
      },
      {
        name: "declared brick conflict (document-parsing x document-pdf)",
        expectedCode: "BRICK_CONFLICT",
        op: { opId: "f-3", type: "enable_brick", brickId: "document-pdf" },
      },
      {
        name: "invalid identity brick",
        expectedCode: "INVALID_IDENTITY_BRICK",
        op: { opId: "f-4", type: "set_identity", identity: "multi-workspace" },
      },
      {
        name: "duplicate entity",
        expectedCode: "DUPLICATE_ENTITY",
        op: {
          opId: "f-5",
          type: "add_entity",
          entity: {
            name: "orders",
            fields: [{ name: "title", type: "text", required: true }],
          },
        },
      },
      {
        name: "entity route collision with brick routePrefix",
        expectedCode: "ENTITY_ROUTE_COLLISION",
        op: {
          opId: "f-6",
          type: "add_entity",
          entity: {
            name: "wallet",
            fields: [{ name: "note", type: "text", required: false }],
          },
        },
      },
      {
        name: "workflow cycle error",
        expectedCode: "cycle",
        op: {
          opId: "f-7",
          type: "add_workflow",
          workflow: {
            id: "wf-cycle",
            name: "Cycle WF",
            nodes: [
              { id: "t", type: "trigger.manual", data: {} },
              { id: "p1", type: "transform.pick", data: { path: "a" } },
              { id: "p2", type: "transform.pick", data: { path: "b" } },
            ],
            edges: [
              { id: "e1", source: "t", target: "p1", sourceHandle: "out", targetHandle: "in" },
              { id: "e2", source: "p1", target: "p2", sourceHandle: "out", targetHandle: "in" },
              { id: "e3", source: "p2", target: "p1", sourceHandle: "out", targetHandle: "in" },
            ],
          },
        },
      },
      {
        name: "workflow incompatible wire (json -> text)",
        expectedCode: "incompatible_wire",
        op: {
          opId: "f-8",
          type: "add_workflow",
          workflow: {
            id: "wf-wire",
            name: "Bad Wire",
            nodes: [
              { id: "t", type: "trigger.manual", data: {} },
              { id: "s", type: "sink.text", data: {} },
            ],
            edges: [{ id: "e1", source: "t", target: "s", sourceHandle: "out", targetHandle: "in" }],
          },
        },
      },
      {
        name: "raw secret value in bind_secret_ref",
        expectedCode: "INVALID_SECRET_REF",
        op: {
          opId: "f-9",
          type: "bind_secret_ref",
          ref: "sk_" + "live_51Nabc1234567890",
          targetKind: "brick",
          targetId: "credit-wallet",
          secretName: "STRIPE_SECRET",
        },
      },
    ];

    for (const fixture of failingFixtures) {
      const mcpRes = await callMcpTool("apply_ops", {
        project: mcpProj,
        ops: [fixture.op],
      });
      expect(mcpRes.isError, `MCP should reject ${fixture.name}`).toBe(true);
      const mcpErrPayload = mcpRes.json<{
        error: {
          code: string;
          issues: Array<{ code: string; path: string; message: string; suggestedFix?: string }>;
        };
      }>();

      const httpRes = await postHttpOps(httpProj, { ops: [fixture.op] });
      expect(httpRes.status, `HTTP should reject ${fixture.name} with 422`).toBe(422);
      const httpErrPayload = (await httpRes.json()) as {
        error: {
          code: string;
          issues: Array<{ code: string; path: string; message: string; suggestedFix?: string }>;
        };
      };

      expect(mcpErrPayload.error.code).toBe("VALIDATION_FAILED");
      expect(httpErrPayload.error.code).toBe("VALIDATION_FAILED");
      expect(mcpErrPayload.error.issues.map((i) => i.code)).toContain(fixture.expectedCode);
      expect(httpErrPayload.error.issues.map((i) => i.code)).toEqual(
        mcpErrPayload.error.issues.map((i) => i.code),
      );
      expect(mcpErrPayload.error.issues[0]?.path).toBe(httpErrPayload.error.issues[0]?.path);
      expect(mcpErrPayload.error.issues[0]?.suggestedFix).toBeDefined();
    }

    // Both projects are still at revision 1 after all 9 failing fixtures
    const { headers: mcpProjHeaders } = await ensureTestProjectToken(studioEnv, mcpProj);
    const { headers: authHeaders } = await ensureTestProjectToken(studioEnv, httpProj);
    const mcpStateAfter = (await (
      await studioApp.request(
        `/api/projects/${mcpProj}`,
        { method: "GET", headers: mcpProjHeaders },
        mcpStudioEnv,
      )
    ).json()) as ProjectStatePayload;
    const httpStateAfter = (await (
      await studioApp.request(
        `/api/projects/${httpProj}`,
        { method: "GET", headers: authHeaders },
        studioEnv,
      )
    ).json()) as ProjectStatePayload;
    expect(mcpStateAfter.revision).toBe(1);
    expect(httpStateAfter.revision).toBe(1);

    // Also test stale baseRevision conflict on MCP apply_ops (AC 4)
    const mcpConflict = await callMcpTool("apply_ops", {
      project: mcpProj,
      baseRevision: 0,
      ops: [
        {
          opId: "f-conflict",
          type: "configure_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 50 },
        },
      ],
    });
    expect(mcpConflict.isError).toBe(true);
    const conflictPayload = mcpConflict.json<{
      error: { code: string; baseRevision: number; currentRevision: number };
    }>();
    expect(conflictPayload.error.code).toBe("CONFLICT");
    expect(conflictPayload.error.baseRevision).toBe(0);
    expect(conflictPayload.error.currentRevision).toBe(1);
  });
});
