import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { runGraph } from "@poc/runtime";
import type { Graph } from "@poc/runtime";
import { applyMigration, createRegistry } from "@poc/sdk";
import type { BrickManifest, D1Like, Executor } from "@poc/sdk";
import {
  APP_WORKSPACE,
  GRAPH_MIGRATION,
  GRAPH_MIGRATIONS,
  GRAPH_TABLE,
  GRAPH_WORKSPACE_MIGRATION,
  LATENCY_TABLE,
  TELEMETRY_MIGRATION,
  isRunWorkspaceId,
  runStoredGraph,
} from "../src/worker/graph-run.ts";
import type { StepLike } from "../src/worker/graph-run.ts";
import { proofExecutors, proofRegistry } from "../src/worker/proof-bricks.ts";
import { createProofRoutes } from "../src/worker/proof-routes.ts";
import { isExcludedDataBrowserTable } from "../src/worker/data-browser.ts";
import { lintMigration } from "../src/migration-lint.ts";
import {
  HostedSandboxTarget,
  MockCloudflareControlPlane,
  SandboxDispatchPlatform,
  createByocProvisioner,
} from "../src/index.ts";
import type { DeployBuildArtifactInput, DeployTarget } from "../src/index.ts";
import { sqliteD1 } from "../../../test/support/sqlite-d1.ts";

// Story 0.18: poc_graphs has a tenant dimension. A row is keyed (workspace_id, id); a run carries a workspace and loads only
// that workspace's graph or the app-wide one (APP_WORKSPACE); no route behind the shared access key writes a graph; the
// Studio deploy path is the only writer and writes app-wide rows. Each test below is one row of the story's I/O matrix.

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, data });
const wire = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ id: `${source}.${sourceHandle}-${target}.${targetHandle}`, source, target, sourceHandle, targetHandle });
const pick = (id: string, path: string) => node(id, "transform.pick", { path });
/** (a + b) * c */
const MULTIPLY: Graph = {
  nodes: [node("t", "trigger.manual"), pick("pa", "a"), pick("pb", "b"), pick("pc", "c"), node("add", "proof.add"), node("mul", "proof.multiply")],
  edges: [wire("t", "out", "pa", "in"), wire("t", "out", "pb", "in"), wire("t", "out", "pc", "in"), wire("pa", "out", "add", "a"), wire("pb", "out", "add", "b"), wire("add", "out", "mul", "a"), wire("pc", "out", "mul", "b")],
};
/** (a + b) + c: the same graph, told apart by its answer. */
const ADD: Graph = { ...MULTIPLY, nodes: MULTIPLY.nodes.map((n) => (n.id === "mul" ? node("mul", "proof.add") : n)) };
const PAYLOAD = { a: 2, b: 3, c: 4 };
const WS_A = "3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b"; // the multi-workspace brick's ids are UUIDs
const WS_B = "ws-b";

const step: StepLike = { do: (async (_name: string, a: unknown, b?: () => Promise<unknown>) => (typeof a === "function" ? (a as () => Promise<unknown>)() : b!())) as StepLike["do"] };
const nonRetryable = (message: string) => Object.assign(new Error(message), { nonRetryable: true });

let world: ReturnType<typeof sqliteD1>;
const store = (workspaceId: string, id: string, graph: Graph) =>
  world.db.prepare(`INSERT INTO ${GRAPH_TABLE} (workspace_id, id, graph, updated_at) VALUES (?, ?, ?, 'now')`).run(workspaceId, id, JSON.stringify(graph));
const rows = () => world.db.prepare(`SELECT workspace_id, id, graph, updated_at FROM ${GRAPH_TABLE} ORDER BY workspace_id, id`).all();
const runAs = (workspaceId: unknown, graphId = "g", telemetry?: { runId: string }) =>
  runStoredGraph({ step, db: world.d1, params: { graphId, workspaceId: workspaceId as string, payload: PAYLOAD, ...(telemetry ? { telemetry } : {}) }, env: {}, registry: proofRegistry, executors: proofExecutors, nonRetryable });
const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (Error & { nonRetryable?: boolean }) | null;

