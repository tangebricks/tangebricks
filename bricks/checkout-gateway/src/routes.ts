import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  NotConfiguredError,
  checkGatewayOrder,
  isPaymentCurrency,
  readBoundedText,
  type GatewayOrder,
  type PaymentGateway,
  type WebhookVerification,
} from "@poc/sdk";
import { CheckoutService, calculateTax, type GatewayType } from "./checkout.ts";
import { checkoutMiddleware, type CheckoutEnv } from "./middleware.ts";

export interface CheckoutRoutesOptions {
  /**
   * Story 2.3: the payment provider (any `PaymentGateway`, the same shape credit-wallet takes). Optional: without one
   * sessions get a placeholder URL as before and `/checkout/webhook` answers 503 NOT_CONFIGURED. With one, a session
   * creates the provider order (for its total, in the smallest unit of its currency) and returns the provider's
   * payment session id, and the session is completed only by a verified webhook.
   */
  gateway?: PaymentGateway;
  /**
   * Story 2.3: the currency gateway sessions are priced in (ISO 4217, upper case; the assembler fills it from the
   * `paymentCurrency` setting, empty by default). Required with a gateway: without it session creation and the webhook
   * answer 503 NOT_CONFIGURED. A request body's currency must equal it.
   */
  currency?: string;
}

/** The most line items one gateway session may have (sessions without a gateway are not capped, as before). */
const MAX_LINE_ITEMS = 50;
/** Checkout ids this brick generates; a provider event naming anything else is another brick's. */
const SESSION_ID = /^cs_[0-9a-f]{32}$/;

/** The session line items are copied onto the invoice, whose column holds at most this many characters. */
const MAX_LINE_ITEMS_JSON = 4096;

function notConfigured(c: Context<CheckoutEnv>) {
  return c.json({ error: "NOT_CONFIGURED: no payment gateway or payment currency is configured for checkout.", code: "NOT_CONFIGURED" }, 503);
}

const LineItemSchema = z.object({
  description: z.string().min(1).max(255),
  quantity: z.number().int().min(1).max(1_000_000),
  unitAmountCents: z.number().int().min(0).max(1_000_000_000_000),
});

const CreateSessionSchema = z.object({
  amountCents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  gateway: z.enum(["stripe", "lemonsqueezy", "cashfree", "paddle", "custom"]).optional(),
  // Bounded like the table's CHECKs, so a session is refused here, before any provider order exists.
  customerEmail: z.string().email().max(255).optional(),
  countryCode: z.string().length(2).optional(),
  lineItems: z.array(LineItemSchema).min(1),
  metadata: z
    .record(z.string(), z.unknown())
    .refine((m) => JSON.stringify(m).length <= 2048, "metadata is too large (at most 2048 characters of JSON)")
    .optional(),
});

