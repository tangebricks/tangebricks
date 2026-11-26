import type { D1Like } from "@poc/sdk";
import { scoped } from "@poc/sdk";

export interface DocTemplate {
  id: string;
  workspace_id: string;
  name: string;
  template_html: string;
  default_metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface RenderedDocRecord {
  id: string;
  workspace_id: string;
  template_id: string | null;
  title: string;
  variables: Record<string, unknown>;
  pdf_sha256: string;
  byte_size: number;
  created_at: string;
}

export interface RenderResult {
  id: string;
  title: string;
  pdfBytes: Uint8Array;
  pdfSha256: string;
  byteSize: number;
  createdAt: string;
}

interface RawTemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  template_html: string;
  default_metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface RawRenderRow {
  id: string;
  workspace_id: string;
  template_id: string | null;
  title: string;
  variables_json: string;
  pdf_sha256: string;
  byte_size: number;
  created_at: string;
}

/**
 * Lightweight template hydration engine supporting variables and each-loops.
 */
export function hydrateTemplate(
  template: string,
  variables: Record<string, unknown>
): string {
  let result = template;

  // 1. Process each-loops: {{#each list}}...{{prop}}...{{/each}}
  const loopRegex = /\{\{#each\s+([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
  result = result.replace(loopRegex, (_, listKey, blockContent) => {
    const list = variables[listKey];
    if (!Array.isArray(list)) return "";

    return list.map((item) => {
      let itemBlock = blockContent;
      if (typeof item === "object" && item !== null) {
        Object.entries(item).forEach(([k, v]) => {
          itemBlock = itemBlock.replaceAll(`{{${k}}}`, String(v ?? ""));
        });
      } else {
        itemBlock = itemBlock.replaceAll("{{this}}", String(item ?? ""));
      }
      return itemBlock;
    }).join("");
  });

  // 2. Process simple variables: {{varName}}
  const varRegex = /\{\{([a-zA-Z0-9_.]+)\}\}/g;
  result = result.replace(varRegex, (_, key) => {
    const val = key.split(".").reduce((acc: unknown, part: string) => {
      if (acc && typeof acc === "object" && part in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[part];
      }
      return "";
    }, variables);
    return String(val ?? "");
  });

  return result;
}

// px-stub: one PDF page of plain text lines, no layout, pagination or HTML rendering
/**
 * Pure edge-compatible PDF binary builder generating standard PDF-1.4 stream.
 */
export function generatePdfBinary(options: {
  title: string;
  lines: string[];
  watermark?: string;
}): Uint8Array {
  const sanitize = (text: string) => text.replace(/[()\\]/g, "");

  // Build PDF content stream
  let streamText = "BT\n/F1 14 Tf\n50 780 Td\n";
  streamText += `(${sanitize(options.title)}) Tj\n`;
  streamText += "/F1 10 Tf\n0 -20 Td\n";

  for (const line of options.lines) {
    streamText += `(${sanitize(line)}) Tj\nT*\n`;
  }

  if (options.watermark) {
    // Watermark in larger font positioned diagonally or at bottom
    streamText += "/F1 24 Tf\n0 -40 Td\n";
    streamText += `([ ${sanitize(options.watermark)} ]) Tj\n`;
  }

  streamText += "ET";

  const streamBytes = new TextEncoder().encode(streamText);
  const streamLen = streamBytes.length;

  const header = "%PDF-1.4\n";

  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  const obj3 = "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n";
  const obj4 = "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  const obj5Header = `5 0 obj\n<< /Length ${streamLen} >>\nstream\n`;
  const obj5Footer = "\nendstream\nendobj\n";

  const preXref = header + obj1 + obj2 + obj3 + obj4 + obj5Header + streamText + obj5Footer;
  const startXref = new TextEncoder().encode(preXref).length;

  const xref = `xref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000236 00000 n \n0000000305 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  const fullDocString = preXref + xref;
  return new TextEncoder().encode(fullDocString);
}

/** Thrown when a template id does not exist in the caller's workspace (including another workspace's id). */
export class TemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`Template '${templateId}' not found`);
    this.name = "TemplateNotFoundError";
  }
}

export class DocumentPdfService {
  constructor(private readonly db: D1Like) {}

  /**
   * Registers a reusable document template.
   */
  async createTemplate(
    workspaceId: string,
    nameRaw: string,
    templateHtml: string,
    defaultMetadata?: Record<string, unknown>
  ): Promise<DocTemplate> {
    const id = `tmpl_${crypto.randomUUID().replace(/-/g, "")}`;
    const name = nameRaw.trim();
    const now = new Date().toISOString();
    const metaJson = defaultMetadata ? JSON.stringify(defaultMetadata) : null;

    const existing = await scoped(this.db, workspaceId).first<RawTemplateRow>("doc_templates", "name = ?", [name]);
    if (existing) {
      await scoped(this.db, workspaceId).update(
        "doc_templates",
        {
          template_html: templateHtml,
          default_metadata_json: metaJson,
          updated_at: now,
        },
        "id = ?",
        [existing.id],
      );
    } else {
      await scoped(this.db, workspaceId).insert("doc_templates", {
        id,
        name,
        template_html: templateHtml,
        default_metadata_json: metaJson,
        created_at: now,
        updated_at: now,
      });
    }

    return {
      id: existing ? existing.id : id,
      workspace_id: workspaceId,
      name,
      template_html: templateHtml,
      default_metadata: defaultMetadata || null,
      created_at: existing ? existing.created_at : now,
      updated_at: now,
    };
  }

  /**
   * Retrieves a template by ID, in the given workspace only: another workspace's template id is "not found".
   */
  async getTemplate(workspaceId: string, templateId: string): Promise<DocTemplate | null> {
    const row = await scoped(this.db, workspaceId).first<RawTemplateRow>("doc_templates", "id = ?", [templateId]);

    if (!row) return null;
    return {
      ...row,
      default_metadata: row.default_metadata_json ? JSON.parse(row.default_metadata_json) : null,
    };
  }

  /**
   * Lists templates for a workspace.
   */
  async listTemplates(workspaceId: string): Promise<DocTemplate[]> {
    const rows = await scoped(this.db, workspaceId).select<RawTemplateRow>(
      "doc_templates",
      undefined,
      [],
      { orderBy: "name ASC" },
    );

    return rows.map((r) => ({
      ...r,
      default_metadata: r.default_metadata_json ? JSON.parse(r.default_metadata_json) : null,
    }));
  }

  /**
   * Renders a document to PDF binary and stores an immutable audit render record.
   */
  async renderDocument(
    workspaceId: string,
    options: {
      templateId?: string;
      title: string;
      variables?: Record<string, unknown>;
      lines?: string[];
      watermark?: string;
    }
  ): Promise<RenderResult> {
    let lines = options.lines || [];

    // If template specified, hydrate it. The template must be the caller's own: another workspace's template id is
    // refused rather than rendered (which would copy its content into this workspace's PDF).
    if (options.templateId) {
      const tmpl = await this.getTemplate(workspaceId, options.templateId);
      if (!tmpl) throw new TemplateNotFoundError(options.templateId);
      const hydrated = hydrateTemplate(tmpl.template_html, options.variables || {});
      // Split hydrated text into lines for PDF generator
      lines = hydrated.split("\n").map((l) => l.trim()).filter(Boolean);
    }

    // Generate binary PDF stream
    const pdfBytes = generatePdfBinary({
      title: options.title,
      lines,
      watermark: options.watermark,
    });

    // Compute SHA-256 digital stamp
    const hashBuffer = await crypto.subtle.digest("SHA-256", pdfBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sha256 = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    const renderId = `drend_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).insert("doc_renders", {
      id: renderId,
      template_id: options.templateId || null,
      title: options.title.trim().slice(0, 255),
      variables_json: JSON.stringify(options.variables || {}),
      pdf_sha256: sha256,
      byte_size: pdfBytes.byteLength,
      created_at: now,
    });

    return {
      id: renderId,
      title: options.title,
      pdfBytes,
      pdfSha256: sha256,
      byteSize: pdfBytes.byteLength,
      createdAt: now,
    };
  }

  /**
   * Lists rendered documents for workspace.
   */
  async listRenders(workspaceId: string): Promise<RenderedDocRecord[]> {
    const rows = await scoped(this.db, workspaceId).select<RawRenderRow>(
      "doc_renders",
      undefined,
      [],
      { orderBy: "created_at DESC", limit: 50 },
    );

    return rows.map((r) => ({
      ...r,
      variables: JSON.parse(r.variables_json || "{}"),
    }));
  }
}