beforeEach(() => {
  world = sqliteD1();
  for (const m of GRAPH_MIGRATIONS) world.db.exec(m.sql);
});

describe("which graph a run loads", () => {
  test("OWN_WORKSPACE: a graph stored for workspace A, run as A, runs A's graph", async () => {
    store(WS_A, "g", MULTIPLY);
    expect((await runAs(WS_A)).outputs.mul).toEqual({ out: 20 });
  });

  test("OTHER_WORKSPACE: a graph stored only for A, run as B, is 'no graph is stored', and never retried", async () => {
    store(WS_A, "g", MULTIPLY);
    const error = await refusal(runAs(WS_B));
    expect(error?.message).toMatch(/no graph is stored under "g"/);
    expect(error?.nonRetryable).toBe(true);
  });

  test("APP_GRAPH: a graph stored under the app workspace is run by A and by B alike", async () => {
    store(APP_WORKSPACE, "g", MULTIPLY);
    expect((await runAs(WS_A)).outputs.mul).toEqual({ out: 20 });
    expect((await runAs(WS_B)).outputs.mul).toEqual({ out: 20 });
    expect((await runAs(APP_WORKSPACE)).outputs.mul).toEqual({ out: 20 });
  });

  test("OWN_OVER_APP: with g under both A and the app, A runs its own row and B gets the app's", async () => {
    store(APP_WORKSPACE, "g", MULTIPLY);
    store(WS_A, "g", ADD);
    expect((await runAs(WS_A)).outputs.mul).toEqual({ out: 9 });
    expect((await runAs(WS_B)).outputs.mul).toEqual({ out: 20 });
    // the order the rows were written in does not matter
    world.db.exec(`DELETE FROM ${GRAPH_TABLE}`);
    store(WS_A, "g", ADD);
    store(APP_WORKSPACE, "g", MULTIPLY);
    expect((await runAs(WS_A)).outputs.mul).toEqual({ out: 9 });
  });

  test("a run started before workspaces existed (params {graphId, payload}) is an app-wide run, not refused on replay", async () => {
    store(APP_WORKSPACE, "g", MULTIPLY);
    store(WS_A, "g", ADD);
    const result = await runStoredGraph({ step, db: world.d1, params: { graphId: "g", payload: PAYLOAD }, env: {}, registry: proofRegistry, executors: proofExecutors, nonRetryable });
    expect(result.outputs.mul).toEqual({ out: 20 });
  });

  test.each([
    ["empty", ""],
    ["not text", 42],
    ["with a slash", "ws/a"],
    ["with a quote", "ws' OR '1'='1"],
    ["too long", "w".repeat(65)],
    ["reserved-looking (double underscore)", "__other__"],
    ["with a double underscore inside", "ws__a"],
  ])("BAD_WORKSPACE: a workspace id %s is refused before the table is read, and never retried", async (_name, workspaceId) => {
    store(APP_WORKSPACE, "g", MULTIPLY);
    world.statements.length = 0;
    const error = await refusal(runAs(workspaceId));
    expect(error?.message).toMatch(/usable workspace id/);
    expect(error?.nonRetryable).toBe(true);
    expect(world.statements).toEqual([]);
  });

  test("the workspace is passed to SQL as a parameter, never written into it", async () => {
    store(WS_A, "g", MULTIPLY);
    world.statements.length = 0;
    await runAs(WS_A);
    expect(world.statements.length).toBeGreaterThan(0);
    expect(world.statements.every((s) => !s.includes(WS_A))).toBe(true);
  });

  test("the reserved app workspace cannot collide with a real one: the multi-workspace brick's UUID ids are accepted, ids with '__' are not", () => {
    expect(isRunWorkspaceId(APP_WORKSPACE)).toBe(true);
    expect(isRunWorkspaceId(WS_A)).toBe(true);
    expect(isRunWorkspaceId(crypto.randomUUID())).toBe(true);
    expect(isRunWorkspaceId("__app")).toBe(false);
    expect(isRunWorkspaceId("app__")).toBe(false);
  });

  test("an app-wide run resolves a workspace connection exactly as before; a workspace's run resolves it in that workspace", async () => {
    const connManifest: BrickManifest = { type: "x.conn", category: "action", inputs: [{ id: "in", dataType: "json" }], outputs: [{ id: "out", dataType: "json" }], configSchema: z.object({}), secrets: [] };
    const registry = createRegistry([...proofRegistry.values(), connManifest]);
    const tryConnection: Executor = async (ctx) => {
      try {
        return { out: await ctx.connection!({ scope: "workspace", app: "slack" }) };
      } catch (error) {
        return { out: error instanceof Error ? error.message : String(error) };
      }
    };
    const executors = new Map<string, Executor>([...proofExecutors, ["x.conn", tryConnection]]);
    const graph: Graph = { nodes: [node("t", "trigger.manual"), node("c", "x.conn")], edges: [wire("t", "out", "c", "in")] };
    store(APP_WORKSPACE, "conn", graph);
    store(WS_A, "conn", graph);
    const env = { DB: world.d1 };
    const runFor = async (workspaceId: string) =>
      (await runStoredGraph({ step, db: world.d1, params: { graphId: "conn", workspaceId, payload: PAYLOAD }, env, registry, executors, nonRetryable })).outputs.c;
    const before = (await runGraph(graph, registry, executors, { payload: PAYLOAD, env, runId: "r" })).outputs.c;
    expect(String(before?.out)).toMatch(/ws_default/);
    const app = await runFor(APP_WORKSPACE);
    expect(app).toEqual(before);
    expect(String(app?.out)).not.toContain(APP_WORKSPACE);
    expect(String((await runFor(WS_A))?.out)).toContain(WS_A);
  });

  test("the run record carries its workspace, whatever telemetry option it is given", async () => {
    world.db.exec(TELEMETRY_MIGRATION.sql);
    store(WS_A, "g", MULTIPLY);
    const result = await runStoredGraph({
      step,
      db: world.d1,
      params: { graphId: "g", workspaceId: WS_A, payload: PAYLOAD, telemetry: { runId: "run_ws_a", workspaceId: WS_B } },
      env: {},
      registry: proofRegistry,
      executors: proofExecutors,
      nonRetryable,
    });
    expect(result.runRecord?.workspaceId).toBe(WS_A);
    const recorded = world.db.prepare("SELECT * FROM px_runs WHERE run_id = ?").get("run_ws_a") as Record<string, unknown>;
    expect(recorded.workspace_id).toBe(WS_A);
  });
});

