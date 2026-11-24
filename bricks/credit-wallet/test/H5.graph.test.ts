import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { record } from "@poc/harness";
import { GraphInvalidError, runGraph, toyExecutors } from "@poc/runtime";
import { createRegistry, toyRegistry } from "@poc/sdk";
import type { BrickManifest, ExecutionContext, Executor, GraphEdge, GraphNode } from "@poc/sdk";
import { applyMigration, creditWalletBricks, creditWalletExecutors, createFakeGateway, createWallet } from "../src/index.ts";
import type { D1Like } from "../src/index.ts";
import migration from "../migrations/0001_credit_wallet.sql?raw";
import migration0002 from "../migrations/0002_workspace_scoped_idempotency.sql?raw";

const db = env.DB as D1Like;
const WS = "ws-graph";

const node = (id: string, type: string, data: Record<string, unknown> = {}): GraphNode => ({ id, type, data });
const wire = (source: string, target: string): GraphEdge => ({ id: `${source}-${target}`, source, target, sourceHandle: "out", targetHandle: "in" });

async function reset(): Promise<void> {
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, migration);
  await applyMigration(db, migration0002);
}
const ledgerRows = async (workspaceId: string) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE workspace_id = ?").bind(workspaceId).first<{ n: number }>())!.n;
const balanceOf = (workspaceId: string) => createWallet(db, undefined).getBalance(workspaceId);

// What the graph does after the paid step: stands for the work the credits pay for. Counts how often it ran.
let paidWorkRuns = 0;
const paidWork: BrickManifest = { type: "test.paid-work", category: "action", inputs: [{ id: "in", dataType: "json" }], outputs: [], configSchema: z.object({}), secrets: [] };
const bricks: BrickManifest[] = [paidWork, ...creditWalletBricks];
const registry = createRegistry([...toyRegistry.values(), ...bricks, ...snoopBricks()]);

function snoopBricks(): BrickManifest[] {
  const base = { category: "transform" as const, inputs: [{ id: "in", dataType: "json" }], outputs: [{ id: "out", dataType: "json" }], configSchema: z.object({}) };
  return [
    { ...base, type: "test.no-bindings", secrets: [] },
    { ...base, type: "test.binding-db", secrets: [], bindings: ["DB"] },
    { ...base, type: "test.secret-only", secrets: ["POC_TEST_DECLARED"] },
    { ...base, type: "test.binding-missing", secrets: [], bindings: ["NOT_PROVIDED"] },
  ];
}
const executors = (extra: Record<string, Executor> = {}): Map<string, Executor> =>
  new Map<string, Executor>([
    ...toyExecutors,
    ...creditWalletExecutors,
    ["test.paid-work", () => ((paidWorkRuns += 1), {})],
    ...Object.entries(extra),
  ]);

/** trigger -> deduct -> paid work. The host gives the runtime only the database, never the whole env. */
const paidGraph = (amount: number, data: Record<string, unknown> = {}) => ({
  nodes: [node("t", "trigger.manual"), node("pay", "credit-wallet.deduct", { amount, ...data }), node("work", "test.paid-work")],
  edges: [wire("t", "pay"), wire("pay", "work")],
});
const runPaid = (amount: number, payload: unknown, data: Record<string, unknown> = {}) =>
  runGraph(paidGraph(amount, data), registry, executors(), { payload, env: { DB: db } });

