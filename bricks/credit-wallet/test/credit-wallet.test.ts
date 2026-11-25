import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_credit_wallet.sql?raw";
import migration0002 from "../migrations/0002_workspace_scoped_idempotency.sql?raw";
import migration0003 from "../migrations/0003_order_currency.sql?raw";
import migration0004 from "../migrations/0004_milli_credits.sql?raw";
import { createWallet, createFakeGateway, type Wallet } from "../src/index.ts";

const db = env.DB as D1Like;
const WS_TEST = "ws_wallet_test";
const WS_OTHER = "ws_wallet_other";

// Deterministic Pseudo-Random Number Generator (Mulberry32) for property testing
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS credit_ledger").run();
  await db.prepare("DROP TABLE IF EXISTS credit_orders").run();
  await db.prepare("DROP TABLE IF EXISTS credit_wallets").run();
  await db.prepare("DROP TABLE IF EXISTS credit_action_costs").run();
  await applyMigration(db, migration);
  await applyMigration(db, migration0002);
  await applyMigration(db, migration0003);
  await applyMigration(db, migration0004);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Credit Wallet Brick Behaviour Suite", () => {
  it("initializes balance and performs atomic top-up and deduction", async () => {
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { currency: "INR" });

    await wallet.openWallet(WS_TEST, 100);
    const bal1 = await wallet.getBalanceMilli(WS_TEST);
    expect(bal1).toBe(100);

    const dedRes = await wallet.deduct({
      workspaceId: WS_TEST,
      userId: "usr_alice",
      amountMilli: 40,
      reason: "API usage deduction",
    });
    expect(dedRes.ok).toBe(true);

    const bal2 = await wallet.getBalanceMilli(WS_TEST);
    expect(bal2).toBe(60);

    const overdrawRes = await wallet.deduct({
      workspaceId: WS_TEST,
      userId: "usr_alice",
      amountMilli: 100,
      reason: "Excessive deduction",
    });
    expect(overdrawRes.ok).toBe(false);
    if (!overdrawRes.ok) {
      expect(overdrawRes.reason).toBe("insufficient_balance");
      expect(overdrawRes.balanceMilli).toBe(60);
    }

    const bal3 = await wallet.getBalanceMilli(WS_TEST);
    expect(bal3).toBe(60);
  });

  it("handles concurrent deductions without ever going negative", async () => {
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { currency: "INR" });

    // Initial balance: 100
    await wallet.openWallet(WS_TEST, 100);

    // Launch 10 concurrent deductions of 15 each = 150 requested (exceeds 100)
    const deductionPromises = Array.from({ length: 10 }, (_, i) =>
      wallet.deduct({
        workspaceId: WS_TEST,
        userId: `usr_concurrent_${i}`,
        amountMilli: 15,
        reason: `Concurrent deduction ${i}`,
        idempotencyKey: `concurrent_deduct_${i}`,
      })
    );

    const results = await Promise.all(deductionPromises);
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);

    // At most 6 can succeed (6 * 15 = 90 <= 100; 7 * 15 = 105 > 100)
    expect(successes.length).toBeLessThanOrEqual(6);
    expect(failures.length).toBeGreaterThanOrEqual(4);
    for (const f of failures) {
      expect(f.ok).toBe(false);
      if (!f.ok) {
        expect(f.reason).toBe("insufficient_balance");
      }
    }

    const finalBalance = await wallet.getBalanceMilli(WS_TEST);
    expect(finalBalance).not.toBeNull();
    expect(finalBalance!).toBeGreaterThanOrEqual(0);
    expect(finalBalance).toBe(100 - successes.length * 15);
  });

  it("credits a duplicate payment webhook only once (idempotent confirmation)", async () => {
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { currency: "INR" });
    await wallet.openWallet(WS_TEST, 0);

    // Create an order for 50 units (50 credits)
    const order = await wallet.createOrder({
      workspaceId: WS_TEST,
      userId: "usr_payer",
      amount: 50,
    });
    expect(order.orderId).toBeDefined();

    // Set gateway status to PAID (simulating payment gateway webhook/completion)
    gateway.setOrder(order.orderId, { status: "PAID" });

    // First confirmation: PAID
    const conf1 = await wallet.confirmOrder(order.orderId);
    expect(conf1.status).toBe("PAID");
    expect(conf1.credited).toBe(true);

    const balAfter1 = await wallet.getBalanceMilli(WS_TEST);
    expect(balAfter1).toBe(50_000);

    // Second confirmation: duplicate webhook callback
    const conf2 = await wallet.confirmOrder(order.orderId);
    expect(conf2.status).toBe("already_processed");
    expect(conf2.credited).toBe(false);

    // Third confirmation concurrently
    const [c3, c4] = await Promise.all([
      wallet.confirmOrder(order.orderId),
      wallet.confirmOrder(order.orderId),
    ]);
    expect(c3.credited).toBe(false);
    expect(c4.credited).toBe(false);

    // Final balance remains strictly 50 credits (thousandths since story 2.5)
    const finalBal = await wallet.getBalanceMilli(WS_TEST);
    expect(finalBal).toBe(50_000);

    // Ledger must contain exactly 1 topup row
    const ledgerRows = await db
      .prepare("SELECT * FROM credit_ledger WHERE workspace_id = ? AND type = 'topup'")
      .bind(WS_TEST)
      .all<any>();
    expect(ledgerRows.results).toHaveLength(1);
    expect(ledgerRows.results![0].amount_milli).toBe(50_000);
  });

  it("supports a refund or reversal path that atomically restores balance", async () => {
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { currency: "INR" });
    await wallet.openWallet(WS_TEST, 100);

    // Deduct 40 credits
    const deductRes = await wallet.deduct({
      workspaceId: WS_TEST,
      userId: "usr_buyer",
      amountMilli: 40,
      reason: "Order purchase",
      idempotencyKey: "charge_order_99",
    });
    expect(deductRes.ok).toBe(true);
    expect(await wallet.getBalanceMilli(WS_TEST)).toBe(60);

    // Refund 40 credits
    const refundRes = await (wallet as any).refund({
      workspaceId: WS_TEST,
      userId: "usr_buyer",
      amountMilli: 40,
      reason: "Order cancelled refund",
      idempotencyKey: "refund_order_99",
    });
    expect(refundRes.ok).toBe(true);
    expect(refundRes.balanceAfterMilli).toBe(100);

    // Replaying same refund idempotency key is a duplicate and does not increase balance
    const dupRefund = await (wallet as any).refund({
      workspaceId: WS_TEST,
      userId: "usr_buyer",
      amountMilli: 40,
      reason: "Order cancelled duplicate refund",
      idempotencyKey: "refund_order_99",
    });
    expect(dupRefund.ok).toBe(true);
    expect(dupRefund.duplicate).toBe(true);
    expect(dupRefund.balanceAfterMilli).toBe(100);

    expect(await wallet.getBalanceMilli(WS_TEST)).toBe(100);
  });

  it("enforces rounding and smallest currency units (integer units)", async () => {
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { currency: "INR" });
    await wallet.openWallet(WS_TEST, 50);

    // Negative path: fractional amounts rejected
    await expect(
      wallet.deduct({
        workspaceId: WS_TEST,
        userId: "usr_alice",
        amountMilli: 10.5,
        reason: "Fractional",
      })
    ).rejects.toThrow(RangeError);

    await expect(
      wallet.deduct({
        workspaceId: WS_TEST,
        userId: "usr_alice",
        amountMilli: -5,
        reason: "Negative amount",
      })
    ).rejects.toThrow(RangeError);

    await expect(
      wallet.deduct({
        workspaceId: WS_TEST,
        userId: "usr_alice",
        amountMilli: 0,
        reason: "Zero amount",
      })
    ).rejects.toThrow(RangeError);

    await expect(
      wallet.openWallet("ws_bad", -10)
    ).rejects.toThrow(RangeError);

    await expect(
      wallet.openWallet("ws_bad_frac", 12.34)
    ).rejects.toThrow(RangeError);

    // Balance untouched
    expect(await wallet.getBalanceMilli(WS_TEST)).toBe(50);
  });

  it("verifies ledger sums to final balance after 100 random ops (property test with fixed seed)", async () => {
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { currency: "INR" });
    const rng = mulberry32(42);

    const initialBalance = 150;
    await wallet.openWallet(WS_TEST, initialBalance);

    let expectedBalance = initialBalance;

    for (let i = 0; i < 100; i++) {
      const isTopup = rng() > 0.65;
      const amount = Math.floor(rng() * 20) + 1; // 1 to 20

      if (isTopup) {
        const refundRes = await (wallet as any).refund({
          workspaceId: WS_TEST,
          userId: "usr_sim",
          amountMilli: amount,
          reason: `Sim topup ${i}`,
          idempotencyKey: `sim_topup_${i}`,
        });
        expect(refundRes.ok).toBe(true);
        expectedBalance += amount;
      } else {
        const deductRes = await wallet.deduct({
          workspaceId: WS_TEST,
          userId: "usr_sim",
          amountMilli: amount,
          reason: `Sim deduct ${i}`,
          idempotencyKey: `sim_deduct_${i}`,
        });
        if (amount <= expectedBalance) {
          expect(deductRes.ok).toBe(true);
          expectedBalance -= amount;
        } else {
          expect(deductRes.ok).toBe(false);
        }
      }
    }

    const actualBalance = await wallet.getBalanceMilli(WS_TEST);
    expect(actualBalance).toBe(expectedBalance);

    // Verify database ledger integrity
    const ledgerRows = await db
      .prepare("SELECT amount_milli AS amount, balance_after_milli AS balance_after FROM credit_ledger WHERE workspace_id = ? ORDER BY rowid ASC")
      .bind(WS_TEST)
      .all<{ amount: number; balance_after: number }>();

    expect(ledgerRows.results).toBeDefined();
    let computedBalance = 0; // sum of delta entries in ledger
    for (const row of ledgerRows.results!) {
      computedBalance += row.amount;
      expect(row.balance_after).toBeGreaterThanOrEqual(0);
    }
    // Note: initial openWallet didn't create a ledger row, so sum of ledger deltas + initialBalance = actualBalance
    expect(initialBalance + computedBalance).toBe(actualBalance);
  });

  it("refuses cross-workspace deduction and never leaks balance between tenants", async () => {
    const gateway = createFakeGateway();
    const wallet = createWallet(db, gateway, { currency: "INR" });

    await wallet.openWallet(WS_TEST, 500);
    await wallet.openWallet(WS_OTHER, 10);

    // Attempting to deduct from WS_OTHER requesting more than WS_OTHER has, but less than WS_TEST has
    const crossRes = await wallet.deduct({
      workspaceId: WS_OTHER,
      userId: "usr_mallory",
      amountMilli: 100,
      reason: "Attempted cross-workspace drain",
    });
    expect(crossRes.ok).toBe(false);
    if (!crossRes.ok) {
      expect(crossRes.reason).toBe("insufficient_balance");
      expect(crossRes.balanceMilli).toBe(10);
    }

    // Attempting to deduct from non-existent workspace
    const missingRes = await wallet.deduct({
      workspaceId: "ws_completely_nonexistent",
      userId: "usr_mallory",
      amountMilli: 10,
      reason: "Non-existent wallet",
    });
    expect(missingRes.ok).toBe(false);
    if (!missingRes.ok) {
      expect(missingRes.reason).toBe("wallet_not_found");
    }

    // WS_TEST remains completely untouched
    expect(await wallet.getBalanceMilli(WS_TEST)).toBe(500);
    expect(await wallet.getBalanceMilli(WS_OTHER)).toBe(10);

    // Ledger for WS_TEST has 0 rows
    const testLedger = await db
      .prepare("SELECT count(*) as count FROM credit_ledger WHERE workspace_id = ?")
      .bind(WS_TEST)
      .first<{ count: number }>();
    expect(testLedger?.count).toBe(0);
  });
});
