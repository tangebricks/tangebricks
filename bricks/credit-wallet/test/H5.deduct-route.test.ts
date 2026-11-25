import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { workspaceMiddleware } from "@poc/multi-workspace";
import type { WorkspaceEnv } from "@poc/multi-workspace";
import mwMigration from "../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import { stubIdentity } from "../../multi-workspace/test/support/stub-identity.ts";
import walletMigration from "../migrations/0001_credit_wallet.sql?raw";
import walletMigration0002 from "../migrations/0002_workspace_scoped_idempotency.sql?raw";
import walletMigration0003 from "../migrations/0003_order_currency.sql?raw";
import { createFakeGateway, createWallet, createWalletRoutes } from "../src/index.ts";

// POST /wallet/deduct: the HTTP way to spend. Written for H6 (the assembled project must refuse spending another
// workspace's credits) but tested here, on the brick alone, so a failure points at the route and not at the assembler.

const db = env.DB as D1Like;
const app = new Hono<WorkspaceEnv>();
app.use("/api/*", stubIdentity);
app.use("/api/wallet", workspaceMiddleware);
app.use("/api/wallet/*", workspaceMiddleware);
app.route("/api", createWalletRoutes({ gateway: createFakeGateway(), currency: "INR" }));

const spend = (user: string | null, workspace: string | null, body: unknown, extra: Record<string, string> = {}) =>
  app.fetch(
    new Request("http://localhost/api/wallet/deduct", {
      method: "POST",
      headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}), ...(workspace ? { "x-workspace-id": workspace } : {}), ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { DB: db },
  );
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const balance = (workspace: string) => createWallet(db, undefined).getBalance(workspace);
const ledger = async (workspace: string) => (await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE workspace_id = ?").bind(workspace).first<{ n: number }>())!.n;

beforeEach(async () => {
  expect.hasAssertions();
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets", "mw_members", "mw_workspaces"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, mwMigration);
  await applyMigration(db, walletMigration);
  await applyMigration(db, walletMigration0002);
  await applyMigration(db, walletMigration0003);
  for (const [ws, owner] of [["ws-a", "alice"], ["ws-b", "bob"]] as const) {
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, ?)").bind(ws, ws, owner).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(ws, owner).run();
  }
  await createWallet(db, undefined).openWallet("ws-a", 100);
  await createWallet(db, undefined).openWallet("ws-b", 50);
});

