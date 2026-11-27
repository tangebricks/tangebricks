import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import { createDurableObjectBlueprintClient, createMcpApp } from "@poc/mcp-server";
import { testToken, testTokenId, testTokenVerifier } from "../../../packages/mcp-server/test/support/test-verifier.ts";
import type { BlueprintDoNamespaceLike } from "@poc/mcp-server";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import mcpMigrationSql from "../../../packages/mcp-server/migrations/0001_mcp_server.sql?raw";
import { app as studioApp } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { ensureTestAuthForPath } from "./project-token.ts";
import { postOpsWithReview } from "./human-session.ts";

const studioEnv = env as unknown as StudioApiEnv;
const mcpDb = (env as unknown as { DB: D1Like }).DB;
const rawDo = (env as unknown as { BLUEPRINT_DO: BlueprintDoNamespaceLike }).BLUEPRINT_DO;

// Story 0.15: the standalone MCP server has no shared bearer; each call presents a token bound to the project it
// names, and the author comes from that token, not from x-mcp-client headers.
const mcpApp = createMcpApp({ catalog, callsPerMinute: 10_000, verifyToken: testTokenVerifier });

async function studioReq(path: string, init: RequestInit = {}, targetEnv: StudioApiEnv = studioEnv): Promise<Response> {
  const { headers: authHeaders } = await ensureTestAuthForPath(targetEnv, path);
  // AD-V8: a token's edit applies when preview-safe; a money brick is proposed and the owner accepts it in Studio.
  const ops = /^\/api\/projects\/([^/]+)\/ops$/.exec(path);
  if (ops?.[1] && init.method === "POST" && typeof init.body === "string") {
    return postOpsWithReview(targetEnv, ops[1], authHeaders, JSON.parse(init.body) as Record<string, unknown>);
  }
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(authHeaders)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return studioApp.request(path, { ...init, headers }, targetEnv);
}

