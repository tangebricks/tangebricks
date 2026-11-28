// Story 2.8: setWorkspaceSuspended through a registry that is a view over an app's own table (an app that adopts the
// bricks without moving its rows, docs/adopting-existing-tables.md). A write through an INSTEAD OF trigger reports no
// change to `changes()`, and its change count depends on the database: plain SQLite reports 0, D1 reports the trigger's
// own writes. The helper must neither drop the audit row nor misreport `changed` under either.
import { describe, expect, test } from "vitest";
import { auditStatement, auditStatementWhen, setWorkspaceSuspended } from "../src/index.ts";
import type { D1Like, D1Statement } from "../src/index.ts";
import { sqliteD1 } from "../../../test/support/sqlite-d1.ts";

const APP_AND_VIEW = `
CREATE TABLE orgs (id TEXT PRIMARY KEY, label TEXT NOT NULL, owner TEXT NOT NULL, is_off INTEGER NOT NULL DEFAULT 0, off_note TEXT, made TEXT NOT NULL DEFAULT (datetime('now')));
CREATE VIEW mw_workspaces AS SELECT id, label AS name, owner AS owner_id, is_off AS suspended, off_note AS suspended_reason, made AS created_at FROM orgs;
CREATE TRIGGER mw_workspaces_update INSTEAD OF UPDATE ON mw_workspaces
BEGIN
  UPDATE orgs SET label = NEW.name, owner = NEW.owner_id, is_off = NEW.suspended, off_note = NEW.suspended_reason WHERE id = OLD.id;
END;
CREATE TABLE audit_events (id TEXT PRIMARY KEY, workspace_id TEXT, actor_id TEXT, actor_type TEXT, actor_email TEXT, action TEXT, target_type TEXT, target_id TEXT, metadata_json TEXT, created_at TEXT, dedupe_key TEXT, via_capability INTEGER);
INSERT INTO orgs (id, label, owner) VALUES ('org_a', 'A', 'o'), ('org_b', 'B', 'o');
`;

type Shape = "plain SQLite" | "D1-shaped change counts";

/** The database, with `run` reporting changes as plain SQLite does, or as D1 does (every row written, triggers included). */
function database(shape: Shape) {
  const { d1, db } = sqliteD1();
  db.exec(APP_AND_VIEW);
  if (shape === "plain SQLite") return { d1, db };
  const total = () => Number((db.prepare("SELECT total_changes() AS t").get() as { t: number }).t);
  const wrap = (s: D1Statement): D1Statement => ({
    bind: (...v) => wrap(s.bind(...v)),
    first: (...a) => s.first(...(a as [])),
    all: () => s.all(),
    run: async () => {
      const before = total();
      const res = await s.run();
      return { ...res, meta: { ...res.meta, changes: total() - before } };
    },
  });
  const shaped: D1Like = { prepare: (q) => wrap(d1.prepare(q)), batch: (ss) => d1.batch(ss), exec: (q) => d1.exec(q) };
  return { d1: shaped, db };
}

const audit = (db: D1Like, ws: string) =>
  auditStatement(
    db,
    { workspaceId: ws, actorType: "user", actorId: "op", action: "platform.workspace.suspend", targetType: "workspace", targetId: ws },
    { afterChange: true },
  );

