import { FIDELITY_CODES } from "@poc/assembler";
import { escapeJsonPointer } from "./report.ts";
import type { ReportCollector } from "./report.ts";
import { derefObject, isPlainObject, mapSchemaTypeToPortType, resolveJsonPointerRef } from "./util.ts";
import type { IntegrationOperationResponse, NodePortDefinition } from "@poc/assembler";
export const OUTPUT_PORT_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const RESERVED_OUTPUT_PORTS = new Set(["out", "status", "body", "data"]);
export const MAX_OUTPUT_SCHEMA_DEPTH = 8;

export interface FlatResponseSchema {
  readonly properties: Array<[string, unknown]>;
  readonly required: ReadonlySet<string>;
}

/**
 * Deref a schema and merge `allOf` members (cycle-safe via a visited `$ref` set,
 * bounded by MAX_OUTPUT_SCHEMA_DEPTH) into one ordered property list.
 */
export function flattenResponseSchema(root: Record<string, unknown>, schema: unknown, visited: Set<string> = new Set(), depth = 0): FlatResponseSchema {
  const properties = new Map<string, unknown>();
  const required = new Set<string>();
  if (!isPlainObject(schema) || depth > MAX_OUTPUT_SCHEMA_DEPTH) {
    return { properties: [], required };
  }
  const current: Record<string, unknown> = schema;
  if (typeof current.$ref === "string") {
    if (visited.has(current.$ref)) return { properties: [], required };
    visited.add(current.$ref);
    const resolved = resolveJsonPointerRef(root, current.$ref);
    if (!isPlainObject(resolved)) return { properties: [], required };
    return flattenResponseSchema(root, resolved, visited, depth + 1);
  }
  if (Array.isArray(current.allOf)) {
    for (const member of current.allOf) {
      const flat = flattenResponseSchema(root, member, new Set(visited), depth + 1);
      for (const [k, v] of flat.properties) properties.set(k, v);
      for (const r of flat.required) required.add(r);
    }
  }
  const variants = Array.isArray(current.oneOf) ? current.oneOf : Array.isArray(current.anyOf) ? current.anyOf : undefined;
  if (variants && variants.length > 0) {
    // Top-level oneOf/anyOf: keep the properties every variant declares. Mixed types become `any`.
    const flats = variants.map((v) => flattenResponseSchema(root, v, new Set(visited), depth + 1));
    const first = new Map(flats[0]!.properties);
    for (const [name, value] of first) {
      const maps = flats.map((f) => new Map(f.properties));
      if (!maps.every((m) => m.has(name))) continue;
      const types = maps.map((m) => mapSchemaTypeToPortType(derefObject(root, m.get(name)).target).dataType);
      properties.set(name, types.every((t) => t === types[0]) ? value : { "x-port-type": "any" });
      if (flats.every((f) => f.required.has(name))) required.add(name);
    }
  }
  if (isPlainObject(current.properties)) {
    for (const [k, v] of Object.entries(current.properties)) properties.set(k, v);
  }
  if (Array.isArray(current.required)) {
    for (const r of current.required) if (typeof r === "string") required.add(r);
  }
  return { properties: [...properties.entries()], required };
}

export function mapResponseOutputs(root: Record<string, unknown>, flat: FlatResponseSchema): { outputs: NodePortDefinition[]; renamed: string[] } {
  const entries = flat.properties.map(([name, value], index) => ({ name, value, index }));
  entries.sort((a, b) => {
    const ar = flat.required.has(a.name) ? 0 : 1;
    const br = flat.required.has(b.name) ? 0 : 1;
    return ar - br || a.index - b.index;
  });
  const outputs: NodePortDefinition[] = [];
  const renamed: string[] = [];
  for (const { name, value } of entries) {
    if (!OUTPUT_PORT_IDENTIFIER.test(name) || RESERVED_OUTPUT_PORTS.has(name)) {
      renamed.push(name);
      continue;
    }
    const resolved = derefObject(root, value).target;
    outputs.push({
      id: name,
      dataType: isPlainObject(resolved) && resolved["x-port-type"] === "any" ? "any" : mapSchemaTypeToPortType(resolved).dataType,
    });
  }
  return { outputs, renamed };
}

