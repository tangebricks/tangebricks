import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { createEmptyBlueprint, targetKey } from "@poc/blueprint";
import type { BlueprintState } from "@poc/blueprint";
import { app } from "../src/index.ts";
import type {
  AuthorAttribution,
  ConflictErrorPayload,
  ProjectStatePayload,
  StudioApiEnv,
} from "../src/index.ts";
import { ensureTestProjectToken } from "./project-token.ts";
import { postOpsWithReview } from "./human-session.ts";

const studioEnv = env as unknown as StudioApiEnv;

// Story 0.15: the author of a write is the verified caller, never a body `author`. Each named actor ("alice", "claude")
// is a caller of its own (an MCP token for the project, labelled with the actor's name); the body `author` is still sent
// and is ignored.
async function actorToken(project: string, actor = "studio-test") {
  return ensureTestProjectToken(studioEnv, project, { clientName: actor });
}
async function actorAuthor(project: string, actor: string): Promise<AuthorAttribution> {
  const t = await actorToken(project, actor);
  return { type: "agent", id: t.tokenId, client: actor, onBehalfOf: t.userId };
}

/** A conflict names the conflicting revision's author without onBehalfOf. */
async function conflictAuthor(project: string, actor: string) {
  const { onBehalfOf: _onBehalfOf, ...rest } = await actorAuthor(project, actor);
  return rest;
}

async function postOps(
  project: string,
  body: {
    baseRevision?: number;
    author?: AuthorAttribution;
    summary?: string;
    ops: unknown[];
  },
) {
  const { headers: authHeaders } = await actorToken(project, body.author?.id);
  // AD-V8: preview-safe edits apply directly; a money brick goes through a proposal the owner accepts in Studio.
  return postOpsWithReview(studioEnv, project, authHeaders, body);
}

