// Story 1.32: build a valid create (and update) for an entity from an app's own published openapi.json, nothing else.
//
// A client that only has the document (the benchmark harness, a second agent, the product test) needs three things the
// schema now says in machine-readable form:
//   - a relation property names its target entity in `x-relation`, so the target row is created first (recursively, up
//     to a depth limit, refusing cycles);
//   - money is an object of an integer `amount` and a `currency` from the declared list;
//   - date, date-time, enum, number bounds and text maxLength are plain JSON Schema.
// The benchmark harness (scripts/agent-bench.ts) and the assembler's workerd test both use this one module, so they
// cannot disagree about what a valid payload is. It imports nothing, so it runs in Node and in workerd alike.

type Schema = Record<string, unknown>;

/** A field as the blueprint (type, values, min, max, maxLength, currencies, relation) or the OpenAPI schema describes it. */
export type FieldLike = {
  type?: unknown;
  values?: unknown;
  enum?: unknown;
  format?: unknown;
  min?: unknown;
  max?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  maxLength?: unknown;
  currencies?: unknown;
  relation?: unknown;
  properties?: unknown;
  "x-relation"?: unknown;
};

const numberOr = (...vs: unknown[]) => vs.find((v): v is number => typeof v === "number" && Number.isFinite(v));

/** An integer inside the field's [min, max]. */
function fitNumber(want: number, field: FieldLike): number {
  const min = numberOr(field.min, field.minimum);
  const max = numberOr(field.max, field.maximum);
  let v = Math.round(want);
  if (min !== undefined && v < min) v = Math.ceil(min);
  if (max !== undefined && v > max) v = Math.floor(max);
  return v;
}

/** Text cut to the field's maxLength (never below one character). */
function fitText(text: string, field: FieldLike): string {
  const maxLength = numberOr(field.maxLength);
  return maxLength === undefined ? text : text.slice(0, Math.max(1, Math.floor(maxLength)));
}

const choicesOf = (field: FieldLike): unknown[] | null => {
  const values = Array.isArray(field.values) ? field.values : Array.isArray(field.enum) ? field.enum : null;
  return values && values.length > 0 ? values : null;
};
const isNumeric = (field: FieldLike) => field.type === "number" || field.type === "integer";

/** The entity a relation field points at (`x-relation` in the document, `relation` in the blueprint), or null. */
function relationTarget(field: FieldLike): string | null {
  const target = field["x-relation"] ?? (field.type === "relation" ? field.relation : undefined);
  return typeof target === "string" && target.length > 0 ? target : null;
}
/** Only a field that names its target is a relation; a plain `format: uuid` string is just a string (it gets a fresh uuid). */
const isRelation = (field: FieldLike) => relationTarget(field) !== null;

/** The declared currencies of a money field: the blueprint's `currencies`, or the schema's `properties.currency.enum`. */
function moneyCurrencies(field: FieldLike): unknown[] | null {
  if (field.type === "money") return Array.isArray(field.currencies) ? field.currencies : [];
  if (field.type !== "object" || typeof field.properties !== "object" || field.properties === null) return null;
  const props = field.properties as Record<string, Schema | undefined>;
  if (!props.amount || !props.currency) return null;
  return Array.isArray(props.currency.enum) ? props.currency.enum : [];
}

type Kind = "relation" | "money" | "enum" | "number" | "boolean" | "date" | "datetime" | "uuid" | "object" | "text";

function kindOf(field: FieldLike): Kind {
  if (isRelation(field)) return "relation";
  if (moneyCurrencies(field) !== null) return "money";
  if (choicesOf(field)) return "enum";
  if (isNumeric(field)) return "number";
  if (field.type === "boolean") return "boolean";
  if (field.type === "date" || (field.type === "string" && field.format === "date")) return "date";
  if (field.type === "datetime" || field.format === "date-time") return "datetime";
  if (field.format === "uuid") return "uuid";
  if (field.type === "json" || field.type === "object") return "object";
  return "text";
}

const SAMPLE_DATE = "2026-01-15";
const SAMPLE_AMOUNT = 1000;

/**
 * A value a field accepts, from its type and constraints. A relation has no value of its own: pass the id of an existing
 * row of its target as `relationId` (createFromOpenApi does), or this throws.
 */
export function sampleValue(field: FieldLike, label: string, relationId?: string): unknown {
  switch (kindOf(field)) {
    case "relation":
      if (relationId === undefined) throw new Error(`a relation${relationTarget(field) ? ` to ${relationTarget(field)}` : ""} needs the id of an existing row`);
      return relationId;
    case "money": {
      const currencies = moneyCurrencies(field)!;
      return { amount: SAMPLE_AMOUNT, currency: currencies[0] ?? "USD" };
    }
    case "enum":
      return choicesOf(field)![0];
    case "number":
      return fitNumber(Math.max(1, numberOr(field.min, field.minimum) ?? 1), field);
    case "boolean":
      return true;
    case "date":
      return SAMPLE_DATE;
    case "datetime":
      return new Date().toISOString();
    case "uuid":
      return crypto.randomUUID();
    case "object":
      return {};
    case "text":
      return fitText(label, field);
  }
}

