import { z } from "zod";
import { catalog as defaultCatalog } from "@poc/assembler/catalog";
import type { Catalog } from "@poc/assembler";
import { applyOps } from "./apply.ts";
import type { BlueprintValidationError } from "./apply.ts";
import { semanticHash } from "./hash.ts";
import type { Op } from "./ops.ts";
import {
  BlueprintMetadataSchema,
  BrickIdSchema,
  EntityDefinitionSchema,
  IDENTIFIER_PATTERN,
  ProjectSlugSchema,
  SecretRefTargetKindSchema,
  SettingValueSchema,
  WorkflowSchema,
  canonicalizeValue,
  createEmptyBlueprint,
  isValidSecretRefHandle,
  normalizeBlueprintState,
  sortRecordKeys,
} from "./schema.ts";
import type { BlueprintMetadata, BlueprintState, BrickEntry, Entity, SecretRef, SettingValue, Workflow } from "./schema.ts";

const RAW_SECRET_VALUE_PATTERN =
  /^(?:sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|rk_test_|whsec_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{8,}|AIza[0-9A-Za-z_-]{10,}|eyJ[A-Za-z0-9_-]{5,}\.|Bearer\s|Basic\s|token\s|-----BEGIN\s)/i;

export interface ExportedRevisionMeta {
  revision: number;
  semanticHash: string;
}

export interface BlueprintBundle {
  schemaVersion: 2;
  project: string;
  identity: string;
  bricks: BrickEntry[];
  entities: Entity[];
  workflows: Workflow[];
  secretRefs: SecretRef[];
  metadata: BlueprintMetadata;
  exportedRevision: ExportedRevisionMeta;
}

export class BlueprintExportError extends Error {
  public readonly code = "RAW_SECRET_DETECTED";
  public readonly issues: BlueprintValidationError[];

