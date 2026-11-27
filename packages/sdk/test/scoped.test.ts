import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Like } from "../src/index.ts";
import { global, scoped, systemScope } from "../src/index.ts";

const db = env.DB as D1Like;

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS job_queues").run();
  await db.prepare("DROP TABLE IF EXISTS test_global").run();
  await db
    .prepare(
      `CREATE TABLE job_queues (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        queue_name TEXT NOT NULL,
        task_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued'
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE test_global (
        id TEXT PRIMARY KEY,
        setting_key TEXT NOT NULL,
        setting_value TEXT NOT NULL
      )`,
    )
    .run();
}

beforeEach(async () => {
  await resetDb();
});

describe("packages/sdk scoped() and global()", () => {
  it("satisfies AC1: first() returns null for cross-tenant row, insert() injects workspace_id and throws TENANT_ID_CONFLICT", async () => {
    const sA = scoped(db, "ws_a");
    const sB = scoped(db, "ws_b");

    await sB.insert("job_queues", {
      id: "job_b_1",
      queue_name: "default",
      task_type: "mail",
      payload_json: "{}",
    });

    // Cross-tenant first() returns null
    const crossTenant = await sA.first("job_queues", "id = ?", ["job_b_1"]);
    expect(crossTenant).toBeNull();

    // Tenant B can read its own row
    const ownRow = await sB.first<{ id: string; workspace_id: string }>("job_queues", "id = ?", ["job_b_1"]);
    expect(ownRow).not.toBeNull();
    expect(ownRow?.id).toBe("job_b_1");
    expect(ownRow?.workspace_id).toBe("ws_b");

    // Insert with matching or omitted workspace_id succeeds
    await sA.insert("job_queues", {
      id: "job_a_1",
      queue_name: "default",
      task_type: "sync",
      payload_json: "{}",
    });
    const insertedA = await sA.first<{ id: string; workspace_id: string }>("job_queues", "id = ?", ["job_a_1"]);
    expect(insertedA?.workspace_id).toBe("ws_a");

    // Insert with conflicting workspace_id throws TENANT_ID_CONFLICT
    await expect(
      sA.insert("job_queues", {
        id: "job_conflict",
        workspace_id: "ws_b",
        queue_name: "default",
        task_type: "sync",
        payload_json: "{}",
      }),
    ).rejects.toThrow(/TENANT_ID_CONFLICT/);
  });

  it("satisfies AC2: raw() throws TENANT_PREDICATE_MISSING naming the table when workspace_id predicate is absent", () => {
    const sA = scoped(db, "ws_a");

    expect(() => {
      sA.raw("SELECT * FROM job_queues WHERE id = ?");
    }).toThrow(/TENANT_PREDICATE_MISSING.*job_queues/);

    expect(() => {
      sA.raw("SELECT * FROM job_queues WHERE id = ?", ["job_1"]);
    }).toThrow(/TENANT_PREDICATE_MISSING.*job_queues/);

    // If predicate is present but workspaceId not bound, still throws
    expect(() => {
      sA.raw("SELECT * FROM job_queues WHERE id = ? AND workspace_id = ?", ["job_1", "ws_other"]);
    }).toThrow(/TENANT_PREDICATE_MISSING.*job_queues/);

    // If predicate is present and workspaceId is bound, statement is created
    const stmt = sA.raw("SELECT * FROM job_queues WHERE id = ? AND workspace_id = ?", ["job_1", "ws_a"]);
    expect(stmt).toBeDefined();
  });

  it("validates workspaceId: empty or malformed throws TENANT_ID_INVALID", () => {
    expect(() => scoped(db, "")).toThrow(/TENANT_ID_INVALID/);
    expect(() => scoped(db, "   ")).toThrow(/TENANT_ID_INVALID/);
    expect(() => scoped(db, "a".repeat(201))).toThrow(/TENANT_ID_INVALID/);
  });

  it("validates table and column names: malformed names throw INVALID_IDENTIFIER", async () => {
    const sA = scoped(db, "ws_a");

    await expect(sA.select("job_queues; DROP TABLE job_queues--")).rejects.toThrow(/INVALID_IDENTIFIER/);
    await expect(sA.insert("job_queues", { "bad-col-name": 123 })).rejects.toThrow(/INVALID_IDENTIFIER/);
  });

  it("enforces D1_BIND_LIMIT when statement binds > 100 parameters", async () => {
    const sA = scoped(db, "ws_a");
    const over100Params = Array.from({ length: 101 }, (_, i) => `val_${i}`);

    await expect(sA.select("job_queues", "id IN (" + over100Params.map(() => "?").join(",") + ")", over100Params)).rejects.toThrow(/D1_BIND_LIMIT/);
  });

  it("update and delete respect tenant boundary and reject cross-tenant mutations", async () => {
    const sA = scoped(db, "ws_a");
    const sB = scoped(db, "ws_b");

    await sB.insert("job_queues", {
      id: "job_b_2",
      queue_name: "default",
      task_type: "mail",
      status: "queued",
    });

    // ws_a cannot update ws_b row
    const updateRes = await sA.update("job_queues", { status: "completed" }, "id = ?", ["job_b_2"]);
    expect(updateRes.meta.changes).toBe(0);

    // Update with conflicting workspace_id throws TENANT_ID_CONFLICT
    await expect(sA.update("job_queues", { workspace_id: "ws_other", status: "completed" }, "id = ?", ["job_b_2"])).rejects.toThrow(/TENANT_ID_CONFLICT/);

    // ws_a cannot delete ws_b row
    const deleteRes = await sA.delete("job_queues", "id = ?", ["job_b_2"]);
    expect(deleteRes.meta.changes).toBe(0);

    // ws_b can update and delete its row
    const updateB = await sB.update("job_queues", { status: "running" }, "id = ?", ["job_b_2"]);
    expect(updateB.meta.changes).toBe(1);

    const deleteB = await sB.delete("job_queues", "id = ?", ["job_b_2"]);
    expect(deleteB.meta.changes).toBe(1);
  });

  it("global() allows operations on global table with mandatory reason", async () => {
    // Missing or empty reason throws GLOBAL_REASON_REQUIRED
    expect(() => global(db, "test_global", "")).toThrow(/GLOBAL_REASON_REQUIRED/);
    expect(() => global(db, "test_global", "   ")).toThrow(/GLOBAL_REASON_REQUIRED/);

    const g = global(db, "test_global", "system-settings-registry");
    expect(g.table).toBe("test_global");
    expect(g.reason).toBe("system-settings-registry");

    await g.insert({
      id: "set_1",
      setting_key: "rate_limit",
      setting_value: "1000",
    });

    const row = await g.first<{ id: string; setting_key: string }>("setting_key = ?", ["rate_limit"]);
    expect(row?.id).toBe("set_1");

    await g.update({ setting_value: "2000" }, "setting_key = ?", ["rate_limit"]);
    const updated = await g.first<{ setting_value: string }>("setting_key = ?", ["rate_limit"]);
    expect(updated?.setting_value).toBe("2000");

    await g.delete("setting_key = ?", ["rate_limit"]);
    const deleted = await g.first("setting_key = ?", ["rate_limit"]);
    expect(deleted).toBeNull();
  });

  it("systemScope() allows operations with mandatory reason", async () => {
    expect(() => systemScope(db, "")).toThrow(/SYSTEM_SCOPE_REASON_REQUIRED/);
    expect(() => systemScope(db, "   ")).toThrow(/SYSTEM_SCOPE_REASON_REQUIRED/);

    const sys = systemScope(db, "cross-tenant cron sweep");
    expect(sys.reason).toBe("cross-tenant cron sweep");

    await sys.insert("test_global", {
      id: "sys_1",
      setting_key: "cron_active",
      setting_value: "1",
    });

    const row = await sys.first<{ id: string; setting_key: string }>("test_global", "setting_key = ?", ["cron_active"]);
    expect(row?.id).toBe("sys_1");

    await sys.update("test_global", { setting_value: "0" }, "setting_key = ?", ["cron_active"]);
    const updated = await sys.first<{ setting_value: string }>("test_global", "setting_key = ?", ["cron_active"]);
    expect(updated?.setting_value).toBe("0");

    await sys.delete("test_global", "setting_key = ?", ["cron_active"]);
    const deleted = await sys.first("test_global", "setting_key = ?", ["cron_active"]);
    expect(deleted).toBeNull();
  });
});