/** The day after a YYYY-MM-DD date (or the sample date when `current` is not one). */
function nextDay(current: unknown): string {
  const ms = typeof current === "string" && /^\d{4}-\d{2}-\d{2}$/.test(current) ? Date.parse(`${current}T00:00:00Z`) : NaN;
  return Number.isNaN(ms) ? SAMPLE_DATE : new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

/** A different value for an update, still inside the field's constraints (the same value when the field allows only one). */
export function updatedValue(field: FieldLike, current: unknown): unknown {
  switch (kindOf(field)) {
    case "relation":
      return current;
    case "money": {
      const currencies = moneyCurrencies(field)!;
      const was = (current ?? {}) as { amount?: unknown; currency?: unknown };
      const amount = typeof was.amount === "number" ? was.amount + 1 : SAMPLE_AMOUNT;
      return { amount, currency: typeof was.currency === "string" ? was.currency : (currencies[0] ?? "USD") };
    }
    case "enum": {
      const values = choicesOf(field)!;
      return values.find((v) => v !== current) ?? values[0];
    }
    case "number": {
      const base = typeof current === "number" ? current : 0;
      const up = fitNumber(base + 1, field);
      return up !== base ? up : fitNumber(base - 1, field);
    }
    case "boolean":
      return current !== true;
    case "date":
      return nextDay(current);
    case "datetime":
      return new Date(Date.now() + 60_000).toISOString();
    case "uuid":
      return crypto.randomUUID();
    case "object":
      return { updated: true };
    case "text": {
      const next = fitText("updated", field);
      return next !== current ? next : fitText("z", field);
    }
  }
}

/** The order an update prefers a field in: plain text first (as before story 1.32), then every other non-relation type. */
const UPDATE_PREFERENCE: Kind[] = ["text", "number", "money", "date", "enum", "datetime", "boolean", "uuid", "object"];

/** False for a field that allows only one value (a one-value enum, a number whose [min, max] holds one integer): an update to it changes nothing. */
function canChange(field: FieldLike, kind: Kind): boolean {
  if (kind === "enum") return choicesOf(field)!.length >= 2;
  if (kind === "number") {
    const min = numberOr(field.min, field.minimum);
    const max = numberOr(field.max, field.maximum);
    return min === undefined || max === undefined || Math.floor(max) > Math.ceil(min);
  }
  return true;
}

/**
 * The field an update step changes: any non-relation field of a supported type that can take a different value, in
 * UPDATE_PREFERENCE order. Null when there is none (only relations, or only fields with a single allowed value): then
 * there is no update step.
 */
export function updateFieldOf<F extends FieldLike>(fields: ReadonlyArray<readonly [string, F]>): readonly [string, F] | null {
  const ranked = fields
    .map((entry) => ({ entry, kind: kindOf(entry[1]) }))
    .filter((e) => e.kind !== "relation" && canChange(e.entry[1], e.kind))
    .map((e) => ({ ...e, rank: UPDATE_PREFERENCE.indexOf(e.kind) }));
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked[0]?.entry ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The document

/** The parts of an OpenAPI document this module reads. */
export interface OpenApiLike {
  paths?: Record<string, Record<string, unknown> | undefined>;
  components?: { schemas?: Record<string, Schema | undefined> };
}

/** One entity's create route, as the document lists it. */
export interface EntityRoute {
  entity: string;
  collectionPath: string;
  /** The create body's schema (`<Entity>Create`): its properties and the required ones. */
  create: { properties: Record<string, FieldLike>; required: string[] };
}

function resolveRef(spec: OpenApiLike, schema: unknown): Schema {
  const ref = (schema as { $ref?: unknown } | undefined)?.$ref;
  if (typeof ref !== "string") return (schema as Schema | undefined) ?? {};
  return spec.components?.schemas?.[ref.split("/").pop() ?? ""] ?? {};
}

/**
 * Every entity create route in the document: a path whose POST has operationId `create_<entity>` and whose `/{id}` path
 * has a GET. Keyed by entity name.
 */
export function entityRoutes(spec: OpenApiLike): Map<string, EntityRoute> {
  const routes = new Map<string, EntityRoute>();
  const paths = spec.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    const post = item?.post as { operationId?: unknown; requestBody?: { content?: Record<string, { schema?: unknown }> } } | undefined;
    const operationId = typeof post?.operationId === "string" ? post.operationId : "";
    if (!operationId.startsWith("create_") || !paths[`${path}/{id}`]?.get) continue;
    const schema = resolveRef(spec, post?.requestBody?.content?.["application/json"]?.schema);
    const properties = (typeof schema.properties === "object" && schema.properties !== null ? schema.properties : {}) as Record<string, FieldLike>;
    const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [];
    routes.set(operationId.slice("create_".length), { entity: operationId.slice("create_".length), collectionPath: path, create: { properties, required } });
  }
  return routes;
}

/** What one POST answered. */
export interface PostAnswer {
  status: number;
  body: Record<string, unknown>;
}

export interface BuiltCreate {
  entity: string;
  path: string;
  /** The body sent for the entity itself. */
  row: Record<string, unknown>;
  status: number;
  body: Record<string, unknown>;
  /** The id the create answered with, or null. */
  id: string | null;
  /** The target rows created first, in order. */
  prerequisites: Array<{ entity: string; status: number; id: string | null }>;
}

/** The default limit on how deep a chain of relations is followed (the entity itself is depth 0). */
const MAX_RELATION_DEPTH = 3;

const idOf = (body: Record<string, unknown>) => {
  const id = (body.item as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : null;
};

/**
 * Creates a row of `entity` from the document alone. Every property of its create schema gets a value: a relation
 * (`x-relation`) gets the id of a target row this function creates first, through the target's own create route, one
 * row per target entity (reused when two fields name the same target). A required relation that would need a cycle,
 * a chain deeper than `maxDepth`, a target with no create route, or a target create that is not answered 201 makes it
 * throw an Error naming the chain. An optional one in that position is left out.
 *
 * `post(path, body)` sends one create (with whatever identity and workspace the caller uses).
 */
export async function createFromOpenApi(
  spec: OpenApiLike,
  entity: string,
  post: (path: string, body: Record<string, unknown>) => Promise<PostAnswer>,
  options: { maxDepth?: number; label?: string } = {},
): Promise<BuiltCreate> {
  const maxDepth = options.maxDepth ?? MAX_RELATION_DEPTH;
  const label = options.label ?? "sample";
  const routes = entityRoutes(spec);
  const made = new Map<string, string>();
  const prerequisites: BuiltCreate["prerequisites"] = [];
  const routeOf = (name: string) => {
    const route = routes.get(name);
    if (!route) throw new Error(`no create route for entity "${name}" in the OpenAPI document`);
    return route;
  };

  const targetId = async (target: string, chain: string[], field: string, required: boolean): Promise<string | null> => {
    const known = made.get(target);
    if (known) return known;
    const where = `${chain.join(" -> ")}.${field}`;
    const problem = chain.includes(target)
      ? `is a cycle (${[...chain, target].join(" -> ")})`
      : chain.length > maxDepth
        ? `is deeper than ${maxDepth} relations (${[...chain, target].join(" -> ")})`
        : !routes.has(target)
          ? `targets "${target}", which has no create route in the OpenAPI document`
          : null;
    if (problem) {
      if (!required) return null;
      throw new Error(`cannot create ${chain[0]}: the required relation ${where} ${problem}`);
    }
    const create = async (): Promise<string> => {
      const route = routeOf(target);
      const row = await rowFor(target, chain.concat(target));
      const answer = await post(route.collectionPath, row);
      const id = idOf(answer.body);
      prerequisites.push({ entity: target, status: answer.status, id });
      if (answer.status !== 201 || id === null)
        throw new Error(
          `cannot create ${chain[0]}: creating the ${target} that ${where} needs answered ${answer.status} ${JSON.stringify(answer.body).slice(0, 200)}`,
        );
      return id;
    };
    let id: string;
    try {
      id = await create();
    } catch (error) {
      // An optional link whose target cannot be made (whatever fails below it) is left out; only required links propagate.
      if (!required) return null;
      throw error;
    }
    made.set(target, id);
    return id;
  };

  const rowFor = async (name: string, chain: string[]): Promise<Record<string, unknown>> => {
    const route = routeOf(name);
    const required = new Set(route.create.required);
    const row: Record<string, unknown> = {};
    for (const [field, schema] of Object.entries(route.create.properties)) {
      if (kindOf(schema) !== "relation") {
        row[field] = sampleValue(schema, `${label} ${field}`);
        continue;
      }
      const id = await targetId(relationTarget(schema)!, chain, field, required.has(field));
      if (id !== null) row[field] = id;
    }
    return row;
  };

  const route = routeOf(entity);
  const row = await rowFor(entity, [entity]);
  const answer = await post(route.collectionPath, row);
  return { entity, path: route.collectionPath, row, status: answer.status, body: answer.body, id: idOf(answer.body), prerequisites };
}