/** A Workflow binding that remembers what it was asked to start. */
function workflowBinding() {
  const created: unknown[] = [];
  return {
    created,
    binding: {
      create: async (options: { params: unknown }) => {
        created.push(options.params);
        return { id: `inst-${created.length}`, status: async () => ({ status: "queued" }) };
      },
      get: async (id: string) => ({ id, status: async () => ({ status: "queued" }) }),
    },
  };
}

describe("the routes behind the shared access key", () => {
  const routes = createProofRoutes({ now: () => 0 });
  const call = async (method: string, path: string, body?: string) => {
    const wf = workflowBinding();
    const response = await routes(new Request(`http://deployed.invalid${path}`, { method, ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }) }), { DB: world.d1, GRAPH_RUNNER: wf.binding });
    return { status: response?.status ?? null, json: response ? ((await response.json()) as Record<string, unknown>) : null, created: wf.created };
  };

  test("PUT_REMOVED: PUT /poc/graphs/x with the key is refused (405) and no row is written, nor by any other write method", async () => {
    for (const method of ["PUT", "POST", "PATCH", "DELETE"]) {
      const result = await call(method, "/poc/graphs/x", JSON.stringify(MULTIPLY));
      expect(result.status, method).toBe(405);
    }
    expect(rows()).toEqual([]);
  });

  test("every route behind the key, called in turn, leaves the graph table exactly as it was", async () => {
    store(APP_WORKSPACE, "app-g", MULTIPLY);
    store(WS_A, "a-g", ADD);
    const before = rows();
    const calls: Array<[string, string, string?]> = [
      ["PUT", "/poc/graphs/app-g", JSON.stringify(ADD)],
      ["PUT", "/poc/graphs/new-g", JSON.stringify(ADD)],
      ["POST", "/poc/graphs/new-g", JSON.stringify(ADD)],
      ["PATCH", "/poc/graphs/app-g", JSON.stringify(ADD)],
      ["DELETE", "/poc/graphs/app-g"],
      ["GET", "/poc/graphs/app-g"],
      ["GET", "/poc/graphs/a-g"],
      ["POST", "/poc/runs", JSON.stringify({ graphId: "app-g", payload: PAYLOAD })],
      ["GET", "/poc/runs/inst-1"],
      ["POST", "/poc/write-latency"],
      ["POST", "/poc/write-latency"],
      ["PUT", "/poc/write-latency", "{}"],
      ["POST", "/poc/nothing", "{}"],
    ];
    for (const [method, path, body] of calls) await call(method, path, body);
    expect(rows()).toEqual(before);
  });

  test("the routes' source holds no statement that writes the graph table", () => {
    const source = readFileSync(resolve(import.meta.dirname, "..", "src", "worker", "proof-routes.ts"), "utf8");
    expect(source).not.toMatch(/\b(INSERT(\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+\$\{GRAPH_TABLE\}/);
    expect(source).toMatch(/INSERT INTO \$\{LATENCY_TABLE\}/); // the one write there is, to the scratch table
  });

  test("GET /poc/graphs/:id shows the app-wide row only: a graph stored only for a workspace is 'no such graph'", async () => {
    store(WS_A, "a-only", MULTIPLY);
    store(APP_WORKSPACE, "shared", ADD);
    store(WS_A, "shared", MULTIPLY);
    expect((await call("GET", "/poc/graphs/a-only")).status).toBe(404);
    const shared = await call("GET", "/poc/graphs/shared");
    expect(shared.status).toBe(200);
    expect(JSON.parse(shared.json!.graph as string)).toEqual(ADD);
  });

  test("POST /poc/runs starts a run for the app workspace, and a workspace named in the body is ignored", async () => {
    const plain = await call("POST", "/poc/runs", JSON.stringify({ graphId: "g", payload: PAYLOAD }));
    expect(plain.status).toBe(202);
    expect(plain.created).toEqual([{ graphId: "g", workspaceId: APP_WORKSPACE, payload: PAYLOAD }]);
    const sneaky = await call("POST", "/poc/runs", JSON.stringify({ graphId: "g", workspaceId: WS_A, payload: PAYLOAD }));
    expect(sneaky.status).toBe(202);
    expect(sneaky.created).toEqual([{ graphId: "g", workspaceId: APP_WORKSPACE, payload: PAYLOAD }]);
  });

  test("LATENCY_NO_GRAPHS: POST /poc/write-latency writes its scratch table ten times and leaves poc_graphs unchanged", async () => {
    store(APP_WORKSPACE, "g", MULTIPLY);
    const before = rows();
    const result = await call("POST", "/poc/write-latency");
    expect(result.status).toBe(200);
    expect(result.json!.writes).toBe(10);
    expect(rows()).toEqual(before);
    const scratch = world.db.prepare(`SELECT id, body FROM ${LATENCY_TABLE}`).all() as Array<{ id: string; body: string }>;
    expect(scratch).toHaveLength(1);
    expect(JSON.parse(scratch[0]!.body)).toEqual({ write: 9 });
  });

  test("the deploy's own tables are not offered by the data browser, so '__app__' is never listed as a workspace", () => {
    expect(isExcludedDataBrowserTable(GRAPH_TABLE)).toBe(true);
    expect(isExcludedDataBrowserTable(LATENCY_TABLE)).toBe(true);
  });
});

