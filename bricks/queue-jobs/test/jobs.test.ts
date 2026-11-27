import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { assemble } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { emittedEntry, type EmittedWorker } from "../../../test/support/emitted-worker.ts";
import migration from "../migrations/0001_queue_jobs.sql?raw";
import { JobQueueService, createJobQueueRoutes } from "../src/index.ts";
import type { JobEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const shellWorker = emittedEntry<EmittedWorker>(import.meta.glob("../../../out/max-compatible/src/index.ts", { eager: true }), "max-compatible");
const WS_ALPHA = "ws_job_alpha";
const WS_BETA = "ws_job_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS job_queues").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Background Job Queue Core Logic", () => {
  it("enqueues jobs and dequeues in strict priority order", async () => {
    const service = new JobQueueService(db);

    // Enqueue low, normal, and urgent jobs
    await service.enqueue({ workspaceId: WS_ALPHA, taskType: "digest_email", payload: { uid: "u1" }, priority: -2 });
    await service.enqueue({ workspaceId: WS_ALPHA, taskType: "sync_hubspot", payload: { uid: "u2" }, priority: 0 });
    await service.enqueue({ workspaceId: WS_ALPHA, taskType: "fraud_alert", payload: { uid: "u3" }, priority: 10 });

    const batch = await service.dequeueBatch("default", 3);

    expect(batch).toHaveLength(3);
    // Urgent first
    expect(batch[0]?.task_type).toBe("fraud_alert");
    expect(batch[0]?.priority).toBe(10);
    expect(batch[0]?.status).toBe("running");

    // Normal second
    expect(batch[1]?.task_type).toBe("sync_hubspot");

    // Low third
    expect(batch[2]?.task_type).toBe("digest_email");

    // Subsequent dequeue yields empty because visibility timeout is active
    const emptyBatch = await service.dequeueBatch("default", 3);
    expect(emptyBatch).toHaveLength(0);
  });

  it("completes job with execution results and timestamp", async () => {
    const service = new JobQueueService(db);
    const job = await service.enqueue({
      workspaceId: WS_ALPHA,
      taskType: "render_pdf",
      payload: { docId: "doc_123" },
    });

    const claimed = await service.dequeueBatch("default", 1);
    expect(claimed).toHaveLength(1);

    const ok = await service.complete(WS_ALPHA, job.id, { r2Url: "https://r2.dev/doc.pdf", bytes: 1024 });
    expect(ok).toBe(true);

    const reloaded = await service.getJob(WS_ALPHA, job.id);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.result).toEqual({ r2Url: "https://r2.dev/doc.pdf", bytes: 1024 });
    expect(reloaded?.completed_at).not.toBeNull();
  });

  it("handles retries with backoff and moves to dead_letter on exhaustion", async () => {
    const service = new JobQueueService(db);
    const job = await service.enqueue({
      workspaceId: WS_ALPHA,
      taskType: "webhook_dispatch",
      payload: { target: "https://api.partner.com" },
      maxRetries: 2,
    });

    // 1st lease & failure
    await service.dequeueBatch("default", 1);
    const fail1 = await service.fail(WS_ALPHA, job.id, "503 Service Unavailable");
    expect(fail1?.status).toBe("queued");
    expect(fail1?.error_message).toBe("503 Service Unavailable");

    // Force next_run_at to past so it can be re-leased
    await db.prepare("UPDATE job_queues SET next_run_at = datetime('now', '-1 minute') WHERE id = ?").bind(job.id).run();

    // 2nd lease & failure (reaches maxRetries: 2)
    await service.dequeueBatch("default", 1);
    const fail2 = await service.fail(WS_ALPHA, job.id, "503 Connection Timeout");
    expect(fail2?.status).toBe("dead_letter");
    expect(fail2?.error_message).toBe("503 Connection Timeout");

    // Verify DLQ recovery
    const replayOk = await service.replayDeadLetter(WS_ALPHA, job.id);
    expect(replayOk).toBe(true);

    const replayed = await service.getJob(WS_ALPHA, job.id);
    expect(replayed?.status).toBe("queued");
    expect(replayed?.attempt_count).toBe(0);
    expect(replayed?.error_message).toBeNull();
  });

  it("strictly isolates jobs per workspace", async () => {
    const service = new JobQueueService(db);
    await service.enqueue({ workspaceId: WS_ALPHA, taskType: "alpha_task", payload: {} });
    await service.enqueue({ workspaceId: WS_BETA, taskType: "beta_task", payload: {} });

    const alphaJobs = await service.listJobs(WS_ALPHA);
    const betaJobs = await service.listJobs(WS_BETA);

    expect(alphaJobs).toHaveLength(1);
    expect(betaJobs).toHaveLength(1);
    expect(alphaJobs[0]?.task_type).toBe("alpha_task");
    expect(betaJobs[0]?.task_type).toBe("beta_task");
  });
});

