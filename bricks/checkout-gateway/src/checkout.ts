import { scoped, type D1Like } from "@poc/sdk";

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
  metadata: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
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
}

// Built-in statutory tax rate lookups
const TAX_RATES_BY_COUNTRY: Record<string, number> = {
  DE: 0.19,
  FR: 0.20,
  GB: 0.20,
  ES: 0.21,
  IT: 0.22,
  NL: 0.21,
  IN: 0.18, // GST
  JP: 0.10,
  AU: 0.10,
  US: 0.00, // Destination-dependent handled via external services
};

export function calculateTax(amountCents: number, countryCode?: string): { taxCents: number; taxRate: number } {
  if (!countryCode) return { taxCents: 0, taxRate: 0 };
  const rate = TAX_RATES_BY_COUNTRY[countryCode.toUpperCase().trim()] || 0;
  const taxCents = Math.round(amountCents * rate);
  return { taxCents, taxRate: rate };
}

export class CheckoutService {
  constructor(
    private readonly db: D1Like,
    private readonly defaultGateway: GatewayType = "stripe"
  ) {}

  /**
   * Creates a hosted checkout session with tax computation.
   */
  async createSession(input: CreateSessionInput): Promise<CheckoutSession> {
    const subtotal = input.lineItems.reduce((acc, item) => acc + item.quantity * item.unitAmountCents, 0);
    const amountCents = input.amountCents !== undefined ? input.amountCents : subtotal;
    const { taxCents } = calculateTax(amountCents, input.countryCode);
    const totalCents = amountCents + taxCents;
    const currency = (input.currency || "usd").toLowerCase().slice(0, 3);
    const gateway = input.gateway || this.defaultGateway;
    const sessionId = `cs_${crypto.randomUUID().replace(/-/g, "")}`;
    const checkoutUrl = `https://checkout.projectx.dev/${gateway}/${sessionId}`;
    const now = new Date().toISOString();
    const meta = input.metadata || {};

    await this.db.prepare(`
      INSERT INTO pay_checkout_sessions (
        id, workspace_id, gateway, amount_cents, currency, tax_cents, total_cents,
        status, customer_email, checkout_url, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
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
      now
    ).run();

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
      metadata: meta,
      created_at: now,
      completed_at: null,
    };
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
