import { scoped, toMilli } from "@poc/sdk";
import type { D1Like } from "./d1.ts";
import { createWallet } from "./wallet.ts";

// Story 2.5: a workspace's price per named action ("email.send", "message:whatsapp"), in thousandths of a credit, and
// the charge that takes `cost x quantity` for an action in one atomic deduction. Nothing here has a built-in price:
// a workspace's own row wins, then the app's optional `defaultActionCosts` setting, and an action priced by neither
// is UNKNOWN_ACTION.

/** An action name: a lowercase letter, then up to 63 of a-z, 0-9, "_", ".", ":" and "-". */
export const ACTION_NAME = /^[a-z][a-z0-9_.:-]{0,63}$/;
/** The most a single action may cost, in thousandths: 999,999.999 credits, the most the `defaultActionCosts` pattern allows. */
export const MAX_ACTION_COST_MILLI = 999_999_999;
/** The most units one charge may take. */
export const MAX_CHARGE_QUANTITY = 10_000;

export interface ActionCost {
  action: string;
  costMilli: number;
  updatedAt: string;
}

export type ChargeActionResult =
  | { ok: true; action: string; quantity: number; costMilli: number; chargedMilli: number; balanceAfterMilli: number; duplicate: boolean }
  | { ok: false; code: "UNKNOWN_ACTION" }
  | { ok: false; code: "INSUFFICIENT_CREDITS"; balanceMilli: number }
  | { ok: false; code: "WALLET_NOT_FOUND" }
  /** Story 2.5: the key is already on the ledger for another operation (another action or quantity, a deduction, a transfer). Nothing was taken. */
  | { ok: false; code: "IDEMPOTENCY_KEY_REUSED" };

export const isActionName = (value: unknown): value is string => typeof value === "string" && ACTION_NAME.test(value);

/**
 * Parses the `defaultActionCosts` setting: comma-separated `action:cost` entries, the cost in credits with up to three
 * decimals (`email.send:0.2,message.send:0.5`). The cost is read after the last ":", so an action may contain ":". An
 * empty string is no defaults. An action listed twice keeps its first cost (later entries for it are ignored). A
 * malformed entry throws RangeError; nothing the manifest's pattern accepts is malformed (tested), so an assembled app
 * cannot fail here when its routes are built.
 */
export function parseDefaultActionCosts(spec: string | undefined): ReadonlyMap<string, number> {
  const costs = new Map<string, number>();
  if (spec === undefined || spec.trim() === "") return costs;
  for (const raw of spec.split(",")) {
    const entry = raw.trim();
    const colon = entry.lastIndexOf(":");
    const action = colon > 0 ? entry.slice(0, colon) : "";
    if (!isActionName(action)) throw new RangeError(`defaultActionCosts: "${entry.slice(0, 80)}" is not action:cost`);
    if (costs.has(action)) continue; // the first entry for an action wins
    costs.set(action, checkCostMilli(toMilli(entry.slice(colon + 1))));
  }
  return costs;
}

function checkCostMilli(costMilli: number): number {
  if (!Number.isSafeInteger(costMilli) || costMilli < 0 || costMilli > MAX_ACTION_COST_MILLI) {
    throw new RangeError("an action cost must be from 0 to 999999.999 credits");
  }
  return costMilli;
}

/** The workspace's own action costs, by action name. */
export async function listActionCosts(db: D1Like, workspaceId: string): Promise<ActionCost[]> {
  const rows = await scoped(db, workspaceId).select<{ action: string; cost_milli: number; updated_at: string }>("credit_action_costs", undefined, [], {
    orderBy: "action ASC",
    limit: 1000,
  });
  return rows.map((r) => ({ action: r.action, costMilli: r.cost_milli, updatedAt: r.updated_at }));
}

/** Sets (or replaces) the workspace's cost for an action. */
export async function setActionCost(db: D1Like, workspaceId: string, action: string, costMilli: number): Promise<void> {
  if (!isActionName(action)) throw new RangeError("an action name is a lowercase letter then up to 63 of a-z 0-9 _ . : -");
  checkCostMilli(costMilli);
  await db
    .prepare(
      "INSERT INTO credit_action_costs (workspace_id, action, cost_milli, updated_at) VALUES (?, ?, ?, datetime('now')) " +
        "ON CONFLICT (workspace_id, action) DO UPDATE SET cost_milli = excluded.cost_milli, updated_at = excluded.updated_at",
    )
    .bind(workspaceId, action, costMilli)
    .run();
}

/** Removes the workspace's own cost for an action (a default, if any, applies again). True if there was one. */
export async function deleteActionCost(db: D1Like, workspaceId: string, action: string): Promise<boolean> {
  if (!isActionName(action)) return false;
  const result = await scoped(db, workspaceId).delete("credit_action_costs", "action = ?", [action]);
  return (result.meta.changes ?? 0) > 0;
}

/** The cost that applies to an action in a workspace: its own row, else the default, else null. */
export async function resolveActionCost(
  db: D1Like,
  workspaceId: string,
  action: string,
  defaults: ReadonlyMap<string, number> = new Map(),
): Promise<{ costMilli: number; source: "workspace" | "default" } | null> {
  if (!isActionName(action)) return null;
  const row = await scoped(db, workspaceId).first<{ cost_milli: number }>("credit_action_costs", "action = ?", [action]);
  if (row) return { costMilli: row.cost_milli, source: "workspace" };
  const fallback = defaults.get(action);
  return fallback === undefined ? null : { costMilli: fallback, source: "default" };
}

