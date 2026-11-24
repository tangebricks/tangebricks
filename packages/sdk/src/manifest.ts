import { z } from "zod";

/** One connection point on a brick. Two ports connect when their data types match or either is "any". */
export interface PortDescriptor {
  id: string;
  label?: string;
  dataType: string;
  required?: boolean;
}

export type CatalogNodeSettingDef =
  | { type: "string"; minLength?: number; maxLength?: number; default?: string; widget?: string }
  | { type: "integer"; min?: number; max?: number; default?: number; widget?: string }
  | { type: "number"; min?: number; max?: number; default?: number; widget?: string }
  | { type: "boolean"; default?: boolean; widget?: string }
  | { type: "enum"; values: readonly string[]; default?: string; widget?: string };

export interface CatalogNodeDescriptor {
  readonly type: string;
  readonly label: string;
  readonly summary?: string;
  readonly role: "trigger" | "action" | "logic";
  readonly inputs: readonly PortDescriptor[];
  readonly outputs: readonly PortDescriptor[];
  readonly config?: Readonly<Record<string, CatalogNodeSettingDef>>;
  readonly secrets?: readonly string[];
  readonly bindings?: readonly string[];
  readonly executor: string;
  readonly durable: boolean;
  readonly sideEffects: "none" | "read" | "write";
  /** The node can carry an idempotency key the provider honours, so a `write` may be retried safely (UC7.2). */
  readonly idempotent?: boolean;
  /** May lower the retry limit derived from `sideEffects`; never raises a non-idempotent write above 0. */
  readonly retry?: { readonly limit?: number };
  readonly availability?: "available" | "unsupported";
  readonly isolation?: "none" | "dispatch";
  readonly brickId?: string;
}

function settingDefToZod(def: CatalogNodeSettingDef): z.ZodType {
  switch (def.type) {
    case "string": {
      let s = z.string();
      if (def.minLength !== undefined) s = s.min(def.minLength);
      if (def.maxLength !== undefined) s = s.max(def.maxLength);
      return def.default !== undefined ? s.optional() : s;
    }
    case "integer": {
      let n = z.number().int();
      if (def.min !== undefined) n = n.min(def.min);
      if (def.max !== undefined) n = n.max(def.max);
      return def.default !== undefined ? n.optional() : n;
    }
    case "number": {
      let n = z.number();
      if (def.min !== undefined) n = n.min(def.min);
      if (def.max !== undefined) n = n.max(def.max);
      return def.default !== undefined ? n.optional() : n;
    }
    case "boolean": {
      const b = z.boolean();
      return def.default !== undefined ? b.optional() : b;
    }
    case "enum": {
      const values = def.values.length > 0 ? (def.values as [string, ...string[]]) : ["default"];
      const e = z.enum(values);
      return def.default !== undefined ? e.optional() : e;
    }
  }
}

export function catalogNodeToBrickManifest(node: CatalogNodeDescriptor): BrickManifest {
  const shape: Record<string, z.ZodType> = {};
  const secretFields: string[] = [];
  for (const [key, def] of Object.entries(node.config ?? {})) {
    shape[key] = settingDefToZod(def);
    if (def.widget === "secret") {
      secretFields.push(key);
    }
  }
  const inputs: PortDescriptor[] = node.inputs.map((p) => ({
    id: p.id,
    ...(p.label !== undefined ? { label: p.label } : {}),
    dataType: p.dataType,
    ...(p.required !== undefined ? { required: p.required } : {}),
  }));
  if (node.type === "core.math" && !inputs.some((p) => p.id === "number")) {
    inputs.push({ id: "number", label: "Number", dataType: "number" });
  }
  return {
    type: node.type,
    label: node.label,
    summary: node.summary,
    category: node.role,
    inputs,
    outputs: node.outputs.map((p) => ({
      id: p.id,
      ...(p.label !== undefined ? { label: p.label } : {}),
      dataType: p.dataType,
      ...(p.required !== undefined ? { required: p.required } : {}),
    })),
    configSchema: z.object(shape).passthrough(),
    secrets: [...(node.secrets ?? [])],
    ...(secretFields.length > 0 ? { secretFields } : {}),
    ...(node.bindings && node.bindings.length > 0 ? { bindings: [...node.bindings] } : {}),
    executor: node.executor,
    durable: node.durable,
    sideEffects: node.sideEffects,
    ...(node.idempotent !== undefined ? { idempotent: node.idempotent } : {}),
    ...(node.retry ? { retry: { ...node.retry } } : {}),
    ...(node.availability ? { availability: node.availability } : {}),
    ...(node.isolation ? { isolation: node.isolation } : {}),
    ...(node.brickId ? { brickId: node.brickId } : {}),
  };
}

/** What a brick declares about itself. The validator and, later, the runtime read only this. */
export interface BrickManifest {
  type: string;
  label?: string;
  summary?: string;
  category: "trigger" | "action" | "transform" | "logic";
  inputs: PortDescriptor[];
  outputs: PortDescriptor[];
  /** Checked against a node's `data` by the validator. */
  configSchema: z.ZodType;
  /** The only secrets an executor of this brick may read (enforced by the runtime). */
  secrets: string[];
  /** Config field keys marked with widget: "secret" in the manifest for telemetry redaction. */
  secretFields?: string[];
  /**
   * The only host bindings (a D1 database, a queue, ...) an executor of this brick may be handed, by name. Enforced
   * by the runtime the same way as `secrets`, and kept separate from them: a name listed here cannot be read as a
   * secret, and the reverse. Absent means none.
   */
  bindings?: string[];
  executor?: string;
  durable?: boolean;
  sideEffects?: "none" | "read" | "write";
  idempotent?: boolean;
  retry?: { limit?: number };
  availability?: "available" | "unsupported";
  isolation?: "none" | "dispatch";
  brickId?: string;
}

export type Registry = ReadonlyMap<string, BrickManifest>;

export function createRegistry(bricks: BrickManifest[]): Registry {
  const registry = new Map<string, BrickManifest>();
  for (const brick of bricks) {
    if (registry.has(brick.type)) throw new Error(`duplicate brick type: ${brick.type}`);
    registry.set(brick.type, brick);
  }
  return registry;
}
