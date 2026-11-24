import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_data_privacy.sql?raw";
import {
  DataPrivacyService,
  createPrivacyRoutes,
} from "../src/index.ts";
import type { PrivacyEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_dpr_alpha";
const WS_BETA = "ws_dpr_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS dpr_export_requests").run();
  await db.prepare("DROP TABLE IF EXISTS dpr_erasure_requests").run();
  await db.prepare("DROP TABLE IF EXISTS dpr_consents").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Data Privacy & GDPR Core Service", () => {
  it("manages user consent preferences and enforces necessary cookies", async () => {
    const service = new DataPrivacyService(db);

    // Initial default: necessary = true, others = false
    const initial = await service.getConsents(WS_ALPHA, "usr_alice");
    expect(initial.necessary).toBe(true);
    expect(initial.analytics).toBe(false);
    expect(initial.marketing).toBe(false);

    // User accepts analytics & marketing
    const updated = await service.setConsents(
      WS_ALPHA,
      "usr_alice",
      { analytics: true, marketing: true },
      { ip: "192.0.2.1", userAgent: "Mozilla/5.0" }
    );

    expect(updated.necessary).toBe(true);
    expect(updated.analytics).toBe(true);
    expect(updated.marketing).toBe(true);
    expect(updated.preferences).toBe(false);

    // User revokes marketing
    const revoked = await service.setConsents(WS_ALPHA, "usr_alice", { marketing: false });
    expect(revoked.marketing).toBe(false);
    expect(revoked.analytics).toBe(true);
  });

  it("gathers user personal data across tenant hooks for Article 20 export", async () => {
    const service = new DataPrivacyService(db, {
      exportTenant: async (_db, { userId }) => ({
        profile: {
          userId,
          fullName: "Alice Wonderland",
          email: "alice@example.com",
        },
        order_history: [{ id: "ord_101", amount: 49.99, date: "2026-10-01" }],
      }),
    });

    // Set consents
    await service.setConsents(WS_ALPHA, "usr_alice", { analytics: true });

    // Request export
    const exportReq = await service.requestDataExport(WS_ALPHA, "usr_alice");
    expect(exportReq.id).toMatch(/^exp_[a-f0-9]{32}$/);
    expect(exportReq.status).toBe("completed");

    const data = exportReq.export_data as any;
    expect(data.user_id).toBe("usr_alice");
    expect(data.privacy_consents.analytics).toBe(true);
    expect(data.profile.fullName).toBe("Alice Wonderland");
    expect(data.order_history).toHaveLength(1);

    // Retrieve via ID
    const fetched = await service.getExportRequest(WS_ALPHA, exportReq.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.export_data).toEqual(data);
  });

  it("executes Article 17 Right to Erasure cascade deletion", async () => {
    const service = new DataPrivacyService(db);

    // Setup consents & export
    await service.setConsents(WS_ALPHA, "usr_bob", { analytics: true, marketing: true });
    await service.requestDataExport(WS_ALPHA, "usr_bob");

    // Execute erasure
    const erasure = await service.requestErasure(
      WS_ALPHA,
      "usr_bob",
      "Closing my account and requesting full data wipe"
    );

    expect(erasure.id).toMatch(/^ers_[a-f0-9]{32}$/);
    expect(erasure.status).toBe("completed");
    expect(erasure.deleted_records_count).toBeGreaterThanOrEqual(2);

    // Consents must be reset to defaults
    const consentsAfter = await service.getConsents(WS_ALPHA, "usr_bob");
    expect(consentsAfter.analytics).toBe(false);
    expect(consentsAfter.marketing).toBe(false);
  });

  it("enforces multi-tenant workspace isolation", async () => {
    const service = new DataPrivacyService(db);

    await service.setConsents(WS_ALPHA, "usr_charlie", { analytics: true });

    // In Beta workspace, charlie has default (false)
    const betaConsents = await service.getConsents(WS_BETA, "usr_charlie");
    expect(betaConsents.analytics).toBe(false);
  });
});

