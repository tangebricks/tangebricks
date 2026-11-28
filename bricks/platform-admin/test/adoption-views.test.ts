// Story 2.8: platform-admin in an app that keeps its own tables and exposes them to the bricks as views with INSTEAD OF
// triggers (docs/adopting-existing-tables.md): the workspace registry from fixtures/adopt-existing-tables, and the
// approval table as a view over the app's own people table. Through a view, D1 reports the trigger's writes as the change
// count and `changes()` reports none, so nothing here may decide from either: suspension and user decisions report
// `changed` correctly and write their audit row atomically.
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { auditRecorder } from "@poc/audit-trail";
import { PLATFORM_AUDIT_SCOPE, createPlatformAdminRoutes } from "../src/index.ts";
import appTables from "../../../fixtures/adopt-existing-tables/app-tables.sql?raw";
import mwViews from "../../../fixtures/adopt-existing-tables/mw-views.sql?raw";
import auditMigration from "../../audit-trail/migrations/0001_audit_trail.sql?raw";
import auditMigration0002 from "../../audit-trail/migrations/0002_capability_rows.sql?raw";

const db = env.DB as unknown as D1Like;
const OPERATOR = "op_views";

// The app's own approvals: a flag, when and by whom. A decision with ok = 0 and a decider is a rejection.
const PEOPLE_AND_VIEW = `
CREATE TABLE people (id TEXT PRIMARY KEY, ok INTEGER NOT NULL DEFAULT 0, ok_at TEXT, ok_by TEXT, joined TEXT NOT NULL DEFAULT (datetime('now')));
CREATE VIEW pa_user_approvals AS
  SELECT id AS user_id,
    CASE WHEN ok = 1 THEN 'approved' WHEN ok_by IS NOT NULL THEN 'rejected' ELSE 'pending' END AS status,
    ok_by AS decided_by, ok_at AS decided_at, NULL AS reason, joined AS created_at
  FROM people;
CREATE TRIGGER pa_user_approvals_insert INSTEAD OF INSERT ON pa_user_approvals
BEGIN
  INSERT INTO people (id, ok, ok_at, ok_by) VALUES (NEW.user_id, CASE WHEN NEW.status = 'approved' THEN 1 ELSE 0 END, NEW.decided_at, NEW.decided_by);
END;
CREATE TRIGGER pa_user_approvals_update INSTEAD OF UPDATE ON pa_user_approvals
BEGIN
  UPDATE people SET ok = CASE WHEN NEW.status = 'approved' THEN 1 ELSE 0 END, ok_at = NEW.decided_at, ok_by = NEW.decided_by WHERE id = OLD.user_id;
END;
`;

const app = new Hono();
app.use("/api/*", async (c, next) => {
  const uid = c.req.header("x-test-user");
  if (uid) c.set("user" as never, { uid } as never);
  await next();
});
app.route("/api", createPlatformAdminRoutes({ auditRecorder, isOperator: (_e, userId) => userId === OPERATOR }) as unknown as Hono);

async function call(method: string, path: string, body: unknown) {
  const res = await app.request(
    `https://example.test${path}`,
    { method, headers: { "x-test-user": OPERATOR, "content-type": "application/json" }, body: JSON.stringify(body) },
    { DB: db },
  );
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const auditActions = async (workspaceId: string) =>
  (
    await db
      .prepare("SELECT action, target_id FROM audit_events WHERE workspace_id = ? AND via_capability = 1 ORDER BY rowid")
      .bind(workspaceId)
      .all<{ action: string; target_id: string }>()
  ).results.map((r) => `${r.action} ${r.target_id}`);

beforeEach(async () => {
  expect.hasAssertions();
  for (const view of ["mw_invites", "mw_members", "mw_workspaces", "pa_user_approvals"]) {
    await db.prepare(`DROP VIEW IF EXISTS ${view}`).run();
    await db.prepare(`DROP TABLE IF EXISTS ${view}`).run();
  }
  for (const table of ["team_invites", "team_users", "teams", "people", "audit_events"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, appTables);
  await db.prepare("INSERT INTO teams (id, title, owner_user) VALUES ('team_a', 'A', 'usr_lead')").run();
  await applyMigration(db, mwViews);
  await applyMigration(db, auditMigration);
  await applyMigration(db, auditMigration0002);
  await applyMigration(db, PEOPLE_AND_VIEW);
  await db.prepare("INSERT INTO people (id) VALUES ('usr_pending')").run();
});

describe("story 2.8: platform-admin through views over an app's own tables", () => {
  test("suspend and unsuspend report changed: true and write their audit row; repeats report changed: false and write none", async () => {
    const s = await call("POST", "/api/platform/workspaces/team_a/suspend", { reason: "abuse" });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json).toMatchObject({ suspended: true, changed: true, before: { suspended: false, reason: null } });
    expect(s.json.auditId).toMatch(/^aud_/);
    expect(await db.prepare("SELECT is_suspended, suspend_note FROM teams WHERE id = 'team_a'").first()).toEqual({ is_suspended: 1, suspend_note: "operator" });
    const again = await call("POST", "/api/platform/workspaces/team_a/suspend", { reason: "abuse" });
    expect(again.json).toMatchObject({ changed: false, auditId: null });
    const u = await call("POST", "/api/platform/workspaces/team_a/unsuspend", { reason: "resolved" });
    expect(u.json).toMatchObject({ suspended: false, changed: true });
    expect(await db.prepare("SELECT is_suspended, suspend_note FROM teams WHERE id = 'team_a'").first()).toEqual({ is_suspended: 0, suspend_note: null });
    expect((await call("POST", "/api/platform/workspaces/team_a/unsuspend", { reason: "resolved" })).json).toMatchObject({ changed: false });
    expect(await auditActions("team_a")).toEqual(["platform.workspace.suspend team_a", "platform.workspace.unsuspend team_a"]);
  });

  test("user decisions land in the app's table with their audit row, for a known user and one the app has never seen", async () => {
    const approved = await call("POST", "/api/platform/users/usr_pending/approve", { reason: "verified" });
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    expect(approved.json.user).toMatchObject({ userId: "usr_pending", status: "approved", decidedBy: OPERATOR });
    const rejected = await call("POST", "/api/platform/users/usr_pending/reject", { reason: "fraud" });
    expect(rejected.json.user).toMatchObject({ status: "rejected", decidedBy: OPERATOR });
    const fresh = await call("POST", "/api/platform/users/usr_new/approve", { reason: "pre-approved" });
    expect(fresh.status, JSON.stringify(fresh.json)).toBe(200);
    expect(
      await db
        .prepare("SELECT id, ok, ok_by FROM people ORDER BY id")
        .all()
        .then((r) => r.results),
    ).toEqual([
      { id: "usr_new", ok: 1, ok_by: OPERATOR },
      { id: "usr_pending", ok: 0, ok_by: OPERATOR },
    ]);
    expect(await auditActions(PLATFORM_AUDIT_SCOPE)).toEqual([
      "platform.user.approve usr_pending",
      "platform.user.reject usr_pending",
      "platform.user.approve usr_new",
    ]);
  });
});
