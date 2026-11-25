import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_feature_flags.sql?raw";
import {
  FeatureFlagService,
  hashToBucket,
  createFlagRoutes,
  requireFlag,
} from "../src/index.ts";
import type { FlagEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_flags_alpha";
const WS_BETA = "ws_flags_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS flag_overrides").run();
  await db.prepare("DROP TABLE IF EXISTS flag_definitions").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Feature Flags Service Core Logic", () => {
  it("defines flag and clamps percentage rollout between 0 and 100", async () => {
    const service = new FeatureFlagService(db);
    const flag = await service.defineFlag("beta_ui", "New UI redesign", true, 150);
    expect(flag.key).toBe("beta_ui");
    expect(flag.percentage_rollout).toBe(100);
    expect(flag.enabled_default).toBe(true);

    const fetched = await service.getFlag("beta_ui");
    expect(fetched).not.toBeNull();
    expect(fetched?.percentage_rollout).toBe(100);

    const flagMin = await service.defineFlag("alpha_feature", "Under development", false, -20);
    expect(flagMin.percentage_rollout).toBe(0);
  });

  it("evaluates deterministic hashing reliably for the same input", async () => {
    const bucket1 = hashToBucket("new_checkout", "user_123");
    const bucket2 = hashToBucket("new_checkout", "user_123");
    expect(bucket1).toBe(bucket2);
    expect(bucket1).toBeGreaterThanOrEqual(0);
    expect(bucket1).toBeLessThan(100);

    // Different keys or users yield different buckets
    const bucketOther = hashToBucket("old_checkout", "user_123");
    expect(typeof bucketOther).toBe("number");
  });

  it("evaluates global default and percentage rollouts", async () => {
    const service = new FeatureFlagService(db);

    // Non-existent flag is false
    expect(await service.isEnabled("missing_flag")).toBe(false);

    // Disabled default is false regardless of percentage
    await service.defineFlag("disabled_flag", "Off", false, 100);
    expect(await service.isEnabled("disabled_flag", { userId: "user_a" })).toBe(false);

    // Enabled with 100% rollout is true for everyone
    await service.defineFlag("global_flag", "On", true, 100);
    expect(await service.isEnabled("global_flag", { userId: "user_a" })).toBe(true);
    expect(await service.isEnabled("global_flag", { userId: "user_b" })).toBe(true);

    // Enabled with 0% rollout is false
    await service.defineFlag("zero_flag", "Zero", true, 0);
    expect(await service.isEnabled("zero_flag", { userId: "user_a" })).toBe(false);

    // Progressive rollout at 50%
    await service.defineFlag("split_flag", "Split", true, 50);
    // Find an identifier that hashes < 50 and one that hashes >= 50
    let enabledUser = "";
    let disabledUser = "";
    for (let i = 0; i < 100; i++) {
      const u = `test_user_${i}`;
      const bucket = hashToBucket("split_flag", u);
      if (bucket < 50 && !enabledUser) enabledUser = u;
      if (bucket >= 50 && !disabledUser) disabledUser = u;
      if (enabledUser && disabledUser) break;
    }

    expect(await service.isEnabled("split_flag", { userId: enabledUser })).toBe(true);
    expect(await service.isEnabled("split_flag", { userId: disabledUser })).toBe(false);
  });

  it("supports workspace-level overrides isolated per tenant", async () => {
    const service = new FeatureFlagService(db);
    await service.defineFlag("enterprise_sso", "SSO integration", false, 0);

    // By default, disabled for both
    expect(await service.isEnabled("enterprise_sso", { workspaceId: WS_ALPHA })).toBe(false);
    expect(await service.isEnabled("enterprise_sso", { workspaceId: WS_BETA })).toBe(false);

    // Override for WS_ALPHA to enabled
    await service.setOverride(WS_ALPHA, "enterprise_sso", true);
    expect(await service.isEnabled("enterprise_sso", { workspaceId: WS_ALPHA })).toBe(true);
    expect(await service.isEnabled("enterprise_sso", { workspaceId: WS_BETA })).toBe(false);

    // Override WS_ALPHA to disabled when flag is globally enabled
    await service.defineFlag("enterprise_sso", "SSO integration", true, 100);
    await service.setOverride(WS_ALPHA, "enterprise_sso", false);
    expect(await service.isEnabled("enterprise_sso", { workspaceId: WS_ALPHA })).toBe(false);
    expect(await service.isEnabled("enterprise_sso", { workspaceId: WS_BETA })).toBe(true);

    // Clear override for WS_ALPHA
    await service.clearOverride(WS_ALPHA, "enterprise_sso");
    expect(await service.isEnabled("enterprise_sso", { workspaceId: WS_ALPHA })).toBe(true);
  });

  it("clearOverride obeys allowOverrides=false and leaves the override in place (story 1.12)", async () => {
    const open = new FeatureFlagService(db, true);
    await open.defineFlag("beta_ui", "Beta UI", false, 0);
    await open.setOverride(WS_ALPHA, "beta_ui", true);

    const locked = new FeatureFlagService(db, false);
    expect(await locked.clearOverride(WS_ALPHA, "beta_ui")).toBe(false);
    expect(await locked.setOverride(WS_ALPHA, "beta_ui", false)).toBe(false);
    const row = await db.prepare("SELECT enabled FROM flag_overrides WHERE workspace_id = ? AND flag_key = ?").bind(WS_ALPHA, "beta_ui").first<{ enabled: number }>();
    expect(row?.enabled).toBe(1);
    // The open service still clears it.
    expect(await open.clearOverride(WS_ALPHA, "beta_ui")).toBe(true);
  });
});

