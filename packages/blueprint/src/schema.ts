import { z } from "zod";
import { LONGTEXT_DEFAULT_LENGTH, LONGTEXT_MAX_LENGTH, MONEY_CURRENCY_SUFFIX, RESERVED_FIELD_NAMES, entitySchema } from "@poc/sdk";
import type { Entity as SdkEntity, EntityField as SdkEntityField } from "@poc/sdk";
import type { Blueprint } from "@poc/assembler";

export const PROJECT_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const BRICK_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const EDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const ENTITY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
export const ENUM_VALUE_PATTERN = /^[a-z0-9_]{1,40}$/;
export const ENTITY_RELATION_PATTERN = /^[a-z][a-z0-9_]{0,39}(?:\.[a-z][a-z0-9_]{0,39})?$/;

const RAW_CREDENTIAL_PREFIX =
  /^(?:sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|rk_test_|whsec_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{8,}|AIza[0-9A-Za-z_-]{10,}|eyJ[A-Za-z0-9_-]{5,}\.|Bearer\s|Basic\s|token\s)/i;
const CLEAN_SECRET_REF_HANDLE = /^(?:sec_[A-Za-z0-9_-]{1,59}|ref_[A-Za-z0-9_-]{1,59}|[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_-]{1,63})$/;

export function isValidSecretRefHandle(ref: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof ref !== "string" || ref.length === 0) {
    return { ok: false, reason: "secret ref handle must be a non-empty string" };
  }
  if (ref.length < 2 || ref.length > 64) {
    return {
      ok: false,
      reason: "secret ref handle must be between 2 and 64 characters",
    };
  }
  if (/\s/.test(ref) || /[=:'"`;\\]/.test(ref) || ref.includes("://")) {
    return {
      ok: false,
      reason: `secret ref "${ref}" looks like a raw credential or URI rather than a secret handle`,
    };
  }
  if (RAW_CREDENTIAL_PREFIX.test(ref)) {
    return {
      ok: false,
      reason: `raw secret value rejected in bind_secret_ref; pass a handle (e.g. "sec_..." or "MY_SECRET_REF") instead`,
    };
  }
  if (!CLEAN_SECRET_REF_HANDLE.test(ref)) {
    return {
      ok: false,
      reason: `secret ref "${ref}" does not match an allowed handle format (sec_<id>, ref_<id>, or identifier)`,
    };
  }
  return { ok: true };
}

export const ProjectSlugSchema = z.string().regex(PROJECT_SLUG_PATTERN);
export const BrickIdSchema = z.string().regex(BRICK_ID_PATTERN);
export const SettingValueSchema = z.union([z.number().finite(), z.string().max(200), z.boolean()]);
export type SettingValue = z.infer<typeof SettingValueSchema>;

export const BrickEntrySchema = z.strictObject({
  id: BrickIdSchema,
  config: z.record(z.string().regex(IDENTIFIER_PATTERN), SettingValueSchema).default({}),
});
export type BrickEntry = z.infer<typeof BrickEntrySchema>;

const entityFieldNameSchema = z
  .string()
  .regex(ENTITY_NAME_PATTERN)
  .refine((n) => !RESERVED_FIELD_NAMES.has(n), {
    message: "this name is used by the system",
  });

const entityFieldCommon = {
  name: entityFieldNameSchema,
  required: z.boolean().default(false),
  unique: z.boolean().optional(),
  indexed: z.boolean().optional(),
  relation: z.string().regex(ENTITY_RELATION_PATTERN).optional(),
  default: z.union([z.string().max(200), z.number().finite(), z.boolean()]).optional(),
};

export const EntityFieldSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("text"),
    maxLength: z.number().int().min(1).max(10_000).default(500),
  }),
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("string"),
    maxLength: z.number().int().min(1).max(10_000).default(500),
  }),
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("number"),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  }),
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("integer"),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  }),
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("boolean"),
  }),
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("enum"),
    values: z.array(z.string().regex(ENUM_VALUE_PATTERN)).min(1).max(20),
  }),
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("json"),
    maxLength: z.number().int().min(1).max(10_000).default(5000),
  }),
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("datetime"),
    maxLength: z.number().int().min(1).max(10_000).default(64),
  }),
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("relation"),
    /** The entity this field points at (`customer`), or `entity.field`, of which only the entity is used. Required. */
    relation: z.string().regex(ENTITY_RELATION_PATTERN),
    /** Kept for declarations written before relations were enforced; a relation's value is a row id, so it is unused. */
    maxLength: z.number().int().min(1).max(10_000).optional(),
  }),
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("date"),
  }),
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("money"),
    currencies: z
      .array(z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter upper-case ISO-4217 code such as INR"))
      .min(1)
      .max(20),
  }),
  z.strictObject({
    ...entityFieldCommon,
    type: z.literal("longtext"),
    maxLength: z.number().int().min(1).max(LONGTEXT_MAX_LENGTH).default(LONGTEXT_DEFAULT_LENGTH),
  }),
]);
export type EntityField = z.infer<typeof EntityFieldSchema>;

