import { z } from "zod";
import type { BudgetIssue } from "./budget.ts";
import { PLATFORM_LIMITS } from "./platform-limits.ts";

// The contract for a declared entity: what an owner may write, the names it may use, and the table it becomes. The
// assembler uses it to write the migration and the router uses it, at run time, to build its validation and its SQL from
// the same declaration, so the two cannot disagree about a column. Nothing here knows any particular entity.
//
// Every name that can reach SQL text (a table, a column, an enum value, a currency code) must match a strict pattern
// first. Values from a request never reach SQL text at all: they are bound as parameters.

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const ENUM_VALUE = /^[a-z0-9_]{1,40}$/;
const CURRENCY = /^[A-Z]{3}$/;

/** The longest a `longtext` field may be declared, and its length when no maxLength is given. */
export const LONGTEXT_MAX_LENGTH = 100_000;
export const LONGTEXT_DEFAULT_LENGTH = 20_000;

/** The suffix of the second column a `money` field is stored in: `<name>` holds the amount, `<name>__currency` the currency. */
export const MONEY_CURRENCY_SUFFIX = "__currency";

/**
 * Keys agents reach for when they mean `relation`. A field carrying one of them is refused with a pointer to the one
 * canonical key, so the agent can correct itself instead of guessing again.
 */
export const WRONG_RELATION_KEYS: ReadonlySet<string> = new Set(["target", "entity", "to", "references", "targetEntity"]);

/** The pointer added to an "unrecognized key" error when a key is one of {@link WRONG_RELATION_KEYS}; null otherwise. */
export function relationKeyHint(keys: readonly unknown[] | undefined): string | null {
  const wrong = (keys ?? []).filter((k): k is string => typeof k === "string" && WRONG_RELATION_KEYS.has(k));
  if (wrong.length === 0) return null;
  return `${wrong.map((k) => `"${k}"`).join(", ")} is not a field key: to point a field at another entity, use type "relation" with the "relation" key, e.g. {"name":"customer_id","type":"relation","relation":"customer"}`;
}

/** Columns the router adds itself, and names SQLite treats as the row id. A declared field may not take any of them. */
export const RESERVED_FIELD_NAMES: ReadonlySet<string> = new Set(["id", "workspace_id", "created_at", "updated_at", "rowid", "oid", "_rowid_"]);

const fieldName = z.string().regex(NAME).refine((n) => !RESERVED_FIELD_NAMES.has(n), { message: "this name is used by the system" });
const required = z.boolean().default(false);

const fieldSchema = z.discriminatedUnion("type", [
  z.strictObject({ name: fieldName, type: z.literal("text"), required, maxLength: z.number().int().min(1).max(10_000).default(500) }),
  z.strictObject({ name: fieldName, type: z.literal("number"), required, min: z.number().int().optional(), max: z.number().int().optional() }),
  z.strictObject({ name: fieldName, type: z.literal("boolean"), required }),
  z.strictObject({ name: fieldName, type: z.literal("enum"), required, values: z.array(z.string().regex(ENUM_VALUE)).min(1).max(20) }),
  /** The id of a row of a declared entity (another one, or this one) in the same workspace. `relation` names the entity. */
  z.strictObject({ name: fieldName, type: z.literal("relation"), required, relation: z.string().regex(NAME) }),
  /** A calendar date, `YYYY-MM-DD`. */
  z.strictObject({ name: fieldName, type: z.literal("date"), required }),
  /** `{amount, currency}`: amount an integer in minor units, currency one of the declared ISO-4217 codes. */
  z.strictObject({
    name: fieldName,
    type: z.literal("money"),
    required,
    currencies: z.array(z.string().regex(CURRENCY, "must be a 3-letter upper-case ISO-4217 code such as INR")).min(1).max(20),
  }),
  z.strictObject({ name: fieldName, type: z.literal("longtext"), required, maxLength: z.number().int().min(1).max(LONGTEXT_MAX_LENGTH).default(LONGTEXT_DEFAULT_LENGTH) }),
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
      if (field.type === "money" && new Set(field.currencies).size !== field.currencies.length) problem(`field "${field.name}" lists a currency twice`);
    }
    // A money field takes a second column, <name>__currency; no declared field may use that name.
    for (const field of entity.fields) {
      if (field.type === "money" && seen.has(field.name + MONEY_CURRENCY_SUFFIX)) {
        problem(`field "${field.name}${MONEY_CURRENCY_SUFFIX}" uses the name of the currency column of money field "${field.name}"`);
      }
    }
  });
export type Entity = z.infer<typeof entitySchema>;

export type ParsedEntities =
  | { ok: true; entities: Entity[] }
  | { ok: false; errors: string[]; issues?: BudgetIssue[] };

/** The columns a field is stored in: one, except a money field, which also has `<name>__currency`. */
export function fieldColumns(field: EntityField): string[] {
  return field.type === "money" ? [field.name, field.name + MONEY_CURRENCY_SUFFIX] : [field.name];
}

/** One message per relation field whose target is neither among `entities` nor in `known`. */
export function relationTargetErrors(entities: ReadonlyArray<Pick<Entity, "name" | "fields">>, known: ReadonlySet<string> = new Set()): string[] {
  const names = new Set([...known, ...entities.map((e) => e.name)]);
  const errors: string[] = [];
  for (const entity of entities) {
    for (const field of entity.fields) {
      if (field.type === "relation" && !names.has(field.relation)) {
        errors.push(
          `entity "${entity.name}" field "${field.name}" relates to entity "${field.relation}", which is not declared in this project; declare "${field.relation}" too, or relate to an entity that exists`,
        );
      }
    }
  }
  return errors;
}

