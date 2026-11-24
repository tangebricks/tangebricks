import { Hono } from "hono";
import { z } from "zod";
import { CheckoutService, type GatewayType } from "./checkout.ts";
import { checkoutMiddleware, type CheckoutEnv } from "./middleware.ts";

const LineItemSchema = z.object({
  description: z.string().min(1).max(255),
  quantity: z.number().int().min(1),
  unitAmountCents: z.number().int().min(0),
});

const CreateSessionSchema = z.object({
  amountCents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  gateway: z.enum(["stripe", "lemonsqueezy", "cashfree", "paddle", "custom"]).optional(),
  customerEmail: z.string().email().optional(),
  countryCode: z.string().length(2).optional(),
  lineItems: z.array(LineItemSchema).min(1),
  metadata: z.record(z.unknown()).optional(),
});

export function createCheckoutRoutes(): Hono<CheckoutEnv> {
  const app = new Hono<CheckoutEnv>();

  app.use("*", checkoutMiddleware);

  // POST /checkout/sessions
  app.post("/checkout/sessions", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("checkoutService") || new CheckoutService(c.env.DB);
    const session = await service.createSession({
      workspaceId,
      amountCents: parsed.data.amountCents,
      currency: parsed.data.currency,
      gateway: parsed.data.gateway as GatewayType | undefined,
      customerEmail: parsed.data.customerEmail,
      countryCode: parsed.data.countryCode,
      lineItems: parsed.data.lineItems,
      metadata: parsed.data.metadata,
    });

    return c.json({ session }, 201);
  });

  // GET /checkout/sessions/:id
  app.get("/checkout/sessions/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const sessionId = c.req.param("id");
    const service = c.get("checkoutService") || new CheckoutService(c.env.DB);
    // Another workspace's session id is "not found", the same as an id that does not exist.
    const session = await service.getSession(ctx.workspaceId, sessionId);

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    return c.json({ session }, 200);
  });

  // Story 0.9 (audit risk 7): there is no "complete" route. A session id is not proof of payment, so a
  // session changes state, and an invoice is issued, only from a verified payment-provider webhook. No
  // such webhook exists yet (Phase 2), so sessions stay pending and invoice creation is unreachable.

  // GET /checkout/invoices
  app.get("/checkout/invoices", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("checkoutService") || new CheckoutService(c.env.DB);
    const invoices = await service.listInvoices(workspaceId);

    return c.json({ invoices }, 200);
  });

  // GET /checkout/invoices/:id
  app.get("/checkout/invoices/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const invoiceId = c.req.param("id");
    const service = c.get("checkoutService") || new CheckoutService(c.env.DB);
    const invoice = await service.getInvoice(ctx.workspaceId, invoiceId);

    if (!invoice) {
      return c.json({ error: "Invoice not found" }, 404);
    }

    return c.json({ invoice }, 200);
  });

  return app;
}
