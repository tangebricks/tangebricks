import { FIDELITY_CODES } from "@poc/assembler";
import type { IntegrationOperation } from "@poc/assembler";
import { escapeJsonPointer } from "./report.ts";
import type { ImportReportElement, ReportCollector } from "./report.ts";
import type { CurationConfig, CurationOperationOverlay } from "./curation.ts";
import { canonicalJson, isPlainObject, sanitizeOperationId } from "./util.ts";

export interface MergeOperationsOptions {
  readonly curation: CurationConfig;
  readonly format: string;
  readonly extractedMap: ReadonlyMap<string, IntegrationOperation>;
  readonly reportCollector: ReportCollector;
  readonly skipOperationCap: boolean | undefined;
}

export interface MergedOperations {
  readonly mergedOperations: IntegrationOperation[];
  readonly targetOpIds: string[];
}

/** Selects the curated operations and applies curation overlays on top of the extracted ones. */
export function mergeOperations(options: MergeOperationsOptions): MergedOperations {
  const { curation, format, extractedMap, reportCollector } = options;
  const overlaysByOpId = new Map<string, { opKey: string; overlay: CurationOperationOverlay }>();
  const orderedOpIds: string[] = [];

  if (Array.isArray(curation.operations)) {
    for (const item of curation.operations) {
      if (item.operationId) {
        const cleanId = sanitizeOperationId(item.operationId);
        overlaysByOpId.set(cleanId, { opKey: item.operationId, overlay: item });
        orderedOpIds.push(cleanId);
      }
    }
  } else if (isPlainObject(curation.operations)) {
    for (const [opKey, overlay] of Object.entries(curation.operations)) {
      const cleanId = sanitizeOperationId(overlay.operationId ?? opKey);
      overlaysByOpId.set(cleanId, { opKey, overlay });
      orderedOpIds.push(cleanId);
    }
  }

  const collisionEntries = reportCollector.entries.filter((e) => e.code === "OPERATION_ID_COLLISION");
  const ambiguousMap = new Map<string, string[]>();
  for (const entry of collisionEntries) {
    const candidateId = entry.to as string;
    const rawId = entry.from as string;
    const baseId = candidateId.replace(/__(?:get|post|put|patch|delete|head|options|trace)(?:__\d+)?$/i, "");
    const list = ambiguousMap.get(baseId) ?? [baseId];
    if (!list.includes(candidateId)) {
      list.push(candidateId);
    }
    ambiguousMap.set(baseId, list);
    ambiguousMap.set(rawId, list);
    ambiguousMap.set(sanitizeOperationId(rawId), list);
  }

  if (Array.isArray(curation.includeOperations)) {
    for (const rawInc of curation.includeOperations) {
      const candidates = ambiguousMap.get(rawInc) ?? ambiguousMap.get(sanitizeOperationId(rawInc));
      if (candidates && candidates.length > 1) {
        throw new Error(
          `OPENAPI_IMPORT_AMBIGUOUS_OPERATION: Curation includeOperations names ambiguous operationId "${rawInc}". Candidate operation IDs: ${candidates.join(", ")}`,
        );
      }
    }
  }

  const targetOpIds =
    Array.isArray(curation.includeOperations) && curation.includeOperations.length > 0
      ? curation.includeOperations.map((id) => sanitizeOperationId(id))
      : orderedOpIds.length > 0
        ? orderedOpIds
        : [...extractedMap.keys()];

  if (targetOpIds.length === 0) {
    throw new Error(
      `OPENAPI_IMPORT_EMPTY_OPERATIONS: Curation for "${curation.app}" resulted in 0 operations (must include 1..30 operations)`,
    );
  }
  if (targetOpIds.length > 30 && !options.skipOperationCap) {
    throw new Error(
      `OPENAPI_IMPORT_TOO_MANY_OPERATIONS: Curation for "${curation.app}" selected ${targetOpIds.length} operations, exceeding the hard cap of 30 operations per integration`,
    );
  }

  const mergedOperations: IntegrationOperation[] = [];
  for (const opId of targetOpIds) {
    const baseOp = extractedMap.get(opId);
    const overlayInfo = overlaysByOpId.get(opId);
    const overlay = overlayInfo?.overlay;
    const opKey = overlayInfo?.opKey ?? opId;

    if (!baseOp && !overlay) {
      throw new Error(
        `OPENAPI_IMPORT_MISSING_OPERATION: Curated operation "${opId}" was not found in ${format} spec for "${curation.app}"`,
      );
    }

    if (!baseOp && overlay) {
      reportCollector.curated({
        op: opId,
        element: "operation",
        code: FIDELITY_CODES.OPERATION_CURATED_ONLY.code,
        pointer: `curation:#/operations/${escapeJsonPointer(opKey)}`,
        reason: `Operation "${opId}" is defined only in curation overlay, not in spec`,
        blocking: false,
      });
    }

    if (baseOp && overlay) {
      if (overlay.method !== undefined && overlay.method.toUpperCase() !== baseOp.method.toUpperCase()) {
        throw new Error(
          `OPENAPI_IMPORT_OVERLAY_CONTRADICTS_SPEC: Curation overlay for operation "${opId}" specifies method "${overlay.method}" which contradicts spec method "${baseOp.method}"`,
        );
      }
      if (overlay.path !== undefined && overlay.path !== baseOp.path) {
        throw new Error(
          `OPENAPI_IMPORT_OVERLAY_CONTRADICTS_SPEC: Curation overlay for operation "${opId}" specifies path "${overlay.path}" which contradicts spec path "${baseOp.path}"`,
        );
      }

      const overlayFields: Array<keyof CurationOperationOverlay> = [
        "params",
        "body",
        "response",
        "pagination",
        "errorWhen",
        "successWhen",
        "rateLimit",
        "idempotency",
        "errorMappings",
        "label",
        "summary",
        "description",
        "sideEffects",
      ];

      for (const k of overlayFields) {
        const overlayVal = overlay[k];
        if (overlayVal === undefined) continue;

        let baseVal: unknown;
        let element: ImportReportElement = "operation";

        if (k === "params") {
          baseVal = baseOp.params;
          element = "param";
        } else if (k === "body") {
          baseVal = baseOp.body;
          element = "body";
        } else if (k === "response") {
          baseVal = baseOp.response;
          element = "response";
        } else if (k === "pagination") {
          baseVal = baseOp.pagination;
          element = "pagination";
        } else if (k === "errorWhen") {
          baseVal = (baseOp as any).errorWhen;
          element = "response";
        } else if (k === "successWhen") {
          baseVal = (baseOp as any).successWhen;
          element = "response";
        } else if (k === "rateLimit") {
          baseVal = baseOp.rateLimit;
          element = "operation";
        } else if (k === "idempotency") {
          baseVal = (baseOp as any).idempotency;
          element = "operation";
        } else if (k === "errorMappings") {
          baseVal = baseOp.errorMappings;
          element = "operation";
        } else if (k === "label") {
          baseVal = baseOp.label;
          element = "operation";
        } else if (k === "summary") {
          baseVal = baseOp.summary;
          element = "operation";
        } else if (k === "description") {
          baseVal = baseOp.description;
          element = "operation";
        } else if (k === "sideEffects") {
          baseVal = baseOp.sideEffects;
          element = "operation";
        }

        const ptr = `curation:#/operations/${escapeJsonPointer(opKey)}/${k}`;

        if (baseVal === undefined || baseVal === null) {
          reportCollector.curated({
            op: opId,
            element,
            code: FIDELITY_CODES.OVERLAY_ADDED.code,
            pointer: ptr,
            to: overlayVal,
            blocking: false,
          });
        } else {
          if (canonicalJson(overlayVal) !== canonicalJson(baseVal)) {
            reportCollector.curated({
              op: opId,
              element,
              code: FIDELITY_CODES.OVERLAY_OVERRIDE.code,
              pointer: ptr,
              from: baseVal,
              to: overlayVal,
              blocking: false,
            });
          }
        }
      }
    }

    const method = overlay?.method ?? baseOp?.method ?? "GET";
    const path = overlay?.path ?? baseOp?.path ?? "/";
    const label = overlay?.label ?? baseOp?.label ?? opId;
    const summary = overlay?.summary ?? baseOp?.summary ?? label;
    const params = overlay?.params ?? baseOp?.params;
    const body = overlay?.body ?? baseOp?.body;
    const response =
      overlay?.response !== undefined
        ? { ...baseOp?.response, ...overlay.response }
        : (baseOp?.response ?? {});
    const pagination = overlay?.pagination ?? baseOp?.pagination;
    const errorWhen = overlay?.errorWhen ?? (baseOp as any)?.errorWhen;
    const successWhen = overlay?.successWhen ?? (baseOp as any)?.successWhen;
    const rateLimit = overlay?.rateLimit ?? baseOp?.rateLimit ?? curation.defaultRateLimit;
    const idempotency = overlay?.idempotency ?? (baseOp as any)?.idempotency;
    const errorMappings = overlay?.errorMappings ?? baseOp?.errorMappings;
    const sideEffects =
      overlay?.sideEffects ?? baseOp?.sideEffects ?? (method === "GET" ? "read" : "write");

    mergedOperations.push({
      operationId: opId,
      label,
      summary,
      ...(overlay?.description ? { description: overlay.description } : {}),
      method,
      path,
      ...(params && params.length > 0 ? { params } : {}),
      ...(body ? { body } : {}),
      response,
      ...(pagination ? { pagination } : {}),
      ...(errorWhen ? { errorWhen } : {}),
      ...(successWhen ? { successWhen } : {}),
      ...(rateLimit ? { rateLimit } : {}),
      ...(idempotency ? { idempotency } : {}),
      ...(errorMappings ? { errorMappings } : {}),
      sideEffects,
    });
  }
  return { mergedOperations, targetOpIds };
}
