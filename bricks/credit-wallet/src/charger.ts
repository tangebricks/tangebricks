import { findWorkspaceState, hasWorkspaceRegistry, scoped } from "@poc/sdk";
import { chargeAction, parseDefaultActionCosts } from "./costs.ts";
import type { ChargeActionResult } from "./costs.ts";
import type { D1Like } from "./d1.ts";
import { createWallet } from "./wallet.ts";

/**
 * Story 1.13: the small billing surface other bricks are handed through the assembler's `$capability` route option
 * (`credit-wallet.walletCharger`), so they can charge a workspace's wallet without importing this brick.
 *
 * It is the wallet's own atomic deduction and refund (story 0.7 / 0.9): one D1 batch each, refused by the database when
 * the wallet cannot cover a deduction, and recorded once per (workspace, idempotency key).
 *
 * Units (story 2.5): every amount is a whole number of thousandths of a credit ("milli-credits"); 1 credit is 1000.
 * The names say so (`milli`, `balanceAfterMilli`), so a caller written for whole credits fails to compile instead of
 * charging a thousandth of what it meant.
 *
 * A debit records the tag `op: "charger"`. Retried with a key that is already on the ledger, it takes nothing and answers
 * `{ ok: true, duplicate: true }` only when that row is a charger debit of the same amount; the wallet's deduction makes
 * that check itself, also when the balance left cannot cover a second one (it checks the balance before the key). A key
 * used for anything else (a route deduction, an action charge, a transfer, a top-up) is `IDEMPOTENCY_KEY_REUSED`.
 */
export type ChargeResult =
  | { ok: true; balanceAfterMilli: number; duplicate: boolean }
  | { ok: false; code: "INSUFFICIENT_CREDITS" | "WALLET_NOT_FOUND" | "IDEMPOTENCY_KEY_REUSED"; balanceMilli: number };

export type RefundResult =
  | { ok: true; balanceAfterMilli: number; duplicate: boolean; milli: number }
  | { ok: false; code: "WALLET_NOT_FOUND" | "NOTHING_TO_REFUND" | "IDEMPOTENCY_KEY_REUSED"; balanceMilli: number };

/** Story 2.6: the outcome of `grant`. Every refusal added nothing. */
export type GrantResult =
  | { ok: true; balanceAfterMilli: number; duplicate: boolean; opened: boolean }
  | { ok: false; code: "WALLET_NOT_FOUND" | "IDEMPOTENCY_KEY_REUSED"; balanceMilli: number };

export interface ChargeActionOptions {
  /** Recorded on the ledger row. Default "system". */
  userId?: string;
  /** Costs that apply when the workspace has no row of its own: the `defaultActionCosts` setting's text, or a parsed map. */
  defaultCosts?: string | ReadonlyMap<string, number>;
}

export interface WalletCharger {
  /** The workspace's balance in thousandths of a credit; 0 when it has no wallet yet. */
  balanceMilli(db: D1Like, workspaceId: string): Promise<number>;
  /** Takes `milli` (a positive whole number of thousandths) once for `idempotencyKey`; `userId` is recorded on the ledger row. */
  debit(db: D1Like, workspaceId: string, milli: number, idempotencyKey: string, reason: string, userId?: string): Promise<ChargeResult>;
  /**
   * Gives back up to `milli` of the deduction recorded under `againstKey`, once for `idempotencyKey` (a key of its own).
   * Nothing is refunded (`NOTHING_TO_REFUND`) unless that deduction is on the ledger, and never more than it took, so
   * it is safe to call when it is unknown whether the deduction committed.
   */
  refund(
    db: D1Like,
    workspaceId: string,
    milli: number,
    idempotencyKey: string,
    againstKey: string,
    reason: string,
    userId?: string,
  ): Promise<RefundResult>;
  /** The ledger entry recorded under a key in this workspace, as thousandths moved, or null if none. */
  settled(db: D1Like, workspaceId: string, idempotencyKey: string): Promise<{ milli: number; type: "deduction" | "topup" } | null>;
  /**
   * Story 2.5: takes the workspace's cost for `action` times `quantity` (1 to 10000), once for `idempotencyKey`.
   * UNKNOWN_ACTION when neither the workspace nor `options.defaultCosts` prices the action.
   */
  chargeAction(
    db: D1Like,
    workspaceId: string,
    action: string,
    quantity: number,
    idempotencyKey: string,
    reason: string,
    options?: ChargeActionOptions,
  ): Promise<ChargeActionResult>;
  /**
   * Story 2.6: adds `milli` (a positive whole number of thousandths) to the workspace's wallet once for `idempotencyKey`,
   * as a top-up tagged `op: "grant"`. A retry is `duplicate: true` only when the row under the key is a grant of the
   * same amount; a key used for anything else is `IDEMPOTENCY_KEY_REUSED`. A workspace with no wallet gets one opened
   * only when it is live (in the workspace registry and not suspended); otherwise, and with no registry, the answer is
   * `WALLET_NOT_FOUND`.
   */
  grant(db: D1Like, workspaceId: string, milli: number, idempotencyKey: string, reason: string, userId?: string): Promise<GrantResult>;
}

function checkKey(idempotencyKey: string): void {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200) {
    throw new RangeError("idempotencyKey must be 1 to 200 characters");
  }
}

