import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { assemble } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import shellWorker from "../../../out/max-compatible/src/index.ts";
import { computeMaxCompatible } from "../../../scripts/max-compatible.ts";
import presenceWorker from "../../../out/privacy-presence/src/index.ts";
import { PRIVACY_PRESENCE_BLUEPRINT } from "../../../test/support/blueprints.ts";

const db = env.DB as unknown as D1Like;
const WS_TEST = "ws_gdpr_test";
const OWNER_TEST = "usr_gdpr_owner";
const USER_TEST = "usr_gdpr_target";
const maxResult = computeMaxCompatible(catalog);

async function resetAndMigrate(): Promise<void> {
  // Drop all existing tables
  for (let pass = 0; pass < 3; pass += 1) {
    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts_%'"
      )
      .all<{ name: string }>();
    if (tables.results.length === 0) break;
    for (const row of [...tables.results].reverse()) {
      try {
        await db.prepare(`DROP TABLE IF EXISTS "${row.name}"`).run();
      } catch {
        // Ignored on intermediate passes
      }
    }
  }

  // Assemble max-compatible and apply migrations
  const maxResult = computeMaxCompatible(catalog);
  const asm = assemble({
    project: maxResult.project,
    bricks: maxResult.bricks,
    entities: [
      {
        name: "records",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "amount", type: "number" },
        ],
      },
    ],
  }, catalog);
  if (!asm.ok) throw new Error("Assembly failed: " + asm.errors.join("; "));

  const migrationEntries = Object.entries(asm.files)
    .filter(([k]) => k.startsWith("migrations/") && k.endsWith(".sql"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  for (const [, sql] of migrationEntries) {
    await applyMigration(db, sql);
  }
}

describe("Data Privacy GDPR - Erasure Coverage (UC9.2)", () => {
  beforeEach(async () => {
    expect.hasAssertions();
    await resetAndMigrate();
  });

  it("erases rows for target user across all tenant tables declaring user columns, except retain tables", async () => {
    // 1. Seed user rows in tenant tables that declare user columns
    // Core auth / workspace setup
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, 'Test WS', ?)").bind(WS_TEST, OWNER_TEST).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(WS_TEST, OWNER_TEST).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'member')").bind(WS_TEST, USER_TEST).run();

    // In-app notifications
    await db.prepare("INSERT INTO notif_notifications (id, workspace_id, user_id, title, body) VALUES ('notif_1', ?, ?, 'Hi', 'Hello')").bind(WS_TEST, USER_TEST).run();

    // Threaded discussions
    await db.prepare("INSERT INTO cmt_threads (id, workspace_id, target_type, target_id, title) VALUES ('th_1', ?, 'doc', 'd1', 'Thread')").bind(WS_TEST).run();
    await db.prepare("INSERT INTO cmt_comments (id, thread_id, workspace_id, author_id, author_name, body) VALUES ('cmt_1', 'th_1', ?, ?, 'Target User', 'Comment body')").bind(WS_TEST, USER_TEST).run();

    // Live chat
    await db.prepare("INSERT INTO chat_conversations (id, workspace_id, customer_id) VALUES ('chat_1', ?, 'cust_1')").bind(WS_TEST).run();
    await db.prepare("INSERT INTO chat_messages (id, conversation_id, workspace_id, sender_type, sender_id, sender_name, body) VALUES ('msg_1', 'chat_1', ?, 'customer', ?, 'Target User', 'Chat text')").bind(WS_TEST, USER_TEST).run();

    // Credit wallet & ledger
    await db.prepare("INSERT INTO credit_wallets (workspace_id, balance_milli) VALUES (?, 100000)").bind(WS_TEST).run();
    await db.prepare("INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason) VALUES ('led_1', ?, ?, 'topup', 100000, 100000, 'initial topup')").bind(WS_TEST, USER_TEST).run();
    await db.prepare("INSERT INTO credit_orders (order_id, workspace_id, user_id, amount, processed) VALUES ('ord_1', ?, ?, 100, 1)").bind(WS_TEST, USER_TEST).run();

    // Identity federation (only if included in max-compatible)
    if (maxResult.bricks.includes("identity-federation")) {
      await db.prepare("INSERT INTO sso_connections (id, workspace_id, domain, provider_type, display_name, client_id, issuer_url) VALUES ('sso_1', ?, 'example.com', 'oidc', 'Example SSO', 'cid_1', 'https://example.com')").bind(WS_TEST).run();
      await db.prepare("INSERT INTO sso_federated_identities (id, connection_id, workspace_id, external_subject_id, email, user_id) VALUES ('fed_1', 'sso_1', ?, 'sub1', 'target@example.com', ?)").bind(WS_TEST, USER_TEST).run();
    }

    // Integration connections
    await db.prepare("INSERT INTO int_oauth_states (state, workspace_id, user_id, provider, code_verifier, redirect_uri, expires_at) VALUES ('st_1', ?, ?, 'github', 'cv', 'https://example.com', 1900000000)").bind(WS_TEST, USER_TEST).run();

    // LLM Gateway
    await db.prepare("INSERT INTO ai_generation_logs (id, workspace_id, user_id, provider, model) VALUES ('gen_1', ?, ?, 'workers-ai', 'llama')").bind(WS_TEST, USER_TEST).run();

    // Product analytics
    await db.prepare("INSERT INTO evt_analytics_events (id, workspace_id, user_id, anonymous_id, event_name, timestamp) VALUES ('evt_1', ?, ?, 'anon_1', 'button_click', '2026-01-01T00:00:00Z')").bind(WS_TEST, USER_TEST).run();

    // RBAC policy
    await db.prepare("INSERT INTO rbac_roles (id, workspace_id, name) VALUES ('role_1', ?, 'admin')").bind(WS_TEST).run();
    await db.prepare("INSERT INTO rbac_role_assignments (workspace_id, user_id, role_id) VALUES (?, ?, 'role_1')").bind(WS_TEST, USER_TEST).run();

    // Realtime presence is quarantined (story 0.11) and not in max-compatible: see the privacy-presence test below.

    // User onboarding
    await db.prepare("INSERT INTO onb_flows (id, workspace_id, key, title, steps_json, created_at) VALUES ('flow_1', ?, 'welcome', 'Welcome', '[]', '2026-01-01T00:00:00Z')").bind(WS_TEST).run();
    await db.prepare("INSERT INTO onb_user_progress (id, flow_id, workspace_id, user_id, started_at) VALUES ('prog_1', 'flow_1', ?, ?, '2026-01-01T00:00:00Z')").bind(WS_TEST, USER_TEST).run();

    // Data privacy consents
    await db.prepare("INSERT INTO dpr_consents (id, user_id, workspace_id, category, granted, updated_at) VALUES ('con_1', ?, ?, 'analytics', 1, '2026-01-01T00:00:00Z')").bind(USER_TEST, WS_TEST).run();

    // Declared entity table
    await db.prepare("INSERT INTO ent_records (id, workspace_id, title, amount) VALUES ('rec_1', ?, 'Document record', 50)").bind(WS_TEST).run();

    // Retained tables: audit_events and asset_files
    await db.prepare("INSERT INTO audit_events (id, workspace_id, actor_id, action, target_type, target_id) VALUES ('aud_1', ?, ?, 'login', 'user', 'u1')").bind(WS_TEST, USER_TEST).run();
    await db.prepare("INSERT INTO asset_files (id, workspace_id, uploaded_by, filename, content_type, size_bytes, r2_key) VALUES ('ast_1', ?, ?, 'doc.pdf', 'application/pdf', 10, 'key1')").bind(WS_TEST, USER_TEST).run();

    // Story 0.6: export and erasure are owner-only, so the member cannot start them (not even for their own data).
    for (const path of ["/api/privacy/export", "/api/privacy/erasure"]) {
      const memberRes = await shellWorker.fetch(
        new Request(`https://example.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-workspace-id": WS_TEST, "x-test-user": USER_TEST },
          body: JSON.stringify({ userId: USER_TEST }),
        }),
        { DB: db }
      );
      expect(memberRes.status).toBe(403);
    }
    expect(await db.prepare("SELECT COUNT(*) AS n FROM dpr_erasure_requests").first<{ n: number }>()).toMatchObject({ n: 0 });

    // 2. AC2: Test personal data export returns document keyed by table (the owner exports the member's data)
    const exportResponse = await shellWorker.fetch(
      new Request("https://example.test/api/privacy/export", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": WS_TEST,
          "x-test-user": OWNER_TEST,
        },
        body: JSON.stringify({
          userId: USER_TEST,
        }),
      }),
      { DB: db }
    );
    expect(exportResponse.status).toBe(201);
    const exportBody = (await exportResponse.json()) as any;
    expect(exportBody.export_data).toBeDefined();
    expect(exportBody.export_data.notif_notifications).toHaveLength(1);
    expect(exportBody.export_data.cmt_comments).toHaveLength(1);
    expect(exportBody.export_data.chat_messages).toHaveLength(1);
    expect(exportBody.export_data.credit_ledger).toHaveLength(1);
    expect(exportBody.export_data.mw_members).toHaveLength(1);

    // 3. Call erasure endpoint (AC2)
    const response = await shellWorker.fetch(
      new Request("https://example.test/api/privacy/erasure", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": WS_TEST,
          "x-test-user": OWNER_TEST,
        },
        body: JSON.stringify({
          userId: USER_TEST,
          reason: "GDPR Article 17 Request",
        }),
      }),
      { DB: db }
    );

    expect(response.status).toBe(201);

    // 4. Verify user rows are 0 in all non-retain tenant tables that declare a user column
    const checkUserCount = async (table: string, col: string) => {
      const row = await db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE ${col} = ? AND workspace_id = ?`).bind(USER_TEST, WS_TEST).first<{ count: number }>();
      return row?.count ?? 0;
    };

    // User tables that must have 0 rows
    expect(await checkUserCount("notif_notifications", "user_id")).toBe(0);
    expect(await checkUserCount("cmt_comments", "author_id")).toBe(0);
    expect(await checkUserCount("chat_messages", "sender_id")).toBe(0);
    // Story 2.5: credit_ledger is retained (financial records; a transfer is two rows in two workspaces).
    expect(await checkUserCount("credit_ledger", "user_id")).toBe(1);
    expect(await checkUserCount("credit_orders", "user_id")).toBe(0);
    if (maxResult.bricks.includes("identity-federation")) {
      expect(await checkUserCount("sso_federated_identities", "user_id")).toBe(0);
    }
    expect(await checkUserCount("int_oauth_states", "user_id")).toBe(0);
    expect(await checkUserCount("ai_generation_logs", "user_id")).toBe(0);
    expect(await checkUserCount("mw_members", "user_id")).toBe(0);
    expect(await checkUserCount("evt_analytics_events", "user_id")).toBe(0);
    expect(await checkUserCount("rbac_role_assignments", "user_id")).toBe(0);
    expect(await checkUserCount("onb_user_progress", "user_id")).toBe(0);
    expect(await checkUserCount("dpr_consents", "user_id")).toBe(0);

    // Retained tables must still have rows
    expect(await checkUserCount("audit_events", "actor_id")).toBe(1);
    expect(await checkUserCount("asset_files", "uploaded_by")).toBe(1);

    // 5. AC3: Test workspace-level erasure (tenant offboarding)
    // Non-owner should be refused with 403
    const forbiddenRes = await shellWorker.fetch(
      new Request("https://example.test/api/privacy/workspace", {
        method: "DELETE",
        headers: {
          "x-workspace-id": WS_TEST,
          "x-test-user": "usr_random_attacker",
        },
      }),
      { DB: db }
    );
    expect(forbiddenRes.status).toBe(403);

    // Owner (OWNER_TEST) executes workspace erasure
    const wsErasureRes = await shellWorker.fetch(
      new Request("https://example.test/api/privacy/workspace", {
        method: "DELETE",
        headers: {
          "x-workspace-id": WS_TEST,
          "x-test-user": OWNER_TEST,
        },
      }),
      { DB: db }
    );
    expect(wsErasureRes.status).toBe(200);
    const wsErasureBody = (await wsErasureRes.json()) as any;
    expect(wsErasureBody.success).toBe(true);
    expect(wsErasureBody.deletedCount).toBeGreaterThan(0);
    expect(wsErasureBody.retain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "audit_events" }),
        expect.objectContaining({ table: "asset_files" }),
        // Story 2.5: money records are kept on workspace erasure too, with the reason the brick declares.
        expect.objectContaining({ table: "credit_ledger", reason: expect.stringMatching(/^Financial records, kept on both user and workspace erasure/) }),
      ])
    );

    // Check all non-retain workspace tables have 0 rows for this workspace
    const checkWsCount = async (table: string) => {
      const row = await db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE workspace_id = ?`).bind(WS_TEST).first<{ count: number }>();
      return row?.count ?? 0;
    };

    expect(await checkWsCount("credit_wallets")).toBe(0);
    expect(await checkWsCount("cmt_threads")).toBe(0);
    expect(await checkWsCount("chat_conversations")).toBe(0);
    if (maxResult.bricks.includes("identity-federation")) {
      expect(await checkWsCount("sso_connections")).toBe(0);
    }
    expect(await checkWsCount("rbac_roles")).toBe(0);
    expect(await checkWsCount("onb_flows")).toBe(0);
    expect(await checkWsCount("ent_records")).toBe(0);

    // Retained tables must STILL retain rows
    expect(await checkWsCount("audit_events")).toBe(1);
    expect(await checkWsCount("asset_files")).toBe(1);
  });
});

// realtime-presence is quarantined (story 0.11), so it is not in max-compatible. Its tables still declare privacy
// coverage, so erasure is checked against a small assembled app that includes it (test/support/global-setup.ts).
describe("Data Privacy GDPR - Erasure Coverage of realtime-presence tables", () => {
  it("user erasure removes the user's pres_sessions and workspace erasure removes pres_rooms", async () => {
    const asm = assemble(PRIVACY_PRESENCE_BLUEPRINT, catalog);
    if (!asm.ok) throw new Error("Assembly failed: " + asm.errors.join("; "));
    for (let pass = 0; pass < 3; pass += 1) {
      const tables = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts_%'")
        .all<{ name: string }>();
      if (tables.results.length === 0) break;
      for (const row of [...tables.results].reverse()) {
        try {
          await db.prepare(`DROP TABLE IF EXISTS "${row.name}"`).run();
        } catch {
          // Ignored on intermediate passes
        }
      }
    }
    const migrations = Object.entries(asm.files)
      .filter(([k]) => k.startsWith("migrations/") && k.endsWith(".sql"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [, sql] of migrations) await applyMigration(db, sql);

    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, 'Test WS', ?)").bind(WS_TEST, OWNER_TEST).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(WS_TEST, OWNER_TEST).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'member')").bind(WS_TEST, USER_TEST).run();
    await db.prepare("INSERT INTO pres_rooms (id, workspace_id, name) VALUES ('rm_1', ?, 'Lobby')").bind(WS_TEST).run();
    await db.prepare("INSERT INTO pres_sessions (id, workspace_id, room_id, user_id, user_name, last_heartbeat_at) VALUES ('sess_1', ?, 'rm_1', ?, 'Target User', 1000)").bind(WS_TEST, USER_TEST).run();
    await db.prepare("INSERT INTO pres_sessions (id, workspace_id, room_id, user_id, user_name, last_heartbeat_at) VALUES ('sess_2', ?, 'rm_1', ?, 'Owner', 1000)").bind(WS_TEST, OWNER_TEST).run();

    const count = async (sql: string, ...args: string[]) => (await db.prepare(sql).bind(...args).first<{ n: number }>())?.n ?? -1;

    const erasure = await presenceWorker.fetch(
      new Request("https://example.test/api/privacy/erasure", {
        method: "POST",
        headers: { "content-type": "application/json", "x-workspace-id": WS_TEST, "x-test-user": OWNER_TEST },
        body: JSON.stringify({ userId: USER_TEST, reason: "GDPR Article 17 Request" }),
      }),
      { DB: db },
    );
    expect(erasure.status).toBe(201);
    expect(await count("SELECT COUNT(*) AS n FROM pres_sessions WHERE user_id = ? AND workspace_id = ?", USER_TEST, WS_TEST)).toBe(0);
    // Only the target user's rows go: the owner's session and the room stay.
    expect(await count("SELECT COUNT(*) AS n FROM pres_sessions WHERE user_id = ? AND workspace_id = ?", OWNER_TEST, WS_TEST)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM pres_rooms WHERE workspace_id = ?", WS_TEST)).toBe(1);

    const wsErasure = await presenceWorker.fetch(
      new Request("https://example.test/api/privacy/workspace", {
        method: "DELETE",
        headers: { "x-workspace-id": WS_TEST, "x-test-user": OWNER_TEST },
      }),
      { DB: db },
    );
    expect(wsErasure.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM pres_rooms WHERE workspace_id = ?", WS_TEST)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM pres_sessions WHERE workspace_id = ?", WS_TEST)).toBe(0);
  });
});
