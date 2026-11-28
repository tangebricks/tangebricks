import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AuditStatement, AuthUser, D1Like, WorkspaceGuard } from "@poc/sdk";
import {
  auditStatementWhen,
  authUserId,
  findWorkspaceRecord,
  findWorkspaceState,
  formatMilli,
  fromMilli,
  hasWorkspaceRegistry,
  listWorkspaces,
  parseMilli,
  refuseApiKeyCaller,
  setWorkspaceSuspended,
  workspaceNotDeletingGuard,
} from "@poc/sdk";
import { APPROVAL_STATUSES, decisionGuard, decisionStatement, findApproval, listApprovals, resolveOperator } from "./approvals.ts";
import type { ApprovalStatus, OperatorResolver } from "./approvals.ts";

// Story 2.6: the platform operator console. Every route here is for platform operators only (the user ids listed in
// PX_PLATFORM_OPERATORS, see isPlatformOperator in @poc/sdk): no workspace role, header or body field makes anyone an
// operator, and with the variable unset nobody is one. The routes act across workspaces, so they sit outside the
// workspace guard, but each one still needs the signed-in session identity.
//
// Every change is made through the owning brick's declared capability (credit-wallet's walletCharger, feature-flags'
// flagOverrides) or an @poc/sdk helper (setWorkspaceSuspended), never by writing another brick's tables here, and every
// change writes an audit row through audit-trail's auditRecorder in the target workspace. The audit log is append-only:
// - in the same D1 batch as the change where the owner takes audit statements (suspension, flag overrides, user
//   decisions), so the change and its audit row commit together or not at all; the audit insert runs right after the
//   change and is written only if the change changed a row, so a no-op or a lost race leaves no row;
// - otherwise (a credit grant, whose wallet batch is the wallet's own) a row is written first with status "pending",
//   the change is made only once it exists, and an outcome row naming it is appended afterwards.
// A workspace whose delete is in progress (story 1.10's fence) is refused with 409 WORKSPACE_DELETING. Suspension and
// flag writes repeat that check inside their guarded write; a grant checks it once, before charger.grant, so a grant
// that lands after a fence goes up is applied to a wallet the delete then purges (its audit rows stay).
// Nothing here acts as another user: no route takes, mints or switches to anyone else's identity or session.

