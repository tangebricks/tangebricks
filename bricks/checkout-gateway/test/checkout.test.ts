import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_checkout_gateway.sql?raw";
import migration0002 from "../migrations/0002_verified_payments.sql?raw";
import {
  CheckoutService,
  createCheckoutRoutes,
  calculateTax,
} from "../src/index.ts";
import type { CheckoutEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_checkout_alpha";
const WS_BETA = "ws_checkout_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS pay_invoices").run();
  await db.prepare("DROP TABLE IF EXISTS pay_checkout_sessions").run();
  await applyMigration(db, migration);
  await applyMigration(db, migration0002);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

/**
 * Story 0.9: invoices are issued only by a verified payment-provider webhook, which does not exist yet
 * (Phase 2), so nothing in the brick can create one. Invoice read and isolation tests seed the row
 * directly, as that webhook would.
 */
async function seedPaidInvoice(workspaceId: string, sessionId: string | null, invoiceNumber: string): Promise<string> {
  const id = `inv_${crypto.randomUUID().replace(/-/g, "")}`;
  await db
    .prepare(
      "INSERT INTO pay_invoices (id, session_id, workspace_id, invoice_number, subtotal_cents, tax_cents, total_cents, currency, status, line_items_json) VALUES (?, ?, ?, ?, 1000, 0, 1000, 'usd', 'paid', '[]')",
    )
    .bind(id, sessionId, workspaceId, invoiceNumber)
    .run();
  return id;
}

describe("Checkout & Tax Engine Core Logic", () => {
  it("computes statutory tax rates correctly", () => {
    // Germany 19% VAT on 10000 cents ($100) -> 1900 cents
    const de = calculateTax(10000, "DE");
    expect(de.taxCents).toBe(1900);
    expect(de.taxRate).toBe(0.19);

    // Great Britain 20% VAT on 5000 cents -> 1000 cents
    const gb = calculateTax(5000, "GB");
    expect(gb.taxCents).toBe(1000);

    // Country with no tax / unknown -> 0
    const us = calculateTax(10000, "US");
    expect(us.taxCents).toBe(0);

    // Story 2.3: integer basis points, rounded half-up exactly (no floating point): 18% of 1 paisa..
    expect(calculateTax(3, "IN").taxCents).toBe(1); // 0.54 -> 1
    expect(calculateTax(2, "IN").taxCents).toBe(0); // 0.36 -> 0
    expect(calculateTax(25, "DE").taxCents).toBe(5); // 4.75 -> 5
    expect(calculateTax(50, "JP").taxCents).toBe(5); // exactly 5
    expect(calculateTax(Number.MAX_SAFE_INTEGER, "IN").taxCents).toBe(Number((BigInt(Number.MAX_SAFE_INTEGER) * 1800n + 5000n) / 10000n));
  });

  it("creates checkout session with tax computation and line items", async () => {
    const service = new CheckoutService(db, "stripe");
    const session = await service.createSession({
      workspaceId: WS_ALPHA,
      gateway: "stripe",
      currency: "usd",
      countryCode: "DE",
      customerEmail: "billing@acme.de",
      lineItems: [
        { description: "Pro Plan Subscription", quantity: 1, unitAmountCents: 10000 },
        { description: "Extra 100k API Tokens", quantity: 2, unitAmountCents: 1500 },
      ],
      metadata: { planId: "tier_pro" },
    });

    expect(session.id).toMatch(/^cs_[a-f0-9]{32}$/);
    expect(session.status).toBe("pending");
    expect(session.amount_cents).toBe(13000); // 10000 + 3000
    expect(session.tax_cents).toBe(2470); // 19% of 13000 = 2470
    expect(session.total_cents).toBe(15470);
    expect(session.checkout_url).toContain(session.id);

    // Reload from D1
    const reloaded = await service.getSession(WS_ALPHA, session.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.amount_cents).toBe(13000);
    expect(reloaded?.customer_email).toBe("billing@acme.de");
  });

  it("has no way to complete a session or issue an invoice without a verified webhook (story 0.9, audit risk 7)", async () => {
    const service = new CheckoutService(db);
    const session = await service.createSession({
      workspaceId: WS_ALPHA,
      countryCode: "FR",
      lineItems: [{ description: "Enterprise License", quantity: 1, unitAmountCents: 50000 }],
    });

    expect("completeSession" in service).toBe(false);
    expect((await service.getSession(WS_ALPHA, session.id))?.status).toBe("pending");
    expect(await service.getInvoiceBySessionId(WS_ALPHA, session.id)).toBeNull();
    expect(await service.listInvoices(WS_ALPHA)).toHaveLength(0);
  });

  it("isolates invoices per workspace", async () => {
    const service = new CheckoutService(db);
    const sAlpha = await service.createSession({
      workspaceId: WS_ALPHA,
      lineItems: [{ description: "Plan Alpha", quantity: 1, unitAmountCents: 2000 }],
    });
    const sBeta = await service.createSession({
      workspaceId: WS_BETA,
      lineItems: [{ description: "Plan Beta", quantity: 1, unitAmountCents: 4000 }],
    });

    await seedPaidInvoice(WS_ALPHA, sAlpha.id, "INV-TEST-00001");
    await seedPaidInvoice(WS_BETA, sBeta.id, "INV-TEST-00002");

    const invoicesAlpha = await service.listInvoices(WS_ALPHA);
    const invoicesBeta = await service.listInvoices(WS_BETA);

    expect(invoicesAlpha).toHaveLength(1);
    expect(invoicesBeta).toHaveLength(1);
    expect(invoicesAlpha[0]?.workspace_id).toBe(WS_ALPHA);
    expect(invoicesBeta[0]?.workspace_id).toBe(WS_BETA);
    expect((await service.getInvoiceBySessionId(WS_ALPHA, sBeta.id))).toBeNull();
  });
});

