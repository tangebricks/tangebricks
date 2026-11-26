import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { sha256Hex } from "@poc/assembler";
import type { Op } from "@poc/blueprint";
import type { D1Like, D1Result, D1Statement } from "@poc/sdk";
import { upsertRunRecord } from "../../../packages/telemetry/src/index.ts";
import tailwindcss from "tailwindcss";
import {
  BlueprintDO,
  app as studioApp,
  ensureStudioD1Schema,
} from "../../studio-api/src/index.ts";
import type { StudioApiEnv } from "../../studio-api/src/index.ts";
import tailwindConfig from "../tailwind.config.ts";

interface NodeWs {
  readonly readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | string) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

interface NodeWsServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    upgradeHead: Buffer,
    callback: (client: NodeWs, request: IncomingMessage) => void,
  ): void;
  close(cb?: () => void): void;
}

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (options: { noServer: boolean }) => NodeWsServer;
};

export const E2E_MCP_TOKEN = "st_mcp_e2e_claude_desktop_token_0123456789";

function createSqliteD1(): D1Like & { close(): void } {
  const sqlite = new DatabaseSync(":memory:");
  const inside = new WeakMap<object, { sql: string; params: SQLInputValue[] }>();

  const execute = ({ sql, params }: { sql: string; params: SQLInputValue[] }): D1Result => {
    const prepared = sqlite.prepare(sql);
    if (/^\s*(pragma|select|explain)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      const rows = prepared.all(...params).map((row) => ({ ...row }));
      return { results: rows, success: true, meta: { changes: 0 } };
    }
    const result = prepared.run(...params);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid ?? 0),
      } as D1Result["meta"],
    };
  };

  const statement = (sql: string, params: SQLInputValue[] = []): D1Statement => {
    const stmt: D1Statement = {
      bind: (...values) => statement(sql, values as SQLInputValue[]),
      async first<Row>() {
        const row = sqlite.prepare(sql).get(...params);
        return row ? ({ ...row } as Row) : null;
      },
      async run() {
        return execute({ sql, params });
      },
      async all<Row>() {
        const rows = sqlite
          .prepare(sql)
          .all(...params)
          .map((row) => ({ ...row }) as Row);
        return { results: rows, success: true, meta: { changes: 0 } } as D1Result<Row>;
      },
    };
    inside.set(stmt, { sql, params });
    return stmt;
  };

  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((stmt) => {
          const known = inside.get(stmt);
          if (!known) {
            throw new Error("batch was given a statement this database did not prepare");
          }
          return execute(known);
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql) {
      sqlite.exec(sql);
    },
    close: () => sqlite.close(),
  };
}

interface BridgeClientSocket {
  _attach: (realWs: NodeWs) => void;
}

interface BridgeServerSocket {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  serializeAttachment: (value: unknown) => void;
  deserializeAttachment: () => unknown;
  _setDoOwner?: (doInstance: BlueprintDO) => void;
  _isClosed?: () => boolean;
}

