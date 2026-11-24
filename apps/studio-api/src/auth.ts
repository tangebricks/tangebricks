import { betterAuth } from "better-auth";
import { getAdapter } from "better-auth/db/adapter";
import { bearer } from "better-auth/plugins/bearer";
import { Hono } from "hono";
import { z } from "zod";
import { sha256Hex } from "@poc/assembler";
import { PROJECT_SLUG_PATTERN, createEmptyBlueprint, semanticHash } from "@poc/blueprint";
import { hardenedBetterAuthOptions, hashedSessionDatabase, isPlatformOperator, rateLimit } from "@poc/sdk";
import type { D1Like, RateLimitRule } from "@poc/sdk";
import { ensureStudioD1Schema } from "./blueprint-do.ts";
import type { AuthorAttribution, StudioApiEnv } from "./blueprint-do.ts";
import { recordStudioOnboardingEvent } from "./security/token-vault.ts";
import { instantiateStarterTemplateForProject } from "./templates.ts";

export type StudioOrgRole = "owner" | "admin" | "builder" | "viewer";
export type StudioOrgRoleInput = StudioOrgRole | "editor";
export type StudioMcpScope = "read" | "edit" | "deploy" | "connect";

export interface StudioAuthUser {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  createdAt: string;
}

export interface StudioAuthSession {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  token: string;
  expiresAt: string;
}

export type StudioCaller =
  | {
      kind: "session";
      userId: string;
      email: string;
      displayName: string | null;
      sessionId: string;
      author: AuthorAttribution;
    }
  | {
      kind: "mcp_token";
      userId: string;
      orgId: string;
      orgRole: StudioOrgRole;
      tokenId: string;
      clientName: string;
      /** The one project this token is bound to (story 0.15). Every tool call is authorised against it. */
      projectId: string;
      scopes: StudioMcpScope[];
      author: AuthorAttribution;
    };

/** The only scopes an MCP token can carry. Anything else (including `*` and `write`) is refused at issuance. */
export const STUDIO_MCP_SCOPES: readonly StudioMcpScope[] = ["read", "edit", "deploy", "connect"];

export function isStudioMcpScope(value: string): value is StudioMcpScope {
  return (STUDIO_MCP_SCOPES as readonly string[]).includes(value);
}

export interface StudioAuditLogInput {
  orgId: string;
  projectId?: string | null;
  actorType: "human" | "agent";
  actorId: string;
  action: string;
  status: string;
  targetRef?: string | null;
  metadata?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  ipHash?: string | null;
  request?: Request | null;
}

export interface StudioAuditLogRecord {
  id: string;
  ts: string;
  orgId: string;
  projectId: string | null;
  actorType: string;
  actorId: string;
  actor: string;
  action: string;
  status: string;
  targetRef: string;
  metadata: Record<string, unknown>;
  details: Record<string, unknown> | null;
  ipHash: string;
  createdAt: string;
}

