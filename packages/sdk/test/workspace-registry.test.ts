// Story 2.6: the sdk's operator helpers over the workspace registry (mw_workspaces): setWorkspaceSuspended, the only
// write any brick but multi-workspace makes to it, and the bounded listing.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { auditStatement, findWorkspaceRecord, findWorkspaceState, listWorkspaces, setWorkspaceSuspended } from "../src/index.ts";
import type { D1Like } from "../src/index.ts";

const db = env.DB as unknown as D1Like;
/** A database object of its own, so the registry lookup (remembered per database object) starts fresh. */
const fresh = (): D1Like => ({ prepare: (q) => db.prepare(q), batch: (s) => db.batch(s), exec: (q) => db.exec(q) });

beforeEach(async () => {
  expect.hasAssertions();
  await db.prepare("DROP TABLE IF EXISTS mw_workspaces").run();
  await db.prepare("DROP TABLE IF EXISTS audit_events").run();
  await db.prepare("CREATE TABLE mw_workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, suspended INTEGER NOT NULL DEFAULT 0, suspended_reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await db
    .prepare(
      "CREATE TABLE audit_events (id TEXT PRIMARY KEY, workspace_id TEXT, actor_id TEXT, actor_type TEXT, actor_email TEXT, action TEXT, target_type TEXT, target_id TEXT, metadata_json TEXT, created_at TEXT, dedupe_key TEXT, via_capability INTEGER)",
    )
    .run();
  for (const id of ["ws_a", "ws_b", "ws_c"]) await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, 'o')").bind(id, id.toUpperCase()).run();
});

const audit = (ws: string, options: { afterChange?: boolean } = { afterChange: true }) =>
  auditStatement(db, { workspaceId: ws, actorType: "user", actorId: "op", action: "platform.workspace.suspend", targetType: "workspace", targetId: ws }, options);
const auditCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM audit_events").first<{ n: number }>())?.n;
const row = (id: string) => db.prepare("SELECT suspended, suspended_reason FROM mw_workspaces WHERE id = ?").bind(id).first();

describe("auditStatement (story 2.6)", () => {
  test("builds a capability-marked insert from fields only, for user or system actors", async () => {
    const made = auditStatement(db, { workspaceId: "ws_a", actorType: "system", actorId: "job", action: "X.Y", metadata: { a: 1 } });
    await made.statement.run();
    expect(await db.prepare("SELECT workspace_id, actor_type, action, target_type, metadata_json, via_capability FROM audit_events").first()).toEqual({
      workspace_id: "ws_a",
      actor_type: "system",
      action: "x.y",
      target_type: "",
      metadata_json: JSON.stringify({ a: 1 }),
      via_capability: 1,
    });
    for (const actorType of ["support_impersonator", "api_key"]) {
      expect(() => auditStatement(db, { workspaceId: "ws_a", actorType: actorType as never, actorId: "x", action: "a" })).toThrow(RangeError);
    }
    expect(() => auditStatement(db, { workspaceId: "ws_a", actorType: "user", actorId: "x", action: "a", metadata: { big: "x".repeat(5000) } })).toThrow(RangeError);
  });
});

