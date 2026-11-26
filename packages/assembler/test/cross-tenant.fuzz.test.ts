// Cross-tenant attack suite (story 0.5, audit risk 15). It enumerates every real route of the assembled max-compatible
// app (from the Hono route table, not just the OpenAPI prefixes) and runs these attack classes against each one in
// workerd, judged by one oracle:
//
//   HEADER_B        Alice names workspace B in x-workspace-id (and three malformed multi-workspace header values).
//   QUERY_B         Alice, header A, adds ?workspaceId=B&workspace_id=B.
//   BODY_B          Alice, header A, smuggles workspaceId/workspace_id = B in the JSON body (POST/PUT/PATCH).
//   ID_GUESS        Alice, header A, fills path params with B's real row ids harvested from B's tenant tables.
//   ROLE_ESCALATION Carol, a plain `member` of A, calls each admin-class route.
//   UNAUTH          No x-test-user at all, on every route not on the public allow-list.
//   NOT_OPERATOR    Story 2.6: on every platform operator route (OPERATOR_CLASS), Alice (owner of A) and Carol (member of
//                   A) are refused with 403 NOT_PLATFORM_OPERATOR, with the suite's env (no PX_PLATFORM_OPERATORS, so
//                   nobody is an operator) and with an env naming someone else as the operator; the operator's own id
//                   with PX_PLATFORM_OPERATORS empty is refused the same way; an admin API key of A is refused (401: a key
//                   is no identity outside the workspace-guarded paths, or 403 API_KEY_FORBIDDEN). Nothing changes: no
//                   tenant row, no workspace's suspended state, no approval record.
//
// Violations that exist today and are not fixed yet live in attack-suite.known-failures.json, each tied to the story
// that fixes it. The suite fails on any violation not in that registry (NEW_FAILURE) and on any registry entry that no
// longer fails (STALE_ENTRY), so a fixing story must prune its entries. See docs/brick-audit.md.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { Hono } from "hono";
import { attach, record } from "@poc/harness";
import type { D1Like } from "@poc/sdk";
import { catalog } from "../catalog.generated.ts";
import { computeMaxCompatible } from "../../../scripts/max-compatible.ts";
import { generateOpenApiSpec } from "../src/openapi.ts";
import { compareWithRegistry, describeComparison, registryKeyOf as keyOf } from "../../../test/support/attack-registry.ts";
import type { RegistryEntry } from "../../../test/support/attack-registry.ts";
import knownFailuresFile from "./attack-suite.known-failures.json";
import { call, joinAsMember, resetAndMigrate } from "./support/assembled-app.ts";
import type { App } from "./support/assembled-app.ts";

interface HonoRoute {
  method: string;
  path: string;
  handler: { name?: string };
}

interface HonoLike {
  routes: HonoRoute[];
}

// The assembled entry's default export is `{ fetch, scheduled, queue }`, so the Hono instance (and its `routes` table)
// is not reachable from it. Capture it instead: wrap Hono.prototype.route while the entry module is first evaluated,
// keep every instance `route()` was called on, then restore the original method.
const routeCalls: Array<{ app: HonoLike; sub: HonoLike }> = [];
const honoProto = Hono.prototype as unknown as { route: (this: HonoLike, path: string, sub: HonoLike) => unknown };
const originalRoute = honoProto.route;
honoProto.route = function (this: HonoLike, path: string, sub: HonoLike) {
  routeCalls.push({ app: this, sub });
  return originalRoute.call(this, path, sub);
};
const entryLoaders = import.meta.glob("../../../out/max-compatible/src/index.ts") as Record<string, () => Promise<{ default: App }>>;
const entrySource = import.meta.glob("../../../out/max-compatible/src/index.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
let loadedEntry: { default: App } | undefined;
try {
  loadedEntry = await Object.values(entryLoaders)[0]?.();
} finally {
  honoProto.route = originalRoute;
}
const app = loadedEntry?.default;
const honoApp = routeCalls.map((c) => c.app).find((a) => a.routes.some((r) => r.path === "/healthz"));

const sql = import.meta.glob("../../../out/max-compatible/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const db = env.DB as unknown as D1Like;

const maxSet = computeMaxCompatible(catalog);
const maxBlueprint = {
  project: maxSet.project,
  bricks: maxSet.bricks,
  entities: [
    {
      name: "records",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "amount", type: "number" },
      ],
    },
  ],
};
const spec = generateOpenApiSpec(maxBlueprint, catalog);

// ---------------------------------------------------------------------------------------------------------------------
// Tenant tables and which brick owns each one
// ---------------------------------------------------------------------------------------------------------------------

/** Brick id from a migration file name such as `0005_audit-trail__0001_audit_trail.sql`. */
function brickOfMigration(file: string): string {
  const base = file.split("/").pop() ?? file;
  const brick = /^\d+_(.+?)__/.exec(base)?.[1] ?? "";
  return brick === "entity" ? "dynamic-entities" : brick;
}

