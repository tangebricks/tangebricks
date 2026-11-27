import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import migration from "../migrations/0001_mcp_server.sql?raw";
import { createInMemoryBlueprintClient, createMcpApp } from "../src/index.ts";
import { testToken, testTokenVerifier } from "./support/test-verifier.ts";
import { createSqliteD1 } from "../../../bricks/credit-wallet/client/test/support/sqlite-d1.ts";

// The official MCP client (from the protocol's own SDK) talking to this server. Nothing here is written to match my reading
// of the specification: the client does the negotiation and the calls its authors wrote, and either they work or they do not.
// Only the network is a stand-in (the client's fetch goes straight into the app) and the database engine (Node's SQLite).
// Story 0.15: the token is bound to the one project this file builds.
const TOKEN = testToken("interop");
const db = createSqliteD1();
// AD-V8: the test keeps the blueprint client so it can play the Studio reviewer who accepts the agent's proposal.
const blueprintClient = createInMemoryBlueprintClient(catalog);
const app = createMcpApp({ catalog, verifyToken: testTokenVerifier, blueprintClient });
const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];

const fetchIntoApp = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  calls.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body: await request.clone().text() });
  return app.fetch(request, { DB: db });
};
const connect = async (token: string | null = TOKEN) => {
  const client = new Client({ name: "interop-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: fetchIntoApp,
    requestInit: token === null ? {} : { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
};

beforeAll(async () => {
  await applyMigration(db, migration);
});
afterAll(() => db.close());

describe("the official MCP client against this server", () => {
  test("connects: negotiates 2025-11-25, sends initialized, and learns the server's name and tools capability", async () => {
    calls.length = 0;
    const { client } = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: "projectx-poc-assembler", version: "0.0.0" });
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getInstructions()).toMatch(/enable_brick/);
    const methods = calls.map((c) => (c.body ? (JSON.parse(c.body) as { method?: string }).method : c.method));
    expect(methods.slice(0, 2)).toEqual(["initialize", "notifications/initialized"]);
    // after negotiation the client sends the version on every request, and the server accepts it
    expect(calls.slice(1).every((c) => c.headers["mcp-protocol-version"] === "2025-11-25")).toBe(true);
    await client.close();
  });

  test("lists the evolved tools with schemas it accepts", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
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
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
    await client.close();
  });

  test("builds a project by calling the tools, as a model would", async () => {
    const { client } = await connect();
    const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect((await client.callTool({ name: "list_bricks", arguments: {} })).isError).toBeFalsy();
    // AD-V8: enable_brick refuses a money brick for an agent; the agent proposes and a person accepts in Studio.
    const refused = await client.callTool({
      name: "enable_brick",
      arguments: { project: "interop", bricks: ["multi-workspace", "credit-wallet", "dynamic-entities"] },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(text(refused)).error.code).toBe("PROPOSAL_REQUIRED");
    const proposed = await client.callTool({
      name: "apply_ops",
      arguments: {
        project: "interop",
        ops: ["multi-workspace", "credit-wallet", "dynamic-entities"].map((brickId) => ({ opId: `enable-${brickId}`, type: "enable_brick", brickId })),
      },
    });
    expect(proposed.isError, text(proposed)).toBeFalsy();
    const pending = JSON.parse(text(proposed)) as { status: string; proposalId: string };
    expect(pending.status).toBe("pending");
    const accepted = await blueprintClient.acceptProposal!({
      project: "interop",
      proposalId: pending.proposalId,
      reviewer: { type: "human", id: "interop:reviewer" },
    });
    expect(accepted.ok).toBe(true);
    const defined = await client.callTool({
      name: "define_entity",
      arguments: {
        project: "interop",
        entities: [
          {
            name: "invoices",
            fields: [
              { name: "client_name", type: "text", required: true },
              { name: "amount", type: "number" },
            ],
          },
        ],
      },
    });
    expect(defined.isError, text(defined)).toBeFalsy();
    const built = await client.callTool({ name: "build_project", arguments: { project: "interop" } });
    expect(built.isError, text(built)).toBeFalsy();
    expect(JSON.parse(text(built))).toMatchObject({
      project: "interop",
      files: 16,
      bricks: ["multi-workspace", "credit-wallet", "dynamic-entities"],
      entities: ["invoices"],
    });
    await client.close();
  });

  test("a tool error reaches the client as an error result it can read, not as an exception", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "enable_brick", arguments: { project: "interop", bricks: ["no-such-brick"] } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/unknown brick "no-such-brick"/);
    await client.close();
  });

  test("an unknown tool is rejected by the client library as a protocol error", async () => {
    const { client } = await connect();
    await expect(client.callTool({ name: "delete_everything", arguments: {} })).rejects.toThrow(/Unknown tool/);
    await client.close();
  });

  test("pings", async () => {
    const { client } = await connect();
    await expect(client.ping()).resolves.toBeDefined();
    await client.close();
  });

  test("with the wrong token it cannot connect, and with none it cannot either", async () => {
    await expect(connect("not-the-token")).rejects.toThrow();
    await expect(connect(null)).rejects.toThrow();
  });

  test("the client's request headers are the ones the server was written to expect", async () => {
    calls.length = 0;
    const { client } = await connect();
    await client.listTools();
    const first = calls[0]!;
    expect(first.method).toBe("POST");
    expect(first.headers["content-type"]).toMatch(/application\/json/);
    expect(first.headers.accept).toMatch(/application\/json/);
    expect(first.headers.accept).toMatch(/text\/event-stream/);
    await client.close();
  });
});