describe("POST /wallet/deduct", () => {
  it("spends from the caller's own workspace and says what is left", async () => {
    const res = await spend("alice", "ws-a", { amount: 30, reason: "report export" });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ charged: 30, balanceAfter: 70, duplicate: false });
    expect(await balance("ws-a")).toBe(70);
    expect(await ledger("ws-a")).toBe(1);
  });

  it("the reason defaults, and shows in the ledger", async () => {
    await spend("alice", "ws-a", { amount: 1 });
    await spend("alice", "ws-a", { amount: 1, reason: "email send" });
    const rows = (await db.prepare("SELECT reason FROM credit_ledger WHERE workspace_id = 'ws-a' ORDER BY rowid").all<{ reason: string }>()).results.map((r) => r.reason);
    expect(rows).toEqual(["usage", "email send"]);
  });

  it("an amount the wallet cannot cover is refused with 402 and nothing changes", async () => {
    const res = await spend("alice", "ws-a", { amount: 101 });
    expect(res.status).toBe(402);
    expect(await json(res)).toEqual({ error: "Insufficient balance", balance: 100 });
    expect(await balance("ws-a")).toBe(100);
    expect(await ledger("ws-a")).toBe(0);
  });

  it("the last credit can be spent and the balance stops at zero", async () => {
    expect((await spend("alice", "ws-a", { amount: 100 })).status).toBe(200);
    expect(await balance("ws-a")).toBe(0);
    expect((await spend("alice", "ws-a", { amount: 1 })).status).toBe(402);
    expect(await balance("ws-a")).toBe(0);
  });

  it("a retry with the same idempotency key takes the money once", async () => {
    const first = await json(await spend("alice", "ws-a", { amount: 40, idempotencyKey: "job-7" }));
    const second = await json(await spend("alice", "ws-a", { amount: 40, idempotencyKey: "job-7" }));
    expect(first).toMatchObject({ balanceAfter: 60, duplicate: false });
    expect(second).toMatchObject({ duplicate: true });
    expect(await balance("ws-a")).toBe(60);
    expect(await ledger("ws-a")).toBe(1);
  });

  it("fifteen requests at once against a balance of ten: exactly ten succeed, over HTTP", async () => {
    await db.prepare("UPDATE credit_wallets SET balance = 10 WHERE workspace_id = 'ws-a'").run();
    const responses = await Promise.all(Array.from({ length: 15 }, () => spend("alice", "ws-a", { amount: 1 })));
    expect(responses.filter((r) => r.status === 200).length).toBe(10);
    expect(responses.filter((r) => r.status === 402).length).toBe(5);
    expect(await balance("ws-a")).toBe(0);
    expect(await ledger("ws-a")).toBe(10);
  });

  it.each([[0], [-5], [1.5], ["10"], [null], [1e12], [Number.NaN]])("an amount of %j is rejected with 400 and nothing changes", async (amount) => {
    expect((await spend("alice", "ws-a", { amount })).status).toBe(400);
    expect(await balance("ws-a")).toBe(100);
    expect(await ledger("ws-a")).toBe(0);
  });

  it.each([["no body", ""], ["a body that is not JSON", "not json"], ["no amount", {}], ["a blank reason", { amount: 1, reason: "" }], ["a very long reason", { amount: 1, reason: "x".repeat(201) }]])("%s is rejected with 400", async (_label, body) => {
    expect((await spend("alice", "ws-a", body)).status).toBe(400);
    expect(await ledger("ws-a")).toBe(0);
  });

  it("a workspace or user named in the body is ignored: the spend lands on the workspace the guard resolved", async () => {
    const res = await spend("alice", "ws-a", { amount: 10, workspaceId: "ws-b", workspace_id: "ws-b", userId: "bob", user: "bob" });
    expect(res.status).toBe(200);
    expect(await balance("ws-a")).toBe(90);
    expect(await balance("ws-b")).toBe(50);
    expect(await ledger("ws-b")).toBe(0);
    const row = await db.prepare("SELECT user_id FROM credit_ledger WHERE workspace_id = 'ws-a'").first<{ user_id: string }>();
    expect(row?.user_id).toBe("alice");
  });

  it("another tenant's workspace is refused with 403 and its balance is untouched", async () => {
    const res = await spend("alice", "ws-b", { amount: 10 });
    expect(res.status).toBe(403);
    expect(await balance("ws-b")).toBe(50);
    expect(await ledger("ws-b")).toBe(0);
    expect(await balance("ws-a")).toBe(100);
  });

  it("no identity is 401 and no workspace is 400, and neither spends anything", async () => {
    expect((await spend(null, "ws-a", { amount: 10 })).status).toBe(401);
    expect((await spend("alice", null, { amount: 10 })).status).toBe(400);
    expect(await balance("ws-a")).toBe(100);
  });

  it("a workspace with no wallet row is a 404 and creates nothing", async () => {
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES ('ws-c', 'c', 'carol')").run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES ('ws-c', 'carol', 'owner')").run();
    const res = await spend("carol", "ws-c", { amount: 1 });
    expect(res.status).toBe(404);
    expect(await balance("ws-c")).toBeNull();
  });

  it("a database failure is a generic 500 that does not leak the cause", async () => {
    await db.prepare("DROP TABLE credit_ledger").run();
    const res = await spend("alice", "ws-a", { amount: 1 });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/credit_ledger|no such table|SQLITE|D1_ERROR/i);
  });
});
