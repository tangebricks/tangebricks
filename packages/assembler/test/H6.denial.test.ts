import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { record } from "@poc/harness";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";

// H6: the assembled project refuses workspace A reading or spending workspace B's money, with no hand edit.
//
// This file is written and owned by this repository. The assembler does not produce it and the assembled project does
// not contain it (scripts/verify.ts checks both). It exercises the project the setup step wrote to out/two-brick/,
// through its public routes, as a signed-in user of one workspace attacking another.
//
// What it shows is that the assembler mounted the workspace guard in front of the wallet's routes, in the right order.
// It does not re-test the bricks' own isolation (H5 and H8 do that).
interface App {
  fetch(request: Request, env: unknown): Response | Promise<Response>;
}
const entry = import.meta.glob("../../../out/two-brick/src/index.ts", { eager: true }) as Record<string, { default: App }>;
const sql = import.meta.glob("../../../out/two-brick/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const app = Object.values(entry)[0]?.default;
const db = env.DB as D1Like;

type Reply = { status: number; body: Record<string, any> | null };
async function call(
  path: string,
  user: string | null,
  workspace: string | null,
  body?: unknown,
  extra: { query?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    ...(user ? { "x-test-user": user } : {}),
    ...(workspace ? { "x-workspace-id": workspace } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...extra.headers,
  };
  const response = await app!.fetch(
    new Request(`http://localhost${path}${extra.query ?? ""}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    }),
    { DB: db },
  );
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, any> | null };
}

interface World {
  /** Alice owns A; Bob owns B; Carol is a plain member of A. */
  a: string;
  b: string;
}
// In whole credits: the wallet holds thousandths since credit-wallet's migration 0004 (story 2.5).
const balanceOf = async (workspace: string) => {
  const milli = (await db.prepare("SELECT balance_milli FROM credit_wallets WHERE workspace_id = ?").bind(workspace).first<{ balance_milli: number }>())
    ?.balance_milli;
  return milli === undefined ? undefined : milli / 1000;
};
const ledgerRows = async (workspace: string) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE workspace_id = ?").bind(workspace).first<{ n: number }>())!.n;
const orderRows = async (workspace: string) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM credit_orders WHERE workspace_id = ?").bind(workspace).first<{ n: number }>())!.n;

/** An empty database with the project's own migrations, two tenants made through the project's own API, balances seeded. */
async function world(): Promise<World> {
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets", "mw_invites", "mw_members", "mw_workspaces"])
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const path of Object.keys(sql).sort()) await applyMigration(db, sql[path]!);
  const create = async (user: string, name: string) => (await call("/api/workspaces", user, null, { name })).body!.workspace.id as string;
  const a = await create("alice", "A");
  const b = await create("bob", "B");
  await call("/api/wallet", "alice", a); // opens the wallets
  await call("/api/wallet", "bob", b);
  await db.prepare("UPDATE credit_wallets SET balance_milli = 100000 WHERE workspace_id = ?").bind(a).run();
  await db.prepare("UPDATE credit_wallets SET balance_milli = 50000 WHERE workspace_id = ?").bind(b).run();
  await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, 'carol', 'member')").bind(a).run();
  return { a, b };
}

/** B's money exactly as it was seeded: balance, no ledger rows, no orders. */
const untouched = async (w: World) => (await balanceOf(w.b)) === 50 && (await ledgerRows(w.b)) === 0 && (await orderRows(w.b)) === 0;

describe("the assembled project is there", () => {
  test("the setup step wrote it and it answers", async () => {
    expect(app, "the setup step should have written out/two-brick/src/index.ts").toBeDefined();
    expect((await call("/api/workspaces", null, null)).status).toBe(401);
  });
});

describe("workspace A cannot reach workspace B's money", () => {
  let w: World;
  beforeEach(async () => {
    expect.hasAssertions();
    w = await world();
  });

  test("reading B's wallet", async () => {
    const reply = await call("/api/wallet", "alice", w.b);
    expect(reply.status).toBe(403);
    expect(JSON.stringify(reply.body)).not.toContain("50");
  });

  test("reading B's history", async () => {
    await db
      .prepare(
        "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, metadata) VALUES ('secret-row', ?, 'bob', 'topup', 50000, 50000, 'bob-private-memo', '{}')",
      )
      .bind(w.b)
      .run();
    const reply = await call("/api/wallet/history", "alice", w.b);
    expect(reply.status).toBe(403);
    expect(JSON.stringify(reply.body)).not.toContain("bob-private-memo");
  });

  test("spending B's credits", async () => {
    const reply = await call("/api/wallet/deduct", "alice", w.b, { amount: 10 });
    expect(reply.status).toBe(403);
    expect(await balanceOf(w.b)).toBe(50);
    expect(await ledgerRows(w.b)).toBe(0);
  });

  test("starting a payment into B's wallet", async () => {
    expect((await call("/api/payments/create-order", "alice", w.b, { amount: 100 })).status).toBe(403);
    expect(await orderRows(w.b)).toBe(0);
  });

  test("naming B in the query string instead of the header", async () => {
    expect((await call("/api/wallet", "alice", null, undefined, { query: `?workspaceId=${w.b}` })).status).toBe(400); // header-only: no header is missing context
    expect((await call("/api/wallet/deduct", "alice", null, { amount: 10 }, { query: `?workspaceId=${w.b}` })).status).toBe(400);
    expect(await untouched(w)).toBe(true);
  });

  test("naming both workspaces in one header", async () => {
    for (const value of [`${w.a}, ${w.b}`, `${w.a},${w.b}`, `${w.b} ${w.a}`]) {
      const reply = await call("/api/wallet/deduct", "alice", value, { amount: 10 });
      expect(reply.status, value).toBeGreaterThanOrEqual(400);
      expect(await untouched(w)).toBe(true);
      expect(await balanceOf(w.a)).toBe(100);
    }
  });

  test("being a member of A while spending with the body pointed at B", async () => {
    const reply = await call("/api/wallet/deduct", "alice", w.a, { amount: 10, workspaceId: w.b, workspace_id: w.b, workspace: w.b });
    expect(reply.status).toBe(200);
    expect(await balanceOf(w.a)).toBe(90);
    expect(await untouched(w)).toBe(true);
  });

  test("a plain member of A, and a stranger, are refused on B too", async () => {
    for (const user of ["carol", "mallory"]) {
      expect((await call("/api/wallet", user, w.b)).status, user).toBe(403);
      expect((await call("/api/wallet/deduct", user, w.b, { amount: 10 })).status, user).toBe(403);
    }
    expect(await untouched(w)).toBe(true);
  });

  test("the same attack in the other direction: B cannot reach A", async () => {
    expect((await call("/api/wallet", "bob", w.a)).status).toBe(403);
    expect((await call("/api/wallet/history", "bob", w.a)).status).toBe(403);
    expect((await call("/api/wallet/deduct", "bob", w.a, { amount: 10 })).status).toBe(403);
    expect(await balanceOf(w.a)).toBe(100);
    expect(await ledgerRows(w.a)).toBe(0);
  });

  test("a workspace id made up, or built to break a query, reaches nothing", async () => {
    for (const id of ["no-such-workspace", "' OR '1'='1", `${w.b}' --`, `${w.b}"; DROP TABLE credit_wallets; --`, "%", "*"]) {
      expect((await call("/api/wallet/deduct", "alice", id, { amount: 10 })).status, id).toBe(403);
    }
    expect(await untouched(w)).toBe(true);
    expect(await balanceOf(w.a)).toBe(100);
  });

  test("no identity is refused on every wallet route, and so is an identity with no workspace", async () => {
    for (const [path, body] of [
      ["/api/wallet", undefined],
      ["/api/wallet/history", undefined],
      ["/api/wallet/deduct", { amount: 1 }],
      ["/api/payments/create-order", { amount: 100 }],
    ] as const) {
      expect((await call(path, null, w.a, body)).status, `${path} without identity`).toBe(401);
      expect((await call(path, "alice", null, body)).status, `${path} without workspace`).toBe(400);
    }
    expect(await balanceOf(w.a)).toBe(100);
    expect(await untouched(w)).toBe(true);
  });

  test("a hundred attempts at once against B leave B exactly as it was", async () => {
    const attempts = Array.from({ length: 100 }, (_, i) =>
      call(i % 2 === 0 ? "/api/wallet/deduct" : "/api/payments/create-order", "alice", w.b, i % 2 === 0 ? { amount: 1 } : { amount: 100 }),
    );
    const replies = await Promise.all(attempts);
    expect(replies.every((r) => r.status === 403)).toBe(true);
    expect(await untouched(w)).toBe(true);
  });
});

