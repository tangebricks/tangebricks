import { z } from "zod";
import { MILLI_PER_CREDIT, fromMilli } from "@poc/sdk";
import type { BrickManifest, Executor } from "@poc/sdk";
import type { D1Like } from "./d1.ts";
import { createWallet } from "./wallet.ts";

/** The name the host gives the D1 database. The brick declares it in its manifest and receives it through `ctx.binding`. */
export const WALLET_DB_BINDING = "DB";

export const DEDUCT_CREDITS = "credit-wallet.deduct";

/**
 * What the step is configured with in the graph: how much it costs and why. The amount is whole credits (the catalog
 * declares it an integer); the step converts it to thousandths for the wallet (story 2.5). Fractional prices belong to
 * per-action costs (`POST /wallet/charge`), not to a graph literal.
 */
const ConfigSchema = z.object({
  amount: z.number().int().positive().max(1_000_000_000),
  reason: z.string().min(1).max(200).default("usage"),
});

/**
 * What the step is fed on its input port. The workspace is NOT taken from here: it is the run's verified workspace
 * (`ctx.workspaceId`, AD-S19). An input that still names a workspace must name that same one, or the step fails with
 * WORKSPACE_MISMATCH and nothing is debited, so neither a payload nor a graph author can point a deduction at another tenant.
 */
const InputSchema = z.object({
  workspaceId: z.string().min(1).max(200).optional(),
  userId: z.string().min(1).max(200),
  /** Supplied by a host that may retry the step: the same key charges only once. */
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const deductCreditsManifest: BrickManifest = {
  type: DEDUCT_CREDITS,
  category: "action",
  inputs: [{ id: "in", dataType: "json" }],
  outputs: [{ id: "out", dataType: "json" }],
  configSchema: ConfigSchema,
  secrets: [],
  // The only way this brick can get at the database. Nothing else is reachable from the executor's context.
  bindings: [WALLET_DB_BINDING],
};

/**
 * Takes `amount` credits from the caller's wallet in one D1 batch. If the wallet cannot cover it the step throws, so
 * the runtime marks it failed and skips everything downstream: a graph does not carry on to the paid work after a
 * refused payment. The balance and the ledger are untouched in that case.
 */
/** Parses with a schema and, on failure, throws one readable line naming each bad field instead of a raw Zod dump. */
function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown, label: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`invalid ${label}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(value)"}: ${i.message}`).join("; ")}`);
}

/** Thrown when the step's input names a workspace other than the run's own. Nothing is debited. */
export class WorkspaceMismatchError extends Error {
  readonly code = "WORKSPACE_MISMATCH" as const;
  readonly retryable = false;
  constructor(message: string) {
    super(`WORKSPACE_MISMATCH: ${message}`);
    this.name = "WorkspaceMismatchError";
  }
}

export const deductCreditsExecutor: Executor = async (ctx) => {
  const workspaceId = ctx.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error("NO_WORKSPACE: the run has no verified workspace, so nothing was debited");
  }
  const config = parseOrThrow(ConfigSchema, ctx.data, "config");
  const input = parseOrThrow(InputSchema, ctx.inputs.in, "input");
  if (input.workspaceId !== undefined && input.workspaceId !== workspaceId) {
    throw new WorkspaceMismatchError("the step's input names a different workspace than the run's; nothing was debited");
  }
  const amountMilli = config.amount * MILLI_PER_CREDIT;
  const wallet = createWallet(ctx.binding<D1Like>(WALLET_DB_BINDING), undefined);
  const result = await wallet.deduct({
    workspaceId,
    userId: input.userId,
    amountMilli,
    reason: config.reason,
    metadata: { node_id: ctx.nodeId },
    idempotencyKey: input.idempotencyKey,
    // A retry is the same node; another node using the same key is refused, not answered with this one's debit.
    match: { op: "node", node_id: ctx.nodeId },
  });
  if (!result.ok) {
    const errMsg =
      result.reason === "insufficient_balance"
        ? `insufficient balance: need ${config.amount}, have ${fromMilli(result.balanceMilli ?? 0)}`
        : result.reason === "idempotency_key_reused"
          ? "IDEMPOTENCY_KEY_REUSED: the idempotency key was already used for a different operation; nothing was debited"
          : `no wallet for workspace ${workspaceId}`;
    await ctx.log?.error(errMsg, {
      brickId: "credit-wallet",
      workspaceId,
      userId: input.userId,
      amountMilli,
      reason: config.reason,
      balanceMilli: result.balanceMilli ?? 0,
    });
    throw new Error(errMsg);
  }
  await ctx.log?.info("Deducted workspace credits", {
    brickId: "credit-wallet",
    workspaceId,
    userId: input.userId,
    chargedMilli: amountMilli,
    balanceAfterMilli: result.balanceAfterMilli,
  });
  return {
    out: {
      charged: config.amount,
      chargedMilli: amountMilli,
      balanceAfter: fromMilli(result.balanceAfterMilli),
      balanceAfterMilli: result.balanceAfterMilli,
      duplicate: result.duplicate,
    },
  };
};

/** The bricks this package contributes to a registry, and the code behind them. */
export const creditWalletBricks: BrickManifest[] = [deductCreditsManifest];
export const creditWalletExecutors: ReadonlyMap<string, Executor> = new Map([[DEDUCT_CREDITS, deductCreditsExecutor]]);