function installNodeWebSocketPair(): void {
  const g = globalThis as unknown as {
    WebSocketPair?: new () => { 0: BridgeClientSocket; 1: BridgeServerSocket };
  };
  if (g.WebSocketPair) return;

  g.WebSocketPair = class NodeWebSocketPair {
    0: BridgeClientSocket;
    1: BridgeServerSocket;

    constructor() {
      let realWs: NodeWs | null = null;
      let doOwner: BlueprintDO | null = null;
      let closed = false;
      let attachment: unknown = null;
      const pendingMessages: string[] = [];

      const serverSocket: BridgeServerSocket = {
        send(data: string) {
          if (closed) return;
          if (realWs && realWs.readyState === 1) {
            realWs.send(data);
          } else {
            pendingMessages.push(data);
          }
        },
        close(code = 1000, reason = "Closed") {
          closed = true;
          if (realWs && realWs.readyState === 1) {
            realWs.close(code, reason);
          }
        },
        serializeAttachment(value: unknown) {
          attachment = value;
        },
        deserializeAttachment() {
          return attachment;
        },
        _setDoOwner(instance: BlueprintDO) {
          doOwner = instance;
        },
        _isClosed() {
          return closed;
        },
      };

      const clientSocket: BridgeClientSocket = {
        _attach(ws: NodeWs) {
          realWs = ws;
          while (pendingMessages.length > 0 && ws.readyState === 1) {
            const nextMsg = pendingMessages.shift()!;
            ws.send(nextMsg);
          }
          ws.on("message", (raw) => {
            const text = typeof raw === "string" ? raw : raw.toString("utf8");
            if (doOwner) {
              void doOwner.webSocketMessage(
                serverSocket as unknown as WebSocket,
                text,
              );
            }
          });
          ws.on("close", (code, reasonBuf) => {
            closed = true;
            if (doOwner) {
              void doOwner.webSocketClose(
                serverSocket as unknown as WebSocket,
                code,
                reasonBuf ? reasonBuf.toString("utf8") : "",
                true,
              );
            }
          });
          ws.on("error", () => {
            closed = true;
            if (doOwner) {
              void doOwner.webSocketError(
                serverSocket as unknown as WebSocket,
                new Error("ws error"),
              );
            }
          });
        },
      };

      this[0] = clientSocket;
      this[1] = serverSocket;
    }
  };
}