function requireStudioSecret(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required secret ${name}`);
  }
  return value;
}

export function normalizeOrgRole(role: StudioOrgRoleInput): StudioOrgRole {
  if (role === "editor") return "builder";
  return role;
}

export function canManageOrg(role: StudioOrgRole | null): boolean {
  return role === "owner" || role === "admin";
}

export function canReadProject(role: StudioOrgRole | null, scopes?: string[]): boolean {
  const roleOk =
    role === "owner" || role === "admin" || role === "builder" || role === "viewer";
  if (!roleOk) return false;
  if (scopes !== undefined) {
    return (
      scopes.includes("read") ||
      scopes.includes("edit") ||
      scopes.includes("deploy") ||
      scopes.includes("connect")
    );
  }
  return true;
}

export function canMutateProject(
  role: StudioOrgRole | null,
  scopes?: string[],
  requiredScope: StudioMcpScope | "any" = "edit",
): boolean {
  const roleOk = role === "owner" || role === "admin" || role === "builder";
  if (!roleOk) return false;
  if (scopes !== undefined) {
    // "any": a builder-or-higher action that any valid token scope may perform (e.g. a plain deploy plan).
    if (requiredScope === "any") return canReadProject(role, scopes);
    return scopes.includes(requiredScope);
  }
  return true;
}

export function parseTokenScopes(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((s) => String(s).trim()).filter(Boolean);
      }
    } catch {
      // fall through to comma/space split
    }
  }
  return trimmed
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createStudioBetterAuth(
  env: StudioApiEnv,
  requestUrl?: string,
  sessionDurationSeconds = 86400,
  requestHeaders?: Headers,
) {
  const origin = requestUrl ? new URL(requestUrl).origin : "http://localhost";
  // No fallback: a missing signing secret must fail loudly, never sign sessions with a value written in source.
  const secret = requireStudioSecret("BETTER_AUTH_SECRET", env.BETTER_AUTH_SECRET);
  const githubClientId = env.GITHUB_CLIENT_ID?.trim();
  const githubClientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  // Story 0.14: every session setting explicit (cookie flags, trusted origins from PX_ALLOWED_ORIGINS, rate limit),
  // and session tokens stored as sha256 digests.
  const hardening = hardenedBetterAuthOptions({
    requestUrl: origin,
    env,
    sessionDurationSeconds,
    hasClientIp: Boolean(requestHeaders?.get("cf-connecting-ip")),
  });

  return betterAuth({
    database: hashedSessionDatabase(getAdapter, env.STUDIO_DB) as unknown as Record<string, unknown>,
    baseURL: origin,
    basePath: "/api/auth",
    secret,
    trustedOrigins: hardening.trustedOrigins,
    advanced: hardening.advanced,
    session: hardening.session,
    rateLimit: hardening.rateLimit,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    // GitHub sign-in is configured only when both credentials are provided.
    socialProviders:
      githubClientId && githubClientSecret
        ? { github: { clientId: githubClientId, clientSecret: githubClientSecret } }
        : {},
    plugins: [bearer()],
  });
}

export function normalizeStudioAuthHeaders(rawHeaders: Headers): {
  headers: Headers;
  presentedCredentials: boolean;
  bearerToken: string | null;
} {
  const headers = new Headers(rawHeaders);
  const authHeader = headers.get("authorization")?.trim() ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const bearerToken = bearerMatch?.[1]?.trim() ?? null;
  const cookieHeader = headers.get("cookie") ?? "";
  const hasSessionCookie =
    cookieHeader.includes("better-auth.session_token=") ||
    cookieHeader.includes("__Secure-better-auth.session_token=");

  if (
    cookieHeader.includes("__Secure-better-auth.session_token=") &&
    !cookieHeader.includes("; better-auth.session_token=")
  ) {
    headers.set(
      "cookie",
      cookieHeader.replaceAll(
        "__Secure-better-auth.session_token=",
        "better-auth.session_token=",
      ),
    );
  }

  return {
    headers,
    presentedCredentials: Boolean(bearerToken) || hasSessionCookie,
    bearerToken,
  };
}

export async function resolveStudioAuthSession(
  env: StudioApiEnv,
  request: Request,
  sessionDurationSeconds = 86400,
): Promise<{
  user: StudioAuthUser | null;
  session: StudioAuthSession | null;
  presentedCredentials: boolean;
}> {
  await ensureStudioD1Schema(env.STUDIO_DB);
  const { headers, presentedCredentials } = normalizeStudioAuthHeaders(request.headers);
  if (!presentedCredentials) {
    return { user: null, session: null, presentedCredentials: false };
  }

  const auth = createStudioBetterAuth(env, request.url, sessionDurationSeconds);
  const resolved = await auth.api.getSession({ headers }).catch(() => null);
  if (!resolved || !resolved.session || !resolved.user) {
    return { user: null, session: null, presentedCredentials: true };
  }

  const expiresAtIso =
    resolved.session.expiresAt instanceof Date
      ? resolved.session.expiresAt.toISOString()
      : String(resolved.session.expiresAt);
  const expiresAtMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return { user: null, session: null, presentedCredentials: true };
  }

  // Also verify against D1 directly in case session expiry was modified in SQLite
  const dbSession = await env.STUDIO_DB.prepare(
    'SELECT "expiresAt" FROM "session" WHERE "id" = ? LIMIT 1',
  )
    .bind(resolved.session.id)
    .first<{ expiresAt: string }>();
  if (!dbSession) {
    return { user: null, session: null, presentedCredentials: true };
  }
  const dbExpiresMs = Date.parse(String(dbSession.expiresAt));
  if (!Number.isFinite(dbExpiresMs) || dbExpiresMs <= Date.now()) {
    return { user: null, session: null, presentedCredentials: true };
  }

  const createdAtIso =
    resolved.user.createdAt instanceof Date
      ? resolved.user.createdAt.toISOString()
      : String(resolved.user.createdAt);

  return {
    user: {
      id: resolved.user.id,
      email: resolved.user.email,
      displayName: resolved.user.name ?? null,
      emailVerified: Boolean(resolved.user.emailVerified),
      createdAt: createdAtIso,
    },
    session: {
      id: resolved.session.id,
      userId: resolved.user.id,
      email: resolved.user.email,
      displayName: resolved.user.name ?? null,
      token: resolved.session.token,
      expiresAt: expiresAtIso,
    },
    presentedCredentials: true,
  };
}

export async function resolveStudioCaller(
  env: StudioApiEnv,
  request: Request,
): Promise<
  | { ok: true; caller: StudioCaller }
  | { ok: false; status: 401; error: { code: string; message: string } }
> {
  const db = env.STUDIO_DB;
  await ensureStudioD1Schema(db);

  const { bearerToken, presentedCredentials } = normalizeStudioAuthHeaders(request.headers);

  // 1. Check scoped MCP token if a Bearer token was presented
  if (bearerToken) {
    const tokenHash = await sha256Hex(bearerToken);
    const mcpTokenRow = await db
      .prepare(
        `SELECT id, org_id, project_id, user_id, client_name, scopes, revoked_at
         FROM studio_mcp_tokens
         WHERE token_hash = ?
         LIMIT 1`,
      )
      .bind(tokenHash)
      .first<{
        id: string;
        org_id: string;
        project_id: string | null;
        user_id: string;
        client_name: string;
        scopes: string;
        revoked_at: string | null;
      }>();

    if (mcpTokenRow) {
      if (mcpTokenRow.revoked_at !== null) {
        return {
          ok: false,
          status: 401,
          error: {
            code: "REVOKED_MCP_TOKEN",
            message: "MCP token has been revoked",
          },
        };
      }

      // Story 0.15: org-wide tokens (no project) are no longer honoured.
      if (mcpTokenRow.project_id === null || mcpTokenRow.project_id.trim().length === 0) {
        return {
          ok: false,
          status: 401,
          error: {
            code: "LEGACY_MCP_TOKEN",
            message:
              "This MCP token is not bound to a project and is no longer accepted; issue a project token (POST /api/orgs/:orgId/mcp-tokens with a projectId)",
          },
        };
      }

      const memberRow = await db
        .prepare(
          `SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1`,
        )
        .bind(mcpTokenRow.org_id, mcpTokenRow.user_id)
        .first<{ role: StudioOrgRole }>();

      if (!memberRow) {
        return {
          ok: false,
          status: 401,
          error: {
            code: "UNAUTHORIZED",
            message: "Token owner is not a member of the organization",
          },
        };
      }

      // Only the fixed scope list counts; anything else stored on an old row (`*`, `write`) grants nothing.
      const scopes = parseTokenScopes(mcpTokenRow.scopes).filter(isStudioMcpScope);
      return {
        ok: true,
        caller: {
          kind: "mcp_token",
          userId: mcpTokenRow.user_id,
          orgId: mcpTokenRow.org_id,
          orgRole: memberRow.role,
          tokenId: mcpTokenRow.id,
          clientName: mcpTokenRow.client_name,
          projectId: mcpTokenRow.project_id,
          scopes,
          author: {
            type: "agent",
            id: mcpTokenRow.id,
            client: mcpTokenRow.client_name,
            onBehalfOf: mcpTokenRow.user_id,
          },
        },
      };
    }

    if (bearerToken.startsWith("px_mcp_")) {
      return {
        ok: false,
        status: 401,
        error: {
          code: "INVALID_MCP_TOKEN",
          message: "Invalid or unknown MCP token",
        },
      };
    }
  }

  // 2. Check Better Auth session (cookie or bearer session token)
  if (presentedCredentials) {
    const { user, session } = await resolveStudioAuthSession(env, request);
    if (user && session) {
      return {
        ok: true,
        caller: {
          kind: "session",
          userId: user.id,
          email: user.email,
          displayName: user.displayName,
          sessionId: session.id,
          author: {
            type: "human",
            id: user.id,
          },
        },
      };
    }

    return {
      ok: false,
      status: 401,
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid or expired session credentials",
      },
    };
  }

  return {
    ok: false,
    status: 401,
    error: {
      code: "UNAUTHORIZED",
      message: "Authentication required",
    },
  };
}

export async function computeAuditIpHash(
  request?: Request | null,
  explicitIpHash?: string | null,
): Promise<string> {
  if (explicitIpHash && explicitIpHash.trim().length > 0) {
    return explicitIpHash.trim();
  }
  const rawIp =
    request?.headers.get("cf-connecting-ip")?.trim() ||
    request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "127.0.0.1";
  const digest = await sha256Hex(`px-audit-ip:${rawIp}`);
  return `sha256:${digest.slice(0, 16)}`;
}

export async function recordStudioAuditLog(
  db: D1Like,
  entry: StudioAuditLogInput,
): Promise<void> {
  await ensureStudioD1Schema(db);
  const id = `audit_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();
  const actorPrefix = entry.actorType === "agent" ? "agent:" : "user:";
  const actor =
    entry.actorId.startsWith("user:") || entry.actorId.startsWith("agent:")
      ? entry.actorId
      : `${actorPrefix}${entry.actorId}`;
  const mergedMetadata = {
    ...(entry.details ?? {}),
    ...(entry.metadata ?? {}),
  };
  const detailsJson =
    entry.details !== undefined
      ? entry.details
        ? JSON.stringify(entry.details)
        : null
      : Object.keys(mergedMetadata).length > 0
        ? JSON.stringify(mergedMetadata)
        : null;
  const metadataJson = JSON.stringify(mergedMetadata);
  const targetRef =
    entry.targetRef?.trim() ||
    (typeof mergedMetadata.targetRef === "string" && mergedMetadata.targetRef.trim()
      ? mergedMetadata.targetRef.trim()
      : entry.projectId ?? entry.orgId);
  const ipHash = await computeAuditIpHash(entry.request, entry.ipHash);

  await db.batch([
    db.prepare(
      "CREATE TRIGGER IF NOT EXISTS trg_studio_audit_logs_no_update BEFORE UPDATE ON studio_audit_logs BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_IMMUTABLE: UPDATE and DELETE are forbidden on studio_audit_logs'); END",
    ),
    db.prepare(
      "CREATE TRIGGER IF NOT EXISTS trg_studio_audit_logs_no_delete BEFORE DELETE ON studio_audit_logs BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_IMMUTABLE: UPDATE and DELETE are forbidden on studio_audit_logs'); END",
    ),
    db
      .prepare(
        `INSERT INTO studio_audit_log (
          id, org_id, project_id, actor_type, actor_id, action, status, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        entry.orgId,
        entry.projectId ?? null,
        entry.actorType,
        entry.actorId,
        entry.action,
        entry.status,
        detailsJson,
        nowIso,
      ),
    db
      .prepare(
        `INSERT INTO studio_audit_logs (
          id, ts, org_id, project_id, actor_type, actor_id, actor, action, status, target_ref, metadata_json, details_json, ip_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        nowIso,
        entry.orgId,
        entry.projectId ?? null,
        entry.actorType,
        entry.actorId,
        actor,
        entry.action,
        entry.status,
        targetRef,
        metadataJson,
        detailsJson,
        ipHash,
        nowIso,
      ),
  ]);
}

export async function queryStudioAuditLogs(
  db: D1Like,
  filters: {
    orgId: string;
    projectId?: string;
    action?: string;
    limit?: number;
  },
): Promise<StudioAuditLogRecord[]> {
  await ensureStudioD1Schema(db);
  const limit = Math.max(1, Math.min(500, filters.limit ?? 200));
  const whereClauses = ["org_id = ?"];
  const bindArgs: unknown[] = [filters.orgId];

  if (filters.projectId && filters.projectId.trim()) {
    whereClauses.push("project_id = ?");
    bindArgs.push(filters.projectId.trim());
  }
  if (filters.action && filters.action.trim()) {
    whereClauses.push("action = ?");
    bindArgs.push(filters.action.trim());
  }

  const rows = await db
    .prepare(
      `SELECT id, ts, org_id, project_id, actor_type, actor_id, actor, action, status, target_ref, metadata_json, details_json, ip_hash, created_at
       FROM studio_audit_logs
       WHERE ${whereClauses.join(" AND ")}
       ORDER BY ts DESC, created_at DESC
       LIMIT ?`,
    )
    .bind(...bindArgs, limit)
    .all<{
      id: string;
      ts: string;
      org_id: string;
      project_id: string | null;
      actor_type: string;
      actor_id: string;
      actor: string;
      action: string;
      status: string;
      target_ref: string;
      metadata_json: string | null;
      details_json: string | null;
      ip_hash: string;
      created_at: string;
    }>();

  return (rows.results ?? []).map((row) => {
    let parsedMeta: Record<string, unknown> = {};
    if (row.metadata_json) {
      try {
        const candidate = JSON.parse(row.metadata_json);
        if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
          parsedMeta = candidate as Record<string, unknown>;
        }
      } catch {
        parsedMeta = {};
      }
    }
    let parsedDetails: Record<string, unknown> | null = null;
    if (row.details_json) {
      try {
        parsedDetails = JSON.parse(row.details_json) as Record<string, unknown>;
      } catch {
        parsedDetails = null;
      }
    }
    return {
      id: row.id,
      ts: row.ts ?? row.created_at,
      orgId: row.org_id,
      projectId: row.project_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      actor: row.actor,
      action: row.action,
      status: row.status,
      targetRef: row.target_ref || row.project_id || row.org_id,
      metadata: parsedMeta,
      details: parsedDetails ?? (Object.keys(parsedMeta).length > 0 ? parsedMeta : null),
      ipHash: row.ip_hash || "sha256:local",
      createdAt: row.created_at,
    };
  });
}