describe("a deduct-credits step in a graph", () => {
  test("changes the balance once, writes one ledger row, and lets the paid work run", async () => {
    await reset();
    paidWorkRuns = 0;
    await createWallet(db, undefined).openWallet(WS, 10);
    const result = await runPaid(3, { workspaceId: WS, userId: "u1" });
    expect(result.ok).toBe(true);
    expect(result.outputs.pay?.out).toEqual({ charged: 3, balanceAfter: 7, duplicate: false });
    expect(await balanceOf(WS)).toBe(7);
    expect(await ledgerRows(WS)).toBe(1);
    expect(paidWorkRuns).toBe(1);
  });

  test("an insufficient balance refuses: the step fails, nothing downstream runs, balance and ledger are unchanged", async () => {
    await reset();
    paidWorkRuns = 0;
    await createWallet(db, undefined).openWallet(WS, 2);
    const result = await runPaid(3, { workspaceId: WS, userId: "u1" });
    expect(result.ok).toBe(false);
    expect(result.failed.pay).toBe("insufficient balance: need 3, have 2");
    expect(result.skipped).toContain("work");
    expect(paidWorkRuns).toBe(0);
    expect(await balanceOf(WS)).toBe(2);
    expect(await ledgerRows(WS)).toBe(0);
  });

  test("a retried run with the same idempotency key is charged once", async () => {
    await reset();
    await createWallet(db, undefined).openWallet(WS, 10);
    const payload = { workspaceId: WS, userId: "u1", idempotencyKey: "workflow-step-9" };
    const first = await runPaid(4, payload);
    const second = await runPaid(4, payload);
    expect(first.outputs.pay?.out).toMatchObject({ charged: 4, balanceAfter: 6, duplicate: false });
    expect(second.outputs.pay?.out).toMatchObject({ charged: 4, duplicate: true });
    expect(await balanceOf(WS)).toBe(6);
    expect(await ledgerRows(WS)).toBe(1);
  });

  test("fifteen runs of the graph at once against a balance of ten: exactly ten succeed", async () => {
    await reset();
    paidWorkRuns = 0;
    await createWallet(db, undefined).openWallet(WS, 10);
    const results = await Promise.all(Array.from({ length: 15 }, () => runPaid(1, { workspaceId: WS, userId: "u1" })));
    expect(results.filter((r) => r.ok).length).toBe(10);
    expect(results.filter((r) => !r.ok).every((r) => r.failed.pay?.startsWith("insufficient balance"))).toBe(true);
    expect(await balanceOf(WS)).toBe(0);
    expect(await ledgerRows(WS)).toBe(10);
    expect(paidWorkRuns).toBe(10);
  });

  test("the workspace comes from the caller, not from the graph: a workspaceId in the node's stored data is ignored", async () => {
    await reset();
    const wallet = createWallet(db, undefined);
    await wallet.openWallet(WS, 10);
    await wallet.openWallet("ws-other", 10);
    const result = await runPaid(3, { workspaceId: WS, userId: "u1" }, { workspaceId: "ws-other" });
    expect(result.ok).toBe(true);
    expect(await balanceOf(WS)).toBe(7);
    expect(await balanceOf("ws-other")).toBe(10);
    expect(await ledgerRows("ws-other")).toBe(0);
  });

  test.each([
    ["no workspace", { userId: "u1" }, "invalid input: workspaceId: Invalid input: expected string, received undefined"],
    ["an empty workspace", { workspaceId: "", userId: "u1" }, "invalid input: workspaceId: Too small: expected string to have >=1 characters"],
    ["a workspace that is not text", { workspaceId: 7, userId: "u1" }, "invalid input: workspaceId: Invalid input: expected string, received number"],
    ["no user", { workspaceId: WS }, "invalid input: userId: Invalid input: expected string, received undefined"],
    ["no payload at all", undefined, "invalid input: (value): Invalid input: expected object, received undefined"],
  ])("%s: the step fails with a readable reason and nothing changes", async (_name, payload, message) => {
    await reset();
    await createWallet(db, undefined).openWallet(WS, 10);
    const result = await runPaid(3, payload);
    expect(result.ok).toBe(false);
    expect(result.failed.pay).toBe(message);
    expect(await balanceOf(WS)).toBe(10);
    expect(await ledgerRows(WS)).toBe(0);
  });

  test("a workspace with no wallet fails the step and creates nothing", async () => {
    await reset();
    const result = await runPaid(3, { workspaceId: "ghost", userId: "u1" });
    expect(result.failed.pay).toBe("no wallet for workspace ghost");
    expect(await balanceOf("ghost")).toBeNull();
    expect(await ledgerRows("ghost")).toBe(0);
  });

  test.each([0, -1, 1.5, "3"])("an amount of %j in the node's config is rejected by the validator before anything runs", async (amount) => {
    await reset();
    await createWallet(db, undefined).openWallet(WS, 10);
    await expect(runPaid(amount as number, { workspaceId: WS, userId: "u1" })).rejects.toThrow(GraphInvalidError);
    expect(await balanceOf(WS)).toBe(10);
  });
});

