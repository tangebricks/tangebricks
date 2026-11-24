import { FIDELITY_CODES } from "@poc/assembler";
import {
  IntegrationManifestSchema,
  extractAuthConnectionFields,
  formatIssues,
  projectIntegrationToNodes,
} from "@poc/assembler";
import { computeFidelity, ReportCollector } from "./report.ts";
import type { ImportReport } from "./report.ts";
import { parseCurationConfig } from "./curation.ts";
import { mergeOperations } from "./merge.ts";
import { applyAcknowledgements } from "./acknowledge.ts";
import type { CurationConfig } from "./curation.ts";
import { computeSpecHash, isPlainObject, parseSpecDocument } from "./util.ts";
import { detectSpecVersion, diffServers } from "./servers.ts";
import { extractSpecSecurity } from "./security.ts";
import { measureIntegrationTokenMetrics } from "./metrics.ts";
import { IMPORTER_VERSION } from "./types.ts";
import type { ImportIntegrationResult, ImportSpecFormat } from "./types.ts";
import { extractOpenApi3Operations } from "./openapi3.ts";
import { extractGoogleDiscoveryOperations } from "./discovery.ts";
import { swagger2ToOpenApi3, translatePointer } from "./swagger2.ts";
export interface ImportIntegrationOptions {
  readonly spec: Record<string, unknown> | string | unknown[];
  readonly format?: ImportSpecFormat;
  readonly curation: CurationConfig;
  readonly mode?: "strict" | "lenient";
  readonly skipOperationCap?: boolean;
}

/**
 * Converts an OpenAPI 3.x or Google Discovery v1 document + curation config into a validated
 * `IntegrationManifestFile`.
 */