/**
 * The org a session caller's new project lands in (story 16). The client may name an org (path, `x-org-id`, body or
 * query `orgId`), but only to choose among the caller's own orgs; otherwise it is the caller's only org, or their
 * personal org. Refused when the caller belongs to no org, or belongs to several (none personal) and named none.
 */
export async function chooseSessionCreateOrg(
  db: D1Like,
  userId: string,
  selectedOrgId: string | undefined,
): Promise<
  | { ok: true; orgId: string }
  | { ok: false; status: 400 | 403; orgId: string; error: { code: string; message: string } }
> {
  const memberships =
    (
      await db
        .prepare("SELECT org_id, role FROM studio_org_members WHERE user_id = ? ORDER BY created_at ASC")
        .bind(userId)
        .all<{ org_id: string; role: StudioOrgRole }>()
    ).results ?? [];
  const selected = selectedOrgId?.trim();
  if (selected) {
    if (!memberships.some((m) => m.org_id === selected)) {
      return {
        ok: false,
        status: 403,
        orgId: selected,
        error: {
          code: "FORBIDDEN_ORG",
          message: "Access denied: caller is not a member of the selected organization",
        },
      };
    }
    return { ok: true, orgId: selected };
  }
  if (memberships.length === 1) return { ok: true, orgId: memberships[0]!.org_id };
  const personal = memberships.find((m) => m.org_id === `org_personal_${userId}`);
  if (personal) return { ok: true, orgId: personal.org_id };
  if (memberships.length === 0) {
    return {
      ok: false,
      status: 403,
      orgId: "unassigned",
      error: { code: "FORBIDDEN_ORG", message: "Caller does not belong to an organization" },
    };
  }
  return {
    ok: false,
    status: 400,
    orgId: "unassigned",
    error: {
      code: "ORG_SELECTION_REQUIRED",
      message:
        "Caller belongs to several organizations; select one (x-org-id or orgId) to create this project in",
    },
  };
}

/**
 * Authorises `caller` for `project` (story 16).
 *
 * - The org and role always come from the project's `projects` row, checked against the caller's verified membership
 *   (or, for an MCP token, the token's own org and project). A client-sent org (`explicitOrgId`, from `x-org-id` or a
 *   body/query `orgId`) never grants anything: it is ignored for an existing project.
 * - A project with no row: a read is 404. A write claims the slug by creating the row, only in an org the caller can
 *   mutate: the org the client selected (one of the caller's own), else the caller's only or personal org. An MCP token
 *   ignores the client org entirely and can only write its own bound project, in its own org.
 */
export async function authorizeProjectAccess(
  db: D1Like,
  caller: StudioCaller,
  project: string,
  mode: "read" | "mutate",
  explicitOrgId?: string,
  requiredScope: StudioMcpScope | "any" = "edit",
): Promise<
  | { ok: true; orgId: string; role: StudioOrgRole }
  | {
      ok: false;
      status: 400 | 403 | 404;
      orgId: string;
      role: StudioOrgRole | null;
      error: { code: string; message: string };
    }
> {
  await ensureStudioD1Schema(db);

  const readRow = () =>
    db
      .prepare("SELECT project_id, org_id FROM projects WHERE project_id = ? LIMIT 1")
      .bind(project)
      .first<{ project_id: string; org_id: string }>();
  let projectRow = await readRow();

  // An MCP token is bound to one project; any other project, in its org or not, is refused.
  if (caller.kind === "mcp_token") {
    if (projectRow && projectRow.org_id !== caller.orgId) {
      return {
        ok: false,
        status: 403,
        orgId: projectRow.org_id,
        role: null,
        error: {
          code: "FORBIDDEN_ORG",
          message: "Access denied: project belongs to another organization",
        },
      };
    }
    if (project !== caller.projectId) {
      return {
        ok: false,
        status: 403,
        orgId: caller.orgId,
        role: null,
        error: {
          code: "FORBIDDEN_PROJECT",
          message: "Access denied: this MCP token is bound to a different project",
        },
      };
    }
  }

  if (!projectRow && mode === "read") {
    return {
      ok: false,
      status: 404,
      orgId: caller.kind === "mcp_token" ? caller.orgId : "unassigned",
      role: null,
      error: { code: "PROJECT_NOT_FOUND", message: `Project "${project}" not found` },
    };
  }

  let targetOrgId: string;
  if (projectRow) {
    targetOrgId = projectRow.org_id;
  } else if (caller.kind === "mcp_token") {
    targetOrgId = caller.orgId;
  } else {
    const chosen = await chooseSessionCreateOrg(db, caller.userId, explicitOrgId);
    if (!chosen.ok) {
      return { ok: false, status: chosen.status, orgId: chosen.orgId, role: null, error: chosen.error };
    }
    targetOrgId = chosen.orgId;
  }

  let role: StudioOrgRole | null = null;
  if (caller.kind === "mcp_token") {
    role = caller.orgRole;
  } else {
    const memberRow = await db
      .prepare("SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1")
      .bind(targetOrgId, caller.userId)
      .first<{ role: StudioOrgRole }>();
    if (!memberRow) {
      return {
        ok: false,
        status: 403,
        orgId: targetOrgId,
        role: null,
        error: {
          code: "FORBIDDEN_ORG",
          message: "Access denied: caller is not a member of the project's organization",
        },
      };
    }
    role = memberRow.role;
  }

  const scopes = caller.kind === "mcp_token" ? caller.scopes : undefined;
  if (mode === "read") {
    if (!canReadProject(role, scopes)) {
      return {
        ok: false,
        status: 403,
        orgId: targetOrgId,
        role,
        error: { code: "FORBIDDEN_ROLE", message: "Caller lacks read permission for project" },
      };
    }
    return { ok: true, orgId: targetOrgId, role };
  }

  if (!canMutateProject(role, scopes, requiredScope)) {
    const missingScope =
      caller.kind === "mcp_token" && (role === "owner" || role === "admin" || role === "builder");
    return {
      ok: false,
      status: 403,
      orgId: targetOrgId,
      role,
      error: {
        code: "FORBIDDEN_ROLE",
        message: missingScope
          ? `MCP token lacks required "${requiredScope}" scope for this operation`
          : "Viewer role cannot mutate project",
      },
    };
  }

  // A write to a project with no row claims it: the row is created in the authorised org, and from then on it is the
  // only source of the project's org. If another org's claim won a race, this caller is refused.
  if (!projectRow) {
    await db
      .prepare(
        `INSERT INTO projects (project_id, org_id, current_revision, semantic_hash, updated_at)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(project_id) DO NOTHING`,
      )
      .bind(project, targetOrgId, semanticHash(createEmptyBlueprint(project)), new Date().toISOString())
      .run();
    projectRow = await readRow();
    if (!projectRow || projectRow.org_id !== targetOrgId) {
      return {
        ok: false,
        status: 403,
        orgId: projectRow?.org_id ?? targetOrgId,
        role: null,
        error: {
          code: "FORBIDDEN_ORG",
          message: "Access denied: project belongs to another organization",
        },
      };
    }
  }

  return { ok: true, orgId: targetOrgId, role };
}

