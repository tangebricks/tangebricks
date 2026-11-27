import type { CurationConfig } from "../importer.ts";
import { importIntegrationSpec, swagger2ToOpenApi3 } from "../importer.ts";
import { NON_STRUCTURAL_CLASSES, type DefectClass } from "./classes.ts";
import { isObject } from "./measure-util.ts";
import type { MeasureContext } from "./measure-types.ts";
import { measureOpenApiOps } from "./measure-openapi.ts";
import { measureDiscoveryOps } from "./measure-discovery.ts";

export type FidelitySpecFormat = "openapi3" | "swagger2" | "google-discovery";

export interface FidelityReport {
  readonly specOps: number;
  readonly extractedOps: number;
  readonly importableOps: number;
  readonly opsWithStructuralDefect: number;
  readonly classes: Record<DefectClass, number>;
  readonly examples: Record<DefectClass, { readonly op: string; readonly [key: string]: unknown }>;
  readonly classOps?: Record<DefectClass, string[]>;
  readonly failedOps?: number;
  readonly fails?: Record<string, number>;
  readonly notes?: string[];
}

export interface MeasureOptions {
  readonly curation?: CurationConfig;
  readonly appName?: string;
  readonly allFields?: boolean;
}

/**
 * Measures an OpenAPI 3, Swagger 2, or Google Discovery specification against
 * known importer defect classes and computes defect and importability statistics.
 */
export function measureSpecFidelity(spec: unknown, format: FidelitySpecFormat, options?: MeasureOptions): FidelityReport {
  const classes: Partial<Record<DefectClass, Set<string>>> = {};
  const examples: Partial<Record<DefectClass, { op: string; [key: string]: unknown }>> = {};

  const flag = (c: DefectClass, opId: string, detail?: Record<string, unknown>) => {
    (classes[c] ??= new Set<string>()).add(opId);
    if (!examples[c]) {
      examples[c] = { op: opId, ...detail };
    }
  };

  const notes: string[] = [];

  const rawDocs: any[] =
    format === "google-discovery" ? (Array.isArray(spec) ? spec : isObject(spec) && Array.isArray((spec as any).apis) ? (spec as any).apis : [spec]) : [];

  const isSwagger = format === "swagger2" || (spec as any)?.swagger === "2.0";
  const spec0 = format === "google-discovery" ? rawDocs[0] : isSwagger ? swagger2ToOpenApi3(spec as any).spec : (spec as any);

  const ctx: MeasureContext = { flag, notes, spec0, rawDocs, options };
  const measured = format === "openapi3" || format === "swagger2" ? measureOpenApiOps(ctx) : measureDiscoveryOps(ctx);
  const extracted = measured.extracted;
  const specOps = measured.specOps;

  // Server & baseUrl mismatch check
  if (options?.curation?.baseUrl) {
    let specUrl = "";
    if (format === "google-discovery") {
      const d = rawDocs[0];
      if (d && typeof d.rootUrl === "string" && typeof d.servicePath === "string") {
        specUrl = `${d.rootUrl.replace(/\/+$/, "")}/${d.servicePath.replace(/^\/+/, "")}`.replace(/\/+$/, "");
      }
    } else if (format === "swagger2") {
      const s = spec0 as Record<string, unknown>;
      const host = typeof s.host === "string" ? s.host : "";
      const basePath = typeof s.basePath === "string" ? s.basePath : "";
      const schemes = Array.isArray(s.schemes) && s.schemes.length > 0 ? s.schemes : ["https"];
      if (host) {
        specUrl = `${schemes[0] ?? "https"}://${host}${basePath.startsWith("/") ? "" : "/"}${basePath}`.replace(/\/+$/, "");
      }
    } else {
      const s = spec0 as Record<string, unknown>;
      if (Array.isArray(s.servers) && s.servers.length > 0 && typeof s.servers[0]?.url === "string") {
        specUrl = s.servers[0].url.replace(/\/+$/, "");
      }
    }

    if (specUrl) {
      const norm = (u: string) => {
        try {
          const parsed = new URL(u);
          return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
        } catch {
          return u.replace(/\/+$/, "");
        }
      };
      if (norm(specUrl) !== norm(options.curation.baseUrl)) {
        for (const opKey of extracted.keys()) {
          flag("server_baseurl_mismatch", opKey, {
            specUrl,
            curationUrl: options.curation.baseUrl,
          });
        }
      }
    }
  }

  // Calculate union of ops with structural defects (excluding non-structural classes)
  const union = new Set<string>();
  for (const [c, s] of Object.entries(classes) as [DefectClass, Set<string>][]) {
    if (!NON_STRUCTURAL_CLASSES.has(c)) {
      for (const k of s) {
        union.add(k);
      }
    }
  }

  const importFormat = format;
  const cur: CurationConfig = options?.curation ?? {
    app: options?.appName ?? "spec",
    version: "1.0.0",
    format: importFormat,
    specProvenance: "upstream",
    baseUrl: "https://api.example.com",
    allowedHosts: ["api.example.com"],
    ui: {
      displayName: options?.appName ?? "Spec",
      category: "developer",
      icon: "spec",
      docsUrl: "https://example.com/docs",
      summary: "Spec integration",
      maturity: "experimental",
      maturityReason: "Fidelity test harness",
    },
    auth: {
      type: "none",
    },
    defaultRateLimit: {
      maxRetries: 3,
      initialBackoffMs: 200,
      respectRetryAfter: true,
      retryAfterHeader: "Retry-After",
    },
    operations: [],
  };

  const specArg = format === "google-discovery" ? { apis: rawDocs } : (spec as any);
  let importableOps = 0;
  let failedOps = 0;
  const fails: Record<string, number> = {};

  for (const opId of extracted.keys()) {
    // Each op is imported alone, so pass only the acknowledgements that can apply to it.
    // Otherwise every other op's acknowledgement is unmatched and throws as stale.
    const acknowledge = cur.acknowledge?.filter((a) => a.op === "*" || a.op === opId);
    try {
      const res = importIntegrationSpec({
        spec: specArg,
        format: importFormat,
        curation: { ...cur, format: importFormat, includeOperations: [opId], acknowledge },
        mode: "lenient",
      });
      if (res && res.manifest) {
        importableOps++;
      }
    } catch (e: any) {
      failedOps++;
      const msg = e instanceof Error ? e.message : String(e);
      const summary = msg.split("\n").slice(0, 2).join(" | ").slice(0, 200);
      fails[summary] = (fails[summary] ?? 0) + 1;
    }
  }

  const sortedClasses: Partial<Record<DefectClass, number>> = {};
  const classOps: Partial<Record<DefectClass, string[]>> = {};
  for (const [c, s] of Object.entries(classes) as [DefectClass, Set<string>][]) {
    sortedClasses[c] = s.size;
    classOps[c] = [...s];
  }

  return {
    specOps,
    extractedOps: extracted.size,
    importableOps,
    opsWithStructuralDefect: union.size,
    classes: sortedClasses as Record<DefectClass, number>,
    examples: examples as Record<DefectClass, { op: string; [key: string]: unknown }>,
    classOps: classOps as Record<DefectClass, string[]>,
    failedOps,
    fails,
    notes,
  };
}
