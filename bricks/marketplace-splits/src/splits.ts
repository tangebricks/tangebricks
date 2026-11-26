import { scoped, type D1Like } from "@poc/sdk";

export type PayoutMethod = "stripe_connect" | "wise" | "manual";
export type TransactionStatus = "in_escrow" | "available" | "paid_out" | "refunded";
export type PayoutStatus = "processing" | "paid" | "failed";

export interface VendorContract {
  id: string;
  workspace_id: string;
  vendor_id: string;
  platform_fee_percent: number;
  escrow_days: number;
  payout_method: PayoutMethod;
  payout_destination: string | null;
  created_at: string;
}

export interface SplitTransaction {
  id: string;
  workspace_id: string;
  vendor_id: string;
  order_id: string;
  gross_amount_cents: number;
  platform_fee_cents: number;
  vendor_amount_cents: number;
  currency: string;
  status: TransactionStatus;
  available_at: string;
  created_at: string;
}

export interface VendorBalance {
  vendor_id: string;
  escrow_cents: number;
  available_cents: number;
  paid_out_cents: number;
  currency: string;
}

export interface PayoutRecord {
  id: string;
  workspace_id: string;
  vendor_id: string;
  amount_cents: number;
  currency: string;
  payout_method: string;
  status: PayoutStatus;
  created_at: string;
  completed_at: string | null;
}

export interface SetContractInput {
  workspaceId: string;
  vendorId: string;
  platformFeePercent?: number;
  escrowDays?: number;
  payoutMethod?: PayoutMethod;
  payoutDestination?: string;
}

export class MarketplaceSplitsService {
  constructor(private readonly db: D1Like) {}

  /**
   * Sets or updates revenue share terms and payout configurations for a vendor.
   */
  async setVendorContract(input: SetContractInput): Promise<VendorContract> {
    const id = `scon_${crypto.randomUUID().replace(/-/g, "")}`;
    const fee = input.platformFeePercent !== undefined ? Math.max(0, Math.min(100, input.platformFeePercent)) : 10.0;
    const escrowDays = input.escrowDays !== undefined ? Math.max(0, input.escrowDays) : 7;
    const method = input.payoutMethod || "stripe_connect";
    const dest = input.payoutDestination?.trim() || null;
    const now = new Date().toISOString();

    const existing = await scoped(this.db, input.workspaceId).first<VendorContract>(
      "split_contracts",
      "vendor_id = ?",
      [input.vendorId.trim()]
    );

    if (existing) {
      await scoped(this.db, input.workspaceId).update(
        "split_contracts",
        {
          platform_fee_percent: fee,
          escrow_days: escrowDays,
          payout_method: method,
          payout_destination: dest,
        },
        "vendor_id = ?",
        [input.vendorId.trim()]
      );
    } else {
      await scoped(this.db, input.workspaceId).insert("split_contracts", {
        id,
        vendor_id: input.vendorId.trim(),
        platform_fee_percent: fee,
        escrow_days: escrowDays,
        payout_method: method,
        payout_destination: dest,
        created_at: now,
      });
    }

    return {
      id,
      workspace_id: input.workspaceId,
      vendor_id: input.vendorId.trim(),
      platform_fee_percent: fee,
      escrow_days: escrowDays,
      payout_method: method,
      payout_destination: dest,
      created_at: now,
    };
  }