  constructor(issues: BlueprintValidationError[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
    this.name = "BlueprintExportError";
    this.issues = issues;
  }
}

function scanValueForRawSecrets(value: unknown, path: string, issues: BlueprintValidationError[]): void {
  if (typeof value === "string") {
    if (RAW_SECRET_VALUE_PATTERN.test(value.trim())) {
      issues.push({
        code: "INVALID_SECRET_REF",
        path,
        message: `raw credential value detected at "${path}"; blueprint bundles may only contain secret reference handles`,
        suggestedFix: "Replace the raw secret string with a secret reference handle via bind_secret_ref",
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => scanValueForRawSecrets(item, `${path}.${idx}`, issues));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scanValueForRawSecrets(v, `${path}.${k}`, issues);
    }
  }
}

export function validateBundleNoRawSecrets(state: BlueprintState): BlueprintValidationError[] {
  const issues: BlueprintValidationError[] = [];

  for (const s of state.secretRefs) {
    const check = isValidSecretRefHandle(s.ref);
    if (!check.ok) {
      issues.push({
        code: "INVALID_SECRET_REF",
        path: `secretRefs.${s.targetKind}.${s.targetId}.${s.secretName}`,
        message: check.reason,
        suggestedFix: 'Pass a clean secret reference handle (such as "sec_stripe_key" or "STRIPE_API_KEY_REF"), never a raw secret value',
      });
    }
  }

  for (const b of state.bricks) {
    for (const [key, val] of Object.entries(b.config ?? {})) {
      scanValueForRawSecrets(val, `bricks.${b.id}.config.${key}`, issues);
    }
  }

  for (const w of state.workflows) {
    for (const n of w.nodes) {
      scanValueForRawSecrets(n.data, `workflows.${w.id}.nodes.${n.id}.data`, issues);
    }
  }

  scanValueForRawSecrets(state.metadata, "metadata", issues);

  return issues;
}

export function exportBlueprintBundle(state: BlueprintState, revisionMeta?: Partial<ExportedRevisionMeta>): BlueprintBundle {
  const secretIssues = validateBundleNoRawSecrets(state);
  if (secretIssues.length > 0) {
    throw new BlueprintExportError(secretIssues);
  }

  const normalized = normalizeBlueprintState(state);
  const computedHash = revisionMeta?.semanticHash ?? semanticHash(normalized);
  const revision = revisionMeta?.revision ?? 0;

  return {
    schemaVersion: 2,
    project: normalized.project,
    identity: normalized.identity,
    bricks: normalized.bricks.map((b) => ({
      id: b.id,
      config: sortRecordKeys(b.config),
    })),
    entities: canonicalizeValue(normalized.entities),
    workflows: canonicalizeValue(normalized.workflows),
    secretRefs: normalized.secretRefs.map((s) => ({
      ref: s.ref,
      targetKind: s.targetKind,
      targetId: s.targetId,
      secretName: s.secretName,
    })),
    metadata: canonicalizeValue(normalized.metadata),
    exportedRevision: {
      revision,
      semanticHash: computedHash,
    },
  };
}

export function serializeBlueprintBundle(state: BlueprintState, revisionMeta?: Partial<ExportedRevisionMeta>): string {
  return JSON.stringify(exportBlueprintBundle(state, revisionMeta), null, 2);
}

const RawBrickItemSchema = z.union([
  BrickIdSchema,
  z.strictObject({
    id: BrickIdSchema,
    config: z.record(z.string().regex(IDENTIFIER_PATTERN), SettingValueSchema).default({}),
  }),
]);

const RawSecretRefSchema = z.strictObject({
  ref: z.string(),
  targetKind: SecretRefTargetKindSchema,
  targetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  secretName: z.string().regex(IDENTIFIER_PATTERN),
});

const RawBlueprintBundleSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  project: ProjectSlugSchema,
  identity: BrickIdSchema.optional(),
  bricks: z.array(RawBrickItemSchema).max(50).default([]),
  entities: z.array(EntityDefinitionSchema).max(20).default([]),
  workflows: z.array(WorkflowSchema).max(50).default([]),
  secretRefs: z.array(RawSecretRefSchema).max(100).default([]),
  metadata: BlueprintMetadataSchema.default({}),
  exportedRevision: z
    .strictObject({
      revision: z.number().int().min(0),
      semanticHash: z.string().min(1),
    })
    .optional(),
});

