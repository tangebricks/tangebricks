import { FIDELITY_CODES } from "@poc/assembler";
import { escapeJsonPointer } from "./report.ts";
import { backfillDiscoveryPathParams, extractDiscoveryParams } from "./discovery-params.ts";
import type { DiscoveryMethodContext } from "./discovery-params.ts";
import { extractDiscoveryBody } from "./discovery-body.ts";
import { reportDiscoveryAuth } from "./discovery-auth.ts";
import type { ReportCollector } from "./report.ts";
import { isPlainObject, sanitizeOperationId, truncateText } from "./util.ts";
import { extractDiscoveryResponse } from "./response.ts";
import type { CurationConfig } from "./curation.ts";
import type { IntegrationAuthDefinition, IntegrationOperation, IntegrationPagination } from "@poc/assembler";
export function extractGoogleDiscoveryOperations(
  discoveryDoc: Record<string, unknown>,
  report?: ReportCollector,
  curationAuth?: IntegrationAuthDefinition | string,
  curation?: CurationConfig,
): Map<string, IntegrationOperation> {
  const operations = new Map<string, IntegrationOperation>();

  const collectFromDoc = (doc: Record<string, unknown>) => {
    const servicePath = typeof doc.servicePath === "string" ? doc.servicePath.replace(/^\/+|\/+$/g, "") : "";

    const visitResources = (resourcesObj: unknown) => {
      if (!isPlainObject(resourcesObj)) return;
      for (const [, resourceVal] of Object.entries(resourcesObj)) {
        if (!isPlainObject(resourceVal)) continue;

        if (isPlainObject(resourceVal.methods)) {
          for (const [methodKey, methodVal] of Object.entries(resourceVal.methods)) {
            if (!isPlainObject(methodVal)) continue;

            const rawId = typeof methodVal.id === "string" && methodVal.id.trim().length > 0 ? methodVal.id : methodKey;
            const baseCleanOpId = sanitizeOperationId(rawId);
            const methodIdStr = typeof methodVal.id === "string" ? methodVal.id : baseCleanOpId;
            const opPointer = `#/methods/${escapeJsonPointer(methodIdStr)}`;
            let operationId = baseCleanOpId;

            const httpMethodRaw = typeof methodVal.httpMethod === "string" ? methodVal.httpMethod.toUpperCase() : "GET";
            const method: IntegrationOperation["method"] =
              httpMethodRaw === "POST" || httpMethodRaw === "PUT" || httpMethodRaw === "PATCH" || httpMethodRaw === "DELETE" ? httpMethodRaw : "GET";

            if (operations.has(operationId)) {
              let candidate = `${baseCleanOpId}__${method.toLowerCase()}`;
              if (operations.has(candidate)) {
                let counter = 2;
                while (operations.has(`${baseCleanOpId}__${method.toLowerCase()}__${counter}`)) {
                  counter++;
                }
                candidate = `${baseCleanOpId}__${method.toLowerCase()}__${counter}`;
              }
              report?.normalized({
                op: candidate,
                element: "operation",
                code: FIDELITY_CODES.OPERATION_ID_COLLISION.code,
                pointer: opPointer,
                from: rawId,
                to: candidate,
                blocking: false,
              });
              operationId = candidate;
            }

            const rawFlatPath =
              typeof methodVal.flatPath === "string" && methodVal.flatPath.trim()
                ? methodVal.flatPath.trim()
                : typeof methodVal.path === "string"
                  ? methodVal.path.trim()
                  : "";

            // Track Google Discovery `{+param}` reserved expansion syntax
            const reservedPathParams = new Set<string>();
            if (rawFlatPath.includes("{+")) {
              for (const match of rawFlatPath.matchAll(/\{\+([A-Za-z0-9_]+)\}/g)) {
                if (match[1]) reservedPathParams.add(match[1]);
              }
            }

            const cleanedRelPath = rawFlatPath.replace(/^\//, "").replace(/\{\+([A-Za-z0-9_]+)\}/g, "{$1}");
            const fullPath = servicePath ? `/${servicePath}/${cleanedRelPath}`.replace(/\/+/g, "/") : `/${cleanedRelPath}`.replace(/\/+/g, "/");

            const ctx: DiscoveryMethodContext = { report, operationId, methodIdStr };
            const { params, usedCleanNames } = extractDiscoveryParams(ctx, methodVal, reservedPathParams);
            backfillDiscoveryPathParams(ctx, fullPath, params, usedCleanNames, reservedPathParams);
            const body = extractDiscoveryBody(ctx, doc, methodVal, method, usedCleanNames);

            const label = truncateText(methodVal.summary ?? methodVal.description, 45) ?? operationId;
            const summary = truncateText(methodVal.description ?? methodVal.summary, 100) ?? label;

            let autoPagination: IntegrationPagination | undefined = undefined;
            const hasPageTokenParam =
              params.some((p) => p.name === "pageToken") || (isPlainObject(methodVal.parameters) && Boolean(methodVal.parameters.pageToken));

            let hasNextPageToken = false;
            let responseArrayProp: string | undefined = undefined;
            if (isPlainObject(methodVal.response) && typeof methodVal.response.$ref === "string") {
              const schemaObj = (doc.schemas as any)?.[methodVal.response.$ref];
              if (isPlainObject(schemaObj) && isPlainObject(schemaObj.properties)) {
                if (schemaObj.properties.nextPageToken) {
                  hasNextPageToken = true;
                }
                for (const [propName, propDef] of Object.entries(schemaObj.properties)) {
                  if (isPlainObject(propDef) && propDef.type === "array") {
                    if (!responseArrayProp || propName === "items" || propName === "messages") {
                      responseArrayProp = propName;
                    }
                  }
                }
              }
            }

            if (hasPageTokenParam && hasNextPageToken) {
              autoPagination = {
                style: "cursor",
                paramName: "pageToken",
                nextCursorPath: "nextPageToken",
                responsePath: responseArrayProp || "items",
                maxPages: 5,
              };
              report?.mapped({
                op: operationId,
                element: "pagination",
                code: FIDELITY_CODES.PAGINATION_MAPPED.code,
                pointer: `#/methods/${escapeJsonPointer(methodIdStr)}/parameters/pageToken`,
                to: autoPagination,
                blocking: false,
              });
            }

            const opCuration = (curation?.operations as any)?.[operationId] ?? (curation?.operations as any)?.[baseCleanOpId];
            const hasPredicate = Boolean(curation?.errorWhen || curation?.successWhen || opCuration?.errorWhen || opCuration?.successWhen);
            const hasPagination = Boolean(autoPagination || opCuration?.pagination);

            const discoveryResponse = extractDiscoveryResponse(
              doc,
              methodVal.response,
              operationId,
              `#/methods/${escapeJsonPointer(methodIdStr)}/response`,
              report,
              hasPredicate,
              hasPagination,
            );

            const scopes = reportDiscoveryAuth(ctx, methodVal, curationAuth);

            report?.mapped({
              op: operationId,
              element: "operation",
              code: FIDELITY_CODES.OPERATION_MAPPED.code,
              pointer: `#/methods/${escapeJsonPointer(methodIdStr)}`,
              blocking: false,
            });

            operations.set(operationId, {
              operationId,
              label,
              summary,
              method,
              path: fullPath,
              ...(scopes.length > 0 ? { security: [[{ scheme: "oauth2", scopes }]] } : {}),
              ...(params.length > 0 ? { params } : {}),
              ...(body ? { body } : {}),
              response: discoveryResponse,
              ...(autoPagination ? { pagination: autoPagination } : {}),
              sideEffects: method === "GET" ? "read" : "write",
            });

            const mediaUpload = isPlainObject(methodVal.mediaUpload) ? (methodVal.mediaUpload as Record<string, unknown>) : undefined;
            const uploadProtocols = isPlainObject(mediaUpload?.protocols) ? (mediaUpload!.protocols as Record<string, unknown>) : undefined;
            const hasProtocols =
              (isPlainObject(uploadProtocols?.simple) && typeof (uploadProtocols!.simple as Record<string, unknown>).path === "string") ||
              (isPlainObject(uploadProtocols?.multipart) && typeof (uploadProtocols!.multipart as Record<string, unknown>).path === "string");

            if (hasProtocols) {
              let uploadPath =
                (isPlainObject(uploadProtocols?.simple) && (uploadProtocols!.simple as any).path) ||
                (isPlainObject(uploadProtocols?.multipart) && (uploadProtocols!.multipart as any).path);
              if (!uploadPath.startsWith("/")) uploadPath = `/${uploadPath}`;

              const uploadOpId = `${operationId}_upload`;
              report?.normalized({
                op: uploadOpId,
                element: "operation",
                code: FIDELITY_CODES.MEDIA_UPLOAD_VARIANT.code,
                pointer: `#/methods/${escapeJsonPointer(methodIdStr)}/supportsMediaUpload`,
                from: rawId,
                to: uploadOpId,
                blocking: false,
              });

              operations.set(uploadOpId, {
                operationId: uploadOpId,
                label: truncateText(`${label} (Upload)`, 45) ?? uploadOpId,
                summary: truncateText(summary, 100) ?? label,
                method,
                path: uploadPath,
                ...(scopes.length > 0 ? { security: [[{ scheme: "oauth2", scopes }]] } : {}),
                ...(params.length > 0 ? { params } : {}),
                body: {
                  contentType: "multipart/related",
                  fields: [
                    {
                      name: "metadata",
                      dataType: "object",
                      required: false,
                      description: "JSON metadata for the file",
                    },
                    {
                      name: "media",
                      dataType: "any",
                      binary: true,
                      required: true,
                      description: "Binary media payload",
                    },
                  ],
                },
                response: discoveryResponse,
                sideEffects: "write",
              });
            } else if (methodVal.supportsMediaUpload || methodVal.mediaUpload) {
              report?.unsupported({
                op: operationId,
                element: "operation",
                code: FIDELITY_CODES.MEDIA_UPLOAD_UNSUPPORTED.code,
                pointer: `#/methods/${escapeJsonPointer(methodIdStr)}/supportsMediaUpload`,
                blocking: false,
              });
            }
          }
        }

        if (isPlainObject(resourceVal.resources)) {
          visitResources(resourceVal.resources);
        }
      }
    };

    visitResources(doc.resources);
  };

  if (Array.isArray(discoveryDoc.apis)) {
    for (const subDoc of discoveryDoc.apis) {
      if (isPlainObject(subDoc)) {
        collectFromDoc({
          ...subDoc,
          schemas: {
            ...(isPlainObject(discoveryDoc.schemas) ? discoveryDoc.schemas : {}),
            ...(isPlainObject(subDoc.schemas) ? subDoc.schemas : {}),
          },
        });
      }
    }
  } else {
    collectFromDoc(discoveryDoc);
  }

  return operations;
}
