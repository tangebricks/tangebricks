import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { D1Like, RequestContext, StructuredLogger } from "@poc/sdk";
import {
  NotConfiguredError,
  WORKSPACE_ADMIN_ROLES,
  fromMilli,
  isPaymentCurrency,
  parseMilli,
  readBoundedText,
  refuseApiKeyCaller,
  scoped,
  toMilli,
  workspaceRoleRefusal,
} from "@poc/sdk";
import type { WebhookVerification } from "@poc/sdk";
import {
  MAX_ACTION_COST_MILLI,
  MAX_CHARGE_QUANTITY,
  chargeAction,
  deleteActionCost,
  isActionName,
  listActionCosts,
  parseDefaultActionCosts,
  setActionCost,
} from "./costs.ts";
import type { PaymentGateway } from "./gateway.ts";
import { createWallet } from "./wallet.ts";
import type { ConfirmResult } from "./wallet.ts";

/**
 * The Hono environment the wallet routes expect. It matches the one the multi-workspace brick sets up, but is written
 * out here so the two bricks do not depend on each other: the host mounts a workspace middleware in front of
 * `/wallet` and `/payments/create-order`, and an identity middleware in front of everything. `/payments/webhook` is
 * called by the payment provider, so it has no user and no workspace: its signature is its authentication.
 */
export interface WalletEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string };
    workspace?: { id: string; role: string; suspended: boolean };
    /** The verified request context the multi-workspace middleware sets alongside `workspace`. */
    ctx?: RequestContext;
    log?: StructuredLogger;
  };
}

export interface WalletRoutesOptions {
  /**
   * The payment provider. There is no default (story 0.9): without one the payment routes answer 503
   * NOT_CONFIGURED. `createFakeGateway()` is for tests that inject it explicitly.
   */
  gateway?: PaymentGateway;
  /**
   * Credits added per unit of money paid (cephlow's CREDITS_PER_RUPEE). Default 1. Story 2.5: a decimal with up to
   * three places is accepted (a number or decimal text) and held as thousandths.
   */
  creditsPerUnit?: number | string;
  /**
   * Story 2.5: action costs that apply when a workspace has set none of its own, as comma-separated `action:cost`
   * entries with the cost in credits (`email.send:0.2,message.send:0.5`). Empty by default: no action has a price
   * until a workspace or this setting gives it one.
   */
  defaultActionCosts?: string;
  /** Smallest order accepted (cephlow's MIN_RECHARGE_AMOUNT). Default 1. */
  minOrderAmount?: number;
  /**
   * Story 2.3: the currency orders are created and verified in (ISO 4217, three uppercase letters, e.g. "INR"). There
   * is no default: with a gateway and no currency (the `paymentCurrency` setting left empty) the payment routes answer
   * 503 NOT_CONFIGURED.
   */
  currency?: string;
}

const CreateOrderSchema = z.object({ amount: z.number().int().positive().max(1_000_000_000) });
const VerifySchema = z.object({ order_id: z.string().min(1).max(200) });
/** The most credits one deduction or transfer may move. */
const MAX_CREDITS = 1_000_000_000;

/**
 * Story 2.5: a credit amount in a request body, a number or decimal text with up to three decimals, as thousandths.
 * Converted exactly (`toMilli`): 0.2 is 200, "12.345" is 12345, and 0.0001 or "1e-3" is refused.
 */
const creditAmount = (min: number, max: number) =>
  z.union([z.number(), z.string().max(40)]).transform((value, ctx) => {
    const parsed = parseMilli(value);
    if (!parsed.ok || parsed.milli < min || parsed.milli > max) {
      ctx.addIssue({ code: "custom", message: "invalid credit amount" });
      return z.NEVER;
    }
    return parsed.milli;
  });

