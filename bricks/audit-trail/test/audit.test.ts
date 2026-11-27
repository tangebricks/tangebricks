import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_audit_trail.sql?raw";
import { AuditTrailService, createAuditRoutes } from "../src/index.ts";
import type { AuditEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_aud_alpha";
const WS_BETA = "ws_aud_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS audit_events").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Audit Trail Ledger Core Logic", () => {
  it("records immutable audit events with actor and network context", async () => {
    const service = new AuditTrailService(db);
    const event = await service.record({
      workspaceId: WS_ALPHA,
      actorId: "usr_alice",
      actorType: "user",
      actorEmail: "alice@acme.com",
      action: "role.updated",
      targetType: "member",
      targetId: "usr_bob",
      ipAddress: "192.0.2.1",
      userAgent: "Mozilla/5.0 Chrome/120",
      metadata: { previousRole: "member", newRole: "admin" },
    });

    expect(event.id).toMatch(/^aud_[a-f0-9]{32}$/);
    expect(event.action).toBe("role.updated");
    expect(event.actor_email).toBe("alice@acme.com");
    expect(event.metadata).toEqual({ previousRole: "member", newRole: "admin" });

    const list = await service.list(WS_ALPHA);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(event.id);
  });

  it("filters audit queries by action, actor, and target", async () => {
    const service = new AuditTrailService(db);

    await service.record({
      workspaceId: WS_ALPHA,
      actorId: "usr_alice",
      action: "api_key.created",
      targetType: "api_key",
      targetId: "key_1",
    });

    await service.record({
      workspaceId: WS_ALPHA,
      actorId: "usr_alice",
      action: "member.invited",
      targetType: "member",
      targetId: "usr_charlie",
    });

    await service.record({
      workspaceId: WS_ALPHA,
      actorId: "usr_bob",
      action: "api_key.created",
      targetType: "api_key",
      targetId: "key_2",
    });

    // Filter by action
    const keyActions = await service.list(WS_ALPHA, { action: "api_key.created" });
    expect(keyActions).toHaveLength(2);

    // Filter by actor
    const aliceActions = await service.list(WS_ALPHA, { actorId: "usr_alice" });
    expect(aliceActions).toHaveLength(2);

    // Filter by both
    const aliceKeys = await service.list(WS_ALPHA, { actorId: "usr_alice", action: "api_key.created" });
    expect(aliceKeys).toHaveLength(1);
    expect(aliceKeys[0]?.target_id).toBe("key_1");
  });

  it("exports SOC2 compliance CSV with proper quoting and headers", async () => {
    const service = new AuditTrailService(db);
    await service.record({
      workspaceId: WS_ALPHA,
      actorId: "usr_alice",
      action: "policy.changed",
      targetType: "security_policy",
      targetId: "pol_mfa",
      metadata: { note: 'Enabled "Strict MFA" policy' },
    });

    const csv = await service.exportCsv(WS_ALPHA);
    const lines = csv.split("\n");

    expect(lines[0]).toContain("id,timestamp,actor_id,actor_type");
    expect(lines[1]).toContain('"policy.changed"');
    expect(lines[1]).toContain("Strict MFA");
  });

  it("strictly isolates audit logs between workspaces", async () => {
    const service = new AuditTrailService(db);
    await service.record({
      workspaceId: WS_ALPHA,
      actorId: "usr_1",
      action: "secret.viewed",
      targetType: "vault",
      targetId: "v_1",
    });

    await service.record({
      workspaceId: WS_BETA,
      actorId: "usr_2",
      action: "secret.viewed",
      targetType: "vault",
      targetId: "v_2",
    });

    const alphaEvents = await service.list(WS_ALPHA);
    const betaEvents = await service.list(WS_BETA);

    expect(alphaEvents).toHaveLength(1);
    expect(betaEvents).toHaveLength(1);
    expect(alphaEvents[0]?.target_id).toBe("v_1");
    expect(betaEvents[0]?.target_id).toBe("v_2");
  });
});

describe("Audit Trail HTTP API", () => {
  it("provides full HTTP workflow for recording, querying, and CSV export", async () => {
    const app = new Hono<AuditEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createAuditRoutes());

    // 1. POST /audit/events
    const createRes = await app.request(
      "/api/audit/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.195",
          "user-agent": "AuditAgent/1.0",
          "x-workspace-id": WS_ALPHA,
        },
        body: JSON.stringify({
          actorId: "usr_sec_admin",
          action: "ip_allowlist.updated",
          targetType: "firewall",
          targetId: "fw_rule_1",
          metadata: { allowedSubnets: ["10.0.0.0/8"] },
        }),
      },
      { DB: db },
    );
    expect(createRes.status).toBe(201);

    // 2. GET /audit/events
    const listRes = await app.request("/api/audit/events?action=ip_allowlist.updated", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { events: Array<{ ip_address: string; user_agent: string }> };
    expect(listJson.events).toHaveLength(1);
    expect(listJson.events[0]?.ip_address).toBe("203.0.113.195");
    expect(listJson.events[0]?.user_agent).toBe("AuditAgent/1.0");

    // 3. GET /audit/export
    const exportRes = await app.request("/api/audit/export", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("Content-Type")).toContain("text/csv");
    const csvContent = await exportRes.text();
    expect(csvContent).toContain("ip_allowlist.updated");
  });

  it("story 0.6: the actor comes from the session, never from body actorId/actorType/actorEmail (audit risk 21)", async () => {
    const app = new Hono<AuditEnv>();
    app.use("/api/*", async (c, next) => {
      c.set("user", { uid: "usr_carol", email: "carol@example.com" });
      await next();
    });
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createAuditRoutes());
    const res = await app.request(
      "/api/audit/events",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA, "x-test-user": "usr_carol", "x-test-role": "member" },
        body: JSON.stringify({
          actorId: "usr_ceo",
          actorType: "support_impersonator",
          actorEmail: "ceo@example.com",
          action: "billing.changed",
          targetType: "plan",
          targetId: "p1",
        }),
      },
      { DB: db },
    );
    expect(res.status).toBe(201);
    const events = await new AuditTrailService(db).list(WS_ALPHA, { action: "billing.changed" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_id: "usr_carol", actor_type: "user", actor_email: "carol@example.com" });
    expect(await new AuditTrailService(db).list(WS_ALPHA, { actorId: "usr_ceo" })).toHaveLength(0);
  });
});