describe("Checkout HTTP API", () => {
  it("creates a session, cannot complete it over HTTP, and retrieves an invoice via HTTP", async () => {
    const app = new Hono<CheckoutEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createCheckoutRoutes());

    // 1. Create Session
    const createRes = await app.request("/api/checkout/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        gateway: "lemonsqueezy",
        countryCode: "GB",
        lineItems: [{ description: "Addon Package", quantity: 1, unitAmountCents: 5000 }],
      }),
    }, { DB: db });
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as { session: { id: string } };
    const sessionId = createJson.session.id;

    // 2. Query session status
    const getRes = await app.request(`/api/checkout/sessions/${sessionId}`, { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(getRes.status).toBe(200);

    // 3. CHECKOUT_COMPLETE (story 0.9): the "complete" route is gone. 404, the session stays pending, no invoice.
    const completeRes = await app.request(`/api/checkout/sessions/${sessionId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        billingDetails: { name: "John Doe" },
      }),
    }, { DB: db });
    expect(completeRes.status).toBe(404);
    const afterRes = await app.request(`/api/checkout/sessions/${sessionId}`, { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(((await afterRes.json()) as { session: { status: string } }).session.status).toBe("pending");
    const emptyList = await app.request("/api/checkout/invoices", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(((await emptyList.json()) as { invoices: unknown[] }).invoices).toHaveLength(0);

    // 4. Query an invoice (seeded as the future verified webhook would issue it)
    const invoiceId = await seedPaidInvoice(WS_ALPHA, sessionId, "INV-TEST-00003");
    const invRes = await app.request(`/api/checkout/invoices/${invoiceId}`, { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(invRes.status).toBe(200);
    const invJson = (await invRes.json()) as { invoice: { invoice_number: string } };
    expect(invJson.invoice.invoice_number).toBe("INV-TEST-00003");

    // 5. List invoices
    const listRes = await app.request("/api/checkout/invoices", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { invoices: unknown[] };
    expect(listJson.invoices).toHaveLength(1);
  });

  // ID_READ_FOREIGN (story 0.7): another workspace's session or invoice id is "not found", never its data.
  it("answers 404 for a session or invoice id that belongs to another workspace", async () => {
    const app = new Hono<CheckoutEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createCheckoutRoutes());

    const service = new CheckoutService(db);
    const sBeta = await service.createSession({
      workspaceId: WS_BETA,
      lineItems: [{ description: "Plan Beta", quantity: 1, unitAmountCents: 4000 }],
    });
    const betaInvoiceId = await seedPaidInvoice(WS_BETA, sBeta.id, "INV-TEST-00004");

    const asAlpha = { headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA } };
    expect((await app.request(`/api/checkout/sessions/${sBeta.id}`, asAlpha, { DB: db })).status).toBe(404);
    expect((await app.request(`/api/checkout/invoices/${betaInvoiceId}`, asAlpha, { DB: db })).status).toBe(404);

    const pending = await service.createSession({
      workspaceId: WS_BETA,
      lineItems: [{ description: "Plan Beta 2", quantity: 1, unitAmountCents: 1000 }],
    });
    const complete = await app.request(`/api/checkout/sessions/${pending.id}/complete`, { ...asAlpha, method: "POST", body: "{}" }, { DB: db });
    expect(complete.status).toBe(404);
    // Beta's session was not completed by Alpha's attempt (the route does not exist).
    expect((await service.getSession(WS_BETA, pending.id))?.status).toBe("pending");
    expect(await service.getSession(WS_ALPHA, sBeta.id)).toBeNull();
    expect(await service.getInvoice(WS_ALPHA, betaInvoiceId)).toBeNull();
  });
});
