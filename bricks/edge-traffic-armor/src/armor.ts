import type { D1Like } from "@poc/sdk";
import { global, scoped } from "@poc/sdk";

export type IpAction = "allow" | "block" | "challenge";
export type BlockReason = "ip_block" | "rate_limit" | "bot_detected" | "waf_rule";

export interface IpRule {
  id: string;
  workspace_id: string;
  ip_or_cidr: string;
  action: IpAction;
  reason: string | null;
  created_at: string;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter: number;
  current: number;
}

export interface BlockedIncident {
  id: string;
  workspace_id: string | null;
  ip_address: string;
  path: string;
  block_reason: BlockReason;
  user_agent: string | null;
  created_at: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class TrafficArmorService {
  private readonly db: D1Like;
  private readonly customFetch: Fetcher;

  constructor(db: D1Like, customFetch: Fetcher = fetch) {
    this.db = db;
    this.customFetch = customFetch;
  }

  /**
   * Adds or updates an IP access rule (allow/block/challenge).
   */
  async addIpRule(workspaceId: string, ipOrCidrRaw: string, action: IpAction, reason?: string): Promise<IpRule> {
    const id = `rule_${crypto.randomUUID().replace(/-/g, "")}`;
    const ip = ipOrCidrRaw.trim();
    const now = new Date().toISOString();

    const existing = await scoped(this.db, workspaceId).first<IpRule>("arm_ip_rules", "ip_or_cidr = ?", [ip]);
    if (existing) {
      await scoped(this.db, workspaceId).update(
        "arm_ip_rules",
        {
          action,
          reason: reason?.trim().slice(0, 255) || null,
        },
        "id = ?",
        [existing.id],
      );
    } else {
      await scoped(this.db, workspaceId).insert("arm_ip_rules", {
        id,
        ip_or_cidr: ip,
        action,
        reason: reason?.trim().slice(0, 255) || null,
        created_at: now,
      });
    }

    return {
      id: existing ? existing.id : id,
      workspace_id: workspaceId,
      ip_or_cidr: ip,
      action,
      reason: reason?.trim().slice(0, 255) || null,
      created_at: existing ? existing.created_at : now,
    };
  }

  /**
   * Removes an IP rule.
   */
  async removeIpRule(workspaceId: string, ipOrCidr: string): Promise<boolean> {
    const res = await scoped(this.db, workspaceId).delete("arm_ip_rules", "ip_or_cidr = ?", [ipOrCidr.trim()]);

    return res.meta.changes > 0;
  }

  /**
   * Lists IP rules for a workspace.
   */
  async listIpRules(workspaceId: string): Promise<IpRule[]> {
    return scoped(this.db, workspaceId).select<IpRule>("arm_ip_rules", undefined, [], {
      orderBy: "created_at DESC",
    });
  }

  /**
   * Checks if an IP is explicitly blocked or allowed for a workspace.
   */
  async checkIp(workspaceId: string, clientIp: string): Promise<IpAction | null> {
    const row = await scoped(this.db, workspaceId).first<{ action: IpAction }>("arm_ip_rules", "ip_or_cidr = ?", [clientIp.trim()]);

    return row?.action || null;
  }

  /**
   * Sliding/fixed window rate limit check.
   */
  async checkRateLimit(keyRaw: string, limit = 60, windowSeconds = 60): Promise<RateLimitResult> {
    const key = keyRaw.trim();
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = nowSec - (nowSec % windowSeconds);
    const reset = windowStart + windowSeconds;
    const retryAfter = Math.max(1, reset - nowSec);

    // Upsert count
    await this.db
      .prepare(
        `
      INSERT INTO arm_rate_limits (key, window_start, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(key, window_start) DO UPDATE SET
        request_count = request_count + 1
    `,
      )
      .bind(key, windowStart)
      .run();

    const row = await this.db
      .prepare("SELECT request_count FROM arm_rate_limits WHERE key = ? AND window_start = ?")
      .bind(key, windowStart)
      .first<{ request_count: number }>();

    const current = row?.request_count || 1;
    const allowed = current <= limit;
    const remaining = Math.max(0, limit - current);

    return {
      allowed,
      limit,
      remaining,
      reset,
      retryAfter,
      current,
    };
  }

  /**
   * Verifies a Cloudflare Turnstile token via the Cloudflare siteverify API.
   */
  async verifyTurnstile(token: string, secretKey: string, remoteIp?: string): Promise<{ success: boolean; errorCodes?: string[] }> {
    if (!token) return { success: false, errorCodes: ["missing-input-response"] };

    try {
      const formData = new URLSearchParams();
      formData.append("secret", secretKey);
      formData.append("response", token);
      if (remoteIp) formData.append("remoteip", remoteIp);

      const res = await this.customFetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: formData,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      const data = (await res.json()) as { success: boolean; "error-codes"?: string[] };
      return {
        success: data.success === true,
        errorCodes: data["error-codes"],
      };
    } catch {
      return { success: false, errorCodes: ["network-error"] };
    }
  }

  /**
   * Logs a security block incident.
   */
  async logBlockedRequest(workspaceId: string | null, ipAddress: string, path: string, reason: BlockReason, userAgent?: string): Promise<BlockedIncident> {
    const id = `inc_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    if (workspaceId) {
      await scoped(this.db, workspaceId).insert("arm_blocked_requests", {
        id,
        ip_address: ipAddress.slice(0, 45),
        path: path.slice(0, 255),
        block_reason: reason,
        user_agent: userAgent?.slice(0, 512) || null,
        created_at: now,
      });
    } else {
      await global(this.db, "arm_blocked_requests", "record edge blocked request without tenant context").insert({
        id,
        workspace_id: null,
        ip_address: ipAddress.slice(0, 45),
        path: path.slice(0, 255),
        block_reason: reason,
        user_agent: userAgent?.slice(0, 512) || null,
        created_at: now,
      });
    }

    return {
      id,
      workspace_id: workspaceId,
      ip_address: ipAddress,
      path,
      block_reason: reason,
      user_agent: userAgent || null,
      created_at: now,
    };
  }

  /**
   * Lists recent security incidents.
   */
  async listIncidents(workspaceId?: string): Promise<BlockedIncident[]> {
    if (workspaceId) {
      return scoped(this.db, workspaceId).select<BlockedIncident>("arm_blocked_requests", undefined, [], { orderBy: "created_at DESC", limit: 50 });
    }

    return global(this.db, "arm_blocked_requests", "list global security incidents").select<BlockedIncident>(undefined, [], {
      orderBy: "created_at DESC",
      limit: 50,
    });
  }
}
