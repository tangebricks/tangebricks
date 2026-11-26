import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_queue_jobs.sql?raw";
import { JobQueueService, createJobQueueRoutes } from "../src/index.ts";
import type { JobEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_A = "ws_tenant_a";
const WS_B = "ws_tenant_b";

/** The job routes behind a stand-in for the workspace middleware: `x-workspace-id` becomes the verified context. */
function routesWithContext(): Hono<JobEnv> {
  const app = new Hono<JobEnv>();
  app.use("*", stubWorkspaceContext);
  app.route("/", createJobQueueRoutes());
  return app;
}

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS job_queues").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("JobQueueService Tenant Scoping (F-ISO-1)", () => {
  it("prevents ws_a from reading ws_b job via getJob(workspaceId, id)", async () => {
    const service = new JobQueueService(db);
    const jobB = await service.enqueue({
      workspaceId: WS_B,
      taskType: "sensitive_task",
      payload: { secret: "b_secret_data" },
    });

    // ws_a attempts to get ws_b's job
    const fetchedByA = await service.getJob(WS_A, jobB.id);
    expect(fetchedByA).toBeNull();

    // ws_b can read its own job
    const fetchedByB = await service.getJob(WS_B, jobB.id);
    expect(fetchedByB).not.toBeNull();
    expect(fetchedByB?.id).toBe(jobB.id);
    expect(fetchedByB?.workspace_id).toBe(WS_B);
  });

  it("prevents ws_a from completing ws_b job via complete(workspaceId, id, result)", async () => {
    const service = new JobQueueService(db);
    const jobB = await service.enqueue({
      workspaceId: WS_B,
      taskType: "render_video",
      payload: { frameCount: 100 },
    });

    // Lease the job so it is running
    const leased = await service.dequeueBatch("default", 1);
    expect(leased).toHaveLength(1);
    expect(leased[0]?.id).toBe(jobB.id);

    // ws_a attempts to complete ws_b's job
    const completedByA = await service.complete(WS_A, jobB.id, {
      tampered: true,
    });
    expect(completedByA).toBe(false);

    // Verify row for ws_b is unchanged in DB
    const rawAfterA = await db
      .prepare("SELECT status, completed_at, result_json FROM job_queues WHERE id = ?")
      .bind(jobB.id)
      .first<{ status: string; completed_at: string | null; result_json: string | null }>();
    expect(rawAfterA?.status).toBe("running");
    expect(rawAfterA?.completed_at).toBeNull();
    expect(rawAfterA?.result_json).toBeNull();

    // ws_b successfully completes its own job
    const completedByB = await service.complete(WS_B, jobB.id, {
      tampered: false,
    });
    expect(completedByB).toBe(true);

    const rawAfterB = await db
      .prepare("SELECT status, completed_at, result_json FROM job_queues WHERE id = ?")
      .bind(jobB.id)
      .first<{ status: string; completed_at: string | null; result_json: string | null }>();
    expect(rawAfterB?.status).toBe("completed");
    expect(rawAfterB?.completed_at).not.toBeNull();
    expect(JSON.parse(rawAfterB?.result_json ?? "{}")).toEqual({ tampered: false });
  });

  it("prevents ws_a from failing ws_b job via fail(workspaceId, id, errorMessage)", async () => {
    const service = new JobQueueService(db);
    const jobB = await service.enqueue({
      workspaceId: WS_B,
      taskType: "payment_webhook",
      payload: { amount: 5000 },
      maxRetries: 3,
    });

    // Lease the job
    const leased = await service.dequeueBatch("default", 1);
    expect(leased).toHaveLength(1);

    // ws_a attempts to fail ws_b's job
    const failedByA = await service.fail(WS_A, jobB.id, "Malicious failure from ws_a");
    expect(failedByA).toBeNull();

    // Verify row for ws_b is unchanged in DB
    const rawAfterA = await db
      .prepare("SELECT status, error_message, attempt_count FROM job_queues WHERE id = ?")
      .bind(jobB.id)
      .first<{ status: string; error_message: string | null; attempt_count: number }>();
    expect(rawAfterA?.status).toBe("running");
    expect(rawAfterA?.error_message).toBeNull();
    expect(rawAfterA?.attempt_count).toBe(1);

    // ws_b legitimately fails its own job
    const failedByB = await service.fail(WS_B, jobB.id, "Legitimate retryable error");
    expect(failedByB).not.toBeNull();
    expect(failedByB?.status).toBe("queued");
    expect(failedByB?.error_message).toBe("Legitimate retryable error");
  });

  it("prevents cross-tenant access via HTTP routes", async () => {
    const app = routesWithContext();
    const service = new JobQueueService(db);

    const jobB = await service.enqueue({
      workspaceId: WS_B,
      taskType: "export_csv",
      payload: { customer: "b_corp" },
    });

    // ws_a attempts to GET ws_b's job
    const getRes = await app.request(`/jobs/${jobB.id}`, {
      headers: { "x-workspace-id": WS_A },
    }, { DB: db });
    expect(getRes.status).toBe(404);

    // ws_a attempts to complete ws_b's job
    const completeRes = await app.request(
      `/jobs/${jobB.id}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": WS_A,
        },
        body: JSON.stringify({ result: { stolen: true } }),
      },
      { DB: db }
    );
    expect([400, 404]).toContain(completeRes.status);

    // ws_a attempts to fail ws_b's job
    const failRes = await app.request(
      `/jobs/${jobB.id}/fail`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workspace-id": WS_A,
        },
        body: JSON.stringify({ error: "Unauthorized abort" }),
      },
      { DB: db }
    );
    expect([400, 404]).toContain(failRes.status);
  });

  it("takes the workspace from the verified context only, never from the query or body", async () => {
    const app = routesWithContext();
    const service = new JobQueueService(db);
    const jobB = await service.enqueue({ workspaceId: WS_B, taskType: "export_csv", payload: { customer: "b_corp" } });

    // QUERY_ONLY: no header, workspace named only in the query string -> missing context
    const queryOnly = await app.request(`/jobs?workspaceId=${WS_B}`, {}, { DB: db });
    expect(queryOnly.status).toBe(400);
    expect(((await queryOnly.json()) as { error: string }).error).toBe("Missing workspace context");

    // HEADER_A_QUERY_B: lists A's jobs only
    const listed = await app.request(`/jobs?workspaceId=${WS_B}`, { headers: { "x-workspace-id": WS_A } }, { DB: db });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { jobs: unknown[] }).jobs).toEqual([]);

    // HEADER_A_BODY_B: completing B's job with body workspaceId B is resolved against A, so B's job is untouched
    const complete = await app.request(
      `/jobs/${jobB.id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-workspace-id": WS_A },
        body: JSON.stringify({ workspaceId: WS_B, result: { stolen: true } }),
      },
      { DB: db },
    );
    expect([400, 404]).toContain(complete.status);
    expect((await service.getJob(WS_B, jobB.id))?.status).toBe("queued");

    // HEADER_A_BODY_B on enqueue: the job lands in A
    const enq = await app.request(
      "/jobs/enqueue",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-workspace-id": WS_A },
        body: JSON.stringify({ workspaceId: WS_B, taskType: "planted", payload: {} }),
      },
      { DB: db },
    );
    expect(enq.status).toBe(201);
    expect((await service.listJobs(WS_A)).map((j) => j.task_type)).toEqual(["planted"]);
    expect((await service.listJobs(WS_B)).map((j) => j.id)).toEqual([jobB.id]);
  });
});