export interface AuditEntryInput {
  actorId: string;
  actorType?: "user";
  actorEmail?: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

/** The audit-trail export this brick is handed (`audit-logging.auditRecorder`). Structural, so no import of the brick. */
export interface PlatformAuditRecorder {
  statement(db: D1Like, workspaceId: string, entry: AuditEntryInput, options?: { afterChange?: boolean }): AuditStatement;
  record(
    db: D1Like,
    workspaceId: string,
    entry: AuditEntryInput,
    options?: { dedupeKey?: string },
  ): Promise<{ id: string; created: boolean; metadata: Record<string, unknown> }>;
  outcome(db: D1Like, workspaceId: string, pendingId: string, actorId: string, outcome: Record<string, unknown>): Promise<{ id: string }>;
  latestOutcome(db: D1Like, workspaceId: string, pendingId: string): Promise<Record<string, unknown> | null>;
  pendingAcrossWorkspaces(
    db: D1Like,
    options?: { limit?: number; after?: string },
  ): Promise<{
    rows: Array<{ id: string; workspaceId: string; action: string; targetId: string; metadata: Record<string, unknown>; createdAt: string }>;
    next: string | null;
  }>;
}

/** The credit-wallet export (`credit-wallet.walletCharger`): only what this brick calls. */
export interface PlatformWalletCharger {
  balanceMilli(db: D1Like, workspaceId: string): Promise<number>;
  grant(
    db: D1Like,
    workspaceId: string,
    milli: number,
    idempotencyKey: string,
    reason: string,
    userId?: string,
  ): Promise<
    | { ok: true; balanceAfterMilli: number; duplicate: boolean; opened: boolean }
    | { ok: false; code: "WALLET_NOT_FOUND" | "IDEMPOTENCY_KEY_REUSED"; balanceMilli: number }
  >;
}

type FlagChange =
  | { ok: true; key: string; changed: boolean; before: boolean | null; after: boolean | null }
  | { ok: false; code: "OVERRIDES_DISABLED" | "FLAG_NOT_FOUND" | "NOT_APPLIED" };
type FlagOptions = { allowOverrides: boolean | undefined; guard?: WorkspaceGuard; alongside?: (before: boolean | null) => readonly AuditStatement[] };

/** The feature-flags export (`feature-flags.flagOverrides`). */
export interface PlatformFlagOverrides {
  list(db: D1Like, workspaceId: string): Promise<Array<{ key: string; enabled: boolean; updatedAt: string }>>;
  set(db: D1Like, workspaceId: string, flagKey: string, enabled: boolean, options: FlagOptions): Promise<FlagChange>;
  clear(db: D1Like, workspaceId: string, flagKey: string, options: FlagOptions): Promise<FlagChange>;
}

export interface PlatformAdminRoutesOptions {
  /**
   * Story 2.8: who is a platform operator, for a host that keeps its own operator list (a table, a directory). Called
   * with the request's env and the signed-in user's id, before any input is read. Default: the ids in
   * `PX_PLATFORM_OPERATORS` (`isPlatformOperator` from @poc/sdk). Only `true` admits; a resolver that throws or rejects
   * admits nobody (500 OPERATOR_CHECK_FAILED, logged).
   */
  isOperator?: OperatorResolver;
  /** The largest grant, in whole credits (setting `maxGrantCredits`, default 1,000,000). */
  maxGrantCredits?: number;
  /** Whether the approval gate is on (setting `requireUserApproval`); reported by the user listing. */
  requireUserApproval?: boolean;
  /** Required: every change writes an audit row through it. Without it every change answers 503 NOT_CONFIGURED. */
  auditRecorder?: PlatformAuditRecorder;
  /** Wired when credit-wallet is enabled; without it, grants answer 503 NOT_CONFIGURED. */
  charger?: PlatformWalletCharger;
  /** Wired when feature-flags is enabled; without it, flag routes answer 503 NOT_CONFIGURED. */
  flagOverrides?: PlatformFlagOverrides;
  /** feature-flags' `allowWorkspaceOverrides` setting (story 1.12); anything but true refuses override changes. */
  flagOverridesAllowed?: boolean;
}

export interface PlatformAdminEnv {
  Bindings: { DB: D1Like };
  Variables: { user?: AuthUser; operatorId?: string };
}

/** Where audit rows go for actions on a person rather than a workspace (user approval decisions). */
export const PLATFORM_AUDIT_SCOPE = "_platform";

export const DEFAULT_MAX_GRANT_CREDITS = 1_000_000;

/** The audit action of a credit grant; its rows carry the request's idempotency key. */
export const GRANT_AUDIT_ACTION = "platform.credits.grant";
/** The longest grant idempotency key: the dedupe key `${GRANT_AUDIT_ACTION}:${key}` must fit in 200 characters. */
export const MAX_GRANT_KEY_LENGTH = 200 - GRANT_AUDIT_ACTION.length - 1;

const reason = z.string().trim().min(1).max(500);
const ReasonSchema = z.object({ reason });
const GrantSchema = z.object({
  amount: z.union([z.number(), z.string().max(32)]),
  reason,
  // At most 177 characters, so the audit dedupe key ("platform.credits.grant:" + key) fits its 200-character column.
  idempotencyKey: z.string().min(1).max(MAX_GRANT_KEY_LENGTH),
});
const FlagSchema = z.object({ enabled: z.boolean(), reason });
const workspaceIdParam = z.string().min(1).max(128);
const userIdParam = z.string().min(1).max(200);
const flagKeyParam = z.string().trim().min(1).max(64);

type Ctx = Context<PlatformAdminEnv>;

const notConfigured = (c: Ctx, what: string) => c.json({ error: `${what} is not configured in this app`, code: "NOT_CONFIGURED" }, 503);
const invalid = (c: Ctx, message: string) => c.json({ error: message, code: "VALIDATION_ERROR" }, 400);
const notFound = (c: Ctx, what: string) => c.json({ error: `${what} not found`, code: "NOT_FOUND" }, 404);
const deleting = (c: Ctx) => c.json({ error: "This workspace is being deleted", code: "WORKSPACE_DELETING" }, 409);
// The cause goes to the log, never to the caller.
const notApplied = (c: Ctx, where: string, error: unknown) => {
  console.error(`platform-admin ${where}:`, error instanceof Error ? error.message : error);
  return c.json({ error: "The action was not applied", code: "ACTION_NOT_APPLIED" }, 500);
};

async function readJson(c: Ctx): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

function pageLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

export function createPlatformAdminRoutes(options: PlatformAdminRoutesOptions = {}): Hono<PlatformAdminEnv> {
  const app = new Hono<PlatformAdminEnv>();
  const maxGrantMilli = (options.maxGrantCredits ?? DEFAULT_MAX_GRANT_CREDITS) * 1000;
  const audit = options.auditRecorder;
  const charger = options.charger;
  const overrides = options.flagOverrides;
  const overridesAllowed = options.flagOverridesAllowed;
  const gateOn = options.requireUserApproval === true;

  // Operators only, before any input is read: no session is 401, an API key is 403 API_KEY_FORBIDDEN, anyone not an
  // operator (PX_PLATFORM_OPERATORS, or the host's isOperator; a workspace owner included) is 403 NOT_PLATFORM_OPERATOR,
  // and a resolver that fails is 500 OPERATOR_CHECK_FAILED (never admitted).
  app.use("/platform/*", async (c, next) => {
    const userId = authUserId(c.get("user"));
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const keyRefusal = refuseApiKeyCaller(c);
    if (keyRefusal) return keyRefusal;
    const operator = await resolveOperator(options.isOperator, c.env, userId);
    if (operator === "failed") return c.json({ error: "The operator check failed", code: "OPERATOR_CHECK_FAILED" }, 500);
    if (!operator) return c.json({ error: "Platform operators only", code: "NOT_PLATFORM_OPERATOR" }, 403);
    c.set("operatorId", userId);
    return await next();
  });

  const operatorOf = (c: Ctx) => c.get("operatorId") as string;

  /** The target workspace for a change: its state, or the response to send (503 no registry, 404, 409 deleting). */
  async function changeableWorkspace(c: Ctx, db: D1Like, workspaceId: string): Promise<{ suspended: boolean; reason: string | null } | Response> {
    if (!(await hasWorkspaceRegistry(db))) return notConfigured(c, "A workspace registry");
    const state = await findWorkspaceState(db, workspaceId);
    if (!state) return notFound(c, "Workspace");
    if (state.deleting) return deleting(c);
    return state;
  }

  // ---- Reads --------------------------------------------------------------------------------------------------------

  app.get("/platform/workspaces", async (c) => {
    const page = await listWorkspaces(c.env.DB, { limit: pageLimit(c.req.query("limit")), after: c.req.query("after") ?? undefined });
    if (!page) return notConfigured(c, "A workspace registry");
    return c.json(page, 200);
  });

  // One workspace's operator summary: its registry state, its wallet balance and its flag overrides. Never its data.
  app.get("/platform/workspaces/:id", async (c) => {
    const id = workspaceIdParam.safeParse(c.req.param("id"));
    if (!id.success) return invalid(c, "Invalid workspace id");
    const db = c.env.DB;
    if (!(await hasWorkspaceRegistry(db))) return notConfigured(c, "A workspace registry");
    const workspace = await findWorkspaceRecord(db, id.data);
    if (!workspace) return notFound(c, "Workspace");
    const balanceMilli = charger ? await charger.balanceMilli(db, id.data) : null;
    return c.json(
      {
        workspace,
        wallet: balanceMilli === null ? null : { balance: fromMilli(balanceMilli), balanceMilli },
        flagOverrides: overrides ? await overrides.list(db, id.data) : null,
      },
      200,
    );
  });

  app.get("/platform/users", async (c) => {
    const status = (c.req.query("status") ?? "pending") as ApprovalStatus;
    if (!APPROVAL_STATUSES.includes(status)) return invalid(c, "status must be pending, approved or rejected");
    const page = await listApprovals(c.env.DB, status, { limit: pageLimit(c.req.query("limit")), after: c.req.query("after") ?? undefined });
    return c.json({ approvalGate: gateOn, ...page }, 200);
  });

  // Audit rows of operator actions still waiting for their outcome (a grant whose outcome row could not be written),
  // across every workspace, in bounded pages. Only rows written through the audit capability are listed.
  app.get("/platform/audit/pending", async (c) => {
    if (!audit) return notConfigured(c, "Audit logging");
    const page = await audit.pendingAcrossWorkspaces(c.env.DB, { limit: pageLimit(c.req.query("limit")), after: c.req.query("after") ?? undefined });
    return c.json(page, 200);
  });

  // ---- Credits ------------------------------------------------------------------------------------------------------

  app.post("/platform/workspaces/:id/credits", async (c) => {
    if (!audit) return notConfigured(c, "Audit logging");
    if (!charger) return notConfigured(c, "A credit wallet");
    const id = workspaceIdParam.safeParse(c.req.param("id"));
    if (!id.success) return invalid(c, "Invalid workspace id");
    const json = await readJson(c);
    if (!json.ok) return invalid(c, "Invalid JSON body");
    const body = GrantSchema.safeParse(json.body);
    if (!body.success) return invalid(c, `amount, reason (1 to 500 characters) and idempotencyKey (1 to ${MAX_GRANT_KEY_LENGTH} characters) are required`);
    const amount = parseMilli(body.data.amount);
    if (!amount.ok || amount.milli <= 0) return invalid(c, "amount must be above zero with at most three decimals");
    if (amount.milli > maxGrantMilli) return invalid(c, `amount is above the largest grant of ${formatMilli(maxGrantMilli)} credits`);
    const db = c.env.DB;
    const target = await changeableWorkspace(c, db, id.data);
    if (target instanceof Response) return target;

    const operatorId = operatorOf(c);
    const key = body.data.idempotencyKey;
    const amountText = formatMilli(amount.milli);
    const beforeMilli = await charger.balanceMilli(db, id.data);
    // The pending row exists before the wallet changes; if it cannot be written, nothing is granted. It is written at
    // most once per key (concurrent first attempts and retries share it), so a retry completes the first attempt's row.
    let pending: Awaited<ReturnType<PlatformAuditRecorder["record"]>>;
    let earlierOutcome: Record<string, unknown> | null = null;
    try {
      pending = await audit.record(
        db,
        id.data,
        {
          actorId: operatorId,
          actorType: "user",
          action: GRANT_AUDIT_ACTION,
          targetType: "workspace",
          targetId: id.data,
          metadata: { status: "pending", reason: body.data.reason, amount: amountText, idempotencyKey: key, before: { balance: formatMilli(beforeMilli) } },
        },
        { dedupeKey: `${GRANT_AUDIT_ACTION}:${key}` },
      );
      if (!pending.created) earlierOutcome = await audit.latestOutcome(db, id.data, pending.id);
    } catch (error) {
      console.error("platform-admin grant audit:", error instanceof Error ? error.message : error);
      return c.json({ error: "The audit row could not be written, so nothing was granted", code: "AUDIT_UNAVAILABLE" }, 503);
    }
    const auditId = pending.id;
    if (!pending.created && pending.metadata.amount !== amountText) {
      return c.json({ error: "This idempotency key was used for a different grant", code: "IDEMPOTENCY_KEY_REUSED", auditId }, 409);
    }

    // Appends an outcome row naming the pending row, unless the latest outcome already says the same.
    const recordOutcome = async (outcome: Record<string, unknown>) => {
      if (earlierOutcome?.status === outcome.status) return;
      try {
        await audit.outcome(db, id.data, auditId, operatorId, outcome);
      } catch (error) {
        // The pending row exists and pendingWithoutOutcome lists it; the grant stands. Logged for follow-up.
        console.error("platform-admin grant audit outcome:", error instanceof Error ? error.message : error);
      }
    };

    let result: Awaited<ReturnType<PlatformWalletCharger["grant"]>>;
    try {
      // Grant keys are prefixed "platform-grant:" in the workspace's single key space (story 2.5). The prefix reserves
      // nothing: the workspace's own routes can use such a key first, and the grant then answers 409
      // IDEMPOTENCY_KEY_REUSED (retry with another key). Known residual: a workspace delete that purges the wallet after
      // a grant removes the granted credits with it; the grant's audit rows stay (audit_events is a kept tombstone table).
      result = await charger.grant(db, id.data, amount.milli, `platform-grant:${key}`, body.data.reason, operatorId);
    } catch (error) {
      await recordOutcome({ status: "failed" });
      return notApplied(c, "grant", error);
    }
    // A duplicate is a grant that took effect on an earlier attempt: its outcome is "applied" too.
    await recordOutcome(
      result.ok ? { status: "applied", after: { balance: formatMilli(result.balanceAfterMilli) } } : { status: "refused", refusal: result.code },
    );
    if (!result.ok) {
      if (result.code === "IDEMPOTENCY_KEY_REUSED") {
        return c.json({ error: "This idempotency key was already used for something else in this workspace", code: "IDEMPOTENCY_KEY_REUSED", auditId }, 409);
      }
      return c.json({ error: "This workspace has no wallet and none can be opened (it is suspended or unknown)", code: "WALLET_NOT_FOUND", auditId }, 404);
    }
    return c.json(
      {
        granted: fromMilli(amount.milli),
        grantedMilli: amount.milli,
        balance: fromMilli(result.balanceAfterMilli),
        balanceMilli: result.balanceAfterMilli,
        duplicate: result.duplicate,
        auditId,
      },
      200,
    );
  });

  // ---- Suspension ---------------------------------------------------------------------------------------------------

  const suspension = (suspended: boolean) => async (c: Ctx) => {
    if (!audit) return notConfigured(c, "Audit logging");
    const id = workspaceIdParam.safeParse(c.req.param("id"));
    if (!id.success) return invalid(c, "Invalid workspace id");
    const json = await readJson(c);
    if (!json.ok) return invalid(c, "Invalid JSON body");
    const body = ReasonSchema.safeParse(json.body);
    if (!body.success) return invalid(c, "reason (1 to 500 characters) is required");
    const db = c.env.DB;
    const state = await changeableWorkspace(c, db, id.data);
    if (state instanceof Response) return state;
    let auditId = "";
    let result: Awaited<ReturnType<typeof setWorkspaceSuspended>>;
    try {
      // Built from the state setWorkspaceSuspended reads itself (the one its guarded update acts on), and written right
      // after the update in its batch, only if the update changed the row.
      result = await setWorkspaceSuspended(db, id.data, suspended, (before) => {
        const entry = audit.statement(
          db,
          id.data,
          {
            actorId: operatorOf(c),
            actorType: "user",
            action: suspended ? "platform.workspace.suspend" : "platform.workspace.unsuspend",
            targetType: "workspace",
            targetId: id.data,
            metadata: { reason: body.data.reason, before, after: { suspended } },
          },
          { afterChange: true },
        );
        auditId = entry.id;
        return [entry];
      });
    } catch (error) {
      return notApplied(c, suspended ? "suspend" : "unsuspend", error);
    }
    if (!result.ok) {
      if (result.reason === "no_registry") return notConfigured(c, "A workspace registry");
      if (result.reason === "deleting") return deleting(c);
      if (result.reason === "other_suspension") {
        return c.json(
          { error: "This workspace is suspended for another reason, which an operator neither overwrites nor lifts", code: "SUSPENDED_OTHERWISE" },
          409,
        );
      }
      return notFound(c, "Workspace");
    }
    // Already in that state by an operator: nothing changed and no audit row was written.
    if (!result.changed) return c.json({ workspaceId: id.data, suspended, changed: false, auditId: null }, 200);
    return c.json({ workspaceId: id.data, suspended, changed: true, before: result.before, auditId }, 200);
  };
  app.post("/platform/workspaces/:id/suspend", suspension(true));
  app.post("/platform/workspaces/:id/unsuspend", suspension(false));

  // ---- Feature flag overrides ---------------------------------------------------------------------------------------

  const flagChange = (mode: "set" | "clear") => async (c: Ctx) => {
    if (!audit) return notConfigured(c, "Audit logging");
    if (!overrides) return notConfigured(c, "Feature flags");
    const id = workspaceIdParam.safeParse(c.req.param("id"));
    const key = flagKeyParam.safeParse(c.req.param("flagKey"));
    if (!id.success || !key.success) return invalid(c, "Invalid workspace id or flag key");
    const json = await readJson(c);
    if (!json.ok) return invalid(c, "Invalid JSON body");
    const body = mode === "set" ? FlagSchema.safeParse(json.body) : ReasonSchema.safeParse(json.body);
    if (!body.success)
      return invalid(c, mode === "set" ? "enabled (true or false) and reason (1 to 500 characters) are required" : "reason (1 to 500 characters) is required");
    const db = c.env.DB;
    const target = await changeableWorkspace(c, db, id.data);
    if (target instanceof Response) return target;
    const flagKey = key.data.toLowerCase();
    const enabled = "enabled" in body.data ? body.data.enabled : null;
    let result: FlagChange;
    let auditId = "";
    try {
      // The audit row is built from the override as flagOverrides itself read it, so its "before" is the one reported.
      const opts: FlagOptions = {
        allowOverrides: overridesAllowed,
        // The write (and so its audit row) applies only while the workspace is not being deleted.
        guard: workspaceNotDeletingGuard(id.data),
        alongside: (before) => {
          const entry = audit.statement(
            db,
            id.data,
            {
              actorId: operatorOf(c),
              actorType: "user",
              action: mode === "set" ? "platform.flag.set" : "platform.flag.clear",
              targetType: "flag",
              targetId: flagKey,
              metadata: { reason: body.data.reason, before: { enabled: before }, after: { enabled } },
            },
            { afterChange: true },
          );
          auditId = entry.id;
          return [entry];
        },
      };
      result = mode === "set" ? await overrides.set(db, id.data, flagKey, enabled as boolean, opts) : await overrides.clear(db, id.data, flagKey, opts);
    } catch (error) {
      return notApplied(c, `flag ${mode}`, error);
    }
    // A refusal ran nothing, the audit row included.
    if (!result.ok) {
      if (result.code === "OVERRIDES_DISABLED") {
        return c.json({ error: "Workspace flag overrides are turned off in this app (allowWorkspaceOverrides)", code: "OVERRIDES_DISABLED" }, 409);
      }
      if (result.code === "NOT_APPLIED") {
        // The guarded write matched nothing: the workspace was fenced for deletion, or the override changed meanwhile.
        if ((await findWorkspaceState(db, id.data))?.deleting) return deleting(c);
        return c.json({ error: "The override changed while this request ran; read it again and retry", code: "CHANGED_CONCURRENTLY" }, 409);
      }
      return notFound(c, "Flag");
    }
    if (!result.changed)
      return c.json({ workspaceId: id.data, key: result.key, changed: false, before: result.before, after: result.after, auditId: null }, 200);
    return c.json({ workspaceId: id.data, key: result.key, changed: true, before: result.before, after: result.after, auditId }, 200);
  };
  app.put("/platform/workspaces/:id/flags/:flagKey", flagChange("set"));
  app.delete("/platform/workspaces/:id/flags/:flagKey", flagChange("clear"));

  // ---- User approvals -----------------------------------------------------------------------------------------------

  const decide = (status: "approved" | "rejected") => async (c: Ctx) => {
    if (!audit) return notConfigured(c, "Audit logging");
    const uid = userIdParam.safeParse(c.req.param("uid"));
    if (!uid.success) return invalid(c, "Invalid user id");
    const json = await readJson(c);
    if (!json.ok) return invalid(c, "Invalid JSON body");
    const body = ReasonSchema.safeParse(json.body);
    if (!body.success) return invalid(c, "reason (1 to 500 characters) is required");
    const db = c.env.DB;
    const operatorId = operatorOf(c);
    let auditId: string;
    let applied: boolean;
    try {
      const before = (await findApproval(db, uid.data))?.status ?? null;
      const entry = audit.statement(
        db,
        PLATFORM_AUDIT_SCOPE,
        {
          actorId: operatorId,
          actorType: "user",
          action: status === "approved" ? "platform.user.approve" : "platform.user.reject",
          targetType: "user",
          targetId: uid.data,
          metadata: { reason: body.data.reason, before: { status: before }, after: { status } },
        },
        { afterChange: true },
      );
      auditId = entry.id;
      // The decision and its audit row commit in one batch. The decision is guarded by the status read above, so its
      // audit "before" is the state it acted on; if the row changed meanwhile, neither is written. The audit row runs
      // first, under the decision's own guard, rather than after it under `changes() > 0`, and the outcome is read back
      // rather than taken from a change count: story 2.8, a host's pa_user_approvals may be a view over its own table,
      // which reports no changes.
      const decidedAt = new Date().toISOString();
      await db.batch([
        auditStatementWhen(db, entry, decisionGuard(uid.data, before)),
        decisionStatement(db, uid.data, status, operatorId, body.data.reason, before, decidedAt),
      ]);
      const now = await findApproval(db, uid.data);
      applied = now !== null && now.status === status && now.decidedBy === operatorId && now.decidedAt === decidedAt;
    } catch (error) {
      return notApplied(c, `user ${status}`, error);
    }
    if (!applied) return c.json({ error: "This user's approval changed while this request ran; read it again and retry", code: "CHANGED_CONCURRENTLY" }, 409);
    return c.json({ user: await findApproval(db, uid.data), auditId }, 200);
  };
  app.post("/platform/users/:uid/approve", decide("approved"));
  app.post("/platform/users/:uid/reject", decide("rejected"));

  return app;
}