export function importIntegrationSpec(
  options: ImportIntegrationOptions,
): ImportIntegrationResult {
  const mode = options.mode ?? "strict";
  const curation = parseCurationConfig(options.curation);

  const specObj =
    typeof options.spec === "string" ? parseSpecDocument(options.spec) : options.spec;

  const detectedVersion = detectSpecVersion(specObj as any);
  const format: ImportSpecFormat =
    options.format ??
    curation.format ??
    (detectedVersion === "swagger2"
      ? "swagger2"
      : isPlainObject(specObj) && "discoveryVersion" in specObj
        ? "google-discovery"
        : "openapi3");

  if (format === "google-discovery" && detectedVersion !== "google-discovery") {
    throw new Error(
      `OPENAPI_IMPORT_FORMAT_MISMATCH: Expected format "google-discovery" but detected "${detectedVersion}"`,
    );
  }
  if (
    format === "openapi3" &&
    detectedVersion !== "openapi3.0" &&
    detectedVersion !== "openapi3.1"
  ) {
    throw new Error(
      `OPENAPI_IMPORT_FORMAT_MISMATCH: Expected format "openapi3" but detected "${detectedVersion}"`,
    );
  }
  if (format === "swagger2" && detectedVersion !== "swagger2") {
    throw new Error(
      `OPENAPI_IMPORT_FORMAT_MISMATCH: Expected format "swagger2" but detected "${detectedVersion}"`,
    );
  }

  const specHash = computeSpecHash(options.spec as any);
  const reportCollector = new ReportCollector();

  let effectiveSpecObj: any = specObj;
  let pointerMap: Map<string, string> | undefined;

  if (detectedVersion === "swagger2") {
    const conversion = swagger2ToOpenApi3(specObj as Record<string, any>);
    effectiveSpecObj = conversion.spec;
    pointerMap = conversion.pointerMap;

    reportCollector.normalized({
      op: null,
      element: "document",
      code: FIDELITY_CODES.SWAGGER2_UPCONVERTED.code,
      pointer: "#/swagger",
      from: "2.0",
      to: "3.0",
      blocking: false,
    });

    for (const ue of conversion.unsupportedEntries) {
      reportCollector.unsupported(ue);
    }
  }

  if (options.curation?.specProvenance === "hand-trimmed") {
    reportCollector.curated({
      op: null,
      element: "document",
      code: FIDELITY_CODES.SPEC_HAND_TRIMMED.code,
      pointer: "curation:#/specProvenance",
      reason: "Spec fixture is hand-trimmed, not upstream",
      blocking: false,
    });
  }

  diffServers({
    spec: effectiveSpecObj,
    format,
    report: reportCollector,
    curation,
  });

  if (curation?.errorWhen) {
    reportCollector.curated({
      op: null,
      element: "response",
      code: FIDELITY_CODES.OVERLAY_ADDED.code,
      pointer: "curation:#/errorWhen",
      to: curation.errorWhen,
      blocking: false,
    });
  }
  if (curation?.successWhen) {
    reportCollector.curated({
      op: null,
      element: "response",
      code: FIDELITY_CODES.OVERLAY_ADDED.code,
      pointer: "curation:#/successWhen",
      to: curation.successWhen,
      blocking: false,
    });
  }

  const extractedMap =
    format === "google-discovery"
      ? extractGoogleDiscoveryOperations(effectiveSpecObj, reportCollector, curation.auth, curation)
      : extractOpenApi3Operations(effectiveSpecObj, reportCollector, curation.auth, curation);

  const { mergedOperations, targetOpIds } = mergeOperations({
    curation,
    format,
    extractedMap,
    reportCollector,
    skipOperationCap: options.skipOperationCap,
  });

  const targetOpIdSet = new Set(targetOpIds);
  const excludedByCuration = Math.max(0, extractedMap.size - targetOpIds.length);
  reportCollector.setExcludedByCuration(excludedByCuration);

  if (pointerMap) {
    reportCollector.applyPointerMap(pointerMap, translatePointer);
  }

  const report = reportCollector.finish(
    curation.app,
    format,
    specHash,
    IMPORTER_VERSION,
    excludedByCuration,
    targetOpIdSet,
  );

  applyAcknowledgements(report, curation, mode);

  const fidelity = computeFidelity(report);
  const { schemes: specSchemes, requirements: specRequirements } = extractSpecSecurity(
    effectiveSpecObj,
    format,
  );

  const draftManifest = {
    manifestVersion: 2 as const,
    kind: "integration" as const,
    app: curation.app,
    version: curation.version ?? "1.0.0",
    ui: curation.ui,
    auth: {
      ...curation.auth,
      ...(Object.keys(specSchemes).length > 0 ? { schemes: specSchemes } : {}),
      ...(specRequirements.length > 0 ? { requirements: specRequirements } : {}),
      connectionFields: extractAuthConnectionFields(curation.auth),
    },
    ...(curation.defaultHeaders ? { defaultHeaders: curation.defaultHeaders } : {}),
    baseUrl: curation.baseUrl,
    allowedHosts: curation.allowedHosts,
    operations: mergedOperations,
    ...(curation.triggers && curation.triggers.length > 0
      ? { triggers: curation.triggers }
      : {}),
    ...(curation.errorWhen ? { errorWhen: curation.errorWhen } : {}),
    ...(curation.successWhen ? { successWhen: curation.successWhen } : {}),
    ...(curation.errorMappings ? { errorMappings: curation.errorMappings } : {}),
    fidelity,
  };

  const parsed = IntegrationManifestSchema.safeParse(draftManifest);
  if (!parsed.success) {
    throw new Error(
      `OPENAPI_IMPORT_SCHEMA_INVALID (${curation.app}):\n  ${formatIssues(parsed.error).join("\n  ")}`,
    );
  }

  const manifest = parsed.data;
  const projectedNodes = projectIntegrationToNodes(manifest);
  const tokenMetrics = measureIntegrationTokenMetrics(manifest);

  return {
    manifest,
    projectedNodes,
    tokenMetrics,
    report,
  };
}

/**
 * Classifies every operation in the spec with no 30-op cap and no curation,
 * for use by the corpus fidelity harness.
 */
