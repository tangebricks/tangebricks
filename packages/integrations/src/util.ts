import { createHash } from "node:crypto";
import YAML from "yaml";
import type { NodePortDataType } from "@poc/assembler";
export function canonicalJson(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(val as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((val as Record<string, unknown>)[k])}`).join(",")}}`;
}

export const VALID_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeIdentifier(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^([0-9])/, "_$1")
    .slice(0, 64);
  return VALID_IDENTIFIER_REGEX.test(cleaned) ? cleaned : "param";
}

export function sanitizeOperationId(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
  return cleaned || "operation";
}

export interface SchemaTypeMappingResult {
  readonly dataType: NodePortDataType;
  readonly loss?: "SCHEMA_COMPOSITION_ERASED" | "BODY_NESTED_FLATTENED";
}

export function mapSchemaTypeToPortType(schema: unknown): SchemaTypeMappingResult {
  if (!isPlainObject(schema)) return { dataType: "string" };

  if (!schema.type && (schema.oneOf || schema.anyOf || schema.allOf)) {
    return { dataType: "string", loss: "SCHEMA_COMPOSITION_ERASED" };
  }

  const rawType = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (rawType === "integer" || rawType === "number") return { dataType: "number" };
  if (rawType === "boolean") return { dataType: "boolean" };
  if (rawType === "array") {
    const it = isPlainObject(schema.items) ? schema.items : undefined;
    if (it && (isPlainObject(it.properties) || it.type === "object" || typeof it.$ref === "string" || it.type === "array")) {
      return { dataType: "array", loss: "BODY_NESTED_FLATTENED" };
    }
    return { dataType: "array" };
  }
  if (rawType === "object" || isPlainObject(schema.properties)) {
    if (isPlainObject(schema.properties) || isPlainObject(schema.additionalProperties)) {
      return { dataType: "object", loss: "BODY_NESTED_FLATTENED" };
    }
    return { dataType: "object" };
  }
  return { dataType: "string" };
}

export function truncateText(text: unknown, maxLen: number): string | undefined {
  if (typeof text !== "string") return undefined;
  const firstSentence =
    text
      .trim()
      .replace(/\s+/g, " ")
      .split(/(?<=\.)\s+/)[0] ?? text.trim();
  const compact = firstSentence.slice(0, maxLen).trim();
  return compact.length > 0 ? compact : undefined;
}

/**
 * Conformant YAML / JSON parser for OpenAPI 3.x, Swagger 2.0, and Google Discovery specs.
 */
export function parseSpecDocument(rawText: string): Record<string, unknown> {
  try {
    const parsed = YAML.parse(rawText, {
      version: "1.2",
      uniqueKeys: true,
      maxAliasCount: 100,
    });
    if (!isPlainObject(parsed)) {
      throw new Error("Spec document root must be an object");
    }
    return parsed;
  } catch (err: any) {
    if (err instanceof Error && err.message.startsWith("OPENAPI_IMPORT_PARSE_ERROR:")) {
      throw err;
    }
    let line = 1;
    let col = 1;
    if (Array.isArray(err?.linePos) && err.linePos.length > 0 && err.linePos[0]) {
      line = err.linePos[0].line;
      col = err.linePos[0].col;
    }
    const cleanMessage = (err?.message || String(err)).split("\n")[0];
    throw new Error(`OPENAPI_IMPORT_PARSE_ERROR: ${line}:${col} ${cleanMessage}`);
  }
}

export function resolveJsonPointerRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    // Google Discovery uses bare schema names in $ref (e.g. "Event")
    if (isPlainObject(root.schemas) && Object.hasOwn(root.schemas, ref)) {
      return root.schemas[ref];
    }
    return undefined;
  }
  const parts = ref
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const part of parts) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

export interface DerefResult {
  readonly target: Record<string, unknown>;
  readonly depthExceeded: boolean;
}

export function derefObject(root: Record<string, unknown>, target: unknown, depth = 0): DerefResult {
  if (!isPlainObject(target)) return { target: {}, depthExceeded: false };
  if (depth > 5) return { target, depthExceeded: true };
  if (typeof target.$ref === "string") {
    const resolved = resolveJsonPointerRef(root, target.$ref);
    if (isPlainObject(resolved)) {
      const nextRef = typeof resolved.$ref === "string" ? resolved.$ref : undefined;
      return derefObject(root, { ...target, ...resolved, $ref: nextRef }, depth + 1);
    }
  }
  return { target, depthExceeded: false };
}

export function canonicalStringify(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(canonicalStringify).join(",")}]`;
  }
  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
  return `{${entries.join(",")}}`;
}

export const specHashCache = new WeakMap<object, string>();

export function computeSpecHash(spec: Record<string, unknown> | string | unknown[]): string {
  if (typeof spec === "object" && spec !== null) {
    const cached = specHashCache.get(spec);
    if (cached) return cached;
  }
  const hash = createHash("sha256");
  if (typeof spec === "string") {
    hash.update(Buffer.from(spec, "utf8"));
  } else if (Buffer.isBuffer(spec)) {
    hash.update(spec);
  } else {
    hash.update(Buffer.from(canonicalStringify(spec), "utf8"));
  }
  const result = `sha256:${hash.digest("hex")}`;
  if (typeof spec === "object" && spec !== null) {
    specHashCache.set(spec, result);
  }
  return result;
}
