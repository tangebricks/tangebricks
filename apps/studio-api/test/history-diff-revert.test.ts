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
import type { ProjectStatePayload, RevisionHistoryPayload, SemanticDiffPayload, StudioApiEnv } from "../src/index.ts";
import { ensureTestAuthForPath } from "./project-token.ts";
import { approveAsOwner, postOpsWithReview } from "./human-session.ts";

const studioEnv = env as unknown as StudioApiEnv;
const mcpDb = (env as unknown as { DB: D1Like }).DB;
const mcpDo = (env as unknown as { BLUEPRINT_DO: BlueprintDoNamespaceLike }).BLUEPRINT_DO;

// Story 0.15: the standalone MCP server has no shared bearer; each call presents a token bound to the project it
// names, and the author comes from that token, not from x-mcp-client headers.
const mcpApp = createMcpApp({ catalog, callsPerMinute: 10_000, verifyToken: testTokenVerifier });

async function studioReq(path: string, init: RequestInit = {}, targetEnv: StudioApiEnv = studioEnv): Promise<Response> {
  const { headers: authHeaders } = await ensureTestAuthForPath(targetEnv, path);
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(authHeaders)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return studioApp.request(path, { ...init, headers }, targetEnv);
}

let rpcId = 1;
async function callMcpTool(name: string, args: Record<string, unknown>) {
  const response = await mcpApp.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${testToken(String(args.project ?? "default-project"), undefined, "claude-code")}`,
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

async function postOps(
  project: string,
  body: {
    baseRevision?: number;
    author?: { type: "human" | "agent"; id: string; client?: string };
    summary?: string;
    ops: unknown[];
  },
) {
  // AD-V8: the token's edit applies when preview-safe; otherwise it is proposed and the owner accepts it in Studio.
  const { headers: authHeaders } = await ensureTestAuthForPath(studioEnv, `/api/projects/${project}/ops`);
  return postOpsWithReview(studioEnv, project, authHeaders, { author: { type: "human", id: "alice" }, ...body });
}

beforeEach(async () => {
  for (const table of ["mcp_files", "mcp_builds", "mcp_projects", "mcp_rate"]) {
    await mcpDb.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(mcpDb, mcpMigrationSql);
});

describe("Story 1.5 — Revision history, semantic diff, and revert via inverse ops", () => {
  test("diffing two revisions reports exact added/removed/updated bricks, entity fields, workflow nodes, and edges, while layout-only changes report diff.isEmpty === true (AC 1, AC 2, AC 4)", async () => {
    const project = "diff-api-proj";

    // Revision 1: initial bricks, entity, and workflow
    const r1 = await postOps(project, {
      summary: "Seed initial blueprint",
      ops: [
        { opId: "d1-a", type: "enable_brick", brickId: "multi-workspace" },
        {
          opId: "d1-b",
          type: "enable_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 10 },
        },
        { opId: "d1-c", type: "enable_brick", brickId: "dynamic-entities" },
        {
          opId: "d1-d",
          type: "add_entity",
          entity: {
            name: "customers",
            fields: [
              { name: "email", type: "text", required: true, maxLength: 100 },
              { name: "legacy_flag", type: "boolean", required: false },
            ],
          },
        },
        {
          opId: "d1-e",
          type: "add_workflow",
          workflow: {
            id: "wf-main",
            name: "Main Flow",
            nodes: [
              { id: "t1", type: "trigger.manual", label: "Start", data: {} },
              { id: "n1", type: "transform.pick", label: "Pick User", data: { path: "user" } },
            ],
            edges: [{ id: "e1", source: "t1", target: "n1", sourceHandle: "out", targetHandle: "in" }],
          },
        },
      ],
    });
    expect(r1.status).toBe(200);

    // Revision 2: semantic changes across bricks, entities, and workflows
    const r2 = await postOps(project, {
      summary: "Update bricks, entity fields, and workflow graph",
      ops: [
        {
          opId: "d2-a",
          type: "configure_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 25 },
          replace: true,
        },
        { opId: "d2-b", type: "enable_brick", brickId: "document-parsing" },
        {
          opId: "d2-c",
          type: "update_entity",
          entity: {
            name: "customers",
            fields: [
              { name: "email", type: "text", required: true, maxLength: 255 },
              { name: "tier", type: "enum", required: true, values: ["free", "pro"] },
            ],
          },
        },
        {
          opId: "d2-d",
          type: "update_node",
          workflowId: "wf-main",
          nodeId: "n1",
          patch: { label: "Pick Customer", data: { path: "customer" } },
        },
        {
          opId: "d2-e",
          type: "add_node",
          workflowId: "wf-main",
          node: { id: "n2", type: "transform.pick", label: "Pick Email", data: { path: "email" } },
        },
        {
          opId: "d2-f",
          type: "connect_edges",
          workflowId: "wf-main",
          edges: [{ id: "e2", source: "n1", target: "n2", sourceHandle: "out", targetHandle: "in" }],
        },
      ],
    });
    expect(r2.status).toBe(200);

    // Revision 3: metadata.layout & viewport only
    const r3 = await postOps(project, {
      summary: "Move canvas nodes",
      ops: [
        {
          opId: "d3-a",
          type: "set_metadata",
          metadata: {
            layout: {
              t1: { x: 80, y: 100 },
              n1: { x: 300, y: 100 },
              n2: { x: 520, y: 100 },
            },
            viewport: { x: 0, y: 0, zoom: 1.2 },
          },
        },
      ],
    });
    expect(r3.status).toBe(200);

    // Diff rev 1 -> rev 2
    const diff12Res = await studioReq(`/api/projects/${project}/diff?from=1&to=2`, { method: "GET" }, studioEnv);
    expect(diff12Res.status).toBe(200);
    const diff12 = (await diff12Res.json()) as SemanticDiffPayload;
    expect(diff12.fromRevision).toBe(1);
    expect(diff12.toRevision).toBe(2);
    expect(diff12.fromSemanticHash).not.toBe(diff12.toSemanticHash);
    expect(diff12.diff.isEmpty).toBe(false);
    expect(diff12.diff.bricks.added.map((b) => b.id)).toEqual(["document-parsing"]);
    expect(diff12.diff.bricks.updated.map((b) => b.id)).toEqual(["credit-wallet"]);
    expect(diff12.diff.entities.updated).toHaveLength(1);
    expect(diff12.diff.entities.updated[0]?.fieldsAdded.map((f) => f.name)).toEqual(["tier"]);
    expect(diff12.diff.entities.updated[0]?.fieldsRemoved.map((f) => f.name)).toEqual(["legacy_flag"]);
    expect(diff12.diff.entities.updated[0]?.fieldsUpdated.map((f) => f.name)).toEqual(["email"]);
    expect(diff12.diff.workflows.updated).toHaveLength(1);
    expect(diff12.diff.workflows.updated[0]?.nodesAdded.map((n) => n.id)).toEqual(["n2"]);
    expect(diff12.diff.workflows.updated[0]?.nodesUpdated.map((n) => n.id)).toEqual(["n1"]);
    expect(diff12.diff.workflows.updated[0]?.edgesAdded.map((e) => e.id)).toEqual(["e2"]);

    // Diff rev 2 -> rev 3 (layout-only change)
    const diff23Res = await studioReq(`/api/projects/${project}/diff?from=2&to=3`, { method: "GET" }, studioEnv);
    expect(diff23Res.status).toBe(200);
    const diff23 = (await diff23Res.json()) as SemanticDiffPayload;
    expect(diff23.fromSemanticHash).toBe(diff23.toSemanticHash);
    expect(diff23.diff.isEmpty).toBe(true);
  });

  test("building at revision 3 (hash3), applying revisions 4..7, and reverting to targetRevision: 3 produces revision 8 with identical semanticHash and buildHash while keeping revisions 1..7 intact (AC 2, AC 3, AC 4)", async () => {
    const project = "revert-build-proj";

    // Revision 1: enable core bricks
    expect(
      (
        await postOps(project, {
          summary: "Enable workspace, wallet, and entities",
          ops: [
            { opId: "r1-1", type: "enable_brick", brickId: "multi-workspace" },
            {
              opId: "r1-2",
              type: "enable_brick",
              brickId: "credit-wallet",
              config: { creditsPerUnit: 15, minOrderAmount: 100 },
            },
            { opId: "r1-3", type: "enable_brick", brickId: "dynamic-entities" },
          ],
        })
      ).status,
    ).toBe(200);

    // Revision 2: add invoices entity
    expect(
      (
        await postOps(project, {
          summary: "Add invoices entity",
          ops: [
            {
              opId: "r2-1",
              type: "add_entity",
              entity: {
                name: "invoices",
                fields: [
                  { name: "title", type: "text", required: true, maxLength: 160 },
                  { name: "amount_cents", type: "number", required: true, min: 0 },
                ],
              },
            },
          ],
        })
      ).status,
    ).toBe(200);

    // Revision 3: add billing workflow and bind secret ref
    const rev3Res = await postOps(project, {
      summary: "Add billing workflow and secret ref",
      ops: [
        {
          opId: "r3-1",
          type: "add_workflow",
          workflow: {
            id: "wf-billing",
            name: "Billing Workflow",
            nodes: [
              { id: "t1", type: "trigger.manual", label: "Trigger", data: {} },
              { id: "n1", type: "transform.pick", label: "Pick Title", data: { path: "title" } },
            ],
            edges: [{ id: "e1", source: "t1", target: "n1", sourceHandle: "out", targetHandle: "in" }],
          },
        },
        {
          opId: "r3-2",
          type: "bind_secret_ref",
          ref: "sec_wallet_prod",
          targetKind: "brick",
          targetId: "credit-wallet",
          secretName: "WALLET_KEY",
        },
      ],
    });
    expect(rev3Res.status).toBe(200);
    const rev3State = (await rev3Res.json()) as ProjectStatePayload;
    expect(rev3State.revision).toBe(3);

    // Build at revision 3 -> hash3
    const build3Res = await studioReq(`/api/projects/${project}/build`, { method: "POST" }, studioEnv);
    expect(build3Res.status).toBe(200);
    const build3 = (await build3Res.json()) as {
      project: string;
      revision: number;
      buildHash: string;
      files: number;
      bytes: number;
    };
    expect(build3.revision).toBe(3);
    const hash3 = build3.buildHash;

    // Revision 4: add brick document-parsing and reconfigure credit-wallet
    expect(
      (
        await postOps(project, {
          summary: "Enable document-parsing and update wallet config",
          ops: [
            { opId: "r4-1", type: "enable_brick", brickId: "document-parsing" },
            {
              opId: "r4-2",
              type: "configure_brick",
              brickId: "credit-wallet",
              config: { creditsPerUnit: 99, minOrderAmount: 500 },
              replace: true,
            },
          ],
        })
      ).status,
    ).toBe(200);

    // Revision 5: add second entity audit_notes and update invoices entity
    expect(
      (
        await postOps(project, {
          summary: "Add audit_notes and update invoices",
          ops: [
            {
              opId: "r5-1",
              type: "add_entity",
              entity: {
                name: "audit_notes",
                fields: [{ name: "note", type: "text", required: true, maxLength: 200 }],
              },
            },
            {
              opId: "r5-2",
              type: "update_entity",
              entity: {
                name: "invoices",
                fields: [
                  { name: "title", type: "text", required: true, maxLength: 80 },
                  { name: "amount_cents", type: "number", required: true, min: 10 },
                  { name: "paid", type: "boolean", required: false },
                ],
              },
            },
          ],
        })
      ).status,
    ).toBe(200);

    // Revision 6: add node n2 + edge e2 to wf-billing, and add a second workflow wf-temp
    expect(
      (
        await postOps(project, {
          summary: "Extend wf-billing and add wf-temp",
          ops: [
            {
              opId: "r6-1",
              type: "add_node",
              workflowId: "wf-billing",
              node: { id: "n2", type: "transform.pick", label: "Pick Paid", data: { path: "paid" } },
            },
            {
              opId: "r6-2",
              type: "connect_edges",
              workflowId: "wf-billing",
              edges: [{ id: "e2", source: "n1", target: "n2", sourceHandle: "out", targetHandle: "in" }],
            },
            {
              opId: "r6-3",
              type: "add_workflow",
              workflow: {
                id: "wf-temp",
                name: "Temporary Workflow",
                nodes: [{ id: "t-temp", type: "trigger.manual", data: {} }],
                edges: [],
              },
            },
          ],
        })
      ).status,
    ).toBe(200);

    // Revision 7: remove node n2 (and its incident edge e2), remove brick document-parsing, and update secret ref
    const rev7Res = await postOps(project, {
      summary: "Remove node n2, remove document-parsing, rotate secret ref",
      ops: [
        {
          opId: "r7-1",
          type: "remove_node",
          workflowId: "wf-billing",
          nodeId: "n2",
        },
        {
          opId: "r7-2",
          type: "remove_brick",
          brickId: "document-parsing",
        },
        {
          opId: "r7-3",
          type: "bind_secret_ref",
          ref: "sec_wallet_rotated",
          targetKind: "brick",
          targetId: "credit-wallet",
          secretName: "WALLET_KEY",
        },
      ],
    });
    expect(rev7Res.status).toBe(200);
    const rev7State = (await rev7Res.json()) as ProjectStatePayload;
    expect(rev7State.revision).toBe(7);
    expect(rev7State.semanticHash).not.toBe(rev3State.semanticHash);

    // Revert to targetRevision: 3 via POST /api/projects/:project/revert -> produces revision 8.
    // AD-V8: the caller is an MCP token, so the first try is refused with APPROVAL_REQUIRED; the owner approves the
    // request in Studio and the retry with the approval id runs the revert.
    const revertBody = {
      targetRevision: 3,
      baseRevision: 7,
      author: { type: "human", id: "bob", client: "studio-ui" },
    };
    const refusedRevert = await studioReq(
      `/api/projects/${project}/revert`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(revertBody) },
      studioEnv,
    );
    expect(refusedRevert.status).toBe(403);
    const refusal = (await refusedRevert.json()) as { error: { code: string; approvalId: string } };
    expect(refusal.error.code).toBe("APPROVAL_REQUIRED");
    expect((await approveAsOwner(studioEnv, project, refusal.error.approvalId)).status).toBe(200);
    const revertRes = await studioReq(
      `/api/projects/${project}/revert`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...revertBody, approvalId: refusal.error.approvalId }),
      },
      studioEnv,
    );
    expect(revertRes.status).toBe(200);
    const rev8State = (await revertRes.json()) as ProjectStatePayload;
    expect(rev8State.revision).toBe(8);
    expect(rev8State.parentRevision).toBe(7);
    expect(rev8State.revertedToRevision).toBe(3);
    expect(rev8State.summary).toBe("Revert to revision 3");
    expect(rev8State.semanticHash).toBe(rev3State.semanticHash);
    expect(rev8State.state).toEqual(rev3State.state);

    // Build at revision 8 -> buildHash must equal hash3
    const build8Res = await studioReq(`/api/projects/${project}/build`, { method: "POST" }, studioEnv);
    expect(build8Res.status).toBe(200);
    const build8 = (await build8Res.json()) as {
      project: string;
      revision: number;
      buildHash: string;
      files: number;
      bytes: number;
    };
    expect(build8.revision).toBe(8);
    expect(build8.buildHash).toBe(hash3);
    expect(build8.files).toBe(build3.files);
    expect(build8.bytes).toBe(build3.bytes);

    // Diff between revision 3 and revision 8 is empty
    const diff38Res = await studioReq(`/api/projects/${project}/diff?from=3&to=8`, { method: "GET" }, studioEnv);
    expect(diff38Res.status).toBe(200);
    const diff38 = (await diff38Res.json()) as SemanticDiffPayload;
    expect(diff38.diff.isEmpty).toBe(true);

    // Revisions 1..7 remain intact in GET /api/projects/:project/revisions history (with descending order & pagination)
    const historyPage1Res = await studioReq(`/api/projects/${project}/revisions?limit=5`, { method: "GET" }, studioEnv);
    expect(historyPage1Res.status).toBe(200);
    const page1 = (await historyPage1Res.json()) as RevisionHistoryPayload;
    expect(page1.revisions.map((r) => r.revision)).toEqual([8, 7, 6, 5, 4]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextBeforeRevision).toBe(4);
    expect(page1.revisions[0]?.summary).toBe("Revert to revision 3");
    expect(page1.revisions[0]?.opCount).toBeGreaterThan(0);

    const historyPage2Res = await studioReq(
      `/api/projects/${project}/revisions?limit=5&beforeRevision=${page1.nextBeforeRevision}`,
      { method: "GET" },
      studioEnv,
    );
    expect(historyPage2Res.status).toBe(200);
    const page2 = (await historyPage2Res.json()) as RevisionHistoryPayload;
    expect(page2.revisions.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextBeforeRevision).toBeNull();

    // Verify MCP revert_to_revision and apply_ops revertTo also work (AC 3)
    // Reverting from revision 8 back to revision 6 via MCP revert_to_revision creates revision 9 matching revision 6!
    const mcpRevert9 = await callMcpTool("revert_to_revision", {
      project,
      targetRevision: 6,
      baseRevision: 8,
    });
    expect(mcpRevert9.isError).toBe(false);
    expect(mcpRevert9.json()).toMatchObject({
      project,
      revision: 9,
      revertedToRevision: 6,
      enabled: ["credit-wallet", "document-parsing", "dynamic-entities", "multi-workspace"],
      entities: ["audit_notes", "invoices"],
    });

    const rev6Fetched = (await (await studioReq(`/api/projects/${project}/revisions/6`, { method: "GET" }, studioEnv)).json()) as ProjectStatePayload;
    const rev9Fetched = (await (await studioReq(`/api/projects/${project}/revisions/9`, { method: "GET" }, studioEnv)).json()) as ProjectStatePayload;
    expect(rev9Fetched.semanticHash).toBe(rev6Fetched.semanticHash);
    expect(rev9Fetched.author).toEqual({
      type: "agent",
      id: testTokenId(project, "claude-code"),
      client: "claude-code",
      onBehalfOf: TEST_TOKEN_USER_ID,
    });

    // And reverting via apply_ops { project, revertTo: 3 } creates revision 10 matching revision 3 again!
    const mcpRevert10 = await callMcpTool("apply_ops", {
      project,
      revertTo: 3,
      baseRevision: 9,
    });
    expect(mcpRevert10.isError).toBe(false);
    expect(mcpRevert10.json()).toMatchObject({
      project,
      revision: 10,
      revertedToRevision: 3,
    });

    const mcpBuild10 = await callMcpTool("build_project", { project });
    expect(mcpBuild10.isError).toBe(false);
    expect(mcpBuild10.json<{ hash: string }>().hash).toBe(hash3);
  });
});
