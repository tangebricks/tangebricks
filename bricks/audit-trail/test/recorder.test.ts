// Story 2.6: auditRecorder, the audit surface other bricks are handed through `audit-logging.auditRecorder`. The log
// stays append-only (outcomes are new rows naming the pending row), every row it writes carries the capability marker,
// and every read it makes ignores rows without it, so nothing a member posts through the public route can pose as one.
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration, isAuditStatement } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration0001 from "../migrations/0001_audit_trail.sql?raw";
import migration0002 from "../migrations/0002_capability_rows.sql?raw";
import { AUDIT_OUTCOME_ACTION, AuditTrailService, auditRecorder, createAuditRoutes } from "../src/index.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as unknown as D1Like;

async function rawRows(ws: string) {
  return (await db.prepare("SELECT id, action, target_id, metadata_json, via_capability FROM audit_events WHERE workspace_id = ? ORDER BY rowid").bind(ws).all()).results;
}

beforeEach(async () => {
  expect.hasAssertions();
  await db.prepare("DROP TABLE IF EXISTS audit_events").run();
  await applyMigration(db, migration0001);
  await applyMigration(db, migration0002);
});

describe("auditRecorder (story 2.6)", () => {
  test("statement() is a branded, capability-marked insert that commits with the caller's batch, and is rolled back with it", async () => {
    const ok = auditRecorder.statement(db, "ws_a", { actorId: "op", action: "Platform.Test", targetType: "workspace", targetId: "ws_a", metadata: { reason: "r" } });
    expect(isAuditStatement(ok)).toBe(true);
    expect(ok.workspaceId).toBe("ws_a");
    await db.batch([db.prepare("SELECT 1"), ok.statement]);
    expect(await new AuditTrailService(db).list("ws_a")).toEqual([expect.objectContaining({ id: ok.id, actor_id: "op", actor_type: "user", action: "platform.test", metadata: { reason: "r" } })]);
    expect((await rawRows("ws_a"))[0]).toMatchObject({ via_capability: 1 });

    const doomed = auditRecorder.statement(db, "ws_a", { actorId: "op", action: "x", targetType: "t", targetId: "i" });
    await expect(db.batch([doomed.statement, db.prepare("INSERT INTO no_such_table VALUES (1)")])).rejects.toThrow();
    expect(await rawRows("ws_a")).toHaveLength(1);
  });

  test("with afterChange, the row is written only if the statement before it changed a row", async () => {
    await db.prepare("DROP TABLE IF EXISTS t_rows").run();
    await db.prepare("CREATE TABLE t_rows (id TEXT PRIMARY KEY, v INTEGER)").run();
    await db.prepare("INSERT INTO t_rows VALUES ('a', 0)").run();
    const skipped = auditRecorder.statement(db, "ws_a", { actorId: "op", action: "a", targetType: "t", targetId: "i" }, { afterChange: true });
    await db.batch([db.prepare("UPDATE t_rows SET v = 1 WHERE id = 'nope'"), skipped.statement]);
    expect(await rawRows("ws_a")).toEqual([]);
    const written = auditRecorder.statement(db, "ws_a", { actorId: "op", action: "a", targetType: "t", targetId: "i" }, { afterChange: true });
    await db.batch([db.prepare("UPDATE t_rows SET v = 1 WHERE id = 'a'"), written.statement]);
    expect(await rawRows("ws_a")).toHaveLength(1);
  });

  test("record() with a dedupe key writes one row per workspace and key; a second call returns the first row", async () => {
    const entry = { actorId: "op", action: "grant", targetType: "t", targetId: "i", metadata: { status: "pending", amount: "1" } };
    const [first, second] = await Promise.all([
      auditRecorder.record(db, "ws_a", entry, { dedupeKey: "k1" }),
      auditRecorder.record(db, "ws_a", { ...entry, metadata: { status: "pending", amount: "2" } }, { dedupeKey: "k1" }),
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.id).toBe(second.id);
    expect(second.created ? first.metadata : second.metadata).toEqual(second.created ? second.metadata : first.metadata);
    expect(await rawRows("ws_a")).toHaveLength(1);
    expect((await auditRecorder.record(db, "ws_b", entry, { dedupeKey: "k1" })).created).toBe(true);
  });

  test("outcomes are appended rows naming the pending row; the pending row never changes; pending without outcome is listed", async () => {
    const { id } = await auditRecorder.record(db, "ws_a", { actorId: "op", action: "grant", targetType: "t", targetId: "i", metadata: { status: "pending" } }, { dedupeKey: "k1" });
    const before = await rawRows("ws_a");
    expect((await auditRecorder.pendingWithoutOutcome(db, "ws_a")).map((r) => r.id)).toEqual([id]);
    expect((await auditRecorder.pendingAcrossWorkspaces(db)).rows.map((r) => [r.workspaceId, r.id])).toEqual([["ws_a", id]]);
    expect(await auditRecorder.latestOutcome(db, "ws_a", id)).toBeNull();

    const outcome = await auditRecorder.outcome(db, "ws_a", id, "op", { status: "applied" });
    const after = await rawRows("ws_a");
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({ id: outcome.id, action: AUDIT_OUTCOME_ACTION, target_id: id, via_capability: 1 });
    expect(await auditRecorder.pendingWithoutOutcome(db, "ws_a")).toEqual([]);
    expect((await auditRecorder.pendingAcrossWorkspaces(db)).rows).toEqual([]);
    expect(await auditRecorder.latestOutcome(db, "ws_a", id)).toEqual({ status: "applied" });
    expect(await auditRecorder.latestOutcome(db, "ws_b", id)).toBeNull();
  });

  test("rows without the capability marker are ignored by every recorder read", async () => {
    const { id } = await auditRecorder.record(db, "ws_a", { actorId: "op", action: "grant", targetType: "t", targetId: "i", metadata: { status: "pending" } }, { dedupeKey: "k1" });
    // Planted straight into the table (as the public route would write them): a fake pending row and a fake outcome.
    await db.prepare("INSERT INTO audit_events (id, workspace_id, actor_id, action, target_type, target_id, metadata_json) VALUES ('aud_fake', 'ws_a', 'm', 'platform.credits.grant', 'workspace', 'ws_a', ?)").bind(JSON.stringify({ status: "pending" })).run();
    await db.prepare("INSERT INTO audit_events (id, workspace_id, actor_id, action, target_type, target_id, metadata_json) VALUES ('aud_out', 'ws_a', 'm', 'audit.outcome', 'audit_event', ?, ?)").bind(id, JSON.stringify({ status: "applied" })).run();
    await db.prepare("INSERT INTO audit_events (id, workspace_id, actor_id, action, target_type, target_id, metadata_json, dedupe_key) VALUES ('aud_key', 'ws_a', 'm', 'platform.credits.grant', 'workspace', 'ws_a', ?, 'k2')").bind(JSON.stringify({ status: "pending", amount: "999" })).run();
    expect((await auditRecorder.pendingWithoutOutcome(db, "ws_a")).map((r) => r.id)).toEqual([id]);
    expect((await auditRecorder.pendingAcrossWorkspaces(db)).rows.map((r) => r.id)).toEqual([id]);
    expect(await auditRecorder.latestOutcome(db, "ws_a", id)).toBeNull();
    // A planted row under a key does not stand in for the capability's row either: the read-back finds no marked row.
    await expect(auditRecorder.record(db, "ws_a", { actorId: "op", action: "grant", targetType: "t", targetId: "i" }, { dedupeKey: "k2" })).rejects.toThrow();
  });

  test("only the actor types user and system are accepted; required fields and the metadata limit are enforced", async () => {
    for (const actorType of ["support_impersonator", "api_key", "root"]) {
      expect(() => auditRecorder.statement(db, "ws_a", { actorId: "op", actorType: actorType as never, action: "a", targetType: "t", targetId: "i" })).toThrow(RangeError);
    }
    expect(() => auditRecorder.statement(db, "ws_a", { actorId: "", action: "a", targetType: "t", targetId: "i" })).toThrow(RangeError);
    expect(() => auditRecorder.statement(db, "", { actorId: "op", action: "a", targetType: "t", targetId: "i" })).toThrow(RangeError);
    await expect(auditRecorder.record(db, "ws_a", { actorId: "op", action: "a", targetType: "t", targetId: "i", metadata: { big: "x".repeat(5000) } })).rejects.toThrow(RangeError);
    expect(await rawRows("ws_a")).toEqual([]);
  });
});

describe("the public audit route reserves the capability's action namespaces (story 2.6)", () => {
  test("a member cannot post platform.* or audit.* rows, so nothing can be planted as a pending grant or an outcome", async () => {
    const app = new Hono();
    app.use("*", stubWorkspaceContext);
    app.route("/", createAuditRoutes() as never);
    const post = (action: string, metadata: Record<string, unknown>) =>
      app.request(
        "/audit/events",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-workspace-id": "ws_a", "x-test-user": "member", "x-test-role": "member" },
          body: JSON.stringify({ action, targetType: "workspace", targetId: "ws_a", metadata }),
        },
        { DB: db },
      );
    for (const action of ["platform.credits.grant", "PLATFORM.workspace.suspend", " audit.outcome", "audit.anything"]) {
      const res = await post(action, { status: "pending", idempotencyKey: "k", amount: "5" });
      expect(res.status, action).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RESERVED_ACTION");
    }
    expect(await rawRows("ws_a")).toEqual([]);
    expect((await post("invoice.sent", {})).status).toBe(201);
    expect(await rawRows("ws_a")).toEqual([expect.objectContaining({ action: "invoice.sent", via_capability: 0 })]);
  });
});
