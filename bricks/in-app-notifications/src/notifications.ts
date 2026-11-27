import type { D1Like } from "@poc/sdk";
import { global, scoped } from "@poc/sdk";

export type NotificationType = "info" | "success" | "warning" | "error" | "action_required";

export interface Notification {
  id: string;
  workspace_id: string | null;
  user_id: string;
  title: string;
  body: string;
  type: NotificationType;
  action_url: string | null;
  is_read: boolean;
  read_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreateNotificationInput {
  userId: string;
  workspaceId?: string;
  title: string;
  body: string;
  type?: NotificationType;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

interface RawNotificationRow {
  id: string;
  workspace_id: string | null;
  user_id: string;
  title: string;
  body: string;
  type: NotificationType;
  action_url: string | null;
  is_read: number;
  read_at: string | null;
  metadata_json: string | null;
  created_at: string;
}

export class NotificationService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  private parseRow(row: RawNotificationRow): Notification {
    let meta = {};
    if (row.metadata_json) {
      try {
        meta = JSON.parse(row.metadata_json);
      } catch {
        meta = {};
      }
    }

    return {
      id: row.id,
      workspace_id: row.workspace_id,
      user_id: row.user_id,
      title: row.title,
      body: row.body,
      type: row.type,
      action_url: row.action_url,
      is_read: row.is_read === 1,
      read_at: row.read_at,
      metadata: meta,
      created_at: row.created_at,
    };
  }

  /**
   * Dispatches a new notification to a specific user.
   */
  async create(input: CreateNotificationInput): Promise<Notification> {
    const id = `ntf_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const type = input.type || "info";
    const meta = input.metadata ? JSON.stringify(input.metadata) : null;

    if (input.workspaceId) {
      await scoped(this.db, input.workspaceId).insert("notif_notifications", {
        id,
        user_id: input.userId.trim(),
        title: input.title.trim().slice(0, 255),
        body: input.body.trim().slice(0, 1024),
        type,
        action_url: input.actionUrl?.trim() || null,
        is_read: 0,
        metadata_json: meta,
        created_at: now,
      });
    } else {
      await global(this.db, "notif_notifications", "global notification create").insert({
        id,
        workspace_id: null,
        user_id: input.userId.trim(),
        title: input.title.trim().slice(0, 255),
        body: input.body.trim().slice(0, 1024),
        type,
        action_url: input.actionUrl?.trim() || null,
        is_read: 0,
        metadata_json: meta,
        created_at: now,
      });
    }

    return {
      id,
      workspace_id: input.workspaceId || null,
      user_id: input.userId.trim(),
      title: input.title.trim().slice(0, 255),
      body: input.body.trim().slice(0, 1024),
      type,
      action_url: input.actionUrl?.trim() || null,
      is_read: false,
      read_at: null,
      metadata: input.metadata || {},
      created_at: now,
    };
  }

  /**
   * Computes the unread notification badge count for a user.
   */
  async getUnreadCount(userId: string, workspaceId?: string): Promise<number> {
    interface CountRow {
      count: number;
    }

    // A user's inbox: their own rows (user_id bound) in the caller's workspace plus platform-wide rows, which have
    // workspace_id NULL and belong to no workspace. Every route that calls this passes the caller's workspace.
    // tenant-lint: allow user-addressed inbox: user_id bound, plus platform-wide rows whose workspace_id is NULL by design
    let query = "SELECT COUNT(*) as count FROM notif_notifications WHERE user_id = ? AND is_read = 0";
    const params: unknown[] = [userId.trim()];

    if (workspaceId) {
      query += " AND (workspace_id = ? OR workspace_id IS NULL)";
      params.push(workspaceId);
    }

    const row = await global(this.db, "notif_notifications", "user unread notifications count").raw(query, params).first<CountRow>();
    return row?.count || 0;
  }

  /**
   * Lists notifications for a user with optional workspace and read filters.
   */
  async list(userId: string, options: { workspaceId?: string; unreadOnly?: boolean; limit?: number; offset?: number } = {}): Promise<Notification[]> {
    // A user's inbox: their own rows (user_id bound) in the caller's workspace plus platform-wide rows, which have
    // workspace_id NULL and belong to no workspace. Every route that calls this passes the caller's workspace.
    // tenant-lint: allow user-addressed inbox: user_id bound, plus platform-wide rows whose workspace_id is NULL by design
    let query = `
      SELECT id, workspace_id, user_id, title, body, type, action_url,
             is_read, read_at, metadata_json, created_at
      FROM notif_notifications
      WHERE user_id = ?
    `;
    const params: unknown[] = [userId.trim()];

    if (options.workspaceId) {
      query += " AND (workspace_id = ? OR workspace_id IS NULL)";
      params.push(options.workspaceId);
    }

    if (options.unreadOnly) {
      query += " AND is_read = 0";
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(options.limit || 20, options.offset || 0);

    const rows = (await global(this.db, "notif_notifications", "user notifications list").raw(query, params).all<RawNotificationRow>()).results;
    return rows.map((r) => this.parseRow(r));
  }

  /**
   * Whether a notification with this id belongs to this user. Lets PATCH /notifications/:id/read tell "already read"
   * from "not yours" (404).
   */
  async existsForUser(notificationId: string, userId: string): Promise<boolean> {
    // Same binding as markAsRead/delete: random id plus the owner's user_id, on a route without workspace context.
    // tenant-lint: allow owner-only lookup by notification id on a route without workspace context; user_id is bound
    const row = await global(this.db, "notif_notifications", "notification owner check")
      .raw("SELECT 1 AS found FROM notif_notifications WHERE id = ? AND user_id = ?", [notificationId, userId.trim()])
      .first<{ found: number }>();
    return row !== null && row !== undefined;
  }

  /**
   * Marks a single notification as read by the owner user.
   */
  async markAsRead(notificationId: string, userId: string): Promise<boolean> {
    const now = new Date().toISOString();
    // PATCH/DELETE /notifications/:id carry no workspace context (they are not behind the workspace guard): the row is
    // matched by its random id and bound to its owner's user_id, so another user's id changes nothing.
    // tenant-lint: allow owner-only change by notification id on a route without workspace context; user_id is bound
    const res = await global(this.db, "notif_notifications", "mark notification read")
      .raw(
        `
      UPDATE notif_notifications
      SET is_read = 1, read_at = ?
      WHERE id = ? AND user_id = ? AND is_read = 0
    `,
        [now, notificationId, userId.trim()],
      )
      .run();

    return res.meta.changes > 0;
  }

  /**
   * Marks all notifications as read for a user.
   */
  async markAllAsRead(userId: string, workspaceId?: string): Promise<number> {
    const now = new Date().toISOString();
    // A user's inbox: their own rows (user_id bound) in the caller's workspace plus platform-wide rows, which have
    // workspace_id NULL and belong to no workspace. Every route that calls this passes the caller's workspace.
    // tenant-lint: allow user-addressed inbox: user_id bound, plus platform-wide rows whose workspace_id is NULL by design
    let query = `
      UPDATE notif_notifications
      SET is_read = 1, read_at = ?
      WHERE user_id = ? AND is_read = 0
    `;
    const params: unknown[] = [now, userId.trim()];

    if (workspaceId) {
      query += " AND (workspace_id = ? OR workspace_id IS NULL)";
      params.push(workspaceId);
    }

    const res = await global(this.db, "notif_notifications", "mark all notifications read").raw(query, params).run();
    return res.meta.changes;
  }

  /**
   * Deletes a notification by owner user.
   */
  async delete(notificationId: string, userId: string): Promise<boolean> {
    // PATCH/DELETE /notifications/:id carry no workspace context (they are not behind the workspace guard): the row is
    // matched by its random id and bound to its owner's user_id, so another user's id changes nothing.
    // tenant-lint: allow owner-only change by notification id on a route without workspace context; user_id is bound
    const res = await global(this.db, "notif_notifications", "delete notification")
      .raw("DELETE FROM notif_notifications WHERE id = ? AND user_id = ?", [notificationId, userId.trim()])
      .run();

    return res.meta.changes > 0;
  }
}
