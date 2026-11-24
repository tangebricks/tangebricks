import { FIDELITY_CODES } from "@poc/assembler";
import { escapeJsonPointer } from "./report.ts";
import type { ReportCollector } from "./report.ts";
import {
  derefObject,
  mapSchemaTypeToPortType,
  sanitizeIdentifier,
  truncateText,
} from "./util.ts";
import type { IntegrationOperationParam } from "@poc/assembler";

export interface OpenApiOpContext {
  readonly spec: Record<string, unknown>;
  readonly report: ReportCollector | undefined;
  readonly operationId: string;
  readonly rawPath: string;
  readonly methodLower: string;
}

export interface RawParam {
  readonly param: unknown;
  readonly pointer: string;
}

export interface ExtractedParams {
  readonly params: IntegrationOperationParam[];
  readonly usedCleanNames: Set<string>;
  readonly hasSwagger2Body: boolean;
}

/** Maps every path/query/header/cookie parameter of one operation (see report codes PARAM_*). */
export function extractOpenApiParams(
  ctx: OpenApiOpContext,
  combinedParams: RawParam[],
): ExtractedParams {
  const { spec, report, operationId } = ctx;
  const params: IntegrationOperationParam[] = [];
  const usedCleanNames = new Set<string>();
  let hasSwagger2Body = false;

  for (const item of combinedParams) {
    const pRaw = item.param;
    const paramPointer = item.pointer;
    const pDeref = derefObject(spec, pRaw);
    const p = pDeref.target;
    const rawName = typeof p.name === "string" ? p.name : "";
    const rawIn = typeof p.in === "string" ? p.in : "query";

    if (rawIn === "formData" || rawIn === "body") {
      hasSwagger2Body = true;
      report?.unsupported({
        op: operationId,
        element: "param",
        code: FIDELITY_CODES.PARAM_LOCATION_UNSUPPORTED.code,
        pointer: paramPointer,
        from: rawIn,
        blocking: p.required === true,
      });
      continue;
    }

    if (!rawName || (rawIn !== "path" && rawIn !== "query" && rawIn !== "header" && rawIn !== "cookie")) {
      continue;
    }

    let cleanName = sanitizeIdentifier(rawName);
    let wireName: string | undefined = cleanName !== rawName ? rawName : undefined;

    if (cleanName !== rawName) {
      report?.normalized({
        op: operationId,
        element: "param",
        code: FIDELITY_CODES.IDENTIFIER_NORMALIZED.code,
        pointer: paramPointer,
        from: rawName,
        to: cleanName,
        blocking: false,
      });
    }

    if (usedCleanNames.has(cleanName)) {
      const candidateName = `${cleanName}_${rawIn}`;
      if (!usedCleanNames.has(candidateName)) {
        wireName = wireName ?? rawName;
        report?.normalized({
          op: operationId,
          element: "param",
          code: FIDELITY_CODES.IDENTIFIER_COLLISION_DISAMBIGUATED.code,
          pointer: paramPointer,
          from: cleanName,
          to: candidateName,
          blocking: false,
        });
        cleanName = candidateName;
        usedCleanNames.add(cleanName);
      } else {
        report?.unsupported({
          op: operationId,
          element: "param",
          code: FIDELITY_CODES.IDENTIFIER_COLLISION.code,
          pointer: paramPointer,
          from: cleanName,
          reason: `Collision for identifier "${cleanName}" could not be disambiguated`,
          blocking: true,
        });
        usedCleanNames.add(cleanName);
      }
    } else {
      usedCleanNames.add(cleanName);
    }

    const schemaDeref = derefObject(spec, p.schema);
    const schema = schemaDeref.target;
    const mapping = mapSchemaTypeToPortType(schema);
    const desc = truncateText(p.description, 50);

    let paramLoss = false;
    if (pDeref.depthExceeded || schemaDeref.depthExceeded) {
      report?.approximated({
        op: operationId,
        element: "param",
        code: FIDELITY_CODES.REF_DEPTH_EXCEEDED.code,
        pointer: paramPointer,
        blocking: false,
      });
      paramLoss = true;
    }

    const styleVal: any = typeof p.style === "string" ? p.style : undefined;
    const explodeVal: boolean | undefined = typeof p.explode === "boolean" ? p.explode : undefined;

    if (styleVal === "label" || styleVal === "matrix") {
      report?.unsupported({
        op: operationId,
        element: "param",
        code: FIDELITY_CODES.PARAM_STYLE_UNHONOURED.code,
        pointer: paramPointer,
        blocking: true,
      });
      paramLoss = true;
    } else if (
      styleVal === "deepObject" &&
      (schema.type === "array" || mapping.dataType === "array")
    ) {
      report?.normalized({
        op: operationId,
        element: "param",
        code: FIDELITY_CODES.DEEPOBJECT_ARRAY_CONVENTION.code,
        pointer: paramPointer,
        from: rawName,
        to: `${cleanName}[]`,
        blocking: false,
      });
    }

    const rawEnum = Array.isArray(schema.enum)
      ? schema.enum
      : Array.isArray(p.enum)
        ? p.enum
        : undefined;
    let cleanEnum: (string | number | boolean)[] | undefined;
    if (rawEnum) {
      if (rawEnum.length > 256) {
        report?.approximated({
          op: operationId,
          element: "param",
          code: FIDELITY_CODES.PARAM_ENUM_TRUNCATED.code,
          pointer: paramPointer,
          blocking: false,
        });
        paramLoss = true;
        cleanEnum = rawEnum.slice(0, 256);
      } else {
        cleanEnum = rawEnum;
      }
    }

    const rawDefault = schema.default !== undefined ? schema.default : p.default;

    let itemsVal: { dataType: any; enum?: (string | number | boolean)[] } | undefined;
    if (
      (schema.type === "array" || p.type === "array" || mapping.dataType === "array") &&
      (schema.items !== undefined || p.items !== undefined)
    ) {
      const rawItems = schema.items !== undefined ? schema.items : p.items;
      const itemsDeref = derefObject(spec, rawItems);
      const itemsMapping = mapSchemaTypeToPortType(itemsDeref.target);
      const rawItemsEnum = Array.isArray(itemsDeref.target.enum)
        ? itemsDeref.target.enum
        : undefined;
      let itemsEnum: (string | number | boolean)[] | undefined;
      if (rawItemsEnum) {
        if (rawItemsEnum.length > 256) {
          report?.approximated({
            op: operationId,
            element: "param",
            code: FIDELITY_CODES.PARAM_ENUM_TRUNCATED.code,
            pointer: `${paramPointer}/schema/items`,
            blocking: false,
          });
          paramLoss = true;
          itemsEnum = rawItemsEnum.slice(0, 256);
        } else {
          itemsEnum = rawItemsEnum;
        }
      }
      itemsVal = {
        dataType: itemsMapping.dataType,
        ...(itemsEnum !== undefined ? { enum: itemsEnum } : {}),
      };
    }

    const allowReservedVal =
      typeof p.allowReserved === "boolean" ? p.allowReserved : undefined;

    if (mapping.loss === "SCHEMA_COMPOSITION_ERASED") {
      report?.approximated({
        op: operationId,
        element: "param",
        code: FIDELITY_CODES.SCHEMA_COMPOSITION_ERASED.code,
        pointer: paramPointer,
        blocking: false,
      });
      paramLoss = true;
    }

    if (!paramLoss) {
      report?.mapped({
        op: operationId,
        element: "param",
        code: FIDELITY_CODES.PARAM_MAPPED.code,
        pointer: paramPointer,
        blocking: false,
      });
    }

    params.push({
      name: cleanName,
      ...(wireName !== undefined ? { wireName } : {}),
      in: rawIn,
      dataType: mapping.dataType,
      ...(p.required === true || rawIn === "path" ? { required: true } : {}),
      ...(desc ? { description: desc } : {}),
      ...(cleanEnum !== undefined ? { enum: cleanEnum } : {}),
      ...(rawDefault !== undefined ? { default: rawDefault } : {}),
      ...(itemsVal !== undefined ? { items: itemsVal } : {}),
      ...(styleVal !== undefined ? { style: styleVal } : {}),
      ...(explodeVal !== undefined ? { explode: explodeVal } : {}),
      ...(allowReservedVal !== undefined ? { allowReserved: allowReservedVal } : {}),
    });
  }
  return { params, usedCleanNames, hasSwagger2Body };
}

