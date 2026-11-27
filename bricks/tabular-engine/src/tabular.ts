import type { D1Like } from "@poc/sdk";
import { scoped } from "@poc/sdk";

export type FieldType = "string" | "number" | "boolean" | "date";

export interface FieldMapping {
  csvColumn: string;
  targetField: string;
  type: FieldType;
  required?: boolean;
}

export interface ImportError {
  row: number;
  column: string;
  value: string;
  message: string;
}

export interface ImportJob {
  id: string;
  workspace_id: string;
  target_entity_type: string;
  filename: string;
  status: "pending" | "mapping" | "validating" | "processing" | "completed" | "failed";
  total_rows: number;
  processed_rows: number;
  error_count: number;
  mapping_config: FieldMapping[] | null;
  error_log: ImportError[];
  created_at: string;
  completed_at: string | null;
}

export interface GridView {
  id: string;
  workspace_id: string;
  name: string;
  entity_type: string;
  columns: Array<{ key: string; label: string; width?: number; visible?: boolean }>;
  filters: Array<{ field: string; operator: string; value: unknown }>;
  sort: Array<{ field: string; direction: "asc" | "desc" }>;
  created_at: string;
  updated_at: string;
}

/**
 * Robust RFC 4180 compliant CSV parser running purely in edge JavaScript.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let insideQuotes = false;
  let i = 0;

  const len = text.length;

  while (i < len) {
    const char = text[i];

    if (char === '"') {
      if (insideQuotes && text[i + 1] === '"') {
        // Escaped quote: "" -> "
        currentField += '"';
        i += 2;
        continue;
      }
      insideQuotes = !insideQuotes;
      i++;
      continue;
    }

    if (char === "," && !insideQuotes) {
      currentRow.push(currentField);
      currentField = "";
      i++;
      continue;
    }

    if ((char === "\r" || char === "\n") && !insideQuotes) {
      // End of row
      currentRow.push(currentField);
      currentField = "";

      if (currentRow.length > 1 || (currentRow.length === 1 && (currentRow[0] ?? "").trim() !== "")) {
        rows.push(currentRow);
      }
      currentRow = [];

      if (char === "\r" && text[i + 1] === "\n") {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    currentField += char;
    i++;
  }

  if (currentField !== "" || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.length > 1 || (currentRow.length === 1 && (currentRow[0] ?? "").trim() !== "")) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/** Thrown when an import job id does not exist in the caller's workspace (including another workspace's id). */
