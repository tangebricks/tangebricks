import type { IntegrationManifestFile, ManifestNodeDefinition } from "@poc/assembler";
import type { ImportTokenMetrics } from "./metrics.ts";
import type { ImportReport } from "./report.ts";
export const IMPORTER_VERSION = "2.0.0";

export type ImportSpecFormat = "openapi3" | "google-discovery" | "swagger2";

export interface ImportIntegrationResult {
  readonly manifest: IntegrationManifestFile;
  readonly projectedNodes: ManifestNodeDefinition[];
  readonly tokenMetrics: ImportTokenMetrics;
  readonly report: ImportReport;
}
