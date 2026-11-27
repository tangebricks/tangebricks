import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, test } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { SCRIPTED_EXPECTED, describeDifferences, runScriptedCheck, scriptedCheckPasses } from "../src/scripted-check.ts";
import type { Send } from "../src/scripted-check.ts";

// The scripted check against the UNBUNDLED assembled project (out/invoice-flow/, written by the setup step), in
// workerd. The bundled script is checked against the same fixed expectations in bundle.node.test.ts, so "the bundle
// answers as the project does" is two matches with one list, not a comparison of two things that could both be wrong.
interface App {
  fetch(request: Request, env: unknown): Response | Promise<Response>;
}
const entry = import.meta.glob("../../../out/invoice-flow/src/index.ts", { eager: true }) as Record<string, { default: App }>;
const sql = import.meta.glob("../../../out/invoice-flow/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const app = Object.values(entry)[0]?.default;
const db = env.DB as D1Like;

const TABLES = ["credit_ledger", "credit_orders", "credit_wallets", "mw_members", "mw_workspaces", "ent_invoices"];
async function freshDatabase() {
  for (const table of TABLES) await db.prepare(`DROP TABLE IF EXISTS "${table}"`).run();
  for (const path of Object.keys(sql).sort()) await applyMigration(db, sql[path]!);
}
const sendTo =
  (target: App, bindings: Record<string, unknown> = { DB: db }): Send =>
  async (request) =>
    target.fetch(request, bindings);

describe("the scripted check against the unbundled project", () => {
  beforeAll(async () => {
    expect(app, "the setup step should have written out/invoice-flow/src/index.ts").toBeDefined();
    await freshDatabase();
  });

  test("gives exactly the expected answers", async () => {
    const seen = await runScriptedCheck(sendTo(app!));
    expect(describeDifferences(seen)).toEqual([]);
    expect(scriptedCheckPasses(seen)).toBe(true);
    expect(seen).toEqual([...SCRIPTED_EXPECTED]);
  });

  test("gives the same answers the second time, on a fresh database, with different ids", async () => {
    await freshDatabase();
    expect(scriptedCheckPasses(await runScriptedCheck(sendTo(app!)))).toBe(true);
  });

  test("records no id or timestamp, so two runs are comparable", async () => {
    await freshDatabase();
    const text = JSON.stringify(await runScriptedCheck(sendTo(app!)));
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(text).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  test("B's refusal is about the real invoice: B asks for the very id A created and A itself can read", async () => {
    await freshDatabase();
    const asked: Array<{ user: string | null; path: string }> = [];
    const created: string[] = [];
    const recording: Send = async (request) => {
      const response = await app!.fetch(request, { DB: db });
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/invoices") created.push(((await response.clone().json()) as { item: { id: string } }).item.id);
      if (url.pathname.startsWith("/api/invoices/")) asked.push({ user: request.headers.get("x-test-user"), path: url.pathname });
      return response;
    };
    expect(scriptedCheckPasses(await runScriptedCheck(recording))).toBe(true);
    expect(created).toHaveLength(1);
    const real = `/api/invoices/${created[0]}`;
    expect(asked).toEqual([
      { user: "alice", path: real },
      { user: "bob", path: real },
    ]);
  });
});

describe("the check can fail (it is not a rubber stamp)", () => {
  test("a project that answers reads as the wrong user is caught", async () => {
    await freshDatabase();
    // wraps the real project but answers every invoice list as alice, whoever asked
    const wrongUser: App = {
      fetch: async (request, bindings) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/api/invoices") {
          const headers = new Headers(request.headers);
          headers.set("x-test-user", "alice");
          return app!.fetch(new Request(request.url, { method: "GET", headers }), bindings);
        }
        return app!.fetch(request, bindings);
      },
    };
    const seen = await runScriptedCheck(sendTo(wrongUser));
    expect(scriptedCheckPasses(seen)).toBe(false);
    expect(describeDifferences(seen).length).toBeGreaterThan(0);
  });

  test("a project that answers 200 to everything fails", async () => {
    const always: App = { fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) };
    const seen = await runScriptedCheck(sendTo(always));
    expect(scriptedCheckPasses(seen)).toBe(false);
    expect(describeDifferences(seen).length).toBeGreaterThanOrEqual(6);
  });

  test("a project that refuses everything fails", async () => {
    const never: App = { fetch: async () => new Response("no", { status: 403 }) };
    expect(scriptedCheckPasses(await runScriptedCheck(sendTo(never)))).toBe(false);
  });

  test("a project that cannot be reached fails by throwing, not by passing", async () => {
    await expect(
      runScriptedCheck(async () => {
        throw new Error("unreachable");
      }),
    ).rejects.toThrow("unreachable");
  });

  test("fewer or extra observations are not a pass", () => {
    expect(scriptedCheckPasses(SCRIPTED_EXPECTED.slice(0, -1))).toBe(false);
    expect(scriptedCheckPasses([...SCRIPTED_EXPECTED, SCRIPTED_EXPECTED[0]!])).toBe(false);
    expect(describeDifferences([...SCRIPTED_EXPECTED, SCRIPTED_EXPECTED[0]!])).toContain("1 unexpected extra observations");
  });

  test("a single changed fact is named", () => {
    const changed = SCRIPTED_EXPECTED.map((o, i) => (i === 2 ? { ...o, facts: { balance: 5 } } : o));
    expect(scriptedCheckPasses(changed)).toBe(false);
    expect(describeDifferences(changed)).toHaveLength(1);
    expect(describeDifferences(changed)[0]).toMatch(/^A's wallet starts at zero: expected .*"balance":0.*saw .*"balance":5/);
  });
});

describe("the expectations are about tenancy, not only about success", () => {
  test("they include a refusal for another workspace, a hidden row, and a missing identity", () => {
    const refusals = SCRIPTED_EXPECTED.filter((o) => o.status >= 400).map((o) => o.status);
    expect(refusals).toEqual([404, 403, 401]);
    expect(SCRIPTED_EXPECTED.some((o) => o.facts.sawAcme === false)).toBe(true);
    expect(SCRIPTED_EXPECTED.filter((o) => o.facts.leakedAcme === false)).toHaveLength(2);
    // the refusal of B reading A's invoice is preceded by A reading it successfully
    const steps = SCRIPTED_EXPECTED.map((o) => o.step);
    expect(steps.indexOf("A reads its own invoice by id")).toBeGreaterThan(-1);
    expect(steps.indexOf("A reads its own invoice by id")).toBeLessThan(steps.indexOf("B reads A's invoice by id and is refused"));
  });
});
