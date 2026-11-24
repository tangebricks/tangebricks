import { Hono } from "hono";
import { z } from "zod";
import type { D1Like } from "@poc/sdk";
import { WorkflowService } from "./workflow.ts";

export interface WorkflowEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
  };
}

const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(100),
  graph: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      type: z.string(),
      data: z.record(z.string(), z.unknown()).default({}),
    })),
    edges: z.array(z.object({
      id: z.string(),
      source: z.string(),
      target: z.string(),
      sourceHandle: z.string().optional(),
      targetHandle: z.string().optional(),
    })),
  }),
});

const RunPayloadSchema = z.record(z.string(), z.unknown()).default({});

export function createWorkflowRoutes(): Hono<WorkflowEnv> {
  const app = new Hono<WorkflowEnv>();

  // List workflows
  app.get("/workflows", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new WorkflowService(c.env.DB);
    const workflows = await service.listWorkflows(workspace.id);
    return c.json({ workflows }, 200);
  });

  // Create workflow
  app.post("/workflows", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateWorkflowSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = new WorkflowService(c.env.DB);
    const result = await service.createWorkflow(workspace.id, parsed.data.name, parsed.data.graph);

    if (!result.ok) {
      return c.json({ error: result.error }, result.code as 400 | 500);
    }

    return c.json({ workflow: result.workflow }, 201);
  });

  // Get workflow details
  app.get("/workflows/:id", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new WorkflowService(c.env.DB);
    const workflow = await service.getWorkflow(workspace.id, c.req.param("id"));

    if (!workflow) return c.json({ error: "Workflow not found" }, 404);
    return c.json({ workflow }, 200);
  });

  // Execute workflow
  app.post("/workflows/:id/run", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      // payload is optional
    }

    const payload = RunPayloadSchema.parse(body);
    const service = new WorkflowService(c.env.DB);
    const result = await service.executeWorkflow(workspace.id, c.req.param("id"), payload, "api");

    if (!result.ok) {
      return c.json({ error: result.error }, result.code as 400 | 404 | 500);
    }

    return c.json({ run: result.run, steps: result.steps }, 200);
  });

  // Get run execution details
  app.get("/runs/:id", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new WorkflowService(c.env.DB);
    const details = await service.getRun(workspace.id, c.req.param("id"));

    if (!details) return c.json({ error: "Run not found" }, 404);
    return c.json(details, 200);
  });

  return app;
}
