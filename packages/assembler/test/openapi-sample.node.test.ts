// Story 1.32: the openapi-sample builder's edges, against documents from generateOpenApiSpec and a fake POST. The
// assembled-app run in workerd is openapi-sample.test.ts.
import { describe, expect, test } from "vitest";
import { generateOpenApiSpec } from "../src/openapi.ts";
import { createFromOpenApi, sampleValue, updateFieldOf, updatedValue } from "../src/openapi-sample.ts";
import type { PostAnswer } from "../src/openapi-sample.ts";

const rel = (name: string, relation: string, required = true) => ({ name, type: "relation", relation, required });
const label = { name: "label", type: "text", required: true, maxLength: 10 };
const specOf = (entities: unknown[]) => generateOpenApiSpec({ project: "p", entities } as never);

/** A fake app: every create answers 201 with a fresh id, and the calls are recorded. */
function fakePost() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let n = 0;
  const post = async (path: string, body: Record<string, unknown>): Promise<PostAnswer> => {
    calls.push({ path, body });
    n += 1;
    return { status: 201, body: { item: { id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` } } };
  };
  return { calls, post };
}

describe("createFromOpenApi (story 1.32)", () => {
  test("required relations: targets first, one row per target entity, reused when two fields name it", async () => {
    const spec = specOf([
      { name: "person", fields: [label] },
      { name: "deal", fields: [rel("buyer_id", "person"), rel("seller_id", "person"), { name: "price", type: "money", currencies: ["INR"], required: true }] },
    ]);
    const { calls, post } = fakePost();
    const built = await createFromOpenApi(spec, "deal", post);
    expect(calls.map((c) => c.path)).toEqual(["/api/person", "/api/deal"]);
    expect(calls[0]!.body).toEqual({ label: "sample lab" });
    expect(built.row).toEqual({ buyer_id: built.prerequisites[0]!.id, seller_id: built.prerequisites[0]!.id, price: { amount: 1000, currency: "INR" } });
    expect(built.status).toBe(201);
  });

  test("a required cycle is refused with the chain named; an optional one is left out", async () => {
    const cyclic = specOf([
      { name: "a", fields: [rel("b_id", "b")] },
      { name: "b", fields: [rel("a_id", "a")] },
    ]);
    await expect(createFromOpenApi(cyclic, "a", fakePost().post)).rejects.toThrow(/required relation a -> b\.a_id is a cycle \(a -> b -> a\)/);

    const optional = specOf([{ name: "node", fields: [label, rel("parent_id", "node", false)] }]);
    const { calls, post } = fakePost();
    const built = await createFromOpenApi(optional, "node", post);
    expect(calls).toHaveLength(1);
    expect(built.row).toEqual({ label: "sample lab" });
  });

  test("a chain deeper than 3 relations is refused; 3 is followed", async () => {
    const chain = (length: number) =>
      specOf(Array.from({ length: length + 1 }, (_, i) => ({ name: `e${i}`, fields: i < length ? [rel("next_id", `e${i + 1}`)] : [label] })));
    const { calls, post } = fakePost();
    expect((await createFromOpenApi(chain(3), "e0", post)).status).toBe(201);
    expect(calls.map((c) => c.path)).toEqual(["/api/e3", "/api/e2", "/api/e1", "/api/e0"]);
    await expect(createFromOpenApi(chain(4), "e0", fakePost().post)).rejects.toThrow(/is deeper than 3 relations \(e0 -> e1 -> e2 -> e3 -> e4\)/);
  });

  test("a target create that is refused stops a required relation with the answer", async () => {
    const spec = specOf([
      { name: "unit", fields: [label] },
      { name: "lease", fields: [rel("unit_id", "unit")] },
    ]);
    const refuse = async (): Promise<PostAnswer> => ({ status: 400, body: { error: { code: "VALIDATION_ERROR" } } });
    await expect(createFromOpenApi(spec, "lease", refuse)).rejects.toThrow(/creating the unit that lease\.unit_id needs answered 400/);
  });

  test("an optional link above a required cycle is left out, and the parent is still created", async () => {
    // a -> (optional) b -> (required) a: b cannot be made without a, so a is created without b_id.
    const spec = specOf([
      { name: "a", fields: [label, rel("b_id", "b", false)] },
      { name: "b", fields: [rel("a_id", "a")] },
    ]);
    const { calls, post } = fakePost();
    const built = await createFromOpenApi(spec, "a", post);
    expect(built.status).toBe(201);
    expect(calls.map((c) => c.path)).toEqual(["/api/a"]);
    expect(built.row).toEqual({ label: "sample lab" });
  });

  test("an optional link above a refused nested target is left out, and the parent is still created", async () => {
    // a -> (optional) b -> (required) c, and c's create is refused.
    const spec = specOf([
      { name: "a", fields: [label, rel("b_id", "b", false)] },
      { name: "b", fields: [rel("c_id", "c")] },
      { name: "c", fields: [label] },
    ]);
    const { calls, post } = fakePost();
    const refuseC = (path: string, body: Record<string, unknown>): Promise<PostAnswer> =>
      path === "/api/c" ? Promise.resolve({ status: 400, body: {} }) : post(path, body);
    const built = await createFromOpenApi(spec, "a", refuseC);
    expect(built.status).toBe(201);
    expect(built.row).toEqual({ label: "sample lab" });
    expect(calls.map((c) => c.path)).toEqual(["/api/a"]);
  });
});

describe("sample and update values for every field type", () => {
  test("blueprint and schema shapes agree on money, date, longtext, enum and relation", () => {
    expect(sampleValue({ type: "money", currencies: ["INR"] }, "x")).toEqual({ amount: 1000, currency: "INR" });
    expect(sampleValue({ type: "object", properties: { amount: { type: "integer" }, currency: { type: "string", enum: ["USD"] } } }, "x")).toEqual({
      amount: 1000,
      currency: "USD",
    });
    expect(sampleValue({ type: "date" }, "x")).toBe("2026-01-15");
    expect(sampleValue({ type: "string", format: "date" }, "x")).toBe("2026-01-15");
    expect(sampleValue({ type: "longtext", maxLength: 4 }, "bench notes")).toBe("benc");
    expect(sampleValue({ type: "enum", values: ["a", "b"] }, "x")).toBe("a");
    expect(sampleValue({ type: "relation", relation: "unit" }, "x", "id-1")).toBe("id-1");
    expect(() => sampleValue({ type: "string", format: "uuid", "x-relation": "unit" }, "x")).toThrow(/relation to unit needs the id/);
    expect(updatedValue({ type: "money", currencies: ["INR"] }, { amount: 5, currency: "INR" })).toEqual({ amount: 6, currency: "INR" });
    expect(updatedValue({ type: "date" }, "2026-02-28")).toBe("2026-03-01");
    expect(updatedValue({ type: "enum", values: ["a", "b"] }, "a")).toBe("b");
    expect(updatedValue({ type: "boolean" }, true)).toBe(false);
    // A plain uuid string (no x-relation) is not a relation: it gets a fresh uuid.
    expect(sampleValue({ type: "string", format: "uuid" }, "x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("a field that allows only one value is never the update field", () => {
    expect(updateFieldOf([["one", { type: "enum", values: ["a"] }]])).toBeNull();
    expect(updateFieldOf([["n", { type: "number", min: 3, max: 3 }]])).toBeNull();
    expect(updateFieldOf([["n", { type: "integer", minimum: 1, maximum: 2 }]])![0]).toBe("n");
  });

  test("the update field: any non-relation type; text first; none when only relations", () => {
    const f = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });
    expect(
      updateFieldOf([
        ["r", f("relation", { relation: "x" })],
        ["m", f("money", { currencies: ["INR"] })],
        ["t", f("text")],
      ])![0],
    ).toBe("t");
    expect(
      updateFieldOf([
        ["r", f("relation", { relation: "x" })],
        ["e", f("enum", { values: ["a", "b"] })],
        ["d", f("date")],
      ])![0],
    ).toBe("d");
    expect(
      updateFieldOf([
        ["one", f("enum", { values: ["a"] })],
        ["b", f("boolean")],
      ])![0],
    ).toBe("b");
    expect(updateFieldOf([["r", f("relation", { relation: "x" })]])).toBeNull();
  });
});
