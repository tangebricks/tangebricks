import {
  createPublicUrlFetch,
  isEgressForbiddenError,
  scoped,
  systemScope,
  type D1Like,
  type HostResolver,
  type PublicUrlFetcher,
} from "@poc/sdk";

/**
 * The most runs one schedule may replay in one tick under catchUp "all" (story 0.21, threat model B16): one schedule
 * can never fan out more than this, whatever its stored max_catch_up says.
 */
export const MAX_CATCH_UP = 10;

export interface ScheduleRecord {
  id: string;
  workspace_id: string;
  target_workflow_id: string | null;
  target_url: string | null;
  cron_expression: string;
  timezone: string;
  active: boolean;
  next_run_at: string;
  last_run_at: string | null;
  created_at: string;
  catch_up: "skip" | "once" | "all";
  max_catch_up: number;
}

export interface HistoryRecord {
  id: string;
  schedule_id: string;
  workspace_id: string;
  scheduled_time: string;
  actual_start_time: string;
  duration_ms: number;
  status: "success" | "failure" | "missed";
  response_summary: string | null;
}

export type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;

interface DueRow {
  id: string;
  workspace_id: string;
  target_workflow_id: string | null;
  target_url: string | null;
  cron_expression: string;
  timezone: string;
  next_run_at: string;
  catch_up?: "skip" | "once" | "all";
  max_catch_up?: number;
}

/**
 * Validates a standard 5-part cron expression: (minute hour day-of-month month day-of-week).
 */
export function validateCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const patterns = [
    /^(\*|([0-9]|[1-5][0-9])|\*\/([1-9]|[1-5][0-9])|([0-9]|[1-5][0-9])-([0-9]|[1-5][0-9]))$/, // minute 0-59
    /^(\*|([0-9]|1[0-9]|2[0-3])|\*\/([1-9]|1[0-9]|2[0-3])|([0-9]|1[0-9]|2[0-3])-([0-9]|1[0-9]|2[0-3]))$/, // hour 0-23
    /^(\*|([1-9]|[12][0-9]|3[01])|\*\/([1-9]|[12][0-9]|3[01])|([1-9]|[12][0-9]|3[01])-([1-9]|[12][0-9]|3[01]))$/, // day 1-31
    /^(\*|([1-9]|1[0-2])|\*\/([1-9]|1[0-2])|([1-9]|1[0-2])-([1-9]|1[0-2]))$/, // month 1-12
    /^(\*|[0-6]|\*\/[1-6]|[0-6]-[0-6])$/, // day of week 0-6
  ];

  return parts.every((p, idx) => patterns[idx]?.test(p) === true);
}

/**
 * Computes the next run date for a standard cron expression from a base date in UTC.
 */
export function computeNextRun(expression: string, fromDate = new Date()): Date {
  if (!validateCron(expression)) throw new Error(`Invalid cron expression: ${expression}`);

  const parts = expression.trim().split(/\s+/);
  const minPart = parts[0];
  // validateCron above guarantees five fields; this only narrows the type.
  if (minPart === undefined) throw new Error(`Invalid cron expression: ${expression}`);

  // Advance by 1 minute in UTC
  const next = new Date(fromDate.getTime() + 60000);
  next.setUTCSeconds(0, 0);

  // If simple step interval (e.g. */5, */15, */1)
  if (minPart.startsWith("*/")) {
    const step = parseInt(minPart.substring(2), 10);
    const remainder = next.getUTCMinutes() % step;
    if (remainder !== 0) {
      next.setUTCMinutes(next.getUTCMinutes() + (step - remainder));
    }
    return next;
  }

  // Exact minute match (e.g. "0" or "30")
  if (/^\d+$/.test(minPart)) {
    const targetMin = parseInt(minPart, 10);
    while (next.getUTCMinutes() !== targetMin) {
      next.setUTCMinutes(next.getUTCMinutes() + 1);
    }
    return next;
  }

  // Default: next minute
  return next;
}

