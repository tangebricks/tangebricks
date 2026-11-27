// Story 1.32: a create built only from an assembled app's own /openapi.json succeeds, in workerd.
//
// The app (test/support/blueprints.ts ENTITY_GRAPH_BLUEPRINT) has lease -> unit and tenant as required relations, plus
// money, date and enum fields, and application with an optional relation to lease. The client reads GET /openapi.json,
// follows each relation's x-relation to create the target rows first (packages/assembler/src/openapi-sample.ts, the
// same builder the benchmark harness uses), then creates and updates the entity. The router's relation check (story
// 1.18) stays in force: an id that is not a row of the target in the workspace is still refused.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import type { D1Like } from "@poc/sdk";
import { createFromOpenApi, entityRoutes, updateFieldOf, updatedValue } from "../src/openapi-sample.ts";
import type { OpenApiLike } from "../src/openapi-sample.ts";
import { call, resetAndMigrate } from "./support/assembled-app.ts";
import type { App } from "./support/assembled-app.ts";

const entryLoaders = import.meta.glob("../../../out/entity-graph/src/index.ts") as Record<string, () => Promise<{ default: App }>>;
const app = (await Object.values(entryLoaders)[0]?.())?.default;
const sql = import.meta.glob("../../../out/entity-graph/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const db = env.DB as unknown as D1Like;

type Reply = { status: number; body: Record<string, any> };
async function api(method: string, path: string, opts: { user?: string; ws?: string; body?: unknown } = {}): Promise<Reply> {
  const res = await call(app!, method, path, opts);
  return { status: res.status, body: JSON.parse(res.text || "{}") as Record<string, any> };
}

async function published(): Promise<OpenApiLike> {
  const res = await api("GET", "/openapi.json");
  expect(res.status).toBe(200);
  return res.body as OpenApiLike;
}

async function workspaceOf(user: string): Promise<string> {
  const created = await api("POST", "/api/workspaces", { user, body: { name: `${user}'s` } });
  expect(created.status).toBe(201);
  return created.body.workspace.id as string;
}

describe("a create built only from the app's openapi.json (story 1.32)", () => {
  test("the document names each relation's target in x-relation, and money is amount plus a declared currency", async () => {
    expect(app, "out/entity-graph/src/index.ts was not assembled").toBeDefined();
    const spec = (await published()) as { components: { schemas: Record<string, { properties: Record<string, unknown>; required?: string[] }> } };
    const lease = spec.components.schemas.LeaseCreate!;
    expect(lease.required).toEqual(["unit_id", "tenant_id", "deposit", "starts_on", "status"]);
    expect(lease.properties.unit_id).toEqual({
      type: "string",
      format: "uuid",
      description: "Relation to unit: the id of a unit in the same workspace",
      "x-relation": "unit",
    });
    expect(lease.properties.tenant_id).toMatchObject({ "x-relation": "tenant" });
    expect(lease.properties.deposit).toEqual({
      type: "object",
      description: "An amount in minor units (1999 for 19.99) and its currency",
      properties: { amount: { type: "integer" }, currency: { type: "string", enum: ["INR"] } },
      required: ["amount", "currency"],
      additionalProperties: false,
    });
    expect(lease.properties.starts_on).toEqual({ type: "string", format: "date" });
    expect(spec.components.schemas.TenantCreate!.properties.notes).toMatchObject({ type: "string" });
  });

  test("lease: the unit and the tenant are created first from their own schemas, then the lease returns 201 and updates", async () => {
    await resetAndMigrate(db, sql);
    const ws = await workspaceOf("alice");
    const spec = await published();
    const sent: string[] = [];
    const built = await createFromOpenApi(
      spec,
      "lease",
      async (path, body) => {
        sent.push(path);
        return api("POST", path, { user: "alice", ws, body });
      },
      { label: "client" },
    );
    expect(built.status, JSON.stringify(built.body)).toBe(201);
    // The document's properties are in canonical (sorted) order, so tenant_id is reached before unit_id.
    expect(sent).toEqual(["/api/tenant", "/api/unit", "/api/lease"]);
    expect(built.prerequisites.map((p) => [p.entity, p.status])).toEqual([
      ["tenant", 201],
      ["unit", 201],
    ]);
    const idOf = (entity: string) => built.prerequisites.find((p) => p.entity === entity)!.id;
    expect(built.row).toMatchObject({
      unit_id: idOf("unit"),
      tenant_id: idOf("tenant"),
      deposit: { amount: 1000, currency: "INR" },
      starts_on: "2026-01-15",
      status: "draft",
    });
    const read = await api("GET", `/api/lease/${built.id}`, { user: "alice", ws });
    expect(read.status).toBe(200);
    expect(read.body.item).toMatchObject({ unit_id: idOf("unit"), deposit: { amount: 1000, currency: "INR" } });

    // The update picks a non-relation field of the new types and the router accepts the changed value.
    const route = entityRoutes(spec).get("lease")!;
    const [field, schema] = updateFieldOf(Object.entries(route.create.properties))!;
    expect(field).toBe("deposit");
    const patched = await api("PATCH", `/api/lease/${built.id}`, { user: "alice", ws, body: { [field]: updatedValue(schema, built.row[field]) } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.item.deposit).toEqual({ amount: 1001, currency: "INR" });

    // 1.18 enforcement is unchanged: an id that is not a unit of this workspace is still refused.
    const other = await workspaceOf("bob");
    const foreign = await createFromOpenApi(spec, "unit", (path, body) => api("POST", path, { user: "bob", ws: other, body }));
    expect(foreign.status).toBe(201);
    const smuggled = await api("POST", "/api/lease", { user: "alice", ws, body: { ...built.row, unit_id: foreign.id } });
    expect(smuggled.status).toBe(400);
    expect(smuggled.body.error.message).toMatch(/unit_id: no unit with this id in this workspace/);
  });

  test("application: the optional relation is filled through a chain (lease, then its unit and tenant), and money, enum and date update", async () => {
    await resetAndMigrate(db, sql);
    const ws = await workspaceOf("carol");
    const spec = await published();
    const built = await createFromOpenApi(spec, "application", (path, body) => api("POST", path, { user: "carol", ws, body }));
    expect(built.status, JSON.stringify(built.body)).toBe(201);
    expect(built.prerequisites.map((p) => p.entity)).toEqual(["tenant", "unit", "lease"]);
    expect(built.row).toMatchObject({ amount: { amount: 1000, currency: "INR" }, stage: "new", due_on: "2026-01-15" });
    const props = entityRoutes(spec).get("application")!.create.properties;
    for (const name of ["amount", "stage", "due_on"]) {
      const patched = await api("PATCH", `/api/application/${built.id}`, { user: "carol", ws, body: { [name]: updatedValue(props[name]!, built.row[name]) } });
      expect(patched.status, `${name}: ${JSON.stringify(patched.body)}`).toBe(200);
    }
    const read = await api("GET", `/api/application/${built.id}`, { user: "carol", ws });
    expect(read.body.item).toMatchObject({ amount: { amount: 1001, currency: "INR" }, stage: "review", due_on: "2026-01-16" });
  });
});
