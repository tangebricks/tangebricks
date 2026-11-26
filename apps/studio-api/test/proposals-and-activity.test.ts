import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import type { ProposalRecord } from "@poc/blueprint";
import { createMcpApp } from "@poc/mcp-server";
import { testToken, testTokenId, testTokenVerifier } from "../../../packages/mcp-server/test/support/test-verifier.ts";
import {
  defaultOwnerSessionHeaders,
  isApprovalGatedPath,
  sendWithOwnerApproval,
  signInTestHuman,
  withApprovalId,
} from "./human-session.ts";
import type { BlueprintDoNamespaceLike } from "@poc/mcp-server";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import mcpMigrationSql from "../../../packages/mcp-server/migrations/0001_mcp_server.sql?raw";
import { app as studioApp } from "../src/index.ts";
import type {
  ActivityFeedPayload,
  ProjectStatePayload,
  StudioApiEnv,
} from "../src/index.ts";
import { ensureTestAuthForPath } from "./project-token.ts";

const studioEnv = env as unknown as StudioApiEnv;
const mcpDb = (env as unknown as { DB: D1Like }).DB;
const mcpDo = (env as unknown as { BLUEPRINT_DO: BlueprintDoNamespaceLike }).BLUEPRINT_DO;

// Story 0.15: the standalone MCP server has no shared bearer; each call presents a token bound to the project it
// names, and the author comes from that token, not from x-mcp-client headers.
const mcpApp = createMcpApp({ catalog, callsPerMinute: 10_000, verifyToken: testTokenVerifier });

async function studioReq(
  path: string,
  init: RequestInit = {},
  targetEnv: StudioApiEnv = studioEnv,
): Promise<Response> {
  // AD-V8: accepting or rejecting a proposal is a Studio reviewer's action, so the default owner's session does it.
  const reviewing = /\/proposals\/[^/]+\/(accept|reject)$/.test(path);
  const { headers: authHeaders } = reviewing
    ? { headers: await defaultOwnerSessionHeaders(targetEnv) }
    : await ensureTestAuthForPath(targetEnv, path);
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(authHeaders)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  // AD-V8: a token's direct edit is sent with mode "apply" (these seeds are preview-safe; the default is a proposal).
  let body = init.body;
  if (/\/ops$/.test(path) && typeof body === "string") {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed.mode === undefined) body = JSON.stringify({ ...parsed, mode: "apply" });
  }
  // AD-V8: a token's deploy needs a Studio approval; the owner approves and the call is retried with the approval id.
  if (isApprovalGatedPath(path)) {
    const project = /\/api\/projects\/([^/]+)/.exec(path)![1]!;
    return sendWithOwnerApproval(targetEnv, project, async (approvalId) =>
      studioApp.request(path, { ...init, headers, body: withApprovalId(body, approvalId) as RequestInit["body"] }, targetEnv),
    );
  }
  return studioApp.request(path, { ...init, headers, body }, targetEnv);
}

let rpcId = 1;
async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  clientHeaders: { clientId?: string; clientName?: string } = {},
) {
  const response = await mcpApp.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${testToken(String(args.project ?? "default-project"), undefined, clientHeaders.clientName ?? "claude-code")}`,
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

async function openProjectWebSocket(project: string) {
  const stub = studioEnv.BLUEPRINT_DO.get(
    studioEnv.BLUEPRINT_DO.idFromName(project),
  );
  const wsRes = await stub.fetch(
    `https://blueprint.internal/ws?project=${encodeURIComponent(project)}`,
    {
      headers: { Upgrade: "websocket" },
    },
  );
  expect(wsRes.status).toBe(101);
  const ws = wsRes.webSocket!;
  ws.accept();
  const messages: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (evt) => {
    try {
      messages.push(JSON.parse(String(evt.data)) as Record<string, unknown>);
    } catch {
      // ignore non-json frames
    }
  });
  return { ws, messages };
}

