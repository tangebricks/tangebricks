import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_rbac_policy.sql?raw";
import mwMigration from "../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import { createRbacRoutes, RbacService, requirePermission } from "../src/index.ts";
import type { Permission, RbacRouteOptions } from "../src/index.ts";
import type { RbacEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const WS_A = "ws-alpha";
const WS_B = "ws-beta";
const USER_1 = "usr_111";
const USER_2 = "usr_222";

async function resetDb(): Promise<void> {
  for (const table of ["rbac_role_assignments", "rbac_permissions", "rbac_roles", "mw_invites", "mw_members", "mw_workspaces"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
  // The brick requires workspace-context, so an assembled app always carries the multi-workspace membership tables.
  await applyMigration(db, mwMigration);
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

// Story 0.19 (threat model B4-B7): you cannot grant what you do not hold, no self-assignment by non-owners, targets must
// be workspace members, permission strings are validated, and 500 bodies carry no DB text.
describe("RBAC grant escalation (story 0.19)", () => {
  const OWNER = "usr_owner";
  const MEMBER_U = "usr_target";
  const OUTSIDER = "usr_outsider";

  const appFor = (userId: string, role: string, options: RbacRouteOptions = {}) => {
    const app = new Hono<RbacEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { uid: userId });
      c.set("workspace", { id: WS_A, role });
      await next();
    });
    app.route("/api", createRbacRoutes(options));
    return app;
  };

  const post = async (app: Hono<RbacEnv>, path: string, body: unknown) => {
    const res = await app.fetch(
      new Request(`http://localhost/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { DB: db }
    );
    return { status: res.status, text: await res.text() };
  };

  async function addMember(userId: string, role: "owner" | "admin" | "member"): Promise<void> {
    await db.prepare("INSERT OR IGNORE INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, ?)").bind(WS_A, "Alpha", OWNER).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, ?)").bind(WS_A, userId, role).run();
  }

  /** Creates a role in WS_A directly through the service (no route checks) and returns its id. */
  async function makeRole(name: string, permissions: Permission[]): Promise<string> {
    const r = await new RbacService(db).createRole(WS_A, name, permissions);
    if (!r.ok) throw new Error(r.error);
    return r.role.id;
  }

  /** Gives `userId` a role carrying exactly `permissions`. */
  async function grant(userId: string, permissions: Permission[]): Promise<void> {
    const roleId = await makeRole(`grant-${userId}-${crypto.randomUUID()}`, permissions);
    await new RbacService(db).assignRole(WS_A, userId, roleId);
  }

  const assignmentCount = async (userId: string): Promise<number> =>
    (await db
      .prepare("SELECT COUNT(*) AS n FROM rbac_role_assignments WHERE workspace_id = ? AND user_id = ?")
      .bind(WS_A, userId)
      .first<{ n: number }>())!.n;
  const roleCount = async (): Promise<number> =>
    (await db.prepare("SELECT COUNT(*) AS n FROM rbac_roles WHERE workspace_id = ?").bind(WS_A).first<{ n: number }>())!.n;

  const P = (s: string): Permission => {
    const [resource, action] = s.split(":");
    return { resource: resource!, action: action! };
  };

  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await addMember(OWNER, "owner");
    await addMember(USER_1, "member");
    await addMember(MEMBER_U, "member");
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("ASSIGN_WITHIN_GRANT: roles:assign + docs:read may assign role{docs:read} to a member", async () => {
    await grant(USER_1, [P("roles:assign"), P("docs:read")]);
    const roleId = await makeRole("Reader", [P("docs:read")]);
    const res = await post(appFor(USER_1, "member"), "/roles/assign", { userId: MEMBER_U, roleId });
    expect(res.status).toBe(200);
    expect(await new RbacService(db).can(WS_A, MEMBER_U, "docs", "read")).toBe(true);
  });

  it("ASSIGN_EXCEEDS: roles:assign alone cannot assign a *:* role", async () => {
    await grant(USER_1, [P("roles:assign")]);
    const roleId = await makeRole("Admin", [P("*:*")]);
    const res = await post(appFor(USER_1, "member"), "/roles/assign", { userId: MEMBER_U, roleId });
    expect(res.status).toBe(403);
    const json = JSON.parse(res.text) as { code: string; missing: string[] };
    expect(json.code).toBe("GRANT_EXCEEDS_CALLER");
    expect(json.missing).toContain("*:*");
    expect(await assignmentCount(MEMBER_U)).toBe(0);
  });

  it("SELF_ASSIGN: a non-owner cannot assign any role to themselves, even one within their grants", async () => {
    await grant(USER_1, [P("roles:assign"), P("docs:read")]);
    const within = await makeRole("Reader", [P("docs:read")]);
    const admin = await makeRole("Admin", [P("*:*")]);
    const before = await assignmentCount(USER_1);
    for (const roleId of [within, admin]) {
      const res = await post(appFor(USER_1, "member"), "/roles/assign", { userId: USER_1, roleId });
      expect(res.status).toBe(403);
      expect((JSON.parse(res.text) as { code: string }).code).toBe("SELF_ASSIGNMENT_FORBIDDEN");
    }
    expect(await assignmentCount(USER_1)).toBe(before);
  });

  it("OWNER_ANY: the workspace owner may assign a *:* role to a member", async () => {
    const roleId = await makeRole("Admin", [P("*:*")]);
    const res = await post(appFor(OWNER, "owner"), "/roles/assign", { userId: MEMBER_U, roleId });
    expect(res.status).toBe(200);
    expect(await new RbacService(db).can(WS_A, MEMBER_U, "anything", "goes")).toBe(true);
  });

  it("NON_MEMBER: assigning to a user who is not in the workspace is 404 and writes nothing", async () => {
    const roleId = await makeRole("Reader", [P("docs:read")]);
    const res = await post(appFor(OWNER, "owner"), "/roles/assign", { userId: OUTSIDER, roleId });
    expect(res.status).toBe(404);
    expect((JSON.parse(res.text) as { code: string }).code).toBe("USER_NOT_IN_WORKSPACE");
    expect(await assignmentCount(OUTSIDER)).toBe(0);
  });

  it("an unknown role is still 404", async () => {
    const res = await post(appFor(OWNER, "owner"), "/roles/assign", { userId: MEMBER_U, roleId: "role_nope" });
    expect(res.status).toBe(404);
    expect(await assignmentCount(MEMBER_U)).toBe(0);
  });

  it("MEMBERSHIP_LOOKUP_FAILS: missing membership tables fail closed with a generic 500 and no row", async () => {
    const roleId = await makeRole("Reader", [P("docs:read")]);
    await db.prepare("DROP TABLE mw_members").run();
    const res = await post(appFor(OWNER, "owner"), "/roles/assign", { userId: MEMBER_U, roleId });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.text)).toEqual({ error: "Workspace membership unavailable" });
    expect(res.text).not.toMatch(/mw_members|no such table/i);
    expect(errorSpy).toHaveBeenCalled();
    expect(await assignmentCount(MEMBER_U)).toBe(0);
  });

  it("CREATE_WILDCARD: a roles:write holder cannot create a role with *:* or roles:assign they lack", async () => {
    await grant(USER_1, [P("roles:write")]);
    const before = await roleCount();
    for (const perm of ["*:*", "roles:assign"]) {
      const res = await post(appFor(USER_1, "member"), "/roles", { name: `Escalate ${perm}`, permissions: [P(perm)] });
      expect(res.status).toBe(403);
      const json = JSON.parse(res.text) as { code: string; missing: string[] };
      expect(json.code).toBe("GRANT_EXCEEDS_CALLER");
      expect(json.missing).toEqual([perm]);
    }
    expect(await roleCount()).toBe(before);
  });

  it("CREATE_WILDCARD: holding docs:* does not cover *:read", async () => {
    await grant(USER_1, [P("roles:write"), P("docs:*")]);
    const res = await post(appFor(USER_1, "member"), "/roles", { name: "Readers", permissions: [P("*:read")] });
    expect(res.status).toBe(403);
    expect((JSON.parse(res.text) as { missing: string[] }).missing).toEqual(["*:read"]);
  });

  it("CREATE_WITHIN: roles:write + docs:read may create role{docs:read}", async () => {
    await grant(USER_1, [P("roles:write"), P("docs:read")]);
    const res = await post(appFor(USER_1, "member"), "/roles", {
      name: "Reader",
      permissions: [{ resource: " Docs ", action: "READ" }],
    });
    expect(res.status).toBe(201);
    expect((JSON.parse(res.text) as { role: { permissions: Permission[] } }).role.permissions).toEqual([P("docs:read")]);
  });

  it("BAD_PERMISSION_STRING: a malformed resource or an empty action is 400 INVALID_PERMISSION", async () => {
    const before = await roleCount();
    for (const perm of [{ resource: "Docs Read!", action: "read" }, { resource: "docs", action: "" }]) {
      const res = await post(appFor(OWNER, "owner"), "/roles", { name: "Bad", permissions: [perm] });
      expect(res.status).toBe(400);
      expect((JSON.parse(res.text) as { code: string }).code).toBe("INVALID_PERMISSION");
    }
    expect(await roleCount()).toBe(before);
  });

  it("UNKNOWN_WITH_LIST: with knownPermissions set, an unlisted permission or wildcard is 400 UNKNOWN_PERMISSION", async () => {
    const options = { knownPermissions: ["docs:read", "docs:write", "docs:*"] };
    for (const perm of ["billing:refund", "*:*"]) {
      const res = await post(appFor(OWNER, "owner", options), "/roles", { name: "Unknown", permissions: [P(perm)] });
      expect(res.status).toBe(400);
      expect((JSON.parse(res.text) as { code: string }).code).toBe("UNKNOWN_PERMISSION");
    }
    const ok = await post(appFor(OWNER, "owner", options), "/roles", { name: "Docs", permissions: [P("docs:*")] });
    expect(ok.status).toBe(201);
  });

  it("REVOKE_EXCEEDS: a non-owner cannot revoke a role carrying a permission they lack", async () => {
    await grant(USER_1, [P("roles:assign"), P("docs:read")]);
    const admin = await makeRole("Admin", [P("*:*")]);
    await new RbacService(db).assignRole(WS_A, MEMBER_U, admin);
    const res = await post(appFor(USER_1, "member"), "/roles/revoke", { userId: MEMBER_U, roleId: admin });
    expect(res.status).toBe(403);
    expect((JSON.parse(res.text) as { code: string }).code).toBe("GRANT_EXCEEDS_CALLER");
    expect(await assignmentCount(MEMBER_U)).toBe(1);

    // Within their grants, revoking still works.
    const reader = await makeRole("Reader", [P("docs:read")]);
    await new RbacService(db).assignRole(WS_A, MEMBER_U, reader);
    const ok = await post(appFor(USER_1, "member"), "/roles/revoke", { userId: MEMBER_U, roleId: reader });
    expect(ok.status).toBe(200);
    expect((JSON.parse(ok.text) as { success: boolean }).success).toBe(true);
  });

  it("DB_ERROR_500: a failing insert returns a generic 500 without the DB text, and logs it", async () => {
    await db.prepare("DROP TABLE rbac_permissions").run();
    const res = await post(appFor(OWNER, "owner"), "/roles", { name: "Broken", permissions: [P("docs:read")] });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.text)).toEqual({ error: "Failed to create role" });
    expect(res.text).not.toMatch(/rbac_permissions|no such table|SQLITE/i);
    expect(errorSpy).toHaveBeenCalled();
  });
});
