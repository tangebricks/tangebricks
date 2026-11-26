// AD-V8 / R56: approval requests for destructive actions an MCP agent asks for.
//
// An MCP token that deploys, promotes, rolls back, reverts, or deploys/promotes a sandbox is refused with
// APPROVAL_REQUIRED and a pending approval request is stored. A Studio session user with editor+ (builder, admin,
// owner) approves or rejects it in Studio; the agent then retries with the approval id. An approval is bound to the
// org, project, action, environment, target, blueprint revision and (for deploy and promote) the plan fingerprint, it
// expires after 24 h, and it is consumed exactly once by a conditional UPDATE whose row count is checked.
//
// Every gate decision keys on the verified StudioCaller.kind from resolveStudioCaller, never on a body field, header or
// tool argument. `requireApproval` is the one helper every gated route (and any future delete or brick-upgrade route)
// calls.

import { sha256Hex } from "@poc/assembler";
import type { D1Like } from "@poc/sdk";
import { recordStudioAuditLog } from "./auth.ts";
import type { StudioCaller } from "./auth.ts";
import { STUDIO_APPROVAL_REQUESTS_DDL } from "./blueprint-do.ts";

export type ApprovalAction =
  | "deploy"
  | "promote"
  | "rollback"
  | "revert"
  | "sandbox_deploy"
  | "promote_to_byoc"
  | "import";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed" | "expired";

/** How long an approval request stays usable after it is created. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;


/** What an approval is bound to. The org always comes from `authorizeProjectAccess`, never from input. */
export interface ApprovalBinding {
  orgId: string;
  projectId: string;
  action: ApprovalAction;
  env?: string | null;
  target?: string | null;
  blueprintRev: number;
  planFingerprint?: string | null;
  /** Shown to the reviewer in Studio: plan action, hashes, migrations, diff summary. Never secrets. */
  summary?: Record<string, unknown>;
}

export interface ApprovalRequestRecord {
  approvalId: string;
  projectId: string;
  action: ApprovalAction;
  env: string | null;
  target: string | null;
  blueprintRev: number;
  planFingerprint: string | null;
  status: ApprovalStatus;
  requestedBy: { tokenId: string; clientName: string | null; userId: string | null };
  decidedBy: string | null;
  summary: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
  consumedAt: string | null;
  expiresAt: string;
}

interface ApprovalRow {
  id: string;
  org_id: string;
  project_id: string;
  action: string;
  env: string;
  target: string;
  blueprint_rev: number;
  plan_fingerprint: string;
  status: string;
  requested_by_token: string;
  decided_by_user: string | null;
  summary_json: string;
  created_at: string;
  decided_at: string | null;
  consumed_at: string | null;
  expires_at: string;
}

const APPROVAL_COLUMNS =
  "id, org_id, project_id, action, env, target, blueprint_rev, plan_fingerprint, status, requested_by_token, decided_by_user, summary_json, created_at, decided_at, consumed_at, expires_at";

export interface ApprovalErrorBody {
  error: {
    code:
      | "APPROVAL_REQUIRED"
      | "APPROVAL_PENDING"
      | "APPROVAL_USED"
      | "APPROVAL_REJECTED"
      | "APPROVAL_EXPIRED"
      | "APPROVAL_STALE"
      | "APPROVAL_NOT_FOUND"
      | "APPROVAL_SESSION_REQUIRED"
      | "APPROVAL_ALREADY_DECIDED";
    message: string;
    approvalId?: string;
    remediation: string;
  };
}

export type RequireApprovalResult =
  | { ok: true; approvalId: string | null; consumedAt?: string }
  | { ok: false; status: 403 | 404 | 409; body: ApprovalErrorBody };

export async function ensureApprovalSchema(db: D1Like): Promise<void> {
  await db.batch(STUDIO_APPROVAL_REQUESTS_DDL.map((sql) => db.prepare(sql)));
}

function rowStatus(row: ApprovalRow, nowMs: number): ApprovalStatus {
  if (row.status === "consumed" || row.consumed_at) return "consumed";
  if (row.status === "rejected") return "rejected";
  if (Date.parse(row.expires_at) <= nowMs) return "expired";
  return row.status === "approved" ? "approved" : "pending";
}

