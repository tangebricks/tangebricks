import { Hono } from "hono";
import { z } from "zod";
import { MarketplaceSplitsService, type PayoutMethod } from "./splits.ts";
import { splitsMiddleware, type SplitsEnv } from "./middleware.ts";

const SetContractSchema = z.object({
  vendorId: z.string().min(1).max(128),
  platformFeePercent: z.number().min(0).max(100).optional(),
  escrowDays: z.number().int().min(0).max(365).optional(),
  payoutMethod: z.enum(["stripe_connect", "wise", "manual"]).optional(),
  payoutDestination: z.string().max(255).optional(),
});

const ProcessSplitSchema = z.object({
  vendorId: z.string().min(1).max(128),
  orderId: z.string().min(1).max(128),
  grossAmountCents: z.number().int().min(0),
  currency: z.string().length(3).optional(),
});

const RequestPayoutSchema = z.object({
  vendorId: z.string().min(1).max(128),
  amountCents: z.number().int().min(1),
  currency: z.string().length(3).optional(),
});

export function createMarketplaceSplitsRoutes(): Hono<SplitsEnv> {
  const app = new Hono<SplitsEnv>();

  app.use("*", splitsMiddleware);

  // POST /marketplace/contracts
  app.post("/marketplace/contracts", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = SetContractSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("splitsService") || new MarketplaceSplitsService(c.env.DB);
    const contract = await service.setVendorContract({
      workspaceId,
      vendorId: parsed.data.vendorId,
      platformFeePercent: parsed.data.platformFeePercent,
      escrowDays: parsed.data.escrowDays,
      payoutMethod: parsed.data.payoutMethod as PayoutMethod | undefined,
      payoutDestination: parsed.data.payoutDestination,
    });

    return c.json({ contract }, 201);
  });

  // GET /marketplace/contracts/:vendorId
  app.get("/marketplace/contracts/:vendorId", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const vendorId = c.req.param("vendorId");

    const service = c.get("splitsService") || new MarketplaceSplitsService(c.env.DB);
    const contract = await service.getVendorContract(workspaceId, vendorId);

    return c.json({ contract }, 200);
  });

  // POST /marketplace/splits
  app.post("/marketplace/splits", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ProcessSplitSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("splitsService") || new MarketplaceSplitsService(c.env.DB);
    const tx = await service.processSplit(
      workspaceId,
      parsed.data.vendorId,
      parsed.data.orderId,
      parsed.data.grossAmountCents,
      parsed.data.currency
    );

    return c.json({ transaction: tx }, 201);
  });

  // GET /marketplace/balances/:vendorId
  app.get("/marketplace/balances/:vendorId", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const vendorId = c.req.param("vendorId");
    const currency = c.req.query("currency") || "usd";

    const service = c.get("splitsService") || new MarketplaceSplitsService(c.env.DB);
    const balance = await service.getVendorBalance(workspaceId, vendorId, currency);

    return c.json({ balance }, 200);
  });

  // POST /marketplace/payouts
  app.post("/marketplace/payouts", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = RequestPayoutSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("splitsService") || new MarketplaceSplitsService(c.env.DB);
    const result = await service.requestPayout(
      workspaceId,
      parsed.data.vendorId,
      parsed.data.amountCents,
      parsed.data.currency
    );

    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({ payout: result.payout }, 201);
  });

  // GET /marketplace/payouts
  app.get("/marketplace/payouts", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const vendorId = c.req.query("vendorId");

    const service = c.get("splitsService") || new MarketplaceSplitsService(c.env.DB);
    const payouts = await service.listPayouts(workspaceId, vendorId || undefined);

    return c.json({ payouts }, 200);
  });

  return app;
}
