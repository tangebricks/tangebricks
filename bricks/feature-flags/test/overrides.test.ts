// Story 2.6: flagOverrides, the override surface other bricks are handed through `feature-flags.flagOverrides`.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration, auditStatement, workspaceNotDeletingGuard } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_feature_flags.sql?raw";
import { FeatureFlagService, flagOverrides } from "../src/index.ts";

const db = env.DB as unknown as D1Like;

beforeEach(async () => {
  expect.hasAssertions();
  await db.prepare("DROP TABLE IF EXISTS flag_overrides").run();
  await db.prepare("DROP TABLE IF EXISTS flag_definitions").run();
  await applyMigration(db, migration);
  await new FeatureFlagService(db).defineFlag("beta", "Beta", false, 100);
});

const audit = (ws = "ws_a") =>
  auditStatement(db, { workspaceId: ws, actorType: "user", actorId: "op", action: "platform.flag.set", targetType: "flag", targetId: "beta" }, { afterChange: true });
const auditCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM audit_events").first<{ n: number }>())?.n;

async function withAuditTable(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS audit_events").run();
  await db
    .prepare(
      "CREATE TABLE audit_events (id TEXT PRIMARY KEY, workspace_id TEXT, actor_id TEXT, actor_type TEXT, actor_email TEXT, action TEXT, target_type TEXT, target_id TEXT, metadata_json TEXT, created_at TEXT, dedupe_key TEXT, via_capability INTEGER)",
    )
    .run();
}