function toRecord(row: ApprovalRow, nowMs: number): ApprovalRequestRecord {
  let summary: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.summary_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      summary = parsed as Record<string, unknown>;
    }
  } catch {
    summary = {};
  }
  const requester =
    summary.requestedBy && typeof summary.requestedBy === "object"
      ? (summary.requestedBy as { clientName?: unknown; userId?: unknown })
      : {};
  return {
    approvalId: row.id,
    projectId: row.project_id,
    action: row.action as ApprovalAction,
    env: row.env || null,
    target: row.target || null,
    blueprintRev: Number(row.blueprint_rev),
    planFingerprint: row.plan_fingerprint || null,
    status: rowStatus(row, nowMs),
    requestedBy: {
      tokenId: row.requested_by_token,
      clientName: typeof requester.clientName === "string" ? requester.clientName : null,
      userId: typeof requester.userId === "string" ? requester.userId : null,
    },
    decidedBy: row.decided_by_user,
    summary,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    consumedAt: row.consumed_at,
    expiresAt: row.expires_at,
  };
}

async function readApprovalRow(
  db: D1Like,
  orgId: string,
  projectId: string,
  approvalId: string,
): Promise<ApprovalRow | null> {
  return db
    .prepare(
      `SELECT ${APPROVAL_COLUMNS} FROM studio_approval_requests WHERE id = ? AND org_id = ? AND project_id = ? LIMIT 1`,
    )
    .bind(approvalId, orgId, projectId)
    .first<ApprovalRow>();
}

/** One migration as the reviewer sees it: its name, the sha256 and size of its SQL, and whether it is destructive. */
export interface ApprovalMigrationSummary {
  name: string;
  sha256: string;
  bytes: number;
  destructive: boolean;
}

/**
 * The migrations a deploy or promote would run, by name and SQL content. Custom migration SQL comes from the request
 * body, so the content (not just the name) is what an approval is bound to.
 */
export async function summarizePlanMigrations(input: {
  pendingMigrations: readonly string[];
  pendingMigrationSql?: Readonly<Record<string, string>>;
  customMigrations?: ReadonlyArray<{ name?: string; migrationName?: string; sql: string }>;
  destructiveNames?: readonly string[];
}): Promise<ApprovalMigrationSummary[]> {
  const sqlByName = new Map<string, string>(Object.entries(input.pendingMigrationSql ?? {}));
  for (const m of input.customMigrations ?? []) {
    const name = m.name ?? m.migrationName ?? "";
    // A custom migration's SQL always counts, even when the plan already lists one with the same name.
    sqlByName.set(name, `${sqlByName.get(name) ?? ""}\n-- custom --\n${m.sql}`);
  }
  const names = new Set<string>([...input.pendingMigrations, ...sqlByName.keys()]);
  const destructive = new Set(input.destructiveNames ?? []);
  const out: ApprovalMigrationSummary[] = [];
  for (const name of [...names].sort()) {
    const sql = sqlByName.get(name) ?? "";
    out.push({
      name,
      sha256: await sha256Hex(sql),
      bytes: new TextEncoder().encode(sql).length,
      destructive: destructive.has(name),
    });
  }
  return out;
}

/** The fingerprint of a deploy or promote plan: what would change, so an approval cannot be reused for another plan. */
export async function computePlanFingerprint(input: {
  envName: string;
  action: string;
  buildHash: string;
  codeHash: string;
  graphHash: string;
  revision: number;
  pendingMigrations?: readonly string[];
  /** Each migration's name and SQL hash (summarizePlanMigrations): different SQL under the same name is another plan. */
  migrations?: readonly ApprovalMigrationSummary[];
  confirmDestructive?: boolean;
  confirmedMigrationNames?: readonly string[];
  /** Anything else the action is bound to (e.g. the destination account of a promotion). */
  extra?: Record<string, unknown>;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      envName: input.envName,
      action: input.action,
      buildHash: input.buildHash,
      codeHash: input.codeHash,
      graphHash: input.graphHash,
      revision: input.revision,
      pendingMigrations: [...(input.pendingMigrations ?? [])].sort(),
      migrations: (input.migrations ?? []).map((m) => `${m.name}:${m.sha256}:${m.destructive ? 1 : 0}`),
      confirmDestructive: input.confirmDestructive === true,
      confirmedMigrationNames: [...(input.confirmedMigrationNames ?? [])].sort(),
      extra: input.extra ?? null,
    }),
  );
}

