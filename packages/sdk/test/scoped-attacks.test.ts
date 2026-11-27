import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Like } from "../src/index.ts";
import { scoped } from "../src/index.ts";

const db = env.DB as D1Like;

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS job_queues").run();
  await db
    .prepare(
      `CREATE TABLE job_queues (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        queue_name TEXT NOT NULL,
        task_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL DEFAULT '2026-01-01'
      )`,
    )
    .run();
}

beforeEach(async () => {
  await resetDb();
});

describe("packages/sdk scoped() attack resistance", () => {
  describe("1. where text rejection (WHERE_UNSAFE)", () => {
    it("rejects parentheses injection: 1=1) OR (1=1", async () => {
      const s = scoped(db, "ws_a");
      await expect(s.select("job_queues", "1=1) OR (1=1")).rejects.toThrow(/WHERE_UNSAFE/);
      await expect(s.first("job_queues", "1=1) OR (1=1")).rejects.toThrow(/WHERE_UNSAFE/);
      await expect(s.update("job_queues", { status: "failed" }, "1=1) OR (1=1")).rejects.toThrow(/WHERE_UNSAFE/);
      await expect(s.delete("job_queues", "1=1) OR (1=1")).rejects.toThrow(/WHERE_UNSAFE/);
    });

    it("rejects comments and trailing injection: ? IS NOT NULL OR 1=1) --", async () => {
      const s = scoped(db, "ws_a");
      await expect(s.select("job_queues", "? IS NOT NULL OR 1=1) --", ["val"])).rejects.toThrow(/WHERE_UNSAFE/);
    });

    it("rejects semicolons (stacked queries)", async () => {
      const s = scoped(db, "ws_a");
      await expect(s.select("job_queues", "status = 'queued'; DROP TABLE job_queues")).rejects.toThrow(/WHERE_UNSAFE/);
    });

    it("rejects block comments /* ... */", async () => {
      const s = scoped(db, "ws_a");
      await expect(s.select("job_queues", "status = 'queued' /* comment */")).rejects.toThrow(/WHERE_UNSAFE/);
    });

    it("rejects UNION expressions", async () => {
      const s = scoped(db, "ws_a");
      await expect(s.first("job_queues", "id = ? UNION SELECT 1,2,3,4,5,6,7", ["j1"])).rejects.toThrow(/WHERE_UNSAFE/);
    });

    it("rejects SELECT subqueries", async () => {
      const s = scoped(db, "ws_a");
      await expect(s.update("job_queues", { status: "failed" }, "id IN (SELECT id FROM job_queues)")).rejects.toThrow(/WHERE_UNSAFE/);
    });

    it("rejects unbalanced parentheses", async () => {
      const s = scoped(db, "ws_a");
      await expect(s.delete("job_queues", "status = 'queued' AND (status = 'failed'")).rejects.toThrow(/WHERE_UNSAFE/);
      await expect(s.select("job_queues", "status = 'queued')")).rejects.toThrow(/WHERE_UNSAFE/);
    });
  });

  describe("2. orderBy validation (ORDER_BY_UNSAFE)", () => {
    it("rejects subqueries in orderBy", async () => {
      const s = scoped(db, "ws_a");
      await expect(
        s.select("job_queues", "status = ?", ["queued"], {
          orderBy: "(SELECT count(*) FROM job_queues)",
        }),
      ).rejects.toThrow(/ORDER_BY_UNSAFE/);
    });

    it("rejects semicolons and comments in orderBy", async () => {
      const s = scoped(db, "ws_a");
      await expect(
        s.select("job_queues", undefined, undefined, {
          orderBy: "created_at; DROP TABLE job_queues",
        }),
      ).rejects.toThrow(/ORDER_BY_UNSAFE/);
    });

    it("allows valid orderBy identifiers and directions", async () => {
      const s = scoped(db, "ws_a");
      await s.insert("job_queues", {
        id: "j1",
        queue_name: "default",
        task_type: "mail",
        created_at: "2026-01-01",
      });

      const res1 = await s.select("job_queues", undefined, undefined, {
        orderBy: "created_at DESC",
      });
      expect(res1).toHaveLength(1);

      const res2 = await s.select("job_queues", undefined, undefined, {
        orderBy: "queue_name ASC, created_at DESC",
      });
      expect(res2).toHaveLength(1);
    });
  });

  describe("3. raw() strict verification", () => {
    it("blocks WHERE 1=1 OR workspace_id = ?", () => {
      const s = scoped(db, "ws_a");
      expect(() => {
        s.raw("SELECT * FROM job_queues WHERE 1=1 OR workspace_id = ?", ["ws_a"]);
      }).toThrow(/TENANT_PREDICATE_MISSING/);
    });

    it("blocks predicate inside a comment", () => {
      const s = scoped(db, "ws_a");
      expect(() => {
        s.raw("SELECT * FROM job_queues WHERE id = ? /* AND workspace_id = ? */", ["ws_a"]);
      }).toThrow(/TENANT_PREDICATE_MISSING/);
    });

    it("blocks scope id in a different slot", () => {
      const s = scoped(db, "ws_a");
      // Placeholder 0 is id, placeholder 1 is workspace_id
      // Caller passes ws_a into slot 0 and j1 into slot 1
      expect(() => {
        s.raw("SELECT * FROM job_queues WHERE id = ? AND workspace_id = ?", ["ws_a", "j1"]);
      }).toThrow(/TENANT_PREDICATE_MISSING/);
    });

    it("blocks UNION from another table", () => {
      const s = scoped(db, "ws_a");
      expect(() => {
        s.raw("SELECT * FROM job_queues WHERE workspace_id = ? UNION SELECT * FROM job_queues WHERE id = ?", ["ws_a", "j2"]);
      }).toThrow(/TENANT_PREDICATE_MISSING/);
    });

    it("blocks DELETE ... WHERE workspace_id = ? OR 1=1", () => {
      const s = scoped(db, "ws_a");
      expect(() => {
        s.raw("DELETE FROM job_queues WHERE workspace_id = ? OR 1=1", ["ws_a"]);
      }).toThrow(/TENANT_PREDICATE_MISSING/);
    });

    it("accepts valid top-level AND workspace_id = ? with matching slot", () => {
      const s = scoped(db, "ws_a");
      const stmt = s.raw("SELECT * FROM job_queues WHERE id = ? AND workspace_id = ?", ["j1", "ws_a"]);
      expect(stmt).toBeDefined();
    });

    it("blocks JOIN across tables", () => {
      const s = scoped(db, "ws_a");
      expect(() => {
        s.raw("SELECT jobs.id, secrets.v FROM job_queues jobs JOIN secrets ON 1=1 WHERE jobs.workspace_id = ?", ["ws_a"]);
      }).toThrow(/TENANT_PREDICATE_MISSING/);
    });

    it("blocks nested SELECT/subquery in UPDATE SET", () => {
      const s = scoped(db, "ws_a");
      expect(() => {
        s.raw("UPDATE job_queues SET task_type = (SELECT v FROM secrets LIMIT 1) WHERE workspace_id = ?", ["ws_a"]);
      }).toThrow(/TENANT_PREDICATE_MISSING/);
    });

    it("blocks multiple tables with comma in FROM list", () => {
      const s = scoped(db, "ws_a");
      expect(() => {
        s.raw("SELECT secrets.v FROM secrets, job_queues WHERE job_queues.workspace_id = ?", ["ws_a"]);
      }).toThrow(/TENANT_PREDICATE_MISSING/);
    });

    it("blocks INSERT ... SELECT subquery", () => {
      const s = scoped(db, "ws_a");
      expect(() => {
        s.raw("INSERT INTO job_queues (id, workspace_id) SELECT id, workspace_id FROM other_jobs WHERE workspace_id = ?", ["ws_a"]);
      }).toThrow(/TENANT_PREDICATE_MISSING/);
    });

    it("keeps working: SELECT * FROM jobs WHERE status = ? AND workspace_id = ?", () => {
      const s = scoped(db, "ws_a");
      const stmt = s.raw("SELECT * FROM job_queues WHERE status = ? AND workspace_id = ?", ["queued", "ws_a"]);
      expect(stmt).toBeDefined();
    });
  });

  describe("4. scoped().workspaceId runtime immutability", () => {
    it("freezes the scoped db instance and prevents mutating workspaceId", () => {
      const s = scoped(db, "ws_a");
      expect(Object.isFrozen(s)).toBe(true);

      expect(() => {
        // @ts-expect-error mutating readonly property
        s.workspaceId = "ws_tampered";
      }).toThrow();

      expect(s.workspaceId).toBe("ws_a");
    });
  });
});