export function buildImportOps(targetState: BlueprintState, currentState?: BlueprintState, opPrefix = "import"): Op[] {
  const normTarget = normalizeBlueprintState(targetState);
  const ops: Op[] = [];
  let seq = 0;
  const nextId = (tag: string) => `${opPrefix}:${++seq}:${tag}`;

  if (currentState) {
    const normCurrent = normalizeBlueprintState(currentState);
    const targetBrickIds = new Set(normTarget.bricks.map((b) => b.id));
    const targetEntityNames = new Set(normTarget.entities.map((e) => e.name));

    if (normCurrent.identity !== "stub" && !targetBrickIds.has(normCurrent.identity)) {
      ops.push({
        opId: nextId("reset-identity"),
        type: "set_identity",
        identity: "stub",
      });
    }

    for (const s of normCurrent.secretRefs) {
      ops.push({
        opId: nextId(`unbind:${s.targetKind}:${s.targetId}:${s.secretName}`),
        type: "unbind_secret_ref",
        targetKind: s.targetKind,
        targetId: s.targetId,
        secretName: s.secretName,
      });
    }

    for (const w of normCurrent.workflows) {
      ops.push({
        opId: nextId(`remove-wf:${w.id}`),
        type: "remove_workflow",
        workflowId: w.id,
      });
    }

    for (const e of normCurrent.entities) {
      if (!targetEntityNames.has(e.name)) {
        ops.push({
          opId: nextId(`remove-entity:${e.name}`),
          type: "remove_entity",
          name: e.name,
        });
      }
    }

    for (const b of normCurrent.bricks) {
      if (!targetBrickIds.has(b.id)) {
        ops.push({
          opId: nextId(`remove-brick:${b.id}`),
          type: "remove_brick",
          brickId: b.id,
        });
      }
    }

    const currentBrickMap = new Map(normCurrent.bricks.map((b) => [b.id, b]));
    for (const b of normTarget.bricks) {
      if (currentBrickMap.has(b.id)) {
        ops.push({
          opId: nextId(`config-brick:${b.id}`),
          type: "configure_brick",
          brickId: b.id,
          config: { ...b.config },
          replace: true,
        });
      } else {
        ops.push({
          opId: nextId(`enable-brick:${b.id}`),
          type: "enable_brick",
          brickId: b.id,
          ...(Object.keys(b.config).length > 0 ? { config: { ...b.config } } : {}),
        });
      }
    }

    if (normTarget.identity !== (normCurrent.identity !== "stub" && !targetBrickIds.has(normCurrent.identity) ? "stub" : normCurrent.identity)) {
      ops.push({
        opId: nextId(`identity:${normTarget.identity}`),
        type: "set_identity",
        identity: normTarget.identity,
      });
    }

    const currentEntityNames = new Set(normCurrent.entities.map((e) => e.name));
    for (const e of normTarget.entities) {
      if (currentEntityNames.has(e.name)) {
        ops.push({
          opId: nextId(`update-entity:${e.name}`),
          type: "update_entity",
          entity: structuredClone(e),
        });
      } else {
        ops.push({
          opId: nextId(`add-entity:${e.name}`),
          type: "add_entity",
          entity: structuredClone(e),
        });
      }
    }

    for (const w of normTarget.workflows) {
      ops.push({
        opId: nextId(`add-wf:${w.id}`),
        type: "add_workflow",
        workflow: structuredClone(w),
      });
    }

    for (const s of normTarget.secretRefs) {
      ops.push({
        opId: nextId(`bind:${s.targetKind}:${s.targetId}:${s.secretName}`),
        type: "bind_secret_ref",
        ref: s.ref,
        targetKind: s.targetKind,
        targetId: s.targetId,
        secretName: s.secretName,
      });
    }

    if (Object.keys(normTarget.metadata).length > 0 || Object.keys(normCurrent.metadata).length > 0 || ops.length === 0) {
      ops.push({
        opId: nextId("metadata"),
        type: "set_metadata",
        metadata: structuredClone(normTarget.metadata),
        replace: true,
      });
    }

    return ops;
  }

  // Fresh import onto empty blueprint state
  for (const b of normTarget.bricks) {
    ops.push({
      opId: nextId(`enable-brick:${b.id}`),
      type: "enable_brick",
      brickId: b.id,
      ...(Object.keys(b.config).length > 0 ? { config: { ...b.config } } : {}),
    });
  }

  if (normTarget.identity !== "stub") {
    ops.push({
      opId: nextId(`identity:${normTarget.identity}`),
      type: "set_identity",
      identity: normTarget.identity,
    });
  }

  for (const e of normTarget.entities) {
    ops.push({
      opId: nextId(`add-entity:${e.name}`),
      type: "add_entity",
      entity: structuredClone(e),
    });
  }

  for (const w of normTarget.workflows) {
    ops.push({
      opId: nextId(`add-wf:${w.id}`),
      type: "add_workflow",
      workflow: structuredClone(w),
    });
  }

  for (const s of normTarget.secretRefs) {
    ops.push({
      opId: nextId(`bind:${s.targetKind}:${s.targetId}:${s.secretName}`),
      type: "bind_secret_ref",
      ref: s.ref,
      targetKind: s.targetKind,
      targetId: s.targetId,
      secretName: s.secretName,
    });
  }

  if (Object.keys(normTarget.metadata).length > 0 || ops.length === 0) {
    ops.push({
      opId: nextId("metadata"),
      type: "set_metadata",
      metadata: structuredClone(normTarget.metadata),
      replace: true,
    });
  }

  return ops;
}

export type ParseBlueprintBundleResult =
  | {
      ok: true;
      bundle: BlueprintBundle;
      state: BlueprintState;
      ops: Op[];
      semanticHash: string;
    }
  | {
      ok: false;
      errors: BlueprintValidationError[];
    };