export type ErrorShape = NonNullable<IntegrationOperationResponse["errorShape"]>;

export const ERROR_CODE_NAMES = ["code", "error"] as const;
export const ERROR_MESSAGE_NAMES = ["message", "error_description"] as const;
export const ERROR_TYPE_NAMES = ["type"] as const;

export function errorShapeAtLevel(root: Record<string, unknown>, flat: FlatResponseSchema, prefix: string): ErrorShape | undefined {
  const props = new Map(flat.properties);
  const isObjectProp = (name: string): boolean => {
    const t = derefObject(root, props.get(name)).target;
    return mapSchemaTypeToPortType(t).dataType === "object";
  };
  const pick = (names: readonly string[]): string | undefined => names.find((n) => props.has(n) && !isObjectProp(n));
  const code = pick(ERROR_CODE_NAMES);
  const message = pick(ERROR_MESSAGE_NAMES);
  const type = pick(ERROR_TYPE_NAMES);
  if (!code && !message && !type) return undefined;
  return {
    ...(code ? { codePath: `${prefix}${code}` } : {}),
    ...(message ? { messagePath: `${prefix}${message}` } : {}),
    ...(type ? { typePath: `${prefix}${type}` } : {}),
  };
}

export function deriveErrorShape(root: Record<string, unknown>, schema: unknown): ErrorShape | undefined {
  const flat = flattenResponseSchema(root, schema);
  const top = errorShapeAtLevel(root, flat, "");
  if (top) return top;
  // Depth 2: look inside object-valued properties, `error` first, then spec order.
  const nested = [...flat.properties].sort(([a], [b]) => (a === "error" ? -1 : b === "error" ? 1 : 0));
  for (const [name, value] of nested) {
    if (!OUTPUT_PORT_IDENTIFIER.test(name)) continue;
    const resolved = derefObject(root, value).target;
    if (mapSchemaTypeToPortType(resolved).dataType !== "object") continue;
    const inner = errorShapeAtLevel(root, flattenResponseSchema(root, resolved), `${name}.`);
    if (inner) return inner;
  }
  return undefined;
}

export function jsonSchemaOfResponse(respObj: Record<string, unknown>): { schema: unknown; nonJsonOnly: boolean; contentType?: string } | undefined {
  const hasSchema = (c: unknown): boolean => isPlainObject(c) && (isPlainObject(c.schema) || typeof c.$ref === "string");
  if (isPlainObject(respObj.content)) {
    const entries = Object.entries(respObj.content).filter(([, c]) => isPlainObject(c));
    const json = entries.find(([mt]) => /json/i.test(mt));
    if (json && hasSchema(json[1])) {
      const media = json[1] as Record<string, unknown>;
      return { schema: media.schema ?? { $ref: media.$ref }, nonJsonOnly: false, contentType: json[0] };
    }
    const nonJson = entries.find(([, c]) => hasSchema(c)) ?? entries[0];
    if (nonJson) {
      const media = nonJson[1] as Record<string, unknown>;
      return { schema: media.schema ?? { $ref: media.$ref }, nonJsonOnly: true, contentType: nonJson[0] };
    }
    return undefined;
  }
  if (isPlainObject(respObj.schema)) return { schema: respObj.schema, nonJsonOnly: false };
  return undefined;
}

/**
 * UC3.2: derive `response` (outputs, status, errorShape) for one OpenAPI/Swagger operation
 * and report what was mapped or lost.
 */
