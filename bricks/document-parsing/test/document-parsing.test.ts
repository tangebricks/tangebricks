import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_document_parsing.sql?raw";
import {
  DocumentParsingService,
  estimateTokens,
  parseMarkdownTable,
  parseCsv,
  createDocumentRoutes,
} from "../src/index.ts";
import type { DocumentEnv } from "../src/middleware.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_doc_alpha";
const WS_BETA = "ws_doc_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS docp_extractions").run();
  await db.prepare("DROP TABLE IF EXISTS docp_chunks").run();
  await db.prepare("DROP TABLE IF EXISTS docp_documents").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Document Parsing Utilities", () => {
  it("estimates token counts accurately for text chunks", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("Hello world")).toBeGreaterThanOrEqual(1);
    const text100 = "a".repeat(400);
    expect(estimateTokens(text100)).toBe(100);
  });

  it("parses markdown tables into structured row arrays", () => {
    const md = `
# Summary Report
| Product | Price | Qty |
|---|---|---|
| Edge Worker | 5.00 | 2 |
| D1 Database | 0.00 | 1 |
`;
    const rows = parseMarkdownTable(md);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Product: "Edge Worker", Price: "5.00", Qty: "2" });
    expect(rows[1]).toEqual({ Product: "D1 Database", Price: "0.00", Qty: "1" });
  });

  it("parses CSV content into structured row arrays", () => {
    const csv = `ID,Name,Role\n101,"Alice",Engineer\n102,"Bob",Designer\n`;
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.Name).toBe("Alice");
    expect(rows[1]?.Role).toBe("Designer");
  });
});

