import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_queue_jobs.sql?raw";
import jobsSource from "../src/jobs.ts?raw";
import { JobQueueService, type Job } from "../src/jobs.ts";

const db = env.DB as D1Like;
const WS_A = "ws_concur_a";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS job_queues").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("JobQueueService Atomic Claim & Concurrency (UC6.2)", () => {
  it("AC1: shows exactly one winner across 20 parallel claims, run 25 times in a loop", async () => {
    const service = new JobQueueService(db);

    for (let i = 0; i < 25; i++) {
      const job = await service.enqueue({
        workspaceId: WS_A,
        taskType: `concurrent_task_${i}`,
        payload: { iteration: i },
      });

      const claims = await Promise.all(
        Array.from({ length: 20 }, () => service.claimJobById(job.id, 60))
      );

      const winners = claims.filter((j): j is Job => j !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0].id).toBe(job.id);
      expect(winners[0].status).toBe("running");
      expect(winners[0].attempt_count).toBe(1);
    }
  });

  it("two concurrent dequeueBatch calls return disjoint id sets totaling 10", async () => {
    const service = new JobQueueService(db);
    for (let i = 0; i < 10; i++) {
      await service.enqueue({
        workspaceId: WS_A,
        queueName: "concur_batch_q",
        taskType: "batch_item",
        payload: { index: i },
      });
    }

    const [batch1, batch2] = await Promise.all([
      service.dequeueBatch("concur_batch_q", 10),
      service.dequeueBatch("concur_batch_q", 10),
    ]);

    const ids1 = new Set(batch1.map((j) => j.id));
    const ids2 = new Set(batch2.map((j) => j.id));

    expect(batch1.length + batch2.length).toBe(10);

    for (const id of ids1) {
      expect(ids2.has(id)).toBe(false);
    }
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
  });

  it("claiming a job already running with an unexpired lease returns null", async () => {
    const service = new JobQueueService(db);
    const job = await service.enqueue({
      workspaceId: WS_A,
      taskType: "unexpired_lease_test",
      payload: { active: true },
    });

    const claim1 = await service.claimJobById(job.id, 60);
    expect(claim1).not.toBeNull();
    expect(claim1?.status).toBe("running");

    const claim2 = await service.claimJobById(job.id, 60);
    expect(claim2).toBeNull();
  });

  it("expired lease becomes reclaimable by a subsequent claimJobById", async () => {
    const service = new JobQueueService(db);
    const job = await service.enqueue({
      workspaceId: WS_A,
      taskType: "expired_reclaim_test",
      payload: { test: true },
    });

    const claim1 = await service.claimJobById(job.id, 60);
    expect(claim1).not.toBeNull();
    expect(claim1?.attempt_count).toBe(1);

    // Expire the lease by updating next_run_at into the past
    await db
      .prepare("UPDATE job_queues SET next_run_at = datetime('now', '-10 seconds') WHERE id = ?")
      .bind(job.id)
      .run();

    const claim2 = await service.claimJobById(job.id, 60);
    expect(claim2).not.toBeNull();
    expect(claim2?.id).toBe(job.id);
    expect(claim2?.attempt_count).toBe(2);
    expect(claim2?.status).toBe("running");
  });

  it("AC2: no code path in jobs.ts performs SELECT-then-UPDATE for a state transition", () => {
    // AC2: /SELECT[\s\S]*?\bawait\b[\s\S]*?UPDATE job_queues/ is absent within any one method
    const methodMatches =
      jobsSource.match(/(?:async\s+)?(?:[a-zA-Z0-9_]+)\s*\([^)]*\)[^{]*\{[\s\S]*?\n  \}/g) ?? [];
    expect(methodMatches.length).toBeGreaterThan(0);
    for (const body of methodMatches) {
      expect(body).not.toMatch(/SELECT[\s\S]*?\bawait\b[\s\S]*?UPDATE\s+job_queues/i);
    }
  });

  it("AC3: stale complete after lease expired and was re-claimed returns false and preserves new lease state", async () => {
    const service = new JobQueueService(db);
    const job = await service.enqueue({
      workspaceId: WS_A,
      taskType: "stale_completion_test",
      payload: { step: 1 },
    });

    // Consumer 1 leases the job (attempt 1)
    const lease1 = await service.claimJobById(job.id, 60);
    expect(lease1).not.toBeNull();
    expect(lease1?.attempt_count).toBe(1);

    // Lease 1 expires
    await db
      .prepare("UPDATE job_queues SET next_run_at = datetime('now', '-10 seconds') WHERE id = ?")
      .bind(job.id)
      .run();

    // Consumer 2 re-claims the job (attempt 2)
    const lease2 = await service.claimJobById(job.id, 60);
    expect(lease2).not.toBeNull();
    expect(lease2?.attempt_count).toBe(2);

    // Consumer 1 (stale, attempt 1) attempts to complete the job
    const completedStale = await service.complete(
      WS_A,
      job.id,
      { fromConsumer1: true },
      lease1!.attempt_count
    );
    expect(completedStale).toBe(false);

    // Verify row in DB is still running with attempt_count 2 and lease2's state intact
    const current = await service.getJob(WS_A, job.id);
    expect(current?.status).toBe("running");
    expect(current?.attempt_count).toBe(2);
    expect(current?.result).toBeNull();
    expect(current?.completed_at).toBeNull();

    // Consumer 2 (valid, attempt 2) completes the job
    const completedValid = await service.complete(
      WS_A,
      job.id,
      { fromConsumer2: true },
      lease2!.attempt_count
    );
    expect(completedValid).toBe(true);

    const finalJob = await service.getJob(WS_A, job.id);
    expect(finalJob?.status).toBe("completed");
    expect(finalJob?.result).toEqual({ fromConsumer2: true });
    expect(finalJob?.completed_at).not.toBeNull();
  });

  it("stale fail after lease expired and was re-claimed returns null and preserves new lease state", async () => {
    const service = new JobQueueService(db);
    const job = await service.enqueue({
      workspaceId: WS_A,
      taskType: "stale_failure_test",
      payload: { step: 1 },
      maxRetries: 3,
    });

    const lease1 = await service.claimJobById(job.id, 60);
    expect(lease1).not.toBeNull();
    expect(lease1?.attempt_count).toBe(1);

    // Lease 1 expires
    await db
      .prepare("UPDATE job_queues SET next_run_at = datetime('now', '-10 seconds') WHERE id = ?")
      .bind(job.id)
      .run();

    // Consumer 2 re-claims the job (attempt 2)
    const lease2 = await service.claimJobById(job.id, 60);
    expect(lease2).not.toBeNull();
    expect(lease2?.attempt_count).toBe(2);

    // Consumer 1 (stale, attempt 1) attempts to fail the job
    const failStale = await service.fail(
      WS_A,
      job.id,
      "Stale timeout error",
      lease1!.attempt_count
    );
    expect(failStale).toBeNull();

    // Verify row in DB is still running with attempt_count 2
    const current = await service.getJob(WS_A, job.id);
    expect(current?.status).toBe("running");
    expect(current?.attempt_count).toBe(2);
  });
});
