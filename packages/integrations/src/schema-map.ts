import type { FieldSchema } from "@poc/assembler";
import { isPlainObject, resolveJsonPointerRef } from "./util.ts";

export interface MapSchemaOptions {
  depth?: number;
  maxDepth?: number;
  maxNodes?: number;
  nodeCounter?: { count: number };
  visitedRefs?: Set<string>;
  onLoss?: (code: string, detail?: { pointer?: string; reason?: string }) => void;
  pointer?: string;
}

/**
 * Resolves a $ref pointer or Discovery schema name against root.
 */
function resolveRef(root: unknown, ref: string): Record<string, unknown> | undefined {
  if (!isPlainObject(root)) return undefined;
  if (ref.startsWith("#/")) {
    const resolved = resolveJsonPointerRef(root, ref);
    return isPlainObject(resolved) ? resolved : undefined;
  }
  const schemas = isPlainObject(root.schemas) ? root.schemas : undefined;
  if (schemas && isPlainObject(schemas[ref])) {
    return schemas[ref] as Record<string, unknown>;
  }
  const components = isPlainObject(root.components) ? root.components : undefined;
  const compSchemas = components && isPlainObject(components.schemas) ? components.schemas : undefined;
  if (compSchemas && isPlainObject(compSchemas[ref])) {
    return compSchemas[ref] as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Maps an OpenAPI 3 / Discovery schema into a cycle-safe, bounded FieldSchema (UC3.5).
 */
export function mapSchema(root: unknown, raw: unknown, options: MapSchemaOptions = {}): FieldSchema {
  const depth = options.depth ?? 1;
  const maxDepth = options.maxDepth ?? 8;
  const maxNodes = options.maxNodes ?? 200;
  const visitedRefs = options.visitedRefs ?? new Set<string>();
  const nodeCounter = options.nodeCounter ?? { count: 0 };

  if (!isPlainObject(raw)) {
    return { dataType: "any" };
  }

  // Deref $ref if present
  if (typeof raw.$ref === "string") {
    const ref = raw.$ref;
    if (visitedRefs.has(ref)) {
      // Cycle safe: count pass-through object node
      nodeCounter.count++;
      return { dataType: "object" };
    }
    const resolved = resolveRef(root, ref);
    if (!resolved) {
      nodeCounter.count++;
      return { dataType: "object" };
    }
    const nextVisited = new Set(visitedRefs);
    nextVisited.add(ref);
    return mapSchema(root, resolved, {
      ...options,
      depth,
      visitedRefs: nextVisited,
      nodeCounter,
      maxDepth,
      maxNodes,
    });
  }

  // Count this node
  nodeCounter.count++;

  // Recursion depth limit check:
  // If depth >= maxDepth and schema has nested structures, collapse to generic object
  // so child nodes are not created at depth > maxDepth.
  if (depth >= maxDepth) {
    if (isPlainObject(raw.properties) || raw.items || raw.oneOf || raw.anyOf || raw.allOf) {
      options.onLoss?.("SCHEMA_DEPTH_LIMIT", {
        pointer: options.pointer,
        reason: `Schema exceeds recursion depth ${maxDepth}; preserved as pass-through object`,
      });
    }
    return { dataType: "object" };
  }

  // allOf composition: merge into a single schema object
  if (Array.isArray(raw.allOf) && raw.allOf.length > 0) {
    const mergedProps: Record<string, unknown> = {};
    const mergedRequired = new Set<string>();
    let mergedType: string | undefined = typeof raw.type === "string" ? raw.type : undefined;

    for (const sub of raw.allOf) {
      let resolvedSub = sub;
      if (isPlainObject(sub) && typeof sub.$ref === "string") {
        resolvedSub = resolveRef(root, sub.$ref) ?? sub;
      }
      if (!isPlainObject(resolvedSub)) continue;

      if (typeof resolvedSub.type === "string") {
        mergedType = resolvedSub.type;
      }
      if (Array.isArray(resolvedSub.required)) {
        for (const r of resolvedSub.required) {
          if (typeof r === "string") mergedRequired.add(r);
        }
      }
      if (isPlainObject(resolvedSub.properties)) {
        for (const [k, v] of Object.entries(resolvedSub.properties)) {
          mergedProps[k] = v;
        }
      }
    }

    const mergedRaw = {
      ...raw,
      type: mergedType ?? "object",
      properties: mergedProps,
      required: [...mergedRequired],
    };
    delete (mergedRaw as any).allOf;
    // Decrement nodeCounter because mapSchema on mergedRaw will count it
    nodeCounter.count--;
    return mapSchema(root, mergedRaw, { ...options, depth, nodeCounter, maxDepth, maxNodes });
  }

  // oneOf / anyOf composition: variants
  const rawVariants = Array.isArray(raw.oneOf) ? raw.oneOf : Array.isArray(raw.anyOf) ? raw.anyOf : undefined;

  let variants: FieldSchema[] | undefined;
  if (rawVariants && rawVariants.length > 0) {
    const collected: FieldSchema[] = [];
    for (const v of rawVariants) {
      if (nodeCounter.count >= maxNodes) {
        options.onLoss?.("SCHEMA_NODE_LIMIT", {
          pointer: options.pointer,
          reason: `Schema exceeds maximum node count of ${maxNodes}; remaining variants omitted`,
        });
        break;
      }
      collected.push(
        mapSchema(root, v, {
          ...options,
          depth: depth + 1,
          visitedRefs,
          nodeCounter,
          maxDepth,
          maxNodes,
        }),
      );
    }
    if (collected.length > 0) {
      variants = collected;
    }
  }

  let discriminator: string | undefined;
  if (typeof raw.discriminator === "string") {
    discriminator = raw.discriminator;
  } else if (isPlainObject(raw.discriminator) && typeof raw.discriminator.propertyName === "string") {
    discriminator = raw.discriminator.propertyName;
  }

  // Determine dataType
  let dataType: FieldSchema["dataType"] = "string";
  if (raw.type === "string") {
    dataType = "string";
  } else if (raw.type === "number" || raw.type === "integer") {
    dataType = "number";
  } else if (raw.type === "boolean") {
    dataType = "boolean";
  } else if (raw.type === "array") {
    dataType = "array";
  } else if (raw.type === "object" || isPlainObject(raw.properties) || raw.additionalProperties !== undefined) {
    dataType = "object";
  } else if (variants) {
    dataType = "any";
  }

  const result: FieldSchema = { dataType };

  if (variants) {
    result.variants = variants;
  }
  if (discriminator) {
    result.discriminator = discriminator;
  }

  if (Array.isArray(raw.required)) {
    const req = raw.required.filter((r): r is string => typeof r === "string");
    if (req.length > 0) {
      result.required = req;
    }
  }

  if (Array.isArray(raw.enum)) {
    result.enum = raw.enum.filter((e): e is string | number | boolean => typeof e === "string" || typeof e === "number" || typeof e === "boolean");
  }

  if (raw.default !== undefined) {
    result.default = raw.default;
  }

  if (typeof raw.additionalProperties === "boolean") {
    result.additionalProperties = raw.additionalProperties;
  }

  if (isPlainObject(raw.properties)) {
    const props: Record<string, FieldSchema> = {};
    for (const [propName, propSchema] of Object.entries(raw.properties)) {
      if (nodeCounter.count >= maxNodes) {
        options.onLoss?.("SCHEMA_NODE_LIMIT", {
          pointer: options.pointer ? `${options.pointer}/properties/${propName}` : undefined,
          reason: `Schema exceeds maximum node count of ${maxNodes}; remaining properties omitted`,
        });
        break;
      }
      props[propName] = mapSchema(root, propSchema, {
        ...options,
        depth: depth + 1,
        visitedRefs,
        nodeCounter,
        maxDepth,
        maxNodes,
        pointer: options.pointer ? `${options.pointer}/properties/${propName}` : undefined,
      });
    }
    result.properties = props;
  }

  if (isPlainObject(raw.items)) {
    if (nodeCounter.count >= maxNodes) {
      options.onLoss?.("SCHEMA_NODE_LIMIT", {
        pointer: options.pointer ? `${options.pointer}/items` : undefined,
        reason: `Schema exceeds maximum node count of ${maxNodes}; items schema omitted`,
      });
    } else {
      result.items = mapSchema(root, raw.items, {
        ...options,
        depth: depth + 1,
        visitedRefs,
        nodeCounter,
        maxDepth,
        maxNodes,
        pointer: options.pointer ? `${options.pointer}/items` : undefined,
      });
    }
  }

  return result;
}
