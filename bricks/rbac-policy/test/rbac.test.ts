import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_rbac_policy.sql?raw";
import { createRbacRoutes, RbacService, requirePermission } from "../src/index.ts";
import type { RbacEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const WS_A = "ws-alpha";
const WS_B = "ws-beta";
const USER_1 = "usr_111";
const USER_2 = "usr_222";

async function resetDb(): Promise<void> {
  for (const table of ["rbac_role_assignments", "rbac_permissions", "rbac_roles"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("RBAC & ABAC Policy Engine Core Logic", () => {
  it("creates roles with fine-grained permissions and retrieves them", async () => {
    const rbac = new RbacService(db);
    const result = await rbac.createRole(
      WS_A,
      "Editor",
      [
        { resource: "documents", action: "read" },
        { resource: "documents", action: "write" },
      ],
      "Can view and edit documents"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.role.name).toBe("Editor");
    expect(result.role.workspace_id).toBe(WS_A);

    const roles = await rbac.getRoles(WS_A);
    expect(roles).toHaveLength(1);
    expect(roles[0].name).toBe("Editor");
    expect(roles[0].permissions).toHaveLength(2);
  });

  it("checks exact, resource wildcard, and action wildcard permissions", async () => {
    const rbac = new RbacService(db);

    // Create custom role with action wildcard (documents:*)
    const editorRole = await rbac.createRole(WS_A, "DocMaster", [{ resource: "documents", action: "*" }]);
    if (!editorRole.ok) return;

    // Create role with resource wildcard (*:read)
    const readerRole = await rbac.createRole(WS_A, "Auditor", [{ resource: "*", action: "read" }]);
    if (!readerRole.ok) return;

    await rbac.assignRole(WS_A, USER_1, editorRole.role.id);
    await rbac.assignRole(WS_A, USER_2, readerRole.role.id);

    // User 1 has documents:* -> can read, write, and delete documents
    expect(await rbac.can(WS_A, USER_1, "documents", "read")).toBe(true);
    expect(await rbac.can(WS_A, USER_1, "documents", "delete")).toBe(true);
    // User 1 cannot access billing
    expect(await rbac.can(WS_A, USER_1, "billing", "write")).toBe(false);

    // User 2 has *:read -> can read documents and invoices, but cannot write
    expect(await rbac.can(WS_A, USER_2, "documents", "read")).toBe(true);
    expect(await rbac.can(WS_A, USER_2, "invoices", "read")).toBe(true);
    expect(await rbac.can(WS_A, USER_2, "documents", "write")).toBe(false);
  });

  it("superadmin wildcard (*:*) grants access to every resource and action", async () => {
    const rbac = new RbacService(db);
    const adminRole = await rbac.createRole(WS_A, "Admin", [{ resource: "*", action: "*" }]);
    if (!adminRole.ok) return;

    await rbac.assignRole(WS_A, USER_1, adminRole.role.id);

    expect(await rbac.can(WS_A, USER_1, "finance", "transfer")).toBe(true);
    expect(await rbac.can(WS_A, USER_1, "security", "rotate_keys")).toBe(true);
  });

  it("enforces strict multi-tenant boundary isolation", async () => {
    const rbac = new RbacService(db);

    // Give User 1 superadmin role in Workspace Alpha
    const adminRole = await rbac.createRole(WS_A, "Admin", [{ resource: "*", action: "*" }]);
    if (!adminRole.ok) return;
    await rbac.assignRole(WS_A, USER_1, adminRole.role.id);

    // In Workspace Alpha -> access granted
    expect(await rbac.can(WS_A, USER_1, "documents", "delete")).toBe(true);

    // In Workspace Beta -> access MUST BE DENIED!
    expect(await rbac.can(WS_B, USER_1, "documents", "delete")).toBe(false);
  });

  it("revoking a role immediately removes all associated capabilities", async () => {
    const rbac = new RbacService(db);
    const role = await rbac.createRole(WS_A, "Manager", [{ resource: "reports", action: "export" }]);
    if (!role.ok) return;

    await rbac.assignRole(WS_A, USER_1, role.role.id);
    expect(await rbac.can(WS_A, USER_1, "reports", "export")).toBe(true);

    const revoked = await rbac.revokeRole(WS_A, USER_1, role.role.id);
    expect(revoked).toBe(true);

    // Permission check immediately fails
    expect(await rbac.can(WS_A, USER_1, "reports", "export")).toBe(false);
  });
});

describe("RBAC Route Guards & Middleware Integration", () => {
  const createApp = (userId = USER_1, role = "member", wsId = WS_A) => {
    const app = new Hono<RbacEnv>();

    // Mock auth & workspace context
    app.use("*", async (c, next) => {
      c.set("user", { uid: userId, email: `${userId}@test.com` });
      c.set("workspace", { id: wsId, role });
      await next();
    });

    app.route("/api", createRbacRoutes());

    // Protected dummy endpoint
    app.get("/api/reports/financial", requirePermission("reports", "view_financial"), (c) =>
      c.json({ report: "top_secret_data" }, 200)
    );

    return app;
  };

  it("returns 403 Forbidden when caller lacks required permission", async () => {
    const app = createApp(USER_1, "member", WS_A);
    const res = await app.fetch(
      new Request("http://localhost/api/reports/financial"),
      { DB: db }
    );

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string; required: string };
    expect(json.error).toBe("Permission denied");
    expect(json.required).toBe("reports:view_financial");
  });

  it("passes request when caller is granted the required permission", async () => {
    const rbac = new RbacService(db);
    const role = await rbac.createRole(WS_A, "FinancialViewer", [{ resource: "reports", action: "view_financial" }]);
    if (!role.ok) return;
    await rbac.assignRole(WS_A, USER_1, role.role.id);

    const app = createApp(USER_1, "member", WS_A);
    const res = await app.fetch(
      new Request("http://localhost/api/reports/financial"),
      { DB: db }
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { report: string };
    expect(json.report).toBe("top_secret_data");
  });

  it("workspace owner automatically bypasses permission checks", async () => {
    // User is owner -> automatically allowed without explicit RBAC row
    const app = createApp(USER_1, "owner", WS_A);
    const res = await app.fetch(
      new Request("http://localhost/api/reports/financial"),
      { DB: db }
    );

    expect(res.status).toBe(200);
  });
});