describe("setWorkspaceSuspended (story 2.6)", () => {
  test("suspend sets reason operator and unsuspend clears it, each with its audit row; repeating either is a no-op with no row", async () => {
    const d = fresh();
    expect(await setWorkspaceSuspended(d, "ws_a", true, [audit("ws_a")])).toEqual({ ok: true, changed: true, before: { suspended: false, reason: null } });
    expect(await row("ws_a")).toEqual({ suspended: 1, suspended_reason: "operator" });
    expect(await findWorkspaceState(d, "ws_a")).toEqual({ suspended: true, reason: "operator", deleting: false, checked: true });
    expect(await findWorkspaceState(d, "ws_b")).toEqual({ suspended: false, reason: null, deleting: false, checked: true });
    expect(await setWorkspaceSuspended(d, "ws_a", true, [audit("ws_a")])).toEqual({ ok: true, changed: false, before: { suspended: true, reason: "operator" } });
    expect(await auditCount()).toBe(1);
    expect(await setWorkspaceSuspended(d, "ws_a", false, [audit("ws_a")])).toEqual({ ok: true, changed: true, before: { suspended: true, reason: "operator" } });
    expect(await row("ws_a")).toEqual({ suspended: 0, suspended_reason: null });
    expect(await setWorkspaceSuspended(d, "ws_a", false, [audit("ws_a")])).toEqual({ ok: true, changed: false, before: { suspended: false, reason: null } });
    expect(await auditCount()).toBe(2);
  });

  test("a suspension for another reason (or none) is neither overwritten nor lifted; a workspace being deleted is refused both ways", async () => {
    await db.prepare("UPDATE mw_workspaces SET suspended = 1, suspended_reason = 'billing' WHERE id = 'ws_b'").run();
    await db.prepare("UPDATE mw_workspaces SET suspended = 1, suspended_reason = NULL WHERE id = 'ws_c'").run();
    for (const ws of ["ws_b", "ws_c"]) {
      for (const suspended of [true, false]) expect(await setWorkspaceSuspended(fresh(), ws, suspended, [audit(ws)])).toEqual({ ok: false, reason: "other_suspension" });
    }
    expect(await row("ws_b")).toEqual({ suspended: 1, suspended_reason: "billing" });
    expect(await row("ws_c")).toEqual({ suspended: 1, suspended_reason: null });
    await db.prepare("UPDATE mw_workspaces SET suspended = 1, suspended_reason = 'deleting' WHERE id = 'ws_b'").run();
    for (const suspended of [true, false]) expect(await setWorkspaceSuspended(fresh(), "ws_b", suspended, [audit("ws_b")])).toEqual({ ok: false, reason: "deleting" });
    expect(await findWorkspaceState(fresh(), "ws_b")).toMatchObject({ deleting: true });
    expect(await auditCount()).toBe(0);
  });

  test("a failing audit statement rolls the flag back; anything but an afterChange audit statement for this workspace throws first", async () => {
    const d = fresh();
    await db.prepare("DROP TABLE audit_events").run();
    await expect(setWorkspaceSuspended(d, "ws_a", true, [audit("ws_a")])).rejects.toThrow();
    expect(await row("ws_a")).toEqual({ suspended: 0, suspended_reason: null });
    await expect(setWorkspaceSuspended(d, "ws_a", true, [db.prepare("DELETE FROM mw_workspaces") as never])).rejects.toThrow(TypeError);
    await expect(setWorkspaceSuspended(d, "ws_a", true, [{ id: "x", workspaceId: "ws_a", statement: db.prepare("DELETE FROM mw_workspaces") } as never])).rejects.toThrow(TypeError);
    await expect(setWorkspaceSuspended(d, "ws_a", true, [audit("ws_b")])).rejects.toThrow(TypeError);
    await expect(setWorkspaceSuspended(d, "ws_a", true, [audit("ws_a", {})])).rejects.toThrow(TypeError);
    // A deduplicated (INSERT OR IGNORE) statement could let the change commit without its row: refused.
    await expect(setWorkspaceSuspended(d, "ws_a", true, [audit("ws_a", { afterChange: true, dedupeKey: "k" } as never)])).rejects.toThrow(/dedupeKey/);
    await expect(setWorkspaceSuspended(d, "ws_a", true, () => [audit("ws_a", { afterChange: true, dedupeKey: "k" } as never)])).rejects.toThrow(/dedupeKey/);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM mw_workspaces").first<{ n: number }>())?.n).toBe(3);
    expect(await row("ws_a")).toEqual({ suspended: 0, suspended_reason: null });
  });

  test("a function passed as alongside is built from the state the update acts on", async () => {
    await db.prepare("UPDATE mw_workspaces SET suspended = 1, suspended_reason = 'operator' WHERE id = 'ws_a'").run();
    const seen: unknown[] = [];
    expect(
      await setWorkspaceSuspended(fresh(), "ws_a", false, (before) => {
        seen.push(before);
        return [audit("ws_a")];
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(seen).toEqual([{ suspended: true, reason: "operator" }]);
    expect(await auditCount()).toBe(1);
    // A no-op never calls it.
    await setWorkspaceSuspended(fresh(), "ws_a", false, () => {
      seen.push("called");
      return [];
    });
    expect(seen).toHaveLength(1);
  });

  test("an unknown workspace is not_found and no registry is no_registry; neither writes an audit row", async () => {
    expect(await setWorkspaceSuspended(fresh(), "ws_nope", true, [audit("ws_nope")])).toEqual({ ok: false, reason: "not_found" });
    await db.prepare("DROP TABLE mw_workspaces").run();
    expect(await setWorkspaceSuspended(fresh(), "ws_a", true, [audit("ws_a")])).toEqual({ ok: false, reason: "no_registry" });
    expect(await listWorkspaces(fresh())).toBeNull();
    expect(await findWorkspaceRecord(fresh(), "ws_a")).toBeNull();
    expect(await auditCount()).toBe(0);
  });

  test("refuses a non-boolean state and a bad id", async () => {
    await expect(setWorkspaceSuspended(fresh(), "ws_a", 1 as never)).rejects.toThrow(TypeError);
    await expect(setWorkspaceSuspended(fresh(), "", true)).rejects.toThrow(RangeError);
  });
});

describe("listWorkspaces / findWorkspaceRecord (story 2.6)", () => {
  test("pages in id order with a bounded limit", async () => {
    const d = fresh();
    const first = await listWorkspaces(d, { limit: 2 });
    expect(first?.workspaces.map((w) => w.id)).toEqual(["ws_a", "ws_b"]);
    expect(first?.next).toBe("ws_b");
    const rest = await listWorkspaces(d, { limit: 2, after: "ws_b" });
    expect(rest).toEqual({ workspaces: [expect.objectContaining({ id: "ws_c", name: "WS_C", ownerId: "o", suspended: false })], next: null });
    expect((await listWorkspaces(d, { limit: 0 }))?.workspaces).toHaveLength(1);
    expect((await listWorkspaces(d, { limit: 10_000 }))?.workspaces).toHaveLength(3);
    expect(await findWorkspaceRecord(d, "ws_b")).toEqual(expect.objectContaining({ id: "ws_b", suspended: false }));
    expect(await findWorkspaceRecord(d, "ws_nope")).toBeNull();
  });
});
