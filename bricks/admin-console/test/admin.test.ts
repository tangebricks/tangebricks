import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_admin_console.sql?raw";
import {
  AdminConsoleService,
  createAdminRoutes,
} from "../src/index.ts";
import type { AdminEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_adm_alpha";
const WS_BETA = "ws_adm_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS adm_impersonation_sessions").run();
  await db.prepare("DROP TABLE IF EXISTS adm_tenant_overrides").run();
  await db.prepare("DROP TABLE IF EXISTS adm_super_admins").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Admin Console Service Core", () => {
  it("manages super admin role hierarchy and permission checks", async () => {
    const service = new AdminConsoleService(db);

    await service.addSuperAdmin("usr_super", "super@platform.app", "super_admin");
    await service.addSuperAdmin("usr_support", "support@platform.app", "support_agent");
    await service.addSuperAdmin("usr_auditor", "auditor@platform.app", "auditor");

    // Super Admin checks
    expect(await service.verifyAdminAccess("usr_super", "super_admin")).toBe(true);
    expect(await service.verifyAdminAccess("usr_super", "support_agent")).toBe(true);
    expect(await service.verifyAdminAccess("usr_super", "auditor")).toBe(true);

    // Support Agent checks
    expect(await service.verifyAdminAccess("usr_support", "super_admin")).toBe(false);
    expect(await service.verifyAdminAccess("usr_support", "support_agent")).toBe(true);
    expect(await service.verifyAdminAccess("usr_support", "auditor")).toBe(true);

    // Auditor checks
    expect(await service.verifyAdminAccess("usr_auditor", "super_admin")).toBe(false);
    expect(await service.verifyAdminAccess("usr_auditor", "support_agent")).toBe(false);
    expect(await service.verifyAdminAccess("usr_auditor", "auditor")).toBe(true);

    // Unknown user
    expect(await service.verifyAdminAccess("usr_regular", "auditor")).toBe(false);
  });

  it("sets tenant status override and enterprise custom limits", async () => {
    const service = new AdminConsoleService(db);
    await service.addSuperAdmin("usr_super", "super@platform.app", "super_admin");
    await service.addSuperAdmin("usr_support", "support@platform.app", "support_agent");

    // Support agent can suspend tenant
    const suspended = await service.setTenantStatus(
      "usr_support",
      WS_ALPHA,
      "suspended",
      "Billing delinquency on invoice #901"
    );
    expect(suspended.status).toBe("suspended");
    expect(suspended.reason).toBe("Billing delinquency on invoice #901");
    expect(suspended.updated_by).toBe("usr_support");

    // Support agent cannot change custom limits (needs super_admin)
    await expect(
      service.setTenantCustomLimits("usr_support", WS_ALPHA, { seatCount: 500 })
    ).rejects.toThrow("Super-admin privilege required");

    // Super admin can set custom enterprise limits
    const limits = await service.setTenantCustomLimits("usr_super", WS_ALPHA, {
      seatCount: 500,
      storageGb: 2000,
      unlimitedWebhooks: true,
    });
    expect(limits.custom_limits.seatCount).toBe(500);
    expect(limits.custom_limits.unlimitedWebhooks).toBe(true);
  });

  it("handles complete user impersonation lifecycle with expiration & invalidation", async () => {
    const service = new AdminConsoleService(db);
    await service.addSuperAdmin("usr_support", "support@platform.app", "support_agent");
    await service.addSuperAdmin("usr_auditor", "auditor@platform.app", "auditor");

    // 1. Must provide audit reason
    await expect(
      service.startImpersonationSession({
        adminUserId: "usr_support",
        impersonatedUserId: "usr_customer_42",
        workspaceId: WS_ALPHA,
        reason: "sh", // too short
      })
    ).rejects.toThrow("at least 5 characters");

    // 2. Start session
    const session = await service.startImpersonationSession({
      adminUserId: "usr_support",
      impersonatedUserId: "usr_customer_42",
      workspaceId: WS_ALPHA,
      reason: "Troubleshooting bug reported in ticket #1029",
      durationMinutes: 15,
    });

    expect(session.id).toMatch(/^imp_[a-f0-9]{32}$/);
    expect(session.session_token).toMatch(/^imp_tok_[a-f0-9]{64}$/);

    // 3. Verify session
    const check = await service.verifyImpersonationToken(session.session_token);
    expect(check.valid).toBe(true);
    expect(check.adminUserId).toBe("usr_support");
    expect(check.impersonatedUserId).toBe("usr_customer_42");
    expect(check.workspaceId).toBe(WS_ALPHA);

    // 4. End session
    const ended = await service.endImpersonationSession(session.session_token);
    expect(ended).toBe(true);

    // 5. Verification must now fail
    const checkAfter = await service.verifyImpersonationToken(session.session_token);
    expect(checkAfter.valid).toBe(false);
    expect(checkAfter.error).toContain("already been ended");

    // 6. Auditor can list sessions
    const logs = await service.listImpersonationSessions("usr_auditor", { workspaceId: WS_ALPHA });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.impersonated_user_id).toBe("usr_customer_42");
  });
});