beforeEach(async () => {
  for (const table of ["mcp_files", "mcp_builds", "mcp_projects", "mcp_rate"]) {
    await mcpDb.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(mcpDb, mcpMigrationSql);
});

describe("Story 7.2 — Draft Branch / Proposal Mode, Per-Op Review & Unified Activity Feed", () => {
  test("AC 1 & AC 2: MCP apply_ops with mode='propose' stores pending proposal in SQLite, keeps mainline rev unchanged, broadcasts WS event < 2s, and supports Accept All, Accept Per-Op (with 422 dependency guard), and Reject", async () => {
    const project = "proposal-review-flow";

    // Seed baseline r1 committed by human alice
    const seedRes = await studioReq(`/api/projects/${project}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        author: { type: "human", id: "alice" },
        summary: "Seed base billing workflow at r1",
        ops: [
          { opId: "r1-1", type: "enable_brick", brickId: "multi-workspace" },
          { opId: "r1-2", type: "enable_brick", brickId: "dynamic-entities" },
          {
            opId: "r1-3",
            type: "add_entity",
            entity: {
              name: "invoices",
              fields: [
                { name: "amount", type: "number", required: true },
                { name: "legacy_code", type: "text", required: false, maxLength: 64 },
              ],
            },
          },
          {
            opId: "r1-4",
            type: "add_workflow",
            workflow: {
              id: "wf-main",
              name: "Main Billing Workflow",
              nodes: [
                { id: "n_trigger", type: "trigger.manual", data: {} },
                { id: "n_transform", type: "transform.pick", data: { path: "invoice" } },
                { id: "n_legacy", type: "transform.pick", data: { path: "legacy" } },
              ],
              edges: [
                {
                  id: "e1",
                  source: "n_trigger",
                  target: "n_transform",
                  sourceHandle: "out",
                  targetHandle: "in",
                },
                {
                  id: "e2",
                  source: "n_transform",
                  target: "n_legacy",
                  sourceHandle: "out",
                  targetHandle: "in",
                },
              ],
            },
          },
        ],
      }),
    });
    expect(seedRes.status).toBe(200);
    const seedPayload = (await seedRes.json()) as ProjectStatePayload;
    expect(seedPayload.revision).toBe(1);

    // Connect WebSocket listener to verify < 2s broadcast
    const { ws, messages } = await openProjectWebSocket(project);

    // 1. Agent submits a 4-op proposal via MCP `apply_ops` with `mode: "propose"`
    const startedAt = Date.now();
    const mcpPropose = await callMcpTool("apply_ops", {
      project,
      baseRev: 1,
      mode: "propose",
      summary: "Propose adding n_added, updating n_transform, and removing n_legacy",
      ops: [
        {
          opId: "p1-add-node",
          type: "add_node",
          workflowId: "wf-main",
          node: { id: "n_added", type: "transform.pick", data: { path: "invoice.total" } },
        },
        {
          opId: "p1-update-node",
          type: "update_node",
          workflowId: "wf-main",
          nodeId: "n_transform",
          data: { path: "invoice.normalized" },
        },
        {
          opId: "p1-remove-node",
          type: "remove_node",
          workflowId: "wf-main",
          nodeId: "n_legacy",
        },
        {
          opId: "p1-add-edge",
          type: "connect_edges",
          workflowId: "wf-main",
          edges: [
            {
              id: "e_added",
              source: "n_transform",
              target: "n_added",
              sourceHandle: "out",
              targetHandle: "in",
            },
          ],
        },
      ],
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(2000);
    expect(mcpPropose.isError).toBe(false);

    const proposeData = mcpPropose.json<{
      mode: string;
      status: string;
      revision: number;
      proposalId: string;
      proposal: ProposalRecord;
    }>();
    expect(proposeData.mode).toBe("propose");
    expect(proposeData.status).toBe("pending");
    expect(proposeData.revision).toBe(1); // Mainline revision unchanged!
    expect(proposeData.proposal.status).toBe("pending");
    expect(proposeData.proposal.baseRev).toBe(1);
    // Story 0.15: the agent is the verified MCP token, not the x-mcp-client headers.
    expect(proposeData.proposal.actor).toMatchObject({
      type: "agent",
      id: testTokenId(project, "claude-code"),
      client: "claude-code",
    });

    // Verify WebSocket received `{ type: "proposal", action: "created", project, proposal }`
    const createdFrame = messages.find(
      (m) => m.type === "proposal" && m.action === "created",
    );
    expect(createdFrame).toBeDefined();
    expect(createdFrame?.project).toBe(project);
    expect((createdFrame?.proposal as ProposalRecord).proposalId).toBe(
      proposeData.proposalId,
    );

    // Verify mainline project state via GET /api/projects/:project is still at r1 and unchanged
    const stateWhilePendingRes = await studioReq(`/api/projects/${project}`);
    expect(stateWhilePendingRes.status).toBe(200);
    const stateWhilePending = (await stateWhilePendingRes.json()) as ProjectStatePayload;
    expect(stateWhilePending.revision).toBe(1);
    const wfWhilePending = stateWhilePending.state.workflows.find((w) => w.id === "wf-main")!;
    expect(wfWhilePending.nodes.map((n) => n.id)).toEqual([
      "n_legacy",
      "n_transform",
      "n_trigger",
    ]);

    // Verify GET /api/projects/:project/proposals lists the pending proposal
    const listRes = await studioReq(`/api/projects/${project}/proposals?status=pending`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      project: string;
      proposals: ProposalRecord[];
    };
    expect(listBody.proposals).toHaveLength(1);
    expect(listBody.proposals[0]?.proposalId).toBe(proposeData.proposalId);

    // 2. AC 2 Guard: Attempting to accept per-op while deselecting `p1-add-node` and keeping `p1-add-edge`
    // must fail with 422 VALIDATION_FAILED before commit without mutating mainline rev or proposal status
    const invalidPartialRes = await studioReq(
      `/api/projects/${project}/proposals/${proposeData.proposalId}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opIds: ["p1-update-node", "p1-remove-node", "p1-add-edge"],
        }),
      },
    );
    expect(invalidPartialRes.status).toBe(422);
    const invalidPartialErr = (await invalidPartialRes.json()) as {
      error: { code: string; issues: Array<{ code: string; message: string }> };
    };
    expect(invalidPartialErr.error.code).toBe("VALIDATION_FAILED");
    expect(invalidPartialErr.error.issues[0]?.code).toBe("MISSING_EDGE_ENDPOINT");

    // Confirm mainline rev is STILL 1 and proposal is STILL pending after failed partial accept
    const stateAfterFailedPartial = (await (
      await studioReq(`/api/projects/${project}`)
    ).json()) as ProjectStatePayload;
    expect(stateAfterFailedPartial.revision).toBe(1);
    const proposalsAfterFailedPartial = (await (
      await studioReq(`/api/projects/${project}/proposals?status=pending`)
    ).json()) as { proposals: ProposalRecord[] };
    expect(proposalsAfterFailedPartial.proposals).toHaveLength(1);
    expect(proposalsAfterFailedPartial.proposals[0]?.status).toBe("pending");

    // 3. AC 2 Accept Per-Op: Accept 3 of 4 ops (keep n_legacy by deselecting p1-remove-node)
    const validPartialRes = await studioReq(
      `/api/projects/${project}/proposals/${proposeData.proposalId}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opIds: ["p1-add-node", "p1-update-node", "p1-add-edge"],
        }),
      },
    );
    expect(validPartialRes.status).toBe(200);
    const validPartialBody = (await validPartialRes.json()) as {
      proposal: ProposalRecord;
      revision: number;
      state: ProjectStatePayload["state"];
    };
    expect(validPartialBody.revision).toBe(2);
    expect(validPartialBody.proposal.status).toBe("partially_accepted");
    expect(validPartialBody.proposal.acceptedRev).toBe(2);
    expect(validPartialBody.proposal.acceptedOpIds).toEqual([
      "p1-add-node",
      "p1-update-node",
      "p1-add-edge",
    ]);

    const wfAtR2 = validPartialBody.state.workflows.find((w) => w.id === "wf-main")!;
    expect(wfAtR2.nodes.map((n) => n.id)).toEqual([
      "n_added",
      "n_legacy",
      "n_transform",
      "n_trigger",
    ]);
    expect(wfAtR2.nodes.find((n) => n.id === "n_transform")?.data).toEqual({
      path: "invoice.normalized",
    });

    // Verify WebSocket received `{ type: "proposal", action: "partially_accepted" }`
    expect(
      messages.some(
        (m) =>
          m.type === "proposal" &&
          m.action === "partially_accepted" &&
          (m.proposal as ProposalRecord).proposalId === proposeData.proposalId,
      ),
    ).toBe(true);

    // 4. Create a second proposal via HTTP POST /api/projects/:project/proposals and test Accept All
    const prop2Res = await studioReq(`/api/projects/${project}/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 2,
        author: { type: "agent", id: "cursor-agent", client: "cursor" },
        summary: "Propose removing legacy node n_legacy",
        ops: [
          {
            opId: "p2-remove-legacy",
            type: "remove_node",
            workflowId: "wf-main",
            nodeId: "n_legacy",
          },
        ],
      }),
    });
    expect(prop2Res.status).toBe(200);
    const prop2Body = (await prop2Res.json()) as {
      proposalId: string;
      proposal: ProposalRecord;
      revision: number;
    };
    expect(prop2Body.revision).toBe(2); // Still r2 while pending

    const acceptAllRes = await studioReq(
      `/api/projects/${project}/proposals/${prop2Body.proposalId}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(acceptAllRes.status).toBe(200);
    const acceptAllBody = (await acceptAllRes.json()) as {
      proposal: ProposalRecord;
      revision: number;
      state: ProjectStatePayload["state"];
    };
    expect(acceptAllBody.revision).toBe(3);
    expect(acceptAllBody.proposal.status).toBe("accepted");
    expect(acceptAllBody.proposal.acceptedRev).toBe(3);
    expect(
      acceptAllBody.state.workflows
        .find((w) => w.id === "wf-main")!
        .nodes.map((n) => n.id),
    ).toEqual(["n_added", "n_transform", "n_trigger"]);

    // 5. Create a third proposal and Reject it -> mainline rev remains r3
    const prop3Res = await studioReq(`/api/projects/${project}/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 3,
        author: { type: "agent", id: "claude-code", client: "claude-code" },
        summary: "Propose enabling credit-wallet",
        ops: [
          {
            opId: "p3-enable-wallet",
            type: "enable_brick",
            brickId: "credit-wallet",
            config: { creditsPerUnit: 5, minOrderAmount: 50 },
          },
        ],
      }),
    });
    expect(prop3Res.status).toBe(200);
    const prop3Body = (await prop3Res.json()) as { proposalId: string };

    const rejectRes = await studioReq(
      `/api/projects/${project}/proposals/${prop3Body.proposalId}/reject`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Wallet brick not needed in this sprint" }),
      },
    );
    expect(rejectRes.status).toBe(200);
    const rejectBody = (await rejectRes.json()) as {
      proposal: ProposalRecord;
      revision: number;
    };
    expect(rejectBody.revision).toBe(3);
    expect(rejectBody.proposal.status).toBe("rejected");
    expect(rejectBody.proposal.rejectionReason).toBe(
      "Wallet brick not needed in this sprint",
    );

    expect(
      messages.some(
        (m) =>
          m.type === "proposal" &&
          m.action === "rejected" &&
          (m.proposal as ProposalRecord).proposalId === prop3Body.proposalId,
      ),
    ).toBe(true);

    ws.close();
  });

  test("AC 4 & AC 5: Unified Activity Feed (GET /api/projects/:project/activity) lists revisions, proposals, builds, deployments, connection changes, and runs in reverse chronological order with author/type/window filtering", async () => {
    const project = "activity-feed-unified";
    // Story 0.15: a human author is a signed-in person (a session), never a body `author`.
    const alice = await signInTestHuman(studioEnv, "alice", "owner", project);

    // 1. Revision r1 by human
    const rev1Res = await studioReq(`/api/projects/${project}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json", ...alice.headers },
      body: JSON.stringify({
        author: { type: "human", id: "alice" },
        summary: "Enable multi-workspace and workflow",
        ops: [
          { opId: "act-1", type: "enable_brick", brickId: "multi-workspace" },
          {
            opId: "act-2",
            type: "add_workflow",
            workflow: {
              id: "wf-act",
              name: "Activity Flow",
              nodes: [
                { id: "t1", type: "trigger.manual", data: {} },
                { id: "n1", type: "transform.pick", data: { path: "payload" } },
              ],
              edges: [
                {
                  id: "e1",
                  source: "t1",
                  target: "n1",
                  sourceHandle: "out",
                  targetHandle: "in",
                },
              ],
            },
          },
        ],
      }),
    });
    expect(rev1Res.status).toBe(200);

    // 2. Agent proposal created + accepted (r2)
    const propRes = await callMcpTool(
      "apply_ops",
      {
        project,
        baseRev: 1,
        mode: "propose",
        summary: "Agent proposal to configure displayName",
        ops: [
          {
            opId: "act-prop-1",
            type: "set_metadata",
            metadata: { displayName: "Agent Activity Project" },
          },
        ],
      },
      { clientId: "agent:claude-code", clientName: "claude-code" },
    );
    expect(propRes.isError).toBe(false);
    const { proposalId } = propRes.json<{ proposalId: string }>();

    const acceptRes = await studioReq(
      `/api/projects/${project}/proposals/${proposalId}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(acceptRes.status).toBe(200);

    // 3. Build project
    const buildRes = await studioReq(`/api/projects/${project}/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(buildRes.status).toBe(200);

    // 4. Deploy to preview (records environment.deploy event in activity feed)
    const deployRes = await studioReq(
      `/api/projects/${project}/environments/preview/deploy`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect([200, 422]).toContain(deployRes.status);

    // 5. Record a connection status change via /api/projects/:project/secrets
    const connRes = await studioReq(`/api/projects/${project}/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "sec_resend_api_key",
        kind: "api_key",
        label: "Resend Production Key",
        appOrBrick: "resend",
        envScope: "all",
        value: "re_test_activity_secret_key_123456",
      }),
    });
    expect([200, 201, 403]).toContain(connRes.status);

    // 6. Run workflow in preview
    const runRes = await studioReq(`/api/projects/${project}/workflows/wf-act/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: { payload: { hello: "world" } },
        env: "preview",
      }),
    });
    expect(runRes.status).toBe(200);

    // Query unified Activity Feed (all events)
    const activityRes = await studioReq(`/api/projects/${project}/activity`);
    expect(activityRes.status).toBe(200);
    const feed = (await activityRes.json()) as ActivityFeedPayload;
    expect(feed.project).toBe(project);
    expect(feed.events.length).toBeGreaterThanOrEqual(7);

    // Verify reverse chronological order
    for (let i = 1; i < feed.events.length; i += 1) {
      const prevTs = Date.parse(feed.events[i - 1]!.timestamp);
      const currTs = Date.parse(feed.events[i]!.timestamp);
      expect(prevTs).toBeGreaterThanOrEqual(currTs);
    }

    // Verify all required event types are present
    const eventTypes = new Set(feed.events.map((e) => e.type));
    expect(eventTypes.has("revision")).toBe(true);
    expect(eventTypes.has("proposal")).toBe(true);
    expect(eventTypes.has("build")).toBe(true);
    expect(eventTypes.has("deploy")).toBe(true);
    expect(eventTypes.has("connection")).toBe(true);
    expect(eventTypes.has("run")).toBe(true);

    // Verify exact actor attribution (`user:<id>` vs `agent:<id>` with client name)
    const agentEvents = feed.events.filter((e) => e.actor.type === "agent");
    expect(agentEvents.length).toBeGreaterThan(0);
    expect(
      agentEvents.some((e) => e.actor.displayId === `agent:${testTokenId(project, "claude-code")}`),
    ).toBe(true);
    expect(agentEvents.some((e) => e.actor.client === "claude-code")).toBe(true);

    const humanEvents = feed.events.filter((e) => e.actor.type === "human");
    expect(humanEvents.length).toBeGreaterThan(0);
    expect(humanEvents.every((e) => e.actor.displayId.startsWith("user:"))).toBe(true);
    expect(humanEvents.some((e) => e.actor.displayId === `user:${alice.userId}`)).toBe(true);

    // Filter by author=humans
    const humansOnlyRes = await studioReq(
      `/api/projects/${project}/activity?author=humans`,
    );
    const humansOnlyFeed = (await humansOnlyRes.json()) as ActivityFeedPayload;
    expect(humansOnlyFeed.events.length).toBeGreaterThan(0);
    expect(humansOnlyFeed.events.every((e) => e.actor.type === "human")).toBe(true);

    // Filter by author=agents
    const agentsOnlyRes = await studioReq(
      `/api/projects/${project}/activity?author=agents`,
    );
    const agentsOnlyFeed = (await agentsOnlyRes.json()) as ActivityFeedPayload;
    expect(agentsOnlyFeed.events.length).toBeGreaterThan(0);
    expect(agentsOnlyFeed.events.every((e) => e.actor.type === "agent")).toBe(true);

    // Filter by specific agent client (`claude-code`)
    const clientOnlyRes = await studioReq(
      `/api/projects/${project}/activity?author=claude-code`,
    );
    const clientOnlyFeed = (await clientOnlyRes.json()) as ActivityFeedPayload;
    expect(clientOnlyFeed.events.length).toBeGreaterThan(0);
    expect(
      clientOnlyFeed.events.every(
        (e) => e.actor.client === "claude-code" || e.actor.id === "claude-code",
      ),
    ).toBe(true);

    // Filter by event type (`proposal`)
    const proposalTypeRes = await studioReq(
      `/api/projects/${project}/activity?type=proposal`,
    );
    const proposalTypeFeed = (await proposalTypeRes.json()) as ActivityFeedPayload;
    expect(proposalTypeFeed.events.length).toBeGreaterThanOrEqual(2); // created + accepted
    expect(proposalTypeFeed.events.every((e) => e.type === "proposal")).toBe(true);

    // Filter by time window (`1h`)
    const windowRes = await studioReq(
      `/api/projects/${project}/activity?window=1h`,
    );
    const windowFeed = (await windowRes.json()) as ActivityFeedPayload;
    expect(windowFeed.events.length).toBe(feed.events.length);
  });
});
