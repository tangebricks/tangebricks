import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { attach, record } from "@poc/harness";
import type { D1Like } from "../src/d1.ts";
import { runControlOp, seedControl, setupControl } from "./support/cephlow-control.ts";
import { type Outcome, type Workload, violations, workload } from "./support/workload.ts";

const db = env.DB as D1Like;
const RUNS = 20;
const WS = "ws-control";

describe("what local D1 does, pinned (the design of the bricks depends on both facts)", () => {
  test("a batch with a statement that raises rolls back whole, earlier statements included", async () => {
    await db.prepare("DROP TABLE IF EXISTS pin_a").run();
    await db.prepare("CREATE TABLE pin_a (id TEXT PRIMARY KEY, bal INTEGER NOT NULL CHECK (bal >= 0))").run();
    await db.prepare("INSERT INTO pin_a VALUES ('a', 5)").run();

    await expect(
      db.batch([
        db.prepare("UPDATE pin_a SET bal = bal + 100 WHERE id = 'a'"),
        db.prepare("UPDATE pin_a SET bal = bal - 1000 WHERE id = 'a'"), // violates the CHECK
      ]),
    ).rejects.toThrow(/CHECK constraint failed/);

    const row = await db.prepare("SELECT bal FROM pin_a WHERE id = 'a'").first<{ bal: number }>();
    expect(row?.bal).toBe(5); // the +100 did not survive
  });

  test("an UPDATE that matches no rows is not an error, and the batch carries on", async () => {
    await db.prepare("DROP TABLE IF EXISTS pin_b").run();
    await db.prepare("CREATE TABLE pin_b (id TEXT PRIMARY KEY, bal INTEGER NOT NULL)").run();
    await db.prepare("INSERT INTO pin_b VALUES ('a', 5)").run();

    const results = await db.batch([
      db.prepare("UPDATE pin_b SET bal = bal - 1 WHERE id = 'nobody'"),
      db.prepare("UPDATE pin_b SET bal = bal + 10 WHERE id = 'a'"),
    ]);
    expect(results.map((r) => r.meta.changes)).toEqual([0, 1]);
    const row = await db.prepare("SELECT bal FROM pin_b WHERE id = 'a'").first<{ bal: number }>();
    expect(row?.bal).toBe(15); // this is why a refused deduction cannot rely on rollback
  });

  test("overlapping read-then-write calls interleave: fifty +1 calls from zero do not reach fifty", async () => {
    await db.prepare("DROP TABLE IF EXISTS pin_c").run();
    await db.prepare("CREATE TABLE pin_c (id TEXT PRIMARY KEY, bal INTEGER NOT NULL)").run();
    await db.prepare("INSERT INTO pin_c VALUES ('a', 0)").run();

    await Promise.all(
      Array.from({ length: 50 }, async () => {
        const row = await db.prepare("SELECT bal FROM pin_c WHERE id = 'a'").first<{ bal: number }>();
        await db.prepare("UPDATE pin_c SET bal = ? WHERE id = 'a'").bind(row!.bal + 1).run();
      }),
    );
    const end = await db.prepare("SELECT bal FROM pin_c WHERE id = 'a'").first<{ bal: number }>();
    expect(end!.bal).toBeLessThan(50);
  });
});

/** Writes a small known-good world into the control tables so the checker can be shown to accept it and to reject damage. */
async function cleanWorld(): Promise<{ start: number; outcomes: Outcome[] }> {
  const w: Workload = { start: 10, ops: [{ kind: "topup", amount: 5, orderId: "o1" }, { kind: "deduct", amount: 3 }] };
  await setupControl(db);
  await seedControl(db, WS, 10, w.ops);
  await db.batch([
    db.prepare("UPDATE workspaces SET current_balance = 12 WHERE id = ?").bind(WS),
    db
      .prepare("INSERT INTO ledgers (id, workspace_id, user_id, type, amount, balance_after, description, metadata) VALUES ('l1', ?, 'u', 'topup', 5, 15, 't', ?)")
      .bind(WS, JSON.stringify({ order_id: "o1" })),
    db
      .prepare("INSERT INTO ledgers (id, workspace_id, user_id, type, amount, balance_after, description, metadata) VALUES ('l2', ?, 'u', 'deduction', -3, 12, 'd', '{}')")
      .bind(WS),
  ]);
  return { start: 10, outcomes: w.ops.map((op) => ({ op, accepted: true })) };
}

