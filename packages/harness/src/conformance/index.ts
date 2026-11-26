import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyMigration, type D1Like } from "@poc/sdk";
import type { BrickManifestFile } from "@poc/assembler";
import { secretNames } from "../../../assembler/src/schemas.ts";
import { catalog } from "../../../assembler/catalog.generated.ts";
import { attach } from "../results.ts";

export type ConformanceCheckName =
  | "CONF_MIGRATIONS_UP"
  | "CONF_TENANT_ISOLATION"
  | "CONF_IDEMPOTENT_WRITE"
  | "CONF_ERROR_CONTRACT"
  | "CONF_SECRET_SCOPE";

export interface TenantIsolationRequest {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  callerWorkspaceId?: string;
  targetWorkspaceId?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface WriteRequest {
  method: "POST" | "PUT";
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ErrorRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ScopeRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface BrickConformanceOptions {
  brickDir?: string;
  manifest?: BrickManifestFile;
  migrations?: Record<string, string>;
  app?: Hono<any>;
  routes?: Hono<any>;
  db?: D1Like;
  seed?: (db: D1Like, workspaces: { workspaceA: string; workspaceB: string }) => Promise<void> | void;
  skip?: Partial<Record<ConformanceCheckName, string>>;
  globalTables?: string[];
  globalRoutes?: string[];
  allowedBindings?: string[];
  testRequests?: TenantIsolationRequest[];
  writeRequests?: WriteRequest[];
  errorRequests?: ErrorRequest[];
  scopeRequests?: ScopeRequest[];
  idempotencyKey?: string;
}

export interface ConformanceCheckOptions extends BrickConformanceOptions {
  manifest: BrickManifestFile;
  db: D1Like;
  migrations: Record<string, string>;
}

export interface TableInfoColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export async function getUserTables(db: D1Like): Promise<string[]> {
  const result = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'")
    .all<{ name: string }>();
  return (result.results ?? []).map((r) => r.name);
}

export async function resetDatabase(db: D1Like): Promise<void> {
  const tables = await getUserTables(db);
  for (const table of tables) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
}

export async function applyMigrationsInOrder(db: D1Like, migrations: Record<string, string>, manifestOrder?: string[]): Promise<void> {
  const orderedKeys: string[] = [];
  if (manifestOrder) {
    for (const key of manifestOrder) {
      if (key in migrations) orderedKeys.push(key);
    }
  }
  for (const key of Object.keys(migrations).sort()) {
    if (!orderedKeys.includes(key)) orderedKeys.push(key);
  }
  for (const key of orderedKeys) {
    const sql = migrations[key];
    if (sql) {
      await applyMigration(db, sql);
    }
  }
}

export async function checkMigrationsUp(options: ConformanceCheckOptions): Promise<{ tables: string[] }> {
  const { db, migrations, manifest, globalTables = [] } = options;
  await resetDatabase(db);

  try {
    await applyMigrationsInOrder(db, migrations, manifest.migrations);
  } catch (err: any) {
    throw new Error(`[CONF_MIGRATIONS_UP] Migration failed to apply: ${err.message}`);
  }

  const tables = await getUserTables(db);
  if (Object.keys(migrations).length > 0) {
    expect(tables.length).toBeGreaterThan(0);
  }

  const declaredGlobals = new Set<string>([
    ...globalTables,
    ...(manifest.globalTables ?? []).map((g: { table: string }) => g.table),
  ]);

  for (const table of tables) {
    const info = await db.prepare(`PRAGMA table_info(${table})`).all<TableInfoColumn>();
    const columns = (info.results ?? []).map((c) => c.name);
    const hasWorkspaceId = columns.includes("workspace_id");
    const isGlobal = declaredGlobals.has(table);

    if (!hasWorkspaceId && !isGlobal) {
      throw new Error(
        `[CONF_MIGRATIONS_UP] Table "${table}" does not have workspace_id column and is not declared in globalTables`,
      );
    }
    expect(hasWorkspaceId || isGlobal).toBe(true);
  }

  return { tables };
}

async function autoSeedTables(db: D1Like, tables: string[], workspaceA: string, workspaceB: string): Promise<void> {
  for (const table of tables) {
    const info = await db.prepare(`PRAGMA table_info(${table})`).all<TableInfoColumn>();
    const columns = info.results ?? [];
    const hasWorkspaceId = columns.some((c) => c.name === "workspace_id");
    if (!hasWorkspaceId) continue;

    for (const [idx, ws] of [workspaceA, workspaceB].entries()) {
      const colNames: string[] = [];
      const colValues: any[] = [];
      const placeholders: string[] = [];

      for (const col of columns) {
        colNames.push(col.name);
        placeholders.push("?");
        if (col.name === "workspace_id") {
          colValues.push(ws);
        } else if (col.pk === 1) {
          colValues.push(`rec_${ws}_${idx + 1}`);
        } else if (col.type.toUpperCase().includes("INT")) {
          colValues.push(idx + 1);
        } else {
          colValues.push(`val_${ws}_${col.name}`);
        }
      }

      const sql = `INSERT OR IGNORE INTO ${table} (${colNames.join(", ")}) VALUES (${placeholders.join(", ")})`;
      await db.prepare(sql).bind(...colValues).run().catch(() => {});
    }
  }
}

export function buildApp(manifest: BrickManifestFile, options: BrickConformanceOptions): Hono<any> {
  if (options.app) return options.app;
  const app = new Hono<any>();
  if (options.routes) {
    app.route("/", options.routes);
  }
  return app;
}

/**
 * Every row a workspace owns, across the brick's tables, as one string. Used to prove that a request by another
 * workspace changed nothing of the target's (AD-V1: a request cannot name another workspace; one that tries is
 * re-scoped to the caller's own verified workspace, so isolation is proved by content, not by a refusal status).
 */
async function snapshotWorkspace(db: D1Like, tables: string[], workspaceId: string): Promise<string> {
  const parts: string[] = [];
  for (const table of tables) {
    const info = await db.prepare(`PRAGMA table_info(${table})`).all<TableInfoColumn>();
    if (!(info.results ?? []).some((c) => c.name === "workspace_id")) continue;
    const rows = await db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY rowid`).bind(workspaceId).all();
    parts.push(`${table}:${JSON.stringify(rows.results ?? [])}`);
  }
  return parts.join("\n");
}

export async function checkTenantIsolation(options: ConformanceCheckOptions): Promise<void> {
  const { db, migrations, manifest, globalRoutes = [] } = options;
  const { tables } = await checkMigrationsUp(options);

  const workspaceA = "ws_conf_alpha";
  const workspaceB = "ws_conf_beta";

  if (options.seed) {
    await options.seed(db, { workspaceA, workspaceB });
  } else {
    await autoSeedTables(db, tables, workspaceA, workspaceB);
  }

  const app = buildApp(manifest, options);
  let testedCount = 0;

  function isGlobalRoute(p: string): boolean {
    return globalRoutes.some((g) => p === g || p.startsWith(g + "/") || p.startsWith(g + "?") || p.endsWith(g));
  }

  if (options.testRequests && options.testRequests.length > 0) {
    for (const req of options.testRequests) {
      if (isGlobalRoute(req.path)) continue;
      testedCount++;
      const callerWs = req.callerWorkspaceId ?? workspaceB;
      const targetWs = req.targetWorkspaceId ?? workspaceA;

      // 1. Positive control: call as owner workspace
      const ownerHeaders: Record<string, string> = {
        "x-workspace-id": targetWs,
        ...(req.headers ?? {}),
      };
      if (req.body) ownerHeaders["Content-Type"] = "application/json";

      const ownerRes = await app.request(
        req.path,
        {
          method: req.method,
          headers: ownerHeaders,
          body: req.body ? JSON.stringify(req.body) : undefined,
        },
        {
          DB: db,
          workspace: { id: targetWs, role: "owner", suspended: false },
        },
      );

      const ownerBodyText = await ownerRes.text();
      if (ownerRes.status !== 200 && ownerRes.status !== 201) {
        throw new Error(
          `[CONF_TENANT_ISOLATION] cannot confirm isolation: owning workspace request to ${req.method} ${req.path} failed (status ${ownerRes.status})`,
        );
      }

      // 2. Negative check: call as other workspace targeting targetWs
      const targetBefore = await snapshotWorkspace(db, tables, targetWs);
      const headers: Record<string, string> = {
        "x-workspace-id": callerWs,
        ...(req.headers ?? {}),
      };
      if (req.body) headers["Content-Type"] = "application/json";

      const res = await app.request(
        req.path,
        {
          method: req.method,
          headers,
          body: req.body ? JSON.stringify(req.body) : undefined,
        },
        {
          DB: db,
          workspace: { id: callerWs, role: "member", suspended: false },
        },
      );

      const bodyText = await res.text();
      if (res.status === 200 || res.status === 201) {
        // A probe that addresses the target's records (by path id, or with no workspace named at all) must be refused.
        // Only a probe that names the target through a query or body `workspaceId` may succeed: since AD-V1 that id is
        // never read, so the caller's own verified workspace answered. That is isolation as long as nothing of the
        // target's came back and nothing of the target's changed.
        const namesTargetByWorkspaceId =
          new URL(req.path, "http://conformance.local").searchParams.get("workspaceId") === targetWs ||
          (typeof req.body === "object" && req.body !== null && (req.body as { workspaceId?: unknown }).workspaceId === targetWs);
        if (!namesTargetByWorkspaceId) {
          throw new Error(
            `[CONF_TENANT_ISOLATION] Route ${req.method} ${req.path} returned ${res.status} when called by workspace ${callerWs} targeting ${targetWs}`,
          );
        }
        if (bodyText.includes(targetWs) || bodyText.includes("Confidential Item A") || (ownerBodyText.length > 0 && bodyText === ownerBodyText)) {
          throw new Error(
            `[CONF_TENANT_ISOLATION] Route ${req.method} ${req.path} leaked target workspace data to caller (status ${res.status}): ${bodyText}`,
          );
        }
        if ((await snapshotWorkspace(db, tables, targetWs)) !== targetBefore) {
          throw new Error(
            `[CONF_TENANT_ISOLATION] Route ${req.method} ${req.path} changed workspace ${targetWs}'s rows when called by workspace ${callerWs}`,
          );
        }
        continue;
      }

