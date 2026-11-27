import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_marketplace_splits.sql?raw";
import { MarketplaceSplitsService, createMarketplaceSplitsRoutes } from "../src/index.ts";
import type { SplitsEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_split_alpha";
const WS_BETA = "ws_split_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS split_payouts").run();
  await db.prepare("DROP TABLE IF EXISTS split_transactions").run();
  await db.prepare("DROP TABLE IF EXISTS split_contracts").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Marketplace Splits & Escrow Core Logic", () => {
  it("calculates platform fee and holds vendor share in escrow", async () => {
    const service = new MarketplaceSplitsService(db);
    // Custom contract: 15% platform fee, 7 days escrow
    await service.setVendorContract({
      workspaceId: WS_ALPHA,
      vendorId: "vendor_1",
      platformFeePercent: 15.0,
      escrowDays: 7,
      payoutMethod: "stripe_connect",
      payoutDestination: "acct_stripe_123",
    });

    const tx = await service.processSplit(WS_ALPHA, "vendor_1", "order_101", 10000); // $100

    expect(tx.id).toMatch(/^stx_[a-f0-9]{32}$/);
    expect(tx.gross_amount_cents).toBe(10000);
    expect(tx.platform_fee_cents).toBe(1500); // 15%
    expect(tx.vendor_amount_cents).toBe(8500); // 85%
    expect(tx.status).toBe("in_escrow");

    // Balance should show 8500 in escrow, 0 available
    const balance = await service.getVendorBalance(WS_ALPHA, "vendor_1");
    expect(balance.escrow_cents).toBe(8500);
    expect(balance.available_cents).toBe(0);
    expect(balance.paid_out_cents).toBe(0);
  });

  it("releases escrow when holding period expires and enables payouts", async () => {
    const service = new MarketplaceSplitsService(db);
    // Contract with 0 escrow days (immediate availability)
    await service.setVendorContract({
      workspaceId: WS_ALPHA,
      vendorId: "vendor_instant",
      platformFeePercent: 10.0,
      escrowDays: 0,
    });

    await service.processSplit(WS_ALPHA, "vendor_instant", "order_202", 5000); // $50

    // Immediate balance availability
    const balance = await service.getVendorBalance(WS_ALPHA, "vendor_instant");
    expect(balance.available_cents).toBe(4500);
    expect(balance.escrow_cents).toBe(0);

    // Request payout exceeding available balance -> fails
    const overPayout = await service.requestPayout(WS_ALPHA, "vendor_instant", 5000);
    expect(overPayout.ok).toBe(false);
    expect(overPayout.error).toContain("Insufficient available balance");

    // Request valid payout -> succeeds
    const okPayout = await service.requestPayout(WS_ALPHA, "vendor_instant", 4500);
    expect(okPayout.ok).toBe(true);
    expect(okPayout.payout?.amount_cents).toBe(4500);
    expect(okPayout.payout?.status).toBe("paid");

    // Post-payout balance
    const postBalance = await service.getVendorBalance(WS_ALPHA, "vendor_instant");
    expect(postBalance.available_cents).toBe(0);
    expect(postBalance.paid_out_cents).toBe(4500);
  });

  it("strictly isolates vendor contracts and balances between workspaces", async () => {
    const service = new MarketplaceSplitsService(db);
    await service.setVendorContract({ workspaceId: WS_ALPHA, vendorId: "v_common", platformFeePercent: 5.0 });
    await service.setVendorContract({ workspaceId: WS_BETA, vendorId: "v_common", platformFeePercent: 25.0 });

    const cAlpha = await service.getVendorContract(WS_ALPHA, "v_common");
    const cBeta = await service.getVendorContract(WS_BETA, "v_common");

    expect(cAlpha.platform_fee_percent).toBe(5.0);
    expect(cBeta.platform_fee_percent).toBe(25.0);
  });
});

describe("Marketplace Splits HTTP API", () => {
  it("provides full HTTP workflow for contracts, splits, balances, and payouts", async () => {
    const app = new Hono<SplitsEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createMarketplaceSplitsRoutes());

    // 1. POST /marketplace/contracts
    const setRes = await app.request(
      "/api/marketplace/contracts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({
          vendorId: "creator_bob",
          platformFeePercent: 20.0,
          escrowDays: 0,
          payoutMethod: "wise",
        }),
      },
      { DB: db },
    );
    expect(setRes.status).toBe(201);

    // 2. GET /marketplace/contracts/:vendorId
    const getRes = await app.request("/api/marketplace/contracts/creator_bob", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as { contract: { platform_fee_percent: number } };
    expect(getJson.contract.platform_fee_percent).toBe(20.0);

    // 3. POST /marketplace/splits
    const splitRes = await app.request(
      "/api/marketplace/splits",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({
          vendorId: "creator_bob",
          orderId: "ord_999",
          grossAmountCents: 20000,
        }),
      },
      { DB: db },
    );
    expect(splitRes.status).toBe(201);
    const splitJson = (await splitRes.json()) as { transaction: { vendor_amount_cents: number } };
    expect(splitJson.transaction.vendor_amount_cents).toBe(16000); // 80%

    // 4. GET /marketplace/balances/:vendorId
    const balRes = await app.request("/api/marketplace/balances/creator_bob", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(balRes.status).toBe(200);
    const balJson = (await balRes.json()) as { balance: { available_cents: number } };
    expect(balJson.balance.available_cents).toBe(16000);

    // 5. POST /marketplace/payouts
    const payRes = await app.request(
      "/api/marketplace/payouts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({
          vendorId: "creator_bob",
          amountCents: 16000,
        }),
      },
      { DB: db },
    );
    expect(payRes.status).toBe(201);
    const payJson = (await payRes.json()) as { payout: { status: string } };
    expect(payJson.payout.status).toBe("paid");

    // 6. GET /marketplace/payouts
    const listRes = await app.request("/api/marketplace/payouts?vendorId=creator_bob", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { payouts: unknown[] };
    expect(listJson.payouts).toHaveLength(1);
  });
});
