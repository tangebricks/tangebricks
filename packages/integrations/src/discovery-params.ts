import { FIDELITY_CODES } from "@poc/assembler";
import { escapeJsonPointer } from "./report.ts";
import type { ReportCollector } from "./report.ts";
import {
  isPlainObject,
  mapSchemaTypeToPortType,
  sanitizeIdentifier,
  truncateText,
} from "./util.ts";
import type { IntegrationOperationParam } from "@poc/assembler";

export interface DiscoveryMethodContext {
  readonly report: ReportCollector | undefined;
  readonly operationId: string;
  readonly methodIdStr: string;
}

export interface ExtractedDiscoveryParams {
  readonly params: IntegrationOperationParam[];
  readonly usedCleanNames: Set<string>;
}

/** Maps the `parameters` map of one Discovery method (report codes PARAM_*). */
export function extractDiscoveryParams(
  ctx: DiscoveryMethodContext,
  methodVal: Record<string, unknown>,
  reservedPathParams: ReadonlySet<string>,
): ExtractedDiscoveryParams {
  const { report, operationId, methodIdStr } = ctx;
  const params: IntegrationOperationParam[] = [];
  const seenParamKeys = new Set<string>();
  const usedCleanNames = new Set<string>();

  const rawParams = isPlainObject(methodVal.parameters) ? methodVal.parameters : {};
  for (const [pKey, pVal] of Object.entries(rawParams)) {
    if (!isPlainObject(pVal)) continue;
    const pPointer = `#/methods/${escapeJsonPointer(methodIdStr)}/parameters/${escapeJsonPointer(pKey)}`;
    const loc =
      pVal.location === "path"
        ? "path"
        : pVal.location === "header"
          ? "header"
          : "query";
    const rawKey = `${loc}:${pKey}`;
    if (seenParamKeys.has(rawKey)) continue;
    seenParamKeys.add(rawKey);

    let cleanName = sanitizeIdentifier(pKey);
    let wireName: string | undefined = cleanName !== pKey ? pKey : undefined;

    if (cleanName !== pKey) {
      report?.normalized({
        op: operationId,
        element: "param",
        code: FIDELITY_CODES.IDENTIFIER_NORMALIZED.code,
        pointer: pPointer,
        from: pKey,
        to: cleanName,
        blocking: false,
      });
    }

    if (usedCleanNames.has(cleanName)) {
      const candidateName = `${cleanName}_${loc}`;
      if (!usedCleanNames.has(candidateName)) {
        wireName = wireName ?? pKey;
        report?.normalized({
          op: operationId,
          element: "param",
          code: FIDELITY_CODES.IDENTIFIER_COLLISION_DISAMBIGUATED.code,
          pointer: pPointer,
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
          pointer: pPointer,
          from: cleanName,
          reason: `Collision for identifier "${cleanName}" could not be disambiguated`,
          blocking: true,
        });
        usedCleanNames.add(cleanName);
      }
    } else {
      usedCleanNames.add(cleanName);
    }

    const desc = truncateText(pVal.description, 50);
    const mapping = mapSchemaTypeToPortType(pVal);

    let paramLoss = false;
    let styleVal: any = undefined;
    let explodeVal: boolean | undefined = undefined;
    let dataTypeVal = mapping.dataType;

    if (pVal.repeated) {
      dataTypeVal = "array";
      styleVal = "form";
      explodeVal = true;
    }

    let cleanEnum: (string | number | boolean)[] | undefined;
    if (Array.isArray(pVal.enum)) {
      if (pVal.enum.length > 256) {
        report?.approximated({
          op: operationId,
          element: "param",
          code: FIDELITY_CODES.PARAM_ENUM_TRUNCATED.code,
          pointer: pPointer,
          blocking: false,
        });
        paramLoss = true;
        cleanEnum = pVal.enum.slice(0, 256);
      } else {
        cleanEnum = pVal.enum;
      }
    }

    const rawDefault = pVal.default;

    let itemsVal: { dataType: any; enum?: (string | number | boolean)[] } | undefined;
    if (pVal.items && (pVal.type === "array" || pVal.repeated)) {
      const itemsMapping = mapSchemaTypeToPortType(pVal.items);
      const rawItemsEnum = Array.isArray((pVal.items as any)?.enum)
        ? (pVal.items as any).enum
        : undefined;
      let itemsEnum: (string | number | boolean)[] | undefined;
      if (rawItemsEnum) {
        if (rawItemsEnum.length > 256) {
          report?.approximated({
            op: operationId,
            element: "param",
            code: FIDELITY_CODES.PARAM_ENUM_TRUNCATED.code,
            pointer: `${pPointer}/items`,
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

    const isReserved =
      reservedPathParams.has(pKey) ||
      (loc === "path" && reservedPathParams.has(cleanName));

    if (mapping.loss === "SCHEMA_COMPOSITION_ERASED") {
      report?.approximated({
        op: operationId,
        element: "param",
        code: FIDELITY_CODES.SCHEMA_COMPOSITION_ERASED.code,
        pointer: pPointer,
        blocking: false,
      });
      paramLoss = true;
    }

    if (!paramLoss) {
      report?.mapped({
        op: operationId,
        element: "param",
        code: FIDELITY_CODES.PARAM_MAPPED.code,
        pointer: pPointer,
        blocking: false,
      });
    }

    params.push({
      name: cleanName,
      ...(wireName !== undefined ? { wireName } : {}),
      in: loc,
      dataType: dataTypeVal,
      ...(pVal.required === true || loc === "path" ? { required: true } : {}),
      ...(desc ? { description: desc } : {}),
      ...(cleanEnum !== undefined ? { enum: cleanEnum } : {}),
      ...(rawDefault !== undefined ? { default: rawDefault } : {}),
      ...(itemsVal !== undefined ? { items: itemsVal } : {}),
      ...(styleVal !== undefined ? { style: styleVal } : {}),
      ...(explodeVal !== undefined ? { explode: explodeVal } : {}),
      ...(isReserved ? { allowReserved: true } : {}),
    });
  }
  return { params, usedCleanNames };
}

/** Every `{param}` in the full path must exist as a path param. */
export function backfillDiscoveryPathParams(
  ctx: DiscoveryMethodContext,
  fullPath: string,
  params: IntegrationOperationParam[],
  usedCleanNames: Set<string>,
  reservedPathParams: ReadonlySet<string>,
): void {
  const { report, operationId, methodIdStr } = ctx;
  for (const match of fullPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
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
        pointer: `#/methods/${escapeJsonPointer(methodIdStr)}`,
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
          pointer: `#/methods/${escapeJsonPointer(methodIdStr)}`,
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
          pointer: `#/methods/${escapeJsonPointer(methodIdStr)}`,
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
      ...(reservedPathParams.has(rawPName) ? { allowReserved: true } : {}),
    });
  }
}
