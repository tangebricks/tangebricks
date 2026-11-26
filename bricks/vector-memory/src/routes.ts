import { Hono } from "hono";
import { z } from "zod";
import { VectorMemoryService, type VectorMetric } from "./vectors.ts";
import { vectorMiddleware, type VectorEnv } from "./middleware.ts";

const CreateIndexSchema = z.object({
  name: z.string().min(1).max(100),
  dimensions: z.number().int().min(1).max(4096).default(384),
  metric: z.enum(["cosine", "euclidean", "dot"]).default("cosine"),
});

const UpsertChunksSchema = z.object({
  chunks: z.array(
    z.object({
      text: z.string().min(1).max(8192),
      embedding: z.array(z.number()),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
  ).min(1),
});

const SearchSchema = z.object({
  vector: z.array(z.number()).min(1),
  topK: z.number().int().min(1).max(100).default(5),
  minScore: z.number().min(-1).max(1).default(0.0),
});

export function createVectorRoutes(): Hono<VectorEnv> {
  const app = new Hono<VectorEnv>();

  app.use("*", vectorMiddleware);

  // POST /vectors/indexes
  app.post("/vectors/indexes", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateIndexSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("vectorService") || new VectorMemoryService(c.env.DB);
    const index = await service.createIndex(
      workspaceId,
      parsed.data.name,
      parsed.data.dimensions,
      parsed.data.metric as VectorMetric
    );

    return c.json({ index }, 201);
  });

  // GET /vectors/indexes
  app.get("/vectors/indexes", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("vectorService") || new VectorMemoryService(c.env.DB);
    const indexes = await service.listIndexes(workspaceId);

    return c.json({ indexes }, 200);
  });

  // POST /vectors/indexes/:id/upsert
  app.post("/vectors/indexes/:id/upsert", async (c) => {
    const indexId = c.req.param("id");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = UpsertChunksSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("vectorService") || new VectorMemoryService(c.env.DB);
    const result = await service.upsertChunks(workspaceId, indexId, parsed.data.chunks);

    if (!result.ok) {
      return c.json({ error: result.error }, result.error === "Vector index not found" ? 404 : 400);
    }

    return c.json(result, 201);
  });

  // POST /vectors/indexes/:id/search
  app.post("/vectors/indexes/:id/search", async (c) => {
    const indexId = c.req.param("id");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = SearchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("vectorService") || new VectorMemoryService(c.env.DB);
    // Another workspace's index id is "not found", the same as an id that does not exist.
    if (!(await service.getIndex(workspaceId, indexId))) {
      return c.json({ error: "Vector index not found" }, 404);
    }
    const results = await service.search(
      workspaceId,
      indexId,
      parsed.data.vector,
      parsed.data.topK,
      parsed.data.minScore
    );

    return c.json({ results }, 200);
  });

  return app;
}
