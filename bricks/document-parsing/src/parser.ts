import { scoped, type D1Like } from "@poc/sdk";

export type DocumentStatus = "uploaded" | "processing" | "completed" | "failed";

export interface DocumentRecord {
  id: string;
  workspace_id: string;
  title: string;
  mime_type: string;
  file_size: number;
  status: DocumentStatus;
  error_message: string | null;
  raw_content: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DocumentChunk {
  id: string;
  document_id: string;
  workspace_id: string;
  chunk_index: number;
  heading: string | null;
  content: string;
  token_count: number;
  metadata_json: string;
  created_at: string;
}

export interface DocumentExtraction {
  id: string;
  document_id: string;
  workspace_id: string;
  schema_name: string;
  extracted_data: Record<string, unknown>;
  confidence: number;
  created_at: string;
}

export interface IngestDocumentInput {
  workspaceId: string;
  title: string;
  mimeType: string;
  rawContent?: string;
  fileSize?: number;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlap?: number;
  splitOnHeaders?: boolean;
}

export interface InvoiceExtractedData {
  invoiceNumber: string | null;
  date: string | null;
  dueDate: string | null;
  totalAmount: number | null;
  currency: string | null;
  vendorName: string | null;
  taxAmount: number | null;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
}

export interface ContactExtractedData {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  organization: string | null;
  jobTitle: string | null;
}

/**
 * Fast edge token estimator (approximately 1 token ~= 4 characters / 0.75 words)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

/**
 * Extracts structured rows from markdown tables:
 * | Col A | Col B |
 * |---|---|
 * | Val 1 | Val 2 |
 */
export function parseMarkdownTable(markdown: string): Array<Record<string, string>> {
  const lines = markdown.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|") && l.endsWith("|"));
  if (lines.length < 3) return [];

  // Parse Header row
  const headers = lines[0]
    .slice(1, -1)
    .split("|")
    .map((h) => h.trim());

  // Verify separator row contains dashes
  if (!lines[1].includes("-")) return [];

  const results: Array<Record<string, string>> = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i]
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.length === headers.length) {
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => {
        row[h] = cells[idx];
      });
      results.push(row);
    }
  }

  return results;
}

/**
 * Parses simple CSV content into JSON objects
 */
export function parseCsv(csvText: string): Array<Record<string, string>> {
  const lines = csvText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cells.length === headers.length) {
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => {
        row[h] = cells[idx];
      });
      rows.push(row);
    }
  }

  return rows;
}

export class DocumentParsingService {
  constructor(private readonly db: D1Like) {}