export const EntityDefinitionSchema = z
  .strictObject({
    name: z.string().regex(ENTITY_NAME_PATTERN),
    workspaceScoped: z.literal(true).default(true),
    fields: z.array(EntityFieldSchema).min(1).max(200),
  })
  .superRefine((entity, ctx) => {
    const problem = (message: string) => ctx.addIssue({ code: "custom", message });
    const seen = new Set<string>();
    for (const field of entity.fields) {
      if (seen.has(field.name)) problem(`field "${field.name}" is declared twice`);
      seen.add(field.name);
      if ((field.type === "number" || field.type === "integer") && field.min !== undefined && field.max !== undefined && field.min > field.max) {
        problem(`field "${field.name}" has min above max`);
      }
      if (field.type === "enum" && new Set(field.values).size !== field.values.length) {
        problem(`field "${field.name}" lists a value twice`);
      }
      if (field.type === "money" && new Set(field.currencies).size !== field.currencies.length) {
        problem(`field "${field.name}" lists a currency twice`);
      }
    }
    // A money field takes a second column, <name>__currency; no declared field may use that name.
    for (const field of entity.fields) {
      if (field.type === "money" && seen.has(field.name + MONEY_CURRENCY_SUFFIX)) {
        problem(`field "${field.name}${MONEY_CURRENCY_SUFFIX}" uses the name of the currency column of money field "${field.name}"`);
      }
    }
  });
export type EntityDefinition = z.infer<typeof EntityDefinitionSchema>;
export type Entity = EntityDefinition;

export function toSdkEntity(entity: EntityDefinition): SdkEntity {
  return entitySchema.parse({
    name: entity.name,
    workspaceScoped: true,
    fields: entity.fields.map((field): SdkEntityField => {
      switch (field.type) {
        case "text":
        case "string":
        case "json":
        case "datetime":
          return {
            name: field.name,
            type: "text",
            required: field.required ?? false,
            maxLength: field.maxLength ?? 500,
          };
        case "number":
        case "integer":
          return {
            name: field.name,
            type: "number",
            required: field.required ?? false,
            ...(field.min !== undefined ? { min: field.min } : {}),
            ...(field.max !== undefined ? { max: field.max } : {}),
          };
        case "boolean":
          return {
            name: field.name,
            type: "boolean",
            required: field.required ?? false,
          };
        case "enum":
          return {
            name: field.name,
            type: "enum",
            required: field.required ?? false,
            values: [...field.values],
          };
        case "relation":
          // `entity.field` names a column of the target; the SDK relates to the entity's row id, so only the entity
          // part is kept.
          return {
            name: field.name,
            type: "relation",
            required: field.required ?? false,
            relation: field.relation.split(".")[0]!,
          };
        case "date":
          return { name: field.name, type: "date", required: field.required ?? false };
        case "money":
          return {
            name: field.name,
            type: "money",
            required: field.required ?? false,
            currencies: [...field.currencies],
          };
        case "longtext":
          return {
            name: field.name,
            type: "longtext",
            required: field.required ?? false,
            maxLength: field.maxLength,
          };
      }
    }),
  });
}

export const NodePositionSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type NodePosition = z.infer<typeof NodePositionSchema>;