describe("the migration", () => {
  test("MIGRATION_KEEPS: rows written in the 9000 schema are all kept by the new migration, under the app workspace", () => {
    const old = sqliteD1();
    old.db.exec(GRAPH_MIGRATION.sql);
    const insert = old.db.prepare(`INSERT INTO ${GRAPH_TABLE} (id, graph, updated_at) VALUES (?, ?, ?)`);
    insert.run("g1", JSON.stringify(MULTIPLY), "2026-01-01T00:00:00.000Z");
    insert.run("g2", JSON.stringify(ADD), "2026-02-02T00:00:00.000Z");
    insert.run("__latency__", '{"write":9}', "2026-03-03T00:00:00.000Z");
    const before = old.db.prepare(`SELECT id, graph, updated_at FROM ${GRAPH_TABLE} ORDER BY id`).all();
    old.db.exec(GRAPH_WORKSPACE_MIGRATION.sql);
    const after = old.db.prepare(`SELECT workspace_id, id, graph, updated_at FROM ${GRAPH_TABLE} ORDER BY id`).all() as Array<Record<string, unknown>>;
    expect(after).toEqual(before.map((r) => ({ workspace_id: APP_WORKSPACE, ...(r as object) })));
  });

  test("MIGRATION_KEEPS: the kept rows are still run, by any workspace, as app-wide graphs", async () => {
    world = sqliteD1();
    world.db.exec(GRAPH_MIGRATION.sql);
    world.db.prepare(`INSERT INTO ${GRAPH_TABLE} (id, graph, updated_at) VALUES ('g', ?, 'then')`).run(JSON.stringify(MULTIPLY));
    world.db.exec(GRAPH_WORKSPACE_MIGRATION.sql);
    expect((await runAs(WS_A)).outputs.mul).toEqual({ out: 20 });
  });

  test("a fresh database and an upgraded one end in the same schema, keyed (workspace_id, id)", () => {
    const schemaOf = (db: ReturnType<typeof sqliteD1>["db"]) => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const fresh = sqliteD1();
    for (const m of GRAPH_MIGRATIONS) fresh.db.exec(m.sql);
    const upgraded = sqliteD1();
    upgraded.db.exec(GRAPH_MIGRATION.sql);
    upgraded.db.prepare(`INSERT INTO ${GRAPH_TABLE} (id, graph, updated_at) VALUES ('g', '{}', 'then')`).run();
    upgraded.db.exec(GRAPH_WORKSPACE_MIGRATION.sql);
    expect(schemaOf(upgraded.db)).toEqual(schemaOf(fresh.db));
    const pk = (fresh.db.prepare(`PRAGMA table_info(${GRAPH_TABLE})`).all() as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pk).toEqual(["workspace_id", "id"]);
  });

  test("the same row id may be stored once per workspace, and only once in each", () => {
    store(APP_WORKSPACE, "g", MULTIPLY);
    store(WS_A, "g", ADD);
    expect(() => store(WS_A, "g", MULTIPLY)).toThrow(/UNIQUE|PRIMARY KEY/i);
  });

  test("the deploy reads it as a table rebuild, not a destructive migration, and runs after 9000", () => {
    expect(lintMigration(GRAPH_WORKSPACE_MIGRATION.name, GRAPH_WORKSPACE_MIGRATION.sql).class).toBe("rewrite");
    expect(GRAPH_MIGRATIONS.map((m) => m.name)).toEqual(["9000_poc_graphs.sql", "9002_poc_graphs_workspace.sql"]);
    expect(GRAPH_WORKSPACE_MIGRATION.name > GRAPH_MIGRATION.name).toBe(true);
  });

  test("applied statement by statement (as the deploy and the sandbox do), it ends the same as applied at once", async () => {
    const split = sqliteD1();
    for (const m of GRAPH_MIGRATIONS) await applyMigration(split.d1, m.sql);
    const schemaOf = (db: ReturnType<typeof sqliteD1>["db"]) => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(schemaOf(split.db)).toEqual(schemaOf(world.db));
  });
});