describe("Admin Console REST API", () => {
  function createApp(callerUserId?: string) {
    const app = new Hono<AdminEnv>();
    app.use("*", async (c, next) => {
      if (callerUserId) {
        c.set("user", { uid: callerUserId, email: `${callerUserId}@test.com` });
      }
      await next();
    });
    app.use("*", stubWorkspaceContext);
    app.route("/", createAdminRoutes());
    return app;
  }

  it("protects admin endpoints against unauthorized callers and allows super admins", async () => {
    const service = new AdminConsoleService(db);
    await service.addSuperAdmin("usr_admin_god", "god@platform.app", "super_admin");

    const unauthApp = createApp("usr_regular_joe");

    // Regular user attempting to suspend tenant -> 403 Forbidden
    const deniedRes = await unauthApp.request(
      `http://localhost/admin/tenants/${WS_ALPHA}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "suspended", reason: "Hostile action" }),
      },
      { DB: db }
    );
    expect(deniedRes.status).toBe(403);

    // Super admin executing action -> 200 OK
    const adminApp = createApp("usr_admin_god");
    const allowedRes = await adminApp.request(
      `http://localhost/admin/tenants/${WS_ALPHA}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "suspended", reason: "Valid maintenance" }),
      },
      { DB: db }
    );
    expect(allowedRes.status).toBe(200);
    const updated = (await allowedRes.json()) as any;
    expect(updated.status).toBe("suspended");
  });

  it("handles impersonation create, verify, and end via HTTP", async () => {
    const service = new AdminConsoleService(db);
    await service.addSuperAdmin("usr_support_hero", "hero@platform.app", "support_agent");

    const app = createApp("usr_support_hero");

    // 1. Start impersonation
    const startRes = await app.request(
      "http://localhost/admin/impersonate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_BETA },
        body: JSON.stringify({
          impersonatedUserId: "usr_client_99",
          workspaceId: WS_BETA,
          reason: "Support investigation requested by customer",
        }),
      },
      { DB: db }
    );
    expect(startRes.status).toBe(201);
    const session = (await startRes.json()) as any;
    expect(session.session_token).toBeDefined();

    // 2. Verify token
    const verifyRes = await app.request(
      "http://localhost/admin/impersonate/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken: session.session_token }),
      },
      { DB: db }
    );
    expect(verifyRes.status).toBe(200);
    const verified = (await verifyRes.json()) as any;
    expect(verified.valid).toBe(true);
    expect(verified.impersonatedUserId).toBe("usr_client_99");

    // 3. End session
    const endRes = await app.request(
      "http://localhost/admin/impersonate/end",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken: session.session_token }),
      },
      { DB: db }
    );
    expect(endRes.status).toBe(200);
  });

  it("refuses an impersonation or a session listing that names a workspace other than the verified one", async () => {
    const service = new AdminConsoleService(db);
    await service.addSuperAdmin("usr_support_hero", "hero@platform.app", "super_admin");
    const app = createApp("usr_support_hero");

    const foreign = await app.request(
      "http://localhost/admin/impersonate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({ impersonatedUserId: "usr_client_99", workspaceId: WS_BETA, reason: "Support investigation requested" }),
      },
      { DB: db }
    );
    expect(foreign.status).toBe(403);
    expect(await service.listImpersonationSessions("usr_support_hero", { workspaceId: WS_BETA })).toHaveLength(0);

    // Without a body workspace the session is for the verified workspace.
    const own = await app.request(
      "http://localhost/admin/impersonate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({ impersonatedUserId: "usr_client_99", reason: "Support investigation requested" }),
      },
      { DB: db }
    );
    expect(own.status).toBe(201);
    expect(await service.listImpersonationSessions("usr_support_hero", { workspaceId: WS_ALPHA })).toHaveLength(1);

    const listForeign = await app.request(`http://localhost/admin/impersonations?workspaceId=${WS_BETA}`, { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listForeign.status).toBe(403);
    const listOwn = await app.request("http://localhost/admin/impersonations", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listOwn.status).toBe(200);
    expect(((await listOwn.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  describe("POST /admin/super-admins is platform-operator only (story 0.6, audit risk 4)", () => {
    const body = (userId: string) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, email: `${userId}@example.com`, role: "super_admin" }),
    });
    async function adminCount(): Promise<number> {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM adm_super_admins").first<{ n: number }>();
      return Number(row?.n ?? 0);
    }

    it("OPERATOR_WRITE: a user listed in PX_PLATFORM_OPERATORS creates a super-admin (201)", async () => {
      const res = await createApp("usr_operator").request("http://localhost/admin/super-admins", body("usr_new"), { DB: db, PX_PLATFORM_OPERATORS: "usr_operator" });
      expect(res.status).toBe(201);
      expect(await new AdminConsoleService(db).verifyAdminAccess("usr_new", "super_admin")).toBe(true);
    });

    it("an existing active super_admin in admin-console's table may create another", async () => {
      await new AdminConsoleService(db).addSuperAdmin("usr_admin_god", "god@platform.app", "super_admin");
      const res = await createApp("usr_admin_god").request("http://localhost/admin/super-admins", body("usr_new"), { DB: db });
      expect(res.status).toBe(201);
      expect(await adminCount()).toBe(2);
    });

    it("NON_OPERATOR_WRITE: a workspace owner who is not an operator (self-registration) gets 403 before validation", async () => {
      const app = createApp("usr_owner");
      const headers = { "x-workspace-id": WS_ALPHA, "x-test-user": "usr_owner", "x-test-role": "owner" };
      const env = { DB: db, PX_PLATFORM_OPERATORS: "usr_operator" };
      const self = await app.request("http://localhost/admin/super-admins", { ...body("usr_owner"), headers: { ...body("x").headers, ...headers } }, env);
      expect(self.status).toBe(403);
      const invalid = await app.request("http://localhost/admin/super-admins", { method: "POST", headers, body: "{bad" }, env);
      expect(invalid.status).toBe(403);
      expect(await adminCount()).toBe(0);
    });

    it("a support_agent is not enough to create a super-admin", async () => {
      await new AdminConsoleService(db).addSuperAdmin("usr_support", "s@platform.app", "support_agent");
      const res = await createApp("usr_support").request("http://localhost/admin/super-admins", body("usr_support"), { DB: db });
      expect(res.status).toBe(403);
      expect(await new AdminConsoleService(db).verifyAdminAccess("usr_support", "super_admin")).toBe(false);
    });

    it("NO_OPERATORS_CONFIGURED: with no env value and no super-admins, nobody can create one", async () => {
      const res = await createApp("usr_operator").request("http://localhost/admin/super-admins", body("usr_operator"), { DB: db });
      expect(res.status).toBe(403);
      expect(await adminCount()).toBe(0);
    });

    it("UNAUTH_ADMIN: no user gets 401", async () => {
      const res = await createApp().request("http://localhost/admin/super-admins", body("usr_x"), { DB: db, PX_PLATFORM_OPERATORS: "usr_x" });
      expect(res.status).toBe(401);
      expect(await adminCount()).toBe(0);
    });
  });
});