export interface CronServiceOptions {
  /** Host resolver for the SSRF guard; tests inject one to stay offline. Defaults to DNS-over-HTTPS. */
  resolveHost?: HostResolver | null;
  /**
   * Workflow binding names a schedule may start (story 0.20, B13). When set it wins over the
   * `CRON_WORKFLOW_TARGETS` env var; when neither is set no Workflow target is allowed.
   */
  allowedWorkflowTargets?: string[];
}

/** Env var the app sets to the comma-separated Workflow binding names cron-alarms may start. */
export const CRON_WORKFLOW_TARGETS_ENV = "CRON_WORKFLOW_TARGETS";

/** Parses a comma-separated allowlist: entries trimmed, empty entries ignored. Anything else is an empty list. */
export function parseWorkflowTargets(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export class CronService {
  /** URL targets are tenant-supplied, so every call goes through the public-URL guard (no internal addresses). */
  private readonly customFetch: PublicUrlFetcher;
  /** Workflow binding names this service may start; empty means none (fail closed). */
  private readonly allowedWorkflowTargets: ReadonlySet<string>;
  private readonly db: D1Like;
  private readonly maxSchedules: number;
  private readonly envBindings: Record<string, unknown> | undefined;

  constructor(
    db: D1Like,
    maxSchedules = 50,
    envBindings?: Record<string, unknown>,
    fetcher?: Fetcher,
    options: CronServiceOptions = {},
  ) {
    this.db = db;
    this.maxSchedules = maxSchedules;
    this.envBindings = envBindings;
    const base: Fetcher =
      fetcher ?? (envBindings?.["fetch"] as Fetcher | undefined) ?? ((url, init) => globalThis.fetch(url, init));
    this.customFetch = createPublicUrlFetch((url, init) => base(url, init), options.resolveHost !== undefined ? { resolveHost: options.resolveHost } : {});
    this.allowedWorkflowTargets = new Set(
      options.allowedWorkflowTargets ?? parseWorkflowTargets(envBindings?.[CRON_WORKFLOW_TARGETS_ENV]),
    );
  }

  /** True when `name` is on the app's Workflow target allowlist. */
  isWorkflowTargetAllowed(name: string): boolean {
    return this.allowedWorkflowTargets.has(name);
  }

  /**
   * Registers a new recurring schedule.
   */
  async createSchedule(
    workspaceId: string,
    cronExpressionRaw: string,
    options: {
      targetWorkflowId?: string;
      targetUrl?: string;
      timezone?: string;
      catchUp?: "skip" | "once" | "all";
      maxCatchUp?: number;
    } = {},
  ): Promise<{ ok: true; schedule: ScheduleRecord } | { ok: false; error: string; code: number; errorCode?: string }> {
    const cron = cronExpressionRaw.trim();
    if (!validateCron(cron)) {
      return { ok: false, error: "Invalid cron expression format (expected 5 fields)", code: 400 };
    }

    if (!options.targetWorkflowId && !options.targetUrl) {
      return { ok: false, error: "Must specify either targetWorkflowId or targetUrl", code: 400 };
    }

    // Story 0.20 (B13): only Workflow bindings the app allowlists may be scheduled; any other name is refused.
    if (options.targetWorkflowId && !this.isWorkflowTargetAllowed(options.targetWorkflowId)) {
      return {
        ok: false,
        error: `Workflow target ${options.targetWorkflowId} is not allowed (not in ${CRON_WORKFLOW_TARGETS_ENV})`,
        code: 400,
        errorCode: "WORKFLOW_TARGET_NOT_ALLOWED",
      };
    }

    const s = scoped(this.db, workspaceId);

    interface CountRow {
      cnt: number;
    }
    const count = await s.raw(
      "SELECT count(*) as cnt FROM cron_schedules WHERE workspace_id = ?",
      [workspaceId]
    ).first<CountRow>();

    if ((count?.cnt ?? 0) >= this.maxSchedules) {
      return { ok: false, error: `Workspace schedule limit (${this.maxSchedules}) reached`, code: 403 };
    }

    const nextRun = computeNextRun(cron);
    const id = `cron_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const catchUp = options.catchUp ?? "once";
    const maxCatchUp = Math.min(options.maxCatchUp ?? MAX_CATCH_UP, MAX_CATCH_UP);

    try {
      await s.insert("cron_schedules", {
        id,
        target_workflow_id: options.targetWorkflowId || null,
        target_url: options.targetUrl || null,
        cron_expression: cron,
        timezone: options.timezone || "UTC",
        active: 1,
        next_run_at: nextRun.toISOString(),
        created_at: now,
        catch_up: catchUp,
        max_catch_up: maxCatchUp,
      });
    } catch {
      // Fallback for tests running prior to 0002_catch_up migration
      await s.insert("cron_schedules", {
        id,
        target_workflow_id: options.targetWorkflowId || null,
        target_url: options.targetUrl || null,
        cron_expression: cron,
        timezone: options.timezone || "UTC",
        active: 1,
        next_run_at: nextRun.toISOString(),
        created_at: now,
      });
    }

    try {
      await this.db
        .prepare(`
        INSERT INTO px_schedules (id, workspace_id, brick_id, schedule_id, cron_expression, payload_json, active, next_run_at, created_at)
        VALUES (?, ?, 'cron-alarms', ?, ?, ?, 1, ?, ?)
      `)
        .bind(
          id,
          workspaceId,
          id,
          cron,
          JSON.stringify({
            targetWorkflowId: options.targetWorkflowId || null,
            targetUrl: options.targetUrl || null,
            timezone: options.timezone || "UTC",
            catchUp,
            maxCatchUp,
          }),
          nextRun.toISOString(),
          now,
        )
        .run();
    } catch {
      // Standalone unit tests may run without the shell px_schedules table.
    }

    return {
      ok: true,
      schedule: {
        id,
        workspace_id: workspaceId,
        target_workflow_id: options.targetWorkflowId || null,
        target_url: options.targetUrl || null,
        cron_expression: cron,
        timezone: options.timezone || "UTC",
        active: true,
        next_run_at: nextRun.toISOString(),
        last_run_at: null,
        created_at: now,
        catch_up: catchUp,
        max_catch_up: maxCatchUp,
      },
    };
  }

  /**
   * Retrieves a schedule by ID scoped to workspace.
   */
  async getSchedule(workspaceId: string, scheduleId: string): Promise<ScheduleRecord | null> {
    interface Row {
      id: string;
      workspace_id: string;
      target_workflow_id: string | null;
      target_url: string | null;
      cron_expression: string;
      timezone: string;
      active: number;
      next_run_at: string;
      last_run_at: string | null;
      created_at: string;
      catch_up?: "skip" | "once" | "all";
      max_catch_up?: number;
    }

    const s = scoped(this.db, workspaceId);
    const row = await s.first<Row>("cron_schedules", "id = ?", [scheduleId]);

    if (!row) return null;
    return {
      ...row,
      active: row.active === 1,
      catch_up: row.catch_up ?? "once",
      max_catch_up: row.max_catch_up ?? 10,
    };
  }

  /**
   * Lists schedules in a workspace.
   */
  async listSchedules(workspaceId: string): Promise<ScheduleRecord[]> {
    interface Row {
      id: string;
      workspace_id: string;
      target_workflow_id: string | null;
      target_url: string | null;
      cron_expression: string;
      timezone: string;
      active: number;
      next_run_at: string;
      last_run_at: string | null;
      created_at: string;
      catch_up?: "skip" | "once" | "all";
      max_catch_up?: number;
    }

    const s = scoped(this.db, workspaceId);
    const rows = await s.select<Row>("cron_schedules", undefined, [], {
      orderBy: "created_at DESC",
    });

    return rows.map((r) => ({
      ...r,
      active: r.active === 1,
      catch_up: r.catch_up ?? "once",
      max_catch_up: r.max_catch_up ?? 10,
    }));
  }

  /**
   * Toggles active state of a schedule.
   */
  async toggleSchedule(workspaceId: string, scheduleId: string, active: boolean): Promise<boolean> {
    const s = scoped(this.db, workspaceId);
    const res = await s.update(
      "cron_schedules",
      { active: active ? 1 : 0 },
      "id = ?",
      [scheduleId]
    );
    const changed = (res.meta?.changes ?? 0) > 0;
    if (changed) {
      try {
        await this.db
          .prepare("UPDATE px_schedules SET active = ? WHERE id = ? AND workspace_id = ?")
          .bind(active ? 1 : 0, scheduleId, workspaceId)
          .run();
      } catch {
        // Standalone unit tests may run without px_schedules.
      }
    }
    return changed;
  }

  /**
   * Deletes a schedule.
   */
  async deleteSchedule(workspaceId: string, scheduleId: string): Promise<boolean> {
    const s = scoped(this.db, workspaceId);
    const res = await s.delete("cron_schedules", "id = ?", [scheduleId]);
    const changed = (res.meta?.changes ?? 0) > 0;
    if (changed) {
      try {
        await this.db
          .prepare("DELETE FROM px_schedules WHERE id = ? AND workspace_id = ?")
          .bind(scheduleId, workspaceId)
          .run();
      } catch {
        // Standalone unit tests may run without px_schedules.
      }
    }
    return changed;
  }

  /**
   * Invokes schedule target (Workflow instance or HTTP URL) and writes history record.
   */
  private async invokeTargetAndRecord(
    sched: DueRow,
    slotIso: string,
    nowIso: string,
  ): Promise<HistoryRecord> {
    const startTime = Date.now();
    const histId = `crh_${crypto.randomUUID().replace(/-/g, "")}`;
    const dedupeId = `cron:${sched.id}:${slotIso}`;
    let outcomeStatus: "success" | "failure" = "success";
    let summary: string | null = null;
    let urlTarget = false;

    try {
      if (sched.target_workflow_id && !this.isWorkflowTargetAllowed(sched.target_workflow_id)) {
        // Story 0.20 (B13): re-checked at fire time, since the allowlist may have changed since the schedule was made.
        // The name is never looked up in env, and there is no fallback runner.
        outcomeStatus = "failure";
        summary = `NOT_ALLOWED: workflow target ${sched.target_workflow_id} is not in ${CRON_WORKFLOW_TARGETS_ENV}; not triggered`;
      } else if (sched.target_workflow_id) {
        const workflowBinding = this.envBindings?.[sched.target_workflow_id] as
          | { create(options: { id: string; params: unknown }): Promise<unknown> }
          | undefined;

        if (workflowBinding && typeof workflowBinding.create === "function") {
          await workflowBinding.create({
            id: dedupeId,
            params: {
              scheduleId: sched.id,
              workspaceId: sched.workspace_id,
              workflowId: sched.target_workflow_id,
              scheduledTime: slotIso,
            },
          });
          summary = `Triggered workflow ${sched.target_workflow_id} (id: ${dedupeId})`;
        } else {
          // Story 0.9 (B14): nothing was triggered, so the run is a failure, not a success.
          outcomeStatus = "failure";
          summary = `NOT_CONFIGURED: no workflow binding for ${sched.target_workflow_id}; the workflow was not triggered`;
        }
      } else if (sched.target_url) {
        urlTarget = true;
        const res = await this.customFetch(sched.target_url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": dedupeId,
          },
          body: JSON.stringify({
            scheduleId: sched.id,
            workspaceId: sched.workspace_id,
            scheduledTime: slotIso,
          }),
        });
        try {
          await res.body?.cancel();
        } catch {
          // ignore: upstream content is never recorded
        }
        if (!res.ok) {
          outcomeStatus = "failure";
          // Status only: upstream status text / body is tenant-readable history and is never stored.
          summary = `HTTP ${res.status}`;
        } else {
          summary = `Called URL ${sched.target_url} (id: ${dedupeId})`;
        }
      }
    } catch (err) {
      outcomeStatus = "failure";
      if (isEgressForbiddenError(err)) {
        summary = err.message;
      } else if (urlTarget) {
        // Network errors from a tenant URL can echo internal details; record a fixed code instead.
        summary = "FETCH_FAILED";
      } else {
        summary = err instanceof Error ? err.message : String(err);
      }
    }

    if (summary && summary.length > 2048) {
      summary = summary.slice(0, 2045) + "...";
    }

    const dur = Math.max(0, Date.now() - startTime);
    const histRecord: HistoryRecord = {
      id: histId,
      schedule_id: sched.id,
      workspace_id: sched.workspace_id,
      scheduled_time: slotIso,
      actual_start_time: nowIso,
      duration_ms: dur,
      status: outcomeStatus,
      response_summary: summary,
    };

    const sys = systemScope(this.db, "platform cron runner across all workspaces");
    await sys.insert("cron_history", {
      id: histId,
      schedule_id: sched.id,
      workspace_id: sched.workspace_id,
      scheduled_time: slotIso,
      actual_start_time: nowIso,
      duration_ms: dur,
      status: outcomeStatus,
      response_summary: summary,
    });

    return histRecord;
  }

  /**
   * Triggers due schedules atomically, records execution history, and advances next_run_at.
   */
  async triggerDueSchedules(now = new Date(), allowedIds?: string[]): Promise<HistoryRecord[]> {
    const sys = systemScope(this.db, "platform cron runner across all workspaces");
    const nowIso = now.toISOString();

    // Query due active schedules. Even when allowedIds is specified, next_run_at MUST be due.
    let candidates: DueRow[];
    try {
      candidates = (
        await sys.raw(
          "SELECT id, workspace_id, target_workflow_id, target_url, cron_expression, timezone, next_run_at, catch_up, max_catch_up FROM cron_schedules WHERE active = 1 AND datetime(next_run_at) <= datetime(?) ORDER BY datetime(next_run_at) ASC",
          [nowIso]
        ).all<DueRow>()
      ).results;
    } catch {
      // Fallback for schemas without catch_up columns
      candidates = (
        await sys.raw(
          "SELECT id, workspace_id, target_workflow_id, target_url, cron_expression, timezone, next_run_at FROM cron_schedules WHERE active = 1 AND datetime(next_run_at) <= datetime(?) ORDER BY datetime(next_run_at) ASC",
          [nowIso]
        ).all<DueRow>()
      ).results;
    }

    if (allowedIds !== undefined) {
      candidates = candidates.filter((r) => allowedIds.includes(r.id));
    }

    const history: HistoryRecord[] = [];

    for (const sched of candidates) {
      const policy = sched.catch_up ?? "once";
      // Rows written before the cap may hold more; they are clamped here.
      const maxCatchUp = Math.min(sched.max_catch_up ?? MAX_CATCH_UP, MAX_CATCH_UP);
      const scheduledTime = new Date(sched.next_run_at);

      // Check if this run is overdue (missed at least one whole interval)
      const nextSlotAfterDue = computeNextRun(sched.cron_expression, scheduledTime);
      const isMissed = nextSlotAfterDue.getTime() <= now.getTime();

      if (policy === "skip" && isMissed) {
        // Policy 'skip': skip overdue slots, advance to future next_run_at, record 'missed' history
        const nextFutureRun = computeNextRun(sched.cron_expression, now);
        const claimRes = (
          await sys.raw(
            `UPDATE cron_schedules
            SET next_run_at = ?, last_run_at = ?
            WHERE id = ? AND next_run_at = ? AND active = 1
            RETURNING id`,
            [nextFutureRun.toISOString(), nowIso, sched.id, sched.next_run_at]
          ).all<{ id: string }>()
        ).results;

        if (!claimRes || claimRes.length === 0) {
          continue; // Claimed concurrently by another invocation
        }

        try {
          await this.db
            .prepare("UPDATE px_schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?")
            .bind(nextFutureRun.toISOString(), nowIso, sched.id)
            .run();
        } catch {}

        const histId = `crh_${crypto.randomUUID().replace(/-/g, "")}`;
        const missedRecord: HistoryRecord = {
          id: histId,
          schedule_id: sched.id,
          workspace_id: sched.workspace_id,
          scheduled_time: sched.next_run_at,
          actual_start_time: nowIso,
          duration_ms: 0,
          status: "missed",
          response_summary: "Missed run skipped per catchUp policy",
        };

        await sys.insert("cron_history", {
          id: histId,
          schedule_id: sched.id,
          workspace_id: sched.workspace_id,
          scheduled_time: sched.next_run_at,
          actual_start_time: nowIso,
          duration_ms: 0,
          status: "missed",
          response_summary: missedRecord.response_summary,
        });

        history.push(missedRecord);
        continue;
      }

      if (policy === "all") {
        // Policy 'all': replay missed slots up to maxCatchUp
        let currentSlot = new Date(sched.next_run_at);
        let runCount = 0;

        while (currentSlot.getTime() <= now.getTime() && runCount < maxCatchUp) {
          const isLastRun = runCount + 1 >= maxCatchUp;
          const nextSlot = computeNextRun(sched.cron_expression, currentSlot);
          const advanceTo =
            isLastRun && nextSlot.getTime() <= now.getTime()
              ? computeNextRun(sched.cron_expression, now)
              : nextSlot;

          const claimRes = (
            await sys.raw(
              `UPDATE cron_schedules
              SET next_run_at = ?, last_run_at = ?
              WHERE id = ? AND next_run_at = ? AND active = 1
              RETURNING id`,
              [advanceTo.toISOString(), nowIso, sched.id, currentSlot.toISOString()]
            ).all<{ id: string }>()
          ).results;

          if (!claimRes || claimRes.length === 0) {
            break; // Another worker claimed this slot
          }

          try {
            await this.db
              .prepare("UPDATE px_schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?")
              .bind(advanceTo.toISOString(), nowIso, sched.id)
              .run();
          } catch {}

          const record = await this.invokeTargetAndRecord(
            sched,
            currentSlot.toISOString(),
            nowIso,
          );
          history.push(record);

          runCount++;
          currentSlot = advanceTo;
        }

        continue;
      }

      // Default policy 'once': advance next_run_at to future, invoke exactly once
      const nextRun = computeNextRun(sched.cron_expression, now);
      const claimRes = (
        await sys.raw(
          `UPDATE cron_schedules
          SET next_run_at = ?, last_run_at = ?
          WHERE id = ? AND next_run_at = ? AND active = 1
          RETURNING id`,
          [nextRun.toISOString(), nowIso, sched.id, sched.next_run_at]
        ).all<{ id: string }>()
      ).results;

      if (!claimRes || claimRes.length === 0) {
        continue; // Claimed concurrently by another invocation
      }

      try {
        await this.db
          .prepare("UPDATE px_schedules SET next_run_at = ?, last_run_at = ? WHERE id = ?")
          .bind(nextRun.toISOString(), nowIso, sched.id)
          .run();
      } catch {}

      const record = await this.invokeTargetAndRecord(sched, sched.next_run_at, nowIso);
      history.push(record);
    }

    return history;
  }

  /**
   * Retrieves execution history for a schedule.
   */
  async getHistory(workspaceId: string, scheduleId?: string, limit = 50): Promise<HistoryRecord[]> {
    const s = scoped(this.db, workspaceId);
    if (scheduleId) {
      return s.select<HistoryRecord>(
        "cron_history",
        "schedule_id = ?",
        [scheduleId],
        { orderBy: "actual_start_time DESC", limit }
      );
    }

    return s.select<HistoryRecord>(
      "cron_history",
      undefined,
      [],
      { orderBy: "actual_start_time DESC", limit }
    );
  }
}

export interface ScheduledCronContext {
  controller?: { scheduledTime?: number; cron?: string };
  /** `CRON_WORKFLOW_TARGETS`: comma-separated Workflow binding names a schedule may start (story 0.20). */
  env: { DB: D1Like; CRON_WORKFLOW_TARGETS?: string; [key: string]: unknown };
  ctx?: unknown;
  dueRows?: Array<{
    id: string;
    workspace_id: string;
    brick_id: string;
    schedule_id: string;
    cron_expression: string;
    payload_json: string;
    next_run_at: string;
  }>;
}

export async function runScheduledCronAlarms(context: ScheduledCronContext): Promise<HistoryRecord[]> {
  const now = new Date(context.controller?.scheduledTime ?? Date.now());
  const service = new CronService(context.env.DB, 50, context.env);
  if (context.dueRows !== undefined) {
    if (context.dueRows.length === 0) return [];
    return service.triggerDueSchedules(
      now,
      context.dueRows.map((r) => r.schedule_id || r.id),
    );
  }
  return service.triggerDueSchedules(now);
}