describe("STUDIO_DEPLOY: the Studio deploy path writes app-wide rows with the composite key", () => {
  const GRAPHS = { "wf-one": JSON.stringify(MULTIPLY), "wf-two": JSON.stringify(ADD) };
  const artifact = (graphHash: string, graphs: Record<string, string> = GRAPHS): DeployBuildArtifactInput => ({
    project: "ws-scoped-graphs",
    buildHash: `build_${graphHash}`,
    codeHash: "code_1",
    graphHash,
    bundle: { code: "export default { fetch() { return new Response('ok'); } };", sha256: "code_1" },
    migrations: [],
    graphs,
    identity: "stub",
  });

  test("sandbox: a deploy and a hot apply store every graph under the app workspace in the sandbox's own D1", async () => {
    const sandboxDb = sqliteD1();
    const platform = new SandboxDispatchPlatform({ createD1: () => sandboxDb.d1 });
    const target = new HostedSandboxTarget({ platform });
    const deployTarget = { type: "platform-sandbox" as const, sandboxId: "sbx-ws-graphs", dispatchNamespace: "px-sandbox-preview", projectId: "ws-scoped-graphs" };
    await target.apply(artifact("graph_1"), deployTarget);
    const stored = () => sandboxDb.db.prepare(`SELECT workspace_id, id, graph FROM ${GRAPH_TABLE} ORDER BY id`).all() as Array<{ workspace_id: string; id: string; graph: string }>;
    expect(stored().map((r) => [r.workspace_id, r.id])).toEqual([[APP_WORKSPACE, "wf-one"], [APP_WORKSPACE, "wf-two"]]);
    await target.putGraph([{ ...MULTIPLY, id: "wf-one", nodes: ADD.nodes }], deployTarget, undefined, { graphHash: "graph_2" });
    expect(stored().every((r) => r.workspace_id === APP_WORKSPACE)).toBe(true);
    const record = platform.getDatabase("sbx-ws-graphs")!;
    expect(Object.values(record.graphs).every((g) => g.workspaceId === APP_WORKSPACE)).toBe(true);
    const pk = (sandboxDb.db.prepare(`PRAGMA table_info(${GRAPH_TABLE})`).all() as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pk).toEqual(["workspace_id", "id"]);
  });

  test("BYOC: a deploy and a direct putGraph store every graph under the app workspace", async () => {
    const ACCOUNT = "fedcba9876543210fedcba9876543210";
    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({ token: "cf_valid_ws_graphs_token_1234", accountId: ACCOUNT, accountName: "WS graphs" });
    const provisioner = createByocProvisioner({ apiClient: controlPlane, resolveToken: async () => "cf_valid_ws_graphs_token_1234" });
    const target: DeployTarget = { type: "byoc", accountId: ACCOUNT, tokenRef: "tok_ws_graphs", envName: "preview" };
    await provisioner.apply({
      target,
      project: "ws-scoped-graphs",
      actor: "usr_alice",
      deployId: "dep_1",
      buildHash: "build_1",
      codeHash: "code_1",
      graphHash: "graph_1",
      bundle: { code: "export default {};", sha256: "code_1" },
      migrations: [],
      queues: [],
      cronTriggers: [],
      workflows: [{ name: "wf-one", className: "GraphRunner" }],
      graphs: GRAPHS,
      schedules: [],
    });
    await provisioner.putGraph(target, { "wf-three": JSON.stringify(MULTIPLY) }, [], { project: "ws-scoped-graphs", actor: "usr_alice", graphHash: "graph_2" });
    const db = controlPlane.inspectDatabase(ACCOUNT, "px-ws-scoped-graphs-preview-db")!;
    expect(Object.keys(db.graphs).sort()).toEqual(["wf-one", "wf-three", "wf-two"]);
    expect(Object.values(db.graphs).every((g) => g.workspaceId === APP_WORKSPACE)).toBe(true);
  });
});

