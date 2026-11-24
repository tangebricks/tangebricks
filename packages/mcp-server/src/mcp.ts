import { Hono } from "hono";
import type { Context } from "hono";
import type { Catalog } from "@poc/assembler";
import type { D1Like } from "@poc/sdk";
import { isMcpScope, requiredScopeForTool, scopesAllow } from "./auth.ts";
import type { McpTokenVerifier, McpVerifiedToken } from "./auth.ts";
import {
  ProjectOutOfScopeError,
  createInMemoryBlueprintClient,
  pinBlueprintClient,
  resolveBlueprintClient,
  withinRateLimit,
} from "./store.ts";
import type {
  BlueprintAuthor,
  BlueprintClient,
  BlueprintDoNamespaceLike,
} from "./store.ts";
import {
  ALL_TOOLS,
  LEGACY_TOOLS,
  TOOLS,
  checkArguments,
  revertToRevisionTool,
  toolDescriptions,
  type StudioRequestFn,
  type Tool,
} from "./tools.ts";

// A stateless MCP server over HTTP, written against the 2025-11-25 revision of the protocol (Streamable HTTP, JSON
// responses only). "Stateless" means the Worker keeps nothing between calls: it assigns no session id (the revision
// makes sessions optional), and project state lives in BlueprintDO.

export const PROTOCOL_VERSION = "2025-11-25";
export const SERVER_INFO = { name: "projectx-poc-assembler", version: "0.0.0" } as const;
const MAX_BODY_BYTES = 256 * 1024;

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export interface McpEnv {
  Bindings: {
    DB: D1Like;
    BLUEPRINT_DO?: BlueprintDoNamespaceLike;
  };
}
export interface McpOptions {
  catalog: Catalog;
  /**
   * Verifies a presented bearer and returns its user, the one project it is bound to, and its scopes (story 0.15). With no
   * verifier the server refuses every call: an unconfigured endpoint is closed, not open.
   */
  verifyToken?: McpTokenVerifier;
  /** Origins allowed to call from a browser. A request with no Origin header (a program, not a page) is always allowed. */
  allowedOrigins?: readonly string[];
  /** Tool calls allowed per minute across the whole server. */
  callsPerMinute?: number;
  /** Optional BlueprintClient override (defaults to BLUEPRINT_DO binding when available or an in-memory BlueprintDO adapter). */
  blueprintClient?: BlueprintClient;
  /** Optional Studio API dispatch helper for runtime/deploy/connection/log tools. */
  studioRequest?: StudioRequestFn;
  /** Optional base URL for Studio consent URLs. */
  baseUrl?: string;
  /**
   * The verified workspace standalone test_workflow records its runs under (no Studio configured). Without one, a
   * standalone run is refused: there is no default workspace (story 1.4).
   */
  standaloneWorkspaceId?: string;
  /** Optional custom tool registry (used for negative tamper testing of token budgets). */
  tools?: ReadonlyArray<Tool>;
}

type Id = string | number;
const rpcError = (id: Id | null, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message },
});
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });

/** Keeps only a well-formed verifier answer: a user, a project, and at least one valid scope. */
function acceptVerified(value: McpVerifiedToken | null | undefined): McpVerifiedToken | null {
  if (!value || typeof value !== "object") return null;
  if (typeof value.userId !== "string" || value.userId.length === 0) return null;
  if (typeof value.projectId !== "string" || value.projectId.length === 0) return null;
  const scopes = Array.isArray(value.scopes) ? value.scopes.filter(isMcpScope) : [];
  if (scopes.length === 0) return null;
  return { ...value, scopes };
}

