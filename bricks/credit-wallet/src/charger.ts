import { scoped } from "@poc/sdk";
import type { D1Like } from "./d1.ts";
import { createWallet } from "./wallet.ts";

/**
 * Story 1.13: the small billing surface other bricks are handed through the assembler's `$capability` route option
 * (`credit-wallet.walletCharger`), so they can charge a workspace's wallet without importing this brick.
 *
 * It is the wallet's own atomic deduction and refund (story 0.7 / 0.9): one D1 batch each, refused by the database when
 * the wallet cannot cover a deduction, and recorded once per (workspace, idempotency key). Credits are whole numbers.
 *
 * A debit with a key that is already on the ledger takes nothing and answers `{ ok: true, duplicate: true }`. The
 * wallet's deduction checks the balance before the key, so a retry whose earlier attempt committed (and left too little
 * for a second one) would be refused for the balance; `debit` therefore looks the key up before answering a refusal.
 */
export type ChargeResult =
  | { ok: true; balanceAfter: number; duplicate: boolean }
  | { ok: false; code: "INSUFFICIENT_CREDITS" | "WALLET_NOT_FOUND"; balance: number };

export type RefundResult =
  | { ok: true; balanceAfter: number; duplicate: boolean; credits: number }
  | { ok: false; code: "WALLET_NOT_FOUND" | "NOTHING_TO_REFUND"; balance: number };

export interface WalletCharger {
  /** The workspace's balance in credits; 0 when it has no wallet yet. */
  balance(db: D1Like, workspaceId: string): Promise<number>;
  /** Takes `credits` (a positive whole number) once for `idempotencyKey`; `userId` is recorded on the ledger row. */
  debit(db: D1Like, workspaceId: string, credits: number, idempotencyKey: string, reason: string, userId?: string): Promise<ChargeResult>;
  /**
   * Gives back up to `credits` of the deduction recorded under `againstKey`, once for `idempotencyKey` (a key of its own).
   * Nothing is refunded (`NOTHING_TO_REFUND`) unless that deduction is on the ledger, and never more than it took, so
   * it is safe to call when it is unknown whether the deduction committed.
   */
  refund(
    db: D1Like,
    workspaceId: string,
    credits: number,
    idempotencyKey: string,
    againstKey: string,
    reason: string,
    userId?: string,
  ): Promise<RefundResult>;
  /** The ledger entry recorded under a key in this workspace, as a whole number of credits moved, or null if none. */
  settled(db: D1Like, workspaceId: string, idempotencyKey: string): Promise<{ credits: number; type: "deduction" | "topup" } | null>;
}

function checkKey(idempotencyKey: string): void {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200) {
    throw new RangeError("idempotencyKey must be 1 to 200 characters");
  }
}

async function settled(db: D1Like, workspaceId: string, idempotencyKey: string): Promise<{ credits: number; type: "deduction" | "topup" } | null> {
  checkKey(idempotencyKey);
  const row = await scoped(db, workspaceId).first<{ amount: number; type: "deduction" | "topup" }>("credit_ledger", "idempotency_key = ?", [idempotencyKey]);
  return row ? { credits: Math.abs(row.amount), type: row.type } : null;
}

export const walletCharger: WalletCharger = Object.freeze({
  async balance(db: D1Like, workspaceId: string): Promise<number> {
    return (await createWallet(db, undefined).getBalance(workspaceId)) ?? 0;
  },

  async debit(db: D1Like, workspaceId: string, credits: number, idempotencyKey: string, reason: string, userId = "system"): Promise<ChargeResult> {
    checkKey(idempotencyKey);
    const wallet = createWallet(db, undefined);
    // createWallet().deduct refuses an amount that is not a positive whole number (RangeError).
    const result = await wallet.deduct({
      workspaceId,
      userId,
      amount: credits,
      reason: reason.slice(0, 200) || "usage",
      idempotencyKey,
    });
    if (result.ok) return { ok: true, balanceAfter: result.balanceAfter, duplicate: result.duplicate };
    // The overdraw check runs before the key check: an earlier attempt with this key may have committed.
    const earlier = await settled(db, workspaceId, idempotencyKey);
    if (earlier && earlier.type === "deduction") return { ok: true, balanceAfter: (await wallet.getBalance(workspaceId)) ?? 0, duplicate: true };
    return {
      ok: false,
      code: result.reason === "insufficient_balance" ? "INSUFFICIENT_CREDITS" : "WALLET_NOT_FOUND",
      balance: result.balance ?? 0,
    };
  },

  async refund(
    db: D1Like,
    workspaceId: string,
    credits: number,
    idempotencyKey: string,
    againstKey: string,
    reason: string,
    userId = "system",
  ): Promise<RefundResult> {
    checkKey(idempotencyKey);
    if (!Number.isSafeInteger(credits) || credits <= 0) throw new RangeError("credits must be a positive whole number");
    const debited = await settled(db, workspaceId, againstKey);
    if (!debited || debited.type !== "deduction") return { ok: false, code: "NOTHING_TO_REFUND", balance: 0 };
    const amount = Math.min(credits, debited.credits);
    const result = await createWallet(db, undefined).refund({
      workspaceId,
      userId,
      amount,
      reason: reason.slice(0, 200) || "refund",
      metadata: { refunds: againstKey },
      idempotencyKey,
    });
    if (result.ok) return { ok: true, balanceAfter: result.balanceAfter, duplicate: result.duplicate, credits: amount };
    return { ok: false, code: "WALLET_NOT_FOUND", balance: 0 };
  },

  settled,
});
