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
import type { FakeGateway } from "../src/index.ts";

// Re-homed from cephlow apps/api-worker/src/routes/payments.test.ts and from the "payments verify" test in
// middleware/workspace.test.ts (see ported-tests.json): the same titles and behavioural assertions, on stub identity,
// the real local D1 and an injected fake gateway in place of a JWT, a mocked database and vi.mock.

const db = env.DB as D1Like;
let gateway: FakeGateway;

async function reset(): Promise<void> {
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets", "mw_members", "mw_workspaces"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, mwMigration);
  await applyMigration(db, walletMigration);
  await applyMigration(db, walletMigration0002);
  await applyMigration(db, walletMigration0003);
}
async function addMember(workspaceId: string, userId: string, role = "owner", suspended = false): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO mw_workspaces (id, name, owner_id, suspended) VALUES (?, ?, 'o', ?)").bind(workspaceId, workspaceId, suspended ? 1 : 0).run();
  await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, ?)").bind(workspaceId, userId, role).run();
}

/** MIN_RECHARGE_AMOUNT 100 and CREDITS_PER_RUPEE 10, as in cephlow's test environment. */
const buildApp = (options: { mountWorkspace?: boolean } = {}) => {
  const app = new Hono<WorkspaceEnv>();
  app.use("/api/*", stubIdentity);
  if (options.mountWorkspace !== false) {
    app.use("/api/wallet", workspaceMiddleware);
    app.use("/api/wallet/*", workspaceMiddleware);
    app.use("/api/payments/create-order", workspaceMiddleware);
  }
  app.route("/api", createWalletRoutes({ gateway, currency: "INR", creditsPerUnit: 10, minOrderAmount: 100 }));
  return app;
};
const call = (path: string, user: string | null, workspace: string | null, body?: unknown, app = buildApp()) =>
  app.fetch(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(user ? { "x-test-user": user } : {}),
        ...(workspace ? { "x-workspace-id": workspace } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
    }),
    { DB: db },
  );
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const balance = (workspace: string) => createWallet(db, undefined).getBalance(workspace);
const ledgerRows = async (workspace: string) => (await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE workspace_id = ?").bind(workspace).first<{ n: number }>())!.n;
const orderRows = async () => (await db.prepare("SELECT COUNT(*) AS n FROM credit_orders").first<{ n: number }>())!.n;

/** A paid-for order for ws-abc owned by `owner`, ready to be confirmed. */
async function paidOrder(owner = "user-123", amount = 100, workspace = "ws-abc"): Promise<string> {
  const wallet = createWallet(db, gateway, { currency: "INR" });
  await wallet.openWallet(workspace);
  const { orderId } = await wallet.createOrder({ workspaceId: workspace, userId: owner, amount });
  gateway.setOrder(orderId, { status: "PAID" });
  return orderId;
}

beforeEach(async () => {
  expect.hasAssertions(); // a ported test that asserts nothing would pass whatever the code does; this makes it fail instead
  await reset();
  gateway = createFakeGateway();
  await addMember("ws-abc", "user-123");
});

describe("paymentsRouter - Security and Coverage Tests", () => {
  describe("POST /payments/create-order", () => {
    it("should reject invalid amount", async () => {
      const res = await call("/api/payments/create-order", "user-123", "ws-abc", { amount: -50 });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("Invalid amount");
    });

    it("should reject amount less than minimum recharge", async () => {
      const res = await call("/api/payments/create-order", "user-123", "ws-abc", { amount: 50 });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toContain("Minimum recharge amount is Rs. 100");
    });

    it("should create cashfree order successfully", async () => {
      const res = await call("/api/payments/create-order", "user-123", "ws-abc", { amount: 150 });
      expect(res.status).toBe(200);
      const data = await json(res);
      expect(data.order_id).toMatch(/^order_[0-9a-f]{16}$/);
      expect(data.payment_session_id).toBe(`session_${data.order_id}`);
      // and the order is remembered against this workspace and user, unprocessed
      const row = await db.prepare("SELECT workspace_id, user_id, amount, processed FROM credit_orders WHERE order_id = ?").bind(data.order_id).first();
      expect(row).toEqual({ workspace_id: "ws-abc", user_id: "user-123", amount: 150, processed: 0 });
    });

    it("should handle cashfree API failure gracefully", async () => {
      gateway.failCreates(true);
      const res = await call("/api/payments/create-order", "user-123", "ws-abc", { amount: 150 });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text).error).toContain("Payment gateway error");
      expect(text).not.toContain("gateway unavailable"); // cephlow appended the gateway's own message; the brick does not
      expect(await orderRows()).toBe(0); // no order is remembered for a payment that was never started
    });
  });

  describe("POST /payments/verify", () => {
    it("should reject missing order_id", async () => {
      const res = await call("/api/payments/verify", "user-123", "ws-abc", {});
      expect(res.status).toBe(400);
    });

    it("should return already processed status if processed is true", async () => {
      const orderId = await paidOrder();
      await db.prepare("UPDATE credit_orders SET processed = 1 WHERE order_id = ?").bind(orderId).run();
      const res = await call("/api/payments/verify", "user-123", "ws-abc", { order_id: orderId });
      expect(res.status).toBe(200);
      expect((await json(res)).status).toBe("already_processed");
      expect(await balance("ws-abc")).toBe(0);
    });

    it("should reject if cashfree status is not PAID", async () => {
      const orderId = await paidOrder();
      gateway.setOrder(orderId, { status: "ACTIVE" });
      const res = await call("/api/payments/verify", "user-123", "ws-abc", { order_id: orderId });
      expect(res.status).toBe(200);
      const data = await json(res);
      expect(data.status).toBe("ACTIVE");
      expect(data.credited).toBe(false);
      expect(await balance("ws-abc")).toBe(0);
    });

    it("should reject if workspace for order does not exist", async () => {
      const orderId = await paidOrder();
      await db.prepare("DELETE FROM credit_wallets WHERE workspace_id = 'ws-abc'").run();
      const res = await call("/api/payments/verify", "user-123", "ws-abc", { order_id: orderId });
      expect(res.status).toBe(404);
      expect((await json(res)).error).toBe("Workspace not found");
    });

    it("should successfully verify and credit workspace", async () => {
      const orderId = await paidOrder();
      const res = await call("/api/payments/verify", "user-123", "ws-abc", { order_id: orderId });
      expect(res.status).toBe(200);
      const data = await json(res);
      expect(data.status).toBe("PAID");
      expect(data.credited).toBe(true);
      expect(data.credits).toBe(1000); // 100 * CREDITS_PER_RUPEE (10)
      expect(await balance("ws-abc")).toBe(1000);
      expect(await ledgerRows("ws-abc")).toBe(1);
    });
  });
});

