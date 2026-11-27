// AD-V8 on the standalone MCP surface and the blueprint clients:
//   - apply_ops without a mode is a proposal; the blueprint is unchanged until a reviewer accepts it;
//   - mode "apply" is refused (PROPOSAL_REQUIRED) for a money brick, a destructive op or a brick upgrade;
//   - the legacy enable_brick / define_entity follow mode "apply"'s rules;
//   - no tool can accept, approve or reject;
//   - the in-memory client stores proposals and accepts / rejects them exactly as the DO client does.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_mcp_server.sql?raw";
import {
  ALL_TOOLS,
  TOOLS,
  classifyApplyRisk,
  createDurableObjectBlueprintClient,
  createInMemoryBlueprintClient,
  createMcpApp,
  pinBlueprintClient,
} from "../src/index.ts";
import type { BlueprintClient, BlueprintDoNamespaceLike } from "../src/index.ts";
import { testToken, testTokenVerifier } from "./support/test-verifier.ts";

const db = env.DB as D1Like;
const rawDo = (env as unknown as { BLUEPRINT_DO: BlueprintDoNamespaceLike }).BLUEPRINT_DO;
let epoch = 0;
const doNamespace: BlueprintDoNamespaceLike = {
  idFromName: (name: string) => rawDo.idFromName(`proposals-default-${epoch}:${name}`),
  get: (id: unknown) => rawDo.get(id),
};

const reviewer = { type: "human" as const, id: "user:reviewer" };
const agent = { type: "agent" as const, id: "mcp_token_1", client: "claude-code", onBehalfOf: "user:owner" };

beforeEach(async () => {
  epoch += 1;
  for (const table of ["mcp_files", "mcp_builds", "mcp_projects", "mcp_rate"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, migration);
});

let rpcId = 1;
async function callTool(
  app: ReturnType<typeof createMcpApp>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; json: Record<string, any>; text: string }> {
  const res = await app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${testToken(String(args.project))}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    }),
    { DB: db, BLUEPRINT_DO: doNamespace },
  );
  const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  const text = body.result.content[0]?.text ?? "";
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    json = {};
  }
  return { isError: body.result.isError === true, json, text };
}

const clients: Array<[string, () => BlueprintClient]> = [
  ["in-memory", () => createInMemoryBlueprintClient(catalog)],
  ["Durable Object", () => createDurableObjectBlueprintClient(doNamespace)],
];