      expect([400, 403, 404]).toContain(res.status);
      expect(bodyText).not.toContain(targetWs);
    }

    if (testedCount === 0) {
      if (options.testRequests.length > 0 && globalRoutes.length > 0) return;
      throw new Error("[CONF_TENANT_ISOLATION] nothing to test: provide explicit routes/seed");
    }
    return;
  }

  // Auto-discover routes from app
  const appRoutes = (app as any).routes as Array<{ method: string; path: string }> | undefined;
  if (!appRoutes || appRoutes.length === 0) {
    throw new Error("[CONF_TENANT_ISOLATION] nothing to test: provide explicit routes/seed");
  }

  for (const route of appRoutes) {
    if (route.path.includes("*")) continue;
    if (isGlobalRoute(route.path)) continue;
    testedCount++;
    const pathAddressed = /:[a-zA-Z0-9_]+/.test(route.path);
    const path = route.path.replace(/:[a-zA-Z0-9_]+/g, `rec_${workspaceA}_1`);

    if (route.method === "GET") {
      const ownerUrl = path.includes("?")
        ? `${path}&workspaceId=${workspaceA}`
        : `${path}?workspaceId=${workspaceA}`;

      // Positive control: must succeed for owning workspace
      const ownerRes = await app.request(
        ownerUrl,
        {
          method: "GET",
          headers: { "x-workspace-id": workspaceA },
        },
        {
          DB: db,
          workspace: { id: workspaceA, role: "owner", suspended: false },
        },
      );

      if (ownerRes.status !== 200) {
        throw new Error(
          `[CONF_TENANT_ISOLATION] cannot confirm isolation: owning workspace request to GET ${ownerUrl} failed (status ${ownerRes.status})`,
        );
      }

      const url = path.includes("?")
        ? `${path}&workspaceId=${workspaceA}`
        : `${path}?workspaceId=${workspaceA}`;

      // Negative check: must fail for workspaceB
      const aBeforeGet = await snapshotWorkspace(db, tables, workspaceA);
      const res = await app.request(
        url,
        {
          method: "GET",
          headers: { "x-workspace-id": workspaceB },
        },
        {
          DB: db,
          workspace: { id: workspaceB, role: "member", suspended: false },
        },
      );

      const bodyText = await res.text();
      if (res.status === 200) {
        if (bodyText.includes(workspaceA) || bodyText.includes("Confidential Item A")) {
          throw new Error(
            `[CONF_TENANT_ISOLATION] Route GET ${url} leaked workspace A data to workspace B: ${bodyText}`,
          );
        }
        // A path-addressed probe (B asking for A's record by id) must be refused. A collection route that names A only
        // through `?workspaceId=` may answer with B's own data (AD-V1: the query is never read), if A's rows are untouched.
        if (pathAddressed || (await snapshotWorkspace(db, tables, workspaceA)) !== aBeforeGet) {
          throw new Error(
            `[CONF_TENANT_ISOLATION] Route GET ${url} returned 200 when called by workspace B targeting workspace A`,
          );
        }
        continue;
      }

      expect([400, 403, 404]).toContain(res.status);
      expect(bodyText).not.toContain(workspaceA);
    } else if (route.method === "POST" || route.method === "PUT") {
      const ownerPayload = {
        workspaceId: workspaceA,
        action: "test.action",
        targetType: "test_target",
        targetId: `rec_${workspaceA}_1`,
        name: "test item",
        title: "test title",
      };

      // Positive control: must succeed for owning workspace
      const ownerRes = await app.request(
        path,
        {
          method: route.method,
          headers: {
            "Content-Type": "application/json",
            "x-workspace-id": workspaceA,
          },
          body: JSON.stringify(ownerPayload),
        },
        {
          DB: db,
          workspace: { id: workspaceA, role: "owner", suspended: false },
        },
      );

      if (ownerRes.status !== 200 && ownerRes.status !== 201) {
        throw new Error(
          `[CONF_TENANT_ISOLATION] cannot confirm isolation: owning workspace request to ${route.method} ${path} failed (status ${ownerRes.status})`,
        );
      }

      // Negative check: workspace B naming A in the body must not touch A
      const aBefore = await snapshotWorkspace(db, tables, workspaceA);
      const res = await app.request(
        path,
        {
          method: route.method,
          headers: {
            "Content-Type": "application/json",
            "x-workspace-id": workspaceB,
          },
          body: JSON.stringify({ workspaceId: workspaceA }),
        },
        {
          DB: db,
          workspace: { id: workspaceB, role: "member", suspended: false },
        },
      );

      const bodyText = await res.text();
      if (res.status === 200 || res.status === 201) {
        // A path-addressed write (B acting on A's record by id) must be refused. A collection write that names A only
        // in the body may be accepted, but it must have run against B's own verified workspace: A's rows are unchanged
        // and nothing of A's came back.
        if (pathAddressed || (await snapshotWorkspace(db, tables, workspaceA)) !== aBefore || bodyText.includes(workspaceA)) {
          throw new Error(
            `[CONF_TENANT_ISOLATION] Route ${route.method} ${path} allowed workspace B to modify workspace A (status ${res.status})`,
          );
        }
        continue;
      }

      expect([400, 403, 404]).toContain(res.status);
      expect(bodyText).not.toContain(workspaceA);
    }
  }

  if (testedCount === 0) {
    if (appRoutes.length > 0 && globalRoutes.length > 0) return;
    throw new Error("[CONF_TENANT_ISOLATION] nothing to test: provide explicit routes/seed");
  }
}