export function analyzeSpec(options: {
  readonly spec: Record<string, unknown> | string | unknown[];
  readonly format: ImportSpecFormat | "swagger2";
  readonly appName?: string;
  readonly curation?: CurationConfig;
}): ImportReport {
  const reportCollector = new ReportCollector();
  const format = options.format === "swagger2" ? "openapi3" : options.format;
  const specObj =
    typeof options.spec === "string"
      ? parseSpecDocument(options.spec)
      : Array.isArray(options.spec)
        ? { apis: options.spec }
        : (options.spec as Record<string, unknown>);

  const detectedVersion = detectSpecVersion(specObj);
  if (options.format === "google-discovery" && detectedVersion !== "google-discovery") {
    throw new Error(
      `OPENAPI_IMPORT_FORMAT_MISMATCH: Expected format "google-discovery" but detected "${detectedVersion}"`,
    );
  }
  if (options.format === "swagger2" && detectedVersion !== "swagger2") {
    throw new Error(
      `OPENAPI_IMPORT_FORMAT_MISMATCH: Expected format "swagger2" but detected "${detectedVersion}"`,
    );
  }
  if (
    options.format === "openapi3" &&
    detectedVersion !== "openapi3.0" &&
    detectedVersion !== "openapi3.1"
  ) {
    throw new Error(
      `OPENAPI_IMPORT_FORMAT_MISMATCH: Expected format "openapi3" but detected "${detectedVersion}"`,
    );
  }

  let effectiveSpecObj: any = specObj;
  let pointerMap: Map<string, string> | undefined;

  if (detectedVersion === "swagger2") {
    const conversion = swagger2ToOpenApi3(specObj as Record<string, any>);
    effectiveSpecObj = conversion.spec;
    pointerMap = conversion.pointerMap;

    reportCollector.normalized({
      op: null,
      element: "document",
      code: FIDELITY_CODES.SWAGGER2_UPCONVERTED.code,
      pointer: "#/swagger",
      from: "2.0",
      to: "3.0",
      blocking: false,
    });

    for (const ue of conversion.unsupportedEntries) {
      reportCollector.unsupported(ue);
    }
  }

  if (options.curation?.specProvenance === "hand-trimmed") {
    reportCollector.curated({
      op: null,
      element: "document",
      code: FIDELITY_CODES.SPEC_HAND_TRIMMED.code,
      pointer: "curation:#/specProvenance",
      reason: "Spec fixture is hand-trimmed, not upstream",
      blocking: false,
    });
  }

  diffServers({
    spec: effectiveSpecObj,
    format: options.format,
    report: reportCollector,
    curation: options.curation,
  });

  if (options.curation?.errorWhen) {
    reportCollector.curated({
      op: null,
      element: "response",
      code: FIDELITY_CODES.OVERLAY_ADDED.code,
      pointer: "curation:#/errorWhen",
      to: options.curation.errorWhen,
      blocking: false,
    });
  }
  if (options.curation?.successWhen) {
    reportCollector.curated({
      op: null,
      element: "response",
      code: FIDELITY_CODES.OVERLAY_ADDED.code,
      pointer: "curation:#/successWhen",
      to: options.curation.successWhen,
      blocking: false,
    });
  }

  const specHash = computeSpecHash(options.spec);
  const app = options.appName ?? "spec";

  if (format === "google-discovery") {
    extractGoogleDiscoveryOperations(effectiveSpecObj, reportCollector, options.curation?.auth, options.curation);
  } else {
    extractOpenApi3Operations(effectiveSpecObj, reportCollector, options.curation?.auth, options.curation);
  }

  if (pointerMap) {
    reportCollector.applyPointerMap(pointerMap, translatePointer);
  }

  return reportCollector.finish(app, options.format, specHash, IMPORTER_VERSION, 0);
}

// Stable public surface: every symbol that used to be exported from this file.
export { computeFidelity, escapeJsonPointer, ReportCollector } from "./report.ts";
export type {
  ImportReport,
  ImportReportElement,
  ImportReportEntry,
  ImportReportStatus,
} from "./report.ts";
export {
  CurationAcknowledgeSchema,
  CurationConfigSchema,
  CurationOperationOverlaySchema,
  CurationUpstreamSchema,
  parseCurationConfig,
} from "./curation.ts";
export type {
  CurationAcknowledge,
  CurationConfig,
  CurationOperationOverlay,
  CurationUpstream,
} from "./curation.ts";
export { default as YAML } from "yaml";
export { canonicalJson, computeSpecHash, derefObject, parseSpecDocument, sanitizeOperationId, mapSchemaTypeToPortType } from "./util.ts";
export type { DerefResult, SchemaTypeMappingResult } from "./util.ts";
export { detectSpecVersion, diffServers, normalizeUrlForCompare } from "./servers.ts";
export type { DetectedSpecVersion } from "./servers.ts";
export { extractSpecSecurity, hasUnsupportedScheme, parseSecurityRequirements, satisfiesRequirement } from "./security.ts";
export { countO200kTokens, measureIntegrationTokenMetrics } from "./metrics.ts";
export type { ImportTokenMetrics } from "./metrics.ts";
export { IMPORTER_VERSION } from "./types.ts";
export type { ImportIntegrationResult, ImportSpecFormat } from "./types.ts";
export { extractOpenApi3Operations } from "./openapi3.ts";
export { extractGoogleDiscoveryOperations } from "./discovery.ts";
export { swagger2ToOpenApi3, translatePointer } from "./swagger2.ts";
export type { Swagger2ConversionResult, Swagger2UnsupportedEntry } from "./swagger2.ts";
