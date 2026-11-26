import { Hono } from "hono";
import { z } from "zod";
import { DocumentPdfService, TemplateNotFoundError } from "./document.ts";
import { documentMiddleware, type DocEnv } from "./middleware.ts";

const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  templateHtml: z.string().min(1).max(32768),
  defaultMetadata: z.record(z.string(), z.unknown()).optional(),
});

const RenderDocSchema = z.object({
  templateId: z.string().optional(),
  title: z.string().min(1).max(255),
  variables: z.record(z.string(), z.unknown()).optional(),
  lines: z.array(z.string()).optional(),
  watermark: z.string().max(64).optional(),
});

export function createDocumentRoutes(): Hono<DocEnv> {
  const app = new Hono<DocEnv>();

  app.use("*", documentMiddleware);

  // POST /documents/templates
  app.post("/documents/templates", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateTemplateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("documentService") || new DocumentPdfService(c.env.DB);
    const template = await service.createTemplate(
      workspaceId,
      parsed.data.name,
      parsed.data.templateHtml,
      parsed.data.defaultMetadata
    );

    return c.json({ template }, 201);
  });

  // GET /documents/templates
  app.get("/documents/templates", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("documentService") || new DocumentPdfService(c.env.DB);
    const templates = await service.listTemplates(workspaceId);

    return c.json({ templates }, 200);
  });

  // POST /documents/render
  app.post("/documents/render", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = RenderDocSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("documentService") || new DocumentPdfService(c.env.DB);
    let result: Awaited<ReturnType<DocumentPdfService["renderDocument"]>>;
    try {
      result = await service.renderDocument(workspaceId, {
        templateId: parsed.data.templateId,
        title: parsed.data.title,
        variables: parsed.data.variables,
        lines: parsed.data.lines,
        watermark: parsed.data.watermark,
      });
    } catch (err: unknown) {
      // Another workspace's template id is "not found", the same as an id that does not exist.
      if (err instanceof TemplateNotFoundError) return c.json({ error: "Template not found" }, 404);
      throw err;
    }

    const format = c.req.query("format");
    if (format === "binary") {
      return new Response(result.pdfBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${result.title}.pdf"`,
          "X-PDF-SHA256": result.pdfSha256,
        },
      });
    }

    return c.json({
      renderId: result.id,
      title: result.title,
      sha256: result.pdfSha256,
      byteSize: result.byteSize,
      createdAt: result.createdAt,
    }, 201);
  });

  // GET /documents/renders
  app.get("/documents/renders", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("documentService") || new DocumentPdfService(c.env.DB);
    const renders = await service.listRenders(workspaceId);

    return c.json({ renders }, 200);
  });

  return app;
}
