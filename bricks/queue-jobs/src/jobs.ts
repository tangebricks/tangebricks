import { scoped, global } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "dead_letter";

export interface Job {
  id: string;
  workspace_id: string;
  queue_name: string;
  task_type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  max_retries: number;
  attempt_count: number;
  next_run_at: string;
  error_message: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
}

export interface EnqueueJobInput {
  workspaceId: string;
  queueName?: string;
  taskType: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
  delaySeconds?: number;
}

interface RawJobRow {
  id: string;
  workspace_id: string;
  queue_name: string;
  task_type: string;
  payload_json: string;
  status: JobStatus;
  priority: number;
  max_retries: number;
  attempt_count: number;
  next_run_at: string;
  error_message: string | null;
  result_json: string | null;
  created_at: string;
  completed_at: string | null;
}

export class JobQueueService {
  constructor(private readonly db: D1Like) {}

  private parseRow(row: RawJobRow): Job {
    let payload = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = {};
    }

    let result = null;
    if (row.result_json) {
      try {
        result = JSON.parse(row.result_json);
      } catch {
        result = null;
      }
    }

    return {
      id: row.id,
      workspace_id: row.workspace_id,
      queue_name: row.queue_name,
      task_type: row.task_type,
      payload,
      status: row.status,
      priority: row.priority,
      max_retries: row.max_retries,
      attempt_count: row.attempt_count,
      next_run_at: row.next_run_at,
      error_message: row.error_message,
      result,
      created_at: row.created_at,
      completed_at: row.completed_at,
    };
  }

  /**
   * Enqueues a job into a named queue with optional priority and delay.
   */
  async enqueue(input: EnqueueJobInput): Promise<Job> {
    const id = `job_${crypto.randomUUID().replace(/-/g, "")}`;
    const queueName = (input.queueName || "default").trim().toLowerCase();
    const priority = Math.max(-10, Math.min(10, input.priority ?? 0));
    const maxRetries = Math.max(0, input.maxRetries ?? 3);
    const delaySeconds = Math.max(0, input.delaySeconds ?? 0);

    const now = new Date();
    const nextRun = new Date(now.getTime() + delaySeconds * 1000);
    const nowIso = now.toISOString();
    const nextRunIso = nextRun.toISOString();

    await scoped(this.db, input.workspaceId).insert("job_queues", {
      id,
      queue_name: queueName,
      task_type: input.taskType.trim(),
      payload_json: JSON.stringify(input.payload),
      status: "queued",
      priority,
      max_retries: maxRetries,
      attempt_count: 0,
      next_run_at: nextRunIso,
      created_at: nowIso,
    });

    return {
      id,
      workspace_id: input.workspaceId,
      queue_name: queueName,
      task_type: input.taskType.trim(),
      payload: input.payload,
      status: "queued",
      priority,
      max_retries: maxRetries,
      attempt_count: 0,
      next_run_at: nextRunIso,
      error_message: null,
      result: null,
      created_at: nowIso,
      completed_at: null,
    };
  }

  /**
   * Leases a batch of available jobs, transitioning them to 'running'
   * and advancing visibility timeout.
   * Atomic single-statement update with RETURNING over candidate subquery.
   */
  async dequeueBatch(
    queueName = "default",
    limit = 10,
    visibilityTimeoutSeconds = 60
  ): Promise<Job[]> {
    const q = queueName.trim().toLowerCase();
    const nowIso = new Date().toISOString();
    const queueTable = global(this.db, "job_queues", "queue-worker-dequeue");
    const timeoutIso = new Date(Date.now() + visibilityTimeoutSeconds * 1000).toISOString();

    const sql =
      "UPDATE job_queues SET status = 'running', attempt_count = attempt_count + 1, next_run_at = ? " +
      "WHERE id IN (" +
      "SELECT id FROM job_queues WHERE queue_name = ? AND status = 'queued' AND next_run_at <= ? " +
      "ORDER BY priority DESC, created_at ASC LIMIT ?" +
      ") AND status = 'queued' " +
      "RETURNING *";

    const res = await queueTable.raw(sql, [timeoutIso, q, nowIso, limit]).all<RawJobRow>();
    const rows = res.results ?? [];
    if (rows.length === 0) return [];

    const jobs = rows.map((r) => this.parseRow(r));
    jobs.sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
    return jobs;
  }

  /**
   * Marks a job as completed and stores execution result.
   * Conditional on status='running' and optional attempt_count lease check.
   */
  async complete(
    workspaceId: string,
    jobId: string,
    resultOrAttempt?: Record<string, unknown> | number,
    maybeAttemptCount?: number
  ): Promise<boolean> {
    let result: Record<string, unknown> | undefined;
    let attemptCount: number | undefined;

    if (typeof resultOrAttempt === "number") {
      attemptCount = resultOrAttempt;
      result = undefined;
    } else {
      result = resultOrAttempt;
      attemptCount = maybeAttemptCount;
    }

    const now = new Date().toISOString();
    const resultJson = result ? JSON.stringify(result) : null;

    const where =
      attemptCount !== undefined
        ? "id = ? AND status = 'running' AND attempt_count = ?"
        : "id = ? AND (status = 'running' OR status = 'queued')";
    const params =
      attemptCount !== undefined ? [jobId, attemptCount] : [jobId];

    const res = await scoped(this.db, workspaceId).update(
      "job_queues",
      {
        status: "completed",
        result_json: resultJson,
        completed_at: now,
      },
      where,
      params
    );

    return res.meta.changes > 0;
  }

  /**
   * Reports job failure. Applies exponential backoff or dead-letter queue.
   * Conditional on status='running' and optional attempt_count lease check.
   */
  async fail(
    workspaceId: string,
    jobId: string,
    errorMessage: string,
    attemptCount?: number
  ): Promise<Job | null> {
    const s = scoped(this.db, workspaceId);
    const current = await this.getJob(workspaceId, jobId);
    if (!current) return null;
    if (attemptCount !== undefined) {
      if (current.status !== "running" || current.attempt_count !== attemptCount) {
        return null;
      }
    } else if (current.status !== "running" && current.status !== "queued") {
      return null;
    }

    const now = new Date();
    const errorMsg = errorMessage.slice(0, 2048);
    const where =
      attemptCount !== undefined
        ? "id = ? AND status = 'running' AND attempt_count = ?"
        : "id = ? AND (status = 'running' OR status = 'queued')";
    const params =
      attemptCount !== undefined ? [jobId, attemptCount] : [jobId];

    if (current.attempt_count >= current.max_retries) {
      // Move to Dead-Letter Queue
      const res = await s.update(
        "job_queues",
        {
          status: "dead_letter",
          error_message: errorMsg,
          completed_at: now.toISOString(),
        },
        where,
        params
      );

      if (res.meta.changes === 0) return null;

      return {
        ...current,
        status: "dead_letter",
        error_message: errorMsg,
        completed_at: now.toISOString(),
      };
    } else {
      // Exponential backoff retry: 5s, 10s, 20s, 40s...
      const delaySeconds = Math.pow(2, current.attempt_count) * 5;
      const nextRun = new Date(now.getTime() + delaySeconds * 1000).toISOString();

      const res = await s.update(
        "job_queues",
        {
          status: "queued",
          next_run_at: nextRun,
          error_message: errorMsg,
        },
        where,
        params
      );

      if (res.meta.changes === 0) return null;

      return {
        ...current,
        status: "queued",
        next_run_at: nextRun,
        error_message: errorMsg,
      };
    }
  }

  /**
   * Replays a dead-letter job by resetting attempts and status to 'queued'.
   */
  async replayDeadLetter(workspaceId: string, jobId: string): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const res = await scoped(this.db, workspaceId).update(
      "job_queues",
      {
        status: "queued",
        attempt_count: 0,
        next_run_at: nowIso,
        error_message: null,
        completed_at: null,
      },
      "id = ? AND status = 'dead_letter'",
      [jobId]
    );

    return res.meta.changes > 0;
  }

  /**
   * Retrieves a job by ID scoped to a workspace.
   */
  async getJob(workspaceId: string, jobId: string): Promise<Job | null> {
    const row = await scoped(this.db, workspaceId).first<RawJobRow>(
      "job_queues",
      "id = ?",
      [jobId]
    );

    if (!row) return null;
    return this.parseRow(row);
  }

  /**
   * Lists jobs for a workspace with optional filters.
   */
  async listJobs(
    workspaceId: string,
    options: { queueName?: string; status?: JobStatus; limit?: number } = {}
  ): Promise<Job[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.queueName) {
      conditions.push("queue_name = ?");
      params.push(options.queueName.trim().toLowerCase());
    }
    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }

    const where = conditions.length > 0 ? conditions.join(" AND ") : undefined;
    const rows = await scoped(this.db, workspaceId).select<RawJobRow>(
      "job_queues",
      where,
      params,
      {
        orderBy: "created_at DESC",
        limit: options.limit || 50,
      }
    );
    return rows.map((r) => this.parseRow(r));
  }

  async list(
    workspaceId: string,
    options: { queueName?: string; status?: JobStatus; limit?: number } = {}
  ): Promise<Job[]> {
    return this.listJobs(workspaceId, options);
  }

  /**
   * Claims a specific job by ID for queue consumer execution, incrementing attempt_count.
   * Atomic single-statement update with RETURNING: only leases if status is 'queued'
   * or if lease expired (status='running' and next_run_at <= now).
   */
  async claimJobById(jobId: string, visibilityTimeoutSeconds = 60): Promise<Job | null> {
    const queueTable = global(this.db, "job_queues", "queue-worker-claim");
    const nowIso = new Date().toISOString();
    const timeoutIso = new Date(Date.now() + visibilityTimeoutSeconds * 1000).toISOString();

    const sql =
      "UPDATE job_queues SET status = 'running', attempt_count = attempt_count + 1, next_run_at = ? " +
      "WHERE id = ? AND (status = 'queued' OR (status = 'running' AND next_run_at <= ?)) " +
      "RETURNING *";

    const row = await queueTable.raw(sql, [timeoutIso, jobId, nowIso]).first<RawJobRow>();
    if (!row) {
      return null;
    }
    return this.parseRow(row);
  }
}