describe("Story 1.3 — Optimistic concurrency: baseRevision, auto-rebase, and 409 conflict payload", () => {
  test("targetKey deterministically extracts logical targets for all op types (AC 2)", () => {
    expect(targetKey({ opId: "1", type: "enable_brick", brickId: "credit-wallet" })).toEqual([
      "brick:credit-wallet",
    ]);
    expect(
      targetKey({
        opId: "2",
        type: "configure_brick",
        brickId: "credit-wallet",
        config: { creditsPerUnit: 10 },
      }),
    ).toEqual(["brick:credit-wallet"]);
    expect(targetKey({ opId: "3", type: "remove_brick", brickId: "credit-wallet" })).toEqual([
      "brick:credit-wallet",
    ]);
    expect(targetKey({ opId: "4", type: "set_identity", identity: "core-auth" })).toEqual([
      "identity",
    ]);
    expect(
      targetKey({
        opId: "5",
        type: "add_entity",
        entity: {
          name: "invoices",
          fields: [{ name: "title", type: "text", required: true, maxLength: 100 }],
        },
      }),
    ).toEqual(["entity:invoices"]);
    expect(
      targetKey({
        opId: "6",
        type: "update_entity",
        entity: {
          name: "invoices",
          fields: [{ name: "title", type: "text", required: true, maxLength: 120 }],
        },
      }),
    ).toEqual(["entity:invoices"]);
    expect(targetKey({ opId: "7", type: "remove_entity", name: "invoices" })).toEqual([
      "entity:invoices",
    ]);
    expect(
      targetKey({
        opId: "8",
        type: "add_workflow",
        workflow: { id: "wf-1", name: "WF 1", nodes: [], edges: [] },
      }),
    ).toEqual(["workflow:wf-1"]);
    expect(targetKey({ opId: "9", type: "remove_workflow", workflowId: "wf-1" })).toEqual([
      "workflow:wf-1",
    ]);
    expect(
      targetKey({
        opId: "10",
        type: "add_node",
        workflowId: "wf-1",
        node: { id: "node-a", type: "trigger.manual", data: {} },
      }),
    ).toEqual(["workflow:wf-1:node:node-a"]);
    expect(
      targetKey({
        opId: "11",
        type: "update_node",
        workflowId: "wf-1",
        nodeId: "node-a",
        patch: { label: "Updated" },
      }),
    ).toEqual(["workflow:wf-1:node:node-a"]);

    const stateWithWf: BlueprintState = {
      ...createEmptyBlueprint("target-test"),
      workflows: [
        {
          id: "wf-1",
          name: "WF 1",
          nodes: [
            { id: "t1", type: "trigger.manual", data: {} },
            { id: "node-a", type: "transform.pick", data: { path: "a" } },
          ],
          edges: [
            { id: "e-1", source: "t1", target: "node-a", sourceHandle: "out", targetHandle: "in" },
          ],
        },
      ],
    };

    expect(
      targetKey(
        { opId: "12", type: "remove_node", workflowId: "wf-1", nodeId: "node-a" },
        stateWithWf,
      ),
    ).toEqual(["workflow:wf-1:edge:e-1", "workflow:wf-1:node:node-a"]);

    expect(
      targetKey({
        opId: "13",
        type: "connect_edges",
        workflowId: "wf-1",
        edges: [
          { id: "e-1", source: "t1", target: "node-a", sourceHandle: "out", targetHandle: "in" },
        ],
      }),
    ).toEqual([
      "workflow:wf-1:edge:e-1",
      "workflow:wf-1:port:node-a:in:in",
      "workflow:wf-1:port:t1:out:out",
    ]);

    expect(
      targetKey(
        { opId: "14", type: "disconnect_edge", workflowId: "wf-1", edgeId: "e-1" },
        stateWithWf,
      ),
    ).toEqual([
      "workflow:wf-1:edge:e-1",
      "workflow:wf-1:port:node-a:in:in",
      "workflow:wf-1:port:t1:out:out",
    ]);

    expect(
      targetKey({
        opId: "15",
        type: "bind_secret_ref",
        ref: "sec_stripe_key",
        targetKind: "brick",
        targetId: "core-auth",
        secretName: "BETTER_AUTH_SECRET",
      }),
    ).toEqual(["secret:brick:core-auth:BETTER_AUTH_SECRET", "secret:sec_stripe_key"]);

    expect(
      targetKey({
        opId: "16",
        type: "set_metadata",
        metadata: {
          displayName: "My SaaS",
          layout: { "node-a": { x: 100, y: 200 }, "node-b": { x: 300, y: 400 } },
        },
      }),
    ).toEqual(["layout:node-a", "layout:node-b", "meta:displayName"]);
  });

  test("non-overlapping concurrent edits (Human edits node-a, Agent edits node-b at baseRevision: 1) auto-rebase and both land (AC 3, AC 4)", async () => {
    const project = "concurrent-rebase";

    // Revision 1: initialize workflow wf-1 with t1 -> node-a -> node-b
    const initRes = await postOps(project, {
      author: { type: "human", id: "alice" },
      summary: "Seed workflow with node-a and node-b",
      ops: [
        { opId: "seed-brick-mw", type: "enable_brick", brickId: "multi-workspace" },
        { opId: "seed-brick-cw", type: "enable_brick", brickId: "credit-wallet" },
        {
          opId: "seed-wf-1",
          type: "add_workflow",
          workflow: {
            id: "wf-1",
            name: "Order Pipeline",
            trigger: { kind: "manual" },
            nodes: [
              { id: "t1", type: "trigger.manual", label: "Trigger", data: {} },
              { id: "node-a", type: "transform.pick", label: "Node A Initial", data: { path: "order.id" } },
              { id: "node-b", type: "transform.pick", label: "Node B Initial", data: { path: "order.total" } },
            ],
            edges: [
              { id: "e-1", source: "t1", target: "node-a", sourceHandle: "out", targetHandle: "in" },
              { id: "e-2", source: "node-a", target: "node-b", sourceHandle: "out", targetHandle: "in" },
            ],
          },
        },
      ],
    });
    expect(initRes.status).toBe(200);
    const rev1 = (await initRes.json()) as ProjectStatePayload;
    expect(rev1.revision).toBe(1);

    // Human (baseRevision: 1) edits node-a -> lands at revision 2
    const humanRes = await postOps(project, {
      baseRevision: 1,
      author: { type: "human", id: "alice" },
      summary: "Human updates node-a",
      ops: [
        {
          opId: "human-edit-node-a",
          type: "update_node",
          workflowId: "wf-1",
          nodeId: "node-a",
          patch: {
            label: "Node A by Alice",
            data: { path: "customer.id" },
          },
        },
      ],
    });
    expect(humanRes.status).toBe(200);
    const rev2 = (await humanRes.json()) as ProjectStatePayload;
    expect(rev2.revision).toBe(2);
    expect(rev2.parentRevision).toBe(1);
    expect(rev2.rebasedFrom).toBeUndefined();

    // Agent (also at stale baseRevision: 1) edits node-b -> auto-rebases onto revision 2 and lands at revision 3
    const agentRes = await postOps(project, {
      baseRevision: 1,
      author: { type: "agent", id: "claude", client: "claude-code" },
      summary: "Agent updates node-b",
      ops: [
        {
          opId: "agent-edit-node-b",
          type: "update_node",
          workflowId: "wf-1",
          nodeId: "node-b",
          patch: {
            label: "Node B by Claude",
            data: { path: "invoice.amount_cents" },
          },
        },
      ],
    });
    expect(agentRes.status).toBe(200);
    const rev3 = (await agentRes.json()) as ProjectStatePayload;
    expect(rev3.revision).toBe(3);
    expect(rev3.parentRevision).toBe(2);
    expect(rev3.rebasedFrom).toBe(1);
    expect(rev3.author).toEqual(await actorAuthor(project, "claude"));

    // Both edits are present in revision 3
    const wf = rev3.state.workflows.find((w) => w.id === "wf-1");
    expect(wf).toBeDefined();
    const nodeA = wf?.nodes.find((n) => n.id === "node-a");
    const nodeB = wf?.nodes.find((n) => n.id === "node-b");
    expect(nodeA?.label).toBe("Node A by Alice");
    expect(nodeA?.data).toEqual({ path: "customer.id" });
    expect(nodeB?.label).toBe("Node B by Claude");
    expect(nodeB?.data).toEqual({ path: "invoice.amount_cents" });

    // Concurrent layout drags on different nodes at stale baseRevision also auto-rebase cleanly
    const dragARes = await postOps(project, {
      baseRevision: 3,
      author: { type: "human", id: "alice" },
      ops: [
        {
          opId: "drag-node-a",
          type: "set_metadata",
          metadata: { layout: { "node-a": { x: 120, y: 80 } } },
        },
      ],
    });
    expect(dragARes.status).toBe(200);

    const dragBRes = await postOps(project, {
      baseRevision: 3,
      author: { type: "agent", id: "claude" },
      ops: [
        {
          opId: "drag-node-b",
          type: "set_metadata",
          metadata: { layout: { "node-b": { x: 420, y: 260 } } },
        },
      ],
    });
    expect(dragBRes.status).toBe(200);
    const rev5 = (await dragBRes.json()) as ProjectStatePayload;
    expect(rev5.revision).toBe(5);
    expect(rev5.rebasedFrom).toBe(3);
    expect(rev5.state.metadata.layout).toEqual({
      "node-a": { x: 120, y: 80 },
      "node-b": { x: 420, y: 260 },
    });
  });

  test("overlapping concurrent edits to the same node or brick reject with HTTP 409 Conflict carrying conflicts, currentState, and interveningOps (AC 3, AC 4)", async () => {
    const project = "concurrent-conflict";

    // Revision 1: initialize workflow wf-1 with t1 -> node-a and credit-wallet brick
    const initRes = await postOps(project, {
      author: { type: "human", id: "alice" },
      ops: [
        { opId: "c-init-mw", type: "enable_brick", brickId: "multi-workspace" },
        { opId: "c-init-cw", type: "enable_brick", brickId: "credit-wallet", config: { creditsPerUnit: 10 } },
        {
          opId: "c-init-wf",
          type: "add_workflow",
          workflow: {
            id: "wf-1",
            name: "Main Workflow",
            trigger: { kind: "manual" },
            nodes: [
              { id: "t1", type: "trigger.manual", data: {} },
              { id: "node-a", type: "transform.pick", label: "Initial A", data: { path: "input.value" } },
            ],
            edges: [
              { id: "e-1", source: "t1", target: "node-a", sourceHandle: "out", targetHandle: "in" },
            ],
          },
        },
      ],
    });
    expect(initRes.status).toBe(200);

    // 1. Both Human (baseRevision: 1) and Agent (baseRevision: 1) edit node-a.
    // Agent lands first at revision 2:
    const agentWinRes = await postOps(project, {
      baseRevision: 1,
      author: { type: "agent", id: "claude" },
      summary: "Agent edits node-a",
      ops: [
        {
          opId: "agent-node-a-op",
          type: "update_node",
          workflowId: "wf-1",
          nodeId: "node-a",
          patch: {
            label: "Agent Node A",
            data: { path: "agent.path" },
          },
        },
      ],
    });
    expect(agentWinRes.status).toBe(200);
    const rev2 = (await agentWinRes.json()) as ProjectStatePayload;
    expect(rev2.revision).toBe(2);

    // Human submits competing edit to node-a at stale baseRevision: 1 -> gets 409 Conflict
    const humanConflictRes = await postOps(project, {
      baseRevision: 1,
      author: { type: "human", id: "alice" },
      summary: "Human edits node-a",
      ops: [
        {
          opId: "human-node-a-op",
          type: "update_node",
          workflowId: "wf-1",
          nodeId: "node-a",
          patch: {
            label: "Human Node A",
            data: { path: "human.path" },
          },
        },
      ],
    });
    expect(humanConflictRes.status).toBe(409);
    const conflictBody = (await humanConflictRes.json()) as { error: ConflictErrorPayload };
    expect(conflictBody.error.code).toBe("CONFLICT");
    expect(conflictBody.error.baseRevision).toBe(1);
    expect(conflictBody.error.currentRevision).toBe(2);
    expect(conflictBody.error.conflicts).toEqual([
      {
        opId: "human-node-a-op",
        target: "workflow:wf-1:node:node-a",
        conflictingRevision: 2,
        conflictingAuthor: await conflictAuthor(project, "claude"),
      },
    ]);
    expect(conflictBody.error.currentState).toEqual(rev2.state);
    expect(conflictBody.error.interveningOps).toHaveLength(1);
    expect(conflictBody.error.interveningOps[0]?.opId).toBe("agent-node-a-op");
    expect(conflictBody.error.interveningOps[0]?.revision).toBe(2);

    // 2. Both Human (baseRevision: 2) and Agent (baseRevision: 2) configure the same brick (credit-wallet).
    // Human lands first at revision 3:
    const humanBrickRes = await postOps(project, {
      baseRevision: 2,
      author: { type: "human", id: "alice" },
      ops: [
        {
          opId: "human-cw-config",
          type: "configure_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 25 },
        },
      ],
    });
    expect(humanBrickRes.status).toBe(200);
    const rev3 = (await humanBrickRes.json()) as ProjectStatePayload;
    expect(rev3.revision).toBe(3);

    // Agent submits competing configure_brick on credit-wallet at baseRevision: 2 -> gets 409 Conflict
    const agentBrickConflictRes = await postOps(project, {
      baseRevision: 2,
      author: { type: "agent", id: "claude" },
      ops: [
        {
          opId: "agent-cw-config",
          type: "configure_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 50 },
        },
      ],
    });
    expect(agentBrickConflictRes.status).toBe(409);
    const brickConflictBody = (await agentBrickConflictRes.json()) as {
      error: ConflictErrorPayload;
    };
    expect(brickConflictBody.error.code).toBe("CONFLICT");
    expect(brickConflictBody.error.baseRevision).toBe(2);
    expect(brickConflictBody.error.currentRevision).toBe(3);
    expect(brickConflictBody.error.conflicts).toEqual([
      {
        opId: "agent-cw-config",
        target: "brick:credit-wallet",
        conflictingRevision: 3,
        conflictingAuthor: await conflictAuthor(project, "alice"),
      },
    ]);

    // 3. Disjoint targetKeys that fail applyOps against currentState (e.g., enabling conflicting bricks document-parsing and document-pdf at baseRevision: 3) -> 409 Conflict
    const docParsingRes = await postOps(project, {
      baseRevision: 3,
      author: { type: "human", id: "alice" },
      ops: [{ opId: "enable-doc-parsing", type: "enable_brick", brickId: "document-parsing" }],
    });
    expect(docParsingRes.status).toBe(200);

    const docPdfRes = await postOps(project, {
      baseRevision: 3,
      author: { type: "agent", id: "claude" },
      ops: [{ opId: "enable-doc-pdf", type: "enable_brick", brickId: "document-pdf" }],
    });
    expect(docPdfRes.status).toBe(409);
    const docPdfConflict = (await docPdfRes.json()) as { error: ConflictErrorPayload };
    expect(docPdfConflict.error.code).toBe("CONFLICT");
    expect(docPdfConflict.error.currentRevision).toBe(4);
    expect(docPdfConflict.error.conflicts[0]?.target).toBe("brick:document-pdf");

    // 4. baseRevision > currentRevision -> 409 Conflict
    const futureBaseRes = await postOps(project, {
      baseRevision: 99,
      author: { type: "agent", id: "claude" },
      ops: [{ opId: "future-op", type: "enable_brick", brickId: "webhook-outbox" }],
    });
    expect(futureBaseRes.status).toBe(409);
    const futureConflict = (await futureBaseRes.json()) as { error: ConflictErrorPayload };
    expect(futureConflict.error.code).toBe("CONFLICT");
    expect(futureConflict.error.baseRevision).toBe(99);
    expect(futureConflict.error.currentRevision).toBe(4);
  });

  test("idempotent opId retry returns 200 OK with the committed revision state without creating a duplicate revision (AC 1, AC 4)", async () => {
    const project = "idempotent-retry";

    const batchPayload = {
      baseRevision: 0,
      author: { type: "human" as const, id: "alice" },
      summary: "Enable workspace and wallet",
      ops: [
        { opId: "idem-op-1", type: "enable_brick", brickId: "multi-workspace" },
        {
          opId: "idem-op-2",
          type: "enable_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 15 },
        },
      ],
    };

    // First submission commits revision 1
    const firstRes = await postOps(project, batchPayload);
    expect(firstRes.status).toBe(200);
    const firstData = (await firstRes.json()) as ProjectStatePayload;
    expect(firstData.revision).toBe(1);

    // Retry with identical opIds and original baseRevision: 0 -> returns 200 OK at revision 1
    const secondRes = await postOps(project, batchPayload);
    expect(secondRes.status).toBe(200);
    const secondData = (await secondRes.json()) as ProjectStatePayload;
    expect(secondData.revision).toBe(1);
    expect(secondData.semanticHash).toBe(firstData.semanticHash);
    expect(secondData.state).toEqual(firstData.state);

    // Retry without baseRevision -> still returns 200 OK at revision 1
    const thirdRes = await postOps(project, {
      author: { type: "human", id: "alice" },
      ops: batchPayload.ops,
    });
    expect(thirdRes.status).toBe(200);
    const thirdData = (await thirdRes.json()) as ProjectStatePayload;
    expect(thirdData.revision).toBe(1);

    // Verify GET /api/projects/:project is still at revision 1 (no duplicate revision 2 created)
    const { headers: authHeaders } = await ensureTestProjectToken(studioEnv, project);
    const stateRes = await app.request(
      `/api/projects/${project}`,
      { method: "GET", headers: authHeaders },
      studioEnv,
    );
    expect(stateRes.status).toBe(200);
    const current = (await stateRes.json()) as ProjectStatePayload;
    expect(current.revision).toBe(1);

    // Revision 2 does not exist
    const rev2Res = await app.request(
      `/api/projects/${project}/revisions/2`,
      { method: "GET", headers: authHeaders },
      studioEnv,
    );
    expect(rev2Res.status).toBe(404);
  });
});