describe("Document Parsing Service Core", () => {
  it("ingests, chunks by headings, and updates document status", async () => {
    const service = new DocumentParsingService(db);

    const doc = await service.ingestDocument({
      workspaceId: WS_ALPHA,
      title: "Architecture Guide",
      mimeType: "text/markdown",
      rawContent: `# Overview\nThis is an overview of the system architecture.\n\n# Database Layer\nD1 provides distributed SQLite across the Cloudflare edge network.\n\n# Storage Layer\nR2 provides S3-compatible zero-egress blob storage.`,
    });

    expect(doc.id).toMatch(/^doc_[a-f0-9]{32}$/);
    expect(doc.status).toBe("uploaded");

    // Chunk by headings
    const chunks = await service.chunkDocument(WS_ALPHA, doc.id, {
      maxTokens: 100,
      splitOnHeaders: true,
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.heading).toBe("Overview");
    expect(chunks[1]?.heading).toBe("Database Layer");
    expect(chunks[2]?.heading).toBe("Storage Layer");
    expect(chunks[0]?.token_count).toBeGreaterThan(0);

    const updatedDoc = await service.getDocument(WS_ALPHA, doc.id);
    expect(updatedDoc!.status).toBe("completed");
    expect(updatedDoc!.completed_at).not.toBeNull();
  });

  it("extracts structured invoice data with line items", async () => {
    const service = new DocumentParsingService(db);

    const rawInvoice = `
INVOICE
Vendor: Acme Cloud Services Inc.
Invoice Number: INV-2026-904
Invoice Date: 2026-10-25
Amount Due: $1,250.00
Tax: $125.00

| Description | Qty | Rate | Amount |
|---|---|---|---|
| Enterprise Cloud Subscription | 1 | 1000.00 | 1000.00 |
| Dedicated Edge Support | 1 | 250.00 | 250.00 |
`;

    const doc = await service.ingestDocument({
      workspaceId: WS_ALPHA,
      title: "Acme Invoice.txt",
      mimeType: "text/plain",
      rawContent: rawInvoice,
    });

    const extraction = await service.extractStructuredData(WS_ALPHA, doc.id, "invoice");

    expect(extraction.schema_name).toBe("invoice");
    expect(extraction.confidence).toBeGreaterThan(0.9);

    const data = extraction.extracted_data as any;
    expect(data.invoiceNumber).toBe("INV-2026-904");
    expect(data.vendorName).toBe("Acme Cloud Services Inc.");
    expect(data.totalAmount).toBe(1250);
    expect(data.taxAmount).toBe(125);
    expect(data.currency).toBe("USD");
    expect(data.lineItems).toHaveLength(2);
    expect(data.lineItems[0].description).toBe("Enterprise Cloud Subscription");
    expect(data.lineItems[0].amount).toBe(1000);

    // Verify stored extractions
    const listExt = await service.getExtractions(WS_ALPHA, doc.id);
    expect(listExt).toHaveLength(1);
    expect(listExt[0]?.extracted_data["invoiceNumber"]).toBe("INV-2026-904");
  });

  it("extracts contact card and custom regex schemas", async () => {
    const service = new DocumentParsingService(db);

    const doc = await service.ingestDocument({
      workspaceId: WS_ALPHA,
      title: "Business Card",
      mimeType: "text/plain",
      rawContent: `Contact: Bruce Wayne\nCompany: Wayne Enterprises\nReach me at: bruce@wayne-ent.com or (555) 019-2831\nTax ID: TX-998822`,
    });

    // 1. Contact schema
    const contactExt = await service.extractStructuredData(WS_ALPHA, doc.id, "contact");
    const contact = contactExt.extracted_data as any;
    expect(contact.fullName).toBe("Bruce Wayne");
    expect(contact.email).toBe("bruce@wayne-ent.com");
    expect(contact.organization).toBe("Wayne Enterprises");

    // 2. Custom schema with regex
    const customExt = await service.extractStructuredData(WS_ALPHA, doc.id, "custom", {
      taxId: { pattern: "Tax ID:\\s*([A-Z0-9-]+)", type: "string" },
    });
    expect((customExt.extracted_data as any).taxId).toBe("TX-998822");
  });

  it("enforces multi-tenant workspace isolation and cascade deletion", async () => {
    const service = new DocumentParsingService(db);

    const doc = await service.ingestDocument({
      workspaceId: WS_ALPHA,
      title: "Confidential Plan",
      mimeType: "text/plain",
      rawContent: "Top secret strategy for Alpha Corp.",
    });

    await service.chunkDocument(WS_ALPHA, doc.id, { maxTokens: 50 });

    // Beta cannot access Alpha's document or chunks
    const crossFetch = await service.getDocument(WS_BETA, doc.id);
    expect(crossFetch).toBeNull();

    const crossChunks = await service.getChunks(WS_BETA, doc.id);
    expect(crossChunks).toHaveLength(0);

    // Delete cascading check
    const deleted = await service.deleteDocument(WS_ALPHA, doc.id);
    expect(deleted).toBe(true);

    const chunksAfter = await service.getChunks(WS_ALPHA, doc.id);
    expect(chunksAfter).toHaveLength(0);
  });
});

describe("Document Parsing REST API", () => {
  function createApp(workspaceId: string = WS_ALPHA) {
    const app = new Hono<DocumentEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: workspaceId, role: "admin" });
      c.set("ctx", Object.freeze({ userId: "usr_doc_tester", workspaceId, role: "admin" }));
      c.set("user", { uid: "usr_doc_tester", name: "Doc Admin" });
      await next();
    });
    app.route("/", createDocumentRoutes());
    return app;
  }

  it("ingests, chunks, extracts, and fetches via HTTP API", async () => {
    const app = createApp();

    // 1. Ingest
    const ingestRes = await app.request(
      "http://localhost/docs/ingest",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Q4 Financials",
          mimeType: "text/markdown",
          rawContent: "# Revenue\nRevenue was $500,000.\n# Expenses\nExpenses were $300,000.",
        }),
      },
      { DB: db }
    );
    expect(ingestRes.status).toBe(201);
    const doc = (await ingestRes.json()) as any;
    expect(doc.id).toBeDefined();

    // 2. Chunk
    const chunkRes = await app.request(
      `http://localhost/docs/${doc.id}/chunk`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxTokens: 100 }),
      },
      { DB: db }
    );
    expect(chunkRes.status).toBe(200);
    const chunkJson = (await chunkRes.json()) as any;
    expect(chunkJson.chunks).toHaveLength(2);

    // 3. Extract custom regex
    const extRes = await app.request(
      `http://localhost/docs/${doc.id}/extract`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaName: "custom",
          customRules: {
            revenue: { pattern: "Revenue was \\$([\\d,]+)", type: "number" },
          },
        }),
      },
      { DB: db }
    );
    expect(extRes.status).toBe(201);
    const extJson = (await extRes.json()) as any;
    expect(extJson.extracted_data.revenue).toBe(500000);

    // 4. List docs & chunks
    const listRes = await app.request(
      `http://localhost/docs`,
      { method: "GET" },
      { DB: db }
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as any;
    expect(listJson.documents).toHaveLength(1);

    // 5. Delete
    const delRes = await app.request(
      `http://localhost/docs/${doc.id}`,
      { method: "DELETE" },
      { DB: db }
    );
    expect(delRes.status).toBe(200);
  });

  it("story 0.11 ID_GUESS: GET /docs/:id/chunks and /extractions answer 404 for another workspace's document id, 200 for its own", async () => {
    const service = new DocumentParsingService(db);
    const doc = await service.ingestDocument({
      workspaceId: WS_ALPHA,
      title: "Alpha Only",
      mimeType: "text/plain",
      rawContent: "Alpha secret content.",
    });
    await service.chunkDocument(WS_ALPHA, doc.id, { maxTokens: 50 });

    for (const sub of ["chunks", "extractions"]) {
      const foreign = await createApp(WS_BETA).request(`http://localhost/docs/${doc.id}/${sub}`, { method: "GET" }, { DB: db });
      expect(foreign.status, sub).toBe(404);
      expect(await foreign.text()).not.toContain("Alpha secret");

      const own = await createApp(WS_ALPHA).request(`http://localhost/docs/${doc.id}/${sub}`, { method: "GET" }, { DB: db });
      expect(own.status, sub).toBe(200);
    }
    const ownChunks = await createApp(WS_ALPHA).request(`http://localhost/docs/${doc.id}/chunks`, { method: "GET" }, { DB: db });
    expect(((await ownChunks.json()) as { chunks: unknown[] }).chunks.length).toBeGreaterThan(0);
  });

  it("returns 400 on invalid input and 404 on missing document", async () => {
    const app = createApp();

    const badIngest = await app.request(
      "http://localhost/docs/ingest",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "" }),
      },
      { DB: db }
    );
    expect(badIngest.status).toBe(400);

    const notFound = await app.request(
      `http://localhost/docs/doc_missing999`,
      { method: "GET" },
      { DB: db }
    );
    expect(notFound.status).toBe(404);
  });
});