describe("Background Job HTTP API", () => {
  it("enqueues, completes, fails, and queries jobs via HTTP", async () => {
    const app = new Hono<JobEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createJobQueueRoutes());

    // 1. POST /jobs/enqueue
    const enqRes = await app.request(
      "/api/jobs/enqueue",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({
          queueName: "reports",
          taskType: "generate_csv",
          payload: { filter: "2026-Q1" },
          priority: 5,
        }),
      },
      { DB: db },
    );
    expect(enqRes.status).toBe(201);
    const enqJson = (await enqRes.json()) as { job: { id: string } };
    const jobId = enqJson.job.id;

    // 2. GET /jobs/:id
    const getRes = await app.request(
      `/api/jobs/${jobId}`,
      {
        headers: { "x-workspace-id": WS_ALPHA },
      },
      { DB: db },
    );
    expect(getRes.status).toBe(200);

    // 3. POST /jobs/:id/complete
    const compRes = await app.request(
      `/api/jobs/${jobId}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-workspace-id": WS_ALPHA,
        },
        body: JSON.stringify({ result: { status: "success" } }),
      },
      { DB: db },
    );
    expect(compRes.status).toBe(200);

    // 4. GET /jobs
    const listRes = await app.request("/api/jobs?queueName=reports", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { jobs: unknown[] };
    expect(listJson.jobs).toHaveLength(1);
  });
});

describe("Assembled Shell queue() Dispatcher in workerd (AC 4)", () => {
  it("enqueues via API, delivers batch to shell queue(), marks succeeding job completed, retries and dead-letters failing job, and preserves workspace isolation", async () => {
    const assembled = assemble({ project: "queue-shell", bricks: ["multi-workspace", "queue-jobs"] }, catalog);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;

    for (const table of ["job_queues", "mw_workspace_members", "mw_workspaces"]) {
      await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    }
    const migrations = Object.entries(assembled.files)
      .filter(([p]) => p.startsWith("migrations/"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [, sql] of migrations) {
      await applyMigration(db, sql);
    }

    const createWs = async (user: string, name: string): Promise<string> => {
      const res = await shellWorker.fetch(
        new Request("https://example.test/api/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-user": user },
          body: JSON.stringify({ name }),
        }),
        { DB: db },
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { workspace: { id: string } }).workspace.id;
    };

    const wsAlpha = await createWs("alice", "Alpha Queue Workspace");
    const wsBeta = await createWs("bob", "Beta Queue Workspace");

    // 1. Enqueue a succeeding job in Workspace Alpha via API
    const okRes = await shellWorker.fetch(
      new Request("https://example.test/api/jobs/enqueue", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": "alice",
          "x-workspace-id": wsAlpha,
        },
        body: JSON.stringify({
          taskType: "render_invoice",
          payload: { invoiceId: "inv_001" },
        }),
      }),
      { DB: db },
    );
    expect(okRes.status).toBe(201);
    const okJobId = ((await okRes.json()) as { job: { id: string } }).job.id;

    // 2. Enqueue a failing job in Workspace Alpha with maxRetries: 2 via API
    const failRes = await shellWorker.fetch(
      new Request("https://example.test/api/jobs/enqueue", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": "alice",
          "x-workspace-id": wsAlpha,
        },
        body: JSON.stringify({
          taskType: "webhook_dispatch",
          payload: { shouldFail: true, failWith: "502 Bad Gateway" },
          maxRetries: 2,
        }),
      }),
      { DB: db },
    );
    expect(failRes.status).toBe(201);
    const failJobId = ((await failRes.json()) as { job: { id: string } }).job.id;

    // 3. Enqueue a separate job in Workspace Beta via API
    const betaRes = await shellWorker.fetch(
      new Request("https://example.test/api/jobs/enqueue", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": "bob",
          "x-workspace-id": wsBeta,
        },
        body: JSON.stringify({
          taskType: "beta_export",
          payload: { rows: 10 },
        }),
      }),
      { DB: db },
    );
    expect(betaRes.status).toBe(201);
    const betaJobId = ((await betaRes.json()) as { job: { id: string } }).job.id;

    // 4. Deliver first batch to the assembled shell's queue() handler
    const batch1 = createMessageBatch("job-queue", [
      { id: "msg_1", timestamp: new Date(), attempts: 1, body: { jobId: okJobId } },
      { id: "msg_2", timestamp: new Date(), attempts: 1, body: { jobId: failJobId } },
    ]);
    const ctx1 = createExecutionContext();
    await shellWorker.queue(batch1, { DB: db }, ctx1);
    const qResult1 = await getQueueResult(batch1, ctx1);
    expect(qResult1.explicitAcks).toContain("msg_1");
    expect(qResult1.retryMessages).toContainEqual({ msgId: "msg_2" });

    // Succeeding job is marked completed ("done")
    const okReloadedRes = await shellWorker.fetch(
      new Request(`https://example.test/api/jobs/${okJobId}`, {
        headers: { "x-test-user": "alice", "x-workspace-id": wsAlpha },
      }),
      { DB: db },
    );
    const okReloaded = ((await okReloadedRes.json()) as { job: { status: string; attempt_count: number; completed_at: string | null } }).job;
    expect(okReloaded.status).toBe("completed");
    expect(okReloaded.attempt_count).toBe(1);
    expect(okReloaded.completed_at).not.toBeNull();

    // Failing job after attempt 1 is retried (status = 'queued', attempt_count = 1)
    const failAfterAttempt1Res = await shellWorker.fetch(
      new Request(`https://example.test/api/jobs/${failJobId}`, {
        headers: { "x-test-user": "alice", "x-workspace-id": wsAlpha },
      }),
      { DB: db },
    );
    const failAfterAttempt1 = ((await failAfterAttempt1Res.json()) as { job: { status: string; attempt_count: number; error_message: string } }).job;
    expect(failAfterAttempt1.status).toBe("queued");
    expect(failAfterAttempt1.attempt_count).toBe(1);
    expect(failAfterAttempt1.error_message).toBe("502 Bad Gateway");

    // 5. Deliver second batch for the failing job (attempt 2 reaches maxRetries = 2 -> dead_letter)
    const batch2 = createMessageBatch("job-queue", [{ id: "msg_3", timestamp: new Date(), attempts: 2, body: { jobId: failJobId } }]);
    const ctx2 = createExecutionContext();
    await shellWorker.queue(batch2, { DB: db }, ctx2);
    const qResult2 = await getQueueResult(batch2, ctx2);
    expect(qResult2.explicitAcks).toContain("msg_3");

    const failAfterAttempt2Res = await shellWorker.fetch(
      new Request(`https://example.test/api/jobs/${failJobId}`, {
        headers: { "x-test-user": "alice", "x-workspace-id": wsAlpha },
      }),
      { DB: db },
    );
    const failAfterAttempt2 = ((await failAfterAttempt2Res.json()) as { job: { status: string; attempt_count: number; error_message: string } }).job;
    expect(failAfterAttempt2.status).toBe("dead_letter");
    expect(failAfterAttempt2.attempt_count).toBe(2);
    expect(failAfterAttempt2.error_message).toBe("502 Bad Gateway");

    // 6. Workspace isolation holds: Alpha sees only Alpha jobs; Beta sees only Beta jobs
    const alphaListRes = await shellWorker.fetch(
      new Request("https://example.test/api/jobs", {
        headers: { "x-test-user": "alice", "x-workspace-id": wsAlpha },
      }),
      { DB: db },
    );
    const alphaJobs = ((await alphaListRes.json()) as { jobs: Array<{ id: string; workspace_id: string }> }).jobs;
    expect(alphaJobs.map((j) => j.id).sort()).toEqual([okJobId, failJobId].sort());
    expect(alphaJobs.every((j) => j.workspace_id === wsAlpha)).toBe(true);

    const betaListRes = await shellWorker.fetch(
      new Request("https://example.test/api/jobs", {
        headers: { "x-test-user": "bob", "x-workspace-id": wsBeta },
      }),
      { DB: db },
    );
    const betaJobs = ((await betaListRes.json()) as { jobs: Array<{ id: string; workspace_id: string; status: string }> }).jobs;
    expect(betaJobs.map((j) => j.id)).toEqual([betaJobId]);
    expect(betaJobs[0]!.status).toBe("queued");
  });
});
