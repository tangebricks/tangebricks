export type { D1Like, D1Result, D1Statement } from "./d1.ts";
export { applyMigration, splitStatements } from "./migrate.ts";
export { FAKE_WEBHOOK_SIGNATURE_HEADER, createFakeGateway } from "./gateway.ts";
export type { FakeGateway, GatewayOrder, PaymentGateway, WebhookVerification } from "./gateway.ts";
export { createWalletRoutes } from "./routes.ts";
export type { WalletEnv, WalletRoutesOptions } from "./routes.ts";
export { createWallet } from "./wallet.ts";
export { walletCharger } from "./charger.ts";
export type { ChargeActionOptions, ChargeResult, GrantResult, RefundResult, WalletCharger } from "./charger.ts";
export {
  ACTION_NAME,
  MAX_ACTION_COST_MILLI,
  MAX_CHARGE_QUANTITY,
  chargeAction,
  deleteActionCost,
  isActionName,
  listActionCosts,
  parseDefaultActionCosts,
  resolveActionCost,
  setActionCost,
} from "./costs.ts";
export type { ActionCost, ChargeActionInput, ChargeActionResult } from "./costs.ts";
export { importWalletBalances, parseBalanceFile, reconcileWallets, walletShadowReport } from "./import-balances.ts";
export type { BalanceImportReport, BalanceImportRow, ImportBalancesOptions, ReconcileReport, ReconcileRow, ReconcileRowReport } from "./import-balances.ts";
export type { ConfirmResult, DeductResult, IdempotencyMatch, OrderRow, TransferResult, Wallet, WalletOptions } from "./wallet.ts";
import { NotConfiguredError, type Executor } from "@poc/sdk";
import { deductCreditsExecutor } from "./brick.ts";
export {
  DEDUCT_CREDITS,
  WALLET_DB_BINDING,
  WorkspaceMismatchError,
  creditWalletBricks,
  creditWalletExecutors,
  deductCreditsExecutor,
  deductCreditsManifest,
} from "./brick.ts";

/**
 * The `credit-wallet.debit` workflow node. Story 0.9: it is the D1-backed deduction (`deductCreditsExecutor`),
 * not arithmetic on its input. It needs the `DB` binding and `{ userId }` on its input; the workspace is the run's own (`ctx.workspaceId`).
 */
export async function executeWalletDebit(ctx: Parameters<Executor>[0]): Promise<Record<string, unknown>> {
  return deductCreditsExecutor(ctx);
}

/**
 * The `credit-wallet.credit` workflow node. Story 0.9: there is no D1-backed credit executor, so the node fails
 * NOT_CONFIGURED instead of returning a made-up balance.
 */
export async function executeWalletCredit(ctx: Parameters<Executor>[0]): Promise<Record<string, unknown>> {
  throw new NotConfiguredError(`credit-wallet.credit (${ctx.nodeId}): no credit executor is configured; no credits were added.`);
}