function createNodeDurableObjectNamespace(getEnv: () => StudioApiEnv): {
  namespace: DurableObjectNamespace;
  closeAll: () => void;
} {
  const instances = new Map<
    string,
    { instance: BlueprintDO; sqlite: DatabaseSync }
  >();

  function getOrCreateInstance(name: string): BlueprintDO {
    let entry = instances.get(name);
    if (!entry) {
      const sqlite = new DatabaseSync(":memory:");
      let txDepth = 0;
      const acceptedSockets = new Set<{
        ws: BridgeServerSocket;
        tags: string[];
      }>();

      let doInstanceRef: BlueprintDO | null = null;

      const ctx = {
        id: {
          toString: () => name,
          equals: (other: { toString(): string }) => other.toString() === name,
          name,
        },
        storage: {
          sql: {
            exec<T = Record<string, unknown>>(
              query: string,
              ...bindings: unknown[]
            ): { toArray(): T[] } {
              const trimmed = query.trim();
              if (bindings.length === 0 && !/^SELECT\b/i.test(trimmed)) {
                sqlite.exec(query);
                return { toArray: () => [] };
              }
              const stmt = sqlite.prepare(query);
              if (/^SELECT\b/i.test(trimmed)) {
                const rows = stmt
                  .all(...(bindings as SQLInputValue[]))
                  .map((r) => ({ ...r }) as T);
                return { toArray: () => rows };
              }
              stmt.run(...(bindings as SQLInputValue[]));
              return { toArray: () => [] };
            },
          },
          transactionSync<T>(closure: () => T): T {
            const isOuter = txDepth === 0;
            if (isOuter) sqlite.exec("BEGIN");
            txDepth += 1;
            try {
              const res = closure();
              txDepth -= 1;
              if (isOuter) sqlite.exec("COMMIT");
              return res;
            } catch (err) {
              txDepth -= 1;
              if (isOuter) {
                try {
                  sqlite.exec("ROLLBACK");
                } catch {
                  // Ignore rollback error
                }
              }
              throw err;
            }
          },
        },
        acceptWebSocket(ws: unknown, tags: string[] = []) {
          const bridgeWs = ws as BridgeServerSocket;
          if (doInstanceRef && bridgeWs._setDoOwner) {
            bridgeWs._setDoOwner(doInstanceRef);
          }
          acceptedSockets.add({ ws: bridgeWs, tags });
        },
        getWebSockets(tag?: string): WebSocket[] {
          const active: WebSocket[] = [];
          for (const item of acceptedSockets) {
            if (item.ws._isClosed?.()) {
              acceptedSockets.delete(item);
              continue;
            }
            if (!tag || item.tags.includes(tag)) {
              active.push(item.ws as unknown as WebSocket);
            }
          }
          return active;
        },
      } as unknown as DurableObjectState;

      const doInstance = new BlueprintDO(ctx, getEnv());
      doInstanceRef = doInstance;
      entry = { instance: doInstance, sqlite };
      instances.set(name, entry);
    }
    return entry.instance;
  }

  const namespace = {
    idFromName(name: string) {
      return {
        toString: () => name,
        equals: (other: { toString(): string }) => other.toString() === name,
        name,
      } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const name = (id as unknown as { name?: string }).name ?? id.toString();
      const instance = getOrCreateInstance(name);
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const req =
            input instanceof Request
              ? input
              : new Request(
                  typeof input === "string" ? input : input.toString(),
                  init,
                );
          return instance.fetch(req);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  return {
    namespace,
    closeAll() {
      for (const { sqlite } of instances.values()) {
        try {
          sqlite.close();
        } catch {
          // Ignore close error
        }
      }
      instances.clear();
    },
  };
}

function extractSessionCookie(res: Response): string {
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""].filter(Boolean);
  return setCookies
    .map((c) => c.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

async function seedRealStudioBackend(env: StudioApiEnv): Promise<void> {
  await ensureStudioD1Schema(env.STUDIO_DB);
  // Story 1.17: a Studio run may name only one of the project's own preview workspaces. Here DB is the shared Studio
  // database, which is not acme-saas's own data store and is never consulted, so the workspace the run specs use
  // (ws_alpha) is made acme-saas's the other way: an earlier run of acme-saas names it.
  await upsertRunRecord(
    env.STUDIO_DB,
    {
      runId: "run_e2e_seed_ws_alpha",
      workflowId: "wf_e2e_workspace_seed",
      revision: 0,
      triggerType: "manual",
      workspaceId: "ws_alpha",
      status: "succeeded",
      durationMs: 0,
      retries: 0,
      startedAt: new Date().toISOString(),
    },
    { projectId: "acme-saas" },
  );

  const apiCall = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    // Send the same-origin Origin header a browser sends; cookie-authenticated
    // mutating routes refuse requests without it (CSRF check, story 0.14).
    const headers = new Headers(init.headers);
    if (!headers.has("origin")) headers.set("origin", "http://127.0.0.1:8787");
    const req = new Request(`http://127.0.0.1:8787${path}`, { ...init, headers });
    return studioApp.fetch(req, env);
  };

  // 1. Sign up Alice (Owner) and Viewer via real Better Auth
  await apiCall("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Alice Owner",
      email: "alice@example.com",
      password: "password12345",
    }),
  });

  const aliceSignIn = await apiCall("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "alice@example.com",
      password: "password12345",
    }),
  });
  const aliceCookie = extractSessionCookie(aliceSignIn);

  await apiCall("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Viewer User",
      email: "viewer@example.com",
      password: "viewerpass123",
    }),
  });

  // 2. Create Acme Org as Alice (Owner)
  const createOrgRes = await apiCall("/api/orgs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: aliceCookie,
    },
    body: JSON.stringify({
      name: "Acme Org",
      slug: "acme",
    }),
  });
  const orgBody = (await createOrgRes.json()) as { org: { id: string } };
  const acmeOrgId = orgBody.org.id;

  // 3. Add Viewer User to Acme Org with role 'viewer'
  await apiCall(`/api/orgs/${encodeURIComponent(acmeOrgId)}/members`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: aliceCookie,
    },
    body: JSON.stringify({
      email: "viewer@example.com",
      role: "viewer",
    }),
  });

  // 4. Seed scoped MCP token for Acme Org ("Claude Desktop")
  const aliceUserRow = await env.STUDIO_DB.prepare(
    `SELECT id FROM "user" WHERE email = ?`,
  )
    .bind("alice@example.com")
    .first<{ id: string }>();
  const aliceUserId = aliceUserRow?.id ?? "alice";
  const tokenHash = await sha256Hex(E2E_MCP_TOKEN);
  // Story 0.15: every MCP token is bound to one project; this one to "acme-saas". A spec that drives another project
  // over MCP needs that project's own token.
  await env.STUDIO_DB.prepare(
    `INSERT INTO studio_mcp_tokens (id, org_id, project_id, user_id, client_name, token_hash, scopes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      "mcp_tok_e2e_claude",
      acmeOrgId,
      "acme-saas",
      aliceUserId,
      "Claude Desktop",
      tokenHash,
      "read,edit",
    )
    .run();

  // 5. Create project "acme-saas" and commit revisions r1 and r2 through real BlueprintDO
  await apiCall(`/api/orgs/${encodeURIComponent(acmeOrgId)}/projects`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: aliceCookie,
    },
    body: JSON.stringify({ project: "acme-saas" }),
  });

  const r1Ops: Op[] = [
    { opId: "seed-1a", type: "enable_brick", brickId: "multi-workspace", config: {} },
    {
      opId: "seed-1b",
      type: "enable_brick",
      brickId: "credit-wallet",
      config: { creditsPerUnit: 10, minOrderAmount: 100 },
    },
    { opId: "seed-1c", type: "enable_brick", brickId: "dynamic-entities", config: {} },
  ];
  await apiCall("/api/projects/acme-saas/ops", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: aliceCookie,
    },
    body: JSON.stringify({
      author: { type: "human", id: "alice" },
      summary: "Enable core workspace, wallet, and entity bricks",
      ops: r1Ops,
    }),
  });

  const r2Ops: Op[] = [
    {
      opId: "seed-2a",
      type: "add_entity",
      entity: {
        name: "invoices",
        workspaceScoped: true,
        fields: [
          { name: "title", type: "text", required: true, maxLength: 160 },
          { name: "amount_cents", type: "number", required: true, min: 0 },
        ],
      },
    },
    {
      opId: "seed-2b",
      type: "add_workflow",
      workflow: {
        id: "wf-billing",
        name: "Invoice Billing Flow",
        nodes: [
          { id: "node-trigger", type: "trigger.manual", label: "Manual Trigger", data: {} },
          {
            id: "node-pick",
            type: "transform.pick",
            label: "Pick Invoice Title",
            data: { path: "title" },
          },
        ],
        edges: [
          {
            id: "edge-1",
            source: "node-trigger",
            target: "node-pick",
            sourceHandle: "out",
            targetHandle: "in",
          },
        ],
      },
    },
  ];
  await apiCall("/api/projects/acme-saas/ops", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: aliceCookie,
    },
    body: JSON.stringify({
      author: { type: "agent", id: "claude-1", client: "Claude Desktop" },
      summary: "Add invoices entity and wf-billing workflow",
      ops: r2Ops,
    }),
  });

  // 6. Create project "live-sync-proj" initialized at r0 in BlueprintDO and D1
  await apiCall(`/api/orgs/${encodeURIComponent(acmeOrgId)}/projects`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: aliceCookie,
    },
    body: JSON.stringify({ project: "live-sync-proj" }),
  });
}

function readNodeRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

function buildFetchHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }
  return headers;
}

export default async function globalSetup() {
  installNodeWebSocketPair();

  const studioWebRoot = resolve(import.meta.dirname, "..");
  const viteEntry = pathToFileURL(
    resolve(studioWebRoot, "node_modules/vite/dist/node/index.js"),
  ).href;

  const studioDb = createSqliteD1();
  let studioEnv!: StudioApiEnv;
  const doNamespace = createNodeDurableObjectNamespace(() => studioEnv);
  studioEnv = {
    STUDIO_DB: studioDb,
    DB: studioDb,
    BLUEPRINT_DO: doNamespace.namespace,
    BETTER_AUTH_SECRET: "studio-e2e-real-backend-secret-0123456789abcdef",
    // Test-only values: studio-api has no source fallbacks for these secrets any more.
    PX_VAULT_KEY: "studio-e2e-vault-key-0123456789abcdef",
    PX_CONN_KEY: "studio-e2e-conn-key-0123456789abcdef",
    PX_TOKEN_KEK: "studio-e2e-token-kek-0123456789abcdef",
    PX_TELEMETRY_SECRET: "studio-e2e-telemetry-secret-0123456789",
    // Story R53: the e2e backend deploys to the in-memory fake, chosen explicitly (refused in production).
    PX_DEPLOY_CLIENT: "fake",
    PX_ENVIRONMENT: "test",
    // Test-only (story 0.21): every spec signs in as the same seeded users (alice, viewer) from one local IP, so the
    // real per-account and per-IP auth limits would refuse logins after the tenth spec. Raise them for the e2e run only;
    // the limiter itself is proven by packages/assembler/test/rate-limit.attack.test.ts and studio-api's auth-rate-limit test.
    PX_RATE_LIMITS: JSON.stringify({
      "auth-login-account": { limit: 100_000, windowSeconds: 600 },
      "auth-login-ip": { limit: 100_000, windowSeconds: 600 },
      "auth-signup-ip": { limit: 100_000, windowSeconds: 3600 },
    }),
  };

  await seedRealStudioBackend(studioEnv);

  const wss = new WebSocketServer({ noServer: true });

  const apiServer = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const method = req.method ?? "GET";
        const url = `http://127.0.0.1:8787${req.url ?? "/"}`;
        const headers = buildFetchHeaders(req);
        const hasBody = method !== "GET" && method !== "HEAD";
        const bodyBuf = hasBody ? await readNodeRequestBody(req) : undefined;

        const fetchReq = new Request(url, {
          method,
          headers,
          body: bodyBuf && bodyBuf.length > 0 ? new Uint8Array(bodyBuf) : undefined,
        });

        const fetchRes = await studioApp.fetch(fetchReq, studioEnv);
        res.statusCode = fetchRes.status;

        const setCookies =
          typeof fetchRes.headers.getSetCookie === "function"
            ? fetchRes.headers.getSetCookie()
            : [];
        if (setCookies.length > 0) {
          res.setHeader("set-cookie", setCookies);
        }
        fetchRes.headers.forEach((value, key) => {
          if (key.toLowerCase() === "set-cookie") return;
          res.setHeader(key, value);
        });

        const arrayBuf = await fetchRes.arrayBuffer();
        res.end(Buffer.from(arrayBuf));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: {
              code: "INTERNAL_ERROR",
              message: err instanceof Error ? err.message : "Internal Server Error",
            },
          }),
        );
      }
    },
  );

  apiServer.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const headers = buildFetchHeaders(req);
      headers.set("upgrade", "websocket");
      const fetchReq = new Request(`http://127.0.0.1:8787${req.url ?? "/"}`, {
        method: "GET",
        headers,
      });

      const fetchRes = await studioApp.fetch(fetchReq, studioEnv);
      const clientSocket = (
        fetchRes as Response & { webSocket?: BridgeClientSocket }
      ).webSocket;

      if (!clientSocket || (fetchRes.status !== 101 && fetchRes.status !== 200)) {
        socket.write(`HTTP/1.1 ${fetchRes.status || 403} Forbidden\r\n\r\n`);
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        clientSocket._attach(ws);
      });
    } catch {
      socket.destroy();
    }
  });

  await new Promise<void>((resolveListen) => {
    apiServer.listen(8787, "127.0.0.1", () => resolveListen());
  });

  const viteMod = (await import(viteEntry)) as {
    createServer: (inlineConfig: Record<string, unknown>) => Promise<{
      listen: () => Promise<void>;
      close: () => Promise<void>;
    }>;
  };

  const server = await viteMod.createServer({
    root: studioWebRoot,
    configFile: false,
    oxc: { jsx: { runtime: "automatic" } },
    css: {
      postcss: {
        plugins: [
          tailwindcss({
            ...tailwindConfig,
            content: [
              resolve(studioWebRoot, "./index.html"),
              resolve(studioWebRoot, "./src/**/*.{ts,tsx}"),
            ],
          }),
        ],
      },
    },
    server: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:8787",
          changeOrigin: true,
          ws: true,
        },
        "/mcp": {
          target: "http://127.0.0.1:8787",
          changeOrigin: true,
        },
      },
    },
    logLevel: "error",
  });
  await server.listen();

  return async () => {
    await server.close();
    wss.close();
    await new Promise<void>((resolveClose) => apiServer.close(() => resolveClose()));
    doNamespace.closeAll();
    studioDb.close();
  };
}