  /**
   * Ingests a new document record.
   */
  async ingestDocument(input: IngestDocumentInput): Promise<DocumentRecord> {
    const id = `doc_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const raw = input.rawContent ?? "";
    const size = input.fileSize ?? (raw ? new TextEncoder().encode(raw).length : 0);

    await scoped(this.db, input.workspaceId).insert("docp_documents", {
      id,
      title: input.title.trim(),
      mime_type: input.mimeType.trim().toLowerCase(),
      file_size: size,
      status: "uploaded",
      error_message: null,
      raw_content: raw,
      created_at: now,
      completed_at: null,
    });

    return {
      id,
      workspace_id: input.workspaceId,
      title: input.title.trim(),
      mime_type: input.mimeType.trim().toLowerCase(),
      file_size: size,
      status: "uploaded",
      error_message: null,
      raw_content: raw,
      created_at: now,
      completed_at: null,
    };
  }

  /**
   * Chunks a document's raw content into searchable/vectorizable fragments.
   */
  async chunkDocument(
    workspaceId: string,
    documentId: string,
    options: ChunkOptions = {}
  ): Promise<DocumentChunk[]> {
    const doc = await this.getDocument(workspaceId, documentId);
    if (!doc) {
      throw new Error(`Document ${documentId} not found in workspace`);
    }

    if (!doc.raw_content) {
      return [];
    }

    // Set processing status
    await scoped(this.db, workspaceId).update(
      "docp_documents",
      { status: "processing" },
      "id = ?",
      [documentId]
    );

    const maxTokens = options.maxTokens ?? 250;
    const splitOnHeaders = options.splitOnHeaders ?? true;
    const raw = doc.raw_content;

    // Delete any existing chunks for this document
    await scoped(this.db, workspaceId).delete(
      "docp_chunks",
      "document_id = ?",
      [documentId]
    );

    const rawSections: Array<{ heading: string | null; content: string }> = [];

    if (splitOnHeaders && (doc.mime_type.includes("markdown") || raw.includes("# "))) {
      // Split by Markdown headings (#, ##, ###)
      const lines = raw.split("\n");
      let currentHeading: string | null = null;
      let currentBuffer: string[] = [];

      for (const line of lines) {
        const headerMatch = line.match(/^(#{1,4})\s+(.+)$/);
        if (headerMatch) {
          if (currentBuffer.length > 0) {
            rawSections.push({
              heading: currentHeading,
              content: currentBuffer.join("\n").trim(),
            });
            currentBuffer = [];
          }
          currentHeading = headerMatch[2].trim();
        } else {
          currentBuffer.push(line);
        }
      }

      if (currentBuffer.length > 0) {
        rawSections.push({
          heading: currentHeading,
          content: currentBuffer.join("\n").trim(),
        });
      }
    } else {
      // Split by paragraphs
      const paragraphs = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      for (const p of paragraphs) {
        rawSections.push({ heading: null, content: p });
      }
    }

    // Combine or split sections to adhere to maxTokens limit
    const chunkItems: Array<{ heading: string | null; content: string; tokenCount: number }> = [];
    for (const section of rawSections) {
      if (!section.content) continue;
      const tokens = estimateTokens(section.content);
      if (tokens <= maxTokens) {
        chunkItems.push({
          heading: section.heading,
          content: section.content,
          tokenCount: tokens,
        });
      } else {
        // Break into sentences/windows
        const words = section.content.split(/\s+/);
        const approxWordsPerChunk = Math.floor(maxTokens * 0.75);
        for (let i = 0; i < words.length; i += approxWordsPerChunk) {
          const slice = words.slice(i, i + approxWordsPerChunk).join(" ");
          chunkItems.push({
            heading: section.heading,
            content: slice,
            tokenCount: estimateTokens(slice),
          });
        }
      }
    }

    const now = new Date().toISOString();
    const createdChunks: DocumentChunk[] = [];

    for (let idx = 0; idx < chunkItems.length; idx++) {
      const ch = chunkItems[idx];
      const chunkId = `chnk_${crypto.randomUUID().replace(/-/g, "")}`;
      const meta = JSON.stringify({ index: idx, title: doc.title });

      await scoped(this.db, workspaceId).insert("docp_chunks", {
        id: chunkId,
        document_id: documentId,
        chunk_index: idx,
        heading: ch.heading,
        content: ch.content,
        token_count: ch.tokenCount,
        metadata_json: meta,
        created_at: now,
      });

      createdChunks.push({
        id: chunkId,
        document_id: documentId,
        workspace_id: workspaceId,
        chunk_index: idx,
        heading: ch.heading,
        content: ch.content,
        token_count: ch.tokenCount,
        metadata_json: meta,
        created_at: now,
      });
    }

    // Mark document as completed
    await scoped(this.db, workspaceId).update(
      "docp_documents",
      { status: "completed", completed_at: now },
      "id = ?",
      [documentId]
    );

    return createdChunks;
  }

  /**
   * Rule-based & pattern extraction for structured entities (Invoices, Receipts, Contacts)
   */
  async extractStructuredData(
    workspaceId: string,
    documentId: string,
    schemaName: "invoice" | "contact" | "tables" | "custom",
    customRules?: Record<string, { pattern: string; type?: "string" | "number" }>
  ): Promise<DocumentExtraction> {
    const doc = await this.getDocument(workspaceId, documentId);
    if (!doc) {
      throw new Error(`Document ${documentId} not found`);
    }

    const text = doc.raw_content || "";
    let extracted: Record<string, unknown> = {};
    let confidence = 0.95;

    if (schemaName === "invoice") {
      const invNum = text.match(/(?:Invoice\s*(?:#|No\.|No|Number)\s*:?\s*|Invoice:\s*)([A-Z0-9_-]+)/i);
      const total = text.match(/(?:Total(?:\s*Amount)?|Amount\s*Due):?\s*(?:[$€£¥])?\s*([\d,]+(?:\.\d{2})?)/i);
      const tax = text.match(/(?:Tax|VAT|GST):?\s*(?:[$€£¥])?\s*([\d,]+(?:\.\d{2})?)/i);
      const date = text.match(/(?:Date|Invoice\s*Date):?\s*(\d{4}[-/.]\d{2}[-/.]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{4})/i);
      const vendor = text.match(/(?:Vendor|From|Billed\s*By):?\s*([A-Za-z0-9\s.,&'-]+?)(?:\n|$)/i);

      let currency = "USD";
      if (text.includes("€") || /EUR/i.test(text)) currency = "EUR";
      else if (text.includes("£") || /GBP/i.test(text)) currency = "GBP";
      else if (text.includes("¥") || /JPY/i.test(text)) currency = "JPY";

      const tableRows = parseMarkdownTable(text);
      const lineItems = tableRows.map((r) => ({
        description: r["Description"] || r["Item"] || r["Product"] || Object.values(r)[0] || "",
        quantity: parseFloat(r["Qty"] || r["Quantity"] || "1") || 1,
        unitPrice: parseFloat(r["Rate"] || r["Price"] || r["Unit Price"] || "0") || 0,
        amount: parseFloat(r["Amount"] || r["Total"] || "0") || 0,
      }));

      const invData: InvoiceExtractedData = {
        invoiceNumber: invNum ? invNum[1].trim() : null,
        date: date ? date[1].trim() : null,
        dueDate: null,
        totalAmount: total ? parseFloat(total[1].replace(/,/g, "")) : null,
        currency,
        vendorName: vendor ? vendor[1].trim() : null,
        taxAmount: tax ? parseFloat(tax[1].replace(/,/g, "")) : null,
        lineItems,
      };
      extracted = invData as unknown as Record<string, unknown>;
    } else if (schemaName === "contact") {
      const email = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      const phone = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      const name = text.match(/(?:Name|Contact):?[ \t]*([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)+)/);
      const company = text.match(/(?:Company|Organization):?\s*([A-Za-z0-9\s.,&'-]+?)(?:\n|$)/i);

      const contactData: ContactExtractedData = {
        fullName: name ? name[1].trim() : null,
        email: email ? email[0].trim() : null,
        phone: phone ? phone[0].trim() : null,
        organization: company ? company[1].trim() : null,
        jobTitle: null,
      };
      extracted = contactData as unknown as Record<string, unknown>;
    } else if (schemaName === "tables") {
      const mdTables = parseMarkdownTable(text);
      const csvTables = doc.mime_type.includes("csv") ? parseCsv(text) : [];
      extracted = {
        tables: mdTables.length > 0 ? mdTables : csvTables,
      };
    } else if (schemaName === "custom" && customRules) {
      for (const [key, rule] of Object.entries(customRules)) {
        try {
          const reg = new RegExp(rule.pattern, "i");
          const m = text.match(reg);
          if (m && m[1]) {
            extracted[key] = rule.type === "number" ? parseFloat(m[1].replace(/,/g, "")) : m[1].trim();
          } else {
            extracted[key] = null;
          }
        } catch {
          extracted[key] = null;
        }
      }
    }

    const extId = `ext_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const dataJson = JSON.stringify(extracted);

    await scoped(this.db, workspaceId).insert("docp_extractions", {
      id: extId,
      document_id: documentId,
      schema_name: schemaName,
      extracted_data_json: dataJson,
      confidence,
      created_at: now,
    });

    return {
      id: extId,
      document_id: documentId,
      workspace_id: workspaceId,
      schema_name: schemaName,
      extracted_data: extracted,
      confidence,
      created_at: now,
    };
  }

