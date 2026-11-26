import { scoped, type D1Like, type PaymentGateway } from "@poc/sdk";

export type GatewayType = "stripe" | "lemonsqueezy" | "cashfree" | "paddle" | "custom";
export type CheckoutSessionStatus = "pending" | "completed" | "expired" | "canceled";
export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";

export interface LineItem {
  description: string;
  quantity: number;
  unitAmountCents: number;
}

export interface CheckoutSession {
  id: string;
  workspace_id: string;
  gateway: GatewayType;
  amount_cents: number;
  currency: string;
  tax_cents: number;
  total_cents: number;
  status: CheckoutSessionStatus;
  customer_email: string | null;
  checkout_url: string;
  /** Story 2.3: the provider's payment session id when a gateway created the order; null otherwise. */
  payment_session_id: string | null;
  /** Story 2.3: the customer the provider order was created for (the caller); null when no gateway is configured. */
  customer_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
}

/** Story 2.3: what recording a verified payment did. */
export type RecordPaymentResult = { status: "recorded"; invoiceId: string } | { status: "already_processed" } | { status: "not_pending" };

/** The fields of a session a provider's answer is checked against, found by session id alone (the webhook has no workspace). */
export interface SessionForPayment {
  id: string;
  workspace_id: string;
  status: CheckoutSessionStatus;
  total_cents: number;
  currency: string;
  customer_id: string | null;
  provider_ref: string | null;
}

export interface Invoice {
  id: string;
  session_id: string | null;
  workspace_id: string;
  invoice_number: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  status: InvoiceStatus;
  billing_details: Record<string, unknown> | null;
  line_items: LineItem[];
  created_at: string;
}

export interface CreateSessionInput {
  workspaceId: string;
  amountCents?: number;
  currency?: string;
  gateway?: GatewayType;
  customerEmail?: string;
  countryCode?: string;
  lineItems: LineItem[];
  metadata?: Record<string, unknown>;
  /** Story 2.3: the caller the provider order is created for. Required with a gateway. */
  customerId?: string;
}

// Built-in statutory tax rate lookups, in basis points (1900 = 19%), so tax is exact integer arithmetic.
const TAX_BASIS_POINTS_BY_COUNTRY: Record<string, number> = {
  DE: 1900,
  FR: 2000,
  GB: 2000,
  ES: 2100,
  IT: 2200,
  NL: 2100,
  IN: 1800, // GST
  JP: 1000,
  AU: 1000,
  US: 0, // Destination-dependent handled via external services
};

/**
 * Tax on a whole number of minor units, rounded half-up in exact integer arithmetic (BigInt, so a large amount never
 * loses precision): floor((amount * bp + 5000) / 10000).
 */
export function calculateTax(amountCents: number, countryCode?: string): { taxCents: number; taxRate: number } {
  if (!countryCode) return { taxCents: 0, taxRate: 0 };
  const bp = TAX_BASIS_POINTS_BY_COUNTRY[countryCode.toUpperCase().trim()] || 0;
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new RangeError("amountCents must be a whole, non-negative number");
  const taxCents = Number((BigInt(amountCents) * BigInt(bp) + 5000n) / 10000n);
  return { taxCents, taxRate: bp / 10000 };
}

export class CheckoutService {
  private readonly db: D1Like;
  private readonly defaultGateway: GatewayType;

  constructor(db: D1Like, defaultGateway: GatewayType = "stripe") {
    this.db = db;
    this.defaultGateway = defaultGateway;
  }

