import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { D1Like } from "@poc/sdk";
import {
  checkMigrationsUp,
  checkTenantIsolation,
  checkIdempotentWrite,
  checkErrorContract,
  checkSecretScope,
  runBrickConformance,
} from "../src/conformance/index.ts";
import { createLeakyRoutes } from "./fixtures/leaky-brick/src/routes.ts";
import migrationSql from "./fixtures/leaky-brick/migrations/0001_leaky.sql?raw";
import manifest from "./fixtures/leaky-brick/brick.manifest.json" with { type: "json" };

const db = env.DB as D1Like;

describe("conformance kit against leaky fixture brick", () => {
  const migrations = { "migrations/0001_leaky.sql": migrationSql };

  it("fails CONF_TENANT_ISOLATION when route omits workspace_id predicate", async () => {
    const routes = createLeakyRoutes();
    await expect(
      checkTenantIsolation({
        manifest: manifest as any,
        routes,
        db,
        migrations,
        seed: async (d, { workspaceA, workspaceB }) => {
          await d
            .prepare("INSERT INTO leaky_items (id, workspace_id, name, val) VALUES (?, ?, ?, ?)")
            .bind("item_a_secret", workspaceA, "Confidential Item A", 100)
            .run();
          await d.prepare("INSERT INTO leaky_items (id, workspace_id, name, val) VALUES (?, ?, ?, ?)").bind("item_b_public", workspaceB, "Item B", 200).run();
        },
        testRequests: [
          {
            method: "GET",
            path: "/leaky/items/item_a_secret",
            callerWorkspaceId: "ws_conf_beta",
            targetWorkspaceId: "ws_conf_alpha",
          },
        ],
      }),
    ).rejects.toThrow(/CONF_TENANT_ISOLATION/);
  });

  it("fails CONF_IDEMPOTENT_WRITE when write route double-inserts on retry", async () => {
    const routes = createLeakyRoutes();
    await expect(
      checkIdempotentWrite({
        manifest: manifest as any,
        routes,
        db,
        migrations,
        writeRequests: [
          {
            method: "POST",
            path: "/leaky/items",
            body: { name: "Duplicated Item", val: 42 },
            headers: { "Idempotency-Key": "idemp_test_key_123" },
          },
        ],
      }),
    ).rejects.toThrow(/CONF_IDEMPOTENT_WRITE/);
  });

  it("fails CONF_ERROR_CONTRACT when handler returns bare string error", async () => {
    const routes = createLeakyRoutes();
    await expect(
      checkErrorContract({
        manifest: manifest as any,
        routes,
        db,
        migrations,
        errorRequests: [
          {
            method: "POST",
            path: "/leaky/fail",
            body: {},
          },
        ],
      }),
    ).rejects.toThrow(/CONF_ERROR_CONTRACT/);
  });

  it("fails CONF_MIGRATIONS_UP when a table lacks workspace_id and is not in globalTables", async () => {
    const badMigration = `CREATE TABLE rogue_table (id TEXT PRIMARY KEY, title TEXT);`;
    await expect(
      checkMigrationsUp({
        manifest: { ...manifest, globalTables: [] } as any,
        db,
        migrations: { "migrations/0001_bad.sql": badMigration },
      }),
    ).rejects.toThrow(/CONF_MIGRATIONS_UP/);
  });

  it("fails CONF_SECRET_SCOPE when route touches undeclared secret", async () => {
    const routes = createLeakyRoutes();
    await expect(
      checkSecretScope({
        manifest: manifest as any, // secrets array is empty in manifest
        routes,
        db,
        migrations,
        scopeRequests: [
          {
            method: "GET",
            path: "/leaky/secret-leak",
          },
        ],
      }),
    ).rejects.toThrow(/CONF_SECRET_SCOPE/);
  });

  it("rejects skipped checks with missing or empty reason", () => {
    expect(() => {
      runBrickConformance({
        manifest: manifest as any,
        routes: createLeakyRoutes(),
        skip: {
          CONF_IDEMPOTENT_WRITE: "" as any,
        },
      });
    }).toThrow(/requires a non-empty reason string/);
  });

  it("fails all route checks when brick has zero routes (vacuous pass prevention)", async () => {
    const emptyRoutes = new (await import("hono")).Hono();
    const opts = {
      manifest: { ...manifest, worker: { package: "@poc/empty", routes: [] } } as any,
      routes: emptyRoutes,
      db,
      migrations,
    };

    await expect(checkTenantIsolation(opts)).rejects.toThrow("[CONF_TENANT_ISOLATION] nothing to test: provide explicit routes/seed");
    await expect(checkIdempotentWrite(opts)).rejects.toThrow("[CONF_IDEMPOTENT_WRITE] nothing to test: provide explicit routes/seed");
    await expect(checkErrorContract(opts)).rejects.toThrow("[CONF_ERROR_CONTRACT] nothing to test: provide explicit routes/seed");
    await expect(checkSecretScope(opts)).rejects.toThrow("[CONF_SECRET_SCOPE] nothing to test: provide explicit routes/seed");
  });

  it("fails CONF_IDEMPOTENT_WRITE when brick has no write routes", async () => {
    const getOnly = new (await import("hono")).Hono();
    getOnly.get("/only-get", (c) => c.text("ok"));
    await expect(
      checkIdempotentWrite({
        manifest: manifest as any,
        routes: getOnly,
        db,
        migrations,
      }),
    ).rejects.toThrow("[CONF_IDEMPOTENT_WRITE] nothing to test: provide explicit routes/seed");
  });

  it("fails CONF_ERROR_CONTRACT when no tested requests return 4xx", async () => {
    const okOnly = new (await import("hono")).Hono();
    okOnly.post("/always-ok", (c) => c.json({ ok: true }, 200));
    await expect(
      checkErrorContract({
        manifest: manifest as any,
        routes: okOnly,
        db,
        migrations,
        errorRequests: [{ method: "POST", path: "/always-ok" }],
      }),
    ).rejects.toThrow("[CONF_ERROR_CONTRACT] nothing to test: provide explicit routes/seed");
  });

  it("fails CONF_TENANT_ISOLATION with positive control failure when route 404s for owning workspace (empty seed)", async () => {
    const routes = createLeakyRoutes();
    await expect(
      checkTenantIsolation({
        manifest: manifest as any,
        routes,
        db,
        migrations,
        seed: async () => {}, // empty seed: owning workspace will get 404
        testRequests: [
          {
            method: "GET",
            path: "/leaky/items/nonexistent_seed_item",
            callerWorkspaceId: "ws_conf_beta",
            targetWorkspaceId: "ws_conf_alpha",
          },
        ],
      }),
    ).rejects.toThrow(/cannot confirm isolation/);
  });

  it("permits globalRoutes over global tables without tenant leak failure", async () => {
    const Hono = (await import("hono")).Hono;
    const globalApp = new Hono();
    globalApp.get("/flags", (c) => c.json({ feature_enabled: true }, 200));

    await expect(
      checkTenantIsolation({
        manifest: {
          ...manifest,
          globalTables: [{ table: "flags", reason: "global flags" }],
        } as any,
        routes: globalApp,
        db,
        migrations,
        globalRoutes: ["/flags"],
      }),
    ).resolves.toBeUndefined();
  });

  it("substitutes :id-style path params in checkIdempotentWrite", async () => {
    const Hono = (await import("hono")).Hono;
    const paramApp = new Hono();
    let writeCount = 0;
    paramApp.post("/items/:id", async (c) => {
      const id = c.req.param("id");
      if (!id || id.startsWith(":")) {
        return c.json({ error: { code: "INVALID_PARAM", message: "unsubstituted param" } }, 400);
      }
      writeCount++;
      return c.json({ ok: true, id }, 200);
    });

    await checkIdempotentWrite({
      manifest: manifest as any,
      routes: paramApp,
      db,
      migrations,
    });
    expect(writeCount).toBe(2);
  });
});