async function settled(db: D1Like, workspaceId: string, idempotencyKey: string): Promise<{ milli: number; type: "deduction" | "topup" } | null> {
  checkKey(idempotencyKey);
  const row = await scoped(db, workspaceId).first<{ amount_milli: number; type: string }>("credit_ledger", "idempotency_key = ?", [idempotencyKey]);
  if (!row || (row.type !== "deduction" && row.type !== "topup")) return null;
  return { milli: Math.abs(row.amount_milli), type: row.type };
}

export const walletCharger: WalletCharger = Object.freeze({
  async balanceMilli(db: D1Like, workspaceId: string): Promise<number> {
    return (await createWallet(db, undefined).getBalanceMilli(workspaceId)) ?? 0;
  },

  async debit(db: D1Like, workspaceId: string, milli: number, idempotencyKey: string, reason: string, userId = "system"): Promise<ChargeResult> {
    checkKey(idempotencyKey);
    const wallet = createWallet(db, undefined);
    // createWallet().deduct refuses an amount that is not a positive whole number of thousandths (RangeError).
    const result = await wallet.deduct({
      workspaceId,
      userId,
      amountMilli: milli,
      reason: reason.slice(0, 200) || "usage",
      idempotencyKey,
      match: { op: "charger" },
    });
    if (result.ok) return { ok: true, balanceAfterMilli: result.balanceAfterMilli, duplicate: result.duplicate };
    // The wallet answers a committed retry of the same deduction (same amount) as a duplicate even when the balance left
    // cannot cover it again, and refuses a key used for anything else (story 2.5): never ok without a deduction.
    return {
      ok: false,
      code:
        result.reason === "insufficient_balance" ? "INSUFFICIENT_CREDITS" : result.reason === "idempotency_key_reused" ? "IDEMPOTENCY_KEY_REUSED" : "WALLET_NOT_FOUND",
      balanceMilli: result.balanceMilli ?? 0,
    };
  },

  async refund(
    db: D1Like,
    workspaceId: string,
    milli: number,
    idempotencyKey: string,
    againstKey: string,
    reason: string,
    userId = "system",
  ): Promise<RefundResult> {
    checkKey(idempotencyKey);
    if (!Number.isSafeInteger(milli) || milli <= 0) throw new RangeError("milli must be a positive whole number of thousandths");
    const debited = await settled(db, workspaceId, againstKey);
    if (!debited || debited.type !== "deduction") return { ok: false, code: "NOTHING_TO_REFUND", balanceMilli: 0 };
    const amountMilli = Math.min(milli, debited.milli);
    const result = await createWallet(db, undefined).refund({
      workspaceId,
      userId,
      amountMilli,
      reason: reason.slice(0, 200) || "refund",
      metadata: { refunds: againstKey },
      idempotencyKey,
    });
    if (result.ok) return { ok: true, balanceAfterMilli: result.balanceAfterMilli, duplicate: result.duplicate, milli: amountMilli };
    if (result.reason === "idempotency_key_reused") return { ok: false, code: "IDEMPOTENCY_KEY_REUSED", balanceMilli: 0 };
    return { ok: false, code: "WALLET_NOT_FOUND", balanceMilli: 0 };
  },

  settled,

  async grant(db: D1Like, workspaceId: string, milli: number, idempotencyKey: string, reason: string, userId = "system"): Promise<GrantResult> {
    checkKey(idempotencyKey);
    if (!Number.isSafeInteger(milli) || milli <= 0) throw new RangeError("milli must be a positive whole number of thousandths");
    const wallet = createWallet(db, undefined);
    let opened = false;
    if ((await wallet.getBalanceMilli(workspaceId)) === null) {
      // A wallet is opened for a live workspace only: one the registry knows and that is not suspended.
      const registry = await hasWorkspaceRegistry(db);
      const state = registry ? await findWorkspaceState(db, workspaceId) : null;
      if (!state || state.suspended) return { ok: false, code: "WALLET_NOT_FOUND", balanceMilli: 0 };
      await wallet.openWallet(workspaceId);
      opened = true;
    }
    const result = await wallet.refund({
      workspaceId,
      userId,
      amountMilli: milli,
      reason: reason.slice(0, 200) || "grant",
      idempotencyKey,
      match: { op: "grant" },
    });
    if (result.ok) return { ok: true, balanceAfterMilli: result.balanceAfterMilli, duplicate: result.duplicate, opened };
    if (result.reason === "idempotency_key_reused") return { ok: false, code: "IDEMPOTENCY_KEY_REUSED", balanceMilli: 0 };
    return { ok: false, code: "WALLET_NOT_FOUND", balanceMilli: 0 };
  },

  async chargeAction(
    db: D1Like,
    workspaceId: string,
    action: string,
    quantity: number,
    idempotencyKey: string,
    reason: string,
    options: ChargeActionOptions = {},
  ): Promise<ChargeActionResult> {
    checkKey(idempotencyKey);
    const defaults = typeof options.defaultCosts === "string" ? parseDefaultActionCosts(options.defaultCosts) : options.defaultCosts;
    return chargeAction(db, workspaceId, {
      userId: options.userId ?? "system",
      action,
      quantity,
      idempotencyKey,
      reason,
      ...(defaults ? { defaults } : {}),
    });
  },
});