export async function checkIdempotentWrite(options: ConformanceCheckOptions): Promise<void> {
  const { db, manifest } = options;
  const { tables } = await checkMigrationsUp(options);
  const app = buildApp(manifest, options);

  async function countTotalRows(): Promise<number> {
    let total = 0;
    for (const table of tables) {
      const countRes = await db.prepare(`SELECT count(*) AS cnt FROM ${table}`).first<{ cnt: number }>();
      total += countRes?.cnt ?? 0;
    }
    return total;
  }

  const writeReqs: WriteRequest[] = options.writeRequests ? [...options.writeRequests] : [];
  if (writeReqs.length === 0) {
    const appRoutes = (app as any).routes as Array<{ method: string; path: string }> | undefined;
    if (appRoutes) {
      for (const r of appRoutes) {
        if ((r.method === "POST" || r.method === "PUT") && !r.path.includes("*")) {
          writeReqs.push({
            method: r.method,
            path: r.path,
            headers: { "Content-Type": "application/json" },
            body: { workspaceId: "ws_conf_idemp", name: "idempotency-item" },
          });
        }
      }
    }
  }

  if (writeReqs.length === 0) {
    throw new Error("[CONF_IDEMPOTENT_WRITE] nothing to test: provide explicit routes/seed");
  }

  const idempotencyKey = options.idempotencyKey ?? "idemp_test_key_conf_1";

  for (const req of writeReqs) {
    const countBefore = await countTotalRows();

    const headers: Record<string, string> = {
      "Idempotency-Key": idempotencyKey,
      "x-workspace-id": "ws_conf_idemp",
      ...(req.headers ?? {}),
    };
    if (req.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

    const bodyStr = req.body ? JSON.stringify(req.body) : undefined;
    const path = req.path.replace(/:[a-zA-Z0-9_]+/g, "rec_ws_conf_idemp_1");

    const res1 = await app.request(
      path,
      { method: req.method, headers, body: bodyStr },
      { DB: db, workspace: { id: "ws_conf_idemp", role: "owner", suspended: false } },
    );

    const countAfter1 = await countTotalRows();
    const delta1 = countAfter1 - countBefore;

    // Second call with same Idempotency-Key
    const res2 = await app.request(
      path,
      { method: req.method, headers, body: bodyStr },
      { DB: db, workspace: { id: "ws_conf_idemp", role: "owner", suspended: false } },
    );

    const countAfter2 = await countTotalRows();
    const delta2 = countAfter2 - countAfter1;

    if (delta2 > 0) {
      throw new Error(
        `[CONF_IDEMPOTENT_WRITE] Replayed write to ${req.method} ${req.path} with Idempotency-Key caused ${delta2} additional row change(s)`,
      );
    }

    expect(delta2).toBe(0);
  }
}

export async function checkErrorContract(options: ConformanceCheckOptions): Promise<void> {
  const { db, manifest } = options;
  await checkMigrationsUp(options);
  const app = buildApp(manifest, options);

  const errorReqs: ErrorRequest[] = options.errorRequests ? [...options.errorRequests] : [];
  if (errorReqs.length === 0) {
    const appRoutes = (app as any).routes as Array<{ method: string; path: string }> | undefined;
    if (appRoutes) {
      for (const r of appRoutes) {
        if (!r.path.includes("*")) {
          if (r.method !== "GET" && r.method !== "HEAD") {
            // Trigger validation or json parse error
            errorReqs.push({
              method: r.method,
              path: r.path,
              headers: { "Content-Type": "application/json" },
              body: "invalid-json{",
            });
          }
          // Trigger missing workspace error
          errorReqs.push({
            method: r.method,
            path: r.path,
            headers: {},
            body: undefined,
          });
        }
      }
    }
  }

  if (errorReqs.length === 0) {
    throw new Error("[CONF_ERROR_CONTRACT] nothing to test: provide explicit routes/seed");
  }

  let tested4xxCount = 0;

  for (const req of errorReqs) {
    const method = req.method ?? "POST";
    const hasBody = method !== "GET" && method !== "HEAD";
    const path = req.path.replace(/:[a-zA-Z0-9_]+/g, "rec_conf_err_1");
    const res = await app.request(
      path,
      {
        method,
        headers: req.headers ?? {},
        body: hasBody ? (typeof req.body === "string" ? req.body : req.body ? JSON.stringify(req.body) : undefined) : undefined,
      },
      { DB: db },
    );

    if (res.status >= 400 && res.status < 500) {
      tested4xxCount++;
      let json: any;
      try {
        json = await res.json();
      } catch {
        throw new Error(
          `[CONF_ERROR_CONTRACT] Route ${req.method ?? "POST"} ${req.path} returned status ${res.status} with non-JSON body`,
        );
      }

      if (!json || typeof json.error !== "object" || json.error === null) {
        throw new Error(
          `[CONF_ERROR_CONTRACT] Route ${req.method ?? "POST"} ${req.path} returned status ${res.status} where body.error is not an object: ${JSON.stringify(json)}`,
        );
      }

      if (typeof json.error.code !== "string" || typeof json.error.message !== "string") {
        throw new Error(
          `[CONF_ERROR_CONTRACT] Route ${req.method ?? "POST"} ${req.path} returned status ${res.status} where body.error does not match { code: string, message: string }: ${JSON.stringify(json.error)}`,
        );
      }

      expect(typeof json.error.code).toBe("string");
      expect(typeof json.error.message).toBe("string");
    }
  }

  if (tested4xxCount === 0) {
    throw new Error("[CONF_ERROR_CONTRACT] nothing to test: provide explicit routes/seed");
  }
}

export async function checkSecretScope(options: ConformanceCheckOptions): Promise<void> {
  const { db, manifest } = options;
  await checkMigrationsUp(options);
  const app = buildApp(manifest, options);

  const allowed = new Set<string>(["DB"]);
  for (const b of options.allowedBindings ?? []) allowed.add(b);
  for (const s of secretNames(manifest)) allowed.add(s);
  if (Array.isArray(manifest.bindings)) {
    for (const b of manifest.bindings) allowed.add(b);
  } else if (manifest.bindings && typeof manifest.bindings === "object") {
    for (const b of Object.keys(manifest.bindings)) allowed.add(b);
  }

  const touchedProperties = new Set<string>();
  const proxyEnv = new Proxy({ DB: db, ...env }, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !prop.startsWith("__") && prop !== "then" && prop !== "constructor") {
        touchedProperties.add(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const scopeReqs: ScopeRequest[] = options.scopeRequests ? [...options.scopeRequests] : [];
  if (scopeReqs.length === 0) {
    const appRoutes = (app as any).routes as Array<{ method: string; path: string }> | undefined;
    if (appRoutes) {
      for (const r of appRoutes) {
        if (!r.path.includes("*")) {
          scopeReqs.push({
            method: r.method,
            path: r.path,
          });
        }
      }
    }
  }

  if (scopeReqs.length === 0) {
    throw new Error("[CONF_SECRET_SCOPE] nothing to test: provide explicit routes/seed");
  }

  for (const req of scopeReqs) {
    const path = req.path.replace(/:[a-zA-Z0-9_]+/g, "rec_conf_scope_1");
    try {
      await app.request(
        path,
        {
          method: req.method ?? "GET",
          headers: { "x-workspace-id": "ws_conf_scope", ...(req.headers ?? {}) },
          body: req.body ? JSON.stringify(req.body) : undefined,
        },
        proxyEnv,
      );
    } catch {
      // ignore route errors
    }
  }

  const undeclared = [...touchedProperties].filter((p) => !allowed.has(p));
  if (undeclared.length > 0) {
    throw new Error(
      `[CONF_SECRET_SCOPE] Route accessed undeclared binding(s) or secret(s): ${undeclared.join(", ")}`,
    );
  }

  expect(undeclared.length).toBe(0);
}

export function runBrickConformance(options: BrickConformanceOptions): void {
  // Validate skip reasons upfront
  if (options.skip) {
    for (const [check, reason] of Object.entries(options.skip)) {
      if (typeof reason !== "string" || reason.trim().length === 0) {
        throw new Error(`Skipped check ${check} requires a non-empty reason string`);
      }
    }
  }

  let manifest = options.manifest;
  let migrations = options.migrations;
  let brickId = options.manifest?.id ?? "unknown-brick";

  if (options.brickDir) {
    const normalizedId = options.brickDir.replace(/^(bricks\/|\.\/bricks\/)/, "").replace(/\/$/, "");
    brickId = normalizedId;
    const entry = (catalog.bricks as Record<string, { manifest: BrickManifestFile; files: Record<string, string> }>)[normalizedId];
    if (entry) {
      manifest = manifest ?? entry.manifest;
      migrations = migrations ?? entry.files;
    }
  }

  if (!manifest) {
    manifest = {
      manifestVersion: 2,
      kind: "brick",
      id: brickId,
      version: "0.0.0",
      trust: "first-party",
      isolation: "none",
      provides: [],
      requires: [],
      migrations: Object.keys(migrations ?? {}),
      routePrefixes: [],
      npmDependencies: {},
      settings: {},
      worker: { package: `@poc/${brickId}`, routes: [] },
    };
  }

  const checkOptions: ConformanceCheckOptions = {
    ...options,
    manifest,
    db: options.db ?? (env.DB as D1Like),
    migrations: migrations ?? {},
  };

  describe(`Brick Conformance: ${brickId}`, () => {
    if (options.skip?.CONF_MIGRATIONS_UP) {
      it.skip("CONF_MIGRATIONS_UP: skipped", () => {});
    } else {
      it("CONF_MIGRATIONS_UP: all migrations apply in order and tables have workspace_id", async () => {
        await checkMigrationsUp(checkOptions);
      });
    }

    if (options.skip?.CONF_TENANT_ISOLATION) {
      it.skip("CONF_TENANT_ISOLATION: skipped", () => {});
    } else {
      it("CONF_TENANT_ISOLATION: isolates tenant data across workspaces", async () => {
        await checkTenantIsolation(checkOptions);
      });
    }

    if (options.skip?.CONF_IDEMPOTENT_WRITE) {
      it.skip("CONF_IDEMPOTENT_WRITE: skipped", () => {});
    } else {
      it("CONF_IDEMPOTENT_WRITE: write routes with Idempotency-Key are idempotent", async () => {
        await checkIdempotentWrite(checkOptions);
      });
    }

    if (options.skip?.CONF_ERROR_CONTRACT) {
      it.skip("CONF_ERROR_CONTRACT: skipped", () => {});
    } else {
      it("CONF_ERROR_CONTRACT: 4xx responses match error contract structure", async () => {
        await checkErrorContract(checkOptions);
      });
    }

    if (options.skip?.CONF_SECRET_SCOPE) {
      it.skip("CONF_SECRET_SCOPE: skipped", () => {});
    } else {
      it("CONF_SECRET_SCOPE: routes touch only declared secrets and bindings", async () => {
        await checkSecretScope(checkOptions);
      });
    }

    it("records conformance tier evidence", (ctx) => {
      const skipped = Object.entries(options.skip ?? {}).map(([check, reason]) => ({
        check,
        reason: reason as string,
      }));
      attach(ctx.task, "tier-evidence", {
        id: brickId,
        kind: "brick",
        skipped,
      });
    });
  });
}