/**
 * The `/api/admin/*` routes are for platform operators only (story 16): a signed-in person listed in
 * `PX_PLATFORM_OPERATORS` (sdk `isPlatformOperator`). Every other caller, and every MCP token, is refused.
 */
export function refuseNonPlatformOperator(
  env: unknown,
  caller: StudioCaller,
): { code: string; message: string } | null {
  if (caller.kind === "mcp_token") {
    return {
      code: "FORBIDDEN_TOKEN_CALLER",
      message: "MCP tokens cannot use platform admin routes",
    };
  }
  if (!isPlatformOperator(env, caller.userId)) {
    return {
      code: "FORBIDDEN_PLATFORM_OPERATOR",
      message: "Only platform operators may use platform admin routes",
    };
  }
  return null;
}

/** Org-level routes (members, cloudflare-tokens, org settings) are for signed-in people only; an MCP token is project-bound. */
export function refuseMcpTokenOnOrgRoute(caller: StudioCaller): { code: string; message: string } | null {
  if (caller.kind !== "mcp_token") return null;
  return {
    code: "FORBIDDEN_TOKEN_CALLER",
    message: "MCP tokens are bound to one project and cannot use organization-level routes; sign in instead",
  };
}

const SignupBodySchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(256),
  displayName: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
});

const LoginBodySchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(256),
});

const CreateOrgBodySchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}$/)
    .optional(),
});

const RoleInputSchema = z.enum(["owner", "admin", "builder", "editor", "viewer"]);

const UpsertMemberBodySchema = z.object({
  userId: z.string().min(1).max(128).optional(),
  email: z.string().email().max(255).optional(),
  role: RoleInputSchema,
});

const UpdateMemberRoleBodySchema = z.object({
  role: RoleInputSchema,
});

const CreateMcpTokenBodySchema = z.object({
  clientName: z.string().min(1).max(120).optional(),
  client: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
  userId: z.string().min(1).max(128).optional(),
  projectId: z.string().regex(PROJECT_SLUG_PATTERN),
  scopes: z.union([z.array(z.string().min(1)), z.string().min(1)]).optional(),
});

const CreateOrgProjectBodySchema = z.object({
  project: z.string().regex(PROJECT_SLUG_PATTERN).optional(),
  slug: z.string().regex(PROJECT_SLUG_PATTERN).optional(),
  name: z.string().min(1).max(120).optional(),
  templateId: z.string().min(1).max(64).optional(),
  source: z.enum(["template", "ai", "blank"]).optional(),
});

function copyAuthHeaders(from: Headers, to: (name: string, value: string) => void): void {
  const setCookie = from.get("set-cookie");
  if (setCookie) to("set-cookie", setCookie);
  const setAuthToken = from.get("set-auth-token");
  if (setAuthToken) to("set-auth-token", setAuthToken);
}

function slugifyOrgName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  const suffix = crypto.randomUUID().slice(0, 6);
  return `${base || "org"}-${suffix}`;
}

function generateMcpPlaintextToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `px_mcp_${hex}`;
}

async function ensurePersonalDefaultOrg(
  db: D1Like,
  userId: string,
  label?: string | null,
): Promise<void> {
  const existing = await db
    .prepare("SELECT org_id FROM studio_org_members WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ org_id: string }>();
  if (existing) return;

  const orgId = `org_personal_${userId}`;
  const cleanLabel = (label?.trim() || "Personal").split("@")[0] || "Personal";
  const orgName = `${cleanLabel}'s Org`;
  const slug = slugifyOrgName(`${cleanLabel}-org`);
  const nowIso = new Date().toISOString();

  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO studio_orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(orgId, slug, orgName, nowIso),
    db
      .prepare(
        "INSERT OR IGNORE INTO studio_org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      )
      .bind(orgId, userId, nowIso),
  ]);

  await recordStudioOnboardingEvent(db, {
    orgId,
    actorId: userId,
    step: "signup_completed",
    createdAt: nowIso,
  }).catch(() => {});
}

async function cleanupUnusedPersonalOrg(db: D1Like, userId: string): Promise<void> {
  const personalOrgId = `org_personal_${userId}`;
  const orgRow = await db
    .prepare("SELECT id FROM studio_orgs WHERE id = ? LIMIT 1")
    .bind(personalOrgId)
    .first<{ id: string }>();
  if (!orgRow) return;

  const hasProject = await db
    .prepare("SELECT project_id FROM projects WHERE org_id = ? LIMIT 1")
    .bind(personalOrgId)
    .first<{ project_id: string }>();
  if (hasProject) return;

  const hasToken = await db
    .prepare("SELECT id FROM studio_mcp_tokens WHERE org_id = ? LIMIT 1")
    .bind(personalOrgId)
    .first<{ id: string }>();
  if (hasToken) return;

  await db.batch([
    db
      .prepare("DELETE FROM studio_org_members WHERE org_id = ?")
      .bind(personalOrgId),
    db.prepare("DELETE FROM studio_orgs WHERE id = ?").bind(personalOrgId),
  ]);
}

// Story 0.21 (threat model audit 18 / B16): the custom login and signup call auth.api.* directly, which skips Better
// Auth's own limiter, so they get the shared SDK limiter with the same buckets and numbers as the core-auth brick.
// Counters live in STUDIO_DB's px_rate_limits; the schema step runs first so a fresh database has the table. Auth rules
// fail closed: a limiter that cannot count answers 503. Operators tune the numbers with PX_RATE_LIMITS.
const STUDIO_AUTH_RATE_LIMITS = {
  loginIp: { bucket: "auth-login-ip", limit: 20, windowSeconds: 600, key: "ip", failClosed: true },
  loginAccount: { bucket: "auth-login-account", limit: 10, windowSeconds: 600, key: "field:email", failClosed: true },
  signupIp: { bucket: "auth-signup-ip", limit: 5, windowSeconds: 3600, key: "ip", failClosed: true },
} satisfies Record<string, RateLimitRule>;
const studioDb = { db: (env: Record<string, unknown>) => env.STUDIO_DB as D1Like | undefined };