export interface ParseEntitiesOptions {
  /** Entities declared elsewhere in the same project, which a relation may also target. */
  knownEntities?: ReadonlySet<string>;
  /** Skip the relation-target check; for a caller that checks the final set itself (a batch may add the target later). */
  skipRelationTargets?: boolean;
}

function describeEntityIssue(issue: z.core.$ZodIssue): string {
  const where = `entities${issue.path.length > 0 ? "." + issue.path.join(".") : ""}`;
  const hint = issue.code === "unrecognized_keys" ? relationKeyHint(issue.keys) : null;
  return `${where}: ${issue.message}${hint ? ` (${hint})` : ""}`;
}

/**
 * Checks a list of declarations. `reserved` is the set of route names some other part of the project already uses; an
 * entity may not take one. Every relation must target an entity in the list (or in `options.knownEntities`). The result
 * is sorted by name, so the order the owner wrote them in never changes the project.
 */
export function parseEntities(
  input: unknown,
  reserved: ReadonlySet<string> = new Set(),
  plan: "free" | "paid" = "free",
  options: ParseEntitiesOptions = {},
): ParsedEntities {
  const parsed = z.array(entitySchema).max(20).safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(describeEntityIssue) };
  }
  const errors: string[] = [];
  const issues: BudgetIssue[] = [];
  const names = new Set<string>();
  const d1ParamLimit = PLATFORM_LIMITS[plan]?.d1BindParams.limit ?? 100;

  for (const entity of parsed.data) {
    if (names.has(entity.name)) errors.push(`entity "${entity.name}" is declared twice`);
    names.add(entity.name);
    if (reserved.has(entity.name)) errors.push(`entity "${entity.name}" uses a name that a brick's routes already use`);

    // D1 bind parameter check: field columns + 4 system columns (id, workspace_id, created_at, updated_at) <= 100.
    // A money field is two columns.
    const fieldColumnCount = entity.fields.reduce((n, f) => n + fieldColumns(f).length, 0);
    const measuredParams = fieldColumnCount + 4;
    if (measuredParams > d1ParamLimit) {
      const msg = `[D1_BIND_PARAMS_EXCEEDED] entity "${entity.name}" defines ${fieldColumnCount} fields (+ 4 system columns = ${measuredParams}), which exceeds the D1 bind parameter limit of ${d1ParamLimit} on plan ${plan}`;
      errors.push(msg);
      issues.push({
        code: "D1_BIND_PARAMS_EXCEEDED",
        nodeId: entity.name,
        message: `Entity "${entity.name}" defines ${fieldColumnCount} fields (+ 4 system columns = ${measuredParams}), which exceeds the D1 limit of ${d1ParamLimit} bind parameters`,
        severity: "error",
        measured: measuredParams,
        limit: d1ParamLimit,
        plan,
        fix: "Split the entity into smaller tables or reduce field count to <= 96",
      });
    }
  }
  if (!options.skipRelationTargets) errors.push(...relationTargetErrors(parsed.data, options.knownEntities));
  if (errors.length > 0) return { ok: false, errors, ...(issues.length > 0 ? { issues } : {}) };
  return { ok: true, entities: [...parsed.data].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
}

/** The table an entity is stored in. The prefix keeps it clear of every brick's tables and of SQLite's own. */
export const tableName = (entity: Pick<Entity, "name">): string => `ent_${entity.name}`;

const q = (identifier: string): string => `"${identifier}"`;

/**
 * The column definitions of a field, one per column (a money field has two), each `"name" TYPE CHECK (...)` without NOT
 * NULL. For adding a field to an existing table with ALTER TABLE ... ADD COLUMN, with the same CHECK a new table gets.
 */
export function columnDefinitions(field: EntityField): string[] {
  return columnSql({ ...field, required: false }).split(",\n  ");
}

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
    // A relation holds a row id (a UUID). No FOREIGN KEY: the router checks the row exists in the same workspace, and
    // deleting the referenced row stays allowed.
    case "relation":
      return `${name} TEXT${notNull} CHECK (length(${name}) = 36)`;
    // date() gives NULL for a string that is not a date and normalises one that overflows (2026-02-30), so only a real
    // YYYY-MM-DD equals its own date(). IS rather than =, so that a NULL from date() fails the check instead of passing.
    case "date":
      return `${name} TEXT${notNull} CHECK (${name} IS date(${name}))`;
    // Two columns: the amount in minor units, and its currency, which must be declared and present exactly when the
    // amount is.
    case "money": {
      const currency = q(field.name + MONEY_CURRENCY_SUFFIX);
      return (
        `${name} INTEGER${notNull} CHECK (typeof(${name}) IN ('integer', 'null')),\n  ` +
        `${currency} TEXT${notNull} CHECK (${currency} IN (${field.currencies.map((c) => `'${c}'`).join(", ")}) AND ((${name} IS NULL) = (${currency} IS NULL)))`
      );
    }
    case "longtext":
      return `${name} TEXT${notNull} CHECK (length(${name}) <= ${field.maxLength})`;
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