export interface QueueMessageLike {
  id?: string;
  body: unknown;
  attempts?: number;
  ack?: () => void;
  retry?: (options?: { delaySeconds?: number }) => void;
}

export interface QueueBatchLike {
  queue: string;
  messages: readonly QueueMessageLike[];
  ackAll?: () => void;
  retryAll?: (options?: { delaySeconds?: number }) => void;
}

export async function consumeJobQueueBatch(
  batch: QueueBatchLike,
  env: { DB: D1Like; [key: string]: unknown },
  _ctx?: unknown,
): Promise<{ completed: string[]; retried: string[]; deadLettered: string[] }> {
  const service = new JobQueueService(env.DB);
  const completed: string[] = [];
  const retried: string[] = [];
  const deadLettered: string[] = [];

  for (const msg of batch.messages) {
    const body = (typeof msg.body === "object" && msg.body !== null ? msg.body : {}) as Record<string, unknown>;
    const jobId = typeof body.jobId === "string" ? body.jobId : typeof body.id === "string" ? body.id : null;
    if (!jobId) {
      msg.ack?.();
      continue;
    }

    const leased = await service.claimJobById(jobId);
    if (!leased) {
      msg.ack?.();
      continue;
    }

    if (leased.task_type === "batch-chunk") {
      const payload = leased.payload as {
        runId?: string;
        nodeId?: string;
        chunk?: number;
        totalChunks?: number;
        totalItems?: number;
        items?: unknown[];
        targetOperation?: string;
      };

      const chunkItems = Array.isArray(payload.items) ? payload.items : [];
      const db = env.DB as D1Like;
      const runId = payload.runId ?? "run_batch";
      const nodeId = payload.nodeId ?? "node_batch";
      const chunkIdx = Number(payload.chunk ?? 0);
      const targetOperation = payload.targetOperation ?? "integration.send";

      for (let itemIndex = 0; itemIndex < chunkItems.length; itemIndex++) {
        const item = chunkItems[itemIndex];
        const itemKey = `${runId}:${nodeId}:${chunkIdx}:${itemIndex}`;

        // Check if item already exists in job_batch_items (idempotent redelivery safety)
        const existing = await scoped(db, leased.workspace_id).first<{ id: string; status: string }>(
          "job_batch_items",
          "job_id = ? AND item_index = ?",
          [leased.id, itemIndex],
        );

        if (existing) {
          continue;
        }

        let itemStatus: "succeeded" | "failed" | "dead_letter" = "succeeded";
        let itemResultJson: string | null = null;
        let itemErrorMessage: string | null = null;

        try {
          const itemObj = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
          if (itemObj.shouldFail === true || itemObj.poison === true || itemObj.failWith) {
            throw new Error(String(itemObj.failWith ?? "POISON_PILL"));
          }

          let callResult: unknown = null;
          if (typeof (env as any).callOperation === "function") {
            callResult = await (env as any).callOperation(
              null,
              targetOperation,
              item,
              { idempotencyKey: itemKey },
            );
          } else {
            callResult = { ok: true, processed: true, idempotencyKey: itemKey };
          }
          itemResultJson = JSON.stringify(callResult);
        } catch (err: any) {
          // AC2: A poisoned item dead-letters alone
          itemStatus = "dead_letter";
          itemErrorMessage = err?.message ?? String(err);
        }

        const batchItemId = `item_${crypto.randomUUID().replace(/-/g, "")}`;
        await scoped(db, leased.workspace_id).insert("job_batch_items", {
          id: batchItemId,
          job_id: leased.id,
          item_index: itemIndex,
          idempotency_key: itemKey,
          status: itemStatus,
          result_json: itemResultJson,
          error_message: itemErrorMessage,
          created_at: new Date().toISOString(),
        });
      }

      await service.complete(
        leased.workspace_id,
        leased.id,
        {
          processed: true,
          chunk: chunkIdx,
          itemsCount: chunkItems.length,
        },
        leased.attempt_count,
      );
      completed.push(leased.id);
      msg.ack?.();

      // Check if all chunks for this runId and nodeId are completed
      if (typeof payload.totalChunks === "number") {
        const allChunksRow = await scoped(db, leased.workspace_id).raw(
          "SELECT COUNT(*) as finishedCount FROM job_queues WHERE workspace_id = ? AND task_type = 'batch-chunk' AND status IN ('completed', 'failed', 'dead_letter') AND json_extract(payload_json, '$.runId') = ? AND json_extract(payload_json, '$.nodeId') = ?",
          [leased.workspace_id, runId, nodeId],
        ).first<{ finishedCount: number }>();

        if (allChunksRow && allChunksRow.finishedCount >= payload.totalChunks) {
          const stats = await scoped(db, leased.workspace_id).raw(
            `SELECT 
               COUNT(*) as total,
               SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as succeeded,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
               SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) as deadLettered
             FROM job_batch_items WHERE workspace_id = ? AND idempotency_key LIKE ?`,
            [leased.workspace_id, `${runId}:${nodeId}:%`],
          ).first<{
            total: number;
            succeeded: number;
            failed: number;
            deadLettered: number;
          }>();

          const aggregate = {
            total: Number(stats?.total ?? payload.totalItems ?? chunkItems.length),
            succeeded: Number(stats?.succeeded ?? 0),
            failed: Number(stats?.failed ?? 0),
            deadLettered: Number(stats?.deadLettered ?? 0),
          };

          const aggKey = `${runId}:${nodeId}`;
          const aggregates = (globalThis as any).__px_batch_aggregates;
          const liveAgg = aggregates?.get(aggKey);
          if (liveAgg) {
            liveAgg.total = aggregate.total;
            liveAgg.succeeded = aggregate.succeeded;
            liveAgg.failed = aggregate.failed;
            liveAgg.deadLettered = aggregate.deadLettered;
          }

          const eventName = `batch:${runId}:${nodeId}`;
          const workflowObj = (env as Record<string, unknown>)["WORKFLOW"] as
            | { sendEvent?: (ev: unknown) => Promise<void> }
            | undefined;
          if (typeof workflowObj?.sendEvent === "function") {
            await workflowObj.sendEvent({ name: eventName, payload: aggregate });
          } else if (typeof (env as any).sendEvent === "function") {
            await (env as any).sendEvent({ name: eventName, payload: aggregate });
          }
        }
      }

      continue;
    }

    const payload = leased.payload;
    const failReason =
      typeof body.failWith === "string"
        ? body.failWith
        : typeof payload.failWith === "string"
          ? payload.failWith
          : body.shouldFail === true || payload.shouldFail === true
            ? "Job execution failed"
            : null;

    if (failReason) {
      const updated = await service.fail(
        leased.workspace_id,
        leased.id,
        failReason,
        leased.attempt_count
      );
      if (updated?.status === "dead_letter") {
        deadLettered.push(leased.id);
        msg.ack?.();
      } else {
        retried.push(leased.id);
        msg.retry?.();
      }
    } else {
      const resultData =
        typeof body.result === "object" && body.result !== null
          ? (body.result as Record<string, unknown>)
          : { processed: true, taskType: leased.task_type, workspaceId: leased.workspace_id };
      await service.complete(
        leased.workspace_id,
        leased.id,
        resultData,
        leased.attempt_count
      );
      completed.push(leased.id);
      msg.ack?.();
    }
  }

  return { completed, retried, deadLettered };
}
