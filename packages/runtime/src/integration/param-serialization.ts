import type { IntegrationOperationParam } from "@poc/assembler";
import { IntegrationCallError } from "./errors.ts";

export type SerializedParam =
  | { kind: "query"; pairs: [string, string][] }
  | { kind: "path"; segment: string }
  | { kind: "header"; value: string }
  | { kind: "cookie"; pair: [string, string] };

function flattenDeepObject(prefix: string, obj: unknown): [string, string][] {
  if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
    const result: [string, string][] = [];
    for (const [k, v] of Object.entries(obj)) {
      result.push(...flattenDeepObject(`${prefix}[${k}]`, v));
    }
    return result;
  } else if (Array.isArray(obj)) {
    return obj.map((v) => [`${prefix}[]`, String(v)]);
  } else {
    return [[prefix, String(obj)]];
  }
}

export function serializeParam(
  param: IntegrationOperationParam,
  value: unknown,
): SerializedParam {
  // 1. Enum validation
  if (value !== undefined && value !== null) {
    if (param.enum && param.enum.length > 0) {
      if (!param.enum.includes(value as any)) {
        throw new IntegrationCallError(
          `INTEGRATION_INVALID_PARAM: Parameter "${param.name}" value "${String(value)}" is not one of the allowed enum values: ${param.enum.join(", ")}`,
          { code: "INTEGRATION_INVALID_PARAM" },
        );
      }
    }
    if (
      param.dataType === "array" &&
      Array.isArray(value) &&
      param.items?.enum &&
      param.items.enum.length > 0
    ) {
      for (const item of value) {
        if (!param.items.enum.includes(item as any)) {
          throw new IntegrationCallError(
            `INTEGRATION_INVALID_PARAM: Parameter "${param.name}" array item "${String(item)}" is not one of the allowed enum values: ${param.items.enum.join(", ")}`,
            { code: "INTEGRATION_INVALID_PARAM" },
          );
        }
      }
    }
  }

  // 2. Style validation
  if (param.style === "label" || param.style === "matrix") {
    throw new IntegrationCallError(
      `INTEGRATION_UNSUPPORTED_FEATURE: Parameter "${param.name}" style "${param.style}" is unsupported`,
      { code: "INTEGRATION_UNSUPPORTED_FEATURE" },
    );
  }

  const wireName = param.wireName ?? param.name;

  // 3. Serialize per location
  if (param.in === "path") {
    let segment: string;
    if (Array.isArray(value)) {
      segment = value.map(String).join(",");
    } else {
      segment = String(value);
    }
    return { kind: "path", segment };
  }

  if (param.in === "header") {
    let headerVal: string;
    if (Array.isArray(value)) {
      headerVal = value.map(String).join(",");
    } else {
      headerVal = String(value);
    }
    return { kind: "header", value: headerVal };
  }

  if (param.in === "cookie") {
    return { kind: "cookie", pair: [wireName, String(value)] };
  }

  // in === "query"
  const style = param.style ?? "form";
  const explode = param.explode ?? (style === "form");

  if (style === "deepObject") {
    if (Array.isArray(value)) {
      // normalized DEEPOBJECT_ARRAY_CONVENTION: expand[]=a&expand[]=b
      const pairs: [string, string][] = value.map((v) => [`${wireName}[]`, String(v)]);
      return { kind: "query", pairs };
    }
    if (typeof value === "object" && value !== null) {
      const pairs = flattenDeepObject(wireName, value);
      return { kind: "query", pairs };
    }
    return { kind: "query", pairs: [[wireName, String(value)]] };
  }

  if (style === "spaceDelimited") {
    if (Array.isArray(value)) {
      return { kind: "query", pairs: [[wireName, value.map(String).join("%20")]] };
    }
    return { kind: "query", pairs: [[wireName, String(value)]] };
  }

  if (style === "pipeDelimited") {
    if (Array.isArray(value)) {
      return { kind: "query", pairs: [[wireName, value.map(String).join("|")]] };
    }
    return { kind: "query", pairs: [[wireName, String(value)]] };
  }

  // style === "form"
  if (Array.isArray(value)) {
    if (explode) {
      return { kind: "query", pairs: value.map((v) => [wireName, String(v)]) };
    } else {
      return { kind: "query", pairs: [[wireName, value.map(String).join(",")]] };
    }
  }

  if (typeof value === "object" && value !== null) {
    if (explode) {
      return {
        kind: "query",
        pairs: Object.entries(value).map(([k, v]) => [k, String(v)]),
      };
    } else {
      const formatted = Object.entries(value)
        .flatMap(([k, v]) => [k, String(v)])
        .join(",");
      return { kind: "query", pairs: [[wireName, formatted]] };
    }
  }

  return { kind: "query", pairs: [[wireName, String(value)]] };
}