export function createStudioAuthAndOrgRoutes(): Hono<{ Bindings: StudioApiEnv }> {
  const router = new Hono<{ Bindings: StudioApiEnv }>();
  const ensureSchema = async (c: { env: StudioApiEnv }, next: () => Promise<void>) => {
    await ensureStudioD1Schema(c.env.STUDIO_DB);
    await next();
  };

  router.post("/api/auth/signup", ensureSchema, rateLimit(STUDIO_AUTH_RATE_LIMITS.signupIp, studioDb), async (c) => {
    const parsed = SignupBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_SIGNUP", issues: parsed.error.issues } }, 400);
    }

    const auth = createStudioBetterAuth(c.env, c.req.url);
    const displayName =
      parsed.data.displayName ?? parsed.data.name ?? parsed.data.email.split("@")[0] ?? "User";
    const res = await auth.api.signUpEmail({
      body: {
        email: parsed.data.email,
        password: parsed.data.password,
        name: displayName,
      },
      headers: c.req.raw.headers,
      asResponse: true,
    });

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
      };
      const isDuplicate =
        res.status === 422 ||
        res.status === 409 ||
        errBody.code === "USER_ALREADY_EXISTS" ||
        errBody.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" ||
        (errBody.message ?? "").toLowerCase().includes("already exists");
      return c.json(
        { error: { code: errBody.code ?? "SIGNUP_FAILED", message: errBody.message ?? "sign-up failed" } },
        isDuplicate ? 409 : 400,
      );
    }

    copyAuthHeaders(res.headers, (k, v) => c.header(k, v));
    const data = (await res.json()) as {
      token: string;
      user: { id: string; email: string; name: string };
    };
    await ensurePersonalDefaultOrg(
      c.env.STUDIO_DB,
      data.user.id,
      data.user.name || data.user.email,
    );
    const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
    return c.json(
      {
        token: data.token,
        user: {
          id: data.user.id,
          email: data.user.email,
          name: data.user.name,
          displayName: data.user.name,
        },
        session: {
          token: data.token,
          expiresAt,
        },
      },
      201,
    );
  });

  router.post(
    "/api/auth/login",
    ensureSchema,
    rateLimit(STUDIO_AUTH_RATE_LIMITS.loginIp, studioDb),
    rateLimit(STUDIO_AUTH_RATE_LIMITS.loginAccount, studioDb),
    async (c) => {
      const parsed = LoginBodySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: { code: "INVALID_LOGIN", issues: parsed.error.issues } }, 400);
      }

      const auth = createStudioBetterAuth(c.env, c.req.url);
      const res = await auth.api.signInEmail({
        body: {
          email: parsed.data.email,
          password: parsed.data.password,
        },
        headers: c.req.raw.headers,
        asResponse: true,
      });

      if (!res.ok) {
        return c.json({ error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } }, 401);
      }

      copyAuthHeaders(res.headers, (k, v) => c.header(k, v));
      const data = (await res.json()) as {
        token: string;
        user: { id: string; email: string; name: string };
      };
      await ensurePersonalDefaultOrg(
        c.env.STUDIO_DB,
        data.user.id,
        data.user.name || data.user.email,
      );
      const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
      return c.json({
        token: data.token,
        user: {
          id: data.user.id,
          email: data.user.email,
          name: data.user.name,
          displayName: data.user.name,
        },
        session: {
          token: data.token,
          expiresAt,
        },
      });
    },
  );

  router.post("/api/auth/logout", async (c) => {
    await ensureStudioD1Schema(c.env.STUDIO_DB);
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const { headers, presentedCredentials } = normalizeStudioAuthHeaders(c.req.raw.headers);
    if (presentedCredentials) {
      const auth = createStudioBetterAuth(c.env, c.req.url);
      const res = await auth.api.signOut({ headers, asResponse: true }).catch(() => null);
      if (res) {
        copyAuthHeaders(res.headers, (k, v) => c.header(k, v));
      }
    }
    return c.json({ ok: true });
  });

  router.get("/api/auth/me", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }
    if (resolved.caller.kind === "mcp_token") {
      return c.json({
        user: {
          id: resolved.caller.userId,
          orgId: resolved.caller.orgId,
          role: resolved.caller.orgRole,
        },
        agent: {
          tokenId: resolved.caller.tokenId,
          clientName: resolved.caller.clientName,
          scopes: resolved.caller.scopes,
        },
      });
    }
    await ensurePersonalDefaultOrg(
      c.env.STUDIO_DB,
      resolved.caller.userId,
      resolved.caller.displayName ?? resolved.caller.email,
    );
    const orgsResult = await c.env.STUDIO_DB.prepare(
      `SELECT o.id, o.slug, o.name, m.role, o.created_at
       FROM studio_orgs o
       JOIN studio_org_members m ON m.org_id = o.id
       WHERE m.user_id = ?
       ORDER BY o.created_at ASC`,
    )
      .bind(resolved.caller.userId)
      .all<{ id: string; slug: string; name: string; role: StudioOrgRole; created_at: string }>();

    return c.json({
      user: {
        id: resolved.caller.userId,
        email: resolved.caller.email,
        name: resolved.caller.displayName ?? resolved.caller.email,
        displayName: resolved.caller.displayName,
      },
      session: {
        id: resolved.caller.sessionId,
      },
      orgs: (orgsResult.results ?? []).map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        role: r.role,
        createdAt: r.created_at,
      })),
    });
  });

  // Better Auth's own email sign-in and sign-up (served by the catch-all below) share the custom routes' buckets, so
  // both entry points count against the same email and IP. These only count; the request goes on to the catch-all.
  router.post(
    "/api/auth/sign-in/email",
    ensureSchema,
    rateLimit(STUDIO_AUTH_RATE_LIMITS.loginIp, studioDb),
    rateLimit(STUDIO_AUTH_RATE_LIMITS.loginAccount, studioDb),
  );
  router.post("/api/auth/sign-up/email", ensureSchema, rateLimit(STUDIO_AUTH_RATE_LIMITS.signupIp, studioDb));

  router.all("/api/auth/*", async (c) => {
    await ensureStudioD1Schema(c.env.STUDIO_DB);
    const auth = createStudioBetterAuth(c.env, c.req.url, 86400, c.req.raw.headers);
    const { headers } = normalizeStudioAuthHeaders(c.req.raw.headers);
    const rawBody =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? undefined
        : await c.req.raw.arrayBuffer();
    const req = new Request(c.req.url, {
      method: c.req.method,
      headers,
      body: rawBody && rawBody.byteLength > 0 ? rawBody : undefined,
    });
    const res = await auth.handler(req);
    if (res.ok && c.req.path.includes("sign-up")) {
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as {
        user?: { id?: string; name?: string; email?: string };
      } | null;
      if (body?.user?.id) {
        await ensurePersonalDefaultOrg(
          c.env.STUDIO_DB,
          body.user.id,
          body.user.name || body.user.email,
        );
      }
    }
    return res;
  });

  // --- Organization & Membership & Scoped MCP Token Routes (/api/orgs) ---

  router.post("/api/orgs", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }
    if (resolved.caller.kind !== "session") {
      return c.json(
        { error: { code: "FORBIDDEN_ROLE", message: "Only human sessions can create organizations" } },
        403,
      );
    }

    const parsed = CreateOrgBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_ORG", issues: parsed.error.issues } }, 400);
    }

    const db = c.env.STUDIO_DB;
    const orgId = `org_${crypto.randomUUID()}`;
    const slug = parsed.data.slug ?? slugifyOrgName(parsed.data.name);
    const nowIso = new Date().toISOString();

    const existingSlug = await db
      .prepare("SELECT id FROM studio_orgs WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ id: string }>();
    if (existingSlug) {
      return c.json(
        { error: { code: "ORG_SLUG_EXISTS", message: `Organization slug "${slug}" already exists` } },
        409,
      );
    }

    await cleanupUnusedPersonalOrg(db, resolved.caller.userId);

    await db.batch([
      db
        .prepare("INSERT INTO studio_orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
        .bind(orgId, slug, parsed.data.name, nowIso),
      db
        .prepare(
          "INSERT INTO studio_org_members (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        )
        .bind(orgId, resolved.caller.userId, nowIso),
    ]);

    await recordStudioAuditLog(db, {
      orgId,
      actorType: "human",
      actorId: resolved.caller.userId,
      action: "org.create",
      status: "succeeded",
      details: { slug, name: parsed.data.name },
    });

    const orgPayload = {
      id: orgId,
      slug,
      name: parsed.data.name,
      role: "owner" as const,
      createdAt: nowIso,
    };

    return c.json({ org: orgPayload, ...orgPayload }, 201);
  });

  router.get("/api/orgs", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const db = c.env.STUDIO_DB;
    if (resolved.caller.kind === "session") {
      await ensurePersonalDefaultOrg(
        db,
        resolved.caller.userId,
        resolved.caller.displayName ?? resolved.caller.email,
      );
    }
    const rows = await db
      .prepare(
        `SELECT o.id, o.slug, o.name, m.role, o.created_at
         FROM studio_orgs o
         JOIN studio_org_members m ON m.org_id = o.id
         WHERE m.user_id = ?
         ORDER BY o.created_at ASC`,
      )
      .bind(resolved.caller.userId)
      .all<{ id: string; slug: string; name: string; role: StudioOrgRole; created_at: string }>();

    // An MCP token sees only the org it is bound to, never its owner's other orgs.
    const tokenOrgId = resolved.caller.kind === "mcp_token" ? resolved.caller.orgId : null;
    const orgs = (rows.results ?? []).filter((row) => tokenOrgId === null || row.id === tokenOrgId).map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      role: row.role,
      createdAt: row.created_at,
    }));

    return c.json({ orgs }, 200);
  });

  router.get("/api/orgs/:orgId", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const tokenRefusal = refuseMcpTokenOnOrgRoute(resolved.caller);
    if (tokenRefusal) {
      return c.json({ error: tokenRefusal }, 403);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;

    const memberRow = await db
      .prepare("SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1")
      .bind(orgId, resolved.caller.userId)
      .first<{ role: StudioOrgRole }>();

    if (!memberRow) {
      return c.json(
        { error: { code: "FORBIDDEN_ORG", message: "Caller is not a member of this organization" } },
        403,
      );
    }

    const orgRow = await db
      .prepare("SELECT id, slug, name, created_at FROM studio_orgs WHERE id = ? LIMIT 1")
      .bind(orgId)
      .first<{ id: string; slug: string; name: string; created_at: string }>();

    if (!orgRow) {
      return c.json({ error: { code: "ORG_NOT_FOUND", message: "Organization not found" } }, 404);
    }

    const membersRes = await db
      .prepare(
        "SELECT org_id, user_id, role, created_at FROM studio_org_members WHERE org_id = ? ORDER BY created_at ASC",
      )
      .bind(orgId)
      .all<{ org_id: string; user_id: string; role: StudioOrgRole; created_at: string }>();

    const projectsRes = await db
      .prepare(
        "SELECT project_id, org_id, current_revision, semantic_hash, updated_at FROM projects WHERE org_id = ? ORDER BY project_id ASC",
      )
      .bind(orgId)
      .all<{
        project_id: string;
        org_id: string;
        current_revision: number;
        semantic_hash: string;
        updated_at: string;
      }>();

    return c.json({
      org: {
        id: orgRow.id,
        slug: orgRow.slug,
        name: orgRow.name,
        role: memberRow.role,
        createdAt: orgRow.created_at,
      },
      members: (membersRes.results ?? []).map((m) => ({
        orgId: m.org_id,
        userId: m.user_id,
        role: m.role,
        createdAt: m.created_at,
      })),
      projects: (projectsRes.results ?? []).map((p) => ({
        project: p.project_id,
        orgId: p.org_id,
        revision: Number(p.current_revision),
        semanticHash: p.semantic_hash,
        updatedAt: p.updated_at,
      })),
    });
  });

  router.post("/api/orgs/:orgId/members", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const tokenRefusal = refuseMcpTokenOnOrgRoute(resolved.caller);
    if (tokenRefusal) {
      return c.json({ error: tokenRefusal }, 403);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;

    const callerMember = await db
      .prepare("SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1")
      .bind(orgId, resolved.caller.userId)
      .first<{ role: StudioOrgRole }>();

    if (!callerMember || !canManageOrg(callerMember.role)) {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "org.member.add",
        status: "forbidden",
        details: { callerRole: callerMember?.role ?? null },
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_ROLE",
            message: "Only owner or admin can manage organization members",
          },
        },
        403,
      );
    }

    const parsed = UpsertMemberBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_MEMBER", issues: parsed.error.issues } }, 400);
    }

    let targetUserId = parsed.data.userId;
    if (!targetUserId && parsed.data.email) {
      const userRow = await db
        .prepare('SELECT "id" FROM "user" WHERE "email" = ? LIMIT 1')
        .bind(parsed.data.email)
        .first<{ id: string }>();
      targetUserId = userRow?.id;
    }

    if (!targetUserId) {
      return c.json(
        { error: { code: "USER_NOT_FOUND", message: "Target user not found" } },
        404,
      );
    }

    const normalizedRole = normalizeOrgRole(parsed.data.role);
    if (normalizedRole === "owner" && callerMember.role !== "owner") {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "org.member.add",
        status: "forbidden",
        targetRef: targetUserId,
        details: {
          targetUserId,
          requestedRole: normalizedRole,
          callerRole: callerMember.role,
        },
        request: c.req.raw,
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_ROLE",
            message: "Only an organization owner can assign the owner role",
          },
        },
        403,
      );
    }
    const nowIso = new Date().toISOString();

    await cleanupUnusedPersonalOrg(db, targetUserId);

    await db
      .prepare(
        `INSERT INTO studio_org_members (org_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(org_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .bind(orgId, targetUserId, normalizedRole, nowIso)
      .run();

    await recordStudioAuditLog(db, {
      orgId,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "org.member.add",
      status: "succeeded",
      details: { targetUserId, role: normalizedRole },
    });

    const memberPayload = {
      orgId,
      userId: targetUserId,
      role: normalizedRole,
      createdAt: nowIso,
    };

    return c.json({ member: memberPayload, ...memberPayload }, 201);
  });

  router.patch("/api/orgs/:orgId/members/:userId", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const tokenRefusal = refuseMcpTokenOnOrgRoute(resolved.caller);
    if (tokenRefusal) {
      return c.json({ error: tokenRefusal }, 403);
    }

    const orgId = c.req.param("orgId");
    const targetUserId = c.req.param("userId");
    const db = c.env.STUDIO_DB;

    const callerMember = await db
      .prepare("SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1")
      .bind(orgId, resolved.caller.userId)
      .first<{ role: StudioOrgRole }>();

    if (!callerMember || !canManageOrg(callerMember.role)) {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "org.member.update_role",
        status: "forbidden",
        details: { targetUserId, callerRole: callerMember?.role ?? null },
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_ROLE",
            message: "Only owner or admin can update member roles",
          },
        },
        403,
      );
    }

    const parsed = UpdateMemberRoleBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_ROLE", issues: parsed.error.issues } }, 400);
    }

    const normalizedRole = normalizeOrgRole(parsed.data.role);
    if (normalizedRole === "owner" && callerMember.role !== "owner") {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "org.member.update_role",
        status: "forbidden",
        targetRef: targetUserId,
        details: {
          targetUserId,
          requestedRole: normalizedRole,
          callerRole: callerMember.role,
        },
        request: c.req.raw,
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_ROLE",
            message: "Only an organization owner can escalate a member to owner",
          },
        },
        403,
      );
    }
    await db
      .prepare("UPDATE studio_org_members SET role = ? WHERE org_id = ? AND user_id = ?")
      .bind(normalizedRole, orgId, targetUserId)
      .run();

    await recordStudioAuditLog(db, {
      orgId,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "org.member.update_role",
      status: "succeeded",
      details: { targetUserId, role: normalizedRole },
    });

    const memberPayload = {
      orgId,
      userId: targetUserId,
      role: normalizedRole,
    };

    return c.json({ member: memberPayload, ...memberPayload }, 200);
  });

  router.post("/api/orgs/:orgId/mcp-tokens", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;

    // Story 0.15: only a signed-in person issues tokens. An MCP token can never mint another token, whatever its
    // owner's role.
    if (resolved.caller.kind === "mcp_token") {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "org.mcp_token.create",
        status: "forbidden",
        details: { code: "FORBIDDEN_TOKEN_CALLER", tokenId: resolved.caller.tokenId },
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_TOKEN_CALLER",
            message: "MCP tokens cannot issue MCP tokens; sign in as an organization owner or admin",
          },
        },
        403,
      );
    }

    const callerMember = await db
      .prepare("SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1")
      .bind(orgId, resolved.caller.userId)
      .first<{ role: StudioOrgRole }>();

    if (!callerMember || !canManageOrg(callerMember.role)) {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "org.mcp_token.create",
        status: "forbidden",
        details: { callerRole: callerMember?.role ?? null },
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_ROLE",
            message: "Only owner or admin can issue organization MCP tokens",
          },
        },
        403,
      );
    }

    const parsed = CreateMcpTokenBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: { code: "INVALID_MCP_TOKEN_REQUEST", issues: parsed.error.issues } }, 400);
    }

    const targetUserId = parsed.data.userId ?? resolved.caller.userId;
    const targetMember = await db
      .prepare("SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1")
      .bind(orgId, targetUserId)
      .first<{ role: StudioOrgRole }>();

    if (!targetMember) {
      return c.json(
        { error: { code: "MEMBER_NOT_FOUND", message: "Target user is not a member of this organization" } },
        404,
      );
    }

    const clientName =
      parsed.data.clientName ?? parsed.data.client ?? parsed.data.name ?? "claude-code";
    const defaultScopes: StudioMcpScope[] =
      targetMember.role === "viewer" ? ["read"] : ["read", "edit"];
    const requestedScopes =
      parsed.data.scopes === undefined
        ? defaultScopes
        : Array.isArray(parsed.data.scopes)
          ? parsed.data.scopes.map((s) => s.trim())
          : parseTokenScopes(parsed.data.scopes);
    const invalidScopes = requestedScopes.filter((s) => !isStudioMcpScope(s));
    if (requestedScopes.length === 0 || invalidScopes.length > 0) {
      return c.json(
        {
          error: {
            code: "INVALID_MCP_TOKEN_SCOPE",
            message: `Scopes must be one or more of ${STUDIO_MCP_SCOPES.join(", ")}`,
            invalidScopes,
          },
        },
        400,
      );
    }
    const scopes = [...new Set(requestedScopes)] as StudioMcpScope[];

    // The token is bound to one project, and that project must belong to this organization.
    const projectId = parsed.data.projectId;
    const projectRow = await db
      .prepare("SELECT org_id FROM projects WHERE project_id = ? LIMIT 1")
      .bind(projectId)
      .first<{ org_id: string }>();
    if (!projectRow) {
      return c.json(
        { error: { code: "PROJECT_NOT_FOUND", message: "Project not found in this organization" } },
        404,
      );
    }
    if (projectRow.org_id !== orgId) {
      await recordStudioAuditLog(db, {
        orgId,
        projectId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "org.mcp_token.create",
        status: "forbidden",
        details: { code: "FORBIDDEN_PROJECT" },
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_PROJECT",
            message: "Project belongs to another organization",
          },
        },
        403,
      );
    }

    const plaintextToken = generateMcpPlaintextToken();
    const tokenHash = await sha256Hex(plaintextToken);
    const tokenId = `mcp_${crypto.randomUUID()}`;
    const nowIso = new Date().toISOString();

    await db
      .prepare(
        `INSERT INTO studio_mcp_tokens (
          id, org_id, project_id, user_id, client_name, token_hash, scopes, revoked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(tokenId, orgId, projectId, targetUserId, clientName, tokenHash, scopes.join(","), nowIso)
      .run();

    await recordStudioAuditLog(db, {
      orgId,
      projectId,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "org.mcp_token.create",
      status: "succeeded",
      details: { tokenId, targetUserId, clientName, projectId, scopes },
    });

    const tokenRecord = {
      id: tokenId,
      orgId,
      projectId,
      userId: targetUserId,
      clientName,
      scopes,
      revokedAt: null,
      createdAt: nowIso,
    };

    return c.json(
      {
        token: plaintextToken,
        mcpToken: tokenRecord,
        ...tokenRecord,
      },
      201,
    );
  });

  router.delete("/api/orgs/:orgId/mcp-tokens/:tokenId", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const tokenId = c.req.param("tokenId");
    const db = c.env.STUDIO_DB;

    if (resolved.caller.kind === "mcp_token") {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "org.mcp_token.revoke",
        status: "forbidden",
        details: { code: "FORBIDDEN_TOKEN_CALLER", tokenId },
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_TOKEN_CALLER",
            message: "MCP tokens cannot revoke MCP tokens; sign in as an organization owner or admin",
          },
        },
        403,
      );
    }

    const callerMember = await db
      .prepare("SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1")
      .bind(orgId, resolved.caller.userId)
      .first<{ role: StudioOrgRole }>();

    if (!callerMember || !canManageOrg(callerMember.role)) {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "org.mcp_token.revoke",
        status: "forbidden",
        details: { tokenId, callerRole: callerMember?.role ?? null },
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_ROLE",
            message: "Only owner or admin can revoke MCP tokens",
          },
        },
        403,
      );
    }

    const nowIso = new Date().toISOString();
    await db
      .prepare("UPDATE studio_mcp_tokens SET revoked_at = ? WHERE id = ? AND org_id = ?")
      .bind(nowIso, tokenId, orgId)
      .run();

    await recordStudioAuditLog(db, {
      orgId,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "org.mcp_token.revoke",
      status: "succeeded",
      details: { tokenId, revokedAt: nowIso },
    });

    return c.json({ ok: true, id: tokenId, revokedAt: nowIso }, 200);
  });

  router.post("/api/orgs/:orgId/projects", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;

    // Story 0.15: an MCP token is bound to one project and cannot create others.
    if (resolved.caller.kind === "mcp_token") {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.create",
        status: "forbidden",
        details: { code: "FORBIDDEN_TOKEN_CALLER", tokenId: resolved.caller.tokenId },
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_TOKEN_CALLER",
            message: "MCP tokens are bound to one project and cannot create projects; sign in to create one",
          },
        },
        403,
      );
    }

    const callerMember = await db
      .prepare("SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1")
      .bind(orgId, resolved.caller.userId)
      .first<{ role: StudioOrgRole }>();

    if (!callerMember) {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.create",
        status: "forbidden",
        details: { code: "FORBIDDEN_ORG" },
      });
      return c.json(
        { error: { code: "FORBIDDEN_ORG", message: "Caller is not a member of this organization" } },
        403,
      );
    }

    if (!canMutateProject(callerMember.role)) {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.create",
        status: "forbidden",
        details: { code: "FORBIDDEN_ROLE", role: callerMember.role },
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_ROLE",
            message: "Viewer role cannot mutate project",
          },
        },
        403,
      );
    }

    const parsed = CreateOrgProjectBodySchema.safeParse(await c.req.json().catch(() => null));
    const requestedTemplateId = parsed.success ? parsed.data.templateId?.trim() : undefined;
    const projectSlug = parsed.success
      ? (parsed.data.project ?? parsed.data.slug ?? requestedTemplateId)
      : undefined;
    if (!projectSlug || !PROJECT_SLUG_PATTERN.test(projectSlug)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: "Provide a valid project slug matching ^[a-z][a-z0-9-]{0,39}$",
          },
        },
        400,
      );
    }

    const templateInst = requestedTemplateId
      ? instantiateStarterTemplateForProject(requestedTemplateId, projectSlug)
      : null;
    if (requestedTemplateId && !templateInst) {
      return c.json(
        {
          error: {
            code: "UNKNOWN_TEMPLATE",
            message: `Unknown starter template "${requestedTemplateId}"`,
          },
        },
        400,
      );
    }

    const existing = await db
      .prepare("SELECT project_id, org_id FROM projects WHERE project_id = ? LIMIT 1")
      .bind(projectSlug)
      .first<{ project_id: string; org_id: string }>();

    if (existing && existing.org_id !== orgId) {
      return c.json(
        {
          error: {
            code: "PROJECT_ALREADY_EXISTS",
            message: `Project "${projectSlug}" belongs to another organization`,
          },
        },
        409,
      );
    }

    const emptyState = createEmptyBlueprint(projectSlug);
    const initialState = templateInst ? templateInst.state : emptyState;
    const initialHash = templateInst ? templateInst.semanticHash : semanticHash(emptyState);
    const initialRevision = templateInst ? 1 : 0;
    const nowIso = new Date().toISOString();

    await db
      .prepare(
        `INSERT INTO projects (project_id, org_id, current_revision, semantic_hash, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           org_id = excluded.org_id,
           current_revision = excluded.current_revision,
           semantic_hash = excluded.semantic_hash,
           updated_at = excluded.updated_at`,
      )
      .bind(projectSlug, orgId, initialRevision, initialHash, nowIso)
      .run();

    if (c.env.BLUEPRINT_DO) {
      const doId = c.env.BLUEPRINT_DO.idFromName(projectSlug);
      const stub = c.env.BLUEPRINT_DO.get(doId);
      if (templateInst) {
        await stub.fetch("http://blueprint-do/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project: projectSlug,
            orgId,
            callerRole: callerMember.role,
            mode: "replace",
            bundle: templateInst.bundle,
            author: resolved.caller.author,
          }),
        });
      } else {
        await stub.fetch("http://blueprint-do/init", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: projectSlug, orgId }),
        });
      }
    }

    const effectiveSource = templateInst
      ? "template"
      : (parsed.success && parsed.data.source ? parsed.data.source : "blank");

    await recordStudioOnboardingEvent(db, {
      orgId,
      projectId: projectSlug,
      actorId: resolved.caller.userId,
      step: "project_created",
      metadata: {
        source: effectiveSource,
        ...(templateInst ? { templateId: templateInst.templateId } : {}),
      },
      createdAt: nowIso,
    }).catch(() => {});

    await recordStudioAuditLog(db, {
      orgId,
      projectId: projectSlug,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "project.create",
      status: "succeeded",
      details: {
        project: projectSlug,
        orgId,
        source: effectiveSource,
        ...(templateInst ? { templateId: templateInst.templateId } : {}),
      },
    });

    const projectPayload = {
      project: projectSlug,
      orgId,
      revision: initialRevision,
      semanticHash: initialHash,
      state: initialState,
      readiness: templateInst ? templateInst.readiness : { ready: false, needs: [] },
      templateId: templateInst ? templateInst.templateId : null,
      seededFromTemplate: Boolean(templateInst),
      source: effectiveSource,
      updatedAt: nowIso,
    };

    return c.json(projectPayload, 201);
  });

  router.delete("/api/orgs/:orgId", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const tokenRefusal = refuseMcpTokenOnOrgRoute(resolved.caller);
    if (tokenRefusal) {
      return c.json({ error: tokenRefusal }, 403);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;

    const callerMember = await db
      .prepare("SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1")
      .bind(orgId, resolved.caller.userId)
      .first<{ role: StudioOrgRole }>();

    if (!callerMember) {
      return c.json(
        { error: { code: "FORBIDDEN_ORG", message: "Caller is not a member of this organization" } },
        403,
      );
    }

    if (callerMember.role !== "owner" || resolved.caller.kind !== "session") {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "org.delete",
        status: "forbidden",
        targetRef: orgId,
        details: { callerRole: callerMember.role },
        request: c.req.raw,
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_ROLE",
            message: "Only an organization owner can delete an organization",
          },
        },
        403,
      );
    }

    await db.batch([
      db.prepare("DELETE FROM studio_org_members WHERE org_id = ?").bind(orgId),
      db.prepare("DELETE FROM studio_mcp_tokens WHERE org_id = ?").bind(orgId),
      db.prepare("DELETE FROM projects WHERE org_id = ?").bind(orgId),
      db.prepare("DELETE FROM studio_orgs WHERE id = ?").bind(orgId),
    ]);

    await recordStudioAuditLog(db, {
      orgId,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "org.delete",
      status: "succeeded",
      targetRef: orgId,
      details: { deletedOrgId: orgId },
      request: c.req.raw,
    });

    return c.json({ ok: true, deletedOrgId: orgId }, 200);
  });

  const handleGetOrgAuditLogs = async (c: {
    env: StudioApiEnv;
    req: {
      raw: Request;
      param: (name: string) => string;
      query: (name: string) => string | undefined;
    };
    json: (body: unknown, status?: number) => Response;
  }) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const tokenRefusal = refuseMcpTokenOnOrgRoute(resolved.caller);
    if (tokenRefusal) {
      return c.json({ error: tokenRefusal }, 403);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;

    const callerMember = await db
      .prepare("SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1")
      .bind(orgId, resolved.caller.userId)
      .first<{ role: StudioOrgRole }>();

    if (!callerMember) {
      return c.json(
        { error: { code: "FORBIDDEN_ORG", message: "Caller is not a member of this organization" } },
        403,
      );
    }

    const projectFilter = c.req.query("projectId") ?? c.req.query("project") ?? undefined;
    const actionFilter = c.req.query("action") ?? undefined;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;

    const entries = await queryStudioAuditLogs(db, {
      orgId,
      ...(projectFilter ? { projectId: projectFilter } : {}),
      ...(actionFilter ? { action: actionFilter } : {}),
      ...(limit && Number.isFinite(limit) ? { limit } : {}),
    });

    return c.json({
      orgId,
      entries,
      logs: entries,
      auditLogs: entries,
    });
  };

  router.get("/api/orgs/:orgId/audit-log", (c) => handleGetOrgAuditLogs(c as never));
  router.get("/api/orgs/:orgId/audit-logs", (c) => handleGetOrgAuditLogs(c as never));

  return router;
}

