import { Hono, type Context } from "hono";
import { z } from "zod";
import { JobQueueService, type JobStatus } from "./jobs.ts";
import { jobQueueMiddleware, type JobEnv } from "./middleware.ts";

const EnqueueSchema = z.object({
  queueName: z.string().min(1).max(64).optional(),
  taskType: z.string().min(1).max(64),
  payload: z.record(z.unknown()),
  priority: z.number().int().min(-10).max(10).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  delaySeconds: z.number().int().min(0).max(86400).optional(),
});

const CompleteSchema = z.object({
  result: z.record(z.unknown()).optional(),
  attemptCount: z.number().int().min(0).optional(),
});

const FailSchema = z.object({
  error: z.string().min(1).max(2048),
  attemptCount: z.number().int().min(0).optional(),
});

/**
 * The verified workspace set by the workspace middleware. Never a header, query or body value read here: those are
 * what the caller sent, and only the middleware may turn one into a workspace after checking membership.
 */
function getWorkspaceId(c: Context<JobEnv>): string | undefined {
  return c.get("ctx")?.workspaceId;
}

export function createJobQueueRoutes(): Hono<JobEnv> {
  const app = new Hono<JobEnv>();

  app.use("*", jobQueueMiddleware);

  // POST /jobs/enqueue
  app.post("/jobs/enqueue", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = EnqueueSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) {
      return c.json({ error: "Missing workspace context" }, 400);
    }

    const service = c.get("jobService") || new JobQueueService(c.env.DB);
    const job = await service.enqueue({
      workspaceId,
      queueName: parsed.data.queueName,
      taskType: parsed.data.taskType,
      payload: parsed.data.payload,
      priority: parsed.data.priority,
      maxRetries: parsed.data.maxRetries,
      delaySeconds: parsed.data.delaySeconds,
    });

    return c.json({ job }, 201);
  });

  // GET /jobs/:id
  app.get("/jobs/:id", async (c) => {
    const jobId = c.req.param("id");
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) {
      return c.json({ error: "Missing workspace context" }, 400);
    }

    const service = c.get("jobService") || new JobQueueService(c.env.DB);
    const job = await service.getJob(workspaceId, jobId);

    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    return c.json({ job }, 200);
  });

  // POST /jobs/:id/complete
  app.post("/jobs/:id/complete", async (c) => {
    const jobId = c.req.param("id");
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const parsed = CompleteSchema.safeParse(body);
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) {
      return c.json({ error: "Missing workspace context" }, 400);
    }

    const service = c.get("jobService") || new JobQueueService(c.env.DB);
    const ok = await service.complete(
      workspaceId,
      jobId,
      parsed.success ? parsed.data.result : undefined,
      parsed.success ? parsed.data.attemptCount : undefined
    );

    if (!ok) {
      return c.json({ error: "Failed to complete job" }, 400);
    }

    return c.json({ ok: true }, 200);
  });

  // POST /jobs/:id/fail
  app.post("/jobs/:id/fail", async (c) => {
    const jobId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = FailSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) {
      return c.json({ error: "Missing workspace context" }, 400);
    }

    const service = c.get("jobService") || new JobQueueService(c.env.DB);
    const job = await service.fail(
      workspaceId,
      jobId,
      parsed.data.error,
      parsed.data.attemptCount
    );

    if (!job) {
      return c.json({ error: "Job not found" }, 404);
    }

    return c.json({ job }, 200);
  });

  // POST /jobs/:id/replay
  app.post("/jobs/:id/replay", async (c) => {
    const jobId = c.req.param("id");
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) {
      return c.json({ error: "Missing workspace context" }, 400);
    }

    const service = c.get("jobService") || new JobQueueService(c.env.DB);
    const ok = await service.replayDeadLetter(workspaceId, jobId);

    if (!ok) {
      return c.json({ error: "Job is not in dead_letter status or not found" }, 400);
    }

    return c.json({ ok: true }, 200);
  });

  // GET /jobs
  app.get("/jobs", async (c) => {
    const workspaceId = getWorkspaceId(c);
    const queueName = c.req.query("queueName");
    const status = c.req.query("status") as JobStatus | undefined;

    if (!workspaceId) {
      return c.json({ error: "Missing workspace context" }, 400);
    }

    const service = c.get("jobService") || new JobQueueService(c.env.DB);
    const jobs = await service.listJobs(workspaceId, {
      queueName,
      status,
    });

    return c.json({ jobs }, 200);
  });

  return app;
}