describe.each(["plain SQLite", "D1-shaped change counts"] as const)("setWorkspaceSuspended through a view (%s)", (shape) => {
  test("the view reports no change to changes(): an afterChange row after the update would never be written", () => {
    const { db } = database(shape);
    db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = 'org_b' AND suspended = 0").run();
    expect(db.prepare("SELECT changes() AS n").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT is_off FROM orgs WHERE id = 'org_b'").get()).toEqual({ is_off: 1 });
  });

  test("suspend and unsuspend report changed: true and write their audit row; a repeat reports changed: false and writes none", async () => {
    const { d1, db } = database(shape);
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;
    expect(await setWorkspaceSuspended(d1, "org_a", true, () => [audit(d1, "org_a")])).toEqual({
      ok: true,
      changed: true,
      before: { suspended: false, reason: null },
    });
    expect(db.prepare("SELECT is_off, off_note FROM orgs WHERE id = 'org_a'").get()).toEqual({ is_off: 1, off_note: "operator" });
    expect(count()).toBe(1);
    expect(await setWorkspaceSuspended(d1, "org_a", true, [audit(d1, "org_a")])).toEqual({
      ok: true,
      changed: false,
      before: { suspended: true, reason: "operator" },
    });
    expect(count()).toBe(1);
    expect(await setWorkspaceSuspended(d1, "org_a", false, [audit(d1, "org_a")])).toEqual({
      ok: true,
      changed: true,
      before: { suspended: true, reason: "operator" },
    });
    expect(db.prepare("SELECT is_off, off_note FROM orgs WHERE id = 'org_a'").get()).toEqual({ is_off: 0, off_note: null });
    expect(count()).toBe(2);
    // Without audit statements the outcome is read back from the row.
    expect(await setWorkspaceSuspended(d1, "org_b", true)).toMatchObject({ ok: true, changed: true });
    expect(await setWorkspaceSuspended(d1, "org_b", true)).toMatchObject({ ok: true, changed: false });
    expect(count()).toBe(2);
  });

  test("a suspension for another reason is neither overwritten nor lifted, and writes no audit row", async () => {
    const { d1, db } = database(shape);
    db.exec("UPDATE orgs SET is_off = 1, off_note = 'billing' WHERE id = 'org_b'");
    for (const suspended of [true, false]) {
      expect(await setWorkspaceSuspended(d1, "org_b", suspended, [audit(d1, "org_b")])).toEqual({ ok: false, reason: "other_suspension" });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events").get()).toEqual({ n: 0 });
  });
});

test("an alongside function that returns undefined is treated as no audit rows, as before", async () => {
  const { d1 } = database("plain SQLite");
  expect(await setWorkspaceSuspended(d1, "org_a", true, (() => undefined) as never)).toMatchObject({ ok: true, changed: true });
});

describe("auditStatementWhen (story 2.8)", () => {
  test("writes the issued row only when the condition holds, and accepts only afterChange statements without a dedupe key", async () => {
    const { d1, db } = database("plain SQLite");
    await auditStatementWhen(d1, audit(d1, "org_a"), { sql: "EXISTS (SELECT 1 FROM orgs WHERE id = ? AND is_off = 1)", params: ["org_a"] }).run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events").get()).toEqual({ n: 0 });
    const made = audit(d1, "org_a");
    await auditStatementWhen(d1, made, { sql: "EXISTS (SELECT 1 FROM orgs WHERE id = ? AND is_off = 0)", params: ["org_a"] }).run();
    expect(db.prepare("SELECT id, workspace_id, action, via_capability FROM audit_events").all()).toEqual([
      { id: made.id, workspace_id: "org_a", action: "platform.workspace.suspend", via_capability: 1 },
    ]);
    const cond = { sql: "1", params: [] };
    expect(() => auditStatementWhen(d1, { id: "x", workspaceId: "org_a", statement: d1.prepare("SELECT 1") } as never, cond)).toThrow(TypeError);
    expect(() => auditStatementWhen(d1, auditStatement(d1, { workspaceId: "org_a", actorType: "user", actorId: "op", action: "a" }), cond)).toThrow(
      /afterChange/,
    );
    expect(() =>
      auditStatementWhen(
        d1,
        auditStatement(d1, { workspaceId: "org_a", actorType: "user", actorId: "op", action: "a" }, { afterChange: true, dedupeKey: "k" }),
        cond,
      ),
    ).toThrow(/dedupeKey/);
    expect(() => auditStatementWhen(d1, audit(d1, "org_a"), { sql: " ", params: [] })).toThrow(TypeError);
  });
});