describe.each(clients)("the %s client stores and reviews proposals", (_name, make) => {
  const seedOps = [{ opId: "seed-ws", type: "enable_brick", brickId: "multi-workspace" }];

  it("a proposal is listed, leaves the blueprint unchanged, and accepting it commits it as the agent on behalf of the reviewer", async () => {
    const client = make();
    const project = `prop-accept-${epoch}`;
    expect((await client.applyOps({ project, author: reviewer, ops: seedOps, mode: "apply" })).ok).toBe(true);
    const proposed = await client.applyOps({
      project,
      author: agent,
      mode: "propose",
      ops: [{ opId: "p-wallet", type: "enable_brick", brickId: "credit-wallet" }],
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.data.status).toBe("pending");
    expect(proposed.data.revision).toBe(1);
    expect((await client.getProject(project))!.revision).toBe(1);

    const listed = await client.listProposals!(project);
    expect(listed.map((p) => p.proposalId)).toEqual([proposed.data.proposalId]);
    expect(await client.listProposals!(project, "pending")).toHaveLength(1);
    expect(await client.listProposals!(project, "accepted")).toHaveLength(0);
    expect((await client.getProposal!(project, proposed.data.proposalId!))?.status).toBe("pending");

    const accepted = await client.acceptProposal!({ project, proposalId: proposed.data.proposalId!, reviewer });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.data.status).toBe("accepted");
    expect(accepted.data.revision).toBe(2);
    expect(accepted.data.proposal).toMatchObject({ status: "accepted", acceptedRev: 2, acceptedOpIds: ["p-wallet"] });
    const after = await client.getProject(project);
    expect(after!.revision).toBe(2);
    expect(accepted.data.author).toMatchObject({ type: "agent", id: agent.id, onBehalfOf: reviewer.id });
    expect(after!.state.bricks.map((b) => b.id)).toContain("credit-wallet");

    const twice = await client.acceptProposal!({ project, proposalId: proposed.data.proposalId!, reviewer });
    expect(twice).toMatchObject({ ok: false, status: 409, error: { code: "PROPOSAL_ALREADY_REVIEWED" } });
  });

  it("rejecting leaves the blueprint unchanged; an unknown proposal is 404; a partial accept follows the selection rules", async () => {
    const client = make();
    const project = `prop-reject-${epoch}`;
    await client.applyOps({ project, author: reviewer, ops: seedOps, mode: "apply" });
    const first = await client.applyOps({
      project,
      author: agent,
      mode: "propose",
      ops: [{ opId: "r-name", type: "set_metadata", metadata: { displayName: "x" } }],
    });
    if (!first.ok) throw new Error("propose failed");
    const rejected = await client.rejectProposal!({ project, proposalId: first.data.proposalId!, reviewer, reason: "no" });
    expect(rejected).toMatchObject({ ok: true, data: { status: "rejected", revision: 1 } });
    expect(await client.getProposal!(project, first.data.proposalId!)).toMatchObject({ status: "rejected", rejectionReason: "no" });
    expect((await client.getProject(project))!.revision).toBe(1);

    expect(await client.acceptProposal!({ project, proposalId: "prop_missing", reviewer })).toMatchObject({
      ok: false,
      status: 404,
      error: { code: "PROPOSAL_NOT_FOUND" },
    });

    const two = await client.applyOps({
      project,
      author: agent,
      mode: "propose",
      ops: [
        { opId: "two-a", type: "set_metadata", metadata: { displayName: "a" } },
        { opId: "two-b", type: "enable_brick", brickId: "feature-flags" },
      ],
    });
    if (!two.ok) throw new Error("propose failed");
    const partial = await client.acceptProposal!({ project, proposalId: two.data.proposalId!, opIds: ["two-b"], reviewer });
    expect(partial).toMatchObject({ ok: true, data: { status: "partially_accepted", revision: 2 } });
    const unknownOp = await client.applyOps({
      project,
      author: agent,
      mode: "propose",
      ops: [{ opId: "three", type: "set_metadata", metadata: { displayName: "c" } }],
    });
    if (!unknownOp.ok) throw new Error("propose failed");
    expect(await client.acceptProposal!({ project, proposalId: unknownOp.data.proposalId!, opIds: ["nope"], reviewer })).toMatchObject({
      ok: false,
      status: 422,
    });
  });

  it("a pinned client reaches the proposals of its own project only", async () => {
    const client = make();
    const project = `prop-pin-${epoch}`;
    await client.applyOps({ project, author: agent, mode: "propose", ops: seedOps });
    const pinned = pinBlueprintClient(client, project);
    expect(await pinned.listProposals!(project)).toHaveLength(1);
    expect(await pinned.listProposals!("someone-else")).toEqual([]);
    await expect(pinned.acceptProposal!({ project: "someone-else", proposalId: "x", reviewer })).rejects.toThrow(/outside the project/);
  });
});

// The same edit rows against the Durable Object client and against the standalone server's in-memory client.
const surfaces: Array<[string, () => { app: ReturnType<typeof createMcpApp>; client: BlueprintClient }]> = [
  [
    "Durable Object",
    () => ({
      app: createMcpApp({ catalog, callsPerMinute: 10_000, verifyToken: testTokenVerifier }),
      client: createDurableObjectBlueprintClient(doNamespace),
    }),
  ],
  [
    "in-memory (standalone)",
    () => {
      const client = createInMemoryBlueprintClient(catalog);
      return { app: createMcpApp({ catalog, callsPerMinute: 10_000, verifyToken: testTokenVerifier, blueprintClient: client }), client };
    },
  ],
];

