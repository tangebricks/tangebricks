import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { D1Like, D1Result, D1Statement } from "../../packages/sdk/src/index.ts";
import { BlueprintDO } from "../../apps/studio-api/src/index.ts";
import type { StudioApiEnv } from "../../apps/studio-api/src/index.ts";

// Studio's API run in-process under Node (story R53): its STUDIO_DB on node:sqlite and its BlueprintDO behind a small Durable
// Object namespace, as the e2e backend does (apps/studio-web/e2e/global-setup.ts), without the WebSocket bridge. Used by
// scripts/live-studio-deploy.ts and by its offline tests. Not a test double for Cloudflare: Studio's own storage only.

export function createNodeSqliteD1(path = ":memory:"): D1Like & { close(): void } {
  const sqlite = new DatabaseSync(path);
  const inside = new WeakMap<object, { sql: string; params: SQLInputValue[] }>();
  const execute = ({ sql, params }: { sql: string; params: SQLInputValue[] }): D1Result => {
    const prepared = sqlite.prepare(sql);
    if (/^\s*(pragma|select|explain|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) {
      return { results: prepared.all(...params).map((row) => ({ ...row })), success: true, meta: { changes: 0 } };
    }
    const result = prepared.run(...params);
    return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid ?? 0) } as D1Result["meta"] };
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
        const rows = sqlite.prepare(sql).all(...params).map((row) => ({ ...row }) as Row);
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
          if (!known) throw new Error("batch was given a statement this database did not prepare");
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

function createNodeDurableObjectNamespace(getEnv: () => StudioApiEnv): { namespace: DurableObjectNamespace; closeAll(): void } {
  const instances = new Map<string, { instance: BlueprintDO; sqlite: DatabaseSync }>();
  const instanceFor = (name: string): BlueprintDO => {
    const existing = instances.get(name);
    if (existing) return existing.instance;
    const sqlite = new DatabaseSync(":memory:");
    let txDepth = 0;
    const ctx = {
      id: { toString: () => name, equals: (other: { toString(): string }) => other.toString() === name, name },
      storage: {
        sql: {
          exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] } {
            const trimmed = query.trim();
            if (bindings.length === 0 && !/^SELECT\b/i.test(trimmed)) {
              sqlite.exec(query);
              return { toArray: () => [] };
            }
            const stmt = sqlite.prepare(query);
            if (/^SELECT\b/i.test(trimmed)) {
              const rows = stmt.all(...(bindings as SQLInputValue[])).map((r) => ({ ...r }) as T);
              return { toArray: () => rows };
            }
            stmt.run(...(bindings as SQLInputValue[]));
            return { toArray: () => [] };
          },
        },
        transactionSync<T>(closure: () => T): T {
          const outer = txDepth === 0;
          if (outer) sqlite.exec("BEGIN");
          txDepth += 1;
          try {
            const result = closure();
            txDepth -= 1;
            if (outer) sqlite.exec("COMMIT");
            return result;
          } catch (error) {
            txDepth -= 1;
            if (outer) sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      },
      acceptWebSocket() {},
      getWebSockets: () => [],
    } as unknown as DurableObjectState;
    const instance = new BlueprintDO(ctx, getEnv());
    instances.set(name, { instance, sqlite });
    return instance;
  };
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name, equals: (other: { toString(): string }) => other.toString() === name, name }) as unknown as DurableObjectId,
    get(id: DurableObjectId) {
      const instance = instanceFor((id as unknown as { name?: string }).name ?? id.toString());
      return {
        fetch: (input: Request | string | URL, init?: RequestInit) =>
          instance.fetch(input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init)),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  return {
    namespace,
    closeAll() {
      for (const { sqlite } of instances.values()) sqlite.close();
      instances.clear();
    },
  };
}

/**
 * A Studio environment for an in-process run: fresh local databases and freshly generated keys for Studio's own secrets
 * (session signing, vault, token key-encryption). `rootSecret` is Studio's PX_TELEMETRY_SECRET: the deployed Workers get
 * only values derived from it. No PX_DEPLOY_CLIENT: the real Cloudflare client is the default.
 */
export function createNodeStudioEnv(options: { rootSecret: string; studioDbPath?: string; environment?: string }): { env: StudioApiEnv; close(): void } {
  const studioDb = createNodeSqliteD1(options.studioDbPath);
  const key = () => randomBytes(32).toString("hex");
  let env!: StudioApiEnv;
  const durableObjects = createNodeDurableObjectNamespace(() => env);
  env = {
    STUDIO_DB: studioDb,
    DB: studioDb,
    BLUEPRINT_DO: durableObjects.namespace,
    BETTER_AUTH_SECRET: key(),
    PX_VAULT_KEY: key(),
    PX_CONN_KEY: key(),
    PX_TOKEN_KEK: key(),
    PX_TOKEN_KEK_VERSION: "1",
    PX_TELEMETRY_SECRET: options.rootSecret,
    ...(options.environment ? { PX_ENVIRONMENT: options.environment } : {}),
  };
  return {
    env,
    close() {
      durableObjects.closeAll();
      studioDb.close();
    },
  };
}
