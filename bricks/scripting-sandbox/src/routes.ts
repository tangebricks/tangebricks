import { Hono } from "hono";
import { z } from "zod";
import { ScriptingSandboxService, executeSandboxed } from "./sandbox.ts";
import { sandboxMiddleware, type ScriptEnv } from "./middleware.ts";
import { createScriptIsolate } from "./isolate.ts";

const CreateScriptSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  triggerEvent: z.string().min(1).max(64),
  sourceCode: z.string().min(1).max(50000),
  timeoutMs: z.number().int().min(100).max(10000).optional(),
});

const UpdateScriptSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  sourceCode: z.string().min(1).max(50000).optional(),
  isEnabled: z.boolean().optional(),
});

const ExecuteScriptSchema = z.object({
  payload: z.record(z.string(), z.unknown()).default({}),
});

const DryRunSchema = z.object({
  sourceCode: z.string().min(1).max(50000),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export function createScriptingRoutes(): Hono<ScriptEnv> {
  const app = new Hono<ScriptEnv>();

  app.use("*", sandboxMiddleware);

  const getService = (c: any): ScriptingSandboxService =>
    c.get("sandboxService") || new ScriptingSandboxService(c.env.DB, createScriptIsolate(c.env));

  // POST /scripts - Create script
  app.post("/scripts", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateScriptSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = getService(c);
    try {
      const script = await service.createScript({
        workspaceId,
        name: parsed.data.name,
        description: parsed.data.description,
        triggerEvent: parsed.data.triggerEvent,
        sourceCode: parsed.data.sourceCode,
        timeoutMs: parsed.data.timeoutMs,
      });

      return c.json(script, 201);
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to create script" }, 400);
    }
  });

  // GET /scripts - List scripts
  app.get("/scripts", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = getService(c);
    const scripts = await service.listScripts(workspaceId);
    return c.json({ scripts });
  });

  // POST /scripts/test - Dry run test bench
  app.post("/scripts/test", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = DryRunSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = getService(c);
    const result = await executeSandboxed(parsed.data.sourceCode, parsed.data.payload, service.isolate);
    return c.json(result);
  });

  // GET /scripts/:id - Get script
  app.get("/scripts/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const scriptId = c.req.param("id");
    const service = getService(c);
    const script = await service.getScript(workspaceId, scriptId);
    if (!script) {
      return c.json({ error: "Script not found" }, 404);
    }

    return c.json(script);
  });

  // PUT /scripts/:id - Update script
  app.put("/scripts/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const scriptId = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = UpdateScriptSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = getService(c);
    try {
      const updated = await service.updateScript(workspaceId, scriptId, {
        name: parsed.data.name,
        description: parsed.data.description,
        sourceCode: parsed.data.sourceCode,
        isEnabled: parsed.data.isEnabled,
      });

      if (!updated) {
        return c.json({ error: "Script not found" }, 404);
      }

      return c.json(updated);
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to update script" }, 400);
    }
  });

  // POST /scripts/:id/run - Execute script with payload
  app.post("/scripts/:id/run", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const scriptId = c.req.param("id");

    let body: unknown = {};
    try {
      body = (await c.req.json()) || {};
    } catch {
      // Body optional
    }

    const parsed = ExecuteScriptSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = getService(c);
    try {
      const execution = await service.executeScript(workspaceId, scriptId, parsed.data.payload);
      return c.json(execution);
    } catch (e: any) {
      return c.json({ error: e.message || "Execution failed" }, 404);
    }
  });

  // GET /scripts/:id/executions - Get execution logs
  app.get("/scripts/:id/executions", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const scriptId = c.req.param("id");
    const service = getService(c);
    // A script id outside the caller's workspace is not found, not an empty log.
    if (!(await service.getScript(workspaceId, scriptId))) return c.json({ error: "Script not found" }, 404);
    const logs = await service.getExecutionLogs(workspaceId, scriptId);
    return c.json({ executions: logs });
  });

  // DELETE /scripts/:id - Delete script
  app.delete("/scripts/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const scriptId = c.req.param("id");
    const service = getService(c);
    const ok = await service.deleteScript(workspaceId, scriptId);
    if (!ok) {
      return c.json({ error: "Script not found" }, 404);
    }

    return c.json({ success: true });
  });

  return app;
}