describe.each(surfaces)("the MCP tools on the %s client: proposals by default, risky applies refused", (_name, make) => {
  const { app, client } = make();

  it("apply_ops without a mode proposes; the blueprint is unchanged and the proposal is stored", async () => {
    const project = `tool-default-${epoch}`;
    const reply = await callTool(app, "apply_ops", {
      project,
      ops: [{ opId: "d-ws", type: "enable_brick", brickId: "multi-workspace" }],
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.json).toMatchObject({ mode: "propose", status: "pending", revision: 0 });
    expect(reply.json.proposal).toMatchObject({ status: "pending", opIds: ["d-ws"] });
    expect(reply.json.diffSummary.bricks.added).toEqual(["multi-workspace"]);
    const stored = await client.listProposals!(project, "pending");
    expect(stored.map((p) => p.proposalId)).toEqual([reply.json.proposalId]);
    expect((await client.getProject(project))?.revision ?? 0).toBe(0);
  });

  it("mode apply applies a preview-safe edit", async () => {
    const project = `tool-apply-${epoch}`;
    const reply = await callTool(app, "apply_ops", {
      project,
      mode: "apply",
      ops: [{ opId: "a-ws", type: "enable_brick", brickId: "multi-workspace" }],
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.json.revision).toBe(1);
  });

  it.each([
    ["an op on a money brick", [{ opId: "m", type: "enable_brick", brickId: "subscription-plans" }], "money setting"],
    ["a destructive op", [{ opId: "d", type: "remove_brick", brickId: "multi-workspace" }], "destructive"],
    ["a brick upgrade", [{ opId: "u", type: "set_metadata", metadata: { catalogVersion: "9.9.9" } }], "brick upgrade"],
  ])("mode apply with %s is PROPOSAL_REQUIRED and changes nothing", async (_label, ops, reason) => {
    const project = `tool-risky-${epoch}`;
    const reply = await callTool(app, "apply_ops", { project, mode: "apply", ops });
    expect(reply.isError).toBe(true);
    expect(reply.json.error.code).toBe("PROPOSAL_REQUIRED");
    expect(reply.json.error.reasons.join(";")).toContain(reason);
    expect(reply.json.error.remediation).toMatch(/propose/);
    expect((await client.getProject(project))?.revision ?? 0).toBe(0);
  });

  it("the legacy enable_brick refuses a money brick and applies a plain one", async () => {
    const project = `tool-legacy-${epoch}`;
    const refused = await callTool(app, "enable_brick", { project, bricks: ["checkout-gateway"] });
    expect(refused.isError).toBe(true);
    expect(refused.json.error.code).toBe("PROPOSAL_REQUIRED");
    const applied = await callTool(app, "enable_brick", { project, bricks: ["multi-workspace"] });
    expect(applied.isError, applied.text).toBe(false);
  });

  it("no MCP tool can accept, approve or reject, and deploy_apply and revert_to_revision take an approvalId", () => {
    expect(ALL_TOOLS.map((t) => t.name).filter((n) => /accept|approve|reject|review/.test(n))).toEqual([]);
    const shape = (name: string) => Object.keys((ALL_TOOLS.find((t) => t.name === name)!.input as unknown as { shape: Record<string, unknown> }).shape);
    expect(shape("deploy_apply")).toContain("approvalId");
    expect(shape("revert_to_revision")).toContain("approvalId");
    expect(TOOLS.find((t) => t.name === "apply_ops")!.description).toMatch(/Propose \(default\)/);
  });

  it("set_metadata with replace drops a pinned catalogVersion: refused as a brick upgrade", async () => {
    const project = `tool-replace-${epoch}`;
    expect(
      (await client.applyOps({ project, author: reviewer, mode: "apply", ops: [{ opId: "pin", type: "set_metadata", metadata: { catalogVersion: "1.0.0" } }] }))
        .ok,
    ).toBe(true);
    const reply = await callTool(app, "apply_ops", {
      project,
      mode: "apply",
      ops: [{ opId: "rep", type: "set_metadata", metadata: { displayName: "x" }, replace: true }],
    });
    expect(reply.isError).toBe(true);
    expect(reply.json.error.code).toBe("PROPOSAL_REQUIRED");
    expect(reply.json.error.reasons.join(";")).toContain("replace drops catalogVersion");
  });

  it("a workflow edit that touches money is refused for direct apply: a money node added, or any edit in a workflow that holds one", async () => {
    const project = `tool-money-wf-${epoch}`;
    const seeded = await client.applyOps({
      project,
      author: reviewer,
      mode: "apply",
      ops: [
        { opId: "s-ws", type: "enable_brick", brickId: "multi-workspace" },
        { opId: "s-cw", type: "enable_brick", brickId: "credit-wallet" },
        {
          opId: "s-wf-plain",
          type: "add_workflow",
          workflow: { id: "wf_plain", name: "Plain", trigger: { kind: "manual" }, nodes: [{ id: "t", type: "trigger.manual", data: {} }], edges: [] },
        },
        {
          opId: "s-wf-money",
          type: "add_workflow",
          workflow: {
            id: "wf_money",
            name: "Money",
            trigger: { kind: "manual" },
            nodes: [
              { id: "t", type: "trigger.manual", data: {} },
              { id: "pick", type: "transform.pick", data: { path: "amount" } },
              { id: "debit", type: "credit-wallet.debit", data: { amount: 1 } },
            ],
            edges: [],
          },
        },
      ],
    });
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);

    const addMoneyNode = await callTool(app, "apply_ops", {
      project,
      mode: "apply",
      ops: [{ opId: "m1", type: "add_node", workflowId: "wf_plain", node: { id: "d2", type: "credit-wallet.debit", data: { amount: 2 } } }],
    });
    expect(addMoneyNode.json.error?.code).toBe("PROPOSAL_REQUIRED");
    expect(addMoneyNode.json.error.reasons.join(";")).toContain("add_node:credit-wallet.debit");

    const editInMoneyWorkflow = await callTool(app, "apply_ops", {
      project,
      mode: "apply",
      ops: [{ opId: "m2", type: "update_node", workflowId: "wf_money", nodeId: "pick", data: { path: "total" } }],
    });
    expect(editInMoneyWorkflow.json.error?.code).toBe("PROPOSAL_REQUIRED");
    expect(editInMoneyWorkflow.json.error.reasons.join(";")).toContain("wf_money (holds a money node)");

    const plainEdit = await callTool(app, "apply_ops", {
      project,
      mode: "apply",
      ops: [{ opId: "m3", type: "add_node", workflowId: "wf_plain", node: { id: "p2", type: "transform.pick", data: { path: "x" } } }],
    });
    expect(plainEdit.isError, plainEdit.text).toBe(false);
  });

  it("classifyApplyRisk is the one shared test", () => {
    expect(classifyApplyRisk([{ type: "add_entity", entity: { name: "x" } }])).toEqual({ risky: false, reasons: [] });
    expect(classifyApplyRisk([{ type: "configure_brick", brickId: "metered-usage" }]).risky).toBe(true);
    expect(classifyApplyRisk([{ type: "bind_secret_ref", targetId: "credit-wallet" }]).risky).toBe(true);
    const replaceOp = [{ type: "set_metadata", metadata: { displayName: "x" }, replace: true }];
    expect(classifyApplyRisk(replaceOp).risky).toBe(false);
    expect(classifyApplyRisk(replaceOp, { currentCatalogVersion: "1.0.0" }).reasons).toEqual(["brick upgrade: set_metadata replace drops catalogVersion"]);
    expect(classifyApplyRisk([{ type: "set_metadata", metadata: { catalogVersion: null } }]).risky).toBe(true);
    expect(classifyApplyRisk([{ type: "set_metadata", metadata: { displayName: "x" } }], { liveProduction: true }).reasons).toEqual([
      "production: the project has a live production deployment, so a direct edit would reach it",
    ]);
  });
});
