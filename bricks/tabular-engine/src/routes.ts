import { Hono } from "hono";
import { z } from "zod";
import { ImportJobNotFoundError, TabularService, type FieldMapping } from "./tabular.ts";
import { tabularMiddleware, type TabularEnv } from "./middleware.ts";

const InferSchema = z.object({
  csvText: z.string().min(1),
});

const CreateJobSchema = z.object({
  targetEntityType: z.string().min(1).max(64),
  filename: z.string().min(1).max(255),
});

const ExecuteImportSchema = z.object({
  csvText: z.string().min(1),
  mappings: z
    .array(
      z.object({
        csvColumn: z.string().min(1),
        targetField: z.string().min(1),
        type: z.enum(["string", "number", "boolean", "date"]),
        required: z.boolean().optional(),
      }),
    )
    .min(1),
});

const CreateGridViewSchema = z.object({
  entityType: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  columns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      width: z.number().optional(),
      visible: z.boolean().optional(),
    }),
  ),
  filters: z
    .array(
      z.object({
        field: z.string(),
        operator: z.string(),
        value: z.unknown(),
      }),
    )
    .optional(),
  sort: z
    .array(
      z.object({
        field: z.string(),
        direction: z.enum(["asc", "desc"]),
      }),
    )
    .optional(),
});

export function createTabularRoutes(): Hono<TabularEnv> {
  const app = new Hono<TabularEnv>();

  app.use("*", tabularMiddleware);

  // POST /tabular/infer
  app.post("/tabular/infer", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = InferSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("tabularService") || new TabularService(c.env.DB);
    const result = service.inferSchema(parsed.data.csvText);
    return c.json(result, 200);
  });

  // POST /tabular/imports
  app.post("/tabular/imports", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateJobSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("tabularService") || new TabularService(c.env.DB);
    const job = await service.createImportJob(workspaceId, parsed.data.targetEntityType, parsed.data.filename);

    return c.json({ job }, 201);
  });

  // POST /tabular/imports/:id/execute
  app.post("/tabular/imports/:id/execute", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const jobId = c.req.param("id");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ExecuteImportSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = c.get("tabularService") || new TabularService(c.env.DB);
    try {
      const result = await service.executeImport(ctx.workspaceId, jobId, parsed.data.csvText, parsed.data.mappings as FieldMapping[]);
      return c.json(result, 200);
    } catch (err: unknown) {
      if (err instanceof ImportJobNotFoundError) return c.json({ error: "Import job not found" }, 404);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // GET /tabular/imports/:id
  app.get("/tabular/imports/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const jobId = c.req.param("id");
    const service = c.get("tabularService") || new TabularService(c.env.DB);
    // Another workspace's job id is "not found", the same as an id that does not exist.
    const job = await service.getImportJob(ctx.workspaceId, jobId);

    if (!job) {
      return c.json({ error: "Import job not found" }, 404);
    }

    return c.json({ job }, 200);
  });

  // POST /tabular/views
  app.post("/tabular/views", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateGridViewSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("tabularService") || new TabularService(c.env.DB);
    const view = await service.createGridView(
      workspaceId,
      parsed.data.entityType,
      parsed.data.name,
      parsed.data.columns,
      parsed.data.filters,
      parsed.data.sort,
    );

    return c.json({ view }, 201);
  });

  // GET /tabular/views
  app.get("/tabular/views", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const entityType = c.req.query("entityType");

    const service = c.get("tabularService") || new TabularService(c.env.DB);
    const views = await service.listGridViews(workspaceId, entityType || undefined);

    return c.json({ views }, 200);
  });

  return app;
}