describe("Feature Flags HTTP API & Route Guards", () => {
  it("defines flag, evaluates flag, sets override, and deletes override via API", async () => {
    const app = new Hono<FlagEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_ALPHA, role: "owner" });
      c.set("user", { uid: "usr_tester" });
      c.set("ctx", Object.freeze({ userId: "usr_tester", workspaceId: WS_ALPHA, role: "owner" }));
      await next();
    });
    app.route("/api", createFlagRoutes({ allowOverrides: true }));

    // 1. Define flag (usr_tester is a platform operator)
    const createRes = await app.request("/api/flags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "dark_mode",
        description: "Dark mode theme",
        enabledDefault: false,
        percentageRollout: 100,
      }),
    }, { DB: db, PX_PLATFORM_OPERATORS: "usr_tester" });
    expect(createRes.status).toBe(201);

    // 2. Evaluate flag -> should be false
    const evalRes1 = await app.request("/api/flags/dark_mode/evaluate", {}, { DB: db });
    expect(evalRes1.status).toBe(200);
    const evalJson1 = (await evalRes1.json()) as { enabled: boolean };
    expect(evalJson1.enabled).toBe(false);

    // 3. Set override for workspace
    const overrideRes = await app.request("/api/flags/dark_mode/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }, { DB: db });
    expect(overrideRes.status).toBe(200);

    // 4. Re-evaluate flag -> should now be true
    const evalRes2 = await app.request("/api/flags/dark_mode/evaluate", {}, { DB: db });
    expect(evalRes2.status).toBe(200);
    const evalJson2 = (await evalRes2.json()) as { enabled: boolean };
    expect(evalJson2.enabled).toBe(true);

    // 5. Delete override
    const delRes = await app.request("/api/flags/dark_mode/override", {
      method: "DELETE",
    }, { DB: db });
    expect(delRes.status).toBe(200);

    // 6. Re-evaluate -> reverted to false
    const evalRes3 = await app.request("/api/flags/dark_mode/evaluate", {}, { DB: db });
    const evalJson3 = (await evalRes3.json()) as { enabled: boolean };
    expect(evalJson3.enabled).toBe(false);
  });

  it("requireFlag guard passes when flag enabled and returns 404 when disabled", async () => {
    const service = new FeatureFlagService(db);
    await service.defineFlag("v2_billing", "Billing v2", false, 0);

    const app = new Hono<FlagEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: WS_ALPHA, role: "owner" });
      await next();
    });
    app.get("/api/v2/invoices", requireFlag("v2_billing"), (c) => {
      return c.json({ data: ["inv_1", "inv_2"] });
    });

    // Guard rejects when disabled
    const resBlocked = await app.request("/api/v2/invoices", {}, { DB: db });
    expect(resBlocked.status).toBe(404);

    // Override flag to enabled
    await service.setOverride(WS_ALPHA, "v2_billing", true);

    // Guard allows when enabled
    const resAllowed = await app.request("/api/v2/invoices", {}, { DB: db });
    expect(resAllowed.status).toBe(200);
    const body = (await resAllowed.json()) as { data: string[] };
    expect(body.data).toEqual(["inv_1", "inv_2"]);
  });
});

