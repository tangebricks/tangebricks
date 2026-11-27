import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { assemble, hashFiles } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_mcp_server.sql?raw";
import { PROTOCOL_VERSION, createDurableObjectBlueprintClient, createMcpApp, projectHash, withinRateLimit } from "../src/index.ts";
import type { BlueprintDoNamespaceLike } from "../src/index.ts";
import { ALL_TOOLS, toolDescriptions } from "../src/tools.ts";
import { createEntityRoutes } from "../../../bricks/dynamic-entities/src/index.ts";
import type { EntityEnv } from "../../../bricks/dynamic-entities/src/index.ts";
import { TEST_TOKEN_USER_ID, projectOf, testToken, testTokenId, testTokenVerifier } from "./support/test-verifier.ts";

const db = env.DB as D1Like;
const rawDoNamespace = (env as unknown as { BLUEPRINT_DO: BlueprintDoNamespaceLike }).BLUEPRINT_DO;
let testEpoch = 0;
const scopedDoNamespace: BlueprintDoNamespaceLike = {
  idFromName: (name: string) => rawDoNamespace.idFromName(`mcp-test-${testEpoch}:${name}`),
  get: (id: unknown) => rawDoNamespace.get(id),
};
const doClient = createDurableObjectBlueprintClient(scopedDoNamespace);
const stored = async (project: string) => {
  const snap = await doClient.getProject(project);
  return snap
    ? {
        blueprint: { bricks: snap.state.bricks, entities: snap.state.entities },
        version: snap.revision,
      }
    : null;
};
// Story 0.15: no shared bearer. Each call presents a token bound to the project it names (testToken); TOKEN is the one for "p1".
const TOKEN = testToken("p1");
const app = createMcpApp({ catalog, allowedOrigins: ["https://studio.example"], callsPerMinute: 10_000, verifyToken: testTokenVerifier });