/** Swagger 2 `in: body|formData` parameters are never mapped; report the dropped body. */
export function reportSwagger2Body(
  ctx: OpenApiOpContext,
  combinedParams: RawParam[],
  hasSwagger2Body: boolean,
): void {
  const { spec, report, operationId, rawPath, methodLower } = ctx;
  if (hasSwagger2Body) {
    report?.unsupported({
      op: operationId,
      element: "body",
      code: FIDELITY_CODES.SWAGGER2_BODY_DROPPED.code,
      pointer: `#/paths/${escapeJsonPointer(rawPath)}/${methodLower}/parameters`,
      blocking: true,
    });
    const swaggerBodyCount = combinedParams.filter((item) => {
      const p = derefObject(spec, item.param).target;
      return p.in === "formData" || p.in === "body";
    }).length;
    if (swaggerBodyCount > 6) {
      report?.unsupported({
        op: operationId,
        element: "bodyField",
        code: FIDELITY_CODES.BODY_FIELD_CAPPED.code,
        pointer: `#/paths/${escapeJsonPointer(rawPath)}/${methodLower}/parameters`,
        blocking: false,
      });
    }
  }
}

/** Every `{param}` in the path template must exist as a path param. */
export function backfillPathParams(
  ctx: OpenApiOpContext,
  params: IntegrationOperationParam[],
  usedCleanNames: Set<string>,
): void {
  const { report, operationId, rawPath } = ctx;
  // Ensure any {param} in path is represented in params
  for (const match of rawPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
    const rawPName = match[1]!;
    if (params.some((p) => p.in === "path" && (p.wireName ?? p.name) === rawPName)) {
      continue;
    }
    let pName = sanitizeIdentifier(rawPName);
    let wireName: string | undefined = pName !== rawPName ? rawPName : undefined;
    if (pName !== rawPName) {
      report?.normalized({
        op: operationId,
        element: "param",
        code: FIDELITY_CODES.IDENTIFIER_NORMALIZED.code,
        pointer: `#/paths/${escapeJsonPointer(rawPath)}`,
        from: rawPName,
        to: pName,
        blocking: false,
      });
    }
    if (usedCleanNames.has(pName)) {
      const candidate = `${pName}_path`;
      if (!usedCleanNames.has(candidate)) {
        wireName = wireName ?? rawPName;
        report?.normalized({
          op: operationId,
          element: "param",
          code: FIDELITY_CODES.IDENTIFIER_COLLISION_DISAMBIGUATED.code,
          pointer: `#/paths/${escapeJsonPointer(rawPath)}`,
          from: pName,
          to: candidate,
          blocking: false,
        });
        pName = candidate;
        usedCleanNames.add(pName);
      } else {
        report?.unsupported({
          op: operationId,
          element: "param",
          code: FIDELITY_CODES.IDENTIFIER_COLLISION.code,
          pointer: `#/paths/${escapeJsonPointer(rawPath)}`,
          from: pName,
          blocking: true,
        });
        usedCleanNames.add(pName);
      }
    } else {
      usedCleanNames.add(pName);
    }
    params.push({
      name: pName,
      ...(wireName !== undefined ? { wireName } : {}),
      in: "path",
      dataType: "string",
      required: true,
    });
  }
}