  /**
   * Creates a hosted checkout session with tax computation.
   */
  async createSession(input: CreateSessionInput, paymentGateway?: PaymentGateway): Promise<CheckoutSession> {
    const subtotal = input.lineItems.reduce((acc, item) => acc + item.quantity * item.unitAmountCents, 0);
    const amountCents = input.amountCents !== undefined ? input.amountCents : subtotal;
    const { taxCents } = calculateTax(amountCents, input.countryCode);
    const totalCents = amountCents + taxCents;
    if (paymentGateway && (!input.currency || !input.customerId)) {
      // Story 2.3: a real provider order never gets a guessed currency or an anonymous customer.
      throw new RangeError("a session paid through a gateway needs a currency and a customer");
    }
    const currency = (input.currency || "usd").toLowerCase().slice(0, 3);
    const gateway = input.gateway || this.defaultGateway;
    const sessionId = `cs_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const meta = input.metadata || {};

    // Story 2.3: with a gateway, the provider order is created first (for the session's total, in the smallest
    // currency unit the session is priced in) and the session is recorded only once the provider has one, so a failed
    // provider call leaves nothing behind.
    let paymentSessionId: string | null = null;
    let customerId: string | null = null;
    let providerRef: string | null = null;
    if (paymentGateway) {
      customerId = input.customerId!;
      // Sessions are priced in minor units (cents, paise): the total goes to the gateway unchanged.
      const created = await paymentGateway.createOrder({ orderId: sessionId, amountMinor: totalCents, currency: currency.toUpperCase(), customerId });
      paymentSessionId = created.paymentSessionId;
      providerRef = created.providerRef;
    }
    // px-stub: without a payment gateway the checkout URL is a synthetic placeholder; no provider is called
    const checkoutUrl = paymentGateway ? "" : `https://checkout.projectx.dev/${gateway}/${sessionId}`;

    try {
      await this.db.prepare(`
        INSERT INTO pay_checkout_sessions (
          id, workspace_id, gateway, amount_cents, currency, tax_cents, total_cents,
          status, customer_email, checkout_url, metadata_json, created_at,
          customer_id, payment_session_id, provider_ref, line_items_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        sessionId,
        input.workspaceId,
        gateway,
        amountCents,
        currency,
        taxCents,
        totalCents,
        input.customerEmail || null,
        checkoutUrl,
        JSON.stringify(meta),
        now,
        customerId,
        paymentSessionId,
        providerRef,
        // Only a gateway session's line items are kept (for its invoice); a session without one stores none, as before.
        paymentGateway ? JSON.stringify(input.lineItems) : null
      ).run();
    } catch (error) {
      if (paymentGateway) {
        // The provider has an order this brick has no session for: say which, so it can be found and cancelled.
        console.error(`checkout-gateway: provider order created but not recorded (order ${sessionId}, provider ref ${providerRef ?? "none"})`);
      }
      throw error;
    }

    return {
      id: sessionId,
      workspace_id: input.workspaceId,
      gateway,
      amount_cents: amountCents,
      currency,
      tax_cents: taxCents,
      total_cents: totalCents,
      status: "pending",
      customer_email: input.customerEmail || null,
      checkout_url: checkoutUrl,
      payment_session_id: paymentSessionId,
      customer_id: customerId,
      metadata: meta,
      created_at: now,
      completed_at: null,
    };
  }

  /**
   * Story 2.3: a session by its id alone, for the provider webhook, which carries no workspace. The id is the provider
   * order id the brick generated (unguessable); the caller acts on it only after the provider's answer matched it.
   */
  async findSessionForPayment(sessionId: string): Promise<SessionForPayment | null> {
    // tenant-lint: allow the provider webhook resolves a session by its unguessable id to learn its workspace
    const row = await this.db
      .prepare("SELECT id, workspace_id, status, total_cents, currency, customer_id, provider_ref FROM pay_checkout_sessions WHERE id = ?")
      .bind(sessionId)
      .first<SessionForPayment>();
    return row ?? null;
  }

  /**
   * Story 2.3: marks a session paid and issues its invoice, once, after a verified webhook and a matching provider
   * answer. One batch: the session moves from pending to completed, and the invoice (numbered after the session, so a
   * second one violates the UNIQUE invoice number and rolls the batch back) is copied from the session row. No client
   * route calls this: a session id is not proof of payment.
   */
  async recordVerifiedPayment(workspaceId: string, sessionId: string): Promise<RecordPaymentResult> {
    const invoiceId = `inv_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    try {
      const [completed] = await this.db.batch([
        this.db
          .prepare("UPDATE pay_checkout_sessions SET status = 'completed', completed_at = ? WHERE id = ? AND workspace_id = ? AND status = 'pending'")
          .bind(now, sessionId, workspaceId),
        this.db
          .prepare(
            "INSERT INTO pay_invoices (id, session_id, workspace_id, invoice_number, subtotal_cents, tax_cents, total_cents, currency, status, line_items_json, created_at) " +
              "SELECT ?, id, workspace_id, ?, amount_cents, tax_cents, total_cents, currency, 'paid', COALESCE(line_items_json, '[]'), ? " +
              "FROM pay_checkout_sessions WHERE id = ? AND workspace_id = ? AND status = 'completed'",
          )
          .bind(invoiceId, `INV-${sessionId}`, now, sessionId, workspaceId),
      ]);
      if (completed!.meta.changes === 0) {
        const existing = await this.getInvoiceBySessionId(workspaceId, sessionId);
        return existing ? { status: "already_processed" } : { status: "not_pending" };
      }
      return { status: "recorded", invoiceId };
    } catch (error) {
      if (/UNIQUE constraint failed/.test(error instanceof Error ? error.message : String(error))) return { status: "already_processed" };
      throw error;
    }
  }

  /**
   * Retrieves a checkout session by ID, in the given workspace only: another workspace's session id is "not found".
   */
  async getSession(workspaceId: string, sessionId: string): Promise<CheckoutSession | null> {
    interface RawSession {
      id: string;
      workspace_id: string;
      gateway: GatewayType;
      amount_cents: number;
      currency: string;
      tax_cents: number;
      total_cents: number;
      status: CheckoutSessionStatus;
      customer_email: string | null;
      checkout_url: string;
      payment_session_id: string | null;
      customer_id: string | null;
      metadata_json: string | null;
      created_at: string;
      completed_at: string | null;
    }

    const row = await scoped(this.db, workspaceId).first<RawSession>("pay_checkout_sessions", "id = ?", [sessionId]);
    if (!row) return null;

    let meta = {};
    try {
      meta = row.metadata_json ? JSON.parse(row.metadata_json) : {};
    } catch {
      meta = {};
    }

    return {
      ...row,
      metadata: meta,
    };
  }

  /**
   * Retrieves an invoice by session ID.
   */
  async getInvoiceBySessionId(workspaceId: string, sessionId: string): Promise<Invoice | null> {
    interface RawInvoice {
      id: string;
      session_id: string | null;
      workspace_id: string;
      invoice_number: string;
      subtotal_cents: number;
      tax_cents: number;
      total_cents: number;
      currency: string;
      status: InvoiceStatus;
      billing_details_json: string | null;
      line_items_json: string;
      created_at: string;
    }

    const row = await scoped(this.db, workspaceId).first<RawInvoice>(
      "pay_invoices",
      "session_id = ?",
      [sessionId]
    );

    if (!row) return null;

    return {
      ...row,
      billing_details: row.billing_details_json ? JSON.parse(row.billing_details_json) : null,
      line_items: JSON.parse(row.line_items_json || "[]"),
    };
  }

  /**
   * Retrieves an invoice by invoice ID.
   */
  async getInvoice(workspaceId: string, invoiceId: string): Promise<Invoice | null> {
    interface RawInvoice {
      id: string;
      session_id: string | null;
      workspace_id: string;
      invoice_number: string;
      subtotal_cents: number;
      tax_cents: number;
      total_cents: number;
      currency: string;
      status: InvoiceStatus;
      billing_details_json: string | null;
      line_items_json: string;
      created_at: string;
    }

    const row = await scoped(this.db, workspaceId).first<RawInvoice>(
      "pay_invoices",
      "id = ?",
      [invoiceId]
    );

    if (!row) return null;

    return {
      ...row,
      billing_details: row.billing_details_json ? JSON.parse(row.billing_details_json) : null,
      line_items: JSON.parse(row.line_items_json || "[]"),
    };
  }

  /**
   * Lists all invoices for a workspace.
   */
  async listInvoices(workspaceId: string): Promise<Invoice[]> {
    interface RawInvoice {
      id: string;
      session_id: string | null;
      workspace_id: string;
      invoice_number: string;
      subtotal_cents: number;
      tax_cents: number;
      total_cents: number;
      currency: string;
      status: InvoiceStatus;
      billing_details_json: string | null;
      line_items_json: string;
      created_at: string;
    }

    const rows = await scoped(this.db, workspaceId).select<RawInvoice>(
      "pay_invoices",
      undefined,
      [],
      { orderBy: "created_at DESC" }
    );

    return rows.map((r) => ({
      ...r,
      billing_details: r.billing_details_json ? JSON.parse(r.billing_details_json) : null,
      line_items: JSON.parse(r.line_items_json || "[]"),
    }));
  }
}