function getTenantTables(): { tables: string[]; brickOfTable: Map<string, string> } {
  const globalTableNames = new Set<string>();
  for (const b of Object.values(catalog.bricks)) {
    if (Array.isArray(b.manifest.globalTables)) {
      for (const g of b.manifest.globalTables) {
        if (g.table) globalTableNames.add(g.table);
      }
    }
  }

  const tenantTables = new Set<string>();
  const brickOfTable = new Map<string, string>();
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_"]+)\s*\(([\s\S]*?)\)\s*;/gi;
  for (const [file, migSql] of Object.entries(sql)) {
    const stripped = migSql.replace(/--[^\r\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of stripped.matchAll(createTableRegex)) {
      const table = (match[1] ?? "").replace(/"/g, "");
      const body = match[2] ?? "";
      if (/\bworkspace_id\b/i.test(body) && !globalTableNames.has(table)) {
        tenantTables.add(table);
        brickOfTable.set(table, brickOfMigration(file));
      }
    }
  }
  return { tables: [...tenantTables].sort(), brickOfTable };
}

const { tables: tenantTables, brickOfTable } = getTenantTables();

type TableRows = Record<string, Array<Record<string, unknown>>>;

async function readTenantRows(workspaceId: string): Promise<TableRows> {
  const out: TableRows = {};
  for (const table of tenantTables) {
    try {
      const rows = await db.prepare(`SELECT * FROM "${table}" WHERE "workspace_id" = ? ORDER BY rowid`).bind(workspaceId).all<Record<string, unknown>>();
      out[table] = rows.results ?? [];
    } catch {
      // Table may not have been created or lack workspace_id
    }
  }
  return out;
}

async function snapshotTenantTables(workspaceId: string): Promise<string> {
  return JSON.stringify(await readTenantRows(workspaceId));
}

/** Primary-key columns per tenant table (PRAGMA table_info), falling back to `id`. Filled after the first migration. */
const pkColumns = new Map<string, string[]>();

async function loadPrimaryKeys(): Promise<void> {
  if (pkColumns.size > 0) return;
  for (const table of tenantTables) {
    let cols: string[] = [];
    try {
      const info = await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string; pk: number }>();
      cols = (info.results ?? []).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    } catch {
      // fall back below
    }
    pkColumns.set(table, cols.length > 0 ? cols : ["id"]);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Route enumeration
// ---------------------------------------------------------------------------------------------------------------------

interface RouteInfo {
  method: string;
  path: string;
  brick: string;
  /** Behind the host's workspaceMiddleware (from the app's own middleware table). */
  guarded: boolean;
  /** An OpenAPI path with no exact handler in the app (the spec documents some prefixes only); attacked for coverage. */
  specOnly?: boolean;
}

/** An `ALL` entry of the route table that is not attacked, with the reason. */
interface DroppedRoute {
  method: string;
  path: string;
  reason: string;
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("/")
    .map((seg) => {
      if (seg === "*") return ".*";
      if (seg.startsWith(":")) return "[^/]+";
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  // Hono's trailing "/*" also matches the bare prefix.
  return new RegExp(`^${escaped.replace(/\/\.\*$/, "(?:/.*)?")}$`);
}

/** Hono `:param{regex}` and `:param?` forms reduced to plain `:param`. */
function normalisePath(path: string): string {
  return path.replace(/(:[A-Za-z0-9_]+)\{[^}]*\}/g, "$1").replace(/(:[A-Za-z0-9_]+)\?/g, "$1");
}

function factoryToBrick(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [id, b] of Object.entries(catalog.bricks)) {
    const routes = (b.manifest as { worker?: { routes?: Array<{ factory?: string }> } }).worker?.routes ?? [];
    for (const r of routes) if (r.factory) map.set(r.factory, id);
  }
  return map;
}

function enumerateRoutes(h: HonoLike, source: string): { routes: RouteInfo[]; dropped: DroppedRoute[]; guards: RegExp[] } {
  // Brick of each sub-app, in mount order: `app.route("/api", createXRoutes(...))` lines of the emitted entry.
  const byFactory = factoryToBrick();
  const mountedFactories = [...source.matchAll(/app\.route\("\/api",\s*(\w+)\(/g)].map((m) => m[1] ?? "");
  const mainCalls = routeCalls.filter((c) => c.app === h);
  const brickOfRoute = new Map<string, string>();
  mainCalls.forEach((call, i) => {
    const brick = byFactory.get(mountedFactories[i] ?? "") ?? "unknown";
    for (const r of call.sub.routes) {
      if (r.method === "ALL") continue;
      const full = normalisePath(`/api${r.path === "/" ? "" : r.path}`);
      const key = `${r.method} ${full}`;
      if (!brickOfRoute.has(key)) brickOfRoute.set(key, brick);
    }
  });

  const guards = h.routes.filter((r) => r.method === "ALL" && r.handler?.name === "workspaceMiddleware").map((r) => patternToRegex(r.path));
  const seen = new Set<string>();
  const out: RouteInfo[] = [];
  const dropped: DroppedRoute[] = [];
  for (const r of h.routes) {
    // `app.use` middleware and `router.all` catch-alls are both registered as ALL. Neither is attacked here, but each
    // is listed with its reason: middleware (two-argument (c, next) functions) is not an endpoint, and the only
    // catch-all handler in max-compatible is core-auth's Better Auth `/api/auth/*`, which is public by design.
    if (r.method === "ALL") {
      const isMiddleware = (r.handler as { length?: number }).length === 2;
      const reason = isMiddleware
        ? `middleware (${r.handler?.name || "anonymous"}), not an endpoint`
        : r.path.startsWith("/api/auth/")
          ? "catch-all handler, public auth (core-auth Better Auth; sign-up/sign-in are public by design)"
          : "catch-all handler with no fixed path to attack";
      const k = `ALL ${r.path} ${reason}`;
      if (!seen.has(k)) {
        seen.add(k);
        dropped.push({ method: "ALL", path: r.path, reason });
      }
      continue;
    }
    const path = normalisePath(r.path);
    const key = `${r.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path, brick: brickOfRoute.get(key) ?? "host", guarded: guards.some((g) => g.test(path)) });
  }
  return { routes: out, dropped, guards };
}

const enumerated = honoApp ? enumerateRoutes(honoApp, Object.values(entrySource)[0] ?? "") : { routes: [], dropped: [], guards: [] };
const allRoutes: RouteInfo[] = enumerated.routes;

const specPathToHono = (p: string) => p.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1");

/** OpenAPI path + method pairs with no exact route in the app: attacked as well, so every documented path is attacked. */
const specOnlyRoutes: RouteInfo[] = Object.entries<any>(spec.paths).flatMap(([p, item]) =>
  ["get", "post", "put", "patch", "delete"]
    .filter((m) => Boolean(item?.[m]))
    .map((m) => ({ method: m.toUpperCase(), path: specPathToHono(p) }))
    .filter((r) => !allRoutes.some((a) => a.method === r.method && a.path === r.path))
    .map((r) => ({ ...r, brick: "openapi", guarded: enumerated.guards.some((g) => g.test(r.path)), specOnly: true })),
);

function paramsOf(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? "");
}

// ---------------------------------------------------------------------------------------------------------------------
// Attack configuration: admin-class routes and public routes
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Admin-class routes for ROLE_ESCALATION: a plain `member` must be refused (401/403) on every one. From the 0.5 plan:
 * every path under /api/admin, plan/subscription/SSO/webhook-subscription/flag writes, data-privacy erase/export, rbac
 * role write/assign, oauth-server authorize, workspace delete, and the 0.6 scope additions in docs/threat-model.md
 * (integration connect/disconnect/callback, asset delete, flag overrides, schedule create/toggle/delete, outbound
 * channels and send, AI prompt templates). Matched against the enumerated routes; an entry that matches nothing in
 * max-compatible (for example a brick that is not in the set) is listed in the report as unmounted.
 */
const ADMIN_CLASS: Array<{ method: string; pattern: RegExp; why: string }> = [
  { method: "*", pattern: /^\/api\/admin(\/|$)/, why: "admin console" },
  { method: "POST", pattern: /^\/api\/plans$/, why: "plan prices (risk 14)" },
  { method: "POST", pattern: /^\/api\/subscriptions\/change$/, why: "plan switch (risk 14)" },
  { method: "POST", pattern: /^\/api\/sso\/connections$/, why: "SSO connection create (risk 9)" },
  { method: "POST", pattern: /^\/api\/webhooks\/subscriptions$/, why: "webhook subscription create (risk 8)" },
  { method: "POST", pattern: /^\/api\/flags$/, why: "global flag definitions (B1)" },
  { method: "*", pattern: /^\/api\/flags\/:[^/]+\/overrides?$/, why: "flag overrides (B2)" },
  { method: "POST", pattern: /^\/api\/privacy\/(export|erasure)$/, why: "data-privacy export/erase (risks 2, 3)" },
  { method: "DELETE", pattern: /^\/api\/privacy\/workspace$/, why: "data-privacy workspace erase (risk 2)" },
  { method: "POST", pattern: /^\/api\/roles(\/|$)/, why: "rbac role write/assign" },
  { method: "PUT", pattern: /^\/api\/roles(\/|$)/, why: "rbac role write" },
  { method: "PATCH", pattern: /^\/api\/roles(\/|$)/, why: "rbac role write" },
  { method: "DELETE", pattern: /^\/api\/roles(\/|$)/, why: "rbac role delete/unassign" },
  { method: "POST", pattern: /^\/api\/policies(\/|$)/, why: "rbac policy write" },
  { method: "*", pattern: /^\/api\/oauth\/authorize$/, why: "oauth-server code issuance (risk 13)" },
  { method: "DELETE", pattern: /^\/api\/workspaces\/:[^/]+$/, why: "workspace delete" },
  { method: "GET", pattern: /^\/api\/integrations\/:[^/]+\/connect$/, why: "integration connect (A9)" },
  { method: "GET", pattern: /^\/api\/connect\/:[^/]+$/, why: "integration connect (A9)" },
  { method: "*", pattern: /^\/api\/integrations\/:[^/]+\/callback$/, why: "integration callback (A9)" },
  { method: "POST", pattern: /^\/api\/integrations\/:[^/]+\/disconnect$/, why: "integration disconnect (A9)" },
  { method: "DELETE", pattern: /^\/api\/assets\/:[^/]+$/, why: "asset delete (A19)" },
  { method: "POST", pattern: /^\/api\/schedules$/, why: "schedule create (B17)" },
  { method: "PATCH", pattern: /^\/api\/schedules\/:[^/]+(\/toggle)?$/, why: "schedule toggle (B17)" },
  { method: "DELETE", pattern: /^\/api\/schedules\/:[^/]+$/, why: "schedule delete (B17)" },
  { method: "POST", pattern: /^\/api\/messages\/(channels|send)$/, why: "outbound channels and send (B8)" },
  { method: "POST", pattern: /^\/api\/messages\/channels\/:[^/]+\/verify$/, why: "outbound sender verification (B8, story 2.4)" },
  { method: "PATCH", pattern: /^\/api\/messages\/channels\/:[^/]+$/, why: "outbound channel settings: workflowSendAllowed (B8, story 2.4)" },
  { method: "POST", pattern: /^\/api\/ai\/templates$/, why: "prompt template create (A6)" },
];

/**
 * Story 2.6: the platform operator routes. Only the user ids in PX_PLATFORM_OPERATORS may call them; no workspace role,
 * owner included, is enough. Every route of the platform-admin brick must match (checked in the coverage test).
 */
const OPERATOR_CLASS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^\/api\/platform\//, why: "platform operator console (story 2.6): PX_PLATFORM_OPERATORS only, fail closed" },
];

function operatorClassOf(route: RouteInfo): string | undefined {
  return OPERATOR_CLASS.find((o) => o.pattern.test(route.path))?.why;
}

/** An env that names an operator other than every attacker, so the check is not passing only because the list is empty. */
const OTHER_OPERATOR_ENV = { ...(env as unknown as Record<string, unknown>), PX_PLATFORM_OPERATORS: "olivia-operator" };
/** The operator's own id with the list empty: fail closed. */
const EMPTY_OPERATOR_ENV = { ...(env as unknown as Record<string, unknown>), PX_PLATFORM_OPERATORS: "" };

/**
 * Platform state the per-workspace snapshots do not cover: every workspace's suspended flag and reason, every approval
 * record, and every audit row of every workspace (the platform scope `_platform` and any third workspace included). A
 * missing table fails the read: the oracle never compares two "missing" markers.
 */
async function platformState(): Promise<string> {
  const read = async (sql: string) => (await db.prepare(sql).all()).results;
  return JSON.stringify([
    await read("SELECT id, suspended, suspended_reason FROM mw_workspaces ORDER BY id"),
    await read("SELECT * FROM pa_user_approvals ORDER BY user_id"),
    await read("SELECT * FROM audit_events ORDER BY workspace_id, rowid"),
  ]);
}

function adminClassOf(route: RouteInfo): string | undefined {
  return ADMIN_CLASS.find((a) => (a.method === "*" || a.method === route.method) && a.pattern.test(route.path))?.why;
}

/**
 * Routes that answer without a signed-in user by design, so UNAUTH does not attack them. Each has a reason; everything
 * else must refuse an anonymous caller with 401/403.
 */
const PUBLIC_ROUTES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/(healthz|readyz|openapi\.json)$/, reason: "health and OpenAPI endpoints, no tenant data" },
  { pattern: /^\/api\/auth(\/|$)/, reason: "core-auth sign-up/sign-in/session endpoints (Better Auth) are public by design" },
  { pattern: /^\/api\/webhooks\/(in|ingress)\//, reason: "webhook ingress is called by third parties and authenticated by signature" },
  { pattern: /^\/api\/(payments|checkout)\/webhook$/, reason: "payment provider webhooks (story 2.3) are called by the provider and authenticated by signature" },
  { pattern: /^\/api\/message-webhooks\/:[^/]+$/, reason: "outbound delivery-status webhooks (story 2.4) are called by the provider and authenticated by the channel's signature" },
  { pattern: /^\/api\/sso\/(discover|authorize|callback)(\/|$)/, reason: "public SSO login/callback" },
  { pattern: /^\/api\/users\/:[^/]+\/profile$/, reason: "user-profile public profile lookup by design (returns only public fields)" },
];

function publicReason(route: RouteInfo): string | undefined {
  return PUBLIC_ROUTES.find((p) => p.pattern.test(route.path))?.reason;
}


// ---------------------------------------------------------------------------------------------------------------------
// World: Alice owns A, Bob owns B, Carol is a plain member of A; both workspaces hold data in as many bricks as possible
// ---------------------------------------------------------------------------------------------------------------------

const B_MARKER = "bobsecret";
const A_MARKER = "alicedata";

interface IdBag {
  /** Every value of every column, by column name (for params such as `key`, `provider`, `user_id`). */
  byColumn: Map<string, string[]>;
  /** Primary-key values per tenant table. */
  pkByTable: Map<string, string[]>;
}

interface World {
  wsA: string;
  wsB: string;
  bRecordId: string;
  bSecrets: string[];
  aIds: IdBag;
  bIds: IdBag;
  seeded: { attempted: number; createdA: number; createdB: number };
  /** An admin API key of A (rich worlds only), for the NOT_OPERATOR class. */
  aKey?: string;
}

function emptyBag(): IdBag {
  return { byColumn: new Map(), pkByTable: new Map() };
}

function harvest(rows: TableRows): IdBag {
  const bag = emptyBag();
  for (const [table, tableRows] of Object.entries(rows)) {
    const pks = pkColumns.get(table) ?? ["id"];
    const pkVals: string[] = [];
    for (const row of tableRows) {
      for (const [col, val] of Object.entries(row)) {
        if (val === null || val === undefined || typeof val === "object") continue;
        const s = String(val);
        const list = bag.byColumn.get(col) ?? [];
        if (!list.includes(s)) list.push(s);
        bag.byColumn.set(col, list);
      }
      // Only single-column keys can fill a single path param.
      if (pks.length === 1) {
        const v = row[pks[0] ?? "id"];
        if (v !== null && v !== undefined && !pkVals.includes(String(v))) pkVals.push(String(v));
      }
    }
    if (pkVals.length > 0) bag.pkByTable.set(table, pkVals);
  }
  return bag;
}

function generateBody(schema: any, seed: string): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { seed };
  if (schema.$ref) {
    const refName = schema.$ref.replace("#/components/schemas/", "");
    const targetSchema = (spec.components?.schemas as any)?.[refName];
    return generateBody(targetSchema, seed);
  }
  const obj: Record<string, unknown> = {};
  if (schema.properties) {
    for (const [key, prop] of Object.entries<any>(schema.properties)) {
      if (prop.type === "string") obj[key] = `${key}-${seed}`;
      else if (prop.type === "number" || prop.type === "integer") obj[key] = 42;
      else if (prop.type === "boolean") obj[key] = true;
      else if (prop.type === "array") obj[key] = [];
      else if (prop.type === "object") obj[key] = {};
    }
  } else if (schema.additionalProperties) {
    obj.title = `test-${seed}`;
    obj.name = `name-${seed}`;
  }
  return obj;
}

/** A request body for a route: the OpenAPI schema when the spec has this exact path, plus common fields brick schemas ask for. */
function bodyFor(route: RouteInfo, seed: string): Record<string, unknown> {
  const specPath = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  const op = (spec.paths as any)[specPath]?.[route.method.toLowerCase()];
  const fromSpec = generateBody(op?.requestBody?.content?.["application/json"]?.schema, seed);
  const slug = seed.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 40);
  return {
    name: `name-${seed}`,
    title: `title-${seed}`,
    key: `key_${slug}`,
    slug: `slug-${slug}`,
    description: `description-${seed}`,
    content: `content-${seed}`,
    text: `text-${seed}`,
    body: `body-${seed}`,
    message: `message-${seed}`,
    subject: `subject-${seed}`,
    event: `event_${slug}`,
    email: `${slug}@example.com`,
    url: `https://example.com/${slug}`,
    amount: 42,
    value: 1,
    enabled: true,
    // Fields some brick create-schemas require (chat, documents, threads, jobs, scripts, domains, checkout, schedules).
    customerId: `customer-${slug}`,
    initialMessage: `hello-${seed}`,
    mimeType: "text/plain",
    rawContent: `raw-${seed}`,
    targetType: "record",
    targetId: `target-${slug}`,
    taskType: `task_${slug}`.slice(0, 60),
    payload: { note: seed },
    triggerEvent: `event_${slug}`.slice(0, 60),
    sourceCode: "export default () => 1;",
    hostname: `${slug.slice(0, 30)}.example.com`,
    lineItems: [{ description: `item-${seed}`, quantity: 1, unitAmountCents: 100 }],
    cronExpression: "*/5 * * * *",
    ...fromSpec,
  };
}

/** Routes never called while seeding: they would destroy the seeded data or are not tenant data. */
function skipWhenSeeding(route: RouteInfo): boolean {
  return (
    route.path.startsWith("/api/auth") ||
    route.path === "/api/workspaces" ||
    /erasure|erase|revoke|delete|sign-out/i.test(route.path)
  );
}

async function seedTenant(target: App, user: string, ws: string, marker: string): Promise<{ attempted: number; created: number }> {
  let attempted = 0;
  let created = 0;
  for (const route of allRoutes) {
    if (route.method !== "POST" || paramsOf(route.path).length > 0 || skipWhenSeeding(route)) continue;
    attempted += 1;
    try {
      const res = await call(target, "POST", route.path, { user, ws, body: bodyFor(route, `${marker}-${route.path.replace(/[^a-zA-Z0-9]/g, "")}`) });
      if (res.status >= 200 && res.status < 300) created += 1;
    } catch {
      // Seeding is best effort: a route that refuses a generated body simply holds no data for that tenant.
    }
  }
  return { attempted, created };
}

async function createWorkspace(user: string, name: string): Promise<string> {
  const res = await call(app!, "POST", "/api/workspaces", { user, body: { name } });
  expect(res.status).toBe(201);
  return (JSON.parse(res.text) as { workspace: { id: string } }).workspace.id;
}

async function seedWorld(options: { rich?: boolean } = {}): Promise<World> {
  await resetAndMigrate(db, sql);
  await loadPrimaryKeys();

  const wsA = await createWorkspace("alice", "Workspace A");
  const wsB = await createWorkspace("bob", "Workspace B");

  // Create a record in Workspace B
  const resRec = await call(app!, "POST", "/api/records", { user: "bob", ws: wsB, body: { title: "secret-bob-records", amount: 999 } });
  expect(resRec.status).toBe(201);
  const recJson = JSON.parse(resRec.text) as { item?: { id: string }; id?: string };
  const bRecordId = recJson.item?.id ?? recJson.id ?? "rec_b_seed";

  const seeded = { attempted: 0, createdA: 0, createdB: 0 };
  if (options.rich) {
    // Carol joins A as a plain member through the real invite flow.
    await joinAsMember(app!, wsA, "alice", "carol");

    const a = await seedTenant(app!, "alice", wsA, A_MARKER);
    const b = await seedTenant(app!, "bob", wsB, B_MARKER);
    seeded.attempted = b.attempted;
    seeded.createdA = a.created;
    seeded.createdB = b.created;
  }
  let aKey: string | undefined;
  if (options.rich) {
    const minted = await call(app!, "POST", "/api/api-keys", { user: "alice", ws: wsA, body: { name: "fuzz-key", role: "admin" } });
    if (minted.status === 201) aKey = (JSON.parse(minted.text) as { rawKey: string }).rawKey;
  }

  const aIds = harvest(await readTenantRows(wsA));
  const bIds = harvest(await readTenantRows(wsB));
  // B's primary keys count as secrets when they are long enough not to match by accident (no small integers).
  const bPkSecrets = [...bIds.pkByTable.values()].flat().filter((v) => v.length >= 8);
  const bSecrets = [...new Set([wsB, "Workspace B", "secret-bob-records", bRecordId, B_MARKER, ...bPkSecrets])];
  return { wsA, wsB, bRecordId, bSecrets, aIds, bIds, seeded, ...(aKey ? { aKey } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Path-param filling
// ---------------------------------------------------------------------------------------------------------------------

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const singular = (s: string) => s.replace(/-/g, "_").replace(/ies$/, "y").replace(/s$/, "");

/** Candidate values for one path param, best first: column-name match, then tables named like the path segment, then the owner brick's keys. */
function candidatesFor(route: RouteInfo, param: string, bag: IdBag, ws: string): string[] {
  const segs = route.path.split("/");
  const idx = segs.indexOf(`:${param}`);
  const before = idx > 0 ? (segs[idx - 1] ?? "") : "";
  const out: string[] = [];
  const add = (vals: string[] | undefined) => {
    for (const v of vals ?? []) if (!out.includes(v)) out.push(v);
  };
  if (param === "workspaceId" || (param === "id" && (before === "workspaces" || before === "tenants"))) add([ws]);
  if (param !== "id") {
    add(bag.byColumn.get(snake(param)));
    add(bag.byColumn.get(param));
  }
  const stems = [singular(before), param.endsWith("Id") ? snake(param.slice(0, -2)) : ""].filter((s) => s.length > 1);
  const ownerTables = [...bag.pkByTable.keys()].filter((t) => brickOfTable.get(t) === route.brick);
  const otherTables = [...bag.pkByTable.keys()].filter((t) => brickOfTable.get(t) !== route.brick);
  for (const t of [...ownerTables, ...otherTables]) if (stems.some((s) => t.includes(s))) add(bag.pkByTable.get(t));
  for (const t of ownerTables) add(bag.pkByTable.get(t));
  // An id-like param with nothing better gets any of the tenant's keys; a name-like param (provider, key, slug)
  // only gets values from a matching column, because a random id there tests nothing.
  if (param === "id" || param.endsWith("Id")) for (const t of otherTables) add(bag.pkByTable.get(t));
  return out;
}

const MAX_GUESSES = 3;

/** Concrete paths with params filled from `bag`; an empty list when some param has no candidate at all. */
function fillPaths(route: RouteInfo, bag: IdBag, ws: string, maxGuesses: number): string[] {
  const params = paramsOf(route.path);
  if (params.length === 0) return [route.path.replace(/\*/g, "probe")];
  const cands = params.map((p) => candidatesFor(route, p, bag, ws));
  if (cands.some((c) => c.length === 0)) return [];
  const width = Math.min(maxGuesses, Math.max(...cands.map((c) => c.length)));
  const paths: string[] = [];
  for (let i = 0; i < width; i += 1) {
    let path = route.path;
    params.forEach((p, j) => {
      const list = cands[j] ?? [];
      path = path.replace(`:${p}`, encodeURIComponent(list[i % list.length] ?? ""));
    });
    path = path.replace(/\*/g, "probe");
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** One concrete path for attacks made from inside A: A's own ids when there are any, otherwise a placeholder. */
function ownPath(route: RouteInfo, world: World): string {
  return (
    fillPaths(route, world.aIds, world.wsA, 1)[0] ??
    route.path.replace(/:([A-Za-z0-9_]+)/g, (_m, p: string) => (p === "workspaceId" || p === "id" ? world.wsA : `missing-${p}`)).replace(/\*/g, "probe")
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------------------------------------------------

type Attack = "HEADER_B" | "QUERY_B" | "BODY_B" | "ID_GUESS" | "ROLE_ESCALATION" | "UNAUTH" | "NOT_OPERATOR";
const ATTACKS: Attack[] = ["HEADER_B", "QUERY_B", "BODY_B", "ID_GUESS", "ROLE_ESCALATION", "UNAUTH", "NOT_OPERATOR"];

interface Violation {
  method: string;
  route: string;
  attack: Attack;
  detail: string;
}

interface Observation {
  status: number;
  body: string;
  /** Everything the attacker sent (URL and body): values the attacker already knows are not a leak when echoed back. */
  sent: string;
  bBefore: string;
  bAfter: string;
  aBefore?: string;
  aAfter?: string;
  /** NOT_OPERATOR: platform state (suspension flags, approvals) before and after. */
  platformBefore?: string;
  platformAfter?: string;
  /** NOT_OPERATOR: the request carried an API key. */
  viaKey?: boolean;
}

const DENIAL = [400, 401, 403, 404];

/**
 * One oracle for every attack class. Returns violation details (empty when the request was safe):
 * - every class: the body must not contain a B secret the attacker did not send, and B's tenant rows must be unchanged;
 * - ID_GUESS: the status must also be a denial (400/401/403/404);
 * - ROLE_ESCALATION: the status must be 401/403 and A's tenant rows unchanged;
 * - ROLE_ESCALATION and UNAUTH also accept 404 on a spec-only OpenAPI path (there is no handler to reach);
 * - UNAUTH: the status must be 401/403 (400 only for "Missing workspace context" on a guarded route).
 * - HEADER_B: on a guarded route (behind workspaceMiddleware) the status must be a denial (400/401/403/404), since
 *   Alice is not a member of B; on an unguarded route the header is ignored and the leak and mutation checks decide.
 * QUERY_B/BODY_B may answer 2xx (the header's own workspace wins); the leak and mutation checks decide.
 */
function judge(attack: Attack, route: RouteInfo, obs: Observation, secrets: string[]): string[] {
  const problems: string[] = [];
  if (attack === "HEADER_B" && route.guarded && !DENIAL.includes(obs.status)) problems.push(`status ${obs.status} not in {400, 401, 403, 404} on a guarded route`);
  // Story 2.4: a provider status webhook answers an id it cannot match with 200 "ignored" (so the provider stops
  // retrying) and changes nothing; the leak and mutation checks below still apply to it.
  const ignoredWebhook = route.path === "/api/message-webhooks/:channelId" && obs.status === 200 && /"status":"ignored"/.test(obs.body) && /"updated":0/.test(obs.body);
  if (attack === "ID_GUESS" && !DENIAL.includes(obs.status) && !ignoredWebhook) problems.push(`status ${obs.status} not in {400, 401, 403, 404}`);
  // A spec-only path has no handler, so the router's 404 is the only answer it can give; it serves no data.
  const noHandler = obs.status === 404 && route.specOnly === true;
  if (attack === "ROLE_ESCALATION" && ![401, 403].includes(obs.status) && !noHandler) problems.push(`member got status ${obs.status}, expected 401/403`);
  if (attack === "NOT_OPERATOR" && obs.viaKey) {
    if (obs.status !== 401 && !(obs.status === 403 && /"code":"API_KEY_FORBIDDEN"/.test(obs.body))) problems.push(`API key got status ${obs.status}, expected 401 or 403 API_KEY_FORBIDDEN`);
  } else if (attack === "NOT_OPERATOR" && (obs.status !== 403 || !/"code":"NOT_PLATFORM_OPERATOR"/.test(obs.body))) {
    problems.push(`non-operator got status ${obs.status}, expected 403 NOT_PLATFORM_OPERATOR`);
  }
  if (attack === "NOT_OPERATOR" && obs.platformAfter !== obs.platformBefore) problems.push("workspace suspension, approval or audit records changed");
  if (attack === "UNAUTH") {
    const missingCtx = obs.status === 400 && route.guarded && /missing workspace context/i.test(obs.body);
    if (![401, 403].includes(obs.status) && !missingCtx && !noHandler) problems.push(`anonymous caller got status ${obs.status}, expected 401/403`);
  }
  for (const secret of secrets) {
    if (secret && !obs.sent.includes(secret) && obs.body.includes(secret)) {
      problems.push(`body leaked B secret "${secret}"`);
      break;
    }
  }
  if (obs.bAfter !== obs.bBefore) problems.push("workspace B tenant rows changed");
  if ((attack === "ROLE_ESCALATION" || attack === "NOT_OPERATOR") && obs.aBefore !== undefined && obs.aAfter !== obs.aBefore) problems.push("workspace A tenant rows changed");
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// Attack runner
// ---------------------------------------------------------------------------------------------------------------------

interface RouteResult {
  route: string;
  method: string;
  cases: number;
  failures: string[];
}

interface SuiteResult {
  violations: Violation[];
  results: RouteResult[];
  cases: number;
  casesByAttack: Record<Attack, number>;
  notAttacked: Array<{ method: string; route: string; attack: Attack | "*"; reason: string }>;
}

/** Run order inside one class: DELETEs last (they remove what other routes read), workspace delete very last. */
function runOrder(routes: RouteInfo[]): RouteInfo[] {
  const rank = (r: RouteInfo) => (r.method === "DELETE" ? (/^\/api\/workspaces\/:[^/]+$/.test(r.path) ? 2 : 1) : 0);
  return routes.map((r, i) => ({ r, i })).sort((x, y) => rank(x.r) - rank(y.r) || x.i - y.i).map((x) => x.r);
}

const MUTATING = new Set(["POST", "PUT", "PATCH"]);

async function runAttackClass(target: App, attack: Attack, routes: RouteInfo[], world: World, result: SuiteResult): Promise<void> {
  const resultFor = new Map<string, RouteResult>();
  const routeResult = (route: RouteInfo): RouteResult => {
    const key = `${route.method} ${route.path}`;
    let r = resultFor.get(key) ?? result.results.find((x) => `${x.method} ${x.route}` === key);
    if (!r) {
      r = { route: route.path, method: route.method, cases: 0, failures: [] };
      result.results.push(r);
    }
    resultFor.set(key, r);
    return r;
  };
  const skip = (route: RouteInfo, reason: string) => result.notAttacked.push({ method: route.method, route: route.path, attack, reason });

  let bSnap = await snapshotTenantTables(world.wsB);
  const watchesA = attack === "ROLE_ESCALATION" || attack === "NOT_OPERATOR";
  let aSnap = watchesA ? await snapshotTenantTables(world.wsA) : undefined;

  for (const route of runOrder(routes)) {
    type Req = { path: string; user?: string; ws?: string; body?: unknown; env?: unknown; headers?: Record<string, string> };
    const reqs: Req[] = [];
    const mutating = MUTATING.has(route.method);
    const seed = `${A_MARKER}-${attack}-${route.path.replace(/[^a-zA-Z0-9]/g, "")}`;
    const body = mutating ? bodyFor(route, seed) : undefined;

    if (attack === "HEADER_B") {
      const path = fillPaths(route, world.bIds, world.wsB, 1)[0] ?? ownPath(route, world);
      for (const ws of [world.wsB, `${world.wsA}, ${world.wsB}`, `${world.wsA},${world.wsB}`, `${world.wsB} ${world.wsA}`]) {
        reqs.push({ path, user: "alice", ws, body });
      }
    } else if (attack === "QUERY_B") {
      const path = ownPath(route, world);
      const join = path.includes("?") ? "&" : "?";
      reqs.push({ path: `${path}${join}workspaceId=${world.wsB}&workspace_id=${world.wsB}`, user: "alice", ws: world.wsA, body });
    } else if (attack === "BODY_B") {
      if (!mutating) continue;
      reqs.push({ path: ownPath(route, world), user: "alice", ws: world.wsA, body: { ...body, workspaceId: world.wsB, workspace_id: world.wsB, workspace: world.wsB, id: world.bRecordId } });
    } else if (attack === "ID_GUESS") {
      if (paramsOf(route.path).length === 0) continue;
      const paths = fillPaths(route, world.bIds, world.wsB, MAX_GUESSES);
      if (paths.length === 0) {
        skip(route, "no B row id fits every path param after seeding");
        continue;
      }
      for (const path of paths) reqs.push({ path, user: "alice", ws: world.wsA, body });
    } else if (attack === "ROLE_ESCALATION") {
      if (!adminClassOf(route)) continue;
      reqs.push({ path: ownPath(route, world), user: "carol", ws: world.wsA, body });
    } else if (attack === "NOT_OPERATOR") {
      if (!operatorClassOf(route)) continue;
      // A's own ids (the attacker's own workspace), so nothing but the operator check stands in the way.
      const path = ownPath(route, world);
      for (const user of ["alice", "carol"]) {
        reqs.push({ path, user, ws: world.wsA, body });
        reqs.push({ path, user, ws: world.wsA, body, env: OTHER_OPERATOR_ENV });
      }
      reqs.push({ path, user: "olivia-operator", ws: world.wsA, body, env: EMPTY_OPERATOR_ENV });
      expect(world.aKey, "the rich world mints an admin API key of A").toBeDefined();
      reqs.push({ path, body, env: OTHER_OPERATOR_ENV, headers: { "x-api-key": world.aKey! } });
    } else if (attack === "UNAUTH") {
      const why = publicReason(route);
      if (why) {
        skip(route, why);
        continue;
      }
      const path = fillPaths(route, world.bIds, world.wsB, 1)[0] ?? ownPath(route, world);
      reqs.push({ path, ws: world.wsB, body });
    }

    const rr = routeResult(route);
    let changed = false;
    for (const req of reqs) {
      rr.cases += 1;
      result.cases += 1;
      result.casesByAttack[attack] += 1;
      let status = 0;
      let text = "";
      const platformBefore = attack === "NOT_OPERATOR" ? await platformState() : undefined;
      try {
        ({ status, text } = await call(target, route.method, req.path, req));
      } catch (err) {
        status = 500;
        text = `request threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      const bAfter = await snapshotTenantTables(world.wsB);
      const aAfter = aSnap !== undefined ? await snapshotTenantTables(world.wsA) : undefined;
      const problems = judge(attack, route, {
        status,
        body: text,
        sent: `${req.path} ${req.ws ?? ""} ${JSON.stringify(req.body ?? "")}`,
        bBefore: bSnap,
        bAfter,
        aBefore: aSnap,
        aAfter,
        platformBefore,
        platformAfter: attack === "NOT_OPERATOR" ? await platformState() : undefined,
        viaKey: req.headers?.["x-api-key"] !== undefined,
      }, world.bSecrets);
      if (problems.length > 0) {
        const detail = `${req.path}: ${problems.join("; ")}`;
        result.violations.push({ method: route.method, route: route.path, attack, detail });
        rr.failures.push(`[${attack}] ${route.method} ${detail}`);
      }
      if (bAfter !== bSnap || (aSnap !== undefined && aAfter !== aSnap)) changed = true;
      bSnap = bAfter;
      aSnap = aAfter;
    }
    // A request that changed tenant rows (for example a member erasing A's data) would make every later route in this
    // class pass or fail for the wrong reason, so the world is seeded again before the next route.
    if (changed) {
      Object.assign(world, await seedWorld({ rich: true }));
      bSnap = await snapshotTenantTables(world.wsB);
      aSnap = watchesA ? await snapshotTenantTables(world.wsA) : undefined;
    }
  }
}

function emptyResult(): SuiteResult {
  return {
    violations: [],
    results: [],
    cases: 0,
    casesByAttack: { HEADER_B: 0, QUERY_B: 0, BODY_B: 0, ID_GUESS: 0, ROLE_ESCALATION: 0, UNAUTH: 0, NOT_OPERATOR: 0 },
    notAttacked: [],
  };
}

/** Runs the given attack classes against `routes` of `target`, each class on a freshly seeded world. */
async function runAttackSuite(target: App, routes: RouteInfo[], attacks: Attack[] = ATTACKS, world?: World): Promise<SuiteResult> {
  const result = emptyResult();
  for (const attack of attacks) {
    const w = world ?? (await seedWorld({ rich: true }));
    await runAttackClass(target, attack, routes, w, result);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Known-failures registry
// ---------------------------------------------------------------------------------------------------------------------

const STORIES = new Set(["0.6", "0.7", "0.9", "0.10", "0.11", "0.14", "1.4"]);
const registry: RegistryEntry[] = (knownFailuresFile as { entries: RegistryEntry[] }).entries;

// The registry comparison (compareWithRegistry, describeComparison) is shared with the control-plane attack suite
// (apps/studio-api/test/control-plane-attack.test.ts); it lives in test/support/attack-registry.ts.

// ---------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------

const LEAKY_ROUTE: RouteInfo = { method: "GET", path: "/api/fixture-leaky/:id", brick: "dynamic-entities", guarded: false };

function leakyFixtureApp(): App {
  // A test-only fixture route that deliberately omits the workspace predicate
  const fixtureApp = new Hono();
  fixtureApp.get("/api/fixture-leaky/:id", async (c) => {
    // Intentionally unscoped: queries by id only without workspace_id
    const row = await db.prepare('SELECT * FROM "ent_records" WHERE "id" = ?').bind(c.req.param("id")).first();
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ item: row });
  });
  return fixtureApp;
}

describe("cross-tenant fuzz over every assembled route", () => {
  test("setup step produced emitted entry and tenant tables", () => {
    expect(app, "out/max-compatible/src/index.ts must exist and export default app").toBeDefined();
    expect(honoApp, "the assembled Hono app must be captured so its route table can be enumerated").toBeDefined();
    expect(tenantTables.length, "must have discovered tenant tables in max-compatible").toBeGreaterThan(10);
    expect(allRoutes.length, "must have enumerated the assembled app's routes").toBeGreaterThan(50);
    expect(allRoutes.filter((r) => r.brick === "unknown"), "every mounted sub-app must map to a catalog brick").toEqual([]);
  });

  test("AC2 — deliberately unscoped handler is caught by the fuzz harness and names the route", async () => {
    const world = await seedWorld();
    const fixtureApp = leakyFixtureApp();

    // Alice requests Bob's record through the unscoped route: the leak must be caught by the oracle.
    const before = await snapshotTenantTables(world.wsB);
    const res = await call(fixtureApp, "GET", `/api/fixture-leaky/${world.bRecordId}`, { user: "alice", ws: world.wsA });
    const problems = judge("ID_GUESS", LEAKY_ROUTE, {
      status: res.status,
      body: res.text,
      sent: `/api/fixture-leaky/${world.bRecordId} ${world.wsA}`,
      bBefore: before,
      bAfter: await snapshotTenantTables(world.wsB),
    }, world.bSecrets);
    expect(problems.length).toBeGreaterThan(0);

    // SEEDED_LEAK: the same route through the attack runner (ID_GUESS with B's harvested ids, and UNAUTH) is reported
    // by name, and since it is not in the registry it is a NEW_FAILURE that would fail the suite.
    const suite = await runAttackSuite(fixtureApp, [LEAKY_ROUTE], ["ID_GUESS", "UNAUTH"], world);
    const named = suite.violations.filter((v) => v.method === "GET" && v.route === "/api/fixture-leaky/:id");
    expect(named.map((v) => v.attack)).toContain("ID_GUESS");
    expect(named.some((v) => /leaked B secret|status 200/.test(v.detail))).toBe(true);
    const comparison = compareWithRegistry(suite.violations, registry);
    expect(describeComparison(comparison).join("\n")).toMatch(/NEW_FAILURE GET \/api\/fixture-leaky\/:id ID_GUESS/);
  });

  test("registry comparison reports NEW_FAILURE and STALE_ENTRY", () => {
    const fake: Violation = { method: "GET", route: "/api/fake/:id", attack: "ID_GUESS", detail: "/api/fake/x: status 200 not in {400, 401, 403, 404}" };
    const fakeEntry: RegistryEntry = { method: "POST", route: "/api/fake-fixed", attack: "BODY_B", story: "0.6", reason: "fixture entry" };
    const c = compareWithRegistry([fake, fake], [fakeEntry]);
    expect(c.newFailures).toEqual([fake]);
    expect(c.staleEntries).toEqual([fakeEntry]);
    expect(describeComparison(c)).toEqual([
      `NEW_FAILURE GET /api/fake/:id ID_GUESS: ${fake.detail}`,
      "STALE_ENTRY remove fixed entry POST /api/fake-fixed BODY_B (story 0.6) from attack-suite.known-failures.json",
    ]);
    // A violation that matches an entry is known, not new; the entry is not stale.
    const matched = compareWithRegistry([fake], [{ ...fakeEntry, method: "GET", route: "/api/fake/:id", attack: "ID_GUESS" }]);
    expect(matched.newFailures).toEqual([]);
    expect(matched.staleEntries).toEqual([]);
    expect(matched.known).toHaveLength(1);
  });

  test("registry entries name a fixing story, a reason, a real attack and a concrete route", () => {
    const seen = new Set<string>();
    for (const e of registry) {
      const where = keyOf(e);
      expect(ATTACKS, where).toContain(e.attack);
      expect(["GET", "POST", "PUT", "PATCH", "DELETE"], where).toContain(e.method);
      expect(e.route, where).toMatch(/^\/[^*]*$/);
      expect(STORIES.has(e.story) || /^PROPOSED-\d+$/.test(e.story), `${where}: story ${e.story}`).toBe(true);
      expect(e.reason.trim().length, where).toBeGreaterThan(0);
      expect(e.reason, where).not.toMatch(/[\r\n]/);
      expect(seen.has(where), `${where} is listed twice`).toBe(false);
      seen.add(where);
    }
  });

  test(
    "AC1 & AC3 — fuzz covers 100% of paths in generateOpenApiSpec",
    async ({ task }) => {
      expect.hasAssertions();

      // AC1: every OpenAPI path is a real route of the app or the prefix of one, so attacking the enumerated routes
      // covers every documented path.
      const totalPaths = Object.keys(spec.paths).length;
      const suite = await runAttackSuite(app!, [...allRoutes, ...specOnlyRoutes]);
      for (const d of enumerated.dropped) suite.notAttacked.push({ method: d.method, route: d.path, attack: "*", reason: d.reason });
      // AC1: an OpenAPI path counts as covered only when that exact path (with {x} mapped to :x) was attacked.
      const attackedPaths = new Set(suite.results.filter((r) => r.cases > 0).map((r) => r.route));
      const coveredPaths = Object.keys(spec.paths).filter((p) => attackedPaths.has(specPathToHono(p)));
      expect(coveredPaths.length).toBe(totalPaths);
      const comparison = compareWithRegistry(suite.violations, registry);
      const problems = describeComparison(comparison);
      const adminRoutes = allRoutes.filter((r) => adminClassOf(r));
      // Story 2.6: every platform-admin route is in the operator class, and the class was attacked.
      const operatorRoutes = allRoutes.filter((r) => operatorClassOf(r));
      const platformRoutes = allRoutes.filter((r) => r.brick === "platform-admin");
      expect(platformRoutes.length, "platform-admin is in max-compatible").toBeGreaterThanOrEqual(10);
      expect(platformRoutes.filter((r) => !operatorClassOf(r)), "platform-admin routes outside OPERATOR_CLASS").toEqual([]);
      expect(suite.casesByAttack.NOT_OPERATOR).toBe(operatorRoutes.length * 6);
      const unmountedAdmin = ADMIN_CLASS.filter((a) => !allRoutes.some((r) => (a.method === "*" || a.method === r.method) && a.pattern.test(r.path))).map(
        (a) => `${a.method} ${a.pattern.source} (${a.why})`,
      );

      const fuzzReport = {
        routeCount: totalPaths,
        honoRouteCount: allRoutes.length,
        specOnlyRoutes: specOnlyRoutes.map((r) => `${r.method} ${r.path}`),
        cases: suite.cases,
        casesByAttack: suite.casesByAttack,
        attacks: ATTACKS,
        // Failures outside the registry plus stale registry entries: must be 0.
        failures: problems.length,
        knownFailures: comparison.known.length,
        violations: suite.violations.length,
        adminClassRoutes: adminRoutes.map((r) => `${r.method} ${r.path}`),
        adminClassNotMounted: unmountedAdmin,
        operatorClassRoutes: operatorRoutes.map((r) => `${r.method} ${r.path}`),
        publicRoutes: allRoutes.filter((r) => publicReason(r)).map((r) => ({ route: `${r.method} ${r.path}`, reason: publicReason(r) })),
        notAttacked: suite.notAttacked,
        problems,
        routes: suite.results,
      };

      attach(task, "cross-tenant-fuzz", fuzzReport);
      record(task, {
        id: "UC6.4",
        checks: {
          coversAllRoutes: coveredPaths.length === totalPaths,
          crossTenantIsolated: problems.length === 0,
        },
      });

      expect(problems).toEqual([]);
    },
    600_000,
  );
});