export interface ChargeActionInput {
  userId: string;
  action: string;
  /** A whole number of units, 1 to 10000. Default 1. */
  quantity?: number;
  idempotencyKey: string;
  reason?: string;
  defaults?: ReadonlyMap<string, number>;
}

/**
 * Takes `cost x quantity` for `action` from the workspace's wallet in the wallet's own atomic deduction, once per
 * (workspace, key). The workspace is the verified one the caller resolved, passed on its own. A key that is already on
 * the ledger answers with what that charge took, even when the cost has
 * changed since or the balance could not cover a second one.
 */
export async function chargeAction(db: D1Like, workspaceId: string, input: ChargeActionInput): Promise<ChargeActionResult> {
  const { userId, action, idempotencyKey } = input;
  const quantity = input.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_CHARGE_QUANTITY) {
    throw new RangeError(`quantity must be a whole number from 1 to ${MAX_CHARGE_QUANTITY}`);
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 200) {
    throw new RangeError("idempotencyKey must be 1 to 200 characters");
  }
  const wallet = createWallet(db, undefined);
  // The row already under this key: the same charge (a deduction recorded with this action and quantity) answers as a
  // duplicate; anything else is a reused key and takes nothing.
  const earlier = async (): Promise<ChargeActionResult | null> => {
    const row = await scoped(db, workspaceId).first<{ type: string; amount_milli: number; metadata: string | null }>(
      "credit_ledger",
      "idempotency_key = ?",
      [idempotencyKey],
    );
    if (!row) return null;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.metadata ?? "null");
    } catch {
      parsed = null;
    }
    // Anything but a metadata object tagged as this very charge is another operation.
    if (typeof parsed !== "object" || parsed === null) return { ok: false, code: "IDEMPOTENCY_KEY_REUSED" };
    const meta = parsed as { op?: unknown; action?: unknown; quantity?: unknown; cost_milli?: unknown };
    if (row.type !== "deduction" || meta.op !== "action" || meta.action !== action || meta.quantity !== quantity) return { ok: false, code: "IDEMPOTENCY_KEY_REUSED" };
    return {
      ok: true,
      action,
      quantity,
      costMilli: typeof meta.cost_milli === "number" ? meta.cost_milli : Math.trunc(Math.abs(row.amount_milli) / quantity),
      chargedMilli: Math.abs(row.amount_milli),
      balanceAfterMilli: (await wallet.getBalanceMilli(workspaceId)) ?? 0,
      duplicate: true,
    };
  };

  const before = await earlier();
  if (before) return before;
  const cost = await resolveActionCost(db, workspaceId, action, input.defaults);
  if (!cost) return { ok: false, code: "UNKNOWN_ACTION" };
  const chargedMilli = cost.costMilli * quantity;
  if (!Number.isSafeInteger(chargedMilli)) throw new RangeError("the charge is too large");

  if (chargedMilli === 0) {
    // A free action takes nothing, but it still records a zero-amount deduction under its key (the ledger's CHECKs allow
    // it), so a retry after the price has changed is a duplicate, not a new charge at the new price.
    try {
      const inserted = await db
        .prepare(
          "INSERT INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason, metadata, idempotency_key) " +
            "SELECT ?, workspace_id, ?, 'deduction', 0, balance_milli, ?, ?, ? FROM credit_wallets WHERE workspace_id = ?",
        )
        .bind(
          crypto.randomUUID(),
          userId,
          (input.reason ?? "").slice(0, 200) || action,
          JSON.stringify({ action, quantity, cost_milli: 0, cost_source: cost.source, op: "action" }),
          idempotencyKey,
          workspaceId,
        )
        .run();
      if ((inserted.meta.changes ?? 0) === 0) return { ok: false, code: "WALLET_NOT_FOUND" };
    } catch (error) {
      if (/UNIQUE constraint failed/.test(error instanceof Error ? error.message : String(error))) {
        return (await earlier()) ?? { ok: false, code: "IDEMPOTENCY_KEY_REUSED" };
      }
      throw error;
    }
    const balance = (await wallet.getBalanceMilli(workspaceId)) ?? 0;
    return { ok: true, action, quantity, costMilli: 0, chargedMilli: 0, balanceAfterMilli: balance, duplicate: false };
  }

  const result = await wallet.deduct({
    workspaceId,
    userId,
    amountMilli: chargedMilli,
    reason: (input.reason ?? "").slice(0, 200) || action,
    metadata: { action, quantity, cost_milli: cost.costMilli, cost_source: cost.source },
    idempotencyKey,
    match: { op: "action", action, quantity },
  });
  if (result.ok) {
    if (result.duplicate) return (await earlier()) ?? { ok: false, code: "IDEMPOTENCY_KEY_REUSED" };
    return { ok: true, action, quantity, costMilli: cost.costMilli, chargedMilli, balanceAfterMilli: result.balanceAfterMilli, duplicate: false };
  }
  // The balance is checked before the key: a concurrent attempt with this key may have committed.
  const settled = await earlier();
  if (settled) return settled;
  if (result.reason === "idempotency_key_reused") return { ok: false, code: "IDEMPOTENCY_KEY_REUSED" };
  if (result.reason === "insufficient_balance") return { ok: false, code: "INSUFFICIENT_CREDITS", balanceMilli: result.balanceMilli ?? 0 };
  return { ok: false, code: "WALLET_NOT_FOUND" };
}