describe("Feature Flags authorisation (story 0.6)", () => {
  function appAs(caller?: { uid: string; role: string }): Hono<FlagEnv> {
    const app = new Hono<FlagEnv>();
    app.use("*", async (c, next) => {
      if (caller) {
        c.set("user", { uid: caller.uid });
        c.set("workspace", { id: WS_ALPHA, role: caller.role });
        c.set("ctx", Object.freeze({ userId: caller.uid, workspaceId: WS_ALPHA, role: caller.role }));
      }
      await next();
    });
    app.route("/api", createFlagRoutes({ allowOverrides: true }));
    return app;
  }
  const flagBody = JSON.stringify({ key: "global_switch", enabledDefault: true });
  const post = (body: string) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body });
  async function flagCount(): Promise<number> {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM flag_definitions").first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  it("OPERATOR_WRITE: a user listed in PX_PLATFORM_OPERATORS defines a global flag (201)", async () => {
    const res = await appAs({ uid: "op_1", role: "member" }).request("/api/flags", post(flagBody), { DB: db, PX_PLATFORM_OPERATORS: "op_0,op_1" });
    expect(res.status).toBe(201);
    expect(await flagCount()).toBe(1);
  });

  it("NON_OPERATOR_WRITE: a workspace owner who is not an operator is refused (403), nothing written", async () => {
    const res = await appAs({ uid: "owner_1", role: "owner" }).request("/api/flags", post(flagBody), { DB: db, PX_PLATFORM_OPERATORS: "op_1" });
    expect(res.status).toBe(403);
    expect(await flagCount()).toBe(0);
  });

  it("NO_OPERATORS_CONFIGURED: with no PX_PLATFORM_OPERATORS every flag definition write is refused", async () => {
    const res = await appAs({ uid: "op_1", role: "owner" }).request("/api/flags", post(flagBody), { DB: db });
    expect(res.status).toBe(403);
    expect(await flagCount()).toBe(0);
  });

  it("UNAUTH_ADMIN: no user gets 401 on flag definition and override routes", async () => {
    const app = appAs();
    const env = { DB: db, PX_PLATFORM_OPERATORS: "op_1" };
    expect((await app.request("/api/flags", post(flagBody), env)).status).toBe(401);
    expect((await app.request("/api/flags/global_switch/override", post(JSON.stringify({ enabled: true })), env)).status).toBe(401);
    expect((await app.request("/api/flags/global_switch/override", { method: "DELETE" }, env)).status).toBe(401);
    expect(await flagCount()).toBe(0);
  });

  it("MEMBER_ADMIN: a plain member gets 403 (not 400) on override set/clear and nothing changes", async () => {
    const service = new FeatureFlagService(db, true);
    await service.defineFlag("paid_gate", "Paid gate", false, 100);
    await service.setOverride(WS_ALPHA, "paid_gate", false);
    const app = appAs({ uid: "member_1", role: "member" });
    expect((await app.request("/api/flags/paid_gate/override", post("not json"), { DB: db })).status).toBe(403);
    expect((await app.request("/api/flags/paid_gate/override", post(JSON.stringify({ enabled: true })), { DB: db })).status).toBe(403);
    expect((await app.request("/api/flags/paid_gate/override", { method: "DELETE" }, { DB: db })).status).toBe(403);
    expect(await service.isEnabled("paid_gate", { workspaceId: WS_ALPHA, userId: "member_1" })).toBe(false);
    const overrides = await db.prepare("SELECT COUNT(*) AS n FROM flag_overrides").first<{ n: number }>();
    expect(Number(overrides?.n)).toBe(1);
  });

  it("ADMIN_OK: an admin sets and clears a workspace override", async () => {
    const service = new FeatureFlagService(db, true);
    await service.defineFlag("paid_gate", "Paid gate", false, 100);
    const app = appAs({ uid: "admin_1", role: "admin" });
    expect((await app.request("/api/flags/paid_gate/override", post(JSON.stringify({ enabled: true })), { DB: db })).status).toBe(200);
    expect(await service.isEnabled("paid_gate", { workspaceId: WS_ALPHA, userId: "admin_1" })).toBe(true);
    expect((await app.request("/api/flags/paid_gate/override", { method: "DELETE" }, { DB: db })).status).toBe(200);
    expect(await service.isEnabled("paid_gate", { workspaceId: WS_ALPHA, userId: "admin_1" })).toBe(false);
    // An override for a flag nobody defined is a 404, not a foreign-key 500.
    expect((await app.request("/api/flags/no_such_flag/override", post(JSON.stringify({ enabled: true })), { DB: db })).status).toBe(404);
  });
});
