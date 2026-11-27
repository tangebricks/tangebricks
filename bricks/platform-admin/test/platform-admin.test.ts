// Story 2.6: the platform-admin brick in workerd, against the real migrations of the bricks whose capabilities it is
// handed (audit-trail's auditRecorder, credit-wallet's walletCharger, feature-flags' flagOverrides) and the sdk's
// setWorkspaceSuspended. Operators are the user ids in PX_PLATFORM_OPERATORS; nobody else, a workspace owner included,
// gets past the gate, and every change leaves an audit row or is not applied.
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { API_KEY_AUTHENTICATION, API_KEY_CREATOR_VAR, AUTHENTICATED_BY_VAR, applyMigration, setWorkspaceSuspended } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { auditRecorder } from "../../audit-trail/src/index.ts";
import { flagOverrides } from "../../feature-flags/src/index.ts";
import { walletCharger } from "../../credit-wallet/src/index.ts";
import * as platformAdmin from "../src/index.ts";
import { PLATFORM_AUDIT_SCOPE, createPlatformAdminRoutes, requireApprovedUser } from "../src/index.ts";
import type { PlatformAdminRoutesOptions } from "../src/index.ts";
import paMigration from "../migrations/0001_platform_admin.sql?raw";
import mwMigration from "../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import auditMigration from "../../audit-trail/migrations/0001_audit_trail.sql?raw";
import auditMigration0002 from "../../audit-trail/migrations/0002_capability_rows.sql?raw";
import flagsMigration from "../../feature-flags/migrations/0001_feature_flags.sql?raw";
import wallet0001 from "../../credit-wallet/migrations/0001_credit_wallet.sql?raw";
import wallet0002 from "../../credit-wallet/migrations/0002_workspace_scoped_idempotency.sql?raw";
import wallet0003 from "../../credit-wallet/migrations/0003_order_currency.sql?raw";
import wallet0004 from "../../credit-wallet/migrations/0004_milli_credits.sql?raw";
import manifestJson from "../brick.manifest.json";
import routesSource from "../src/routes.ts?raw";
import approvalsSource from "../src/approvals.ts?raw";

const db = env.DB as unknown as D1Like;
const OPERATOR = "olivia-operator";
const OPERATOR_ENV = { DB: db, PX_PLATFORM_OPERATORS: `someone-else, ${OPERATOR}` };
const WS_A = "ws_pa_alpha";
const WS_B = "ws_pa_beta";

const TABLES = [
  "pa_user_approvals",
  "audit_events",
  "flag_overrides",
  "flag_definitions",
  "credit_ledger",
  "credit_orders",
  "credit_wallets",
  "credit_action_costs",
  "mw_invites",
  "mw_members",
  "mw_workspaces",
];

async function reset(): Promise<void> {
  for (const t of TABLES) await db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  for (const sql of [mwMigration, auditMigration, auditMigration0002, flagsMigration, wallet0001, wallet0002, wallet0003, wallet0004, paMigration])
    await applyMigration(db, sql);
  for (const [id, owner] of [
    [WS_A, "alice"],
    [WS_B, "bob"],
  ] as const) {
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, ?)").bind(id, `Workspace ${id}`, owner).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, owner).run();
  }
}

const FULL: PlatformAdminRoutesOptions = {
  maxGrantCredits: 1000,
  requireUserApproval: false,
  auditRecorder,
  charger: walletCharger,
  flagOverrides,
  flagOverridesAllowed: true,
};

/** The brick behind a stub identity: `x-test-user` signs in; `x-test-api-key: 1` marks the request as API-key authenticated. */
function appWith(options: PlatformAdminRoutesOptions = FULL): Hono {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    const uid = c.req.header("x-test-user");
    if (uid) c.set("user" as never, { uid } as never);
    if (c.req.header("x-test-api-key")) c.set(AUTHENTICATED_BY_VAR as never, API_KEY_AUTHENTICATION as never);
    await next();
  });
  app.route("/api", createPlatformAdminRoutes(options) as unknown as Hono);
  return app;
}

type Reply = { status: number; json: Record<string, any> };

