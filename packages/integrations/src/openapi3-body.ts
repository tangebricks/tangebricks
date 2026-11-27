import { FIDELITY_CODES } from "@poc/assembler";
import { escapeJsonPointer } from "./report.ts";
import { mapSchema } from "./schema-map.ts";
import { derefObject, isPlainObject, sanitizeIdentifier, truncateText } from "./util.ts";
import type { IntegrationOperationBody, IntegrationOperationBodyField } from "@poc/assembler";
import type { OpenApiOpContext } from "./openapi3-params.ts";

/** Maps the JSON / form-urlencoded request body of one operation (see report codes BODY_*). */
export function extractOpenApiBody(ctx: OpenApiOpContext, opRaw: Record<string, unknown>, usedCleanNames: Set<string>): IntegrationOperationBody | undefined {
  const { spec, report, operationId, rawPath, methodLower } = ctx;
  let body: IntegrationOperationBody | undefined;
  if (!isPlainObject(opRaw.requestBody)) {
    return undefined;
  }

  const reqBodyPointer = `#/paths/${escapeJsonPointer(rawPath)}/${methodLower}/requestBody`;
  const reqBodyDeref = derefObject(spec, opRaw.requestBody);
  const reqBody = reqBodyDeref.target;
  const content = isPlainObject(reqBody.content) ? reqBody.content : {};
  const cts = Object.keys(content);

  let matchedKey: string | undefined;
  let contentType: IntegrationOperationBody["contentType"] | undefined;

  const jsonKey = cts.find((c) => c === "application/json" || c.endsWith("+json"));
  if (jsonKey) {
    matchedKey = jsonKey;
    contentType = "application/json";
  } else if (cts.includes("application/x-www-form-urlencoded")) {
    matchedKey = "application/x-www-form-urlencoded";
    contentType = "application/x-www-form-urlencoded";
  } else if (cts.includes("multipart/form-data")) {
    matchedKey = "multipart/form-data";
    contentType = "multipart/form-data";
  } else if (cts.includes("multipart/related")) {
    matchedKey = "multipart/related";
    contentType = "multipart/related";
  } else if (cts.includes("application/octet-stream")) {
    matchedKey = "application/octet-stream";
    contentType = "application/octet-stream";
  } else {
    const textKey = cts.find((c) => c.startsWith("text/"));
    if (textKey) {
      matchedKey = textKey;
      contentType = "text/plain";
    }
  }

  if (!matchedKey || !contentType) {
    if (cts.length > 0) {
      report?.unsupported({
        op: operationId,
        element: "contentType",
        code: FIDELITY_CODES.CONTENT_TYPE_UNSUPPORTED.code,
        pointer: `${reqBodyPointer}/content`,
        from: cts,
        to: "application/json",
        blocking: true,
      });
    }
    contentType = "application/json";
    matchedKey = cts[0] ?? "application/json";
  } else if (cts.length > 1) {
    const alternatives = cts.filter((c) => c !== matchedKey);
    report?.mapped({
      op: operationId,
      element: "contentType",
      code: FIDELITY_CODES.CONTENT_TYPE_MAPPED.code,
      pointer: `${reqBodyPointer}/content`,
      from: alternatives,
      to: contentType,
      blocking: false,
    });
  } else if (contentType !== "application/json" && contentType !== "application/x-www-form-urlencoded") {
    report?.mapped({
      op: operationId,
      element: "contentType",
      code: FIDELITY_CODES.CONTENT_TYPE_MAPPED.code,
      pointer: `${reqBodyPointer}/content`,
      from: [matchedKey],
      to: contentType,
      blocking: false,
    });
  }

  const mediaObj: Record<string, unknown> = isPlainObject(content[matchedKey])
    ? (content[matchedKey] as Record<string, unknown>)
    : isPlainObject(Object.values(content)[0])
      ? (Object.values(content)[0] as Record<string, unknown>)
      : {};

  const bodySchemaPointer = `${reqBodyPointer}/content/${escapeJsonPointer(matchedKey)}/schema`;
  const bodySchemaDeref = derefObject(spec, mediaObj.schema);
  let bodySchema = bodySchemaDeref.target;

  // Extract encoding if declared
  let encoding: Record<string, { style: "form" | "deepObject"; explode?: boolean }> | undefined;
  if (isPlainObject(mediaObj.encoding)) {
    const enc: Record<string, { style: "form" | "deepObject"; explode?: boolean }> = {};
    for (const [k, v] of Object.entries(mediaObj.encoding)) {
      if (isPlainObject(v)) {
        const style = v.style === "deepObject" ? "deepObject" : "form";
        const explode = typeof v.explode === "boolean" ? v.explode : undefined;
        enc[k] = { style, ...(explode !== undefined ? { explode } : {}) };
      }
    }
    if (Object.keys(enc).length > 0) {
      encoding = enc;
    }
  }

  // Handle allOf merging
  if (Array.isArray(bodySchema.allOf) && bodySchema.allOf.length > 0) {
    const mergedProps: Record<string, unknown> = {};
    const mergedRequired = new Set<string>();
    let mergedType: string | undefined = typeof bodySchema.type === "string" ? bodySchema.type : undefined;

    for (const sub of bodySchema.allOf) {
      const subDeref = derefObject(spec, sub);
      const s = subDeref.target;
      if (!isPlainObject(s)) continue;
      if (typeof s.type === "string") mergedType = s.type;
      if (Array.isArray(s.required)) {
        for (const r of s.required) {
          if (typeof r === "string") mergedRequired.add(r);
        }
      }
      if (isPlainObject(s.properties)) {
        for (const [k, v] of Object.entries(s.properties)) {
          mergedProps[k] = v;
        }
      }
    }

    bodySchema = {
      ...bodySchema,
      type: mergedType ?? "object",
      properties: mergedProps,
      required: [...mergedRequired],
    };
  }

  // Raw octet-stream body
  if (contentType === "application/octet-stream") {
    report?.mapped({
      op: operationId,
      element: "body",
      code: FIDELITY_CODES.BODY_FIELD_MAPPED.code,
      pointer: bodySchemaPointer,
      blocking: false,
    });
    return {
      contentType: "application/octet-stream",
      root: { dataType: "any" },
    };
  }

  // Raw text body
  if (contentType === "text/plain") {
    report?.mapped({
      op: operationId,
      element: "body",
      code: FIDELITY_CODES.BODY_FIELD_MAPPED.code,
      pointer: bodySchemaPointer,
      blocking: false,
    });
    return {
      contentType: "text/plain",
      root: { dataType: "string" },
    };
  }

  // Top-level array body
  if (bodySchema.type === "array") {
    const rootSchema = mapSchema(spec, bodySchema, {
      pointer: bodySchemaPointer,
      onLoss: (code) => {
        if (code === "SCHEMA_DEPTH_LIMIT" || code === "SCHEMA_NODE_LIMIT") {
          report?.approximated({
            op: operationId,
            element: "body",
            code: code === "SCHEMA_DEPTH_LIMIT" ? FIDELITY_CODES.SCHEMA_DEPTH_LIMIT.code : FIDELITY_CODES.SCHEMA_NODE_LIMIT.code,
            pointer: bodySchemaPointer,
            blocking: false,
          });
        }
      },
    });
    report?.mapped({
      op: operationId,
      element: "body",
      code: FIDELITY_CODES.BODY_FIELD_MAPPED.code,
      pointer: bodySchemaPointer,
      blocking: false,
    });
    return {
      contentType,
      root: { dataType: "array", schema: rootSchema },
    };
  }

  // oneOf / anyOf composed root body
  if ((Array.isArray(bodySchema.oneOf) && bodySchema.oneOf.length > 0) || (Array.isArray(bodySchema.anyOf) && bodySchema.anyOf.length > 0)) {
    const rootSchema = mapSchema(spec, bodySchema, {
      pointer: bodySchemaPointer,
      onLoss: (code) => {
        if (code === "SCHEMA_DEPTH_LIMIT" || code === "SCHEMA_NODE_LIMIT") {
          report?.approximated({
            op: operationId,
            element: "body",
            code: code === "SCHEMA_DEPTH_LIMIT" ? FIDELITY_CODES.SCHEMA_DEPTH_LIMIT.code : FIDELITY_CODES.SCHEMA_NODE_LIMIT.code,
            pointer: bodySchemaPointer,
            blocking: false,
          });
        }
      },
    });
    report?.mapped({
      op: operationId,
      element: "body",
      code: FIDELITY_CODES.BODY_FIELD_MAPPED.code,
      pointer: bodySchemaPointer,
      blocking: false,
    });
    return {
      contentType,
      root: { dataType: "any", schema: rootSchema },
    };
  }

  const props = isPlainObject(bodySchema.properties) ? bodySchema.properties : {};
  const propEntries = Object.entries(props);

  // Free-form body: no properties and additionalProperties !== false, or additionalProperties === true
  if (propEntries.length === 0 && cts.length > 0 && bodySchema.additionalProperties !== false) {
    report?.mapped({
      op: operationId,
      element: "body",
      code: FIDELITY_CODES.BODY_FIELD_MAPPED.code,
      pointer: bodySchemaPointer,
      blocking: false,
    });
    return {
      contentType,
      root: { dataType: "object" },
    };
  }

  const requiredSet = new Set<string>(Array.isArray(bodySchema.required) ? bodySchema.required.filter((r): r is string => typeof r === "string") : []);

  // Order required-first, keeping spec order within each group
  const reqProps: [string, unknown][] = [];
  const optProps: [string, unknown][] = [];
  for (const entry of propEntries) {
    if (requiredSet.has(entry[0])) {
      reqProps.push(entry);
    } else {
      optProps.push(entry);
    }
  }
  const orderedProps = [...reqProps, ...optProps];

  const fields: IntegrationOperationBodyField[] = [];
  for (const [propName, propRaw] of orderedProps) {
    const propPointer = `${bodySchemaPointer}/properties/${escapeJsonPointer(propName)}`;
    const propDeref = derefObject(spec, propRaw);
    const propSchema = propDeref.target;
    let cleanFieldName = sanitizeIdentifier(propName);
    let fieldWireName: string | undefined = cleanFieldName !== propName ? propName : undefined;

    if (cleanFieldName !== propName) {
      report?.normalized({
        op: operationId,
        element: "bodyField",
        code: FIDELITY_CODES.IDENTIFIER_NORMALIZED.code,
        pointer: propPointer,
        from: propName,
        to: cleanFieldName,
        blocking: false,
      });
    }

    if (usedCleanNames.has(cleanFieldName)) {
      const candidateName = `${cleanFieldName}_body`;
      if (!usedCleanNames.has(candidateName)) {
        fieldWireName = fieldWireName ?? propName;
        report?.normalized({
          op: operationId,
          element: "bodyField",
          code: FIDELITY_CODES.IDENTIFIER_COLLISION_DISAMBIGUATED.code,
          pointer: propPointer,
          from: cleanFieldName,
          to: candidateName,
          blocking: false,
        });
        cleanFieldName = candidateName;
        usedCleanNames.add(cleanFieldName);
      } else {
        report?.unsupported({
          op: operationId,
          element: "bodyField",
          code: FIDELITY_CODES.IDENTIFIER_COLLISION.code,
          pointer: propPointer,
          from: cleanFieldName,
          reason: `Collision for identifier "${cleanFieldName}" could not be disambiguated`,
          blocking: true,
        });
        usedCleanNames.add(cleanFieldName);
      }
    } else {
      usedCleanNames.add(cleanFieldName);
    }

    const desc = truncateText(propSchema.description, 50);
    const fieldSchema = mapSchema(spec, propRaw, {
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

    const isBinary = propSchema.format === "binary" || (isPlainObject(propRaw) && (propRaw as Record<string, unknown>).format === "binary");

    fields.push({
      name: cleanFieldName,
      ...(fieldWireName !== undefined ? { wireName: fieldWireName } : {}),
      dataType: isBinary ? "any" : fieldSchema.dataType,
      ...(requiredSet.has(propName) ? { required: true } : {}),
      ...(desc ? { description: desc } : {}),
      ...(isBinary ? { binary: true } : {}),
      schema: fieldSchema,
    });
  }

  if (fields.length > 0) {
    body = {
      contentType,
      fields,
      ...(encoding ? { encoding } : {}),
    };
  }

  return body;
}