describe("bindings are scoped by the manifest, as secrets are", () => {
  const run = (type: string, exec: Executor, hostEnv: Record<string, unknown> = { DB: db, POC_TEST_DECLARED: String(env.POC_TEST_DECLARED) }) =>
    runGraph({ nodes: [node("t", "trigger.manual"), node("x", type)], edges: [wire("t", "x")] }, registry, executors({ [type]: exec }), { payload: {}, env: hostEnv });

  test("a brick receives the binding its manifest declares", async () => {
    const result = await run("test.binding-db", (ctx) => ({ out: ctx.binding("DB") === db }));
    expect(result.ok).toBe(true);
    expect(result.outputs.x?.out).toBe(true);
  });

  test("a brick that declares no bindings is refused one, and the error names the binding", async () => {
    const result = await run("test.no-bindings", (ctx) => ({ out: ctx.binding("DB") }));
    expect(result.ok).toBe(false);
    expect(result.failed.x).toBe('binding "DB" is not declared by test.no-bindings');
  });

  test("a brick cannot reach another brick's binding by asking for it under any other name", async () => {
    const result = await run("test.binding-db", (ctx) => ({ out: ctx.binding("POC_TEST_DECLARED") }));
    expect(result.failed.x).toBe('binding "POC_TEST_DECLARED" is not declared by test.binding-db');
  });

  test("a declared binding the host did not provide fails with a clear message", async () => {
    const result = await run("test.binding-missing", (ctx) => ({ out: ctx.binding("NOT_PROVIDED") }));
    expect(result.failed.x).toBe('binding "NOT_PROVIDED" is declared by test.binding-missing but was not provided');
  });

  test("a binding name is not a secret name, and a secret name is not a binding name", async () => {
    const asSecret = await run("test.binding-db", (ctx) => ({ out: ctx.secret("DB") }));
    expect(asSecret.failed.x).toBe('secret "DB" is not declared by test.binding-db');
    const asBinding = await run("test.secret-only", (ctx) => ({ out: ctx.binding("POC_TEST_DECLARED") }));
    expect(asBinding.failed.x).toBe('binding "POC_TEST_DECLARED" is not declared by test.secret-only');
  });

  test("the deduct brick cannot be pointed at a database under another name", async () => {
    await reset();
    await createWallet(db, undefined).openWallet(WS, 10);
    const result = await runGraph(paidGraph(3), registry, executors(), { payload: { workspaceId: WS, userId: "u1" }, env: { OTHER: db } });
    expect(result.failed.pay).toBe('binding "DB" is declared by credit-wallet.deduct but was not provided');
    expect(await balanceOf(WS)).toBe(10);
  });

  test("the context an executor is handed does not contain the env or the database until the binding is requested", async () => {
    let seen: ExecutionContext | undefined;
    await run("test.binding-db", (ctx) => {
      seen = ctx;
      return { out: 1 };
    });
    const objects = new Set<object>();
    const visit = (v: unknown) => {
      if (typeof v !== "object" || v === null || objects.has(v)) return;
      objects.add(v);
      for (const key of Reflect.ownKeys(v)) visit((v as Record<PropertyKey, unknown>)[key]);
    };
    visit(seen);
    expect(objects.has(env)).toBe(false);
    expect(objects.has(db as unknown as object)).toBe(false);
    expect(Object.keys(seen!).sort()).toEqual(["binding", "data", "idempotencyKey", "inputs", "nodeId", "payload", "runId", "secret"]);
  });
});

test("H5 graph report", async ({ task }) => {
  await reset();
  paidWorkRuns = 0;
  await createWallet(db, undefined).openWallet(WS, 10);
  const payload = { workspaceId: WS, userId: "u1", idempotencyKey: "report-1" };
  const first = await runPaid(3, payload);
  const retry = await runPaid(3, payload);
  const changedOnce = first.ok && (await balanceOf(WS)) === 7 && (await ledgerRows(WS)) === 1 && retry.ok && paidWorkRuns === 2;
  record(task, { id: "H5", checks: { graphDeductChangesBalanceOnce: changedOnce } });
});
