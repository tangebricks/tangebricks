import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_in_app_notifications.sql?raw";
import mwMigration from "../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import { NotificationService, createNotificationRoutes } from "../src/index.ts";
import type { NotificationEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const USER_ALICE = "usr_notif_alice";
const USER_BOB = "usr_notif_bob";
const WS_ALPHA = "ws_notif_alpha";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS notif_notifications").run();
  await applyMigration(db, migration);
  await applyMigration(db, mwMigration);
  await db.prepare("DELETE FROM mw_members").run();
}

async function addMember(workspaceId: string, userId: string, role: string): Promise<void> {
  await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, ?)").bind(workspaceId, userId, role).run();
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("In-App Notification Service Core Logic", () => {
  it("creates notifications and tracks unread count", async () => {
    const service = new NotificationService(db);

    expect(await service.getUnreadCount(USER_ALICE)).toBe(0);

    const n1 = await service.create({
      userId: USER_ALICE,
      workspaceId: WS_ALPHA,
      title: "Invoice Generated",
      body: "Your invoice #1001 is ready for download",
      type: "success",
      actionUrl: "/invoices/1001",
    });

    await service.create({
      userId: USER_ALICE,
      workspaceId: WS_ALPHA,
      title: "Security Alert",
      body: "New login detected from Tokyo",
      type: "warning",
    });

    expect(n1.id).toMatch(/^ntf_[a-f0-9]{32}$/);
    expect(await service.getUnreadCount(USER_ALICE)).toBe(2);

    // List unread notifications
    const unread = await service.list(USER_ALICE, { unreadOnly: true });
    expect(unread).toHaveLength(2);
    expect(unread[0]?.title).toBe("Security Alert"); // Most recent first
  });

  it("marks individual notification as read and reflects in badge count", async () => {
    const service = new NotificationService(db);
    const n = await service.create({
      userId: USER_ALICE,
      title: "Welcome!",
      body: "Thanks for joining ProjectX",
    });

    expect(await service.getUnreadCount(USER_ALICE)).toBe(1);

    const changed = await service.markAsRead(n.id, USER_ALICE);
    expect(changed).toBe(true);

    expect(await service.getUnreadCount(USER_ALICE)).toBe(0);

    // Calling markAsRead again returns false since it is already read
    expect(await service.markAsRead(n.id, USER_ALICE)).toBe(false);
  });

  it("marks all notifications as read in a single batch", async () => {
    const service = new NotificationService(db);
    await service.create({ userId: USER_ALICE, title: "Alert 1", body: "B1" });
    await service.create({ userId: USER_ALICE, title: "Alert 2", body: "B2" });
    await service.create({ userId: USER_ALICE, title: "Alert 3", body: "B3" });

    expect(await service.getUnreadCount(USER_ALICE)).toBe(3);

    const count = await service.markAllAsRead(USER_ALICE);
    expect(count).toBe(3);

    expect(await service.getUnreadCount(USER_ALICE)).toBe(0);
  });

  it("strictly isolates notifications between users", async () => {
    const service = new NotificationService(db);
    const nAlice = await service.create({ userId: USER_ALICE, title: "Alice Secret", body: "A" });
    await service.create({ userId: USER_BOB, title: "Bob Secret", body: "B" });

    // Bob cannot list Alice's notifications
    const bobsList = await service.list(USER_BOB);
    expect(bobsList).toHaveLength(1);
    expect(bobsList[0]?.title).toBe("Bob Secret");

    // Bob cannot mark Alice's notification as read
    const hackRead = await service.markAsRead(nAlice.id, USER_BOB);
    expect(hackRead).toBe(false);

    // Bob cannot delete Alice's notification
    const hackDel = await service.delete(nAlice.id, USER_BOB);
    expect(hackDel).toBe(false);

    // Alice deletes her notification
    const aliceDel = await service.delete(nAlice.id, USER_ALICE);
    expect(aliceDel).toBe(true);
  });
});