  /**
   * Retrieves document record by ID.
   */
  async getDocument(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const row = await scoped(this.db, workspaceId).first<DocumentRecord>(
      "docp_documents",
      "id = ?",
      [documentId]
    );

    return row || null;
  }

  /**
   * Retrieves all chunks for a document.
   */
  async getChunks(workspaceId: string, documentId: string): Promise<DocumentChunk[]> {
    return scoped(this.db, workspaceId).select<DocumentChunk>(
      "docp_chunks",
      "document_id = ?",
      [documentId],
      { orderBy: "chunk_index ASC" }
    );
  }

  /**
   * Retrieves all extractions for a document.
   */
  async getExtractions(workspaceId: string, documentId: string): Promise<DocumentExtraction[]> {
    const rows = await scoped(this.db, workspaceId).select<{
      id: string;
      document_id: string;
      workspace_id: string;
      schema_name: string;
      extracted_data_json: string;
      confidence: number;
      created_at: string;
    }>("docp_extractions", "document_id = ?", [documentId], {
      orderBy: "created_at DESC",
    });

    return rows.map((r) => ({
      id: r.id,
      document_id: r.document_id,
      workspace_id: r.workspace_id,
      schema_name: r.schema_name,
      extracted_data: JSON.parse(r.extracted_data_json || "{}"),
      confidence: r.confidence,
      created_at: r.created_at,
    }));
  }

  /**
   * Lists documents in workspace.
   */
  async listDocuments(
    workspaceId: string,
    options: { status?: DocumentStatus; limit?: number; offset?: number } = {}
  ): Promise<DocumentRecord[]> {
    return scoped(this.db, workspaceId).select<DocumentRecord>(
      "docp_documents",
      options.status ? "status = ?" : undefined,
      options.status ? [options.status] : [],
      {
        orderBy: "created_at DESC",
        limit: options.limit || 50,
        offset: options.offset || 0,
      }
    );
  }

  /**
   * Deletes document and cascading chunks/extractions.
   */
  async deleteDocument(workspaceId: string, documentId: string): Promise<boolean> {
    const res = await scoped(this.db, workspaceId).delete(
      "docp_documents",
      "id = ?",
      [documentId]
    );

    return res.meta.changes > 0;
  }
}