  /**
   * Retrieves the contract for a vendor.
   */
  async getVendorContract(workspaceId: string, vendorId: string): Promise<VendorContract> {
    const row = await scoped(this.db, workspaceId).first<VendorContract>(
      "split_contracts",
      "vendor_id = ?",
      [vendorId.trim()]
    );

    if (row) return row;

    // Default contract if not customized
    return {
      id: "default",
      workspace_id: workspaceId,
      vendor_id: vendorId.trim(),
      platform_fee_percent: 10.0,
      escrow_days: 7,
      payout_method: "stripe_connect",
      payout_destination: null,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Splits an incoming payment gross amount between platform and vendor with escrow hold.
   */
  async processSplit(
    workspaceId: string,
    vendorId: string,
    orderId: string,
    grossAmountCents: number,
    currency = "usd"
  ): Promise<SplitTransaction> {
    const contract = await this.getVendorContract(workspaceId, vendorId);

    const platformFeeCents = Math.round(grossAmountCents * (contract.platform_fee_percent / 100));
    const vendorAmountCents = grossAmountCents - platformFeeCents;
    const now = new Date();
    const availableAt = new Date(now.getTime() + contract.escrow_days * 86400 * 1000).toISOString();
    const nowIso = now.toISOString();
    const txId = `stx_${crypto.randomUUID().replace(/-/g, "")}`;
    const curr = currency.toLowerCase().slice(0, 3);

    const status: TransactionStatus = contract.escrow_days === 0 ? "available" : "in_escrow";

    await scoped(this.db, workspaceId).insert("split_transactions", {
      id: txId,
      vendor_id: vendorId.trim(),
      order_id: orderId.trim(),
      gross_amount_cents: grossAmountCents,
      platform_fee_cents: platformFeeCents,
      vendor_amount_cents: vendorAmountCents,
      currency: curr,
      status,
      available_at: availableAt,
      created_at: nowIso,
    });

    return {
      id: txId,
      workspace_id: workspaceId,
      vendor_id: vendorId.trim(),
      order_id: orderId.trim(),
      gross_amount_cents: grossAmountCents,
      platform_fee_cents: platformFeeCents,
      vendor_amount_cents: vendorAmountCents,
      currency: curr,
      status,
      available_at: availableAt,
      created_at: nowIso,
    };
  }

  /**
   * Transitions escrow transactions whose holding period has passed to 'available'.
   */
  async releaseMaturedEscrows(workspaceId: string): Promise<number> {
    const nowIso = new Date().toISOString();
    const res = await scoped(this.db, workspaceId).update(
      "split_transactions",
      { status: "available" },
      "status = 'in_escrow' AND available_at <= ?",
      [nowIso]
    );

    return res.meta.changes;
  }

  /**
   * Calculates vendor financial balances across escrow, available, and paid out.
   */
  async getVendorBalance(
    workspaceId: string,
    vendorId: string,
    currency = "usd"
  ): Promise<VendorBalance> {
    // Release any escrows that matured before querying balance
    await this.releaseMaturedEscrows(workspaceId);

    const curr = currency.toLowerCase().slice(0, 3);
    interface SumRow {
      status: TransactionStatus;
      sum_cents: number;
    }

    const rows = (await scoped(this.db, workspaceId).raw(
      `SELECT status, SUM(vendor_amount_cents) as sum_cents
       FROM split_transactions
       WHERE workspace_id = ? AND vendor_id = ? AND currency = ?
       GROUP BY status`,
      [workspaceId, vendorId.trim(), curr]
    ).all<SumRow>()).results;

    let escrowCents = 0;
    let availableCents = 0;
    let paidOutCents = 0;

    for (const r of rows) {
      if (r.status === "in_escrow") escrowCents = r.sum_cents || 0;
      if (r.status === "available") availableCents = r.sum_cents || 0;
      if (r.status === "paid_out") paidOutCents = r.sum_cents || 0;
    }

    return {
      vendor_id: vendorId.trim(),
      escrow_cents: escrowCents,
      available_cents: availableCents,
      paid_out_cents: paidOutCents,
      currency: curr,
    };
  }

  // px-stub: quarantined: the balance check and the paid_out updates are not atomic, so two payouts can spend one balance
  /**
   * Requests a payout from available balance to vendor's configured external destination.
   */
  async requestPayout(
    workspaceId: string,
    vendorId: string,
    amountCents: number,
    currency = "usd"
  ): Promise<{ ok: boolean; payout?: PayoutRecord; error?: string }> {
    const curr = currency.toLowerCase().slice(0, 3);
    const balance = await this.getVendorBalance(workspaceId, vendorId, curr);

    if (amountCents > balance.available_cents) {
      return {
        ok: false,
        error: `Insufficient available balance: requested ${amountCents} cents, available ${balance.available_cents} cents`,
      };
    }

    const contract = await this.getVendorContract(workspaceId, vendorId);
    const payoutId = `pyt_${crypto.randomUUID().replace(/-/g, "")}`;
    const nowIso = new Date().toISOString();

    // Mark corresponding available transactions as paid_out up to requested amount
    let remainingToDeduct = amountCents;
    interface AvailableTx {
      id: string;
      vendor_amount_cents: number;
    }
    const availRows = await scoped(this.db, workspaceId).select<AvailableTx>(
      "split_transactions",
      "vendor_id = ? AND currency = ? AND status = 'available'",
      [vendorId.trim(), curr],
      { orderBy: "created_at ASC" }
    );

    for (const tx of availRows) {
      if (remainingToDeduct <= 0) break;
      await scoped(this.db, workspaceId).update(
        "split_transactions",
        { status: "paid_out" },
        "id = ?",
        [tx.id]
      );
      remainingToDeduct -= tx.vendor_amount_cents;
    }

    // Insert payout record
    await scoped(this.db, workspaceId).insert("split_payouts", {
      id: payoutId,
      vendor_id: vendorId.trim(),
      amount_cents: amountCents,
      currency: curr,
      payout_method: contract.payout_method,
      status: "paid",
      created_at: nowIso,
      completed_at: nowIso,
    });

    return {
      ok: true,
      payout: {
        id: payoutId,
        workspace_id: workspaceId,
        vendor_id: vendorId.trim(),
        amount_cents: amountCents,
        currency: curr,
        payout_method: contract.payout_method,
        status: "paid",
        created_at: nowIso,
        completed_at: nowIso,
      },
    };
  }

  /**
   * Lists past payout records.
   */
  async listPayouts(workspaceId: string, vendorId?: string): Promise<PayoutRecord[]> {
    return scoped(this.db, workspaceId).select<PayoutRecord>(
      "split_payouts",
      vendorId ? "vendor_id = ?" : undefined,
      vendorId ? [vendorId.trim()] : [],
      { orderBy: "created_at DESC", limit: 50 }
    );
  }
}
