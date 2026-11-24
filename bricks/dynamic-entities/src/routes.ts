import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { parseEntities, tableName } from "@poc/sdk";
import type { D1Like, Entity, EntityField } from "@poc/sdk";

// Create, list, read, update and delete for any declared entity, interpreted at run time from the declaration. No code
// is written for any entity: the validation and the SQL are built here, once, from the same declaration the assembler
// wrote the table from. Three rules hold for every query:
//   1. the workspace is the one the guard resolved; nothing in the URL, query or body can change it;
//   2. only identifiers that passed parseEntities (strict patterns) are ever placed in SQL text, and they are quoted;
//   3. every value from a request is a bound parameter.

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

function valueSchema(field: EntityField): z.ZodType {
  switch (field.type) {
    case "text":
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
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}

/** What the database holds for a field becomes what a client sees: booleans are stored as 0 and 1. */
function present(entity: Entity, row: Row): Row {
  const out: Row = { id: row.id };
  for (const field of entity.fields) out[field.name] = field.type === "boolean" && row[field.name] !== null ? Boolean(row[field.name]) : (row[field.name] ?? null);
  out.created_at = row.created_at;
  out.updated_at = row.updated_at;
  return out;
}

/** What a client sends becomes what is stored. */
const store = (field: EntityField, value: unknown): unknown => (value === undefined || value === null ? null : field.type === "boolean" ? (value ? 1 : 0) : value);

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
    const columns = entity.fields.map((f) => q(f.name));
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

    router.post(base, async (c) => {
      const ctx = needWorkspace(c);
      if ("failure" in ctx) return ctx.failure;
      const body = createSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json({ error: { code: "VALIDATION_ERROR", message: describeIssues(body.error) } }, 400);
      const id = crypto.randomUUID();
      try {
        await c.env.DB.prepare(`INSERT INTO ${table} ("id", "workspace_id", ${columns.join(", ")}) VALUES (?, ?, ${columns.map(() => "?").join(", ")})`)
          .bind(id, ctx.workspace.id, ...entity.fields.map((f) => store(f, (body.data as Row)[f.name])))
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
        const { results } = await c.env.DB.prepare(`SELECT ${selectList} FROM ${table} WHERE "workspace_id" = ? ORDER BY "created_at" DESC, "id" LIMIT ? OFFSET ?`)
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
        const result = await c.env.DB.prepare(`UPDATE ${table} SET ${changes.map((f) => `${q(f.name)} = ?`).join(", ")}, "updated_at" = datetime('now') WHERE "id" = ? AND "workspace_id" = ?`)
          .bind(...changes.map((f) => store(f, (body.data as Row)[f.name])), id, ctx.workspace.id)
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
