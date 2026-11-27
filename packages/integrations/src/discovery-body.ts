import { FIDELITY_CODES } from "@poc/assembler";
import { escapeJsonPointer } from "./report.ts";
import { mapSchema } from "./schema-map.ts";
import { isPlainObject, resolveJsonPointerRef, sanitizeIdentifier, truncateText } from "./util.ts";
import type { IntegrationOperationBody, IntegrationOperationBodyField } from "@poc/assembler";
import type { DiscoveryMethodContext } from "./discovery-params.ts";

/** Maps the `request` schema of one Discovery method (report codes BODY_*). */
export function extractDiscoveryBody(
  ctx: DiscoveryMethodContext,
  doc: Record<string, unknown>,
  methodVal: Record<string, unknown>,
  method: string,
  usedCleanNames: Set<string>,
): IntegrationOperationBody | undefined {
  const { report, operationId, methodIdStr } = ctx;
  let body: IntegrationOperationBody | undefined;
  if (method !== "GET" && isPlainObject(methodVal.request)) {
    const refName = typeof methodVal.request.$ref === "string" ? methodVal.request.$ref : "";
    const reqSchema = refName ? resolveJsonPointerRef(doc, refName) : methodVal.request;
    const reqPointer = `#/methods/${escapeJsonPointer(methodIdStr)}/request`;

    if (isPlainObject(reqSchema) && isPlainObject(reqSchema.properties)) {
      const allProps = Object.entries(reqSchema.properties);
      if (allProps.length === 0) {
        report?.mapped({
          op: operationId,
          element: "body",
          code: FIDELITY_CODES.BODY_FIELD_MAPPED.code,
          pointer: reqPointer,
          blocking: false,
        });
        return {
          contentType: "application/json",
          root: { dataType: "object" },
        };
      }

      const requiredSet = new Set<string>(Array.isArray(reqSchema.required) ? reqSchema.required.filter((r): r is string => typeof r === "string") : []);

      // Required-first ordering
      const reqProps: [string, unknown][] = [];
      const optProps: [string, unknown][] = [];
      for (const entry of allProps) {
        if (requiredSet.has(entry[0])) {
          reqProps.push(entry);
        } else {
          optProps.push(entry);
        }
      }
      const orderedProps = [...reqProps, ...optProps];

      const fields: IntegrationOperationBodyField[] = [];
      for (const [propName, propVal] of orderedProps) {
        if (!isPlainObject(propVal)) continue;
        const propPointer = `${reqPointer}/properties/${escapeJsonPointer(propName)}`;
        let cleanField = sanitizeIdentifier(propName);
        let fieldWireName: string | undefined = cleanField !== propName ? propName : undefined;

        if (cleanField !== propName) {
          report?.normalized({
            op: operationId,
            element: "bodyField",
            code: FIDELITY_CODES.IDENTIFIER_NORMALIZED.code,
            pointer: propPointer,
            from: propName,
            to: cleanField,
            blocking: false,
          });
        }

        if (usedCleanNames.has(cleanField)) {
          const candidateName = `${cleanField}_body`;
          if (!usedCleanNames.has(candidateName)) {
            fieldWireName = fieldWireName ?? propName;
            report?.normalized({
              op: operationId,
              element: "bodyField",
              code: FIDELITY_CODES.IDENTIFIER_COLLISION_DISAMBIGUATED.code,
              pointer: propPointer,
              from: cleanField,
              to: candidateName,
              blocking: false,
            });
            cleanField = candidateName;
            usedCleanNames.add(cleanField);
          } else {
            report?.unsupported({
              op: operationId,
              element: "bodyField",
              code: FIDELITY_CODES.IDENTIFIER_COLLISION.code,
              pointer: propPointer,
              from: cleanField,
              reason: `Collision for identifier "${cleanField}" could not be disambiguated`,
              blocking: true,
            });
            usedCleanNames.add(cleanField);
          }
        } else {
          usedCleanNames.add(cleanField);
        }

        const desc = truncateText(propVal.description, 50);
        const fieldSchema = mapSchema(doc, propVal, {
          pointer: propPointer,
          onLoss: (code) => {
            if (code === "SCHEMA_DEPTH_LIMIT" || code === "SCHEMA_NODE_LIMIT") {
              report?.approximated({
                op: operationId,
                element: "bodyField",
                code: code === "SCHEMA_DEPTH_LIMIT" ? FIDELITY_CODES.SCHEMA_DEPTH_LIMIT.code : FIDELITY_CODES.SCHEMA_NODE_LIMIT.code,
                pointer: propPointer,
                blocking: false,
              });
            }
          },
        });

        report?.mapped({
          op: operationId,
          element: "bodyField",
          code: FIDELITY_CODES.BODY_FIELD_MAPPED.code,
          pointer: propPointer,
          blocking: false,
        });

        fields.push({
          name: cleanField,
          ...(fieldWireName !== undefined ? { wireName: fieldWireName } : {}),
          dataType: fieldSchema.dataType,
          ...(requiredSet.has(propName) ? { required: true } : {}),
          ...(desc ? { description: desc } : {}),
          schema: fieldSchema,
        });
      }

      if (fields.length > 0) {
        body = {
          contentType: "application/json",
          fields,
        };
      }
    }
  }
  return body;
}