const DEFAULT_TEST_SESSION_TOKEN = "studio-cp1-test-owner-token-0123456789";
/** The one project the seeded test MCP token is bound to. */
export const DEFAULT_TEST_PROJECT_ID = "default-project";

/**
 * Seeds a default test user, organization (`org_default`), and MCP/session token in `STUDIO_DB`
 * for test suites that exercise Studio API endpoints.
 */
export async function ensureDefaultTestAuth(env: StudioApiEnv): Promise<{
  token: string;
  userId: string;
  orgId: string;
  headers: Record<string, string>;
}> {
  const db = env.STUDIO_DB;
  await ensureStudioD1Schema(db);

  const userId = "user_cp1_default_owner";
  const orgId = "org_default";
  const tokenId = "mcp_cp1_default_owner"; // gitleaks:allow (a row id, not a secret)
  const tokenHash = await sha256Hex(DEFAULT_TEST_SESSION_TOKEN);
  const nowIso = new Date().toISOString();

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
         VALUES (?, 'CP1 Test Owner', 'cp1-owner@example.test', 1, ?, ?)`,
      )
      .bind(userId, nowIso, nowIso),
    db
      .prepare(
        `INSERT OR IGNORE INTO studio_orgs (id, slug, name, created_at)
         VALUES (?, 'org-default', 'Default Organization', ?)`,
      )
      .bind(orgId, nowIso),
    db
      .prepare(
        `INSERT OR IGNORE INTO studio_org_members (org_id, user_id, role, created_at)
         VALUES (?, ?, 'owner', ?)`,
      )
      .bind(orgId, userId, nowIso),
    db
      .prepare(
        `INSERT OR IGNORE INTO studio_mcp_tokens (
          id, org_id, project_id, user_id, client_name, token_hash, scopes, revoked_at, created_at
        ) VALUES (?, ?, ?, ?, 'studio-test', ?, 'read,edit,deploy,connect', NULL, ?)`,
      )
      .bind(tokenId, orgId, DEFAULT_TEST_PROJECT_ID, userId, tokenHash, nowIso),
    // A token is only ever issued for a project that has a row (story 16), so the seed token's project has one too.
    db
      .prepare(
        `INSERT OR IGNORE INTO projects (project_id, org_id, current_revision, semantic_hash, updated_at)
         VALUES (?, ?, 0, ?, ?)`,
      )
      .bind(
        DEFAULT_TEST_PROJECT_ID,
        orgId,
        semanticHash(createEmptyBlueprint(DEFAULT_TEST_PROJECT_ID)),
        nowIso,
      ),
  ]);
  // A row seeded before story 0.15 has no project; bind it so the seed token stays usable.
  await db
    .prepare(
      "UPDATE studio_mcp_tokens SET project_id = ?, scopes = 'read,edit,deploy,connect' WHERE id = ? AND project_id IS NULL",
    )
    .bind(DEFAULT_TEST_PROJECT_ID, tokenId)
    .run();

  return {
    token: DEFAULT_TEST_SESSION_TOKEN,
    userId,
    orgId,
    headers: {
      authorization: `Bearer ${DEFAULT_TEST_SESSION_TOKEN}`,
    },
  };
}
