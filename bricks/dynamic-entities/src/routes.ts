import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { MONEY_CURRENCY_SUFFIX, fieldColumns, parseEntities, tableName } from "@poc/sdk";
import type { D1Like, Entity, EntityField } from "@poc/sdk";

// Create, list, read, update and delete for any declared entity, interpreted at run time from the declaration. No code
// is written for any entity: the validation and the SQL are built here, once, from the same declaration the assembler
// wrote the table from. Three rules hold for every query:
//   1. the workspace is the one the guard resolved; nothing in the URL, query or body can change it;
//   2. only identifiers that passed parseEntities (strict patterns) are ever placed in SQL text, and they are quoted;
//   3. every value from a request is a bound parameter.
// A relation field holds the id of a row of its target entity; the router checks that row exists in the same workspace
// before it writes (no FOREIGN KEY, so deleting the referenced row stays allowed).

/** The Hono environment the routes expect. Matches what the workspace guard sets, written out so bricks stay independent. */
export interface EntityEnv {
  Bindings: { DB: D1Like };
  Variables: { user?: { uid: string }; workspace?: { id: string; role: string; suspended: boolean } };
}

type Ctx = Context<EntityEnv>;
type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const q = (identifier: string) => `"${identifier}"`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD (so not 2026-13-01 or 2026-02-30). */
function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0-99 as 1900-1999, and the table's date() accepts them as written.
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function valueSchema(field: EntityField): z.ZodType {
  switch (field.type) {
    case "text":
    case "longtext":
      return z.string().max(field.maxLength);
    case "number": {
      let schema = z.number().int().refine(Number.isSafeInteger, "must be a whole number");
      if (field.min !== undefined) schema = schema.min(field.min);
      if (field.max !== undefined) schema = schema.max(field.max);
      return schema;
    }
    case "boolean":
      return z.boolean();
    case "enum":
      return z.enum(field.values as [string, ...string[]]);
    case "relation":
      return z.string().regex(UUID, `must be the id of a ${field.relation}`);
    case "date":
      return z.string().refine(isCalendarDate, "must be a date written YYYY-MM-DD");
    case "money":
      return z.strictObject({
        amount: z.number().int("must be a whole number of minor units (1999 for 19.99)").refine(Number.isSafeInteger, "must be a whole number"),
        currency: z.enum(field.currencies as [string, ...string[]]),
      });
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}

/** What the database holds for a field becomes what a client sees: booleans are stored as 0 and 1, money as two columns. */
function present(entity: Entity, row: Row): Row {
  const out: Row = { id: row.id };
  for (const field of entity.fields) {
    const value = row[field.name] ?? null;
    if (field.type === "boolean") out[field.name] = value === null ? null : Boolean(value);
    else if (field.type === "money") out[field.name] = value === null ? null : { amount: value, currency: row[field.name + MONEY_CURRENCY_SUFFIX] ?? null };
    else out[field.name] = value;
  }
  out.created_at = row.created_at;
  out.updated_at = row.updated_at;
  return out;
}

/** What a client sends becomes what is stored: one value per column of the field (see fieldColumns). */
function store(field: EntityField, value: unknown): unknown[] {
  const missing = value === undefined || value === null;
  if (field.type === "money") {
    const money = value as { amount: number; currency: string } | null | undefined;
    return missing ? [null, null] : [money!.amount, money!.currency];
  }
  return [missing ? null : field.type === "boolean" ? (value ? 1 : 0) : value];
}

export interface EntityRoutesOptions {
  /** The declarations. Checked in full on start-up; a bad one stops the Worker from starting rather than being served. */
  entities: unknown;
}

export function createEntityRoutes(options: EntityRoutesOptions): Hono<EntityEnv> {
  const parsed = parseEntities(options.entities);
  if (!parsed.ok) throw new Error(`invalid entity declaration: ${parsed.errors.join("; ")}`);
  const router = new Hono<EntityEnv>();

  // Fails closed: with no identity or no resolved workspace, nothing below runs.
  const needWorkspace = (c: Ctx) => {
    const user = c.get("user");
    const workspace = c.get("workspace");
    if (!user) return { failure: c.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401) } as const;
    if (!workspace) return { failure: c.json({ error: { code: "MISSING_WORKSPACE", message: "Missing workspace context" } }, 400) } as const;
    return { user, workspace } as const;
  };
  const failed = (c: Ctx, where: string, error: unknown) => {
    console.error(where, error);
    return c.json({ error: "Internal error" }, 500);
  };

  for (const entity of parsed.entities) {
    const table = q(tableName(entity));
    const columns = entity.fields.flatMap((f) => fieldColumns(f).map(q));
    const relations = entity.fields.filter((f): f is Extract<EntityField, { type: "relation" }> => f.type === "relation");
    const selectList = [q("id"), ...columns, q("created_at"), q("updated_at")].join(", ");
    const base = `/${entity.name}`;

    // Create and update accept only declared fields; anything else in the body (a workspace_id, an id, a made-up column)
    // is dropped by the schema before it can reach SQL.
    const shape: Record<string, z.ZodType> = {};
    const updateShape: Record<string, z.ZodType> = {};
    for (const field of entity.fields) {
      const value = valueSchema(field);
      shape[field.name] = field.required ? value : value.nullable().optional();
      updateShape[field.name] = (field.required ? value : value.nullable()).optional();
    }
    const createSchema = z.object(shape);
    const updateSchema = z.object(updateShape);

    const readOne = (c: Ctx, workspaceId: string, id: string) =>
      c.env.DB.prepare(`SELECT ${selectList} FROM ${table} WHERE "id" = ? AND "workspace_id" = ?`).bind(id, workspaceId).first<Row>();

    // A related id must be a row of the target entity in this workspace. A row of another workspace, of another entity,
    // or none at all gets the same answer. The id already matched the UUID pattern in the schema.
    const missingRelations = async (c: Ctx, workspaceId: string, data: Row): Promise<string | null> => {
      const problems: string[] = [];
      for (const field of relations) {
        const value = data[field.name];
        if (typeof value !== "string") continue;
        const found = await c.env.DB.prepare(`SELECT 1 AS found FROM ${q(tableName({ name: field.relation }))} WHERE "id" = ? AND "workspace_id" = ?`)
          .bind(value, workspaceId)
          .first<{ found: number }>();
        if (!found) problems.push(`${field.name}: no ${field.relation} with this id in this workspace`);
      }
      return problems.length > 0 ? problems.join("; ") : null;
    };

    router.post(base, async (c) => {
      const ctx = needWorkspace(c);
      if ("failure" in ctx) return ctx.failure;
      const body = createSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json({ error: { code: "VALIDATION_ERROR", message: describeIssues(body.error) } }, 400);
      const id = crypto.randomUUID();
      try {
        const missing = await missingRelations(c, ctx.workspace.id, body.data as Row);
        if (missing) return c.json({ error: { code: "VALIDATION_ERROR", message: missing } }, 400);
        await c.env.DB.prepare(`INSERT INTO ${table} ("id", "workspace_id", ${columns.join(", ")}) VALUES (?, ?, ${columns.map(() => "?").join(", ")})`)
          .bind(id, ctx.workspace.id, ...entity.fields.flatMap((f) => store(f, (body.data as Row)[f.name])))
          .run();
        return c.json({ item: present(entity, (await readOne(c, ctx.workspace.id, id))!) }, 201);
      } catch (error) {
        return failed(c, `POST ${base}:`, error);
      }
    });

    router.get(base, async (c) => {
      const ctx = needWorkspace(c);
      if ("failure" in ctx) return ctx.failure;
      const query = ListQuery.safeParse({ limit: c.req.query("limit"), offset: c.req.query("offset") });
      if (!query.success) return c.json({ error: { code: "VALIDATION_ERROR", message: describeIssues(query.error) } }, 400);
      try {
        const { results } = await c.env.DB.prepare(
          `SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ? ORDER BY "created_at" DESC, "id" LIMIT ? OFFSET ?`,
        )
          .bind(ctx.workspace.id, query.data.limit, query.data.offset)
          .all<Row>();
        const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE "workspace_id" = ?`).bind(ctx.workspace.id).first<{ n: number }>();
        return c.json({ items: results.map((row) => present(entity, row)), total: total?.n ?? 0, limit: query.data.limit, offset: query.data.offset });
      } catch (error) {
        return failed(c, `GET ${base}:`, error);
      }
    });

    router.get(`${base}/:id`, async (c) => {
      const ctx = needWorkspace(c);
      if ("failure" in ctx) return ctx.failure;
      const id = c.req.param("id");
      if (!UUID.test(id)) return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
      try {
        const row = await readOne(c, ctx.workspace.id, id);
        // A row in another workspace is answered exactly like a row that does not exist.
        return row ? c.json({ item: present(entity, row) }) : c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
      } catch (error) {
        return failed(c, `GET ${base}/:id:`, error);
      }
    });

    router.patch(`${base}/:id`, async (c) => {
      const ctx = needWorkspace(c);
      if ("failure" in ctx) return ctx.failure;
      const id = c.req.param("id");
      if (!UUID.test(id)) return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
      const body = updateSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json({ error: { code: "VALIDATION_ERROR", message: describeIssues(body.error) } }, 400);
      const changes = entity.fields.filter((f) => (body.data as Row)[f.name] !== undefined);
      if (changes.length === 0) return c.json({ error: { code: "VALIDATION_ERROR", message: "Nothing to update: send at least one declared field" } }, 400);
      try {
        const missing = await missingRelations(c, ctx.workspace.id, body.data as Row);
        if (missing) return c.json({ error: { code: "VALIDATION_ERROR", message: missing } }, 400);
        const assignments = changes.flatMap((f) => fieldColumns(f).map((column) => `${q(column)} = ?`));
        const result = await c.env.DB.prepare(
          `UPDATE ${table} SET ${assignments.join(", ")}, "updated_at" = datetime('now') WHERE "id" = ? AND "workspace_id" = ?`,
        )
          .bind(...changes.flatMap((f) => store(f, (body.data as Row)[f.name])), id, ctx.workspace.id)
          .run();
        if (result.meta.changes === 0) return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
        return c.json({ item: present(entity, (await readOne(c, ctx.workspace.id, id))!) });
      } catch (error) {
        return failed(c, `PATCH ${base}/:id:`, error);
      }
    });

    router.delete(`${base}/:id`, async (c) => {
      const ctx = needWorkspace(c);
      if ("failure" in ctx) return ctx.failure;
      const id = c.req.param("id");
      if (!UUID.test(id)) return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
      try {
        const result = await c.env.DB.prepare(`DELETE FROM ${table} WHERE "id" = ? AND "workspace_id" = ?`).bind(id, ctx.workspace.id).run();
        return result.meta.changes === 0 ? c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404) : c.json({ deleted: true });
      } catch (error) {
        return failed(c, `DELETE ${base}/:id:`, error);
      }
    });
  }

  return router;
}
