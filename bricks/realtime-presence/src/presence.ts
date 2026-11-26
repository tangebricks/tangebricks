import { scoped, type D1Like } from "@poc/sdk";

export type PresenceStatus = "online" | "idle" | "away" | "offline";

export interface CursorPosition {
  x: number;
  y: number;
  page?: number;
  target?: string;
}

export interface PresenceParticipant {
  user_id: string;
  user_name: string;
  status: PresenceStatus;
  cursor: CursorPosition | null;
  metadata: Record<string, unknown>;
  last_heartbeat_at: number;
  is_active: boolean;
}

export interface RoomPresence {
  room_name: string;
  active_count: number;
  participants: PresenceParticipant[];
}

interface RawSessionRow {
  id: string;
  workspace_id: string;
  room_id: string;
  user_id: string;
  user_name: string;
  status: PresenceStatus;
  cursor_json: string | null;
  metadata_json: string | null;
  last_heartbeat_at: number;
  created_at: string;
}

export class RealtimePresenceService {
  private readonly db: D1Like;
  private readonly defaultTtlSeconds: number;

  constructor(db: D1Like, defaultTtlSeconds = 30) {
    this.db = db;
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  /**
   * Retrieves or creates a presence room.
   */
  async getOrCreateRoom(workspaceId: string, roomNameRaw: string): Promise<string> {
    const name = roomNameRaw.trim().toLowerCase();
    const id = `room_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    const existing = await scoped(this.db, workspaceId).first<{ id: string }>(
      "pres_rooms",
      "name = ?",
      [name]
    );
    if (existing) return existing.id;

    try {
      await scoped(this.db, workspaceId).insert("pres_rooms", {
        id,
        name,
        created_at: now,
      });
      return id;
    } catch {
      const row = await scoped(this.db, workspaceId).first<{ id: string }>(
        "pres_rooms",
        "name = ?",
        [name]
      );
      return row?.id || id;
    }
  }

  /**
   * Updates user heartbeat, status, and live cursor position in a room.
   */
  async heartbeat(
    workspaceId: string,
    roomName: string,
    user: { userId: string; userName: string },
    options: {
      cursor?: CursorPosition;
      status?: PresenceStatus;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<PresenceParticipant> {
    const roomId = await this.getOrCreateRoom(workspaceId, roomName);
    const id = `sess_${crypto.randomUUID().replace(/-/g, "")}`;
    const status = options.status || "online";
    const cursorJson = options.cursor ? JSON.stringify(options.cursor) : null;
    const metaJson = options.metadata ? JSON.stringify(options.metadata) : null;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const existing = await scoped(this.db, workspaceId).first<{
      id: string;
      cursor_json: string | null;
      metadata_json: string | null;
    }>(
      "pres_sessions",
      "room_id = ? AND user_id = ?",
      [roomId, user.userId.trim()]
    );

    if (existing) {
      await scoped(this.db, workspaceId).update(
        "pres_sessions",
        {
          user_name: user.userName.trim(),
          status,
          cursor_json: cursorJson ?? existing.cursor_json,
          metadata_json: metaJson ?? existing.metadata_json,
          last_heartbeat_at: nowMs,
        },
        "room_id = ? AND user_id = ?",
        [roomId, user.userId.trim()]
      );
    } else {
      await scoped(this.db, workspaceId).insert("pres_sessions", {
        id,
        room_id: roomId,
        user_id: user.userId.trim(),
        user_name: user.userName.trim(),
        status,
        cursor_json: cursorJson,
        metadata_json: metaJson,
        last_heartbeat_at: nowMs,
        created_at: nowIso,
      });
    }

    return {
      user_id: user.userId.trim(),
      user_name: user.userName.trim(),
      status,
      cursor: options.cursor || null,
      metadata: options.metadata || {},
      last_heartbeat_at: nowMs,
      is_active: true,
    };
  }

  /**
   * Retrieves active presence participants in a room, filtering out expired sessions.
   */
  async getRoomPresence(
    workspaceId: string,
    roomNameRaw: string,
    ttlSeconds = this.defaultTtlSeconds
  ): Promise<RoomPresence> {
    const roomName = roomNameRaw.trim().toLowerCase();
    const roomId = await this.getOrCreateRoom(workspaceId, roomName);
    const thresholdMs = Date.now() - ttlSeconds * 1000;

    const rows = await scoped(this.db, workspaceId).select<RawSessionRow>(
      "pres_sessions",
      "room_id = ? AND status != 'offline'",
      [roomId],
      { orderBy: "last_heartbeat_at DESC" }
    );

    const activeParticipants: PresenceParticipant[] = [];

    for (const r of rows) {
      const isActive = r.last_heartbeat_at >= thresholdMs;
      if (!isActive) continue; // Filter out expired sessions

      let cursor: CursorPosition | null = null;
      if (r.cursor_json) {
        try {
          cursor = JSON.parse(r.cursor_json);
        } catch {
          cursor = null;
        }
      }

      let meta = {};
      if (r.metadata_json) {
        try {
          meta = JSON.parse(r.metadata_json);
        } catch {
          meta = {};
        }
      }

      activeParticipants.push({
        user_id: r.user_id,
        user_name: r.user_name,
        status: r.status,
        cursor,
        metadata: meta,
        last_heartbeat_at: r.last_heartbeat_at,
        is_active: true,
      });
    }

    return {
      room_name: roomName,
      active_count: activeParticipants.length,
      participants: activeParticipants,
    };
  }

  /**
   * Explicitly marks a user as offline or removes them from room presence.
   */
  async leaveRoom(workspaceId: string, roomNameRaw: string, userId: string): Promise<boolean> {
    const roomName = roomNameRaw.trim().toLowerCase();
    const room = await scoped(this.db, workspaceId).first<{ id: string }>(
      "pres_rooms",
      "name = ?",
      [roomName]
    );
    if (!room) return false;

    const res = await scoped(this.db, workspaceId).update(
      "pres_sessions",
      { status: "offline" },
      "user_id = ? AND room_id = ?",
      [userId.trim(), room.id]
    );

    return res.meta.changes > 0;
  }

  /**
   * Checks overall user online status across any room.
   */
  async getUserStatus(
    workspaceId: string,
    userId: string,
    ttlSeconds = this.defaultTtlSeconds
  ): Promise<{ online: boolean; status: PresenceStatus; lastSeenAt: number | null }> {
    const thresholdMs = Date.now() - ttlSeconds * 1000;
    interface StatusRow {
      status: PresenceStatus;
      last_heartbeat_at: number;
    }

    const rows = await scoped(this.db, workspaceId).select<StatusRow>(
      "pres_sessions",
      "user_id = ?",
      [userId.trim()],
      { orderBy: "last_heartbeat_at DESC", limit: 1 }
    );

    const row = rows[0] || null;

    if (!row) {
      return { online: false, status: "offline", lastSeenAt: null };
    }

    const isOnline = row.status !== "offline" && row.last_heartbeat_at >= thresholdMs;

    return {
      online: isOnline,
      status: isOnline ? row.status : "offline",
      lastSeenAt: row.last_heartbeat_at,
    };
  }
}