type Reply = { status: number; body: any; headers: Headers; text: string };
interface Send {
  headers?: Record<string, string | null>;
  raw?: string;
  token?: string | null;
  env?: Record<string, unknown>;
}
async function post(message: unknown, send: Send = {}, appUnderTest = app): Promise<Reply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(send.token === null ? {} : { authorization: `Bearer ${send.token ?? testToken(projectOf(message) ?? "p")}` }),
  };
  for (const [name, value] of Object.entries(send.headers ?? {})) {
    if (value === null) delete headers[name];
    else headers[name] = value;
  }
  const response = await appUnderTest.fetch(new Request("http://localhost/mcp", { method: "POST", headers, body: send.raw ?? JSON.stringify(message) }), {
    DB: db,
    BLUEPRINT_DO: scopedDoNamespace,
    ...send.env,
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON (a 202 or 405 has no body)
  }
  return { status: response.status, body, headers: response.headers, text };
}
let nextId = 1;
const request = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
const callTool = (name: string, args: unknown, send?: Send) => post(request("tools/call", { name, arguments: args }), send);
const toolText = (reply: Reply) => reply.body.result.content[0].text as string;
const toolJson = (reply: Reply) => JSON.parse(toolText(reply));
// AD-V8: an agent proposes a money brick (enable_brick refuses it) and a person accepts the proposal in Studio; here the
// test plays that person through the blueprint client's acceptProposal, which no MCP tool can reach.
let reviewSeq = 0;
async function enableReviewed(project: string, bricks: Array<string | { id: string; config?: Record<string, unknown> }>) {
  const enabled = new Set((await doClient.getProject(project))?.state.bricks.map((b) => b.id) ?? []);
  const ops = bricks.map((item) => {
    const { id, config } = typeof item === "string" ? { id: item, config: {} } : { id: item.id, config: item.config ?? {} };
    reviewSeq += 1;
    return enabled.has(id)
      ? { opId: `review-${reviewSeq}`, type: "configure_brick", brickId: id, config, replace: true }
      : { opId: `review-${reviewSeq}`, type: "enable_brick", brickId: id, ...(Object.keys(config).length > 0 ? { config } : {}) };
  });
  const proposed = toolJson(await callTool("apply_ops", { project, ops }));
  expect(proposed.status).toBe("pending");
  const accepted = await doClient.acceptProposal!({ project, proposalId: proposed.proposalId, reviewer: { type: "human", id: "test:studio-reviewer" } });
  expect(accepted.ok).toBe(true);
}
const count = async (table: string, project: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project = ?`).bind(project).first<{ n: number }>())!.n;

beforeEach(async () => {
  expect.hasAssertions();
  testEpoch += 1;
  for (const table of ["mcp_files", "mcp_builds", "mcp_projects", "mcp_rate"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, migration);
});

describe("the protocol", () => {
  it("initialize answers with the version, the tools capability, the server's name and a short instruction", async () => {
    const reply = await post(request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe("application/json");
    expect(reply.body).toMatchObject({
      jsonrpc: "2.0",
      id: expect.any(Number),
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "projectx-poc-assembler", version: "0.0.0" },
      },
    });
    expect(reply.body.result.instructions).toMatch(/enable_brick/);
    // stateless: no session is assigned
    expect(reply.headers.get("mcp-session-id")).toBeNull();
  });

  it("answers with its own version even when the client asks for another", async () => {
    expect(
      (await post(request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "old", version: "1" } }))).body.result
        .protocolVersion,
    ).toBe("2025-11-25");
  });

  it("the response carries the request's id, whether a number or a string", async () => {
    expect((await post({ jsonrpc: "2.0", id: 41, method: "ping" })).body).toEqual({ jsonrpc: "2.0", id: 41, result: {} });
    expect((await post({ jsonrpc: "2.0", id: "abc-7", method: "ping" })).body).toEqual({ jsonrpc: "2.0", id: "abc-7", result: {} });
  });

  it("a notification is accepted with 202 and no body", async () => {
    const reply = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(reply.status).toBe(202);
    expect(reply.text).toBe("");
  });

  it("a response from the client is accepted with 202 and no body", async () => {
    expect((await post({ jsonrpc: "2.0", id: 5, result: {} })).status).toBe(202);
    expect((await post({ jsonrpc: "2.0", id: 5, error: { code: -1, message: "x" } })).status).toBe(202);
  });

  it("tools/list names the evolved tools, each with an object schema and safety annotations", async () => {
    const reply = await post(request("tools/list"));
    const tools = reply.body.result.tools as Array<{ name: string; description: string; inputSchema: any; annotations?: any }>;
    expect(tools.map((t) => t.name)).toEqual([
      "search_bricks",
      "get_brick",
      "search_nodes",
      "get_node",
      "get_blueprint_summary",
      "get_blueprint_slice",
      "validate_blueprint",
      "apply_ops",
      "request_connection",
      "list_connections",
      "test_workflow",
      "list_runs",
      "get_run_trace",
      "query_logs",
      "deploy_plan",
      "deploy_apply",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
      expect(tool.annotations).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
      });
    }
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).toEqual([
      "search_bricks",
      "get_brick",
      "search_nodes",
      "get_node",
      "get_blueprint_summary",
      "get_blueprint_slice",
      "validate_blueprint",
      "list_connections",
      "list_runs",
      "get_run_trace",
      "query_logs",
      "deploy_plan",
    ]);
    expect(tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name)).toEqual(["apply_ops", "deploy_apply"]);
    expect(tools.find((t) => t.name === "apply_ops")!.inputSchema.required).toEqual(["project", "ops"]);
    expect(tools.find((t) => t.name === "deploy_apply")!.inputSchema.additionalProperties).not.toBe(true);
  });

  it("ping answers with an empty result", async () => {
    expect((await post(request("ping"))).body.result).toEqual({});
  });

  it("GET and DELETE are 405 with Allow: POST (no server stream, no sessions)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await app.fetch(new Request("http://localhost/mcp", { method }), { DB: db });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("an unknown method is a protocol error: method not found", async () => {
    const reply = await post(request("resources/list"));
    expect(reply.status).toBe(200);
    expect(reply.body.error).toMatchObject({ code: -32601 });
    expect(reply.body.id).toBeTypeOf("number");
  });
});

describe("a request the server cannot read", () => {
  it.each([
    ["not JSON", { raw: "{nope" }, 400, -32700],
    ["an empty body", { raw: "" }, 400, -32700],
    ["a list (batching was removed)", { raw: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]) }, 400, -32600],
    [
      "a list holding two valid requests",
      {
        raw: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "ping" },
          { jsonrpc: "2.0", id: 2, method: "ping" },
        ]),
      },
      400,
      -32600,
    ],
    ["a number", { raw: "7" }, 400, -32600],
    ["null", { raw: "null" }, 400, -32600],
    ["the wrong jsonrpc version", { raw: JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }) }, 400, -32600],
    ["no method", { raw: JSON.stringify({ jsonrpc: "2.0", id: 1 }) }, 400, -32600],
    ["a method that is not text", { raw: JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 }) }, 400, -32600],
    ["an id that is null", { raw: JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }) }, 400, -32600],
    ["an id that is an object", { raw: JSON.stringify({ jsonrpc: "2.0", id: {}, method: "ping" }) }, 400, -32600],
  ])("%s is a JSON-RPC error with HTTP %i", async (_label, send, status, code) => {
    const reply = await post(undefined, send as Send);
    expect(reply.status).toBe(status);
    expect(reply.body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code } });
  });

  it("params that are not an object are invalid params", async () => {
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: [1] })).body.error.code).toBe(-32602);
  });

  it("an unsupported MCP-Protocol-Version header is 400, a matching one is fine, and none is fine", async () => {
    expect((await post(request("ping"), { headers: { "mcp-protocol-version": "2099-01-01" } })).status).toBe(400);
    expect((await post(request("ping"), { headers: { "mcp-protocol-version": "2025-11-25" } })).status).toBe(200);
    expect((await post(request("ping"))).status).toBe(200);
  });

  it("a body that is not declared as JSON is 415, and a client that accepts nothing we send is 406", async () => {
    expect((await post(request("ping"), { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await post(request("ping"), { headers: { "content-type": null } })).status).toBe(415);
    expect((await post(request("ping"), { headers: { accept: "text/event-stream" } })).status).toBe(406);
    expect((await post(request("ping"), { headers: { accept: null } })).status).toBe(200);
    expect((await post(request("ping"), { headers: { accept: "*/*" } })).status).toBe(200);
  });

  it("a body over the limit is 413", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { padding: "x".repeat(300_000) } });
    expect((await post(undefined, { raw: big })).status).toBe(413);
  });
});

describe("who may call", () => {
  it.each([
    ["no token", { token: null }],
    ["a wrong token", { token: "not-the-token" }],
    ["a token that is a prefix of the real one", { token: TOKEN.slice(0, 10) }],
    ["the real token with something added", { token: TOKEN + "x" }],
    ["an empty token", { token: "" }],
    ["the token without the Bearer word", { token: null, headers: { authorization: TOKEN } }],
    ["a Basic header", { token: null, headers: { authorization: `Basic ${TOKEN}` } }],
  ])("%s is 401 and nothing happens", async (_label, send) => {
    const reply = await callTool("enable_brick", { project: "p1", bricks: ["multi-workspace"] }, send as Send);
    expect(reply.status).toBe(401);
    expect(reply.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect(reply.text).not.toContain(TOKEN);
    expect(await count("mcp_projects", "p1")).toBe(0);
    expect((await post(request("tools/list"), send as Send)).status).toBe(401);
    expect((await post(request("initialize", {}), send as Send)).status).toBe(401);
  });

  it("a server with no token verifier refuses everyone, including a caller who sends a token that would verify (STANDALONE_NO_VERIFIER)", async () => {
    const unverified = createMcpApp({ catalog, callsPerMinute: 10_000 });
    for (const send of [{}, { token: "" }, { token: null }, { token: TOKEN }]) {
      expect((await post(request("ping"), send as Send, unverified)).status).toBe(503);
      expect((await post(request("tools/list"), send as Send, unverified)).status).toBe(503);
      const call = await post(
        request("tools/call", { name: "enable_brick", arguments: { project: "p1", bricks: ["multi-workspace"] } }),
        send as Send,
        unverified,
      );
      expect(call.status).toBe(503);
    }
    expect(await count("mcp_projects", "p1")).toBe(0);
  });

  it("a verifier that throws or answers malformed records refuses the call", async () => {
    for (const verifyToken of [
      async () => {
        throw new Error("verifier down");
      },
      async () => ({ userId: "", projectId: "p1", scopes: ["read" as const] }),
      async () => ({ userId: "u", projectId: "", scopes: ["read" as const] }),
      async () => ({ userId: "u", projectId: "p1", scopes: [] }),
      async () => ({ userId: "u", projectId: "p1", scopes: ["*"] as never }),
    ]) {
      const strict = createMcpApp({ catalog, callsPerMinute: 10_000, verifyToken });
      expect((await post(request("ping"), {}, strict)).status).toBe(401);
    }
  });

  it("an Origin that is not allowed is 403 even with the right token; an allowed one, and none, are fine", async () => {
    expect((await post(request("ping"), { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await post(request("ping"), { headers: { origin: "null" } })).status).toBe(403);
    expect((await post(request("ping"), { headers: { origin: "https://studio.example.evil.example" } })).status).toBe(403);
    expect((await post(request("ping"), { headers: { origin: "https://studio.example" } })).status).toBe(200);
  });

  it("the token is checked before the Origin-free path is trusted, and the order does not leak whether a project exists", async () => {
    await callTool("enable_brick", { project: "exists", bricks: ["multi-workspace"] });
    const a = await callTool("build_project", { project: "exists" }, { token: "wrong" });
    const b = await callTool("build_project", { project: "does-not-exist" }, { token: "wrong" });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.text).toBe(b.text);
  });

  it("too many calls in a minute are 429 with Retry-After, and the refused call does nothing", async () => {
    const limited = createMcpApp({ catalog, callsPerMinute: 3, verifyToken: testTokenVerifier });
    const results: number[] = [];
    for (let i = 0; i < 5; i += 1)
      results.push(
        (await post(request("tools/call", { name: "enable_brick", arguments: { project: "rate", bricks: ["multi-workspace"] } }), {}, limited)).status,
      );
    expect(results).toEqual([200, 200, 200, 429, 429]);
    const refused = await post(request("tools/call", { name: "list_bricks", arguments: {} }), {}, limited);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await withinRateLimit(db, 3, Date.now() + 120_000)).toBe(true); // a later minute starts again
  });
});

describe("a token bound to one project (story 0.15, STANDALONE_VERIFIER)", () => {
  const readP1 = testToken("p1", ["read"]);

  it("a read token reads its own project, with or without naming it", async () => {
    await callTool("enable_brick", { project: "p1", bricks: ["multi-workspace"] });
    const named = await callTool("get_blueprint_summary", { project: "p1" }, { token: readP1 });
    expect(named.status).toBe(200);
    expect(named.body.result.isError).not.toBe(true);
    const unnamed = await callTool("get_blueprint_summary", {}, { token: readP1 });
    expect(unnamed.status).toBe(200);
    expect(unnamed.body.result.isError).not.toBe(true);
    expect(toolText(unnamed)).toBe(toolText(named));
  });

  it("any other project is 403 and nothing happens there (TOKEN_OTHER_PROJECT)", async () => {
    for (const [tool, args] of [
      ["get_blueprint_summary", { project: "p2" }],
      ["enable_brick", { project: "p2", bricks: ["multi-workspace"] }],
      ["build_project", { project: "p2" }],
    ] as const) {
      const reply = await callTool(tool, args, { token: TOKEN });
      expect(reply.status, tool).toBe(403);
      expect(reply.body.error.message).toMatch(/different project/);
    }
    expect(await count("mcp_projects", "p2")).toBe(0);
    expect(await stored("p2")).toBeNull();
  });

  it("a read token cannot edit, deploy or connect (SCOPE_ESCALATION)", async () => {
    for (const [tool, args, scope] of [
      ["enable_brick", { project: "p1", bricks: ["multi-workspace"] }, "edit"],
      ["apply_ops", { project: "p1", ops: [] }, "edit"],
      ["build_project", { project: "p1" }, "edit"],
      ["deploy_apply", { project: "p1", env: "preview" }, "deploy"],
      ["request_connection", { project: "p1", app: "slack" }, "connect"],
    ] as const) {
      const reply = await callTool(tool, args, { token: readP1 });
      expect(reply.status, tool).toBe(403);
      expect(reply.body.error.message).toContain(`"${scope}" scope`);
    }
    expect(await count("mcp_projects", "p1")).toBe(0);
  });

  it("an edit token cannot deploy or connect", async () => {
    const editP1 = testToken("p1", ["read", "edit"]);
    expect((await callTool("deploy_apply", { project: "p1", env: "preview" }, { token: editP1 })).status).toBe(403);
    expect((await callTool("request_connection", { project: "p1", app: "slack" }, { token: editP1 })).status).toBe(403);
    expect((await callTool("enable_brick", { project: "p1", bricks: ["multi-workspace"] }, { token: editP1 })).status).toBe(200);
  });

  it("the author is the verified token, never the x-mcp-client headers (HEADER_AUTHOR)", async () => {
    const authors: unknown[] = [];
    const recording = {
      ...doClient,
      getProject: doClient.getProject.bind(doClient),
      applyOps: async (input: Parameters<typeof doClient.applyOps>[0]) => {
        authors.push(input.author);
        return doClient.applyOps(input);
      },
      revertToRevision: doClient.revertToRevision.bind(doClient),
    };
    const recorded = createMcpApp({ catalog, callsPerMinute: 10_000, verifyToken: testTokenVerifier, blueprintClient: recording });
    const reply = await post(
      request("tools/call", { name: "enable_brick", arguments: { project: "p1", bricks: ["multi-workspace"] } }),
      { headers: { "x-mcp-client-id": "evil", "x-mcp-client-name": "evil-client", "x-client-id": "evil2" } },
      recorded,
    );
    expect(reply.status).toBe(200);
    expect(reply.body.result.isError, toolText(reply)).not.toBe(true);
    expect(authors).toEqual([{ type: "agent", id: testTokenId("p1"), client: "mcp-test", onBehalfOf: TEST_TOKEN_USER_ID }]);
  });
});

describe("list_bricks and get_brick", () => {
  it("lists compact paged items (<= 10 per page) with opaque cursor and filters, and hides experimental bricks by default", async () => {
    const allItems: Array<{ id: string; summary: string; category: string; maturity: string }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const reply = await callTool("list_bricks", cursor ? { cursor } : {});
      expect(reply.body.result.isError).toBeUndefined();
      const page = toolJson(reply) as { items: typeof allItems; nextCursor: string | null };
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThanOrEqual(10);
      for (const item of page.items) {
        expect(item).toEqual({
          id: expect.any(String),
          summary: expect.any(String),
          category: expect.any(String),
          maturity: expect.stringMatching(/^(production|beta)$/),
        });
      }
      allItems.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(4);
    expect(allItems.map((b) => b.id)).toEqual(
      Object.keys(catalog.bricks)
        .filter((id) => catalog.bricks[id]!.manifest.ui?.maturity !== "experimental")
        .sort(),
    );

    const byCategory = toolJson(await callTool("list_bricks", { category: "billing" }));
    expect(byCategory.items.every((b: { category: string }) => b.category === "billing")).toBe(true);
    expect(byCategory.items.map((b: { id: string }) => b.id)).toContain("credit-wallet");

    const byCap = toolJson(await callTool("list_bricks", { capability: "workspace-context" }));
    expect(byCap.items.map((b: { id: string }) => b.id)).toEqual(["multi-workspace"]);

    const byQuery = toolJson(await callTool("list_bricks", { query: "wallet" }));
    expect(byQuery.items.map((b: { id: string }) => b.id)).toEqual(["credit-wallet"]);

    const badCursor = await callTool("list_bricks", { cursor: btoa("10:000000000000") });
    expect(badCursor.body.result.isError).toBe(true);
    expect(toolText(badCursor)).toMatch(/invalid cursor: catalog changed/);
  });

  it("get_brick returns provides, needs, settings, servesEntities, routes and conflicts for one brick, and refuses unknown ids", async () => {
    const walletReply = await callTool("get_brick", { id: "credit-wallet" });
    expect(walletReply.body.result.isError).toBeUndefined();
    const wallet = toolJson(walletReply);
    expect(wallet).toMatchObject({
      id: "credit-wallet",
      category: "billing",
      maturity: "beta",
      provides: ["credit-wallet"],
      needs: ["workspace-context"],
      servesEntities: false,
      routes: ["wallet", "payments"],
      conflicts: [],
    });
    expect(wallet.settings.creditsPerUnit).toBe("whole number 1 to 1000000, default 1");

    const entities = toolJson(await callTool("get_brick", { id: "dynamic-entities" }));
    expect(entities.servesEntities).toBe(true);

    const unknown = await callTool("get_brick", { id: "no-such-brick" });
    expect(unknown.body.result.isError).toBe(true);
    expect(toolText(unknown)).toMatch(/unknown brick "no-such-brick"/);
  });

  it("with a project name shows what it has and what it still needs; a project that does not exist is null", async () => {
    expect(toolJson(await callTool("list_bricks", { project: "nothing-here" })).project).toBeNull();
    await callTool("enable_brick", { project: "shown", bricks: ["binary-assets"] });
    const { project } = toolJson(await callTool("list_bricks", { project: "shown" }));
    expect(project.enabled).toEqual([{ id: "binary-assets", config: {} }]);
    expect(project.needs.join()).toMatch(/binary-assets requires "workspace-context".*multi-workspace/);
  });

  it("changes nothing", async () => {
    await callTool("list_bricks", { project: "unmade" });
    expect(await count("mcp_projects", "unmade")).toBe(0);
  });
});

// AD-V8: enable_brick applies directly, so it is refused for a money brick (credit-wallet, see "the AD-V8 gate" below);
// the macro's own mechanics are shown with binary-assets, a non-money brick with numeric settings.
describe("enable_brick", () => {
  it("creates the project on first use and says what is still needed", async () => {
    const first = toolJson(await callTool("enable_brick", { project: "shop", bricks: ["binary-assets"] }));
    expect(first.enabled).toEqual(["binary-assets"]);
    expect(first.needs.join()).toMatch(/requires "workspace-context"/);
    const second = toolJson(await callTool("enable_brick", { project: "shop", bricks: ["multi-workspace"] }));
    expect(second.enabled).toEqual(["binary-assets", "multi-workspace"]);
    expect(second.needs).toEqual([]);
  });

  it("settings are checked and stored; enabling again replaces the settings, and the brick is listed once", async () => {
    await callTool("enable_brick", { project: "shop", bricks: ["multi-workspace"] });
    await callTool("enable_brick", { project: "shop", bricks: [{ id: "binary-assets", config: { maxFileSizeBytes: 10 * 1024 } }] });
    await callTool("enable_brick", {
      project: "shop",
      bricks: [{ id: "binary-assets", config: { maxFileSizeBytes: 20 * 1024, workspaceQuotaBytes: 100 * 1048576 } }],
    });
    const snap = (await stored("shop"))!;
    expect(snap.blueprint.bricks).toEqual([
      { id: "binary-assets", config: { maxFileSizeBytes: 20 * 1024, workspaceQuotaBytes: 100 * 1048576 } },
      { id: "multi-workspace", config: {} },
    ]);
    expect(await count("mcp_projects", "shop")).toBe(0);
  });

  it.each([
    [
      "a brick that does not exist",
      { project: "p", bricks: ["no-such-brick"] },
      new RegExp(`unknown brick "no-such-brick" \\(available: ${Object.keys(catalog.bricks).sort().join(", ")}\\)`),
    ],
    ["a setting that does not exist", { project: "p", bricks: [{ id: "credit-wallet", config: { creditPerUnit: 2 } }] }, /unknown setting "creditPerUnit"/],
    ["a setting out of range", { project: "p", bricks: [{ id: "credit-wallet", config: { creditsPerUnit: 0 } }] }, /must be a whole number from 1 to 1000000/],
    ["a setting of the wrong kind", { project: "p", bricks: [{ id: "credit-wallet", config: { minOrderAmount: "ten" } }] }, /must be a whole number/],
  ])("%s is a tool error that names the problem and changes nothing", async (_label, args, message) => {
    const reply = await callTool("enable_brick", args);
    expect(reply.status).toBe(200);
    expect(reply.body.result.isError).toBe(true);
    expect(toolText(reply)).toMatch(message);
    expect(toolText(reply)).toMatch(/nothing was changed/);
    expect(await count("mcp_projects", "p")).toBe(0);
  });

  it("no project runs against the token's own project, and only that one (story 0.15, NO_PROJECT_ARG)", async () => {
    const reply = await callTool("enable_brick", { bricks: ["multi-workspace"] }, { token: testToken("own") });
    expect(reply.status).toBe(200);
    expect(reply.body.result.isError, toolText(reply)).not.toBe(true);
    expect(JSON.parse(toolText(reply)).project).toBe("own");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM mcp_projects WHERE project <> 'own'").first<{ n: number }>())!.n).toBe(0);
  });

  it("a call with no arguments field at all still defaults to the token's project (NO_PROJECT_ARG)", async () => {
    await callTool("enable_brick", { project: "own", bricks: ["multi-workspace"] }, { token: testToken("own") });
    const reply = await post(request("tools/call", { name: "get_blueprint_summary" }), { token: testToken("own") });
    expect(reply.status).toBe(200);
    expect(reply.body.result.isError, toolText(reply)).not.toBe(true);
    expect(JSON.parse(toolText(reply)).project).toBe("own");
  });

  it.each([
    ["a project name in capitals", { project: "Shop", bricks: ["multi-workspace"] }],
    ["a project name that is a path", { project: "../x", bricks: ["multi-workspace"] }],
    ["a project name that ends a statement", { project: "x'; DROP TABLE mcp_projects; --", bricks: ["multi-workspace"] }],
    ["a project name over 40 characters", { project: "a".repeat(41), bricks: ["multi-workspace"] }],
    ["a brick that is not text", { project: "p", bricks: [5] }],
    ["settings that are a list", { project: "p", bricks: [{ id: "credit-wallet", config: [1] }] }],
    ["a setting that is an object", { project: "p", bricks: [{ id: "credit-wallet", config: { creditsPerUnit: { $ne: 1 } } }] }],
    ["no arguments at all", undefined],
  ])("%s is a tool error (the model can read and fix it), not a protocol error", async (_label, args) => {
    const reply = await callTool("enable_brick", args);
    expect(reply.status).toBe(200);
    expect(reply.body.error).toBeUndefined();
    expect(reply.body.result.isError).toBe(true);
    expect(toolText(reply)).toMatch(/^Invalid arguments: /);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM mcp_projects").first<{ n: number }>())!.n).toBe(0);
  });

  it("twenty calls at once for twenty different bricks' settings all land: none is lost", async () => {
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        callTool("enable_brick", {
          project: "busy",
          bricks: [i % 2 === 0 ? { id: "binary-assets", config: { maxFileSizeBytes: (i + 1) * 1024 } } : "multi-workspace"],
        }),
      ),
    );
    expect(replies.every((r) => r.status === 200 && !r.body.result.isError)).toBe(true);
    const row = (await stored("busy"))!;
    const bricks = row.blueprint.bricks as Array<{ id: string }>;
    expect(bricks.map((b) => b.id)).toEqual(["binary-assets", "multi-workspace"]);
    expect(row.version).toBe(20); // every one of the twenty changes was written
  });

  it("twenty different bricks enabled at once on one project: none is lost", async () => {
    await Promise.all(
      ["binary-assets", "dynamic-entities", "multi-workspace"].flatMap((brick) =>
        Array.from({ length: 7 }, () => callTool("enable_brick", { project: "three", bricks: [brick] })),
      ),
    );
    const row = (await stored("three"))!;
    expect((row.blueprint.bricks as Array<{ id: string }>).map((b) => b.id)).toEqual(["binary-assets", "dynamic-entities", "multi-workspace"]);
  });
});

describe("enable_brick with a list", () => {
  it("enables several bricks in one call, in one write, and the project is complete when the list is", async () => {
    const reply = toolJson(await callTool("enable_brick", { project: "shop", bricks: ["binary-assets", "multi-workspace"] }));
    expect(reply.enabled).toEqual(["binary-assets", "multi-workspace"]);
    expect(reply.needs).toEqual([]); // the wallet's need is met by the workspace brick in the same list: no half-built state is reported
    expect((await stored("shop"))!.version).toBe(1);
  });

  it("a brick with settings and a brick without can be mixed in one list", async () => {
    await callTool("enable_brick", {
      project: "mix",
      bricks: ["multi-workspace", { id: "binary-assets", config: { maxFileSizeBytes: 7 * 1024 } }, "dynamic-entities"],
    });
    expect((await stored("mix"))!.blueprint.bricks).toEqual([
      { id: "binary-assets", config: { maxFileSizeBytes: 7 * 1024 } },
      { id: "dynamic-entities", config: {} },
      { id: "multi-workspace", config: {} },
    ]);
  });

  it("the order of the list does not matter", async () => {
    await callTool("enable_brick", { project: "ab", bricks: ["multi-workspace", "binary-assets", "dynamic-entities"] });
    await callTool("enable_brick", { project: "ba", bricks: ["dynamic-entities", "binary-assets", "multi-workspace"] });
    expect((await stored("ab"))!.blueprint).toEqual((await stored("ba"))!.blueprint);
  });

  it("one bad item refuses the whole list: nothing is written, not even the good items, and the bad one is named", async () => {
    const reply = await callTool("enable_brick", {
      project: "atomic",
      bricks: ["multi-workspace", "no-such-brick", { id: "credit-wallet", config: { creditsPerUnit: 0 } }],
    });
    expect(reply.body.result.isError).toBe(true);
    expect(toolText(reply)).toMatch(/unknown brick "no-such-brick"/);
    expect(toolText(reply)).toMatch(/credit-wallet: setting "creditsPerUnit" must be a whole number/); // every problem at once, not only the first
    expect(toolText(reply)).toMatch(/nothing was changed/);
    expect(await stored("atomic")).toBeNull();
  });

  it("a refused list leaves an existing project exactly as it was, version included", async () => {
    await callTool("enable_brick", { project: "keep", bricks: ["multi-workspace"] });
    const before = await stored("keep");
    const reply = await callTool("enable_brick", { project: "keep", bricks: ["credit-wallet", "no-such-brick"] });
    expect(reply.body.result.isError).toBe(true);
    expect(await stored("keep")).toEqual(before);
  });

  it("the same brick twice in one list is refused rather than guessed at", async () => {
    const reply = await callTool("enable_brick", {
      project: "twice",
      bricks: [
        { id: "credit-wallet", config: { creditsPerUnit: 1 } },
        { id: "credit-wallet", config: { creditsPerUnit: 2 } },
      ],
    });
    expect(toolText(reply)).toMatch(/brick "credit-wallet" is listed twice.*nothing was changed/);
    expect(await stored("twice")).toBeNull();
  });

  it("a list changes the bricks it names and leaves the others alone", async () => {
    await callTool("enable_brick", { project: "edit", bricks: ["multi-workspace", { id: "binary-assets", config: { maxFileSizeBytes: 3 * 1024 } }] });
    await callTool("enable_brick", { project: "edit", bricks: [{ id: "binary-assets", config: { maxFileSizeBytes: 9 * 1024 } }, "dynamic-entities"] });
    expect((await stored("edit"))!.blueprint.bricks).toEqual([
      { id: "binary-assets", config: { maxFileSizeBytes: 9 * 1024 } },
      { id: "dynamic-entities", config: {} },
      { id: "multi-workspace", config: {} },
    ]);
  });

  it.each([
    ["an empty list", { project: "p", bricks: [] }, /bricks: .*>=1 items/],
    ["more than twenty bricks", { project: "p", bricks: Array.from({ length: 21 }, () => "multi-workspace") }, /bricks: .*<=20 items/],
    ["one brick written the old way", { project: "p", brick: "multi-workspace" }, /bricks: .*(required|undefined)/],
    ["a list where an item is a number", { project: "p", bricks: ["multi-workspace", 5] }, /bricks\.1: .*(allowed forms|expected)/],
    ["a list where an item has a misspelt key", { project: "p", bricks: [{ idd: "multi-workspace" }] }, /bricks\.0\.id: .*|bricks\.0: .*Unrecognized key/],
    [
      "a list where one setting is an object",
      { project: "p", bricks: ["multi-workspace", { id: "credit-wallet", config: { creditsPerUnit: { $ne: 1 } } }] },
      /bricks\.1\.config\.creditsPerUnit/,
    ],
    ["a list that is text", { project: "p", bricks: "multi-workspace" }, /bricks: .*expected array/],
    ["a list item whose id is not a brick name", { project: "p", bricks: ["multi-workspace", "x'; DROP TABLE mcp_projects; --"] }, /bricks\.1: .*pattern/],
  ])("%s is a tool error that points at the item, and writes nothing", async (_label, args, message) => {
    const reply = await callTool("enable_brick", args);
    expect(reply.body.error).toBeUndefined();
    expect(reply.body.result.isError).toBe(true);
    expect(toolText(reply)).toMatch(/^Invalid arguments: /);
    expect(toolText(reply)).toMatch(message);
    expect(await count("mcp_projects", "p")).toBe(0);
  });

  it("many lists at once that overlap all land: every brick named by any of them ends up enabled", async () => {
    const lists = [
      ["binary-assets"],
      ["multi-workspace", "binary-assets"],
      ["dynamic-entities"],
      ["multi-workspace"],
      ["dynamic-entities", "binary-assets"],
      ["binary-assets", "multi-workspace", "dynamic-entities"],
    ];
    const replies = await Promise.all(Array.from({ length: 18 }, (_, i) => callTool("enable_brick", { project: "crowd", bricks: lists[i % lists.length] })));
    expect(replies.every((r) => !r.body.result.isError)).toBe(true);
    const after = (await stored("crowd"))!;
    expect(after.blueprint.bricks.map((b: { id: string }) => b.id)).toEqual(["binary-assets", "dynamic-entities", "multi-workspace"]);
    expect(after.version).toBe(18); // each of the eighteen calls was written once
  });
});

describe("define_entity with a list", () => {
  const field = [{ name: "label", type: "text" }];

  it("declares several tables in one call, in one write, kept in name order", async () => {
    const reply = toolJson(
      await callTool("define_entity", {
        project: "many",
        entities: [
          { name: "zebras", fields: field },
          { name: "apples", fields: field },
          { name: "mangoes", fields: field },
        ],
      }),
    );
    expect(reply.entities).toEqual(["apples", "mangoes", "zebras"]);
    expect((await stored("many"))!.version).toBe(1);
  });

  it("the order of the list does not matter", async () => {
    await callTool("define_entity", {
      project: "xy",
      entities: [
        { name: "x_things", fields: field },
        { name: "y_things", fields: field },
      ],
    });
    await callTool("define_entity", {
      project: "yx",
      entities: [
        { name: "y_things", fields: field },
        { name: "x_things", fields: field },
      ],
    });
    expect((await stored("xy"))!.blueprint).toEqual((await stored("yx"))!.blueprint);
  });

  it("one bad table refuses the whole list: nothing is stored, and the bad one is named", async () => {
    const reply = await callTool("define_entity", {
      project: "atomic",
      entities: [
        { name: "apples", fields: field },
        { name: "wallet", fields: field },
        { name: "mangoes", fields: field },
      ],
    });
    expect(reply.body.result.isError).toBe(true);
    expect(toolText(reply)).toMatch(/entity "wallet" uses a name that a brick's routes already use.*nothing was changed/);
    expect(await stored("atomic")).toBeNull();
  });

  it("a refused list leaves an existing project exactly as it was, version included", async () => {
    await callTool("define_entity", { project: "keep", entities: [{ name: "apples", fields: field }] });
    const before = await stored("keep");
    await callTool("define_entity", {
      project: "keep",
      entities: [
        { name: "mangoes", fields: field },
        { name: "wallet", fields: field },
      ],
    });
    expect(await stored("keep")).toEqual(before);
  });

  it("the same table twice in one list is refused", async () => {
    const reply = await callTool("define_entity", {
      project: "twice",
      entities: [
        { name: "apples", fields: field },
        { name: "apples", fields: [{ name: "other", type: "text" }] },
      ],
    });
    expect(toolText(reply)).toMatch(/entity "apples" is declared twice.*nothing was changed/);
    expect(await stored("twice")).toBeNull();
  });

  it("a list replaces the tables it names and keeps the others", async () => {
    await callTool("define_entity", {
      project: "swap",
      entities: [
        { name: "apples", fields: field },
        { name: "mangoes", fields: field },
      ],
    });
    await callTool("define_entity", {
      project: "swap",
      entities: [
        { name: "mangoes", fields: [{ name: "colour", type: "text" }] },
        { name: "pears", fields: field },
      ],
    });
    const entities = (await stored("swap"))!.blueprint.entities;
    expect(entities.map((e: { name: string }) => e.name)).toEqual(["apples", "mangoes", "pears"]);
    expect(entities[1]!.fields.map((f: { name: string }) => f.name)).toEqual(["colour"]);
    expect(entities[0]!.fields.map((f: { name: string }) => f.name)).toEqual(["label"]);
  });

  it("more than twenty in one call is refused by the schema, and twenty plus more across calls by the project's own limit", async () => {
    const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, fields: field }));
    const tooMany = await callTool("define_entity", { project: "cap", entities: many(21, "a") });
    expect(toolText(tooMany)).toMatch(/^Invalid arguments: entities: .*<=20 items/);
    expect(await stored("cap")).toBeNull();
    expect(toolJson(await callTool("define_entity", { project: "cap", entities: many(15, "a") })).entities).toHaveLength(15);
    const before = await stored("cap");
    const over = await callTool("define_entity", { project: "cap", entities: many(10, "b") });
    expect(over.body.result.isError).toBe(true);
    expect(toolText(over)).toMatch(/nothing was changed/);
    expect(await stored("cap")).toEqual(before);
  });

  it.each([
    ["an empty list", { project: "p", entities: [] }, /entities: .*>=1 items/],
    ["one table written the old way", { project: "p", entity: { name: "apples", fields: field } }, /entities: .*(required|undefined)/],
    [
      "a list where the second table has no fields",
      {
        project: "p",
        entities: [
          { name: "apples", fields: field },
          { name: "empty", fields: [] },
        ],
      },
      /entities\.1\.fields/,
    ],
    [
      "a list where the second table has a field named for a system column",
      {
        project: "p",
        entities: [
          { name: "apples", fields: field },
          { name: "things", fields: [{ name: "workspace_id", type: "text" }] },
        ],
      },
      /entities\.1\.fields\.0\.name/,
    ],
  ])("%s is a tool error that points at the item, and writes nothing", async (_label, args, message) => {
    const reply = await callTool("define_entity", args);
    expect(reply.body.result.isError).toBe(true);
    expect(toolText(reply)).toMatch(/^Invalid arguments: /);
    expect(toolText(reply)).toMatch(message);
    expect(await count("mcp_projects", "p")).toBe(0);
  });

  it("many lists at once that overlap all land, and the table they all name ends up declared once", async () => {
    const lists = [["apples"], ["apples", "mangoes"], ["pears"], ["mangoes", "pears", "apples"]];
    const replies = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        callTool("define_entity", { project: "crowd", entities: lists[i % lists.length]!.map((name) => ({ name, fields: field })) }),
      ),
    );
    expect(replies.every((r) => !r.body.result.isError)).toBe(true);
    const after = (await stored("crowd"))!;
    expect(after.blueprint.entities.map((e: { name: string }) => e.name)).toEqual(["apples", "mangoes", "pears"]);
    expect(after.version).toBe(12);
  });
});

describe("define_entity", () => {
  const invoices = {
    name: "invoices",
    fields: [
      { name: "client_name", type: "text", required: true },
      { name: "amount", type: "number" },
      { name: "status", type: "enum", values: ["draft", "paid"] },
    ],
  };

  it("stores the entity, says what the project still needs, and replaces an entity of the same name", async () => {
    const first = toolJson(await callTool("define_entity", { project: "ent", entities: [invoices] }));
    expect(first.entities).toEqual(["invoices"]);
    expect(first.needs.join()).toMatch(/no brick is enabled yet/);
    await callTool("define_entity", { project: "ent", entities: [{ ...invoices, fields: [{ name: "label", type: "text" }] }] });
    const row = (await stored("ent"))!;
    const entities = row.blueprint.entities;
    expect(entities).toHaveLength(1);
    expect(entities[0]!.fields.map((f: { name: string }) => f.name)).toEqual(["label"]);
  });

  it("two entities are kept in name order", async () => {
    await callTool("define_entity", { project: "ent", entities: [{ name: "zebras", fields: [{ name: "label", type: "text" }] }] });
    await callTool("define_entity", { project: "ent", entities: [invoices] });
    expect(toolJson(await callTool("list_bricks", { project: "ent" })).project.entities).toEqual(["invoices", "zebras"]);
  });

  it.each([
    [
      "an entity named for a brick's routes",
      { name: "wallet", fields: [{ name: "label", type: "text" }] },
      /entity "wallet" uses a name that a brick's routes already use/,
    ],
    ["a field named for a system column", { name: "things", fields: [{ name: "workspace_id", type: "text" }] }, /entities\.0\.fields\.0\.name/],
    [
      "an enum value that would break the SQL",
      { name: "things", fields: [{ name: "kind", type: "enum", values: ["a'); DROP TABLE x; --"] }] },
      /entities\.0\.fields\.0\.values/,
    ],
  ])("%s is a tool error and changes nothing", async (_label, entity, message) => {
    const reply = await callTool("define_entity", { project: "ent", entities: [entity] });
    expect(reply.body.result.isError).toBe(true);
    expect(toolText(reply)).toMatch(message);
    expect(await count("mcp_projects", "ent")).toBe(0);
  });

  it.each([
    ["an entity that is not an object", "invoices"],
    ["an entity name with a quote", { name: 'inv"oices', fields: [{ name: "a", type: "text" }] }],
    ["an entity with no fields", { name: "empty", fields: [] }],
    ["a field type that does not exist", { name: "x", fields: [{ name: "a", type: "blob" }] }],
    ["an extra key", { ...invoices, owner: "bob" }],
  ])("%s is refused by the tool's own schema", async (_label, entity) => {
    const reply = await callTool("define_entity", { project: "ent", entities: [entity] });
    expect(reply.body.result.isError).toBe(true);
    expect(toolText(reply)).toMatch(/^Invalid arguments: /);
    expect(await count("mcp_projects", "ent")).toBe(0);
  });

  it("redefining an entity so that two of them clash leaves the stored blueprint as it was", async () => {
    await callTool("define_entity", { project: "ent", entities: [invoices] });
    const before = (await stored("ent"))!;
    await callTool("define_entity", { project: "ent", entities: [{ name: "orders", fields: [{ name: "id", type: "text" }] }] });
    expect(await stored("ent")).toEqual(before);
  });
});

describe("build_project", () => {
  const invoices = {
    name: "invoices",
    fields: [
      { name: "client_name", type: "text", required: true },
      { name: "amount", type: "number" },
    ],
  };
  async function readyProject(project: string) {
    await callTool("enable_brick", { project, bricks: ["multi-workspace"] });
    await enableReviewed(project, [{ id: "credit-wallet", config: { creditsPerUnit: 10 } }]);
    await callTool("enable_brick", { project, bricks: ["dynamic-entities"] });
    await callTool("define_entity", { project, entities: [invoices] });
  }

  it("builds, stores the files, and answers with a summary and no source", async () => {
    await readyProject("invoice-flow");
    const reply = await callTool("build_project", { project: "invoice-flow" });
    expect(reply.body.result.isError).toBeUndefined();
    const summary = toolJson(reply);
    expect(summary).toMatchObject({
      project: "invoice-flow",
      files: 16,
      bricks: ["multi-workspace", "credit-wallet", "dynamic-entities"],
      entities: ["invoices"],
    });
    expect(summary.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.bytes).toBeGreaterThan(1000);
    // the answer is short and holds none of the project's source
    expect(toolText(reply).length).toBeLessThan(400);
    for (const word of ["CREATE TABLE", "workspaceMiddleware", "import ", "client_name"]) expect(toolText(reply)).not.toContain(word);
  });

  it("the stored files are exactly what a direct assembly of the same blueprint produces, file for file and by hash", async () => {
    await readyProject("invoice-flow");
    const summary = toolJson(await callTool("build_project", { project: "invoice-flow" }));
    const direct = assemble(
      {
        project: "invoice-flow",
        bricks: ["multi-workspace", { id: "credit-wallet", config: { creditsPerUnit: 10 } }, "dynamic-entities"],
        entities: [invoices],
      },
      catalog,
    );
    if (!direct.ok) throw new Error(direct.errors.join("; "));
    const stored = (
      await db
        .prepare("SELECT path, content, sha256 FROM mcp_files WHERE project = 'invoice-flow' ORDER BY path")
        .all<{ path: string; content: string; sha256: string }>()
    ).results;
    expect(Object.fromEntries(stored.map((r) => [r.path, r.content]))).toEqual(direct.files);
    expect(Object.fromEntries(stored.map((r) => [r.path, r.sha256]))).toEqual(await hashFiles(direct.files));
    expect(summary.hash).toBe(await projectHash(direct.files));
    const build = await db
      .prepare("SELECT project_hash, file_count, byte_count FROM mcp_builds WHERE project = 'invoice-flow'")
      .first<{ project_hash: string; file_count: number; byte_count: number }>();
    expect(build).toEqual({ project_hash: summary.hash, file_count: 16, byte_count: summary.bytes }); // story 0.21: credit-wallet's rate limits add the px_rate_limits migration; story 2.3 its 0003; story 2.5 its 0004; story 2.8 multi-workspace's 0002
  });

  it("the order the tools were called in does not change the project", async () => {
    await readyProject("one");
    await callTool("define_entity", { project: "two", entities: [invoices] });
    await callTool("enable_brick", { project: "two", bricks: ["dynamic-entities"] });
    await enableReviewed("two", [{ id: "credit-wallet", config: { creditsPerUnit: 10 } }]);
    await callTool("enable_brick", { project: "two", bricks: ["multi-workspace"] });
    const [a, b] = [toolJson(await callTool("build_project", { project: "one" })), toolJson(await callTool("build_project", { project: "two" }))];
    // the project name is part of the files, so compare what does not depend on it
    expect({ ...a, project: "x", hash: "" }).toEqual({ ...b, project: "x", hash: "" });
    expect(a.bytes - "one".length).toBe(b.bytes - "two".length);
  });

  it("building twice gives the same hash and replaces the files rather than adding to them", async () => {
    await readyProject("again");
    const first = toolJson(await callTool("build_project", { project: "again" }));
    const second = toolJson(await callTool("build_project", { project: "again" }));
    expect(second.hash).toBe(first.hash);
    expect(await count("mcp_files", "again")).toBe(16);
  });

  it("a rebuild after a change replaces the old files entirely: nothing from the earlier build is left", async () => {
    await readyProject("grow");
    await callTool("build_project", { project: "grow" });
    expect(await count("mcp_files", "grow")).toBe(16); // story 2.8 (multi-workspace 0002); story 2.3 (credit-wallet 0003); story 0.21: credit-wallet's rate limits add the px_rate_limits migration
    await callTool("define_entity", { project: "grow", entities: [{ name: "tasks", fields: [{ name: "title", type: "text" }] }] });
    expect(toolJson(await callTool("build_project", { project: "grow" })).files).toBe(17);
    expect(await count("mcp_files", "grow")).toBe(17);
  });

  it("a project that cannot be built says why, builds nothing, and leaves an earlier build in place", async () => {
    await readyProject("fragile");
    const good = toolJson(await callTool("build_project", { project: "fragile" }));
    await enableReviewed("fragile", [{ id: "credit-wallet", config: { creditsPerUnit: 5 } }]);
    // now make it unbuildable: an entity with the entity brick removed is not possible, so use a fresh project instead
    await enableReviewed("lonely", ["credit-wallet"]);
    const refused = await callTool("build_project", { project: "lonely" });
    expect(refused.body.result.isError).toBe(true);
    expect(toolText(refused)).toMatch(/credit-wallet requires "workspace-context".*nothing was built/);
    expect(await count("mcp_files", "lonely")).toBe(0);
    expect(await count("mcp_builds", "lonely")).toBe(0);
    expect(toolJson(await callTool("build_project", { project: "fragile" })).files).toBe(good.files);
  });

  it("a project that was never started, and one with nothing in it, are tool errors", async () => {
    expect(toolText(await callTool("build_project", { project: "never" }))).toMatch(/unknown project "never"/);
    await callTool("define_entity", { project: "bare", entities: [invoices] });
    expect(toolText(await callTool("build_project", { project: "bare" }))).toMatch(/no brick is enabled yet.*nothing was built/);
  });

  it("entities with nothing to serve them are refused with the brick to enable", async () => {
    await callTool("enable_brick", { project: "orphan", bricks: ["multi-workspace"] });
    await callTool("define_entity", { project: "orphan", entities: [invoices] });
    expect(toolText(await callTool("build_project", { project: "orphan" }))).toMatch(
      /entities are declared but no enabled brick handles them \(enable one of: dynamic-entities\)/,
    );
  });

  it("two builds of one project at once leave a whole, consistent set of files", async () => {
    await readyProject("race");
    const replies = await Promise.all(Array.from({ length: 6 }, () => callTool("build_project", { project: "race" })));
    const hashes = new Set(replies.map((r) => toolJson(r).hash));
    expect(hashes.size).toBe(1);
    const stored = (await db.prepare("SELECT path, content FROM mcp_files WHERE project = 'race' ORDER BY path").all<{ path: string; content: string }>())
      .results;
    expect(stored).toHaveLength(16);
    expect(await projectHash(Object.fromEntries(stored.map((r) => [r.path, r.content])))).toBe([...hashes][0]);
  });

  it("projects are kept apart: building one does not touch another's files", async () => {
    await readyProject("alpha");
    await readyProject("beta");
    await callTool("build_project", { project: "alpha" });
    await callTool("build_project", { project: "beta" });
    const alpha = (await db.prepare("SELECT content FROM mcp_files WHERE project = 'alpha' AND path = 'package.json'").first<{ content: string }>())!.content;
    const beta = (await db.prepare("SELECT content FROM mcp_files WHERE project = 'beta' AND path = 'package.json'").first<{ content: string }>())!.content;
    expect(JSON.parse(alpha).name).toBe("alpha");
    expect(JSON.parse(beta).name).toBe("beta");
  });
});

describe("the errors a client would see", () => {
  it("an unknown tool is a protocol error naming it (a long name is cut short)", async () => {
    const reply = await post(request("tools/call", { name: "delete_everything", arguments: {} }));
    expect(reply.body.error).toMatchObject({ code: -32602, message: "Unknown tool: delete_everything" });
    expect((await post(request("tools/call", { name: "x".repeat(5000), arguments: {} }))).body.error.message.length).toBeLessThan(150);
    expect((await post(request("tools/call", { arguments: {} }))).body.error.message).toMatch(/\(no name\)/);
  });

  it("a tool call with no arguments object is treated as empty, and list_bricks still works", async () => {
    expect((await post(request("tools/call", { name: "list_bricks" }))).body.result.isError).toBeUndefined();
  });

  it("an internal failure is a generic protocol error that leaks nothing", async () => {
    await db.prepare("DROP TABLE mcp_rate").run();
    const reply = await callTool("enable_brick", { project: "p", bricks: ["multi-workspace"] });
    expect(reply.body.error).toMatchObject({ code: -32603, message: "internal error" });
    expect(reply.text).not.toMatch(/mcp_rate|mcp_projects|no such table|SQLITE|D1_ERROR/i);
  });

  it("nothing the server says contains the access token", async () => {
    const texts = [
      (await post(request("initialize", {}))).text,
      (await post(request("tools/list"))).text,
      (await callTool("list_bricks", {})).text,
      (await post(undefined, { raw: "{" })).text,
    ];
    for (const text of texts) expect(text).not.toContain(TOKEN);
  });
});

describe("tools that need a deploy target (story 0.9, R-F)", () => {
  it("deploy_apply with no target connected is an error with a remediation line: no 'deployed' status, no URL, nothing built", async () => {
    await callTool("enable_brick", { project: "notarget", bricks: ["multi-workspace"] });
    for (const env of ["preview", "production"] as const) {
      const reply = await callTool("deploy_apply", { project: "notarget", env });
      expect(reply.status).toBe(200);
      expect(reply.body.result.isError, env).toBe(true);
      const text = toolText(reply);
      expect(text).not.toMatch(/"status":"deployed"/);
      expect(text).not.toMatch(/workers\.dev/);
      const body = JSON.parse(text);
      // production with stub identity is refused earlier with its own code; preview reaches the target check
      if (env === "preview") {
        expect(body.error.code).toBe("NO_TARGET");
        expect(body.error.remediation).toMatch(/^Connect a Cloudflare target first: /);
        expect(body.issues[0]).toMatchObject({ code: "NO_TARGET", suggestedFix: expect.stringMatching(/Connect a Cloudflare target first/) });
      }
      expect(body.workerUrl).toBeUndefined();
      expect(body.deploymentId).toBeUndefined();
    }
    expect(await count("mcp_builds", "notarget")).toBe(0);
  });
});

describe("deploy_apply reports only real deploy state (story 0.9, R-F)", () => {
  it("production with a non-stub identity and no target is NO_TARGET with the remediation line", async () => {
    await callTool("enable_brick", { project: "prodnotarget", bricks: ["multi-workspace", "core-auth"] });
    const setId = await callTool("apply_ops", { project: "prodnotarget", mode: "apply", ops: [{ opId: "id-1", type: "set_identity", identity: "core-auth" }] }); // AD-V8: a preview-safe edit an agent may apply directly
    expect(setId.body.result.isError, toolText(setId)).not.toBe(true);
    const reply = await callTool("deploy_apply", { project: "prodnotarget", env: "production" });
    expect(reply.body.result.isError).toBe(true);
    const body = JSON.parse(toolText(reply));
    expect(body.error.code).toBe("NO_TARGET");
    expect(body.error.remediation).toMatch(/^Connect a Cloudflare target first: /);
    expect(body.env).toBe("production");
    expect(toolText(reply)).not.toMatch(/"status":"deployed"|workers\.dev/);
  });

  const studioApp = (deployBody: Record<string, unknown>) =>
    createMcpApp({
      catalog,
      allowedOrigins: ["https://studio.example"],
      callsPerMinute: 10_000,
      verifyToken: testTokenVerifier,
      studioRequest: async () => new Response(JSON.stringify(deployBody), { status: 200, headers: { "content-type": "application/json" } }),
    });
  const callVia = (appUnderTest: ReturnType<typeof createMcpApp>, args: unknown) =>
    post(request("tools/call", { name: "deploy_apply", arguments: args }), {}, appUnderTest);

  it("a studio 200 with no status or deployment id is an error, never a default 'deployed' or an invented id", async () => {
    for (const deployBody of [{}, { deployId: "dep_real_1" }, { status: "live" }]) {
      const reply = await callVia(studioApp(deployBody), { project: "viastudio", env: "preview", planId: "plan_x" });
      expect(reply.body.result.isError, JSON.stringify(deployBody)).toBe(true);
      const text = toolText(reply);
      expect(JSON.parse(text).error.code).toBe("PROVIDER_ERROR");
      expect(text).not.toMatch(/"status":"deployed"|dep_plan_x/);
    }
  });

  it("a studio 200 with status and deployment id is reported as studio returned it", async () => {
    const reply = await callVia(studioApp({ deployId: "dep_real_1", status: "live", revision: 3 }), { project: "viastudio", env: "preview" });
    expect(reply.body.result.isError).toBeFalsy();
    expect(JSON.parse(toolText(reply))).toMatchObject({ deploymentId: "dep_real_1", status: "live", revision: 3 });
  });
});

describe("define_entity: relations, date, money and longtext (story 1.18)", () => {
  const customer = { name: "customer", fields: [{ name: "label", type: "text", required: true }] };
  const invoice = {
    name: "invoice",
    fields: [
      { name: "customer_id", type: "relation", relation: "customer", required: true },
      { name: "due_on", type: "date" },
      { name: "total", type: "money", currencies: ["INR"] },
      { name: "notes", type: "longtext" },
    ],
  };

  it("tools/list gives agents the relation key and the date, money and longtext types (apply_ops, and the define_entity macro)", async () => {
    const tools = (await post(request("tools/list"))).body.result.tools as Array<{ name: string; description: string }>;
    const listed = tools.find((t) => t.name === "apply_ops")!.description;
    // define_entity is a legacy macro that tools/list does not show; its own description says the same.
    const macro = toolDescriptions(ALL_TOOLS).find((t) => t.name === "define_entity")!.description;
    for (const description of [listed, macro]) {
      expect(description).toContain('{"name":"customer_id","type":"relation","relation":"customer"}');
      expect(description).toMatch(/relation key/);
      for (const type of ["date", "money", "longtext"]) expect(description).toContain(type);
    }
  });

  it("a relation to an undeclared entity is refused, naming the field and the entity", async () => {
    const reply = await callTool("define_entity", {
      project: "rel",
      entities: [{ name: "invoice", fields: [{ name: "owner_id", type: "relation", relation: "ghost" }] }],
    });
    expect(reply.body.result.isError).toBe(true);
    expect(toolText(reply)).toMatch(/field "owner_id" relates to entity "ghost", which is not declared/);
    expect(await stored("rel")).toBeNull();
  });

  it.each(["target", "entity", "to", "references", "targetEntity"])("the wrong key %s is refused with a pointer to relation", async (key) => {
    const reply = await callTool("define_entity", {
      project: "rel",
      entities: [customer, { name: "invoice", fields: [{ name: "customer_id", type: "relation", [key]: "customer" }] }],
    });
    expect(reply.body.result.isError).toBe(true);
    expect(toolText(reply)).toMatch(new RegExp(`"${key}" is not a field key: .*use type "relation" with the "relation" key`));
    expect(await stored("rel")).toBeNull();
  });

  it("a relation may target an entity declared by an earlier call", async () => {
    await callTool("define_entity", { project: "rel", entities: [customer] });
    const reply = await callTool("define_entity", { project: "rel", entities: [invoice] });
    expect(reply.body.result.isError).toBeUndefined();
    expect(toolJson(reply).entities).toEqual(["customer", "invoice"]);
  });

  it("the built app carries the relation, and in workerd it refuses a related id from another workspace or another entity", async () => {
    await callTool("enable_brick", { project: "rel-app", bricks: ["multi-workspace", "dynamic-entities"] });
    const defined = await callTool("define_entity", { project: "rel-app", entities: [invoice, customer] });
    expect(defined.body.result.isError).toBeUndefined();
    const built = await callTool("build_project", { project: "rel-app" });
    expect(built.body.result.isError).toBeUndefined();
    const files = Object.fromEntries(
      (await db.prepare("SELECT path, content FROM mcp_files WHERE project = 'rel-app'").all<{ path: string; content: string }>()).results.map((r) => [
        r.path,
        r.content,
      ]),
    );
    const entities = JSON.parse(files["src/entities.json"]!);
    expect(entities.find((e: { name: string }) => e.name === "invoice").fields[0]).toEqual({
      name: "customer_id",
      type: "relation",
      required: true,
      relation: "customer",
    });
    const migrations = Object.keys(files)
      .filter((p) => /^migrations\/\d+_entity__/.test(p))
      .sort();
    expect(migrations.map((p) => p.replace(/^migrations\/\d+_/, ""))).toEqual(["entity__customer.sql", "entity__invoice.sql"]);
    expect(files[migrations[1]!]).toContain(`"customer_id" TEXT NOT NULL CHECK (length("customer_id") = 36)`);
    expect(files[migrations[1]!]).toContain(`"total__currency" TEXT CHECK ("total__currency" IN ('INR')`);

    // Run the built declaration and migrations through the real router on workerd's D1.
    for (const table of ["ent_customer", "ent_invoice"]) await db.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
    for (const path of migrations) await applyMigration(db, files[path]!);
    const router = createEntityRoutes({ entities });
    const send = async (workspace: string, method: string, path: string, body?: unknown) => {
      const appUnderTest = new Hono<EntityEnv>();
      appUnderTest.use("*", async (c, next) => {
        c.set("user", { uid: "usr_rel" });
        c.set("workspace", { id: workspace, role: "owner", suspended: false });
        await next();
      });
      appUnderTest.route("/", router);
      const res = await appUnderTest.request(
        `http://localhost${path}`,
        { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
        { DB: db },
      );
      return { status: res.status, body: (await res.json()) as any };
    };
    const ownCustomer = (await send("ws_a", "POST", "/customer", { label: "Acme" })).body.item.id as string;
    const foreignCustomer = (await send("ws_b", "POST", "/customer", { label: "Other" })).body.item.id as string;

    const good = await send("ws_a", "POST", "/invoice", { customer_id: ownCustomer, due_on: "2026-11-26", total: { amount: 1999, currency: "INR" } });
    expect(good.status).toBe(201);
    expect(good.body.item.total).toEqual({ amount: 1999, currency: "INR" });

    const foreign = await send("ws_a", "POST", "/invoice", { customer_id: foreignCustomer });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringMatching(/customer_id/) });

    const ownInvoiceId = await send("ws_a", "POST", "/invoice", { customer_id: good.body.item.id });
    expect(ownInvoiceId.status).toBe(400);
    expect(ownInvoiceId.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringMatching(/customer_id/) });
  });
});
