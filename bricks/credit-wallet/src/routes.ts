import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { D1Like, RequestContext, StructuredLogger } from "@poc/sdk";
import { scoped } from "@poc/sdk";
import type { PaymentGateway } from "./gateway.ts";
import { createWallet } from "./wallet.ts";

/**
 * The Hono environment the wallet routes expect. It matches the one the multi-workspace brick sets up, but is written
 * out here so the two bricks do not depend on each other: the host mounts a workspace middleware in front of
 * `/wallet` and `/payments/create-order`, and an identity middleware in front of everything.
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
  /** Credits added per unit of money paid (cephlow's CREDITS_PER_RUPEE). Default 1. */
  creditsPerUnit?: number;
  /** Smallest order accepted (cephlow's MIN_RECHARGE_AMOUNT). Default 1. */
  minOrderAmount?: number;
}

const CreateOrderSchema = z.object({ amount: z.number().int().positive().max(1_000_000_000) });
const VerifySchema = z.object({ order_id: z.string().min(1).max(200) });
// The body names an amount and a reason, never a workspace or a user: those come from the guard and the identity.
const DeductSchema = z.object({
  amount: z.number().int().positive().max(1_000_000_000),
  reason: z.string().min(1).max(200).default("usage"),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

type Ctx = Context<WalletEnv>;

export function createWalletRoutes(options: WalletRoutesOptions): Hono<WalletEnv> {
  const minOrderAmount = options.minOrderAmount ?? 1;
  const router = new Hono<WalletEnv>();
  const walletFor = (c: Ctx) =>
    createWallet(c.env.DB, options.gateway, { creditsPerUnit: options.creditsPerUnit ?? 1, minOrderAmount });
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
      return c.json({
        currentBalance: (await wallet.getBalance(ctx.workspace.id)) ?? 0,
        creditsPerUnit: options.creditsPerUnit ?? 1,
        minOrderAmount,
      });
    } catch (error) {
      console.error("GET /wallet:", error);
      return c.json({ error: "Failed to fetch wallet balance" }, 500);
    }
  });

  // The caller's workspace ledger, newest first. Filters by the resolved workspace only.
  router.get("/wallet/history", async (c) => {
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    try {
      const results = await scoped(c.env.DB, ctx.workspace.id).select<{
        id: string;
        type: string;
        amount: number;
        balance_after: number;
        reason: string;
        metadata: string | null;
        user_id: string;
        created_at: string;
      }>("credit_ledger", undefined, [], { orderBy: "rowid DESC", limit: 50 });
      return c.json({
        ledgers: results.map((row) => ({
          id: row.id,
          type: row.type,
          amount: row.amount,
          balanceAfter: row.balance_after,
          description: row.reason,
          metadata: safeJson(row.metadata),
          userId: row.user_id,
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
  // that to some roles is the host's decision.
  router.post("/wallet/deduct", async (c) => {
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    const rawJson = await c.req.json().catch(() => ({}));
    const body = DeductSchema.safeParse(rawJson);
    if (!body.success) return c.json({ error: "Invalid amount (a whole number above zero)" }, 400);
    const idempotencyKey = c.req.header("Idempotency-Key") || c.req.header("idempotency-key") || body.data.idempotencyKey;
    try {
      const result = await walletFor(c).deduct({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.uid,
        amount: body.data.amount,
        reason: body.data.reason,
        idempotencyKey,
      });
      if (result.ok) {
        await loggerFor(c, ctx.workspace.id)?.info("Credits deducted from wallet", {
          brickId: "credit-wallet",
          workspaceId: ctx.workspace.id,
          userId: ctx.user.uid,
          charged: body.data.amount,
          balanceAfter: result.balanceAfter,
        });
        return c.json({ charged: body.data.amount, balanceAfter: result.balanceAfter, duplicate: result.duplicate });
      }
      if (result.reason === "insufficient_balance") {
        await loggerFor(c, ctx.workspace.id)?.warn("Insufficient balance for wallet deduction", {
          brickId: "credit-wallet",
          workspaceId: ctx.workspace.id,
          userId: ctx.user.uid,
          requestedAmount: body.data.amount,
          balance: result.balance,
        });
        return c.json({ error: "Insufficient balance", balance: result.balance }, 402);
      }
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

  // Start a payment: ask the gateway for an order and remember which workspace and user it is for.
  router.post("/payments/create-order", async (c) => {
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;
    if (!options.gateway) return gatewayNotConfigured(c);
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
    if (!options.gateway) return gatewayNotConfigured(c);
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
        case "PAID":
          return c.json({ status: "PAID", credited: true, amount: (result as { amount: number }).amount, credits: (result as { credits: number }).credits });
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
        default:
          return c.json({ status: result.status, credited: false });
      }
    } catch (error) {
      console.error("POST /payments/verify:", error);
      return c.json({ error: "Payment verification failed" }, 500);
    }
  });

  return router;
}

function gatewayNotConfigured(c: Ctx) {
  return c.json(
    {
      error: "NOT_CONFIGURED: no payment gateway is configured; no order was created or verified.",
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
