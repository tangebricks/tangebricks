import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createStudioApiApp } from "../src/index.ts";
import { createNodeStudioEnv } from "../../../scripts/lib/studio-node-env.ts";
import { createStudioCall } from "../../../scripts/lib/live-studio.ts";

// Story R55: the official MCP client (the protocol's own SDK, as Claude Code uses) against Studio's /mcp. Before this
// story Studio answered notifications/initialized with a 200 JSON-RPC error and GET /mcp with 404; a strict client gives
// up on either. Only the network is a stand-in: the client's fetch goes straight into Studio's app, run on Node's SQLite.

const studio = createNodeStudioEnv({ rootSecret: "mcp-interop-root-secret-0123456789" });
const app = createStudioApiApp();
const call = createStudioCall(app, studio.env);
const PROJECT = "interop-studio";
let token = "";
let session = "";
const calls: Array<{ method: string; rpc: string | undefined; status: number; headers: Record<string, string> }> = [];

const fetchIntoStudio = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const body = request.method === "POST" ? await request.clone().text() : "";
  const response = await app.fetch(request, studio.env);
  calls.push({ method: request.method, rpc: body ? (JSON.parse(body) as { method?: string }).method : undefined, status: response.status, headers: Object.fromEntries(request.headers) });
  return response;
};

const connect = async (bearer: string | null = token) => {
  const client = new Client({ name: "studio-interop-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://studio.local/mcp"), {
    fetch: fetchIntoStudio,
    requestInit: bearer === null ? {} : { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return client;
};
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ type: string; text: string }>)[0]!.text;

beforeAll(async () => {
  const signup = await call("POST", "/api/auth/signup", { email: "owner@interop.test", password: "Pw-interop-0123456789!", name: "Interop Owner" });
  expect(signup.status).toBe(201);
  session = String(signup.body.token);
  const org = await call("POST", "/api/orgs", { name: "Interop", slug: "interop-org" }, session);
  expect([200, 201]).toContain(org.status);
  const orgId = String(org.body.id);
  const project = await call("POST", `/api/orgs/${orgId}/projects`, { project: PROJECT }, session);
  expect([200, 201]).toContain(project.status);
  const issued = await call("POST", `/api/orgs/${orgId}/mcp-tokens`, { clientName: "Claude Code", projectId: PROJECT, scopes: ["read", "edit", "deploy"] }, session);
  expect(issued.status).toBe(201);
  token = String(issued.body.token);
});
afterAll(() => studio.close());

describe("the official MCP client against Studio's /mcp", () => {
  test("connects: initialize, then notifications/initialized answered 202 with no body", async () => {
    calls.length = 0;
    const client = await connect();
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.slice(0, 2).map((c) => c.rpc)).toEqual(["initialize", "notifications/initialized"]);
    expect(posts[1]!.status).toBe(202);
    await client.close();
  });

  test("GET and DELETE on /mcp and /api/mcp are 405 with Allow: POST (no stream, no sessions), and 401 without a caller", async () => {
    for (const path of ["/mcp", "/api/mcp"]) {
      for (const method of ["GET", "DELETE"]) {
        const res = await app.fetch(new Request(`http://studio.local${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } }), studio.env);
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
        // without a caller it is the 401 every control-plane route answers
        const unauth = await app.fetch(new Request(`http://studio.local${path}`, { method }), studio.env);
        expect(unauth.status, `${method} ${path} without a token`).toBe(401);
      }
    }
  });

  test("lists the build surface the benchmark's agent uses", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["apply_ops", "validate_blueprint", "deploy_plan", "deploy_apply", "get_blueprint_summary"]) expect(names).toContain(name);
    await client.close();
  });

  test("calls tools as a model would: a money brick is proposed for the owner, validate_blueprint answers", async () => {
    const client = await connect();
    const proposed = await client.callTool({
      name: "apply_ops",
      arguments: { ops: ["multi-workspace", "credit-wallet", "dynamic-entities"].map((brickId) => ({ opId: `enable-${brickId}`, type: "enable_brick", brickId, config: {} })) },
    });
    expect(proposed.isError, text(proposed)).toBeFalsy();
    const pending = JSON.parse(text(proposed)) as { status: string; proposalId: string };
    expect(pending.status).toBe("pending");
    // The owner reviews in Studio with their session, as a person would.
    const accepted = await call("POST", `/api/projects/${PROJECT}/proposals/${pending.proposalId}/accept`, {}, session);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const validated = await client.callTool({ name: "validate_blueprint", arguments: {} });
    expect(validated.isError, text(validated)).toBeFalsy();
    await client.close();
  });

  test("an unknown tool is a protocol error the client raises; a tool error is a readable result", async () => {
    const client = await connect();
    await expect(client.callTool({ name: "delete_everything", arguments: {} })).rejects.toThrow(/Unknown tool/);
    const refused = await client.callTool({ name: "apply_ops", arguments: { ops: [{ opId: "x", type: "enable_brick", brickId: "no-such-brick" }] } });
    expect(refused.isError).toBe(true);
    await client.close();
  });

  test("pings", async () => {
    const client = await connect();
    await expect(client.ping()).resolves.toBeDefined();
    await client.close();
  });

  test("with a wrong token or none it cannot connect", async () => {
    await expect(connect("not-a-token")).rejects.toThrow();
    await expect(connect(null)).rejects.toThrow();
  });
});