export function extractOpenApiResponse(
  root: Record<string, unknown>,
  responsesRaw: unknown,
  operationId: string,
  pointerBase: string,
  report: ReportCollector | undefined,
  hasPredicate = false,
  hasPagination = false,
): IntegrationOperationResponse {
  const responses = isPlainObject(responsesRaw) ? responsesRaw : {};
  const keys = Object.keys(responses);
  const resolveResp = (key: string): Record<string, unknown> => derefObject(root, responses[key]).target;
  const ptr = (key: string): string => `${pointerBase}/${escapeJsonPointer(key)}`;
  const result: IntegrationOperationResponse = {};

  const twoXx = keys.filter((k) => /^2(\d\d|XX)$/i.test(k)).sort((a, b) => a.localeCompare(b));
  const hasErrorStatus = keys.some((k) => /^[45]/.test(k));
  let successKey: string | undefined;
  let success: { schema: unknown; nonJsonOnly: boolean; contentType?: string } | undefined;
  for (const k of twoXx) {
    const found = jsonSchemaOfResponse(resolveResp(k));
    if (found && !found.nonJsonOnly) {
      successKey = k;
      success = found;
      break;
    }
  }
  let nonJsonFound: { schema: unknown; nonJsonOnly: boolean; contentType?: string } | undefined;
  let nonJsonKey: string | undefined;
  if (!success) {
    for (const k of twoXx) {
      const found = jsonSchemaOfResponse(resolveResp(k));
      if (found?.nonJsonOnly) {
        nonJsonKey = k;
        nonJsonFound = found;
        break;
      }
    }
  }
  if (!success && twoXx.length === 0 && !hasErrorStatus && keys.includes("default")) {
    const found = jsonSchemaOfResponse(resolveResp("default"));
    if (found && !found.nonJsonOnly) {
      successKey = "default";
      success = found;
    }
  }

  if (success && successKey) {
    const flat = flattenResponseSchema(root, success.schema);
    if (/^\d{3}$/.test(successKey)) result.status = Number(successKey);
    const { outputs, renamed } = mapResponseOutputs(root, flat);
    if (outputs.length > 0) result.outputs = outputs;
    report?.mapped({
      op: operationId,
      element: "response",
      code: FIDELITY_CODES.RESPONSE_SCHEMA.code,
      pointer: ptr(successKey),
      blocking: false,
    });
    if (renamed.length > 0) {
      report?.normalized({
        op: operationId,
        element: "response",
        code: FIDELITY_CODES.RESPONSE_PROPERTY_NOT_PORT.code,
        pointer: ptr(successKey),
        from: renamed,
        reason: "properties whose name is not a port identifier or is a reserved port stay reachable under `out`",
        blocking: false,
      });
    }

    const respObj = resolveResp(successKey);
    const hasLinkHeader = isPlainObject(respObj) && isPlainObject(respObj.headers) && Object.keys(respObj.headers).some((h) => h.toLowerCase() === "link");
    checkResponseSemanticsFidelity(root, flat, ptr(successKey), operationId, report, hasPredicate, hasPagination, hasLinkHeader);
  } else if (nonJsonKey && nonJsonFound) {
    const ct = nonJsonFound.contentType ?? "application/octet-stream";
    result.contentType = ct;
    if (/^\d{3}$/.test(nonJsonKey)) result.status = Number(nonJsonKey);
    if (ct.startsWith("text/")) {
      result.outputs = [{ id: "text", dataType: "string" }];
    } else {
      result.binary = true;
      result.outputs = [
        { id: "blobRef", dataType: "string" },
        { id: "contentType", dataType: "string" },
        { id: "size", dataType: "number" },
      ];
    }
    report?.mapped({
      op: operationId,
      element: "response",
      code: FIDELITY_CODES.RESPONSE_SCHEMA.code,
      pointer: ptr(nonJsonKey),
      blocking: false,
    });
  } else {
    const emptyKey = twoXx.find((k) => k === "204" || k === "205");
    if (emptyKey) {
      result.status = Number(emptyKey);
      report?.mapped({
        op: operationId,
        element: "response",
        code: FIDELITY_CODES.RESPONSE_EMPTY.code,
        pointer: ptr(emptyKey),
        blocking: false,
      });
    } else {
      report?.mapped({
        op: operationId,
        element: "response",
        code: FIDELITY_CODES.RESPONSE_MAPPED.code,
        pointer: ptr(twoXx[0] ?? keys[0] ?? "200"),
        blocking: false,
      });
    }
  }

  const errorKeys = [
    ...keys.filter((k) => /^[45]/.test(k)).sort((a, b) => a.localeCompare(b)),
    ...(keys.includes("default") && successKey !== "default" ? ["default"] : []),
  ];
  for (const k of errorKeys) {
    const found = jsonSchemaOfResponse(resolveResp(k));
    if (!found || found.nonJsonOnly) continue;
    const shape = deriveErrorShape(root, found.schema);
    if (shape) {
      result.errorShape = shape;
      report?.mapped({
        op: operationId,
        element: "response",
        code: FIDELITY_CODES.ERROR_SHAPE.code,
        pointer: ptr(k),
        to: shape,
        blocking: false,
      });
      break;
    }
  }
  return result;
}