export function createMcpApp(options: McpOptions): Hono<McpEnv> {
  const app = new Hono<McpEnv>();
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const callsPerMinute = options.callsPerMinute ?? 120;
  const fallbackBlueprintClient =
    options.blueprintClient ?? createInMemoryBlueprintClient(options.catalog);

  type Ctx = Context<McpEnv>;
  const json = (
    c: Ctx,
    status: 200 | 400 | 401 | 403 | 406 | 413 | 415 | 429 | 503,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  // One endpoint. It does not offer a server-to-client stream or sessions, so these methods are not allowed.
  const notAllowed = () => new Response(null, { status: 405, headers: { allow: "POST" } });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  app.post("/mcp", async (c) => {
    // 1. Where it came from. A browser page always sends Origin; a program does not.
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigins.has(origin))
      return json(c, 403, rpcError(null, ERR.invalidRequest, "origin not allowed"));

    // 2. Who is asking. With no verifier the server refuses everyone: an unconfigured endpoint is closed, not open.
    const verifyToken = options.verifyToken;
    if (!verifyToken)
      return json(
        c,
        503,
        rpcError(null, ERR.internal, "this server has no token verifier configured"),
      );
    const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    let verified: McpVerifiedToken | null = null;
    if (given !== undefined) {
      try {
        verified = acceptVerified(
          await verifyToken(given, (c.env ?? {}) as unknown as Record<string, unknown>),
        );
      } catch {
        verified = null;
      }
    }
    if (!verified)
      return json(c, 401, rpcError(null, ERR.invalidRequest, "missing or wrong access token"), {
        "www-authenticate": 'Bearer realm="mcp"',
      });
    const caller = verified;

    // 3. Is it a request this server can read at all.
    const version = c.req.header("mcp-protocol-version");
    if (version !== undefined && version !== PROTOCOL_VERSION)
      return json(
        c,
        400,
        rpcError(
          null,
          ERR.invalidRequest,
          `unsupported MCP-Protocol-Version; this server speaks ${PROTOCOL_VERSION}`,
        ),
      );
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? ""))
      return json(c, 415, rpcError(null, ERR.invalidRequest, "send Content-Type: application/json"));
    const accept = c.req.header("accept");
    if (accept !== undefined && !/application\/json|\*\/\*/.test(accept))
      return json(c, 406, rpcError(null, ERR.invalidRequest, "this server answers application/json"));
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES)
      return json(c, 413, rpcError(null, ERR.invalidRequest, "request too large"));
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES)
      return json(c, 413, rpcError(null, ERR.invalidRequest, "request too large"));

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return json(c, 400, rpcError(null, ERR.parse, "the body is not valid JSON"));
    }
    // One message per request: batching was removed from the protocol.
    if (typeof message !== "object" || message === null || Array.isArray(message))
      return json(
        c,
        400,
        rpcError(null, ERR.invalidRequest, "send one JSON-RPC message, not a list"),
      );
    const rpc = message as {
      jsonrpc?: unknown;
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (rpc.jsonrpc !== "2.0")
      return json(c, 400, rpcError(null, ERR.invalidRequest, 'jsonrpc must be "2.0"'));

    // A response or a notification gets no answer: 202 and nothing else.
    const isResponse = ("result" in rpc || "error" in rpc) && !("method" in rpc);
    if (isResponse) return new Response(null, { status: 202 });
    if (typeof rpc.method !== "string")
      return json(c, 400, rpcError(null, ERR.invalidRequest, "a message needs a method"));
    if (!("id" in rpc)) return new Response(null, { status: 202 });
    if (typeof rpc.id !== "string" && typeof rpc.id !== "number")
      return json(c, 400, rpcError(null, ERR.invalidRequest, "id must be a string or a number"));
    const id = rpc.id;
    const params = (rpc.params ?? {}) as Record<string, unknown>;
    if (typeof params !== "object" || Array.isArray(params))
      return json(c, 200, rpcError(id, ERR.invalidParams, "params must be an object"));

    try {
      switch (rpc.method) {
        case "initialize":
          return json(
            c,
            200,
            rpcResult(id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              instructions:
                "Build a project: enable_brick, define_entity, or apply_ops, then build_project.",
            }),
          );
        case "ping":
          return json(c, 200, rpcResult(id, {}));
        case "tools/list":
          return json(
            c,
            200,
            rpcResult(id, { tools: toolDescriptions(options.tools ?? TOOLS) }),
          );
        case "tools/call": {
          const name = params.name;
          let rawArgs =
            typeof params.arguments === "object" &&
            params.arguments !== null &&
            !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : params.arguments === undefined
                ? {} // no `arguments` field is an empty object, so the project default below still applies
                : undefined;
          const isRevertAlias =
            name === "apply_ops" &&
            rawArgs !== undefined &&
            ("revertTo" in rawArgs || "targetRevision" in rawArgs) &&
            !("ops" in rawArgs);
          const activeAllTools = options.tools
            ? [...options.tools, ...LEGACY_TOOLS]
            : ALL_TOOLS;
          const tool =
            typeof name === "string"
              ? isRevertAlias
                ? revertToRevisionTool
                : (activeAllTools.find((t) => t.name === name) ??
                  (name === "revert_to_revision" ? revertToRevisionTool : undefined))
              : undefined;
          if (!tool)
            return json(
              c,
              200,
              rpcError(
                id,
                ERR.invalidParams,
                `Unknown tool: ${typeof name === "string" ? name.slice(0, 100) : "(no name)"}`,
              ),
            );
          // The tool's project defaults to the token's project; any other project, or a write the token's scopes do not
          // allow, is refused before any work.
          if (rawArgs !== undefined && !("project" in rawArgs))
            rawArgs = { ...rawArgs, project: caller.projectId };
          const targetProject =
            rawArgs !== undefined && typeof rawArgs.project === "string"
              ? rawArgs.project
              : caller.projectId;
          if (targetProject !== caller.projectId)
            return json(
              c,
              403,
              rpcError(id, ERR.invalidRequest, "this token is bound to a different project"),
            );
          const requiredScope = requiredScopeForTool(tool.name, tool.readOnly);
          if (!scopesAllow(caller.scopes, requiredScope))
            return json(
              c,
              403,
              rpcError(
                id,
                ERR.invalidRequest,
                `this token lacks the "${requiredScope}" scope for ${tool.name}`,
              ),
            );
          // Counted before any work, so a flood is refused cheaply.
          if (!(await withinRateLimit(c.env.DB, callsPerMinute)))
            return json(c, 429, rpcError(id, ERR.internal, "too many tool calls; wait a minute"), {
              "retry-after": "60",
            });
          const effectiveArgs =
            isRevertAlias && rawArgs
              ? {
                  project: rawArgs.project,
                  targetRevision: rawArgs.revertTo ?? rawArgs.targetRevision,
                  ...(rawArgs.baseRevision !== undefined
                    ? { baseRevision: rawArgs.baseRevision }
                    : {}),
                }
              : (rawArgs ?? params.arguments);
          const checked = checkArguments(tool, effectiveArgs);
          // Bad arguments are the model's to fix, so they are a tool error it can read, not a protocol error.
          if (!checked.ok)
            return json(
              c,
              200,
              rpcResult(id, {
                content: [{ type: "text", text: `Invalid arguments: ${checked.message}` }],
                isError: true,
              }),
            );
          const blueprint = pinBlueprintClient(
            options.blueprintClient ?? resolveBlueprintClient(c.env, fallbackBlueprintClient),
            caller.projectId,
          );
          // The author is the verified token's user; request headers cannot set it.
          const author: BlueprintAuthor = {
            type: "agent",
            id: caller.tokenId ?? `agent:${caller.userId}`,
            client: caller.clientName ?? "mcp",
            onBehalfOf: caller.userId,
          };
          let baseUrl = options.baseUrl;
          if (!baseUrl) {
            try {
              baseUrl = new URL(c.req.url).origin;
            } catch {
              baseUrl = "https://studio.projectx.local";
            }
          }
          const result = await tool.run(
            {
              db: c.env.DB,
              catalog: options.catalog,
              blueprint,
              author,
              studioRequest: options.studioRequest,
              baseUrl,
              projectId: caller.projectId,
              ...(options.standaloneWorkspaceId ? { workspaceId: options.standaloneWorkspaceId } : {}),
            },
            checked.value,
          );
          return json(
            c,
            200,
            rpcResult(id, {
              content: [{ type: "text", text: result.text }],
              ...(result.isError ? { isError: true } : {}),
            }),
          );
        }
        default:
          return json(
            c,
            200,
            rpcError(id, ERR.methodNotFound, `Method not found: ${rpc.method.slice(0, 100)}`),
          );
      }
    } catch (error) {
      if (error instanceof ProjectOutOfScopeError)
        return json(c, 403, rpcError(id, ERR.invalidRequest, error.message));
      console.error("mcp:", error);
      return json(c, 200, rpcError(id, ERR.internal, "internal error"));
    }
  });

  return app;
}
