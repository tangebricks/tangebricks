import { Hono } from "hono";
import { z } from "zod";
import type { D1Like, RequestContext } from "@poc/sdk";
import { WORKSPACE_ADMIN_ROLES, workspaceRoleRefusal } from "@poc/sdk";
import { CronService, MAX_CATCH_UP, parseWorkflowTargets } from "./cron.ts";

export interface CronEnv {
  Bindings: {
    DB: D1Like;
    /** Comma-separated Workflow binding names a schedule may start (story 0.20). Unset: none. */
    CRON_WORKFLOW_TARGETS?: string;
  };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified request context set by the workspace middleware; the only source of the caller's role. */
    ctx?: RequestContext;
  };
}

export interface CronRouteOptions {
  maxSchedules?: number;
}

const CreateScheduleSchema = z.object({
  cronExpression: z.string().min(9).max(100),
  targetWorkflowId: z.string().max(64).optional(),
  targetUrl: z.string().url().max(1024).optional(),
  timezone: z.string().max(64).default("UTC"),
  catchUp: z.enum(["skip", "once", "all"]).default("once"),
  maxCatchUp: z.number().int().min(1).max(MAX_CATCH_UP).default(MAX_CATCH_UP),
});

const ToggleScheduleSchema = z.object({
  active: z.boolean(),
});

export function createScheduleRoutes(options: CronRouteOptions = {}): Hono<CronEnv> {
  const app = new Hono<CronEnv>();

  // List schedules in current workspace
  app.get("/schedules", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new CronService(c.env.DB, options.maxSchedules);
    const schedules = await service.listSchedules(workspace.id);
    return c.json({ schedules }, 200);
  });

  // Owner/admin only (sweep B17). Create schedule
  app.post("/schedules", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateScheduleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    // The env carries the app's Workflow target allowlist (CRON_WORKFLOW_TARGETS); it is never tenant-settable.
    const service = new CronService(c.env.DB, options.maxSchedules, undefined, undefined, {
      allowedWorkflowTargets: parseWorkflowTargets(c.env.CRON_WORKFLOW_TARGETS),
    });
    const result = await service.createSchedule(workspace.id, parsed.data.cronExpression, {
      targetWorkflowId: parsed.data.targetWorkflowId,
      targetUrl: parsed.data.targetUrl,
      timezone: parsed.data.timezone,
      catchUp: parsed.data.catchUp,
      maxCatchUp: parsed.data.maxCatchUp,
    });

    if (!result.ok) {
      return c.json(
        { error: result.error, ...(result.errorCode ? { code: result.errorCode } : {}) },
        result.code as 400 | 403 | 500,
      );
    }

    return c.json({ schedule: result.schedule }, 201);
  });

  // Get schedule details
  app.get("/schedules/:id", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new CronService(c.env.DB, options.maxSchedules);
    const schedule = await service.getSchedule(workspace.id, c.req.param("id"));

    if (!schedule) return c.json({ error: "Schedule not found" }, 404);
    return c.json({ schedule }, 200);
  });

  // Owner/admin only (sweep B17). Toggle active state
  app.patch("/schedules/:id", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ToggleScheduleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid active boolean" }, 400);
    }

    const service = new CronService(c.env.DB, options.maxSchedules);
    const toggled = await service.toggleSchedule(workspace.id, c.req.param("id"), parsed.data.active);

    if (!toggled) return c.json({ error: "Schedule not found" }, 404);
    return c.json({ success: true }, 200);
  });

  // Owner/admin only (sweep B17). Delete schedule
  app.delete("/schedules/:id", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new CronService(c.env.DB, options.maxSchedules);
    const deleted = await service.deleteSchedule(workspace.id, c.req.param("id"));

    if (!deleted) return c.json({ error: "Schedule not found" }, 404);
    return c.json({ success: true }, 200);
  });

  // Get execution history
  app.get("/schedules/:id/history", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new CronService(c.env.DB, options.maxSchedules);
    // A schedule id outside the caller's workspace is not found, not an empty history.
    const schedule = await service.getSchedule(workspace.id, c.req.param("id"));
    if (!schedule) return c.json({ error: "Schedule not found" }, 404);
    const history = await service.getHistory(workspace.id, schedule.id);
    return c.json({ history }, 200);
  });

  return app;
}
