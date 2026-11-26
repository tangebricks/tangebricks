import { Hono } from "hono";
import { z } from "zod";
import { FacetedSearchService } from "./search.ts";
import { searchMiddleware, type SearchEnv } from "./middleware.ts";

const IndexDocSchema = z.object({
  entityType: z.string().min(1).max(64),
  entityId: z.string().min(1).max(128),
  title: z.string().min(1).max(255),
  body: z.string().min(1).max(16384),
  facets: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export function createSearchRoutes(): Hono<SearchEnv> {
  const app = new Hono<SearchEnv>();

  app.use("*", searchMiddleware);

  // POST /search/index
  app.post("/search/index", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = IndexDocSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("searchService") || new FacetedSearchService(c.env.DB);
    const doc = await service.indexDocument(
      workspaceId,
      parsed.data.entityType,
      parsed.data.entityId,
      parsed.data.title,
      parsed.data.body,
      parsed.data.facets
    );

    return c.json({ document: doc }, 201);
  });

  // DELETE /search/index/:type/:id
  app.delete("/search/index/:type/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const entityType = c.req.param("type");
    const entityId = c.req.param("id");

    const service = c.get("searchService") || new FacetedSearchService(c.env.DB);
    const ok = await service.deleteDocument(workspaceId, entityType, entityId);

    if (!ok) {
      return c.json({ error: "Document not found" }, 404);
    }

    return c.json({ ok: true }, 200);
  });

  // GET /search
  app.get("/search", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const q = c.req.query("q");
    const entityType = c.req.query("type");
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 20;
    const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : 0;

    if (!q) {
      return c.json({ error: "Search query 'q' parameter is required" }, 400);
    }

    const service = c.get("searchService") || new FacetedSearchService(c.env.DB);
    const results = await service.search(workspaceId, q, {
      entityType,
      limit,
      offset,
    });

    return c.json(results, 200);
  });

  // GET /search/typeahead
  app.get("/search/typeahead", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const prefix = c.req.query("prefix");
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 5;

    if (!prefix) {
      return c.json({ suggestions: [] }, 200);
    }

    const service = c.get("searchService") || new FacetedSearchService(c.env.DB);
    const suggestions = await service.typeahead(workspaceId, prefix, limit);

    return c.json({ suggestions }, 200);
  });

  return app;
}