describe("the violation checker can tell a clean run from each kind of damage", () => {
  test("accepts a correct world", async () => {
    const { start, outcomes } = await cleanWorld();
    expect(await violations(db, WS, start, outcomes)).toEqual([]);
  });

  test("flags a final balance that is off by one", async () => {
    const { start, outcomes } = await cleanWorld();
    await db.prepare("UPDATE workspaces SET current_balance = 13 WHERE id = ?").bind(WS).run();
    expect((await violations(db, WS, start, outcomes)).join("|")).toMatch(/final balance 13, expected 12/);
  });

  test("flags a lost ledger row", async () => {
    const { start, outcomes } = await cleanWorld();
    await db.prepare("DELETE FROM ledgers WHERE id = 'l2'").run();
    expect((await violations(db, WS, start, outcomes)).join("|")).toMatch(/ledger has 1 rows for 2 accepted/);
  });

  test("flags a phantom ledger row left by a refused operation", async () => {
    const { start, outcomes } = await cleanWorld();
    const refused: Outcome = { op: { kind: "deduct", amount: 99 }, accepted: false };
    await db
      .prepare("INSERT INTO ledgers (id, workspace_id, user_id, type, amount, balance_after, description, metadata) VALUES ('l3', ?, 'u', 'deduction', 0, 12, 'd', '{}')")
      .bind(WS)
      .run();
    expect((await violations(db, WS, start, [...outcomes, refused])).join("|")).toMatch(/ledger has 3 rows for 2 accepted/);
  });

  test("flags a balance_after that a replay of the ledger does not reproduce", async () => {
    const { start, outcomes } = await cleanWorld();
    await db.prepare("UPDATE ledgers SET balance_after = 14 WHERE id = 'l1'").run();
    expect((await violations(db, WS, start, outcomes)).join("|")).toMatch(/balance_after does not match a replay/);
  });

  test("flags a negative balance_after", async () => {
    const { start, outcomes } = await cleanWorld();
    await db.prepare("UPDATE ledgers SET balance_after = -1 WHERE id = 'l2'").run();
    expect((await violations(db, WS, start, outcomes)).join("|")).toMatch(/negative balance_after/);
  });

  test("flags an order credited twice", async () => {
    const { start, outcomes } = await cleanWorld();
    await db
      .prepare("INSERT INTO ledgers (id, workspace_id, user_id, type, amount, balance_after, description, metadata) VALUES ('l4', ?, 'u', 'topup', 5, 17, 't', ?)")
      .bind(WS, JSON.stringify({ order_id: "o1" }))
      .run();
    expect((await violations(db, WS, start, outcomes)).join("|")).toMatch(/1 orders credited more than once/);
  });
});

describe("the negative control: cephlow's own top-up and deduction logic, fifty at a time", () => {
  test("run one at a time, the same logic and the same workloads give no violation (so the checker and the port are not what fails)", async () => {
    const dirty: string[] = [];
    for (let run = 1; run <= RUNS; run += 1) {
      const w = workload(run);
      await setupControl(db);
      await seedControl(db, WS, w.start, w.ops);
      const outcomes: Outcome[] = [];
      for (const op of w.ops) outcomes.push(await runControlOp(db, WS, op));
      const reasons = await violations(db, WS, w.start, outcomes);
      if (reasons.length > 0) dirty.push(`run ${run}: ${reasons.join("; ")}`);
      // The workload must exercise refusals in at least some orders, or the refusal path is never checked.
    }
    expect(dirty).toEqual([]);
  });

  test("the workloads include refused deductions and accepted ones, so both paths are exercised", async () => {
    let refused = 0;
    let acceptedDeductions = 0;
    for (let run = 1; run <= RUNS; run += 1) {
      const w = workload(run);
      await setupControl(db);
      await seedControl(db, WS, w.start, w.ops);
      for (const op of w.ops) {
        const outcome = await runControlOp(db, WS, op);
        if (op.kind === "deduct") outcome.accepted ? (acceptedDeductions += 1) : (refused += 1);
      }
    }
    expect(refused).toBeGreaterThan(0);
    expect(acceptedDeductions).toBeGreaterThan(0);
  });

  test(`loses updates in at least one of ${RUNS} runs`, async ({ task }) => {
    const perRun: Array<{ run: number; start: number; violating: boolean; reasons: string[] }> = [];
    for (let run = 1; run <= RUNS; run += 1) {
      const w = workload(run);
      await setupControl(db);
      await seedControl(db, WS, w.start, w.ops);
      const outcomes = await Promise.all(w.ops.map((op) => runControlOp(db, WS, op)));
      const reasons = await violations(db, WS, w.start, outcomes);
      perRun.push({ run, start: w.start, violating: reasons.length > 0, reasons });
    }
    const violatingRuns = perRun.filter((r) => r.violating).length;
    attach(task, "h5-control", {
      note: "cephlow's read-add-write top-up and its deduction, run 50 operations at a time on local D1; see test/support/cephlow-control.ts",
      runs: RUNS,
      violatingRuns,
      perRun,
    });
    record(task, { id: "H5", checks: { controlLosesUpdates: violatingRuns >= 1 } });
    console.log(`CONTROL: ${violatingRuns} of ${RUNS} runs violated the invariant. First: ${perRun.find((r) => r.violating)?.reasons.join("; ")}`);
    expect(violatingRuns).toBeGreaterThanOrEqual(1);
  });
});