async function call(
  app: Hono,
  method: string,
  path: string,
  opts: { user?: string; body?: unknown; env?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.user) headers["x-test-user"] = opts.user;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(
    new Request(`https://example.test${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) } : {}),
    }),
    (opts.env ?? OPERATOR_ENV) as never,
  );
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) as Record<string, any> };
  } catch {
    return { status: res.status, json: { raw: text } };
  }
}

async function auditRows(
  workspaceId: string,
): Promise<Array<{ actor_id: string; action: string; target_type: string; target_id: string; metadata: Record<string, any> }>> {
  const rows = (
    await db
      .prepare("SELECT actor_id, action, target_type, target_id, metadata_json FROM audit_events WHERE workspace_id = ? ORDER BY rowid")
      .bind(workspaceId)
      .all<{ actor_id: string; action: string; target_type: string; target_id: string; metadata_json: string }>()
  ).results;
  return rows.map(({ metadata_json, ...r }) => ({ ...r, metadata: JSON.parse(metadata_json) as Record<string, any> }));
}

const suspendedFlag = async (id: string) =>
  (await db.prepare("SELECT suspended FROM mw_workspaces WHERE id = ?").bind(id).first<{ suspended: number }>())?.suspended;

/** Every operator route with a concrete path and a valid body. */
const ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "GET", path: "/api/platform/workspaces" },
  { method: "GET", path: `/api/platform/workspaces/${WS_A}` },
  { method: "GET", path: "/api/platform/users?status=pending" },
  { method: "GET", path: "/api/platform/audit/pending" },
  { method: "POST", path: `/api/platform/workspaces/${WS_A}/credits`, body: { amount: 5, reason: "goodwill", idempotencyKey: "k-gate" } },
  { method: "POST", path: `/api/platform/workspaces/${WS_A}/suspend`, body: { reason: "abuse" } },
  { method: "POST", path: `/api/platform/workspaces/${WS_A}/unsuspend`, body: { reason: "resolved" } },
  { method: "PUT", path: `/api/platform/workspaces/${WS_A}/flags/beta`, body: { enabled: true, reason: "pilot" } },
  { method: "DELETE", path: `/api/platform/workspaces/${WS_A}/flags/beta`, body: { reason: "pilot over" } },
  { method: "POST", path: "/api/platform/users/carol/approve", body: { reason: "verified" } },
  { method: "POST", path: "/api/platform/users/carol/reject", body: { reason: "spam" } },
];

beforeEach(async () => {
  expect.hasAssertions();
  await reset();
});

describe("operator gate", () => {
  test("ROUTES lists every route the brick mounts", () => {
    const mounted = createPlatformAdminRoutes(FULL)
      .routes.filter((r) => r.method !== "ALL")
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const listed = ROUTES.map((r) => `${r.method} ${r.path.replace(/\?.*$/, "")}`)
      .map((k) => k.replace(`/${WS_A}`, "/:id").replace("/carol/", "/:uid/").replace("/flags/beta", "/flags/:flagKey").replace("/api", ""))
      .sort();
    expect([...new Set(listed)]).toEqual(mounted);
    expect(mounted.every((r) => r.split(" ")[1]!.startsWith("/platform/"))).toBe(true);
  });

  test("a workspace owner, a member and anyone not listed get 403 NOT_PLATFORM_OPERATOR on every route, and nothing changes", async () => {
    const app = appWith();
    for (const user of ["alice", "bob", "mallory"]) {
      for (const r of ROUTES) {
        // Operator claims in headers or the body are never read.
        const res = await call(app, r.method, r.path, {
          user,
          body: r.body === undefined ? undefined : { ...(r.body as object), operator: true, role: "owner", platformOperator: user },
          headers: { "x-platform-operator": "1", "x-px-platform-operators": user },
        });
        expect(res.status, `${user} ${r.method} ${r.path}`).toBe(403);
        expect(res.json.code, `${user} ${r.method} ${r.path}`).toBe("NOT_PLATFORM_OPERATOR");
      }
    }
    // Refused before the body is read: an invalid body is still 403, not 400.
    expect((await call(app, "POST", `/api/platform/workspaces/${WS_A}/suspend`, { user: "alice", body: "{not json" })).status).toBe(403);
    expect(await suspendedFlag(WS_A)).toBe(0);
    expect(await auditRows(WS_A)).toEqual([]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger").first<{ n: number }>())?.n).toBe(0);
  });

  test("with PX_PLATFORM_OPERATORS unset or empty, everyone is refused (fail closed)", async () => {
    const app = appWith();
    for (const e of [{ DB: db }, { DB: db, PX_PLATFORM_OPERATORS: "" }, { DB: db, PX_PLATFORM_OPERATORS: " , " }]) {
      for (const r of ROUTES) {
        const res = await call(app, r.method, r.path, { user: OPERATOR, body: r.body, env: e });
        expect(res.status, `${r.method} ${r.path}`).toBe(403);
        expect(res.json.code).toBe("NOT_PLATFORM_OPERATOR");
      }
    }
    expect(await suspendedFlag(WS_A)).toBe(0);
  });

  test("no session is 401; an API-key request is 403 API_KEY_FORBIDDEN even for an operator's id", async () => {
    const app = appWith();
    for (const r of ROUTES) {
      expect((await call(app, r.method, r.path, { body: r.body })).status, `${r.method} ${r.path}`).toBe(401);
      const key = await call(app, r.method, r.path, { user: OPERATOR, body: r.body, headers: { "x-test-api-key": "1" } });
      expect(key.status, `${r.method} ${r.path}`).toBe(403);
      expect(key.json.code).toBe("API_KEY_FORBIDDEN");
    }
    expect(await auditRows(WS_A)).toEqual([]);
  });
});

describe("credit grants", () => {
  test("an operator grants 12.5 credits: the wallet gains 12500 thousandths once; one pending row and one applied outcome", async () => {
    const app = appWith();
    const grant = { amount: 12.5, reason: "Launch goodwill", idempotencyKey: "grant-1" };
    const first = await call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, { user: OPERATOR, body: grant });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json).toMatchObject({ granted: 12.5, grantedMilli: 12500, balance: 12.5, balanceMilli: 12500, duplicate: false });
    // A retry is a duplicate and adds nothing.
    const retry = await call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, { user: OPERATOR, body: grant });
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ balanceMilli: 12500, duplicate: true });
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(12500);
    expect(await walletCharger.balanceMilli(db, WS_B)).toBe(0);
    const ledger = (await db.prepare("SELECT type, amount_milli, user_id, metadata FROM credit_ledger WHERE workspace_id = ?").bind(WS_A).all()).results;
    expect(ledger).toEqual([{ type: "topup", amount_milli: 12500, user_id: OPERATOR, metadata: JSON.stringify({ op: "grant" }) }]);

    // Append-only: the pending row is never changed; the retry reused it and added nothing (its outcome is already
    // "applied"); the outcome row names it.
    const rows = await auditRows(WS_A);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_id: OPERATOR, action: "platform.credits.grant", target_type: "workspace", target_id: WS_A });
    expect(rows[0]!.metadata).toEqual({ status: "pending", reason: "Launch goodwill", amount: "12.5", idempotencyKey: "grant-1", before: { balance: "0" } });
    expect(rows[1]).toMatchObject({ actor_id: OPERATOR, action: "audit.outcome", target_type: "audit_event", target_id: first.json.auditId });
    expect(rows[1]!.metadata).toEqual({ status: "applied", after: { balance: "12.5" } });
    expect(retry.json.auditId).toBe(first.json.auditId);
    expect(await auditRecorder.pendingWithoutOutcome(db, WS_A)).toEqual([]);
    expect(await auditRows(WS_B)).toEqual([]);
  });

  test("bad requests are 400 with nothing granted and no audit row", async () => {
    const app = appWith();
    const path = `/api/platform/workspaces/${WS_A}/credits`;
    for (const body of [
      { amount: 5, idempotencyKey: "k" },
      { amount: 5, reason: "", idempotencyKey: "k" },
      { amount: 5, reason: "x".repeat(501), idempotencyKey: "k" },
      { amount: 5, reason: "r" },
      { amount: 0, reason: "r", idempotencyKey: "k" },
      { amount: -1, reason: "r", idempotencyKey: "k" },
      { amount: 1.0001, reason: "r", idempotencyKey: "k" },
      { amount: "1e3", reason: "r", idempotencyKey: "k" },
      // Over the maxGrantCredits cap (1000 here).
      { amount: 1000.001, reason: "r", idempotencyKey: "k" },
    ]) {
      const res = await call(app, "POST", path, { user: OPERATOR, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(app, "POST", path, { user: OPERATOR, body: { amount: "1000", reason: "r", idempotencyKey: "cap" } })).status).toBe(200);
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(1_000_000);
    expect((await auditRows(WS_A)).map((r) => r.metadata.status)).toEqual(["pending", "applied"]);
  });

  test("a retry after a grant that took effect without its outcome row completes that row with applied", async () => {
    const app = appWith();
    // A first attempt whose outcome was never written: the pending row exists and the wallet already has the grant.
    await auditRecorder.record(
      db,
      WS_A,
      {
        actorId: OPERATOR,
        action: "platform.credits.grant",
        targetType: "workspace",
        targetId: WS_A,
        metadata: { status: "pending", reason: "r", amount: "7", idempotencyKey: "half-done", before: { balance: "0" } },
      },
      { dedupeKey: "platform.credits.grant:half-done" },
    );
    await walletCharger.grant(db, WS_A, 7000, "platform-grant:half-done", "r", OPERATOR);
    const [pending] = await auditRecorder.pendingWithoutOutcome(db, WS_A);
    expect(pending).toBeDefined();
    const retry = await call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, {
      user: OPERATOR,
      body: { amount: 7, reason: "r", idempotencyKey: "half-done" },
    });
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ duplicate: true, auditId: pending!.id, balanceMilli: 7000 });
    expect(await auditRecorder.pendingWithoutOutcome(db, WS_A)).toEqual([]);
    const rows = await auditRows(WS_A);
    expect(rows.map((r) => [r.action, r.metadata.status])).toEqual([
      ["platform.credits.grant", "pending"],
      ["audit.outcome", "applied"],
    ]);
  });

  test("the idempotency key is at most 177 characters, so the audit dedupe key always fits", async () => {
    const app = appWith();
    const ok = await call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, {
      user: OPERATOR,
      body: { amount: 1, reason: "r", idempotencyKey: "k".repeat(177) },
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const retry = await call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, {
      user: OPERATOR,
      body: { amount: 1, reason: "r", idempotencyKey: "k".repeat(177) },
    });
    expect(retry.json).toMatchObject({ duplicate: true, auditId: ok.json.auditId });
    const tooLong = await call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, {
      user: OPERATOR,
      body: { amount: 1, reason: "r", idempotencyKey: "k".repeat(178) },
    });
    expect(tooLong.status).toBe(400);
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(1000);
  });

  test("concurrent first attempts with one key share one pending row; the grant applies once", async () => {
    const app = appWith();
    const body = { amount: 3, reason: "r", idempotencyKey: "same-time" };
    const replies = await Promise.all([1, 2, 3].map(() => call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, { user: OPERATOR, body })));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(replies.map((r) => r.json.auditId)).size).toBe(1);
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(3000);
    const rows = await auditRows(WS_A);
    expect(rows.filter((r) => r.action === "platform.credits.grant")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "audit.outcome").map((r) => r.metadata.status)).toContain("applied");
  });

  test("GET /platform/audit/pending lists capability rows still waiting for an outcome, across workspaces, in bounded pages", async () => {
    const app = appWith();
    for (const ws of [WS_A, WS_B]) {
      await auditRecorder.record(
        db,
        ws,
        { actorId: OPERATOR, action: "platform.credits.grant", targetType: "workspace", targetId: ws, metadata: { status: "pending", amount: "1" } },
        { dedupeKey: `k-${ws}` },
      );
    }
    // A row a member could have posted before the namespace was reserved (no capability marker) is never listed.
    await db
      .prepare(
        "INSERT INTO audit_events (id, workspace_id, actor_id, action, target_type, target_id, metadata_json) VALUES ('aud_planted', ?, 'm', 'platform.credits.grant', 'workspace', ?, ?)",
      )
      .bind(WS_A, WS_A, JSON.stringify({ status: "pending" }))
      .run();
    const first = await call(app, "GET", "/api/platform/audit/pending?limit=1", { user: OPERATOR });
    expect(first.status).toBe(200);
    expect(first.json.rows).toHaveLength(1);
    const rest = await call(app, "GET", `/api/platform/audit/pending?limit=1&after=${first.json.next as string}`, { user: OPERATOR });
    expect(rest.json.next).toBeNull();
    const listed = [...first.json.rows, ...rest.json.rows].map((r: { workspaceId: string; id: string }) => r.workspaceId).sort();
    expect(listed).toEqual([WS_A, WS_B].sort());
    expect([...first.json.rows, ...rest.json.rows].map((r: { id: string }) => r.id)).not.toContain("aud_planted");
    expect((await call(app, "GET", "/api/platform/audit/pending", { user: "alice" })).status).toBe(403);
  });

  test("unknown workspace 404; no wallet in a suspended workspace 404 WALLET_NOT_FOUND; a reused key 409; no wallet brick 503", async () => {
    const app = appWith();
    expect(
      (await call(app, "POST", "/api/platform/workspaces/ws_nope/credits", { user: OPERATOR, body: { amount: 1, reason: "r", idempotencyKey: "k" } })).status,
    ).toBe(404);
    expect(await auditRows("ws_nope")).toEqual([]);

    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = ?").bind(WS_B).run();
    const suspended = await call(app, "POST", `/api/platform/workspaces/${WS_B}/credits`, {
      user: OPERATOR,
      body: { amount: 1, reason: "r", idempotencyKey: "k" },
    });
    expect(suspended.status).toBe(404);
    expect(suspended.json.code).toBe("WALLET_NOT_FOUND");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM credit_wallets WHERE workspace_id = ?").bind(WS_B).first<{ n: number }>())?.n).toBe(0);
    expect((await auditRows(WS_B)).map((r) => r.metadata.status)).toEqual(["pending", "refused"]);
    expect((await auditRows(WS_B))[1]!.metadata).toMatchObject({ refusal: "WALLET_NOT_FOUND" });

    expect(
      (await call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, { user: OPERATOR, body: { amount: 2, reason: "r", idempotencyKey: "same" } }))
        .status,
    ).toBe(200);
    const reused = await call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, {
      user: OPERATOR,
      body: { amount: 3, reason: "r", idempotencyKey: "same" },
    });
    expect(reused.status).toBe(409);
    expect(reused.json.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(2000);
    // The refused reuse added no audit row: one pending row and its applied outcome only.
    expect((await auditRows(WS_A)).map((r) => r.metadata.status)).toEqual(["pending", "applied"]);
    // A tenant can use a "platform-grant:" key first: the grant then answers 409 (choose another key).
    await walletCharger.debit(db, WS_A, 1, "platform-grant:taken", "tenant's own use");
    const taken = await call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, {
      user: OPERATOR,
      body: { amount: 1, reason: "r", idempotencyKey: "taken" },
    });
    expect(taken.status).toBe(409);
    expect(taken.json.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const noWallet = appWith({ ...FULL, charger: undefined });
    const res = await call(noWallet, "POST", `/api/platform/workspaces/${WS_A}/credits`, {
      user: OPERATOR,
      body: { amount: 1, reason: "r", idempotencyKey: "k2" },
    });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("NOT_CONFIGURED");
  });
});

describe("suspension", () => {
  test("suspend and unsuspend set mw_workspaces.suspended through the sdk helper, each with its audit row", async () => {
    const app = appWith();
    const s = await call(app, "POST", `/api/platform/workspaces/${WS_A}/suspend`, { user: OPERATOR, body: { reason: "chargeback fraud" } });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json).toMatchObject({ workspaceId: WS_A, suspended: true, changed: true, before: { suspended: false, reason: null } });
    expect(await suspendedFlag(WS_A)).toBe(1);
    expect(await suspendedFlag(WS_B)).toBe(0);
    const u = await call(app, "POST", `/api/platform/workspaces/${WS_A}/unsuspend`, { user: OPERATOR, body: { reason: "resolved" } });
    expect(u.status).toBe(200);
    expect(await suspendedFlag(WS_A)).toBe(0);
    const rows = await auditRows(WS_A);
    expect(rows.map((r) => [r.action, r.actor_id, r.metadata.reason, r.metadata.before, r.metadata.after])).toEqual([
      ["platform.workspace.suspend", OPERATOR, "chargeback fraud", { suspended: false, reason: null }, { suspended: true }],
      ["platform.workspace.unsuspend", OPERATOR, "resolved", { suspended: true, reason: "operator" }, { suspended: false }],
    ]);
    // Repeating either is a no-op: 200 changed:false, and no audit row.
    for (const action of ["unsuspend", "suspend", "suspend"]) {
      const res = await call(app, "POST", `/api/platform/workspaces/${WS_A}/${action}`, { user: OPERATOR, body: { reason: "again" } });
      expect(res.status).toBe(200);
      if (action === "unsuspend") expect(res.json).toMatchObject({ changed: false, auditId: null });
    }
    expect((await call(app, "POST", `/api/platform/workspaces/${WS_A}/suspend`, { user: OPERATOR, body: { reason: "again" } })).json).toMatchObject({
      changed: false,
      auditId: null,
    });
    expect(await auditRows(WS_A)).toHaveLength(3);
  });

  test("an operator suspension sets reason operator; a workspace being deleted is 409 for every change; another reason is not lifted", async () => {
    const app = appWith();
    const reasonOf = async (id: string) => db.prepare("SELECT suspended, suspended_reason FROM mw_workspaces WHERE id = ?").bind(id).first();
    // 1. Not suspended, then suspended by an operator: reason "operator". The 1.10 delete route retries only reason
    //    "deleting", so the owner cannot delete a workspace an operator suspended (tested in the assembled app).
    expect((await call(app, "POST", `/api/platform/workspaces/${WS_A}/suspend`, { user: OPERATOR, body: { reason: "r" } })).status).toBe(200);
    expect(await reasonOf(WS_A)).toEqual({ suspended: 1, suspended_reason: "operator" });
    // 2. Operator-suspended, then unsuspended: the flag and the reason are cleared.
    expect((await call(app, "POST", `/api/platform/workspaces/${WS_A}/unsuspend`, { user: OPERATOR, body: { reason: "r" } })).status).toBe(200);
    expect(await reasonOf(WS_A)).toEqual({ suspended: 0, suspended_reason: null });
    // 3. and 4. A workspace fenced for deletion: neither suspend nor unsuspend (nor a grant or a flag change) touches it,
    //    and no audit row is written.
    await db.prepare("UPDATE mw_workspaces SET suspended = 1, suspended_reason = 'deleting' WHERE id = ?").bind(WS_B).run();
    await db.prepare("INSERT INTO flag_definitions (key, enabled_default) VALUES ('beta', 0)").run();
    for (const [method, path, body] of [
      ["POST", `/api/platform/workspaces/${WS_B}/suspend`, { reason: "r" }],
      ["POST", `/api/platform/workspaces/${WS_B}/unsuspend`, { reason: "r" }],
      ["POST", `/api/platform/workspaces/${WS_B}/credits`, { amount: 1, reason: "r", idempotencyKey: "k" }],
      ["PUT", `/api/platform/workspaces/${WS_B}/flags/beta`, { enabled: true, reason: "r" }],
      ["DELETE", `/api/platform/workspaces/${WS_B}/flags/beta`, { reason: "r" }],
    ] as const) {
      const res = await call(app, method, path, { user: OPERATOR, body });
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(res.json.code).toBe("WORKSPACE_DELETING");
    }
    expect(await reasonOf(WS_B)).toEqual({ suspended: 1, suspended_reason: "deleting" });
    expect(await auditRows(WS_B)).toEqual([]);
    expect(await walletCharger.balanceMilli(db, WS_B)).toBe(0);
    expect(await flagOverrides.list(db, WS_B)).toEqual([]);
    // A suspension for another reason (billing, or none at all) is neither taken over nor lifted: suspend-then-unsuspend
    // leaves it exactly as it was, with no audit row.
    for (const reason of ["billing", null]) {
      await db.prepare("UPDATE mw_workspaces SET suspended = 1, suspended_reason = ? WHERE id = ?").bind(reason, WS_A).run();
      for (const action of ["suspend", "unsuspend"]) {
        const res = await call(app, "POST", `/api/platform/workspaces/${WS_A}/${action}`, { user: OPERATOR, body: { reason: "r" } });
        expect(res.status, `${String(reason)} ${action}`).toBe(409);
        expect(res.json.code).toBe("SUSPENDED_OTHERWISE");
      }
      expect(await reasonOf(WS_A)).toEqual({ suspended: 1, suspended_reason: reason });
    }
    expect((await auditRows(WS_A)).map((r) => r.action)).toEqual(["platform.workspace.suspend", "platform.workspace.unsuspend"]);
  });

  test("a suspension that loses a race (a delete fence, a removal) commits no audit row; alongside takes audit statements only", async () => {
    // The audit insert runs right after the update and only if it changed a row.
    const raced = auditRecorder.statement(
      db,
      WS_B,
      { actorId: OPERATOR, action: "platform.workspace.suspend", targetType: "workspace", targetId: WS_B },
      { afterChange: true },
    );
    await db.prepare("UPDATE mw_workspaces SET suspended = 1, suspended_reason = 'deleting' WHERE id = ?").bind(WS_B).run();
    await db.batch([
      db.prepare("UPDATE mw_workspaces SET suspended = 1, suspended_reason = 'operator' WHERE id = ? AND suspended = 0").bind(WS_B),
      raced.statement,
    ]);
    expect(await auditRows(WS_B)).toEqual([]);
    const gone = auditRecorder.statement(
      db,
      "ws_gone",
      { actorId: OPERATOR, action: "platform.workspace.suspend", targetType: "workspace", targetId: "ws_gone" },
      { afterChange: true },
    );
    await db.batch([db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = 'ws_gone'"), gone.statement]);
    expect(await auditRows("ws_gone")).toEqual([]);
    const applied = auditRecorder.statement(
      db,
      WS_A,
      { actorId: OPERATOR, action: "platform.workspace.suspend", targetType: "workspace", targetId: WS_A },
      { afterChange: true },
    );
    expect(await setWorkspaceSuspended(db, WS_A, true, [applied])).toMatchObject({ ok: true, changed: true });
    expect(await auditRows(WS_A)).toHaveLength(1);
    // Anything but an afterChange audit statement for this workspace is refused, before anything runs.
    const forB = auditRecorder.statement(
      db,
      WS_B,
      { actorId: OPERATOR, action: "platform.workspace.unsuspend", targetType: "workspace", targetId: WS_B },
      { afterChange: true },
    );
    for (const bad of [{ id: "x", workspaceId: WS_A, statement: db.prepare("DELETE FROM mw_members") }, forB]) {
      await expect(setWorkspaceSuspended(db, WS_A, false, [bad as never])).rejects.toThrow(TypeError);
    }
    expect(await suspendedFlag(WS_A)).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM mw_members").first<{ n: number }>())?.n).toBe(2);
  });

  test("a missing reason is 400, an unknown workspace 404, no workspace registry 503", async () => {
    const app = appWith();
    expect((await call(app, "POST", `/api/platform/workspaces/${WS_A}/suspend`, { user: OPERATOR, body: {} })).status).toBe(400);
    expect((await call(app, "POST", "/api/platform/workspaces/ws_nope/suspend", { user: OPERATOR, body: { reason: "r" } })).status).toBe(404);
    expect(await suspendedFlag(WS_A)).toBe(0);
    for (const t of ["mw_invites", "mw_members", "mw_workspaces"]) await db.prepare(`DROP TABLE ${t}`).run();
    // A database object of its own: the sdk remembers a registry it has found once per database object.
    const fresh: D1Like = { prepare: (q) => db.prepare(q), batch: (s) => db.batch(s), exec: (q) => db.exec(q) };
    const noRegistry = { DB: fresh, PX_PLATFORM_OPERATORS: OPERATOR };
    const res = await call(app, "POST", `/api/platform/workspaces/${WS_A}/suspend`, { user: OPERATOR, body: { reason: "r" }, env: noRegistry });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("NOT_CONFIGURED");
    expect((await call(app, "GET", "/api/platform/workspaces", { user: OPERATOR, env: noRegistry })).status).toBe(503);
    expect((await call(app, "GET", `/api/platform/workspaces/${WS_A}`, { user: OPERATOR, env: noRegistry })).status).toBe(503);
    for (const [method, path, body] of [
      ["POST", `/api/platform/workspaces/${WS_A}/unsuspend`, { reason: "r" }],
      ["POST", `/api/platform/workspaces/${WS_A}/credits`, { amount: 1, reason: "r", idempotencyKey: "k" }],
      ["PUT", `/api/platform/workspaces/${WS_A}/flags/beta`, { enabled: true, reason: "r" }],
      ["DELETE", `/api/platform/workspaces/${WS_A}/flags/beta`, { reason: "r" }],
    ] as const) {
      const r = await call(app, method, path, { user: OPERATOR, body, env: noRegistry });
      expect(r.status, `${method} ${path}`).toBe(503);
      expect(r.json.code).toBe("NOT_CONFIGURED");
    }
    expect(await auditRows(WS_A)).toEqual([]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("feature flag overrides", () => {
  test("set and clear go through flagOverrides with audit rows; overrides turned off is 409; unknown flag 404; no flag brick 503", async () => {
    await db.prepare("INSERT INTO flag_definitions (key, enabled_default) VALUES ('beta', 0)").run();
    const app = appWith();
    const set = await call(app, "PUT", `/api/platform/workspaces/${WS_A}/flags/BETA`, { user: OPERATOR, body: { enabled: true, reason: "pilot" } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json).toMatchObject({ key: "beta", before: null, after: true });
    expect(await flagOverrides.list(db, WS_A)).toEqual([expect.objectContaining({ key: "beta", enabled: true })]);
    expect(await flagOverrides.list(db, WS_B)).toEqual([]);
    const summary = await call(app, "GET", `/api/platform/workspaces/${WS_A}`, { user: OPERATOR });
    expect(summary.json.flagOverrides).toEqual([expect.objectContaining({ key: "beta", enabled: true })]);

    const cleared = await call(app, "DELETE", `/api/platform/workspaces/${WS_A}/flags/beta`, { user: OPERATOR, body: { reason: "pilot over" } });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toMatchObject({ before: true, after: null });
    expect(await flagOverrides.list(db, WS_A)).toEqual([]);
    expect((await auditRows(WS_A)).map((r) => [r.action, r.target_type, r.target_id, r.metadata.reason])).toEqual([
      ["platform.flag.set", "flag", "beta", "pilot"],
      ["platform.flag.clear", "flag", "beta", "pilot over"],
    ]);

    // Story 1.12's rule: with allowWorkspaceOverrides off, neither set nor clear changes anything.
    const locked = appWith({ ...FULL, flagOverridesAllowed: false });
    const refused = await call(locked, "PUT", `/api/platform/workspaces/${WS_A}/flags/beta`, { user: OPERATOR, body: { enabled: true, reason: "r" } });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("OVERRIDES_DISABLED");
    expect((await call(locked, "DELETE", `/api/platform/workspaces/${WS_A}/flags/beta`, { user: OPERATOR, body: { reason: "r" } })).status).toBe(409);
    expect(
      (
        await call(appWith({ ...FULL, flagOverridesAllowed: undefined }), "PUT", `/api/platform/workspaces/${WS_A}/flags/beta`, {
          user: OPERATOR,
          body: { enabled: true, reason: "r" },
        })
      ).status,
    ).toBe(409);
    expect(await flagOverrides.list(db, WS_A)).toEqual([]);

    expect((await call(app, "PUT", `/api/platform/workspaces/${WS_A}/flags/nope`, { user: OPERATOR, body: { enabled: true, reason: "r" } })).status).toBe(404);
    expect((await call(app, "PUT", `/api/platform/workspaces/${WS_A}/flags/beta`, { user: OPERATOR, body: { enabled: "yes", reason: "r" } })).status).toBe(400);
    expect((await call(app, "PUT", "/api/platform/workspaces/ws_nope/flags/beta", { user: OPERATOR, body: { enabled: true, reason: "r" } })).status).toBe(404);
    // Refusals wrote no audit row.
    expect(await auditRows(WS_A)).toHaveLength(2);

    const noFlags = await call(appWith({ ...FULL, flagOverrides: undefined }), "PUT", `/api/platform/workspaces/${WS_A}/flags/beta`, {
      user: OPERATOR,
      body: { enabled: true, reason: "r" },
    });
    expect(noFlags.status).toBe(503);
  });
});

describe("audit guarantee", () => {
  test("when the audit row cannot be written, no action is applied", async () => {
    await db.prepare("INSERT INTO flag_definitions (key, enabled_default) VALUES ('beta', 0)").run();
    await db.prepare("DROP TABLE audit_events").run();
    const app = appWith();
    const grant = await call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, {
      user: OPERATOR,
      body: { amount: 5, reason: "r", idempotencyKey: "k" },
    });
    expect(grant.status).toBe(503);
    expect(grant.json.code).toBe("AUDIT_UNAVAILABLE");
    expect((await call(app, "POST", `/api/platform/workspaces/${WS_A}/suspend`, { user: OPERATOR, body: { reason: "r" } })).status).toBe(500);
    expect((await call(app, "PUT", `/api/platform/workspaces/${WS_A}/flags/beta`, { user: OPERATOR, body: { enabled: true, reason: "r" } })).status).toBe(500);
    expect((await call(app, "POST", "/api/platform/users/carol/approve", { user: OPERATOR, body: { reason: "r" } })).status).toBe(500);
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger").first<{ n: number }>())?.n).toBe(0);
    expect(await suspendedFlag(WS_A)).toBe(0);
    expect(await flagOverrides.list(db, WS_A)).toEqual([]);
    expect(
      await db
        .prepare("SELECT * FROM pa_user_approvals")
        .all()
        .then((r) => r.results),
    ).toEqual([]);
  });

  test("without an audit recorder every change answers 503 and nothing changes", async () => {
    const app = appWith({ ...FULL, auditRecorder: undefined });
    for (const r of ROUTES.filter((x) => x.method !== "GET")) {
      const res = await call(app, r.method, r.path, { user: OPERATOR, body: r.body });
      expect(res.status, `${r.method} ${r.path}`).toBe(503);
    }
    expect(await suspendedFlag(WS_A)).toBe(0);
    expect(await walletCharger.balanceMilli(db, WS_A)).toBe(0);
  });
});

describe("reads", () => {
  test("operators list workspaces in bounded pages and read one workspace's summary, never its data", async () => {
    for (let i = 0; i < 5; i += 1) await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, 'o')").bind(`ws_pa_z${i}`, `Z${i}`).run();
    const app = appWith();
    const first = await call(app, "GET", "/api/platform/workspaces?limit=3", { user: OPERATOR });
    expect(first.status).toBe(200);
    expect(first.json.workspaces.map((w: { id: string }) => w.id)).toEqual([WS_A, WS_B, "ws_pa_z0"]);
    const second = await call(app, "GET", `/api/platform/workspaces?limit=3&after=${first.json.next as string}`, { user: OPERATOR });
    expect(second.json.workspaces.map((w: { id: string }) => w.id)).toEqual(["ws_pa_z1", "ws_pa_z2", "ws_pa_z3"]);
    const big = await call(app, "GET", "/api/platform/workspaces?limit=100000", { user: OPERATOR });
    expect(big.json.workspaces).toHaveLength(7);

    await call(app, "POST", `/api/platform/workspaces/${WS_A}/credits`, { user: OPERATOR, body: { amount: "0.25", reason: "r", idempotencyKey: "k" } });
    const summary = await call(app, "GET", `/api/platform/workspaces/${WS_A}`, { user: OPERATOR });
    expect(summary.status).toBe(200);
    expect(summary.json).toEqual({
      workspace: expect.objectContaining({ id: WS_A, ownerId: "alice", suspended: false }),
      wallet: { balance: 0.25, balanceMilli: 250 },
      flagOverrides: [],
    });
    expect((await call(app, "GET", "/api/platform/workspaces/ws_nope", { user: OPERATOR })).status).toBe(404);
    const bare = await call(appWith({ ...FULL, charger: undefined, flagOverrides: undefined }), "GET", `/api/platform/workspaces/${WS_A}`, { user: OPERATOR });
    expect(bare.json).toMatchObject({ wallet: null, flagOverrides: null });
  });
});

describe("user approval gate", () => {
  function gatedApp(): Hono {
    const app = new Hono();
    app.use("/api/*", async (c, next) => {
      const uid = c.req.header("x-test-user");
      if (uid) c.set("user" as never, { uid } as never);
      if (c.req.header("x-test-api-key")) c.set(AUTHENTICATED_BY_VAR as never, API_KEY_AUTHENTICATION as never);
      const creator = c.req.header("x-test-key-creator");
      if (creator) c.set(API_KEY_CREATOR_VAR as never, creator as never);
      await next();
    });
    app.use("/api/things", requireApprovedUser as never);
    app.get("/api/things", (c) => c.json({ ok: true }));
    app.route("/api", createPlatformAdminRoutes({ ...FULL, requireUserApproval: true }) as unknown as Hono);
    return app;
  }

  test("an unapproved user is refused with 403 USER_NOT_APPROVED and listed as pending; approval lets them through", async () => {
    const app = gatedApp();
    const first = await call(app, "GET", "/api/things", { user: "carol" });
    expect(first.status).toBe(403);
    expect(first.json.code).toBe("USER_NOT_APPROVED");
    const pending = await call(app, "GET", "/api/platform/users?status=pending", { user: OPERATOR });
    expect(pending.json).toMatchObject({ approvalGate: true, users: [expect.objectContaining({ userId: "carol", status: "pending", decidedBy: null })] });

    const approved = await call(app, "POST", "/api/platform/users/carol/approve", { user: OPERATOR, body: { reason: "verified customer" } });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    expect(approved.json.user).toMatchObject({ userId: "carol", status: "approved", decidedBy: OPERATOR, reason: "verified customer" });
    expect((await call(app, "GET", "/api/things", { user: "carol" })).status).toBe(200);

    const rejected = await call(app, "POST", "/api/platform/users/carol/reject", { user: OPERATOR, body: { reason: "chargebacks" } });
    expect(rejected.status).toBe(200);
    const refused = await call(app, "GET", "/api/things", { user: "carol" });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "USER_NOT_APPROVED", status: "rejected" });

    // Decisions are audited in the platform scope (a person, not a workspace).
    expect((await auditRows(PLATFORM_AUDIT_SCOPE)).map((r) => [r.action, r.target_type, r.target_id, r.metadata.before, r.metadata.after])).toEqual([
      ["platform.user.approve", "user", "carol", { status: "pending" }, { status: "approved" }],
      ["platform.user.reject", "user", "carol", { status: "approved" }, { status: "rejected" }],
    ]);
    expect((await call(app, "POST", "/api/platform/users/carol/approve", { user: OPERATOR, body: {} })).status).toBe(400);
    expect((await call(app, "GET", "/api/platform/users?status=everyone", { user: OPERATOR })).status).toBe(400);
  });

  test("operators and anonymous requests pass the gate; API keys pass only for an approved creator; approval before sign-in works", async () => {
    const app = gatedApp();
    expect((await call(app, "GET", "/api/things", { user: OPERATOR })).status).toBe(200);
    // An API key is judged by its creator: refused while the creator is pending or rejected, or unknown.
    const viaKey = (creator?: string) =>
      call(app, "GET", "/api/things", { user: "apikey:k1", headers: { "x-test-api-key": "1", ...(creator ? { "x-test-key-creator": creator } : {}) } });
    expect((await viaKey()).json.code).toBe("USER_NOT_APPROVED");
    expect((await viaKey("erin")).json.code).toBe("USER_NOT_APPROVED");
    expect((await call(app, "POST", "/api/platform/users/erin/reject", { user: OPERATOR, body: { reason: "fraud" } })).status).toBe(200);
    expect((await viaKey("erin")).status).toBe(403);
    expect((await call(app, "POST", "/api/platform/users/frank/approve", { user: OPERATOR, body: { reason: "ok" } })).status).toBe(200);
    expect((await viaKey("frank")).status).toBe(200);
    expect((await viaKey(OPERATOR)).status).toBe(200);
    expect((await call(app, "GET", "/api/things")).status).toBe(200);
    // The operator's own id gets no row: operators exempt themselves.
    expect((await db.prepare("SELECT COUNT(*) AS n FROM pa_user_approvals WHERE user_id = ?").bind(OPERATOR).first<{ n: number }>())?.n).toBe(0);
    // Operator status comes only from the env: the same id without it is gated.
    expect((await call(app, "GET", "/api/things", { user: OPERATOR, env: { DB: db } })).status).toBe(403);

    expect((await call(app, "POST", "/api/platform/users/dave/approve", { user: OPERATOR, body: { reason: "pre-approved" } })).status).toBe(200);
    expect((await call(app, "GET", "/api/things", { user: "dave" })).status).toBe(200);
  });

  test("a decision guarded by a status that changed meanwhile is refused with 409 and writes neither row", async () => {
    const app = gatedApp();
    await call(app, "GET", "/api/things", { user: "gina" });
    // A database whose batch first lets a concurrent decision land, after the route read the status.
    const racing: D1Like = {
      prepare: (q) => db.prepare(q),
      exec: (q) => db.exec(q),
      batch: async (statements) => {
        await db.prepare("UPDATE pa_user_approvals SET status = 'rejected' WHERE user_id = 'gina'").run();
        return db.batch(statements);
      },
    };
    const res = await call(app, "POST", "/api/platform/users/gina/approve", {
      user: OPERATOR,
      body: { reason: "r" },
      env: { DB: racing, PX_PLATFORM_OPERATORS: OPERATOR },
    });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("CHANGED_CONCURRENTLY");
    expect(await db.prepare("SELECT status FROM pa_user_approvals WHERE user_id = 'gina'").first()).toEqual({ status: "rejected" });
    expect(await auditRows(PLATFORM_AUDIT_SCOPE)).toEqual([]);
    // A user with no row yet: a concurrent first row makes the guarded insert write nothing either.
    const racingNew: D1Like = {
      prepare: (q) => db.prepare(q),
      exec: (q) => db.exec(q),
      batch: async (statements) => {
        await db.prepare("INSERT INTO pa_user_approvals (user_id, status) VALUES ('hal', 'pending')").run();
        return db.batch(statements);
      },
    };
    const fresh = await call(app, "POST", "/api/platform/users/hal/reject", {
      user: OPERATOR,
      body: { reason: "r" },
      env: { DB: racingNew, PX_PLATFORM_OPERATORS: OPERATOR },
    });
    expect(fresh.status).toBe(409);
    expect(await auditRows(PLATFORM_AUDIT_SCOPE)).toEqual([]);
  });

  test("user listing is paged and bounded", async () => {
    const app = gatedApp();
    for (const u of ["u1", "u2", "u3", "u4"]) await call(app, "GET", "/api/things", { user: u });
    const page = await call(app, "GET", "/api/platform/users?limit=3", { user: OPERATOR });
    expect(page.json.users.map((u: { userId: string }) => u.userId)).toEqual(["u1", "u2", "u3"]);
    expect(page.json.next).toBe("u3");
    const rest = await call(app, "GET", "/api/platform/users?limit=3&after=u3", { user: OPERATOR });
    expect(rest.json).toMatchObject({ users: [expect.objectContaining({ userId: "u4" })], next: null });
  });

  test("a gate that cannot read its table refuses the request", async () => {
    await db.prepare("DROP TABLE pa_user_approvals").run();
    const res = await call(gatedApp(), "GET", "/api/things", { user: "carol" });
    expect(res.status).toBe(500);
  });
});

describe("no impersonation", () => {
  const PATTERN = /imperson|act[-_]?as|sudo|switch[-_]?user|login[-_]?as|assume|masquerade|on[-_]?behalf/i;

  test("no route path and no export of the brick offers to act as another user", () => {
    const paths = createPlatformAdminRoutes(FULL).routes.map((r) => r.path);
    expect(paths.filter((p) => PATTERN.test(p))).toEqual([]);
    expect(Object.keys(platformAdmin).filter((name) => PATTERN.test(name))).toEqual([]);
  });

  test("the brick's code never sets an identity, a workspace context, a session or a token", () => {
    for (const [file, text] of [
      ["routes.ts", routesSource],
      ["approvals.ts", approvalsSource],
    ] as const) {
      // The only variable it sets is the operator's own id, after the operator check.
      const sets = [...text.matchAll(/c\.set\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
      expect(
        sets.filter((name) => name !== "operatorId"),
        file,
      ).toEqual([]);
      expect(text, file).not.toMatch(/set-cookie|setCookie|createSession|signToken|session_token|x-test-user|authenticatedBy/i);
      expect(text, file).not.toMatch(PATTERN);
    }
  });

  test("the manifest declares no identity step and no admin-console dependency", () => {
    const manifest = manifestJson as unknown as { requires: string[]; worker: { identityAlternative?: unknown; guard?: unknown } };
    expect(manifest.worker.identityAlternative).toBeUndefined();
    expect(manifest.worker.guard).toBeUndefined();
    expect(manifest.requires).not.toContain("admin-console");
  });
});
