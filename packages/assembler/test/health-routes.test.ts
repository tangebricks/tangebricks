import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { SECRET_VALUE_PATTERNS } from "@poc/telemetry";
import { assemble, sha256Sync } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";

interface App {
  fetch(request: Request, env: unknown): Response | Promise<Response>;
}

const entry = import.meta.glob("../../../out/two-brick/src/index.ts", { eager: true }) as Record<string, { default: App }>;
const sql = import.meta.glob("../../../out/two-brick/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const app = Object.values(entry)[0]?.default;
const db = env.DB as D1Like;

describe("UC9.1 — Tracer: generated /healthz and /readyz in every assembled project", () => {
  beforeEach(async () => {
    // Reset schema
    for (const table of ["credit_ledger", "credit_orders", "credit_wallets", "mw_members", "mw_workspaces", "_projectx_migrations"]) {
      await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    }
  });

  test("AC1 & Task 1: GET /healthz returns 200 { ok: true, build: <bundle sha> } without auth", async () => {
    expect(app).toBeDefined();
    const res = await app!.fetch(new Request("http://localhost/healthz"), { DB: db });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.build).toBe("string");
    expect(body.build).toMatch(/^[0-9a-f]{12,64}$/);

    // Assert no secrets, table rows, or stack traces
    const bodyStr = JSON.stringify(body);
    for (const pattern of SECRET_VALUE_PATTERNS) {
      expect(bodyStr).not.toMatch(pattern);
    }
    expect(bodyStr).not.toMatch(/credit_wallets|mw_workspaces|balance|ledger/);
    expect(bodyStr).not.toContain("stack");
  });

  test("AC1 & Task 1: GET /readyz returns 200 with all checks ok when migrations are applied", async () => {
    expect(app).toBeDefined();

    // Create _projectx_migrations and apply migrations
    await db.prepare("CREATE TABLE IF NOT EXISTS _projectx_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)").run();
    for (const [path, sqlContent] of Object.entries(sql)) {
      const name = path.split("/").pop()!;
      await applyMigration(db, sqlContent);
      const hash = sha256Sync(sqlContent);
      await db.prepare("INSERT OR REPLACE INTO _projectx_migrations (name, sha256, applied_at) VALUES (?, ?, datetime('now'))").bind(name, hash).run();
    }

    const res = await app!.fetch(new Request("http://localhost/readyz"), { DB: db });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({
      d1: "ok",
      bindings: "ok",
      migrations: "ok",
    });

    // Assert no secrets, table rows, or stack traces
    const bodyStr = JSON.stringify(body);
    for (const pattern of SECRET_VALUE_PATTERNS) {
      expect(bodyStr).not.toMatch(pattern);
    }
    expect(bodyStr).not.toContain("stack");
  });

  test("AC1 & Task 1: GET /readyz returns 503 when a migration is missing from _projectx_migrations", async () => {
    expect(app).toBeDefined();

    // Create _projectx_migrations and apply only the first migration
    await db.prepare("CREATE TABLE IF NOT EXISTS _projectx_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)").run();
    const sortedPaths = Object.keys(sql).sort();
    const firstPath = sortedPaths[0]!;
    const firstName = firstPath.split("/").pop()!;
    await applyMigration(db, sql[firstPath]!);
    await db.prepare("INSERT INTO _projectx_migrations (name, sha256, applied_at) VALUES (?, ?, datetime('now'))").bind(firstName, sha256Sync(sql[firstPath]!)).run();

    // Every migration after the first is pending, in order.
    const pendingNames = sortedPaths.slice(1).map((p) => p.split("/").pop()!).join(", ");

    const res = await app!.fetch(new Request("http://localhost/readyz"), { DB: db });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect((body.checks as Record<string, string>)?.migrations).toBe(`pending: ${pendingNames}`);
    expect((body.checks as Record<string, string>)?.d1).toBe("ok");
    expect((body.checks as Record<string, string>)?.bindings).toBe("ok");

    const bodyStr = JSON.stringify(body);
    for (const pattern of SECRET_VALUE_PATTERNS) {
      expect(bodyStr).not.toMatch(pattern);
    }
    expect(bodyStr).not.toContain("stack");
  });

  test("AC1 & Task 1: GET /readyz returns 503 when DB binding is absent", async () => {
    expect(app).toBeDefined();

    // Calling app.fetch with empty env (no DB binding)
    const res = await app!.fetch(new Request("http://localhost/readyz"), {});
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect((body.checks as Record<string, string>)?.bindings).toBe("missing: DB");

    const bodyStr = JSON.stringify(body);
    for (const pattern of SECRET_VALUE_PATTERNS) {
      expect(bodyStr).not.toMatch(pattern);
    }
    expect(bodyStr).not.toContain("stack");
  });

  test("AC3: A declared entity named 'healthz' or 'readyz' is refused by the assembler", () => {
    const resHealthz = assemble(
      {
        project: "test-reserved-healthz",
        bricks: ["multi-workspace", "credit-wallet"],
        entities: [
          {
            name: "healthz",
            workspaceScoped: true,
            fields: [{ name: "title", type: "text" }],
          },
        ],
      },
      catalog,
    );
    expect(resHealthz.ok).toBe(false);
    if (!resHealthz.ok) {
      expect(resHealthz.errors.some((e) => e.includes("healthz"))).toBe(true);
    }

    const resReadyz = assemble(
      {
        project: "test-reserved-readyz",
        bricks: ["multi-workspace", "credit-wallet"],
        entities: [
          {
            name: "readyz",
            workspaceScoped: true,
            fields: [{ name: "title", type: "text" }],
          },
        ],
      },
      catalog,
    );
    expect(resReadyz.ok).toBe(false);
    if (!resReadyz.ok) {
      expect(resReadyz.errors.some((e) => e.includes("readyz"))).toBe(true);
    }
  });
});
