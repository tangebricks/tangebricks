import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_document_pdf.sql?raw";
import {
  DocumentPdfService,
  hydrateTemplate,
  generatePdfBinary,
  createDocumentRoutes,
} from "../src/index.ts";
import type { DocEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_doc_alpha";
const WS_BETA = "ws_doc_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS doc_renders").run();
  await db.prepare("DROP TABLE IF EXISTS doc_templates").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Document & PDF Engine Core Logic", () => {
  it("hydrates template variables and loops accurately", () => {
    const template = "Invoice for {{customerName}}\nTotal: ${{totalAmount}}\nItems:\n{{#each items}}- {{name}}: ${{price}}\n{{/each}}";
    const vars = {
      customerName: "Acme Corp",
      totalAmount: 150,
      items: [
        { name: "Pro Plan", price: 100 },
        { name: "Addon Seats", price: 50 },
      ],
    };

    const hydrated = hydrateTemplate(template, vars);

    expect(hydrated).toContain("Invoice for Acme Corp");
    expect(hydrated).toContain("Total: $150");
    expect(hydrated).toContain("- Pro Plan: $100");
    expect(hydrated).toContain("- Addon Seats: $50");
  });

  it("generates valid RFC-compliant binary PDF stream with watermark", () => {
    const bytes = generatePdfBinary({
      title: "Quarterly Financial Statement",
      lines: ["Revenue: $1,200,000", "Net Income: $350,000"],
      watermark: "CONFIDENTIAL",
    });

    const text = new TextDecoder().decode(bytes);

    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.includes("/Catalog")).toBe(true);
    expect(text.includes("Quarterly Financial Statement")).toBe(true);
    expect(text.includes("CONFIDENTIAL")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
  });

  it("renders document, saves audit record, and computes SHA-256 digital stamp", async () => {
    const service = new DocumentPdfService(db);
    const tmpl = await service.createTemplate(
      WS_ALPHA,
      "service_agreement",
      "Agreement between {{partyA}} and {{partyB}}\nEffective Date: {{effectiveDate}}"
    );

    expect(tmpl.id).toMatch(/^tmpl_[a-f0-9]{32}$/);

    const render = await service.renderDocument(WS_ALPHA, {
      templateId: tmpl.id,
      title: "Service Agreement - Acme & Wayne",
      variables: {
        partyA: "Acme Corp",
        partyB: "Wayne Enterprises",
        effectiveDate: "2026-11-01",
      },
      watermark: "DRAFT",
    });

    expect(render.id).toMatch(/^drend_[a-f0-9]{32}$/);
    expect(render.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(render.byteSize).toBeGreaterThan(100);

    // Verify stored render audit record in D1
    const renders = await service.listRenders(WS_ALPHA);
    expect(renders).toHaveLength(1);
    expect(renders[0]?.pdf_sha256).toBe(render.pdfSha256);
    expect(renders[0]?.title).toBe("Service Agreement - Acme & Wayne");
  });

  it("strictly isolates templates and renders between workspaces", async () => {
    const service = new DocumentPdfService(db);
    await service.createTemplate(WS_ALPHA, "tmpl_1", "Content A");
    await service.createTemplate(WS_BETA, "tmpl_1", "Content B");

    const alphaTemplates = await service.listTemplates(WS_ALPHA);
    const betaTemplates = await service.listTemplates(WS_BETA);

    expect(alphaTemplates).toHaveLength(1);
    expect(betaTemplates).toHaveLength(1);
    expect(alphaTemplates[0]?.template_html).toBe("Content A");
    expect(betaTemplates[0]?.template_html).toBe("Content B");
  });
});

describe("Document & PDF HTTP API", () => {
  it("provides full HTTP workflow for templates, JSON metadata, and binary download", async () => {
    const app = new Hono<DocEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createDocumentRoutes());

    // 1. POST /documents/templates
    const createRes = await app.request("/api/documents/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        name: "nda_contract",
        templateHtml: "Non-Disclosure Agreement for {{clientName}}",
      }),
    }, { DB: db });
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as { template: { id: string } };
    const tmplId = createJson.template.id;

    // 2. GET /documents/templates
    const listRes = await app.request("/api/documents/templates", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { templates: unknown[] };
    expect(listJson.templates).toHaveLength(1);

    // 3. POST /documents/render (JSON format)
    const renderRes = await app.request("/api/documents/render", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        templateId: tmplId,
        title: "NDA - Stark Industries",
        variables: { clientName: "Stark Industries" },
      }),
    }, { DB: db });
    expect(renderRes.status).toBe(201);
    const renderJson = (await renderRes.json()) as { renderId: string; sha256: string };
    expect(renderJson.renderId).toMatch(/^drend_/);
    expect(renderJson.sha256).toMatch(/^[a-f0-9]{64}$/);

    // 4. POST /documents/render?format=binary (Binary PDF format)
    const binRes = await app.request("/api/documents/render?format=binary", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        title: "Downloadable PDF",
        lines: ["Page 1 content"],
      }),
    }, { DB: db });
    expect(binRes.status).toBe(200);
    expect(binRes.headers.get("Content-Type")).toBe("application/pdf");
    expect(binRes.headers.get("X-PDF-SHA256")).not.toBeNull();
    const binBytes = await binRes.arrayBuffer();
    expect(binBytes.byteLength).toBeGreaterThan(100);

    // 5. GET /documents/renders
    const rendersRes = await app.request("/api/documents/renders", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(rendersRes.status).toBe(200);
    const rendersJson = (await rendersRes.json()) as { renders: unknown[] };
    expect(rendersJson.renders).toHaveLength(2);
  });

  // ID_READ_FOREIGN (story 0.7): another workspace's template id is "not found"; it is never rendered for the caller.
  it("answers 404 when rendering with a template id that belongs to another workspace", async () => {
    const app = new Hono<DocEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createDocumentRoutes());

    const service = new DocumentPdfService(db);
    const betaTmpl = await service.createTemplate(WS_BETA, "beta_secret", "Beta secret terms for {{name}}");

    const res = await app.request("/api/documents/render", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({ templateId: betaTmpl.id, title: "Stolen", variables: { name: "Mallory" } }),
    }, { DB: db });
    expect(res.status).toBe(404);
    expect(await service.getTemplate(WS_ALPHA, betaTmpl.id)).toBeNull();
    expect((await service.getTemplate(WS_BETA, betaTmpl.id))?.template_html).toContain("Beta secret terms");
    expect(await service.listRenders(WS_ALPHA)).toHaveLength(0);
  });
});