/** UC3.2: derive `response` for a Google Discovery method (`response: {$ref}` against `schemas`). */
export function extractDiscoveryResponse(
  root: Record<string, unknown>,
  responseRaw: unknown,
  operationId: string,
  pointer: string,
  report: ReportCollector | undefined,
  hasPredicate = false,
  hasPagination = false,
): IntegrationOperationResponse {
  if (!isPlainObject(responseRaw)) {
    report?.mapped({ op: operationId, element: "response", code: FIDELITY_CODES.RESPONSE_MAPPED.code, pointer, blocking: false });
    return {};
  }
  const flat = flattenResponseSchema(root, responseRaw);
  const result: IntegrationOperationResponse = {};
  const { outputs, renamed } = mapResponseOutputs(root, flat);
  if (outputs.length > 0) result.outputs = outputs;
  report?.mapped({ op: operationId, element: "response", code: FIDELITY_CODES.RESPONSE_SCHEMA.code, pointer, blocking: false });
  if (renamed.length > 0) {
    report?.normalized({
      op: operationId,
      element: "response",
      code: FIDELITY_CODES.RESPONSE_PROPERTY_NOT_PORT.code,
      pointer,
      from: renamed,
      reason: "properties whose name is not a port identifier or is a reserved port stay reachable under `out`",
      blocking: false,
    });
  }
  checkResponseSemanticsFidelity(root, flat, pointer, operationId, report, hasPredicate, hasPagination);
  return result;
}

function checkResponseSemanticsFidelity(
  root: Record<string, unknown>,
  flat: FlatResponseSchema,
  pointer: string,
  operationId: string,
  report: ReportCollector | undefined,
  hasPredicate: boolean,
  hasPagination: boolean,
  hasLinkHeader = false,
): void {
  if (
    !hasPredicate &&
    flat.properties.some(([name, val]) => {
      if (name !== "ok") return false;
      const t = derefObject(root, val).target;
      return isPlainObject(t) && (t.type === "boolean" || (Array.isArray(t.type) && t.type.includes("boolean")));
    })
  ) {
    report?.approximated({
      op: operationId,
      element: "response",
      code: FIDELITY_CODES.SUCCESS_ENVELOPE_UNCHECKED.code,
      pointer,
      reason: "200 response schema has boolean 'ok' property with no errorWhen/successWhen predicate",
      blocking: false,
    });
  }
  const PAGINATION_PROPS = new Set(["has_more", "next_cursor", "nextPageToken", "next"]);
  if (!hasPagination && (hasLinkHeader || flat.properties.some(([name]) => PAGINATION_PROPS.has(name)))) {
    report?.approximated({
      op: operationId,
      element: "pagination",
      code: FIDELITY_CODES.PAGINATION_UNMODELLED.code,
      pointer,
      reason: "Response declares pagination signals (has_more, next_cursor, nextPageToken, next, Link) but pagination is not modelled",
      blocking: false,
    });
  }
}