// The body names an amount and a reason, never a workspace or a user: those come from the guard and the identity.
const DeductSchema = z.object({
  amount: creditAmount(1, MAX_CREDITS * 1000),
  reason: z.string().min(1).max(200).default("usage"),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
const CostSchema = z.object({ cost: creditAmount(0, MAX_ACTION_COST_MILLI) });
const ChargeSchema = z.object({
  action: z.string().refine(isActionName),
  quantity: z.number().int().min(1).max(MAX_CHARGE_QUANTITY).default(1),
  idempotencyKey: z.string().min(1).max(200),
  reason: z.string().min(1).max(200).optional(),
});
const TransferSchema = z.object({
  toWorkspaceId: z.string().min(1).max(200),
  amount: creditAmount(1, MAX_CREDITS * 1000),
  idempotencyKey: z.string().min(1).max(200),
  note: z.string().min(1).max(200).optional(),
});

type Ctx = Context<WalletEnv>;

/** The order ids `createOrder` generates; a provider event naming anything else is another brick's. */
const WALLET_ORDER_ID = /^order_[0-9a-f]{16}$/;

export function createWalletRoutes(options: WalletRoutesOptions): Hono<WalletEnv> {
  const minOrderAmount = options.minOrderAmount ?? 1;
  // Both are checked here, once: a malformed multiplier or default-cost list fails when the routes are built.
  const creditsPerUnitMilli = toMilli(options.creditsPerUnit ?? 1);
  if (creditsPerUnitMilli <= 0) throw new RangeError("creditsPerUnit must be above zero");
  const defaultCosts = parseDefaultActionCosts(options.defaultActionCosts);
  const router = new Hono<WalletEnv>();
  // Payments need both a provider and a currency; either one missing is NOT_CONFIGURED, never a guessed default.
  const paymentsConfigured = Boolean(options.gateway) && isPaymentCurrency(options.currency);
  const walletFor = (c: Ctx) =>
    createWallet(c.env.DB, options.gateway, {
      creditsPerUnit: options.creditsPerUnit ?? 1,
      minOrderAmount,
      ...(options.currency !== undefined ? { currency: options.currency } : {}),
    });
  const loggerFor = (c: Ctx, workspaceId?: string): StructuredLogger | undefined => {
    const base = c.get("log");
    if (!base) return undefined;
    if (typeof base.withContext === "function") {
      return base.withContext({
        brickId: "credit-wallet",
        ...(workspaceId ? { workspaceId } : {}),
      });
    }
    return base;
  };

  // Fails closed: if the host did not mount the workspace middleware, nothing below runs against a guessed workspace.
  // The workspace is only ever the one the middleware resolved from the verified header; a `workspaceId` in the query
  // string or body is never read, so it cannot point a request at another workspace.
  const needWorkspace = (c: Ctx) => {
    const user = c.get("user");
    const workspace = c.get("workspace");
    if (!user) return { failure: c.json({ error: "Unauthorized" }, 401) } as const;
    if (!workspace) return { failure: c.json({ error: "Missing workspace context" }, 400) } as const;
    return { user, workspace } as const;
  };

  // The caller's balance. The wallet row is created on first use, for a workspace the caller was already resolved into.
  router.get("/wallet", async (c) => {
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    try {
      const wallet = walletFor(c);
      await wallet.openWallet(ctx.workspace.id);
      const balanceMilli = (await wallet.getBalanceMilli(ctx.workspace.id)) ?? 0;
      return c.json({
        currentBalance: fromMilli(balanceMilli),
        currentBalanceMilli: balanceMilli,
        creditsPerUnit: fromMilli(creditsPerUnitMilli),
        minOrderAmount,
      });
    } catch (error) {
      console.error("GET /wallet:", error);
      return c.json({ error: "Failed to fetch wallet balance" }, 500);
    }
  });

  // The caller's workspace ledger, newest first. Filters by the resolved workspace only. A transfer's row carries its
  // transfer code; the destination's row says nothing else about the source.
  router.get("/wallet/history", async (c) => {
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    try {
      const results = await scoped(c.env.DB, ctx.workspace.id).select<{
        id: string;
        type: string;
        amount_milli: number;
        balance_after_milli: number;
        reason: string;
        metadata: string | null;
        user_id: string;
        transfer_code: string | null;
        created_at: string;
      }>("credit_ledger", undefined, [], { orderBy: "rowid DESC", limit: 50 });
      return c.json({
        ledgers: results.map((row) => ({
          id: row.id,
          type: row.type,
          amount: fromMilli(row.amount_milli),
          amountMilli: row.amount_milli,
          balanceAfter: fromMilli(row.balance_after_milli),
          balanceAfterMilli: row.balance_after_milli,
          description: row.reason,
          metadata: safeJson(row.metadata),
          userId: row.user_id,
          ...(row.transfer_code ? { transferCode: row.transfer_code } : {}),
          createdAt: row.created_at,
        })),
      });
    } catch (error) {
      console.error("GET /wallet/history:", error);
      return c.json({ error: "Failed to fetch ledger history" }, 500);
    }
  });

  // Spend credits from the caller's workspace. The amount is taken in one atomic batch; an amount the wallet cannot
  // cover is refused with nothing changed. The workspace is the one the guard resolved and nothing in the body can
  // change that: any workspaceId or user in the body is ignored. Any member of the workspace may spend; restricting
  // that to some roles is the host's decision. Story 2.5: the amount may have up to three decimals.
  router.post("/wallet/deduct", async (c) => {
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    const rawJson = await c.req.json().catch(() => ({}));
    const body = DeductSchema.safeParse(rawJson);
    if (!body.success) return c.json({ error: "Invalid amount (above zero, at most three decimals)" }, 400);
    const amountMilli = body.data.amount;
    const idempotencyKey = c.req.header("Idempotency-Key") || c.req.header("idempotency-key") || body.data.idempotencyKey;
    try {
      const result = await walletFor(c).deduct({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.uid,
        amountMilli,
        reason: body.data.reason,
        idempotencyKey,
        match: { op: "deduct" },
      });
      if (result.ok) {
        await loggerFor(c, ctx.workspace.id)?.info("Credits deducted from wallet", {
          brickId: "credit-wallet",
          workspaceId: ctx.workspace.id,
          userId: ctx.user.uid,
          chargedMilli: amountMilli,
          balanceAfterMilli: result.balanceAfterMilli,
        });
        return c.json({
          charged: fromMilli(amountMilli),
          chargedMilli: amountMilli,
          balanceAfter: fromMilli(result.balanceAfterMilli),
          balanceAfterMilli: result.balanceAfterMilli,
          duplicate: result.duplicate,
        });
      }
      if (result.reason === "insufficient_balance") {
        await loggerFor(c, ctx.workspace.id)?.warn("Insufficient balance for wallet deduction", {
          brickId: "credit-wallet",
          workspaceId: ctx.workspace.id,
          userId: ctx.user.uid,
          requestedMilli: amountMilli,
          balanceMilli: result.balanceMilli,
        });
        return c.json({ error: "Insufficient balance", ...balancePair(result.balanceMilli) }, 402);
      }
      if (result.reason === "idempotency_key_reused") return keyReused(c);
      return c.json({ error: "Wallet not found" }, 404);
    } catch (error) {
      console.error("POST /wallet/deduct:", error);
      await loggerFor(c, ctx.workspace.id)?.error("Failed to deduct credits", {
        brickId: "credit-wallet",
        workspaceId: ctx.workspace.id,
        error,
      });
      return c.json({ error: "Failed to deduct credits" }, 500);
    }
  });

  // Story 2.5: the workspace's action costs (any member may read them), and the defaults that apply to actions the
  // workspace has not priced itself.
  router.get("/wallet/costs", async (c) => {
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    try {
      const own = await listActionCosts(c.env.DB, ctx.workspace.id);
      const priced = new Set(own.map((row) => row.action));
      return c.json({
        costs: own.map((row) => ({
          action: row.action,
          cost: fromMilli(row.costMilli),
          costMilli: row.costMilli,
          source: "workspace",
          updatedAt: row.updatedAt,
        })),
        defaults: [...defaultCosts]
          .filter(([action]) => !priced.has(action))
          .map(([action, costMilli]) => ({ action, cost: fromMilli(costMilli), costMilli, source: "default" })),
      });
    } catch (error) {
      console.error("GET /wallet/costs:", error);
      return c.json({ error: "Failed to fetch action costs" }, 500);
    }
  });

  // Owner/admin only: set the workspace's cost for one action, in credits with up to three decimals (0 is free).
  router.put("/wallet/costs/:action", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    const action = c.req.param("action");
    if (!isActionName(action)) return c.json({ error: "Invalid action name", code: "INVALID_ACTION" }, 400);
    const body = CostSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: `Invalid cost (0 to 999999.999 credits, at most three decimals)` }, 400);
    try {
      await setActionCost(c.env.DB, ctx.workspace.id, action, body.data.cost);
      return c.json({ action, cost: fromMilli(body.data.cost), costMilli: body.data.cost, source: "workspace" });
    } catch (error) {
      console.error("PUT /wallet/costs/:action:", error);
      return c.json({ error: "Failed to set the action cost" }, 500);
    }
  });

  // Owner/admin only: remove the workspace's own cost for an action (a default for it, if any, applies again).
  router.delete("/wallet/costs/:action", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    const action = c.req.param("action");
    if (!isActionName(action)) return c.json({ error: "Invalid action name", code: "INVALID_ACTION" }, 400);
    try {
      const removed = await deleteActionCost(c.env.DB, ctx.workspace.id, action);
      if (!removed) return c.json({ error: "No cost is set for this action", code: "UNKNOWN_ACTION" }, 404);
      return c.json({ action, removed: true });
    } catch (error) {
      console.error("DELETE /wallet/costs/:action:", error);
      return c.json({ error: "Failed to remove the action cost" }, 500);
    }
  });

  // Story 2.5: charge the caller's workspace for `quantity` of an action at its cost, once per idempotency key. Any
  // member may charge, as with /wallet/deduct; the price is the workspace's (or the default), never the caller's.
  router.post("/wallet/charge", async (c) => {
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    const body = ChargeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: `Invalid charge: an action name, a quantity from 1 to ${MAX_CHARGE_QUANTITY}, and an idempotencyKey` }, 400);
    }
    try {
      const result = await chargeAction(c.env.DB, ctx.workspace.id, {
        userId: ctx.user.uid,
        action: body.data.action,
        quantity: body.data.quantity,
        idempotencyKey: body.data.idempotencyKey,
        ...(body.data.reason ? { reason: body.data.reason } : {}),
        defaults: defaultCosts,
      });
      if (result.ok) {
        await loggerFor(c, ctx.workspace.id)?.info("Action charged to wallet", {
          brickId: "credit-wallet",
          workspaceId: ctx.workspace.id,
          userId: ctx.user.uid,
          action: result.action,
          quantity: result.quantity,
          chargedMilli: result.chargedMilli,
          balanceAfterMilli: result.balanceAfterMilli,
        });
        return c.json({
          action: result.action,
          quantity: result.quantity,
          cost: fromMilli(result.costMilli),
          costMilli: result.costMilli,
          charged: fromMilli(result.chargedMilli),
          chargedMilli: result.chargedMilli,
          balanceAfter: fromMilli(result.balanceAfterMilli),
          balanceAfterMilli: result.balanceAfterMilli,
          duplicate: result.duplicate,
        });
      }
      if (result.code === "UNKNOWN_ACTION") return c.json({ error: "No cost is set for this action", code: "UNKNOWN_ACTION" }, 404);
      if (result.code === "IDEMPOTENCY_KEY_REUSED") return keyReused(c);
      if (result.code === "INSUFFICIENT_CREDITS") {
        return c.json({ error: "Insufficient balance", code: "INSUFFICIENT_CREDITS", ...balancePair(result.balanceMilli) }, 402);
      }
      return c.json({ error: "Wallet not found", code: "WALLET_NOT_FOUND" }, 404);
    } catch (error) {
      console.error("POST /wallet/charge:", error);
      return c.json({ error: "Failed to charge the action" }, 500);
    }
  });

  // Story 2.5: move credits from the caller's workspace to another workspace's existing wallet. Owner/admin of the
  // source only, and never an API key. One D1 batch moves the credits and writes both ledger rows (sharing a transfer
  // code), or nothing at all. The destination is named in the body, but only its wallet's existence is checked and
  // nothing of it is returned: a workspace that does not exist and one without a wallet get the same 404.
  router.post("/wallet/transfer", async (c) => {
    const keyRefused = refuseApiKeyCaller(c);
    if (keyRefused) return keyRefused;
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    const body = TransferSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: "Invalid transfer: a toWorkspaceId, an amount above zero with at most three decimals, and an idempotencyKey" }, 400);
    }
    if (body.data.toWorkspaceId === ctx.workspace.id) return c.json({ error: "A workspace cannot transfer to itself", code: "SAME_WORKSPACE" }, 400);
    try {
      const wallet = walletFor(c);
      await wallet.openWallet(ctx.workspace.id);
      const result = await wallet.transfer({
        fromWorkspaceId: ctx.workspace.id,
        toWorkspaceId: body.data.toWorkspaceId,
        userId: ctx.user.uid,
        amountMilli: body.data.amount,
        idempotencyKey: body.data.idempotencyKey,
        ...(body.data.note ? { note: body.data.note } : {}),
      });
      if (result.ok) {
        await loggerFor(c, ctx.workspace.id)?.info("Credits transferred", {
          brickId: "credit-wallet",
          workspaceId: ctx.workspace.id,
          userId: ctx.user.uid,
          transferCode: result.transferCode,
          amountMilli: result.amountMilli,
          duplicate: result.duplicate,
        });
        return c.json({
          transferCode: result.transferCode,
          amount: fromMilli(result.amountMilli),
          amountMilli: result.amountMilli,
          balanceAfter: fromMilli(result.balanceAfterMilli),
          balanceAfterMilli: result.balanceAfterMilli,
          duplicate: result.duplicate,
        });
      }
      switch (result.reason) {
        case "insufficient_balance":
          return c.json({ error: "Insufficient balance", code: "INSUFFICIENT_CREDITS", ...balancePair(result.balanceMilli) }, 402);
        case "same_workspace":
          return c.json({ error: "A workspace cannot transfer to itself", code: "SAME_WORKSPACE" }, 400);
        case "idempotency_key_reused":
          return keyReused(c);
        default:
          return c.json({ error: "Destination not found", code: "DESTINATION_NOT_FOUND" }, 404);
      }
    } catch (error) {
      console.error("POST /wallet/transfer:", error);
      return c.json({ error: "Failed to transfer credits" }, 500);
    }
  });

  // Start a payment: ask the gateway for an order and remember which workspace and user it is for.
  router.post("/payments/create-order", async (c) => {
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    if (!paymentsConfigured) return gatewayNotConfigured(c);
    const rawJson = await c.req.json().catch(() => ({}));
    const body = CreateOrderSchema.safeParse(rawJson);
    if (!body.success) return c.json({ error: "Invalid amount" }, 400);
    if (body.data.amount < minOrderAmount) return c.json({ error: `Minimum recharge amount is Rs. ${minOrderAmount}` }, 400);
    try {
      const wallet = walletFor(c);
      await wallet.openWallet(ctx.workspace.id);
      const order = await wallet.createOrder({ workspaceId: ctx.workspace.id, userId: ctx.user.uid, amount: body.data.amount });
      await loggerFor(c, ctx.workspace.id)?.info("Payment order created", {
        brickId: "credit-wallet",
        workspaceId: ctx.workspace.id,
        orderId: order.orderId,
        amount: body.data.amount,
      });
      return c.json({ payment_session_id: order.paymentSessionId, order_id: order.orderId });
    } catch (error) {
      console.error("POST /payments/create-order:", error);
      await loggerFor(c, ctx.workspace.id)?.error("Payment gateway error", {
        brickId: "credit-wallet",
        workspaceId: ctx.workspace.id,
        error,
      });
      return c.json({ error: "Payment gateway error" }, 500);
    }
  });

  // Confirm a payment. Needs the caller's identity but not a workspace: the order says which workspace it belongs to,
  // and a suspended workspace must still be able to complete a payment that was already charged.
  router.post("/payments/verify", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (!paymentsConfigured) return gatewayNotConfigured(c);
    const body = VerifySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "order_id is required" }, 400);
    const orderId = body.data.order_id;
    try {
      const wallet = walletFor(c);
      const order = await wallet.getOrder(orderId);
      // Ownership is checked before the gateway is asked anything. Another user's order answers exactly like a missing
      // one (ID_READ_FOREIGN, story 0.7), so the reply never says whether an order id exists.
      if (!order || order.userId !== user.uid) return c.json({ error: "Order not found" }, 404);

      const result = await wallet.confirmOrder(orderId);
      switch (result.status) {
        case "PAID": {
          const paid = result as { amount: number; creditsMilli: number };
          return c.json({ status: "PAID", credited: true, amount: paid.amount, credits: fromMilli(paid.creditsMilli), creditsMilli: paid.creditsMilli });
        }
        case "already_processed":
          return c.json({ status: "already_processed", credited: false });
        case "order_not_found":
          return c.json({ error: "Order not found" }, 404);
        case "wallet_not_found":
          return c.json({ error: "Workspace not found" }, 404);
        case "gateway_error":
          return c.json({ error: "Could not verify with payment gateway" }, 502);
        case "invalid_amount":
          return c.json({ error: "Payment verification failed" }, 500);
        case "verification_mismatch":
          await logMismatch(c, orderId, result);
          return c.json({ error: "Payment verification failed", status: "verification_mismatch", credited: false }, 409);
        default:
          return c.json({ status: result.status, credited: false });
      }
    } catch (error) {
      console.error("POST /payments/verify:", error);
      return c.json({ error: "Payment verification failed" }, 500);
    }
  });

  // Story 2.3: the provider's payment notification. No user and no workspace (the provider calls it), so it is never
  // behind the workspace guard; the signature over the raw body is what authenticates it. A verified webhook only
  // names an order: the order is then re-fetched from the provider and checked against the stored one exactly as the
  // client verify path does, and the ledger key `order:<id>` keeps a repeated delivery to one credit.
  // Answers: 200 for credited, already processed, not paid yet, or an order this wallet does not know (so the
  // provider stops retrying); 401 for a bad or stale signature; 409 for a mismatch; 502 when the provider could not
  // be asked (the provider retries later).
  router.post("/payments/webhook", async (c) => {
    if (!paymentsConfigured || !options.gateway) return gatewayNotConfigured(c);
    // Bounded before any HMAC: a declared or actual body over 64 KiB is refused.
    const rawBody = await readBoundedText(c.req.raw);
    if (rawBody === null) return c.json({ error: "Webhook body too large" }, 413);
    let verified: WebhookVerification;
    try {
      verified = await options.gateway.verifyWebhook(rawBody, c.req.raw.headers);
    } catch (error) {
      if (error instanceof NotConfiguredError) return gatewayNotConfigured(c);
      console.error("POST /payments/webhook: signature check failed:", error instanceof Error ? error.name : "error");
      return c.json({ error: "Webhook verification failed" }, 500);
    }
    if (verified.kind === "invalid") return c.json({ error: "Invalid webhook signature" }, 401);
    // Correctly signed but not about an order: acknowledged, so the provider stops retrying.
    if (verified.kind === "ignored") return c.json({ received: true, status: "ignored", credited: false });
    const orderId = verified.orderId;
    // An id that is not a wallet order id is another brick's order on the same provider account (a checkout session,
    // say): not ours, so acknowledged quietly.
    if (!WALLET_ORDER_ID.test(orderId)) return c.json({ received: true, status: "ignored", credited: false });
    try {
      const result = await walletFor(c).confirmOrder(orderId);
      switch (result.status) {
        case "PAID":
          return c.json({ received: true, status: "PAID", credited: true });
        case "already_processed":
          return c.json({ received: true, status: "already_processed", credited: false });
        case "order_not_found":
          // A signed event for an order this wallet never recorded (an orphan provider order, or another brick's).
          // Acknowledged so the provider stops retrying, but loudly, so it can be reconciled.
          console.error(`credit-wallet: signed payment webhook for an unknown order (order ${orderId}, provider ref ${verified.providerRef ?? "none"})`);
          return c.json({ received: true, status: "ignored", credited: false });
        case "wallet_not_found":
          // A paid order whose credit cannot land: the provider will retry, but someone has to look.
          console.error(
            `credit-wallet: paid order cannot be credited, its workspace has no wallet (order ${orderId}, provider ref ${verified.providerRef ?? "none"})`,
          );
          return c.json({ error: "Workspace not found" }, 404);
        case "gateway_error":
          return c.json({ error: "Could not verify with payment gateway" }, 502);
        case "invalid_amount":
          return c.json({ error: "Payment verification failed" }, 500);
        case "verification_mismatch":
          await logMismatch(c, orderId, result);
          return c.json({ error: "Payment verification failed", status: "verification_mismatch", credited: false }, 409);
        default:
          return c.json({ received: true, status: result.status, credited: false });
      }
    } catch (error) {
      console.error("POST /payments/webhook:", error);
      return c.json({ error: "Payment verification failed" }, 500);
    }
  });

  // Names the field that did not match, never a value from the provider or a secret.
  async function logMismatch(c: Ctx, orderId: string, result: ConfirmResult) {
    const detail = result as { field?: string; workspaceId?: string };
    console.warn(`payment verification mismatch on ${detail.field ?? "unknown"} for order ${orderId}`);
    await loggerFor(c, detail.workspaceId)?.warn("Payment verification mismatch", {
      brickId: "credit-wallet",
      ...(detail.workspaceId ? { workspaceId: detail.workspaceId } : {}),
      orderId,
      field: detail.field ?? "unknown",
    });
  }

  return router;
}

function gatewayNotConfigured(c: Ctx) {
  return c.json(
    {
      error: "NOT_CONFIGURED: no payment gateway or payment currency is configured; no order was created or verified.",
      code: "NOT_CONFIGURED",
    },
    503,
  );
}

function safeJson(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "{}");
  } catch {
    return {};
  }
}

/** A balance in a refusal: credits and thousandths, or null for both when the wallet is missing. */
function balancePair(balanceMilli: number | null): { balance: number | null; balanceMilli: number | null } {
  return balanceMilli === null ? { balance: null, balanceMilli: null } : { balance: fromMilli(balanceMilli), balanceMilli };
}

/** Story 2.5: a key already on this workspace's ledger for another operation. Nothing was taken or moved. */
function keyReused(c: Ctx) {
  return c.json({ error: "This idempotency key was already used for a different operation", code: "IDEMPOTENCY_KEY_REUSED" }, 409);
}