export const WorkflowNodeSchema = z.strictObject({
  id: z.string().regex(NODE_ID_PATTERN),
  type: z.string().min(1).max(120),
  label: z.string().min(1).max(120).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  position: NodePositionSchema.optional(),
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowEdgeSchema = z.strictObject({
  id: z.string().regex(EDGE_ID_PATTERN),
  source: z.string().regex(NODE_ID_PATTERN),
  target: z.string().regex(NODE_ID_PATTERN),
  sourceHandle: z.string().min(1).max(64).optional(),
  targetHandle: z.string().min(1).max(64).optional(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const WorkflowTriggerSchema = z.union([
  z.string().min(1).max(120),
  z.strictObject({
    kind: z.enum(["manual", "webhook", "schedule", "queue", "event"]),
    cron: z.string().max(64).optional(),
    path: z.string().max(120).optional(),
    queue: z.string().max(64).optional(),
    event: z.string().max(120).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

export const WorkflowSchema = z.strictObject({
  id: z.string().regex(WORKFLOW_ID_PATTERN),
  name: z.string().min(1).max(120),
  trigger: WorkflowTriggerSchema.optional(),
  nodes: z.array(WorkflowNodeSchema).default([]),
  edges: z.array(WorkflowEdgeSchema).default([]),
});
export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowDefinition = Workflow;

export const SecretRefTargetKindSchema = z.enum(["brick", "connection"]);
export type SecretRefTargetKind = z.infer<typeof SecretRefTargetKindSchema>;

export const SecretRefSchema = z
  .strictObject({
    ref: z.string().min(2).max(64),
    targetKind: SecretRefTargetKindSchema,
    targetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    secretName: z.string().regex(IDENTIFIER_PATTERN),
  })
  .superRefine((val, ctx) => {
    const check = isValidSecretRefHandle(val.ref);
    if (!check.ok) {
      ctx.addIssue({ code: "custom", path: ["ref"], message: check.reason });
    }
  });
export type SecretRef = z.infer<typeof SecretRefSchema>;

export const ViewportSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().positive(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

export const BlueprintMetadataSchema = z.strictObject({
  displayName: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  catalogVersion: z.string().max(64).optional(),
  layout: z.record(z.string(), NodePositionSchema).optional(),
  viewport: ViewportSchema.optional(),
});
export type BlueprintMetadata = z.infer<typeof BlueprintMetadataSchema>;

export const BlueprintStateSchema = z.strictObject({
  schemaVersion: z.literal(2).optional(),
  project: ProjectSlugSchema,
  identity: BrickIdSchema.default("stub"),
  bricks: z.array(BrickEntrySchema).max(50).default([]),
  entities: z.array(EntityDefinitionSchema).max(20).default([]),
  workflows: z.array(WorkflowSchema).max(50).default([]),
  secretRefs: z.array(SecretRefSchema).max(100).default([]),
  metadata: BlueprintMetadataSchema.default({}),
});
export type BlueprintState = z.infer<typeof BlueprintStateSchema>;

export function sortRecordKeys<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function canonicalizeValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonicalizeValue(v)]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

export function normalizeBlueprintState(state: BlueprintState): BlueprintState {
  const bricks: BrickEntry[] = [...state.bricks]
    .map((b) => ({
      id: b.id,
      config: sortRecordKeys(b.config ?? {}),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const entities: EntityDefinition[] = [...state.entities].map((e) => canonicalizeValue(e)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const workflows: Workflow[] = [...state.workflows]
    .map((w) => ({
      id: w.id,
      name: w.name,
      ...(w.trigger !== undefined ? { trigger: canonicalizeValue(w.trigger) } : {}),
      nodes: [...w.nodes]
        .map((n) => ({
          id: n.id,
          type: n.type,
          ...(n.label !== undefined ? { label: n.label } : {}),
          data: canonicalizeValue(n.data ?? {}),
          ...(n.position !== undefined ? { position: { x: n.position.x, y: n.position.y } } : {}),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      edges: [...w.edges]
        .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          ...(e.sourceHandle !== undefined ? { sourceHandle: e.sourceHandle } : {}),
          ...(e.targetHandle !== undefined ? { targetHandle: e.targetHandle } : {}),
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const secretRefs: SecretRef[] = [...state.secretRefs]
    .map((s) => ({
      ref: s.ref,
      targetKind: s.targetKind,
      targetId: s.targetId,
      secretName: s.secretName,
    }))
    .sort((a, b) => {
      const ka = `${a.targetKind}:${a.targetId}:${a.secretName}:${a.ref}`;
      const kb = `${b.targetKind}:${b.targetId}:${b.secretName}:${b.ref}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  const metadata: BlueprintMetadata = {};
  if (state.metadata?.displayName !== undefined) {
    metadata.displayName = state.metadata.displayName;
  }
  if (state.metadata?.description !== undefined) {
    metadata.description = state.metadata.description;
  }
  if (state.metadata?.catalogVersion !== undefined) {
    metadata.catalogVersion = state.metadata.catalogVersion;
  }
  if (state.metadata?.layout !== undefined) {
    metadata.layout = sortRecordKeys(Object.fromEntries(Object.entries(state.metadata.layout).map(([k, pos]) => [k, { x: pos.x, y: pos.y }])));
  }
  if (state.metadata?.viewport !== undefined) {
    metadata.viewport = {
      x: state.metadata.viewport.x,
      y: state.metadata.viewport.y,
      zoom: state.metadata.viewport.zoom,
    };
  }

  return {
    ...(state.schemaVersion !== undefined ? { schemaVersion: state.schemaVersion } : {}),
    project: state.project,
    identity: state.identity ?? "stub",
    bricks,
    entities,
    workflows,
    secretRefs,
    metadata,
  };
}

export function createEmptyBlueprint(project: string, init?: Partial<Omit<BlueprintState, "project">>): BlueprintState {
  const parsedProject = ProjectSlugSchema.parse(project);
  return normalizeBlueprintState({
    project: parsedProject,
    identity: init?.identity ?? "stub",
    bricks: init?.bricks ?? [],
    entities: init?.entities ?? [],
    workflows: init?.workflows ?? [],
    secretRefs: init?.secretRefs ?? [],
    metadata: init?.metadata ?? {},
    ...(init?.schemaVersion !== undefined ? { schemaVersion: init.schemaVersion } : {}),
  });
}

export function toAssemblerBlueprint(state: BlueprintState): Blueprint {
  const normalized = normalizeBlueprintState(state);
  return {
    project: normalized.project,
    identity: normalized.identity,
    bricks: normalized.bricks.map((b) => (Object.keys(b.config).length > 0 ? { id: b.id, config: b.config } : b.id)),
    entities: normalized.entities.map(toSdkEntity),
    ...(normalized.workflows.length > 0 ? { workflows: normalized.workflows } : {}),
    ...(normalized.secretRefs.length > 0 ? { secretRefs: normalized.secretRefs } : {}),
  };
}