let rpcId = 1;
async function callMcpTool(name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await mcpApp.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${testToken(String(args.project ?? "default-project"), undefined, "Claude Code")}`,
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
      BLUEPRINT_DO: rawDo,
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

interface WsClientHarness {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  nextMessage: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => void;
}

async function connectWsClient(project: string, sinceRevision?: number): Promise<WsClientHarness> {
  const query = sinceRevision !== undefined ? `?sinceRevision=${sinceRevision}` : "";
  const response = await studioReq(
    `/api/projects/${project}/ws${query}`,
    {
      method: "GET",
      headers: {
        Upgrade: "websocket",
      },
    },
    studioEnv,
  );
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  expect(ws).toBeDefined();
  if (!ws) {
    throw new Error("Expected response.webSocket on 101 response");
  }

  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<(msg: Record<string, unknown>) => void> = [];

  ws.addEventListener("message", (event: MessageEvent) => {
    const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(parsed);
    } else {
      messages.push(parsed);
    }
  });

  ws.accept();

  const nextMessage = (timeoutMs = 200): Promise<Record<string, unknown>> => {
    const queued = messages.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(onMsg);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
      }, timeoutMs);
      const onMsg = (msg: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(msg);
      };
      waiters.push(onMsg);
    });
  };

  return {
    ws,
    messages,
    nextMessage,
    close: () => {
      try {
        ws.close(1000, "test complete");
      } catch {
        // ignore if already closed
      }
    },
  };
}

beforeEach(async () => {
  for (const table of ["mcp_files", "mcp_builds", "mcp_projects", "mcp_rate"]) {
    await mcpDb.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(mcpDb, mcpMigrationSql);
});

describe("Story 1.7 — Project WebSocket hub in BlueprintDO for live revision broadcasts", () => {
  test("two connected WebSocket clients both receive the exact revision broadcast within 200ms when an MCP tool mutates the project (AC 1, AC 2, AC 3, AC 5)", async () => {
    const project = "ws-live-broadcast";

    const client1 = await connectWsClient(project);
    const client2 = await connectWsClient(project);

    const conn1 = await client1.nextMessage(200);
    const conn2 = await client2.nextMessage(200);

    expect(conn1).toMatchObject({
      type: "connected",
      project,
      currentRevision: 0,
    });
    expect(conn2).toMatchObject({
      type: "connected",
      project,
      currentRevision: 0,
    });

    // Mutate via MCP enable_brick tool
    const mcpRes1 = await callMcpTool("enable_brick", {
      project,
      bricks: ["core-auth"],
    });
    const startEnable = Date.now();
    expect(mcpRes1.isError).toBe(false);

    const [rev1Client1, rev1Client2] = await Promise.all([client1.nextMessage(200), client2.nextMessage(200)]);
    const elapsedEnableMs = Date.now() - startEnable;
    expect(elapsedEnableMs).toBeLessThanOrEqual(200);

    expect(rev1Client1).toEqual(rev1Client2);
    expect(rev1Client1).toMatchObject({
      type: "revision",
      project,
      revision: 1,
      parentRevision: 0,
      author: {
        type: "agent",
        id: testTokenId(project, "Claude Code"),
        client: "Claude Code",
      },
      summary: "enable brick core-auth",
    });
    expect(Array.isArray(rev1Client1.ops)).toBe(true);
    expect((rev1Client1.ops as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "enable_brick",
      brickId: "core-auth",
    });

    // Mutate via MCP apply_ops tool
    const mcpRes2 = await callMcpTool("apply_ops", {
      project,
      baseRevision: 1,
      summary: "Enable multi-workspace and credit-wallet",
      ops: [
        {
          opId: "ws-op-mw",
          type: "enable_brick",
          brickId: "multi-workspace",
        },
        {
          opId: "ws-op-cw",
          type: "enable_brick",
          brickId: "credit-wallet",
        },
      ],
    });
    expect(mcpRes2.isError).toBe(false);

    // AD-V8: the money brick makes this a proposal; both clients see it, then the token's user accepts it in Studio
    // and both see the revision.
    const [prop2Client1, prop2Client2] = await Promise.all([client1.nextMessage(200), client2.nextMessage(200)]);
    expect(prop2Client1).toEqual(prop2Client2);
    expect(prop2Client1).toMatchObject({ type: "proposal", project });
    const proposalId = mcpRes2.json<{ proposalId: string }>().proposalId;
    const startApplyOps = Date.now();
    const accepted = await createDurableObjectBlueprintClient(rawDo).acceptProposal!({
      project,
      proposalId,
      reviewer: { type: "human", id: "test:studio-reviewer" },
    });
    expect(accepted.ok).toBe(true);

    const [rev2Client1, rev2Client2] = await Promise.all([client1.nextMessage(200), client2.nextMessage(200)]);
    const elapsedApplyOpsMs = Date.now() - startApplyOps;
    expect(elapsedApplyOpsMs).toBeLessThanOrEqual(200);

    expect(rev2Client1).toEqual(rev2Client2);
    expect(rev2Client1).toMatchObject({
      type: "revision",
      project,
      revision: 2,
      parentRevision: 1,
      author: {
        type: "agent",
        id: testTokenId(project, "Claude Code"),
        client: "Claude Code",
      },
      summary: "Enable multi-workspace and credit-wallet",
    });
    expect(rev2Client1.ops).toHaveLength(2);

    client1.close();
    client2.close();
  });

  test("client reconnecting with ?sinceRevision=2 when project is at revision 5 receives catchup with revisions 3, 4, and 5 in order (AC 2, AC 5)", async () => {
    const project = "ws-catchup-project";

    // Commit 5 revisions
    const steps: Array<{ opId: string; type: string; [key: string]: unknown }> = [
      { opId: "c-op-1", type: "enable_brick", brickId: "core-auth" },
      { opId: "c-op-2", type: "enable_brick", brickId: "multi-workspace" },
      { opId: "c-op-3", type: "enable_brick", brickId: "credit-wallet" },
      { opId: "c-op-4", type: "enable_brick", brickId: "dynamic-entities" },
      {
        opId: "c-op-5",
        type: "add_entity",
        entity: {
          name: "invoices",
          fields: [{ name: "title", type: "text", required: true, maxLength: 120 }],
        },
      },
    ];

    for (const op of steps) {
      const res = await studioReq(
        `/api/projects/${project}/ops`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            author: { type: "human", id: "alice" },
            ops: [op],
          }),
        },
        studioEnv,
      );
      expect(res.status).toBe(200);
    }

    const reconnecting = await connectWsClient(project, 2);
    const connectedMsg = await reconnecting.nextMessage(200);
    expect(connectedMsg).toMatchObject({
      type: "connected",
      project,
      currentRevision: 5,
    });

    const catchupMsg = await reconnecting.nextMessage(200);
    expect(catchupMsg).toMatchObject({
      type: "catchup",
      fromRevision: 2,
      toRevision: 5,
    });

    const revisions = catchupMsg.revisions as Array<{
      revision: number;
      parentRevision: number;
      ops: Array<{ opId: string; type: string }>;
      author: { type: string; id: string };
      summary: string;
      semanticHash: string;
      timestamp: string;
    }>;
    expect(revisions).toHaveLength(3);
    expect(revisions.map((r) => r.revision)).toEqual([3, 4, 5]);
    expect(revisions.map((r) => r.parentRevision)).toEqual([2, 3, 4]);
    expect(revisions[0]!.ops[0]!.opId).toBe("c-op-3");
    expect(revisions[1]!.ops[0]!.opId).toBe("c-op-4");
    expect(revisions[2]!.ops[0]!.opId).toBe("c-op-5");

    reconnecting.close();
  });

  test("failed/invalid mutations (409 or 422) broadcast nothing, and ping/invalid WebSocket frames are handled cleanly (AC 3, AC 4, AC 5)", async () => {
    const project = "ws-neg-and-frames";

    const client1 = await connectWsClient(project);
    const client2 = await connectWsClient(project);

    await client1.nextMessage(200); // connected
    await client2.nextMessage(200); // connected

    // Commit valid revision 1
    const okRes = await studioReq(
      `/api/projects/${project}/ops`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          author: { type: "human", id: "alice" },
          ops: [{ opId: "valid-1", type: "enable_brick", brickId: "core-auth" }],
        }),
      },
      studioEnv,
    );
    expect(okRes.status).toBe(200);

    await client1.nextMessage(200);
    await client2.nextMessage(200);

    // 1. Trigger 422 validation error (unknown brick ID)
    const err422 = await studioReq(
      `/api/projects/${project}/ops`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          author: { type: "human", id: "alice" },
          ops: [{ opId: "bad-422", type: "enable_brick", brickId: "non-existent-brick" }],
        }),
      },
      studioEnv,
    );
    expect(err422.status).toBe(422);

    // 2. Trigger 409 conflict (stale baseRevision with overlapping target)
    const err409 = await studioReq(
      `/api/projects/${project}/ops`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 0,
          author: { type: "human", id: "bob" },
          ops: [{ opId: "bad-409", type: "remove_brick", brickId: "core-auth" }],
        }),
      },
      studioEnv,
    );
    expect(err409.status).toBe(409);

    // 3. Test ping -> pong on client1
    client1.ws.send(JSON.stringify({ type: "ping" }));
    const pongMsg = await client1.nextMessage(200);
    expect(pongMsg).toEqual({ type: "pong" });

    // Verify no revision broadcasts were queued before pong
    expect(client1.messages).toHaveLength(0);
    expect(client2.messages).toHaveLength(0);

    // 4. Test invalid/unparsable frame -> BAD_MESSAGE without disconnecting client1 or client2
    client1.ws.send("not-valid-json{{{");
    const badJsonMsg = await client1.nextMessage(200);
    expect(badJsonMsg).toMatchObject({
      type: "error",
      code: "BAD_MESSAGE",
    });

    client1.ws.send(JSON.stringify({ type: "unknown_command" }));
    const badTypeMsg = await client1.nextMessage(200);
    expect(badTypeMsg).toMatchObject({
      type: "error",
      code: "BAD_MESSAGE",
    });

    // 5. Commit revision 2 and verify both client1 and client2 are still connected and receive it
    const okRes2 = await studioReq(
      `/api/projects/${project}/ops`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          author: { type: "human", id: "alice" },
          ops: [{ opId: "valid-2", type: "enable_brick", brickId: "multi-workspace" }],
        }),
      },
      studioEnv,
    );
    expect(okRes2.status).toBe(200);

    const [after1, after2] = await Promise.all([client1.nextMessage(200), client2.nextMessage(200)]);
    expect(after1).toMatchObject({ type: "revision", revision: 2 });
    expect(after2).toMatchObject({ type: "revision", revision: 2 });

    client1.close();
    client2.close();
  });
});