export function parseBlueprintBundle(
  input: unknown,
  options?: {
    targetProject?: string;
    catalog?: Catalog;
    opPrefix?: string;
  },
): ParseBlueprintBundleResult {
  const catalog = options?.catalog ?? defaultCatalog;

  let rawObj: unknown = input;
  if (typeof input === "string") {
    try {
      rawObj = JSON.parse(input);
    } catch {
      return {
        ok: false,
        errors: [
          {
            code: "INVALID_BUNDLE_JSON",
            path: "bundle",
            message: "Bundle string is not valid JSON",
            suggestedFix: "Provide a valid JSON object or string matching saas.blueprint.json",
          },
        ],
      };
    }
  }

  if (
    typeof rawObj === "object" &&
    rawObj !== null &&
    "blueprint" in rawObj &&
    typeof (rawObj as { blueprint?: unknown }).blueprint === "object" &&
    (rawObj as { blueprint?: unknown }).blueprint !== null
  ) {
    rawObj = (rawObj as { blueprint: unknown }).blueprint;
  }

  const parsed = RawBlueprintBundleSchema.safeParse(rawObj);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: "INVALID_BUNDLE_SCHEMA",
        path: issue.path.join(".") || "bundle",
        message: issue.message,
        suggestedFix: "Ensure bundle conforms to v1 or v2 saas.blueprint.json schema",
      })),
    };
  }

  const rawData = parsed.data;
  const effectiveProject = options?.targetProject ?? rawData.project;
  if (!ProjectSlugSchema.safeParse(effectiveProject).success) {
    return {
      ok: false,
      errors: [
        {
          code: "INVALID_PROJECT_SLUG",
          path: "project",
          message: `Invalid project slug "${effectiveProject}"`,
          suggestedFix: "Use a lowercase slug matching ^[a-z][a-z0-9-]{0,39}$",
        },
      ],
    };
  }

  const normalizedBricks: BrickEntry[] = rawData.bricks.map((item) =>
    typeof item === "string"
      ? { id: item, config: {} as Record<string, SettingValue> }
      : { id: item.id, config: (item.config ?? {}) as Record<string, SettingValue> },
  );

  // Check for duplicate bricks in the raw bundle before normalization
  const seenBricks = new Set<string>();
  for (const b of normalizedBricks) {
    if (seenBricks.has(b.id)) {
      return {
        ok: false,
        errors: [
          {
            code: "DUPLICATE_BRICK",
            path: `bricks.${b.id}`,
            message: `brick "${b.id}" is listed more than once in bundle`,
            suggestedFix: `List brick "${b.id}" only once in bricks`,
          },
        ],
      };
    }
    seenBricks.add(b.id);
  }

  const candidateState: BlueprintState = {
    schemaVersion: 2,
    project: effectiveProject,
    identity: rawData.identity ?? "stub",
    bricks: normalizedBricks,
    entities: rawData.entities,
    workflows: rawData.workflows,
    secretRefs: rawData.secretRefs,
    metadata: rawData.metadata,
  };

  const secretIssues = validateBundleNoRawSecrets(candidateState);
  if (secretIssues.length > 0) {
    return {
      ok: false,
      errors: secretIssues,
    };
  }

  const ops = buildImportOps(candidateState, undefined, options?.opPrefix ?? "import");
  const emptyState = createEmptyBlueprint(effectiveProject);
  const applied = applyOps(emptyState, ops, catalog);
  if (!applied.ok) {
    return {
      ok: false,
      errors: applied.errors,
    };
  }

  const finalState = applied.state;
  const finalHash = semanticHash(finalState);
  const bundle = exportBlueprintBundle(finalState, {
    revision: rawData.exportedRevision?.revision ?? 0,
    semanticHash: finalHash,
  });

  return {
    ok: true,
    bundle,
    state: finalState,
    ops,
    semanticHash: finalHash,
  };
}