describe("workspace A can use its own wallet through the same assembled project", () => {
  let w: World;
  beforeEach(async () => {
    expect.hasAssertions();
    w = await world();
  });

  test("reading the balance and the history", async () => {
    const wallet = await call("/api/wallet", "alice", w.a);
    expect(wallet).toMatchObject({ status: 200, body: { currentBalance: 100 } });
    expect((await call("/api/wallet/history", "alice", w.a)).status).toBe(200);
  });

  test("spending, and the spend lands on A only", async () => {
    const reply = await call("/api/wallet/deduct", "alice", w.a, { amount: 30, reason: "report export" });
    expect(reply).toMatchObject({ status: 200, body: { charged: 30, balanceAfter: 70 } });
    expect(await balanceOf(w.a)).toBe(70);
    expect(await untouched(w)).toBe(true);
    const history = await call("/api/wallet/history", "alice", w.a);
    expect(history.body!.ledgers.map((l: { description: string; amount: number }) => [l.description, l.amount])).toEqual([["report export", -30]]);
  });

  test("a plain member of A can use A's wallet too", async () => {
    expect((await call("/api/wallet", "carol", w.a)).status).toBe(200);
    expect((await call("/api/wallet/deduct", "carol", w.a, { amount: 5 })).status).toBe(200);
    expect(await balanceOf(w.a)).toBe(95);
  });

  // Story 0.9: the assembled project wires no payment gateway, so A passes the workspace guard and the route
  // answers 503 NOT_CONFIGURED instead of creating a fake order.
  test("starting a payment passes the guard and is refused as not configured", async () => {
    const reply = await call("/api/payments/create-order", "alice", w.a, { amount: 100 });
    expect(reply).toMatchObject({ status: 503, body: { code: "NOT_CONFIGURED" } });
    expect(await orderRows(w.a)).toBe(0);
    expect(await orderRows(w.b)).toBe(0);
  });

  test("overspending is refused and stops at zero", async () => {
    expect((await call("/api/wallet/deduct", "alice", w.a, { amount: 101 })).status).toBe(402);
    expect((await call("/api/wallet/deduct", "alice", w.a, { amount: 100 })).status).toBe(200);
    expect((await call("/api/wallet/deduct", "alice", w.a, { amount: 1 })).status).toBe(402);
    expect(await balanceOf(w.a)).toBe(0);
    expect(await untouched(w)).toBe(true);
  });
});