describe("In-App Notification HTTP API", () => {
  it("protects endpoints from unauthenticated callers", async () => {
    const app = new Hono<NotificationEnv>();
    app.route("/api", createNotificationRoutes());

    const res = await app.request("/api/notifications", {}, { DB: db });
    expect(res.status).toBe(401);
  });

  it("provides full HTTP workflow for notifications", async () => {
    const app = new Hono<NotificationEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { uid: USER_ALICE, email: "alice@example.com" });
      c.set("workspace", { id: WS_ALPHA });
      c.set("ctx", Object.freeze({ userId: USER_ALICE, workspaceId: WS_ALPHA, role: "owner" }));
      await next();
    });
    app.route("/api", createNotificationRoutes());
    await addMember(WS_ALPHA, USER_ALICE, "owner");

    // 1. POST /notifications
    const createRes = await app.request(
      "/api/notifications",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Deployment Finished",
          body: "Worker deployed to edge successfully",
          type: "success",
        }),
      },
      { DB: db },
    );
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as { notification: { id: string } };
    const notifId = createJson.notification.id;

    // 2. GET /notifications/unread-count
    const countRes = await app.request("/api/notifications/unread-count", {}, { DB: db });
    expect(countRes.status).toBe(200);
    const countJson = (await countRes.json()) as { unread_count: number };
    expect(countJson.unread_count).toBe(1);

    // 3. GET /notifications
    const listRes = await app.request("/api/notifications", {}, { DB: db });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { notifications: unknown[] };
    expect(listJson.notifications).toHaveLength(1);

    // 4. PATCH /notifications/:id/read
    const readRes = await app.request(
      `/api/notifications/${notifId}/read`,
      {
        method: "PATCH",
      },
      { DB: db },
    );
    expect(readRes.status).toBe(200);

    // 5. Verify badge is 0
    const reCountRes = await app.request("/api/notifications/unread-count", {}, { DB: db });
    const reCountJson = (await reCountRes.json()) as { unread_count: number };
    expect(reCountJson.unread_count).toBe(0);

    // 6. DELETE /notifications/:id
    const delRes = await app.request(
      `/api/notifications/${notifId}`,
      {
        method: "DELETE",
      },
      { DB: db },
    );
    expect(delRes.status).toBe(200);
  });

  it("story 0.11 ID_GUESS: PATCH /:id/read and DELETE /:id answer 404 for another user's notification and leave it unchanged", async () => {
    const service = new NotificationService(db);
    const nBob = await service.create({ userId: USER_BOB, workspaceId: "ws_notif_beta", title: "Bob only", body: "B" });
    const nAlice = await service.create({ userId: USER_ALICE, workspaceId: WS_ALPHA, title: "Alice", body: "A" });
    const app = new Hono<NotificationEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { uid: USER_ALICE, email: "alice@example.com" });
      await next();
    });
    app.route("/api", createNotificationRoutes());

    expect((await app.request(`/api/notifications/${nBob.id}/read`, { method: "PATCH" }, { DB: db })).status).toBe(404);
    expect((await app.request(`/api/notifications/${nBob.id}`, { method: "DELETE" }, { DB: db })).status).toBe(404);
    expect(await service.getUnreadCount(USER_BOB)).toBe(1);
    expect(await service.list(USER_BOB)).toHaveLength(1);

    // Own id: 200; marking an already-read notification again is still 200 (changed: false), not 404.
    const first = await app.request(`/api/notifications/${nAlice.id}/read`, { method: "PATCH" }, { DB: db });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, changed: true });
    const again = await app.request(`/api/notifications/${nAlice.id}/read`, { method: "PATCH" }, { DB: db });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, changed: false });
    expect((await app.request(`/api/notifications/${nAlice.id}`, { method: "DELETE" }, { DB: db })).status).toBe(200);
    expect((await app.request(`/api/notifications/${nAlice.id}`, { method: "DELETE" }, { DB: db })).status).toBe(404);
  });

  describe("POST /notifications authorisation (story 0.6, audit risk 21)", () => {
    function appAs(caller?: { uid: string; role: string }): Hono<NotificationEnv> {
      const app = new Hono<NotificationEnv>();
      app.use("*", async (c, next) => {
        if (caller) {
          c.set("user", { uid: caller.uid });
          c.set("workspace", { id: WS_ALPHA, role: caller.role });
          c.set("ctx", Object.freeze({ userId: caller.uid, workspaceId: WS_ALPHA, role: caller.role }));
        }
        await next();
      });
      app.route("/api", createNotificationRoutes());
      return app;
    }
    const create = (app: Hono<NotificationEnv>, body: Record<string, unknown> | string) =>
      app.request(
        "/api/notifications",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        },
        { DB: db },
      );
    async function notifCount(): Promise<number> {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM notif_notifications").first<{ n: number }>();
      return Number(row?.n ?? 0);
    }

    beforeEach(async () => {
      await addMember(WS_ALPHA, USER_ALICE, "owner");
      await addMember(WS_ALPHA, USER_BOB, "member");
    });

    it("UNAUTH_ADMIN: no user gets 401", async () => {
      expect((await create(appAs(), { userId: USER_BOB, title: "t", body: "b" })).status).toBe(401);
      expect(await notifCount()).toBe(0);
    });

    it("MEMBER_ADMIN: a plain member gets 403, also for an invalid body", async () => {
      const member = appAs({ uid: USER_BOB, role: "member" });
      expect((await create(member, { userId: USER_ALICE, title: "Spoof", body: "b" })).status).toBe(403);
      expect((await create(member, "{bad")).status).toBe(403);
      expect(await notifCount()).toBe(0);
    });

    it("NOTIFY_NON_MEMBER: an admin cannot notify a user outside the workspace", async () => {
      const res = await create(appAs({ uid: USER_ALICE, role: "owner" }), { userId: "usr_outsider", title: "t", body: "b" });
      expect(res.status).toBe(404);
      await addMember("ws_other", "usr_outsider", "owner");
      const again = await create(appAs({ uid: USER_ALICE, role: "admin" }), { userId: "usr_outsider", title: "t", body: "b" });
      expect(again.status).toBe(404);
      expect(await notifCount()).toBe(0);
    });

    it("ADMIN_OK: an admin notifies a member of the workspace", async () => {
      const res = await create(appAs({ uid: USER_ALICE, role: "admin" }), { userId: USER_BOB, title: "Hello", body: "b" });
      expect(res.status).toBe(201);
      expect(await new NotificationService(db).getUnreadCount(USER_BOB, WS_ALPHA)).toBe(1);
    });
  });
});