describe("workspaceMiddleware & requireNotSuspended - Security Tests (the payments half)", () => {
  it("should reject payments verify if the order does not belong to the user (H-5)", async () => {
    const orderId = await paidOrder("user-999"); // an order belonging to a different user
    const res = await call("/api/payments/verify", "user-123", null, { order_id: orderId }); // authenticated as user-123
    // ID_READ_FOREIGN (story 0.7): another user's order is "not found", the same answer as a missing one.
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual(await json(await call("/api/payments/verify", "user-123", null, { order_id: "order_missing" })));
    expect(await balance("ws-abc")).toBe(0); // and the gateway's PAID status was never acted on
    expect(await ledgerRows("ws-abc")).toBe(0);
  });
});

describe("the wallet routes beyond the ported tests", () => {
  // ID_READ_FOREIGN (story 0.7): a credit order of another workspace is "not found" and is never credited.
  it("an order that belongs to another workspace is a 404, indistinguishable from a missing one", async () => {
    await addMember("ws-other", "user-other");
    await createWallet(db, gateway, { currency: "INR" }).openWallet("ws-other", 0);
    const { orderId } = await createWallet(db, gateway, { currency: "INR" }).createOrder({ workspaceId: "ws-other", userId: "user-other", amount: 100 });
    gateway.setOrder(orderId, { status: "PAID" });
    const foreign = await call("/api/payments/verify", "user-123", "ws-abc", { order_id: orderId });
    const missing = await call("/api/payments/verify", "user-123", "ws-abc", { order_id: "order_nope" });
    expect(foreign.status).toBe(404);
    expect(await json(foreign)).toEqual(await json(missing));
    expect(await balance("ws-other")).toBe(0);
    expect(await ledgerRows("ws-other")).toBe(0);
  });

  it("an order that does not exist is a 404", async () => {
    const res = await call("/api/payments/verify", "user-123", null, { order_id: "order_nope" });
    expect(res.status).toBe(404);
  });

  it.each([[{ order_id: 7 }], [{ order_id: "" }], [{ order_id: "x".repeat(201) }], ["not json"]])("verify with the body %j is rejected with 400", async (body) => {
    expect((await call("/api/payments/verify", "user-123", null, body as never)).status).toBe(400);
  });

  it.each([[150.5], ["150"], [null], [0], [1e12]])("create-order with an amount of %j is rejected with 400 and creates nothing", async (amount) => {
    const res = await call("/api/payments/create-order", "user-123", "ws-abc", { amount });
    expect(res.status).toBe(400);
    expect(await orderRows()).toBe(0);
  });

  it("verifying the same order twice credits once", async () => {
    const orderId = await paidOrder();
    const first = await json(await call("/api/payments/verify", "user-123", null, { order_id: orderId }));
    const second = await json(await call("/api/payments/verify", "user-123", null, { order_id: orderId }));
    expect(first).toMatchObject({ status: "PAID", credited: true });
    expect(second).toEqual({ status: "already_processed", credited: false });
    expect(await balance("ws-abc")).toBe(1000);
  });

  it("twenty parallel verify calls over HTTP credit the order once", async () => {
    const orderId = await paidOrder();
    const responses = await Promise.all(Array.from({ length: 20 }, () => call("/api/payments/verify", "user-123", null, { order_id: orderId })));
    const bodies = await Promise.all(responses.map(json));
    expect(bodies.filter((b) => b.credited === true).length).toBe(1);
    expect(bodies.filter((b) => b.status === "already_processed").length).toBe(19);
    expect(await balance("ws-abc")).toBe(1000);
    expect(await ledgerRows("ws-abc")).toBe(1);
  });

  it("a gateway outage on verify is a 502 that does not leak the gateway's message, and nothing is credited", async () => {
    const orderId = await paidOrder();
    gateway.failFetches(true);
    const res = await call("/api/payments/verify", "user-123", null, { order_id: orderId });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("gateway unavailable");
    expect(await balance("ws-abc")).toBe(0);
    gateway.failFetches(false);
    expect((await json(await call("/api/payments/verify", "user-123", null, { order_id: orderId }))).credited).toBe(true);
  });

  it("a suspended workspace can still complete a payment that was already charged", async () => {
    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = 'ws-abc'").run();
    const orderId = await paidOrder();
    const res = await call("/api/payments/verify", "user-123", null, { order_id: orderId });
    expect(res.status).toBe(200);
    expect(await balance("ws-abc")).toBe(1000);
  });

  it("GET /wallet shows the balance, starting at zero and rising after a payment", async () => {
    expect(await json(await call("/api/wallet", "user-123", "ws-abc"))).toMatchObject({ currentBalance: 0, creditsPerUnit: 10, minOrderAmount: 100 });
    await call("/api/payments/verify", "user-123", null, { order_id: await paidOrder() });
    expect((await json(await call("/api/wallet", "user-123", "ws-abc"))).currentBalance).toBe(1000);
  });

  it("GET /wallet/history lists this workspace's ledger newest first, and nobody else's", async () => {
    await addMember("ws-other", "user-other");
    await call("/api/payments/verify", "user-123", null, { order_id: await paidOrder() });
    const wallet = createWallet(db, gateway, { currency: "INR" });
    await wallet.deduct({ workspaceId: "ws-abc", userId: "user-123", amount: 250, reason: "usage", metadata: { job: 1 } });
    await wallet.openWallet("ws-other", 5);
    await wallet.deduct({ workspaceId: "ws-other", userId: "user-other", amount: 1, reason: "secret-other-usage" });

    const history = await json(await call("/api/wallet/history", "user-123", "ws-abc"));
    expect(history.ledgers.map((l: { type: string; amount: number; balanceAfter: number }) => [l.type, l.amount, l.balanceAfter])).toEqual([
      ["deduction", -250, 750],
      ["topup", 1000, 1000],
    ]);
    expect(history.ledgers[0].metadata).toEqual({ job: 1 });
    expect(JSON.stringify(history)).not.toContain("secret-other-usage");
  });

  it("a member of one workspace cannot read or fund another's wallet by naming it", async () => {
    await addMember("ws-other", "user-other");
    await createWallet(db, gateway, { currency: "INR" }).openWallet("ws-other", 77);
    for (const path of ["/api/wallet", "/api/wallet/history"]) expect((await call(path, "user-123", "ws-other")).status).toBe(403);
    expect((await call("/api/payments/create-order", "user-123", "ws-other", { amount: 100 })).status).toBe(403);
    expect(await orderRows()).toBe(0);
    expect(await balance("ws-other")).toBe(77);
  });

  it("another member of the same workspace cannot confirm someone else's order", async () => {
    await addMember("ws-abc", "user-teammate", "member");
    const orderId = await paidOrder("user-123");
    expect((await call("/api/payments/verify", "user-teammate", null, { order_id: orderId })).status).toBe(404);
    expect(await balance("ws-abc")).toBe(0);
  });

  it("every route answers 401 without an identity", async () => {
    expect((await call("/api/wallet", null, "ws-abc")).status).toBe(401);
    expect((await call("/api/wallet/history", null, "ws-abc")).status).toBe(401);
    expect((await call("/api/payments/create-order", null, "ws-abc", { amount: 100 })).status).toBe(401);
    expect((await call("/api/payments/verify", null, null, { order_id: "x" })).status).toBe(401);
  });

  it("routes fail closed when the host forgot to mount the workspace middleware", async () => {
    const bare = buildApp({ mountWorkspace: false });
    expect((await call("/api/wallet", "user-123", "ws-abc", undefined, bare)).status).toBe(400);
    expect((await call("/api/wallet/history", "user-123", "ws-abc", undefined, bare)).status).toBe(400);
    expect((await call("/api/payments/create-order", "user-123", "ws-abc", { amount: 100 }, bare)).status).toBe(400);
    expect(await orderRows()).toBe(0);
  });

  it("a database failure is a generic error that does not leak the cause", async () => {
    await db.prepare("DROP TABLE credit_ledger").run();
    const res = await call("/api/wallet/history", "user-123", "ws-abc");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/credit_ledger|no such table|SQLITE|D1_ERROR/i);
  });
});