describe("the sandbox's default in-memory D1 stand-in models the composite key", () => {
  const standIn = async () => {
    const platform = new SandboxDispatchPlatform();
    await platform.putStoredGraph("sbx-standin", APP_WORKSPACE, "g", JSON.stringify(MULTIPLY));
    await platform.putStoredGraph("sbx-standin", WS_A, "g", JSON.stringify(ADD));
    await platform.putStoredGraph("sbx-standin", WS_A, "a-only", JSON.stringify(ADD));
    return platform.getDatabase("sbx-standin")!.rawD1;
  };
  const runIn = (db: D1Like, workspaceId: string, graphId = "g") =>
    runStoredGraph({ step, db, params: { graphId, workspaceId, payload: PAYLOAD }, env: {}, registry: proofRegistry, executors: proofExecutors, nonRetryable });

  test("OWN_OVER_APP: (A, g) does not overwrite (__app__, g); A runs its own row and B gets the app's", async () => {
    const db = await standIn();
    expect((await runIn(db, WS_A)).outputs.mul).toEqual({ out: 9 });
    expect((await runIn(db, WS_B)).outputs.mul).toEqual({ out: 20 });
  });

  test("OTHER_WORKSPACE: a graph stored only for A is 'no graph is stored' for B", async () => {
    const db = await standIn();
    expect((await refusal(runIn(db, WS_B, "a-only")))?.message).toMatch(/no graph is stored under "a-only"/);
    expect((await runIn(db, WS_A, "a-only")).outputs.mul).toEqual({ out: 9 });
  });
});