test("H6 report", async ({ task }) => {
  const w = await world();
  const denied = [
    (await call("/api/wallet", "alice", w.b)).status === 403,
    (await call("/api/wallet/history", "alice", w.b)).status === 403,
    (await call("/api/wallet/deduct", "alice", w.b, { amount: 10 })).status === 403,
    (await call("/api/payments/create-order", "alice", w.b, { amount: 100 })).status === 403,
    (await call("/api/wallet/deduct", "alice", null, { amount: 10 }, { query: `?workspaceId=${w.b}` })).status === 400,
    (await call("/api/wallet", "bob", w.a)).status === 403,
    (await call("/api/wallet/deduct", "bob", w.a, { amount: 10 })).status === 403,
    await untouched(w),
    (await balanceOf(w.a)) === 100,
  ];
  const smuggled = await call("/api/wallet/deduct", "alice", w.a, { amount: 10, workspaceId: w.b, workspace_id: w.b });
  denied.push(smuggled.status === 200, (await balanceOf(w.b)) === 50, (await balanceOf(w.a)) === 90);

  const own = await world();
  const mine = [
    (await call("/api/wallet", "alice", own.a)).body?.currentBalance === 100,
    (await call("/api/wallet/deduct", "alice", own.a, { amount: 30 })).body?.balanceAfter === 70,
    (await call("/api/wallet/history", "alice", own.a)).body?.ledgers?.length === 1,
    (await call("/api/payments/create-order", "alice", own.a, { amount: 100 })).status === 503,
    (await call("/api/wallet/deduct", "alice", own.a, { amount: 71 })).status === 402,
    (await balanceOf(own.a)) === 70,
  ];

  record(task, { id: "H6", checks: { crossTenantDenied: denied.every(Boolean), ownWalletWorks: mine.every(Boolean) } });
});
