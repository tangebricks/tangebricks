import { Hono } from "hono";
import { z } from "zod";
import { DocumentParsingService, type DocumentStatus } from "./parser.ts";
import { documentMiddleware, type DocumentEnv } from "./middleware.ts";

const IngestDocSchema = z.object({
  title: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  rawContent: z.string().optional(),
  fileSize: z.number().int().nonnegative().optional(),
});

const ChunkDocSchema = z.object({
  maxTokens: z.number().int().min(10).max(8192).optional(),
  splitOnHeaders: z.boolean().optional(),
});

const ExtractDocSchema = z.object({
  schemaName: z.enum(["invoice", "contact", "tables", "custom"]),
  customRules: z
    .record(
      z.string(),
      z.object({
        pattern: z.string().min(1),
        type: z.enum(["string", "number"]).optional(),
      }),
    )
    .optional(),
});

export function createDocumentRoutes(): Hono<DocumentEnv> {
  const app = new Hono<DocumentEnv>();

  app.use("*", documentMiddleware);

  // POST /docs/ingest - Ingest document
  app.post("/docs/ingest", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = IngestDocSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("parsingService") || new DocumentParsingService(c.env.DB);
    const doc = await service.ingestDocument({
      workspaceId,
      title: parsed.data.title,
      mimeType: parsed.data.mimeType,
      rawContent: parsed.data.rawContent,
      fileSize: parsed.data.fileSize,
    });

    return c.json(doc, 201);
  });

  // POST /docs/:id/chunk - Chunk document
  app.post("/docs/:id/chunk", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const docId = c.req.param("id");

    let body: unknown = {};
    try {
      body = (await c.req.json()) || {};
    } catch {
      // Body can be empty
    }

    const parsed = ChunkDocSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("parsingService") || new DocumentParsingService(c.env.DB);
    try {
      const chunks = await service.chunkDocument(workspaceId, docId, {
        maxTokens: parsed.data.maxTokens,
        splitOnHeaders: parsed.data.splitOnHeaders,
      });
      return c.json({ chunks });
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to chunk document" }, 404);
    }
  });

  // POST /docs/:id/extract - Extract schema-constrained structured data
  app.post("/docs/:id/extract", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const docId = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ExtractDocSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("parsingService") || new DocumentParsingService(c.env.DB);
    try {
      const extraction = await service.extractStructuredData(workspaceId, docId, parsed.data.schemaName, parsed.data.customRules);
      return c.json(extraction, 201);
    } catch (e: any) {
      return c.json({ error: e.message || "Extraction failed" }, 404);
    }
  });

  // GET /docs - List documents
  app.get("/docs", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const status = c.req.query("status") as DocumentStatus | undefined;
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
    const offset = c.req.query("offset") ? Number(c.req.query("offset")) : 0;

    const service = c.get("parsingService") || new DocumentParsingService(c.env.DB);
    const docs = await service.listDocuments(workspaceId, { status, limit, offset });
    return c.json({ documents: docs });
  });

  // GET /docs/:id - Get document details
  app.get("/docs/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const docId = c.req.param("id");
    const service = c.get("parsingService") || new DocumentParsingService(c.env.DB);
    const doc = await service.getDocument(workspaceId, docId);
    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }

    return c.json(doc);
  });

  // GET /docs/:id/chunks - Get chunks for document
  app.get("/docs/:id/chunks", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const docId = c.req.param("id");
    const service = c.get("parsingService") || new DocumentParsingService(c.env.DB);
    // A document id outside the caller's workspace is not found, not an empty list.
    if (!(await service.getDocument(workspaceId, docId))) return c.json({ error: "Document not found" }, 404);
    const chunks = await service.getChunks(workspaceId, docId);
    return c.json({ chunks });
  });

  // GET /docs/:id/extractions - Get extractions for document
  app.get("/docs/:id/extractions", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const docId = c.req.param("id");
    const service = c.get("parsingService") || new DocumentParsingService(c.env.DB);
    if (!(await service.getDocument(workspaceId, docId))) return c.json({ error: "Document not found" }, 404);
    const extractions = await service.getExtractions(workspaceId, docId);
    return c.json({ extractions });
  });

  // DELETE /docs/:id - Delete document
  app.delete("/docs/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const docId = c.req.param("id");
    const service = c.get("parsingService") || new DocumentParsingService(c.env.DB);
    const ok = await service.deleteDocument(workspaceId, docId);
    if (!ok) {
      return c.json({ error: "Document not found" }, 404);
    }

    return c.json({ success: true });
  });

  return app;
}