export function createCheckoutRoutes(options: CheckoutRoutesOptions = {}): Hono<CheckoutEnv> {
  const app = new Hono<CheckoutEnv>();
  const paymentGateway = options.gateway;
  // With a gateway, payments also need a configured currency; either missing is NOT_CONFIGURED, never a default.
  const paymentsConfigured = Boolean(paymentGateway) && isPaymentCurrency(options.currency);

  app.use("*", checkoutMiddleware);

  // Story 2.3: the provider's payment notification. The provider calls it, so it has no user and no workspace and is
  // not behind the workspace guard (the manifest's guardPaths leave it out); the signature over the raw body is its
  // authentication. A verified webhook only names a session: the provider order is re-fetched and must match the
  // session's id, total, currency and customer before the session is completed and its invoice issued, once.
  // Answers: 200 for recorded, already processed, not paid yet or an unknown session; 401 bad signature; 409 mismatch;
  // 502 when the provider could not be asked.
  app.post("/checkout/webhook", async (c) => {
    if (!paymentGateway || !paymentsConfigured) return notConfigured(c);
    // Bounded before any HMAC: a declared or actual body over 64 KiB is refused.
    const rawBody = await readBoundedText(c.req.raw);
    if (rawBody === null) return c.json({ error: "Webhook body too large" }, 413);
    let verified: WebhookVerification;
    try {
      verified = await paymentGateway.verifyWebhook(rawBody, c.req.raw.headers);
    } catch (error) {
      if (error instanceof NotConfiguredError) return notConfigured(c);
      console.error("POST /checkout/webhook: signature check failed:", error instanceof Error ? error.name : "error");
      return c.json({ error: "Webhook verification failed" }, 500);
    }
    if (verified.kind === "invalid") return c.json({ error: "Invalid webhook signature" }, 401);
    // Correctly signed but not about an order: acknowledged, so the provider stops retrying.
    if (verified.kind === "ignored") return c.json({ received: true, status: "ignored" }, 200);
    // An id that is not a checkout session id is another brick's order on the same provider account (the wallet's,
    // say): not ours, so acknowledged quietly.
    if (!SESSION_ID.test(verified.orderId)) return c.json({ received: true, status: "ignored" }, 200);

    const service = c.get("checkoutService") || new CheckoutService(c.env.DB);
    const session = await service.findSessionForPayment(verified.orderId);
    if (!session) {
      // A signed event for a session this brick never recorded (an orphan provider order, or another brick's).
      // Acknowledged so the provider stops retrying, but loudly, so it can be reconciled.
      console.error(
        `checkout-gateway: signed payment webhook for an unknown session (order ${verified.orderId}, provider ref ${verified.providerRef ?? "none"})`,
      );
      return c.json({ received: true, status: "ignored" }, 200);
    }
    if (session.status === "completed") return c.json({ received: true, status: "already_processed" }, 200);
    if (session.status !== "pending") return c.json({ received: true, status: session.status }, 200);

    let order: GatewayOrder;
    try {
      order = await paymentGateway.fetchOrder(session.id, session.provider_ref ?? undefined);
    } catch {
      return c.json({ error: "Could not verify with payment gateway" }, 502);
    }
    if (order.status !== "PAID") return c.json({ received: true, status: order.status }, 200);
    const check = checkGatewayOrder(
      { orderId: session.id, amountMinor: session.total_cents, currency: session.currency, customerId: session.customer_id ?? "" },
      order,
    );
    if (!check.ok) {
      // Names the field only, never a value from the provider.
      console.warn(`checkout payment verification mismatch on ${check.field} for session ${session.id}`);
      return c.json({ error: "Payment verification failed", status: "verification_mismatch" }, 409);
    }

    const recorded = await service.recordVerifiedPayment(session.workspace_id, session.id);
    if (recorded.status === "recorded") return c.json({ received: true, status: "PAID", invoiceId: recorded.invoiceId }, 200);
    return c.json({ received: true, status: recorded.status }, 200);
  });

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
    let currency = parsed.data.currency;
    let amountCents = parsed.data.amountCents;
    if (paymentGateway) {
      // Story 2.3: the currency is the configured one, never the client's; a body currency must agree with it.
      if (!paymentsConfigured) return notConfigured(c);
      if (currency !== undefined && currency.toUpperCase() !== options.currency) return c.json({ error: `currency must be ${options.currency}` }, 400);
      currency = options.currency!;
      // The provider is charged the server-computed line-item total plus tax; a different client amount is refused.
      const subtotal = parsed.data.lineItems.reduce((acc, item) => acc + item.quantity * item.unitAmountCents, 0);
      if (amountCents !== undefined && amountCents !== subtotal) return c.json({ error: "amountCents must equal the line items' total" }, 400);
      amountCents = undefined;
      // The line items are copied onto the invoice, whose column holds at most this many characters.
      if (parsed.data.lineItems.length > MAX_LINE_ITEMS) return c.json({ error: `At most ${MAX_LINE_ITEMS} line items` }, 400);
      if (JSON.stringify(parsed.data.lineItems).length > MAX_LINE_ITEMS_JSON) return c.json({ error: "Too many line items" }, 400);
      // The provider is asked for a safe, positive whole amount or nothing at all.
      const total = Number.isSafeInteger(subtotal) ? subtotal + calculateTax(subtotal, parsed.data.countryCode).taxCents : Number.NaN;
      if (!Number.isSafeInteger(total) || total <= 0) return c.json({ error: "The session total must be a positive whole amount" }, 400);
    }

    const service = c.get("checkoutService") || new CheckoutService(c.env.DB);
    let session;
    try {
      session = await service.createSession(
        {
          workspaceId,
          amountCents,
          currency,
          gateway: parsed.data.gateway as GatewayType | undefined,
          customerEmail: parsed.data.customerEmail,
          countryCode: parsed.data.countryCode,
          lineItems: parsed.data.lineItems,
          metadata: parsed.data.metadata,
          customerId: ctx.userId,
        },
        paymentGateway,
      );
    } catch (error) {
      if (!paymentGateway) throw error;
      // The provider's own text (and anything secret in it) never reaches the client; no session was recorded.
      console.error("POST /checkout/sessions: payment gateway error:", error instanceof Error ? error.name : "error");
      return c.json({ error: "Payment gateway error" }, 502);
    }

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
  // session changes state, and an invoice is issued, only from a verified payment-provider webhook
  // (`POST /checkout/webhook`, story 2.3, which needs a configured gateway).

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