function refusal(
  status: 403 | 404 | 409,
  code: ApprovalErrorBody["error"]["code"],
  message: string,
  remediation: string,
  approvalId?: string,
): RequireApprovalResult {
  return {
    ok: false,
    status,
    body: { error: { code, message, ...(approvalId ? { approvalId } : {}), remediation } },
  };
}

const RETRY_REMEDIATION = (approvalId: string) =>
  `Ask an editor to approve request ${approvalId} in Studio (Pending approvals), then retry the same call with approvalId "${approvalId}".`;

/**
 * AD-V8: the one gate for destructive actions. A Studio session caller is the human reviewer and is never gated. An
 * MCP token without `approvalId` gets APPROVAL_REQUIRED and a pending request (an identical pending one is reused).
 * With `approvalId`, the approval must belong to this org and project, be approved, unexpired, unused and match the
 * binding; it is then consumed atomically, exactly once.
 */
export async function requireApproval(
  db: D1Like,
  caller: StudioCaller,
  binding: ApprovalBinding,
  approvalId: string | undefined,
  now: Date = new Date(),
): Promise<RequireApprovalResult> {
  if (caller.kind === "session") return { ok: true, approvalId: null };
  await ensureApprovalSchema(db);

  const env = binding.env ?? "";
  const target = binding.target ?? "";
  const fingerprint = binding.planFingerprint ?? "";
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const audit = (action: string, status: string, details: Record<string, unknown>) =>
    recordStudioAuditLog(db, {
      orgId: binding.orgId,
      projectId: binding.projectId,
      actorType: caller.author.type,
      actorId: caller.author.id,
      action,
      status,
      targetRef: `${binding.projectId}:${binding.action}${env ? `:${env}` : ""}`,
      details: {
        ...details,
        gatedAction: binding.action,
        env: env || null,
        target: target || null,
        ...(caller.author.client ? { client: caller.author.client } : {}),
      },
    });

  if (approvalId === undefined || approvalId.trim().length === 0) {
    const existing = await db
      .prepare(
        `SELECT ${APPROVAL_COLUMNS} FROM studio_approval_requests
         WHERE org_id = ? AND project_id = ? AND action = ? AND env = ? AND target = ? AND blueprint_rev = ?
           AND plan_fingerprint = ? AND requested_by_token = ? AND status = 'pending' AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(
        binding.orgId,
        binding.projectId,
        binding.action,
        env,
        target,
        binding.blueprintRev,
        fingerprint,
        caller.tokenId,
        nowIso,
      )
      .first<ApprovalRow>();

    let id: string;
    let reused = false;
    if (existing) {
      id = existing.id;
      reused = true;
    } else {
      id = `apr_${crypto.randomUUID().replace(/-/g, "")}`;
      const summary = {
        ...(binding.summary ?? {}),
        requestedBy: {
          tokenId: caller.tokenId,
          clientName: caller.clientName,
          userId: caller.userId,
        },
      };
      await db
        .prepare(
          `INSERT INTO studio_approval_requests
             (id, org_id, project_id, action, env, target, blueprint_rev, plan_fingerprint, status,
              requested_by_token, summary_json, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .bind(
          id,
          binding.orgId,
          binding.projectId,
          binding.action,
          env,
          target,
          binding.blueprintRev,
          fingerprint,
          caller.tokenId,
          JSON.stringify(summary),
          nowIso,
          new Date(nowMs + APPROVAL_TTL_MS).toISOString(),
        )
        .run();
    }
    await audit("project.approval.request", "pending", { approvalId: id, reused });
    return refusal(
      403,
      "APPROVAL_REQUIRED",
      `An MCP agent cannot ${binding.action.replace(/_/g, " ")} without a human approval (AD-V8). Approval request ${id} is pending.`,
      RETRY_REMEDIATION(id),
      id,
    );
  }

  // An approval belongs to the token that asked for it: another token on the project cannot reuse or consume it (it
  // gets the same answer as for an id that does not exist, and asks for its own).
  const found = await readApprovalRow(db, binding.orgId, binding.projectId, approvalId);
  const row = found && found.requested_by_token === caller.tokenId ? found : null;
  if (!row) {
    await audit("project.approval.consume", "refused", { code: "APPROVAL_NOT_FOUND" });
    return refusal(
      404,
      "APPROVAL_NOT_FOUND",
      "No approval with this id exists for this project.",
      "Retry without approvalId to create a new approval request, then ask an editor to approve it in Studio.",
    );
  }

  const status = rowStatus(row, nowMs);
  const refuse = async (
    httpStatus: 403 | 409,
    code: ApprovalErrorBody["error"]["code"],
    message: string,
    remediation: string,
  ) => {
    await audit("project.approval.consume", "refused", { approvalId: row.id, code });
    return refusal(httpStatus, code, message, remediation, row.id);
  };
  const newRequest =
    "Retry without approvalId to create a new approval request, then ask an editor to approve it in Studio.";

  if (status === "consumed") {
    return refuse(409, "APPROVAL_USED", `Approval ${row.id} was already used; an approval is single-use.`, newRequest);
  }
  if (status === "rejected") {
    return refuse(403, "APPROVAL_REJECTED", `Approval ${row.id} was rejected by a reviewer.`, newRequest);
  }
  if (status === "expired") {
    return refuse(403, "APPROVAL_EXPIRED", `Approval ${row.id} expired (approvals last 24 hours).`, newRequest);
  }
  if (status === "pending") {
    return refuse(
      403,
      "APPROVAL_PENDING",
      `Approval ${row.id} has not been approved yet.`,
      RETRY_REMEDIATION(row.id),
    );
  }
  if (
    row.action !== binding.action ||
    row.env !== env ||
    row.target !== target ||
    Number(row.blueprint_rev) !== binding.blueprintRev ||
    row.plan_fingerprint !== fingerprint
  ) {
    return refuse(
      409,
      "APPROVAL_STALE",
      `Approval ${row.id} was granted for a different ${row.action !== binding.action ? "action" : row.env !== env || row.target !== target ? "environment or target" : "blueprint revision or plan"}; what would run now is not what was approved.`,
      newRequest,
    );
  }

  const consumed = await db
    .prepare(
      `UPDATE studio_approval_requests SET status = 'consumed', consumed_at = ?
       WHERE id = ? AND org_id = ? AND project_id = ? AND requested_by_token = ? AND status = 'approved'
         AND consumed_at IS NULL AND expires_at > ?`,
    )
    .bind(nowIso, row.id, binding.orgId, binding.projectId, caller.tokenId, nowIso)
    .run();
  if ((consumed.meta?.changes ?? 0) !== 1) {
    return refuse(409, "APPROVAL_USED", `Approval ${row.id} was already used; an approval is single-use.`, newRequest);
  }
  await audit("project.approval.consume", "succeeded", { approvalId: row.id });
  return { ok: true, approvalId: row.id, consumedAt: nowIso };
}

/**
 * The action an approval was consumed for failed: give the approval back (status `approved`, not consumed) so the same
 * bound retry can run. Only the consumption this caller made is undone (conditional on the id and the consumed_at it
 * set), so a second, concurrent use can never be revived. Audited as `project.approval.release`.
 */
export async function releaseApproval(
  db: D1Like,
  caller: StudioCaller,
  input: { orgId: string; projectId: string; approvalId: string; consumedAt: string; reason: string },
): Promise<boolean> {
  await ensureApprovalSchema(db);
  const released = await db
    .prepare(
      `UPDATE studio_approval_requests SET status = 'approved', consumed_at = NULL
       WHERE id = ? AND org_id = ? AND project_id = ? AND status = 'consumed' AND consumed_at = ?`,
    )
    .bind(input.approvalId, input.orgId, input.projectId, input.consumedAt)
    .run();
  const ok = (released.meta?.changes ?? 0) === 1;
  await recordStudioAuditLog(db, {
    orgId: input.orgId,
    projectId: input.projectId,
    actorType: caller.author.type,
    actorId: caller.author.id,
    action: "project.approval.release",
    status: ok ? "succeeded" : "refused",
    details: { approvalId: input.approvalId, reason: input.reason },
  });
  return ok;
}

/** AD-V8: a project's approval requests, newest first, optionally filtered by status. */
export async function listApprovalRequests(
  db: D1Like,
  orgId: string,
  projectId: string,
  status?: ApprovalStatus,
  now: Date = new Date(),
): Promise<ApprovalRequestRecord[]> {
  await ensureApprovalSchema(db);
  const nowIso = now.toISOString();
  // The status is filtered in SQL, before the limit, so older rows of the wanted status are never cut off.
  const statusSql: Record<ApprovalStatus, string> = {
    pending: "status = 'pending' AND expires_at > ?",
    approved: "status = 'approved' AND consumed_at IS NULL AND expires_at > ?",
    expired: "status IN ('pending', 'approved') AND consumed_at IS NULL AND expires_at <= ?",
    rejected: "status = 'rejected'",
    consumed: "(status = 'consumed' OR consumed_at IS NOT NULL)",
  };
  const filter = status ? ` AND ${statusSql[status]}` : "";
  const binds: unknown[] = [orgId, projectId];
  if (status && statusSql[status].includes("?")) binds.push(nowIso);
  const rows = await db
    .prepare(
      `SELECT ${APPROVAL_COLUMNS} FROM studio_approval_requests
       WHERE org_id = ? AND project_id = ?${filter} ORDER BY created_at DESC LIMIT 200`,
    )
    .bind(...binds)
    .all<ApprovalRow>();
  const records = (rows.results ?? []).map((row) => toRecord(row, now.getTime()));
  return status ? records.filter((r) => r.status === status) : records;
}

export type DecideApprovalResult =
  | { ok: true; approval: ApprovalRequestRecord }
  | { ok: false; status: 403 | 404 | 409; body: ApprovalErrorBody };

/**
 * Approves or rejects a pending request. The caller must already be a verified Studio session user with editor+ on the
 * project (the route checks `caller.kind` and `authorizeProjectAccess`); this only changes a pending, unexpired row.
 */
export async function decideApprovalRequest(
  db: D1Like,
  input: {
    orgId: string;
    projectId: string;
    approvalId: string;
    decision: "approved" | "rejected";
    userId: string;
  },
  now: Date = new Date(),
): Promise<DecideApprovalResult> {
  await ensureApprovalSchema(db);
  const nowIso = now.toISOString();
  const row = await readApprovalRow(db, input.orgId, input.projectId, input.approvalId);
  if (!row) {
    return {
      ok: false,
      status: 404,
      body: {
        error: {
          code: "APPROVAL_NOT_FOUND",
          message: "No approval with this id exists for this project.",
          remediation: "Reload the pending approvals list.",
        },
      },
    };
  }
  const current = rowStatus(row, now.getTime());
  if (current === "expired") {
    return {
      ok: false,
      status: 403,
      body: {
        error: {
          code: "APPROVAL_EXPIRED",
          message: `Approval ${row.id} expired (approvals last 24 hours).`,
          approvalId: row.id,
          remediation: "The agent must ask again; a new request will appear here.",
        },
      },
    };
  }
  if (current !== "pending") {
    return {
      ok: false,
      status: 409,
      body: {
        error: {
          code: "APPROVAL_ALREADY_DECIDED",
          message: `Approval ${row.id} is already ${current}.`,
          approvalId: row.id,
          remediation: "Reload the pending approvals list.",
        },
      },
    };
  }
  const updated = await db
    .prepare(
      `UPDATE studio_approval_requests SET status = ?, decided_by_user = ?, decided_at = ?
       WHERE id = ? AND org_id = ? AND project_id = ? AND status = 'pending' AND expires_at > ?`,
    )
    .bind(input.decision, input.userId, nowIso, row.id, input.orgId, input.projectId, nowIso)
    .run();
  if ((updated.meta?.changes ?? 0) !== 1) {
    return {
      ok: false,
      status: 409,
      body: {
        error: {
          code: "APPROVAL_ALREADY_DECIDED",
          message: `Approval ${row.id} was decided by someone else just now.`,
          approvalId: row.id,
          remediation: "Reload the pending approvals list.",
        },
      },
    };
  }
  const fresh = await readApprovalRow(db, input.orgId, input.projectId, row.id);
  return { ok: true, approval: toRecord(fresh ?? row, now.getTime()) };
}

/** AD-V8: approving, rejecting or accepting is a human's action. An MCP token is refused whatever its scopes. */
export function sessionReviewerRefusal(caller: StudioCaller): ApprovalErrorBody | null {
  if (caller.kind === "session") return null;
  return {
    error: {
      code: "APPROVAL_SESSION_REQUIRED",
      message:
        "Only a person signed in to Studio can approve, reject, accept or decline; an MCP token cannot review its own changes.",
      remediation: "Ask an editor (builder, admin or owner) to review this in Studio.",
    },
  };
}
