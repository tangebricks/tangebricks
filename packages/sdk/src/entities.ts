import { z } from "zod";
import type { BudgetIssue } from "./budget.ts";
import { PLATFORM_LIMITS } from "./platform-limits.ts";

// The contract for a declared entity: what an owner may write, the names it may use, and the table it becomes. The
// assembler uses it to write the migration and the router uses it, at run time, to build its validation and its SQL from
// the same declaration, so the two cannot disagree about a column. Nothing here knows any particular entity.
//
// Every name that can reach SQL text (a table, a column, an enum value) must match a strict pattern first. Values from a
// request never reach SQL text at all: they are bound as parameters.

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const ENUM_VALUE = /^[a-z0-9_]{1,40}$/;

/** Columns the router adds itself, and names SQLite treats as the row id. A declared field may not take any of them. */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(["id", "workspace_id", "created_at", "updated_at", "rowid", "oid", "_rowid_"]);

const fieldName = z.string().regex(NAME).refine((n) => !RESERVED_FIELD_NAMES.has(n), { message: "this name is used by the system" });
const required = z.boolean().default(false);

const fieldSchema = z.discriminatedUnion("type", [
  z.strictObject({ name: fieldName, type: z.literal("text"), required, maxLength: z.number().int().min(1).max(10_000).default(500) }),
  z.strictObject({ name: fieldName, type: z.literal("number"), required, min: z.number().int().optional(), max: z.number().int().optional() }),
  z.strictObject({ name: fieldName, type: z.literal("boolean"), required }),
  z.strictObject({ name: fieldName, type: z.literal("enum"), required, values: z.array(z.string().regex(ENUM_VALUE)).min(1).max(20) }),
]);
export type EntityField = z.infer<typeof fieldSchema>;

export const entitySchema = z
  .strictObject({
    name: z.string().regex(NAME),
    /** Only workspace-scoped entities exist: every row belongs to one workspace. Written out so a declaration says so. */
    workspaceScoped: z.literal(true).default(true),
    fields: z.array(fieldSchema).min(1).max(200),
  })
  .superRefine((entity, ctx) => {
    const problem = (message: string) => ctx.addIssue({ code: "custom", message });
    const seen = new Set<string>();
    for (const field of entity.fields) {
      if (seen.has(field.name)) problem(`field "${field.name}" is declared twice`);
      seen.add(field.name);
      if (field.type === "number" && field.min !== undefined && field.max !== undefined && field.min > field.max) problem(`field "${field.name}" has min above max`);
      if (field.type === "enum" && new Set(field.values).size !== field.values.length) problem(`field "${field.name}" lists a value twice`);
    }
  });
export type Entity = z.infer<typeof entitySchema>;

export type ParsedEntities =
  | { ok: true; entities: Entity[] }
  | { ok: false; errors: string[]; issues?: BudgetIssue[] };

/**
 * Checks a list of declarations. `reserved` is the set of route names some other part of the project already uses; an
 * entity may not take one. The result is sorted by name, so the order the owner wrote them in never changes the project.
 */
export function parseEntities(
  input: unknown,
  reserved: ReadonlySet<string> = new Set(),
  plan: "free" | "paid" = "free",
): ParsedEntities {
  const parsed = z.array(entitySchema).max(20).safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `entities${i.path.length > 0 ? "." + i.path.join(".") : ""}: ${i.message}`) };
  }
  const errors: string[] = [];
  const issues: BudgetIssue[] = [];
  const names = new Set<string>();
  const d1ParamLimit = PLATFORM_LIMITS[plan]?.d1BindParams.limit ?? 100;

  for (const entity of parsed.data) {
    if (names.has(entity.name)) errors.push(`entity "${entity.name}" is declared twice`);
    names.add(entity.name);
    if (reserved.has(entity.name)) errors.push(`entity "${entity.name}" uses a name that a brick's routes already use`);

    // D1 bind parameter check: fields + 4 system columns (id, workspace_id, created_at, updated_at) <= 100
    const measuredParams = entity.fields.length + 4;
    if (measuredParams > d1ParamLimit) {
      const msg = `[D1_BIND_PARAMS_EXCEEDED] entity "${entity.name}" defines ${entity.fields.length} fields (+ 4 system columns = ${measuredParams}), which exceeds the D1 bind parameter limit of ${d1ParamLimit} on plan ${plan}`;
      errors.push(msg);
      issues.push({
        code: "D1_BIND_PARAMS_EXCEEDED",
        nodeId: entity.name,
        message: `Entity "${entity.name}" defines ${entity.fields.length} fields (+ 4 system columns = ${measuredParams}), which exceeds the D1 limit of ${d1ParamLimit} bind parameters`,
        severity: "error",
        measured: measuredParams,
        limit: d1ParamLimit,
        plan,
        fix: "Split the entity into smaller tables or reduce field count to <= 96",
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors, ...(issues.length > 0 ? { issues } : {}) };
  return { ok: true, entities: [...parsed.data].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}

/** The table an entity is stored in. The prefix keeps it clear of every brick's tables and of SQLite's own. */
export const tableName = (entity: Pick<Entity, "name">): string => `ent_${entity.name}`;

const q = (identifier: string): string => `"${identifier}"`;

function columnSql(field: EntityField): string {
  const notNull = field.required ? " NOT NULL" : "";
  const name = q(field.name);
  switch (field.type) {
    case "text":
      return `${name} TEXT${notNull} CHECK (length(${name}) <= ${field.maxLength})`;
    case "number": {
      const bounds = [field.min !== undefined ? `${name} >= ${field.min}` : null, field.max !== undefined ? `${name} <= ${field.max}` : null].filter(Boolean);
      return `${name} INTEGER${notNull}${bounds.length > 0 ? ` CHECK (${bounds.join(" AND ")})` : ""}`;
    }
    case "boolean":
      return `${name} INTEGER${notNull} CHECK (${name} IN (0, 1))`;
    case "enum":
      return `${name} TEXT${notNull} CHECK (${name} IN (${field.values.map((v) => `'${v}'`).join(", ")}))`;
  }
}

/** The CREATE TABLE and CREATE INDEX for an entity. Only validated names and values appear in it; it contains no semicolon except between statements. */
export function entityDdl(entity: Entity): string {
  const table = tableName(entity);
  const columns = [
    `${q("id")} TEXT PRIMARY KEY`,
    `${q("workspace_id")} TEXT NOT NULL`,
    ...entity.fields.map(columnSql),
    `${q("created_at")} TEXT NOT NULL DEFAULT (datetime('now'))`,
    `${q("updated_at")} TEXT NOT NULL DEFAULT (datetime('now'))`,
  ];
  return (
    `-- Generated from the blueprint's declaration of ${entity.name}. Do not edit.\n` +
    `CREATE TABLE IF NOT EXISTS ${q(table)} (\n  ${columns.join(",\n  ")}\n);\n\n` +
    `CREATE INDEX IF NOT EXISTS ${q(table + "_workspace_idx")} ON ${q(table)}(${q("workspace_id")}, ${q("created_at")});\n`
  );
}