describe("flagOverrides (story 2.6)", () => {
  test("set and clear change one workspace's override, which the flag evaluation then uses; repeats are no-ops", async () => {
    expect(await flagOverrides.set(db, "ws_a", " BETA ", true, { allowOverrides: true })).toEqual({ ok: true, key: "beta", changed: true, before: null, after: true });
    expect(await flagOverrides.set(db, "ws_a", "beta", true, { allowOverrides: true })).toEqual({ ok: true, key: "beta", changed: false, before: true, after: true });
    expect(await flagOverrides.set(db, "ws_a", "beta", false, { allowOverrides: true })).toEqual({ ok: true, key: "beta", changed: true, before: true, after: false });
    expect(await flagOverrides.set(db, "ws_a", "beta", true, { allowOverrides: true })).toMatchObject({ ok: true, changed: true });
    const service = new FeatureFlagService(db);
    expect(await service.isEnabled("beta", { workspaceId: "ws_a" })).toBe(true);
    expect(await service.isEnabled("beta", { workspaceId: "ws_b" })).toBe(false);
    expect(await flagOverrides.list(db, "ws_a")).toEqual([expect.objectContaining({ key: "beta", enabled: true })]);
    expect(await flagOverrides.list(db, "ws_b")).toEqual([]);
    expect(await flagOverrides.clear(db, "ws_a", "beta", { allowOverrides: true })).toEqual({ ok: true, key: "beta", changed: true, before: true, after: null });
    expect(await flagOverrides.clear(db, "ws_a", "beta", { allowOverrides: true })).toEqual({ ok: true, key: "beta", changed: false, before: null, after: null });
    expect(await flagOverrides.list(db, "ws_a")).toEqual([]);
  });

  test("allowOverrides other than true refuses set and clear (story 1.12's rule); an unknown flag is FLAG_NOT_FOUND", async () => {
    for (const allowOverrides of [false, undefined]) {
      expect(await flagOverrides.set(db, "ws_a", "beta", true, { allowOverrides })).toEqual({ ok: false, code: "OVERRIDES_DISABLED" });
      expect(await flagOverrides.clear(db, "ws_a", "beta", { allowOverrides })).toEqual({ ok: false, code: "OVERRIDES_DISABLED" });
    }
    expect(await flagOverrides.set(db, "ws_a", "nope", true, { allowOverrides: true })).toEqual({ ok: false, code: "FLAG_NOT_FOUND" });
    expect(await flagOverrides.list(db, "ws_a")).toEqual([]);
  });

  test("audit rows commit only with a change; a guard that fails (workspace being deleted) writes neither", async () => {
    await withAuditTable();
    expect((await flagOverrides.set(db, "ws_a", "beta", true, { allowOverrides: true, alongside: () => [audit()] })).ok).toBe(true);
    expect(await auditCount()).toBe(1);
    // A no-op runs nothing, so no row.
    expect(await flagOverrides.set(db, "ws_a", "beta", true, { allowOverrides: true, alongside: () => [audit()] })).toMatchObject({ changed: false });
    expect(await auditCount()).toBe(1);
    await db.prepare("DROP TABLE IF EXISTS mw_workspaces").run();
    await db.prepare("CREATE TABLE mw_workspaces (id TEXT PRIMARY KEY, suspended INTEGER NOT NULL DEFAULT 0, suspended_reason TEXT)").run();
    await db.prepare("INSERT INTO mw_workspaces (id, suspended, suspended_reason) VALUES ('ws_a', 1, 'deleting')").run();
    const guard = workspaceNotDeletingGuard("ws_a");
    expect(await flagOverrides.set(db, "ws_a", "beta", false, { allowOverrides: true, guard, alongside: () => [audit()] })).toEqual({ ok: false, code: "NOT_APPLIED" });
    expect(await flagOverrides.clear(db, "ws_a", "beta", { allowOverrides: true, guard, alongside: () => [audit()] })).toEqual({ ok: false, code: "NOT_APPLIED" });
    expect(await flagOverrides.get(db, "ws_a", "beta")).toBe(true);
    expect(await auditCount()).toBe(1);
    await db.prepare("UPDATE mw_workspaces SET suspended = 0, suspended_reason = NULL WHERE id = 'ws_a'").run();
    expect((await flagOverrides.clear(db, "ws_a", "beta", { allowOverrides: true, guard, alongside: () => [audit()] })).ok).toBe(true);
    expect(await auditCount()).toBe(2);
    await expect(flagOverrides.set(db, "ws_a", "beta", true, { allowOverrides: true, guard: { sql: "1 = 1", params: [] } })).rejects.toThrow(TypeError);
    await db.prepare("DROP TABLE mw_workspaces").run();
  });

  test("a write guarded by a stale before value does nothing (a concurrent change), and writes no audit row", async () => {
    await withAuditTable();
    await flagOverrides.set(db, "ws_a", "beta", true, { allowOverrides: true });
    // A database whose batch first lets a concurrent change land, after flagOverrides read the value.
    const racing: D1Like = {
      prepare: (q) => db.prepare(q),
      exec: (q) => db.exec(q),
      batch: async (statements) => {
        await db.prepare("UPDATE flag_overrides SET enabled = 0 WHERE workspace_id = 'ws_a'").run();
        return db.batch(statements);
      },
    };
    expect(await flagOverrides.set(racing, "ws_a", "beta", false, { allowOverrides: true, alongside: () => [audit()] })).toEqual({ ok: false, code: "NOT_APPLIED" });
    expect(await auditCount()).toBe(0);
    await db.prepare("UPDATE flag_overrides SET enabled = 1 WHERE workspace_id = 'ws_a'").run();
    expect(await flagOverrides.clear(racing, "ws_a", "beta", { allowOverrides: true, alongside: () => [audit()] })).toEqual({ ok: false, code: "NOT_APPLIED" });
    expect(await auditCount()).toBe(0);
  });

  test("alongside takes afterChange audit statements for this workspace only; anything else throws before anything runs", async () => {
    await withAuditTable();
    for (const alongside of [
      [db.prepare("DELETE FROM flag_definitions")],
      [{ id: "x", workspaceId: "ws_a", statement: db.prepare("DELETE FROM flag_definitions") }],
      [audit("ws_b")],
      [auditStatement(db, { workspaceId: "ws_a", actorType: "user", actorId: "op", action: "a" })],
    ]) {
      await expect(flagOverrides.set(db, "ws_a", "beta", true, { allowOverrides: true, alongside: alongside as never })).rejects.toThrow(TypeError);
    }
    expect(await flagOverrides.get(db, "ws_a", "beta")).toBeNull();
    expect(await new FeatureFlagService(db).getFlag("beta")).not.toBeNull();
    // A failing audit insert rolls the override back.
    await db.prepare("DROP TABLE audit_events").run();
    await expect(flagOverrides.set(db, "ws_a", "beta", true, { allowOverrides: true, alongside: () => [audit()] })).rejects.toThrow();
    expect(await flagOverrides.get(db, "ws_a", "beta")).toBeNull();
  });

  test("a function passed as alongside gets the value the change read, which is the before it reports", async () => {
    const seen: Array<boolean | null> = [];
    const record = (before: boolean | null) => {
      seen.push(before);
      return [];
    };
    expect((await flagOverrides.set(db, "ws_a", "beta", true, { allowOverrides: true, alongside: record })).ok).toBe(true);
    expect(await flagOverrides.set(db, "ws_a", "beta", false, { allowOverrides: true, alongside: record })).toMatchObject({ before: true });
    expect(await flagOverrides.clear(db, "ws_a", "beta", { allowOverrides: true, alongside: record })).toMatchObject({ before: false });
    expect(seen).toEqual([null, true, false]);
  });
});