export class ImportJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Import job '${jobId}' not found`);
    this.name = "ImportJobNotFoundError";
  }
}

export class TabularService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  /**
   * Automatically infers column headers and sample previews from CSV text.
   */
  inferSchema(csvText: string): { headers: string[]; previewRows: Record<string, string>[] } {
    const rows = parseCsv(csvText);
    if (rows.length === 0) return { headers: [], previewRows: [] };

    // rows is not empty (checked above), so the default is never used.
    const [headerRow = [], ...dataRows] = rows;
    const headers = headerRow.map((h) => h.trim());
    const preview = dataRows.slice(0, 5).map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => {
        obj[h] = r[idx] !== undefined ? r[idx].trim() : "";
      });
      return obj;
    });

    return { headers, previewRows: preview };
  }

  /**
   * Initializes a new import job.
   */
  async createImportJob(workspaceId: string, targetEntityType: string, filename: string): Promise<ImportJob> {
    const id = `imp_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).insert("tab_import_jobs", {
      id,
      target_entity_type: targetEntityType,
      filename,
      status: "pending",
      total_rows: 0,
      processed_rows: 0,
      error_count: 0,
      created_at: now,
    });

    return {
      id,
      workspace_id: workspaceId,
      target_entity_type: targetEntityType,
      filename,
      status: "pending",
      total_rows: 0,
      processed_rows: 0,
      error_count: 0,
      mapping_config: null,
      error_log: [],
      created_at: now,
      completed_at: null,
    };
  }

  /**
   * Validates and processes CSV against the specified field mappings.
   */
  async executeImport(
    workspaceId: string,
    jobId: string,
    csvText: string,
    mappings: FieldMapping[],
  ): Promise<{
    ok: boolean;
    job: ImportJob;
    records: Record<string, unknown>[];
    errors: ImportError[];
  }> {
    // The job must belong to the caller's workspace before any row is processed or any write is attempted.
    if (!(await this.getImportJob(workspaceId, jobId))) {
      throw new ImportJobNotFoundError(jobId);
    }

    const parsed = parseCsv(csvText);
    if (parsed.length === 0) {
      throw new Error("CSV contains no rows");
    }

    // parsed is not empty (checked above), so the default is never used.
    const [headerRow = []] = parsed;
    const headers = headerRow.map((h) => h.trim());
    const headerIndices = new Map<string, number>();
    headers.forEach((h, idx) => headerIndices.set(h, idx));

    const dataRows = parsed.slice(1);
    const totalRows = dataRows.length;
    const errors: ImportError[] = [];
    const records: Record<string, unknown>[] = [];

    dataRows.forEach((row, rowIdx) => {
      const rowNum = rowIdx + 2; // 1-based, skipping header
      const record: Record<string, unknown> = {};
      let rowValid = true;

      for (const m of mappings) {
        const colIdx = headerIndices.get(m.csvColumn);
        const rawVal = colIdx !== undefined && row[colIdx] !== undefined ? row[colIdx].trim() : "";

        if (m.required && (!rawVal || rawVal.length === 0)) {
          errors.push({
            row: rowNum,
            column: m.csvColumn,
            value: rawVal,
            message: `Required field '${m.targetField}' is empty`,
          });
          rowValid = false;
          continue;
        }

        if (!rawVal) {
          record[m.targetField] = null;
          continue;
        }

        // Type Coercion
        if (m.type === "number") {
          const num = Number(rawVal);
          if (isNaN(num)) {
            errors.push({
              row: rowNum,
              column: m.csvColumn,
              value: rawVal,
              message: `Value '${rawVal}' is not a valid number`,
            });
            rowValid = false;
          } else {
            record[m.targetField] = num;
          }
        } else if (m.type === "boolean") {
          const lower = rawVal.toLowerCase();
          if (["true", "1", "yes", "y"].includes(lower)) {
            record[m.targetField] = true;
          } else if (["false", "0", "no", "n"].includes(lower)) {
            record[m.targetField] = false;
          } else {
            errors.push({
              row: rowNum,
              column: m.csvColumn,
              value: rawVal,
              message: `Value '${rawVal}' is not a valid boolean`,
            });
            rowValid = false;
          }
        } else if (m.type === "date") {
          const timestamp = Date.parse(rawVal);
          if (isNaN(timestamp)) {
            errors.push({
              row: rowNum,
              column: m.csvColumn,
              value: rawVal,
              message: `Value '${rawVal}' is not a valid date`,
            });
            rowValid = false;
          } else {
            record[m.targetField] = new Date(timestamp).toISOString();
          }
        } else {
          record[m.targetField] = rawVal;
        }
      }

      if (rowValid) {
        records.push(record);
      }
    });

    const status = records.length > 0 ? "completed" : "failed";
    const now = new Date().toISOString();
    const storedErrors = errors.slice(0, 50); // Cap stored error array to fit D1 bound

    await scoped(this.db, workspaceId).update(
      "tab_import_jobs",
      {
        status,
        total_rows: totalRows,
        processed_rows: records.length,
        error_count: errors.length,
        mapping_config_json: JSON.stringify(mappings),
        error_log_json: JSON.stringify(storedErrors),
        completed_at: now,
      },
      "id = ?",
      [jobId],
    );

    const job = await this.getImportJob(workspaceId, jobId);
    if (!job) throw new Error("Failed to retrieve updated job");

    return {
      ok: status === "completed",
      job,
      records,
      errors,
    };
  }

  /**
   * Retrieves an import job by ID, in the given workspace only: another workspace's job id is "not found".
   */
  async getImportJob(workspaceId: string, jobId: string): Promise<ImportJob | null> {
    interface RawJob {
      id: string;
      workspace_id: string;
      target_entity_type: string;
      filename: string;
      status: ImportJob["status"];
      total_rows: number;
      processed_rows: number;
      error_count: number;
      mapping_config_json: string | null;
      error_log_json: string | null;
      created_at: string;
      completed_at: string | null;
    }

    const row = await scoped(this.db, workspaceId).first<RawJob>("tab_import_jobs", "id = ?", [jobId]);

    if (!row) return null;

    return {
      ...row,
      mapping_config: row.mapping_config_json ? JSON.parse(row.mapping_config_json) : null,
      error_log: row.error_log_json ? JSON.parse(row.error_log_json) : [],
    };
  }

  /**
   * Creates a saved grid view for dynamic entities.
   */
  async createGridView(
    workspaceId: string,
    entityType: string,
    name: string,
    columns: GridView["columns"],
    filters: GridView["filters"] = [],
    sort: GridView["sort"] = [],
  ): Promise<GridView> {
    const id = `grid_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).insert("tab_grid_views", {
      id,
      name: name.trim(),
      entity_type: entityType.trim(),
      columns_json: JSON.stringify(columns),
      filters_json: JSON.stringify(filters),
      sort_json: JSON.stringify(sort),
      created_at: now,
      updated_at: now,
    });

    return {
      id,
      workspace_id: workspaceId,
      name: name.trim(),
      entity_type: entityType.trim(),
      columns,
      filters,
      sort,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Lists grid views for a workspace and entity type.
   */
  async listGridViews(workspaceId: string, entityType?: string): Promise<GridView[]> {
    interface RawGrid {
      id: string;
      workspace_id: string;
      name: string;
      entity_type: string;
      columns_json: string;
      filters_json: string;
      sort_json: string;
      created_at: string;
      updated_at: string;
    }

    const rows = await scoped(this.db, workspaceId).select<RawGrid>(
      "tab_grid_views",
      entityType ? "entity_type = ?" : undefined,
      entityType ? [entityType] : [],
      { orderBy: "name ASC" },
    );

    return rows.map((r) => ({
      ...r,
      columns: JSON.parse(r.columns_json || "[]"),
      filters: JSON.parse(r.filters_json || "[]"),
      sort: JSON.parse(r.sort_json || "[]"),
    }));
  }
}