describe("the sandbox's graph migrations on a reused database", () => {
  test("a database that already has the 9002 schema is not migrated again, and its rows are kept", async () => {
    const reused = sqliteD1();
    for (const m of GRAPH_MIGRATIONS) reused.db.exec(m.sql);
    reused.db.prepare(`INSERT INTO ${GRAPH_TABLE} (workspace_id, id, graph, updated_at) VALUES (?, 'g', '{}', 'then')`).run(WS_A);
    await new SandboxDispatchPlatform({ createD1: () => reused.d1 }).ensureDatabase("sbx-reused");
    expect(reused.db.prepare(`SELECT workspace_id, id FROM ${GRAPH_TABLE}`).all()).toEqual([{ workspace_id: WS_A, id: "g" }]);
  });

  test("a database left at 9000 gets only 9002, and its rows move to the app workspace", async () => {
    const reused = sqliteD1();
    reused.db.exec(GRAPH_MIGRATION.sql);
    reused.db.prepare(`INSERT INTO ${GRAPH_TABLE} (id, graph, updated_at) VALUES ('g', '{}', 'then')`).run();
    await new SandboxDispatchPlatform({ createD1: () => reused.d1 }).ensureDatabase("sbx-reused");
    expect(reused.db.prepare(`SELECT workspace_id, id FROM ${GRAPH_TABLE}`).all()).toEqual([{ workspace_id: APP_WORKSPACE, id: "g" }]);
  });
});

describe("the BYOC mock control plane", () => {
  const ACCOUNT = "0123456789abcdef0123456789abcdef";
  const TOKEN = "cf_valid_mock_meta_token_1234";
  const setUp = async () => {
    const cp = new MockCloudflareControlPlane();
    cp.registerToken({ token: TOKEN, accountId: ACCOUNT, accountName: "meta" });
    const db = await cp.ensureDatabase(ACCOUNT, TOKEN, "px-meta-db");
    return { cp, db };
  };

  test("a new database lists both tables the graph migrations make", async () => {
    const { db } = await setUp();
    expect(db.tables).toEqual([GRAPH_TABLE, LATENCY_TABLE]);
  });

  test("recording app-wide graphs keeps a workspace's own rows", async () => {
    const { cp, db } = await setUp();
    await cp.putStoredGraph(ACCOUNT, TOKEN, db.uuid, WS_A, "g", JSON.stringify(ADD));
    cp.recordEnvironmentMetadata(ACCOUNT, "px-meta-script", "px-meta-db", { graphs: { g: JSON.stringify(MULTIPLY) } });
    const graphs = cp.inspectDatabase(ACCOUNT, "px-meta-db")!.graphs;
    expect(graphs[`${WS_A}:g`]).toMatchObject({ graph: JSON.stringify(ADD), workspaceId: WS_A });
    expect(graphs.g).toMatchObject({ graph: JSON.stringify(MULTIPLY), workspaceId: APP_WORKSPACE });
  });
});

test("the H10 deploy appends both graph migrations after the project's own", () => {
  const source = readFileSync(join(resolve(import.meta.dirname, "..", "src"), "h10.ts"), "utf8");
  expect(source).toContain("migrations: [...build.migrations, ...GRAPH_MIGRATIONS]");
});