describe("Data Privacy REST Endpoints", () => {
  function createApp(workspaceId: string = WS_ALPHA, userId: string = "usr_dpr_user", role: string | null = "member") {
    const app = new Hono<PrivacyEnv>();
    app.use("*", async (c, next) => {
      if (role) {
        c.set("workspace", { id: workspaceId, role });
        c.set("ctx", Object.freeze({ userId, workspaceId, role }));
        c.set("user", { uid: userId, email: "user@dpr.com" });
      }
      await next();
    });
    app.route("/", createPrivacyRoutes());
    return app;
  }

  it("updates consents, requests data export, and triggers erasure via HTTP", async () => {
    const app = createApp(WS_ALPHA, "usr_dpr_user", "owner");

    // 1. Update Consents
    const consentRes = await app.request(
      "http://localhost/privacy/consents",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consents: { analytics: true, marketing: true },
        }),
      },
      { DB: db }
    );
    expect(consentRes.status).toBe(200);
    const consentJson = (await consentRes.json()) as any;
    expect(consentJson.consents.analytics).toBe(true);

    // 2. Request Export
    const exportRes = await app.request(
      "http://localhost/privacy/export",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      { DB: db }
    );
    expect(exportRes.status).toBe(201);
    const exportJson = (await exportRes.json()) as any;
    expect(exportJson.id).toBeDefined();
    expect(exportJson.status).toBe("completed");

    // 3. Request Erasure
    const eraseRes = await app.request(
      "http://localhost/privacy/erasure",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "User GDPR request via web UI" }),
      },
      { DB: db }
    );
    expect(eraseRes.status).toBe(201);
    const eraseJson = (await eraseRes.json()) as any;
    expect(eraseJson.status).toBe("completed");
    expect(eraseJson.deleted_records_count).toBeGreaterThanOrEqual(1);

    // 4. Fetch Erasure status
    const getEraseRes = await app.request(
      `http://localhost/privacy/erasure/${eraseJson.id}`,
      { method: "GET" },
      { DB: db }
    );
    expect(getEraseRes.status).toBe(200);
  });

  it("an owner of A naming workspace B for erasure is refused with 403 and nothing is erased (ADMIN_TARGET_MISMATCH)", async () => {
    const service = new DataPrivacyService(db);
    await service.setConsents(WS_ALPHA, "usr_a", { analytics: true });
    await service.setConsents(WS_BETA, "usr_b", { analytics: true });
    const count = async (ws: string) =>
      (await db.prepare("SELECT COUNT(*) AS n FROM dpr_consents WHERE workspace_id = ?").bind(ws).first<{ n: number }>())!.n;

    const app = createApp(WS_ALPHA, "usr_owner_a", "owner");
    // Query names B: refused, and neither workspace is touched.
    const byQuery = await app.request(`http://localhost/privacy/workspace?workspaceId=${WS_BETA}`, { method: "DELETE" }, { DB: db });
    expect(byQuery.status).toBe(403);
    expect(await count(WS_BETA)).toBe(1);
    expect(await count(WS_ALPHA)).toBe(1);

    // Body names B: refused the same way.
    const byBody = await app.request(
      "http://localhost/privacy/workspace",
      { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: WS_BETA }) },
      { DB: db },
    );
    expect(byBody.status).toBe(403);
    expect(await count(WS_BETA)).toBe(1);
    expect(await count(WS_ALPHA)).toBe(1);

    // Naming the verified workspace (or none) erases A only.
    const same = await app.request(`http://localhost/privacy/workspace?workspaceId=${WS_ALPHA}`, { method: "DELETE" }, { DB: db });
    expect(same.status).toBe(200);
    expect(((await same.json()) as { workspaceId: string }).workspaceId).toBe(WS_ALPHA);
    expect(await count(WS_ALPHA)).toBe(0);
    expect(await count(WS_BETA)).toBe(1);
  });

  it("story 0.6: export, erasure and workspace delete are owner-only (UNAUTH 401, member and admin 403, nothing changes)", async () => {
    const service = new DataPrivacyService(db);
    await service.setConsents(WS_ALPHA, "usr_a", { analytics: true });
    const counts = async () => {
      const q = async (sql: string) => Number((await db.prepare(sql).first<{ n: number }>())?.n ?? 0);
      return {
        consents: await q("SELECT COUNT(*) AS n FROM dpr_consents"),
        exports: await q("SELECT COUNT(*) AS n FROM dpr_export_requests"),
        erasures: await q("SELECT COUNT(*) AS n FROM dpr_erasure_requests"),
      };
    };
    const before = await counts();
    const json = { "Content-Type": "application/json" };
    for (const [role, status] of [[null, 401], ["member", 403], ["admin", 403]] as const) {
      const app = createApp(WS_ALPHA, "usr_caller", role);
      const exp = await app.request("http://localhost/privacy/export", { method: "POST", headers: json, body: JSON.stringify({ userId: "usr_a" }) }, { DB: db });
      expect(exp.status).toBe(status);
      const ers = await app.request("http://localhost/privacy/erasure", { method: "POST", headers: json, body: JSON.stringify({ userId: "usr_a" }) }, { DB: db });
      expect(ers.status).toBe(status);
      const bad = await app.request("http://localhost/privacy/erasure", { method: "POST", headers: json, body: JSON.stringify({ userId: 42 }) }, { DB: db });
      expect(bad.status).toBe(status);
      const ws = await app.request("http://localhost/privacy/workspace", { method: "DELETE" }, { DB: db });
      expect(ws.status).toBe(status);
    }
    expect(await counts()).toEqual(before);

    const owner = createApp(WS_ALPHA, "usr_owner", "owner");
    const exp = await owner.request("http://localhost/privacy/export", { method: "POST", headers: json, body: JSON.stringify({ userId: "usr_a" }) }, { DB: db });
    expect(exp.status).toBe(201);
  });

  it("story 0.6: GET /privacy/export/:id is owner-only (member 403, owner 200)", async () => {
    const record = await new DataPrivacyService(db).requestDataExport(WS_ALPHA, "usr_a");
    const read = (role: string | null) => createApp(WS_ALPHA, "usr_caller", role).request(`http://localhost/privacy/export/${record.id}`, {}, { DB: db });
    expect((await read(null)).status).toBe(401);
    expect((await read("member")).status).toBe(403);
    expect((await read("admin")).status).toBe(403);
    expect((await read("owner")).status).toBe(200);
  });

  it("story 0.6: consents — a member acts only on themselves; another userId needs owner/admin", async () => {
    const json = { "Content-Type": "application/json" };
    const set = (role: string, body: Record<string, unknown>) =>
      createApp(WS_ALPHA, "usr_self", role).request("http://localhost/privacy/consents", { method: "POST", headers: json, body: JSON.stringify(body) }, { DB: db });
    const get = (role: string, query = "") => createApp(WS_ALPHA, "usr_self", role).request(`http://localhost/privacy/consents${query}`, {}, { DB: db });
    const service = new DataPrivacyService(db);
    await service.setConsents(WS_ALPHA, "usr_other", { marketing: false });

    expect((await set("member", { userId: "usr_other", consents: { marketing: true } })).status).toBe(403);
    expect((await get("member", "?userId=usr_other")).status).toBe(403);
    expect((await service.getConsents(WS_ALPHA, "usr_other")).marketing).toBe(false);

    expect((await set("member", { consents: { analytics: true } })).status).toBe(200);
    expect((await set("member", { userId: "usr_self", consents: { analytics: true } })).status).toBe(200);
    expect((await get("member")).status).toBe(200);
    expect((await get("member", "?userId=usr_self")).status).toBe(200);

    expect((await set("admin", { userId: "usr_other", consents: { marketing: true } })).status).toBe(200);
    expect((await get("owner", "?userId=usr_other")).status).toBe(200);
    expect((await service.getConsents(WS_ALPHA, "usr_other")).marketing).toBe(true);
  });

  it("refuses with 400 when the workspace middleware did not run", async () => {
    const app = new Hono<PrivacyEnv>();
    app.route("/", createPrivacyRoutes());
    const res = await app.request(`http://localhost/privacy/consents?workspaceId=${WS_ALPHA}&userId=usr_a`, {}, { DB: db });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Missing workspace context");
  });
});
