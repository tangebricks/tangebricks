import type { IntegrationFidelity } from "@poc/assembler";

export type ImportReportStatus =
  | "mapped"
  | "normalized"
  | "curated"
  | "approximated"
  | "unsupported";

export type ImportReportElement =
  | "document"
  | "operation"
  | "param"
  | "bodyField"
  | "body"
  | "contentType"
  | "response"
  | "auth"
  | "server"
  | "pagination";

export interface ImportReportEntry {
  readonly op: string | null;
  readonly element: ImportReportElement;
  /** RFC 6901 pointer into the source spec, or "curation:#/..." */
  readonly pointer: string;
  readonly status: ImportReportStatus;
  /** Report code matching ^[A-Z][A-Z0-9_]{2,63}$ */
  readonly code: string;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly reason?: string;
  readonly blocking: boolean;
  readonly acknowledged?: { readonly reason: string };
}

export interface ImportReport {
  readonly app: string;
  readonly format: string;
  readonly specHash: string;
  readonly importerVersion: string;
  readonly summary: Record<ImportReportStatus, number>;
  readonly excludedByCuration: number;
  readonly entries: ImportReportEntry[];
}

export function escapeJsonPointer(str: string): string {
  return str.replace(/~/g, "~0").replace(/\//g, "~1");
}

export class ReportCollector {
  private readonly _entries: ImportReportEntry[] = [];
  private _excludedByCuration = 0;

  add(entry: ImportReportEntry): void {
    this._entries.push(entry);
  }

  mapped(entry: Omit<ImportReportEntry, "status">): void {
    this._entries.push({ ...entry, status: "mapped" });
  }

  normalized(entry: Omit<ImportReportEntry, "status">): void {
    this._entries.push({ ...entry, status: "normalized" });
  }

  curated(entry: Omit<ImportReportEntry, "status">): void {
    this._entries.push({ ...entry, status: "curated" });
  }

  approximated(entry: Omit<ImportReportEntry, "status">): void {
    this._entries.push({ ...entry, status: "approximated" });
  }

  unsupported(entry: Omit<ImportReportEntry, "status">): void {
    this._entries.push({ ...entry, status: "unsupported" });
  }

  setExcludedByCuration(count: number): void {
    this._excludedByCuration = count;
  }

  applyPointerMap(
    pointerMap: Map<string, string>,
    translateFn?: (map: Map<string, string>, ptr: string) => string,
  ): void {
    for (let i = 0; i < this._entries.length; i++) {
      const e = this._entries[i]!;
      const translated = translateFn
        ? translateFn(pointerMap, e.pointer)
        : (pointerMap.get(e.pointer) ?? e.pointer);
      if (translated !== e.pointer) {
        this._entries[i] = { ...e, pointer: translated };
      }
    }
  }

  get entries(): readonly ImportReportEntry[] {
    return this._entries;
  }

  finish(
    app: string,
    format: string,
    specHash: string,
    importerVersion: string,
    excludedByCuration = this._excludedByCuration,
    allowedOpIds?: ReadonlySet<string>,
  ): ImportReport {
    const rawList = allowedOpIds
      ? this._entries.filter((e) => e.op === null || allowedOpIds.has(e.op))
      : this._entries;

    // Sort entries deterministically by (op, pointer, code)
    const sorted = [...rawList].sort((a, b) => {
      const opA = a.op ?? "";
      const opB = b.op ?? "";
      if (opA !== opB) return opA.localeCompare(opB);
      if (a.pointer !== b.pointer) return a.pointer.localeCompare(b.pointer);
      return a.code.localeCompare(b.code);
    });

    const summary: Record<ImportReportStatus, number> = {
      mapped: 0,
      normalized: 0,
      curated: 0,
      approximated: 0,
      unsupported: 0,
    };
    for (const entry of sorted) {
      summary[entry.status]++;
    }

    const totalSummary =
      summary.mapped +
      summary.normalized +
      summary.curated +
      summary.approximated +
      summary.unsupported;
    if (totalSummary !== sorted.length) {
      throw new Error(
        `Import report summary sum (${totalSummary}) does not match entries count (${sorted.length})`,
      );
    }

    return {
      app,
      format,
      specHash,
      importerVersion,
      summary,
      excludedByCuration,
      entries: sorted,
    };
  }

  finalize(
    app: string,
    format: string,
    specHash: string,
    importerVersion: string,
    excludedByCuration = this._excludedByCuration,
    allowedOpIds?: ReadonlySet<string>,
  ): ImportReport {
    return this.finish(
      app,
      format,
      specHash,
      importerVersion,
      excludedByCuration,
      allowedOpIds,
    );
  }
}

/**
 * Computes the fidelity level and unsupported projections from an import report.
 * - exact: every entry is mapped or normalized
 * - curated: at least one curated entry and 0 approximated or unsupported
 * - partial: otherwise
 */
export function computeFidelity(report: ImportReport): IntegrationFidelity {
  const hasCurated = report.summary.curated > 0;
  const hasLoss = report.summary.approximated > 0 || report.summary.unsupported > 0;

  let level: "exact" | "curated" | "partial";
  if (!hasLoss && !hasCurated) {
    level = "exact";
  } else if (!hasLoss && hasCurated) {
    level = "curated";
  } else {
    level = "partial";
  }

  const unsupported = report.entries
    .filter((e) => e.status === "approximated" || e.status === "unsupported")
    .map((e) => ({
      op: e.op,
      code: e.code,
      pointer: e.pointer,
      blocking: e.blocking,
    }))
    .slice(0, 500);

  return {
    specHash: report.specHash,
    importerVersion: report.importerVersion,
    level,
    unsupported,
  };
}
