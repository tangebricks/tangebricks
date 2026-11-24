import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_realtime_presence.sql?raw";
import {
  RealtimePresenceService,
  createPresenceRoutes,
} from "../src/index.ts";
import type { PresenceEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_pres_alpha";
const WS_BETA = "ws_pres_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS pres_sessions").run();
  await db.prepare("DROP TABLE IF EXISTS pres_rooms").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Realtime Presence & State Sync Core Logic", () => {
  it("tracks room presence with live cursor coordinates and viewing pills", async () => {
    const service = new RealtimePresenceService(db);

    // Alice joins document room
    const p1 = await service.heartbeat(
      WS_ALPHA,
      "doc_financial_model",
      { userId: "usr_alice", userName: "Alice Smith" },
      { cursor: { x: 350, y: 120, page: 2 }, status: "online" }
    );

    expect(p1.user_name).toBe("Alice Smith");
    expect(p1.cursor).toEqual({ x: 350, y: 120, page: 2 });

    // Bob joins same document room
    await service.heartbeat(
      WS_ALPHA,
      "doc_financial_model",
      { userId: "usr_bob", userName: "Bob Jones" },
      { cursor: { x: 100, y: 50, page: 1 }, status: "online" }
    );

    const roomPresence = await service.getRoomPresence(WS_ALPHA, "doc_financial_model");
    expect(roomPresence.active_count).toBe(2);
    expect(roomPresence.participants.map((p) => p.user_id)).toContain("usr_alice");
    expect(roomPresence.participants.map((p) => p.user_id)).toContain("usr_bob");
  });

  it("filters out expired sessions based on TTL window", async () => {
    const service = new RealtimePresenceService(db);

    await service.heartbeat(
      WS_ALPHA,
      "canvas_board",
      { userId: "usr_active", userName: "Active User" }
    );

    await service.heartbeat(
      WS_ALPHA,
      "canvas_board",
      { userId: "usr_stale", userName: "Stale User" }
    );

    // Manually age usr_stale's heartbeat to 60 seconds ago
    const staleTime = Date.now() - 60000;
    await db.prepare(
      "UPDATE pres_sessions SET last_heartbeat_at = ? WHERE user_id = 'usr_stale'"
    ).bind(staleTime).run();

    // Query with 30s TTL
    const presence = await service.getRoomPresence(WS_ALPHA, "canvas_board", 30);
    expect(presence.active_count).toBe(1);
    expect(presence.participants[0].user_id).toBe("usr_active");
  });

  it("handles explicit room departure", async () => {
    const service = new RealtimePresenceService(db);

    await service.heartbeat(
      WS_ALPHA,
      "chat_lounge",
      { userId: "usr_charlie", userName: "Charlie" }
    );

    expect((await service.getRoomPresence(WS_ALPHA, "chat_lounge")).active_count).toBe(1);

    const left = await service.leaveRoom(WS_ALPHA, "chat_lounge", "usr_charlie");
    expect(left).toBe(true);

    expect((await service.getRoomPresence(WS_ALPHA, "chat_lounge")).active_count).toBe(0);
  });

  it("strictly isolates presence rooms between workspaces", async () => {
    const service = new RealtimePresenceService(db);
    await service.heartbeat(WS_ALPHA, "general", { userId: "usr_a", userName: "Alpha User" });
    await service.heartbeat(WS_BETA, "general", { userId: "usr_b", userName: "Beta User" });

    const presA = await service.getRoomPresence(WS_ALPHA, "general");
    const presB = await service.getRoomPresence(WS_BETA, "general");

    expect(presA.active_count).toBe(1);
    expect(presA.participants[0].user_id).toBe("usr_a");
    expect(presB.active_count).toBe(1);
    expect(presB.participants[0].user_id).toBe("usr_b");
  });
});

describe("Realtime Presence HTTP API", () => {
  it("provides full HTTP workflow for presence, viewing pills, and status", async () => {
    const app = new Hono<PresenceEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createPresenceRoutes());

    // 1. POST /presence/heartbeat
    const hbRes = await app.request("/api/presence/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        roomName: "spreadsheet_q4",
        userId: "usr_sarah",
        userName: "Sarah Connor",
        cursor: { x: 500, y: 300 },
      }),
    }, { DB: db });
    expect(hbRes.status).toBe(200);

    // 2. GET /presence/rooms/:name
    const roomRes = await app.request("/api/presence/rooms/spreadsheet_q4", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(roomRes.status).toBe(200);
    const roomJson = (await roomRes.json()) as { presence: { active_count: number; participants: unknown[] } };
    expect(roomJson.presence.active_count).toBe(1);

    // 3. GET /presence/users/:userId
    const statusRes = await app.request("/api/presence/users/usr_sarah", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as { online: boolean; status: string };
    expect(statusJson.online).toBe(true);

    // 4. POST /presence/rooms/:name/leave
    const leaveRes = await app.request("/api/presence/rooms/spreadsheet_q4/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        userId: "usr_sarah",
      }),
    }, { DB: db });
    expect(leaveRes.status).toBe(200);

    // 5. Verify room count is now 0
    const reRoomRes = await app.request("/api/presence/rooms/spreadsheet_q4", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    const reRoomJson = (await reRoomRes.json()) as { presence: { active_count: number } };
    expect(reRoomJson.presence.active_count).toBe(0);
  });
});
