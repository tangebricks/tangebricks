import { FIDELITY_CODES } from "@poc/assembler";
import { escapeJsonPointer } from "./report.ts";
import type { ReportCollector } from "./report.ts";
import {
  derefObject,
  isPlainObject,
  resolveJsonPointerRef,
  sanitizeOperationId,
  truncateText,
} from "./util.ts";
import { extractSpecSecurity } from "./security.ts";
import { extractOpenApiResponse } from "./response.ts";
import { backfillPathParams, extractOpenApiParams, reportSwagger2Body } from "./openapi3-params.ts";
import type { OpenApiOpContext } from "./openapi3-params.ts";
import { extractOpenApiBody } from "./openapi3-body.ts";
import { reportOpenApiAuth } from "./openapi3-auth.ts";
import type { CurationConfig } from "./curation.ts";
import type { IntegrationAuthDefinition, IntegrationOperation } from "@poc/assembler";
/**
 * Extracts normalized operations from an OpenAPI 3.0 / 3.1 document.
 */
export function extractOpenApi3Operations(
  spec: Record<string, unknown>,
  report?: ReportCollector,
  curationAuth?: IntegrationAuthDefinition | string,
  curation?: CurationConfig,
): Map<string, IntegrationOperation> {
  const operations = new Map<string, IntegrationOperation>();
  const paths = isPlainObject(spec.paths) ? spec.paths : {};
  const { schemes, requirements: rootRequirements } = extractSpecSecurity(spec);
  const ALL_HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;

  for (const [rawPath, pathItemRaw] of Object.entries(paths)) {
    if (!isPlainObject(pathItemRaw)) continue;

    if (typeof pathItemRaw.$ref === "string") {
      const resolved = resolveJsonPointerRef(spec, pathItemRaw.$ref);
      if (!isPlainObject(resolved)) {
        report?.unsupported({
          op: null,
          element: "operation",
          code: FIDELITY_CODES.OPERATION_SKIPPED.code,
          pointer: `#/paths/${escapeJsonPointer(rawPath)}`,
          reason: `Unresolved path-item ref: ${pathItemRaw.$ref}`,
          blocking: false,
        });
      }
    }

    const pathLevelParams = Array.isArray(pathItemRaw.parameters) ? pathItemRaw.parameters : [];

    for (const methodLower of ALL_HTTP_METHODS) {
      const opRaw = pathItemRaw[methodLower];
      if (!isPlainObject(opRaw)) continue;

      const rawOpId =
        typeof opRaw.operationId === "string" && opRaw.operationId.trim().length > 0
          ? opRaw.operationId
          : `${methodLower}_${rawPath.replace(/[^A-Za-z0-9]+/g, "_")}`;
      const baseCleanOpId = sanitizeOperationId(rawOpId);
      const opPointer = `#/paths/${escapeJsonPointer(rawPath)}/${methodLower}`;
      let operationId = baseCleanOpId;

      if (operations.has(operationId)) {
        let candidate = `${baseCleanOpId}__${methodLower}`;
        if (operations.has(candidate)) {
          let counter = 2;
          while (operations.has(`${baseCleanOpId}__${methodLower}__${counter}`)) {
            counter++;
          }
          candidate = `${baseCleanOpId}__${methodLower}__${counter}`;
        }
        report?.normalized({
          op: candidate,
          element: "operation",
          code: FIDELITY_CODES.OPERATION_ID_COLLISION.code,
          pointer: opPointer,
          from: rawOpId,
          to: candidate,
          blocking: false,
        });
        operationId = candidate;
      }

      if (methodLower === "head" || methodLower === "options" || methodLower === "trace") {
        report?.unsupported({
          op: operationId,
          element: "operation",
          code: FIDELITY_CODES.OPERATION_SKIPPED.code,
          pointer: `#/paths/${escapeJsonPointer(rawPath)}/${methodLower}`,
          reason: `${methodLower.toUpperCase()} method unsupported`,
          blocking: false,
        });
        continue;
      }

      const method = methodLower.toUpperCase() as IntegrationOperation["method"];
      const label =
        truncateText(opRaw.summary, 45) ??
        truncateText(opRaw.operationId, 45) ??
        operationId;
      const summary =
        truncateText(opRaw.summary ?? opRaw.description, 100) ?? label;

      const opLevelParams = Array.isArray(opRaw.parameters) ? opRaw.parameters : [];
      const opParamKeys = new Set<string>();
      for (const opParam of opLevelParams) {
        const p = derefObject(spec, opParam).target;
        if (typeof p.name === "string" && typeof p.in === "string") {
          opParamKeys.add(`${p.in}:${p.name}`);
        }
      }

      const rawCombinedParams: Array<{ param: unknown; pointer: string }> = [
        ...pathLevelParams
          .filter((p) => {
            const dereffed = derefObject(spec, p).target;
            const inVal = typeof dereffed.in === "string" ? dereffed.in : "query";
            const nameVal = typeof dereffed.name === "string" ? dereffed.name : "";
            return !opParamKeys.has(`${inVal}:${nameVal}`);
          })
          .map((p, i) => ({
            param: p,
            pointer: `#/paths/${escapeJsonPointer(rawPath)}/parameters/${i}`,
          })),
        ...opLevelParams.map((p, i) => ({
          param: p,
          pointer: `#/paths/${escapeJsonPointer(rawPath)}/${methodLower}/parameters/${i}`,
        })),
      ];

      const seenRawParamKeys = new Set<string>();
      const combinedParams: Array<{ param: unknown; pointer: string }> = [];
      for (const item of rawCombinedParams) {
        const p = derefObject(spec, item.param).target;
        const inVal = typeof p.in === "string" ? p.in : "query";
        const nameVal = typeof p.name === "string" ? p.name : "";
        const key = `${inVal}:${nameVal}`;
        if (seenRawParamKeys.has(key)) continue;
        seenRawParamKeys.add(key);
        combinedParams.push(item);
      }

      const ctx: OpenApiOpContext = { spec, report, operationId, rawPath, methodLower };
      const { params, usedCleanNames, hasSwagger2Body } = extractOpenApiParams(
        ctx,
        combinedParams,
      );
      reportSwagger2Body(ctx, combinedParams, hasSwagger2Body);
      backfillPathParams(ctx, params, usedCleanNames);
      const body = extractOpenApiBody(ctx, opRaw, usedCleanNames);

      const normalizedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

      const opCuration =
        (curation?.operations as any)?.[operationId] ??
        (curation?.operations as any)?.[rawOpId];
      const hasPredicate = Boolean(
        curation?.errorWhen ||
          curation?.successWhen ||
          opCuration?.errorWhen ||
          opCuration?.successWhen,
      );
      const hasPagination = Boolean(opCuration?.pagination);

      const response = extractOpenApiResponse(
        spec,
        opRaw.responses,
        operationId,
        `#/paths/${escapeJsonPointer(rawPath)}/${methodLower}/responses`,
        report,
        hasPredicate,
        hasPagination,
      );

      const opSecurityValue = reportOpenApiAuth(
        ctx,
        opRaw,
        { schemes, requirements: rootRequirements },
        curationAuth,
      );
      report?.mapped({
        op: operationId,
        element: "operation",
        code: FIDELITY_CODES.OPERATION_MAPPED.code,
        pointer: `#/paths/${escapeJsonPointer(rawPath)}/${methodLower}`,
        blocking: false,
      });

      operations.set(operationId, {
        operationId,
        label,
        summary,
        method,
        path: normalizedPath,
        ...(opSecurityValue !== undefined ? { security: opSecurityValue } : {}),
        ...(params.length > 0 ? { params } : {}),
        ...(body ? { body } : {}),
        response,
        sideEffects: method === "GET" ? "read" : "write",
      });
    }
  }

  return operations;
}
