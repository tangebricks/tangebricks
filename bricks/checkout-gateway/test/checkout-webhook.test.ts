import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like, PaymentGateway } from "@poc/sdk";
import migration from "../migrations/0001_checkout_gateway.sql?raw";
import migration0002 from "../migrations/0002_verified_payments.sql?raw";
import { CheckoutService, createCheckoutRoutes } from "../src/index.ts";
import type { CheckoutEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";
// Test only: the wallet brick's fake gateway, which implements the same provider-neutral PaymentGateway. Nothing in
// bricks/checkout-gateway/src imports credit-wallet.
import { createFakeGateway, type FakeGateway } from "../../credit-wallet/src/gateway.ts";

// Story 2.3: with a gateway, a session creates the provider order, and only a verified webhook whose re-fetched order
// matches the session's id, total, currency and customer completes it and issues its invoice, once.

const db = env.DB as D1Like;
const WS = "ws_checkout_pay";
const USER = "user-buyer";

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

afterEach(() => {
  vi.restoreAllMocks();
});

/** With a gateway, the configured currency is INR unless the test says otherwise (null: none configured). */
function appWith(gateway?: PaymentGateway, currency: string | null = "INR") {
  const app = new Hono<CheckoutEnv>();
  app.use("/api/*", stubWorkspaceContext);
  app.route("/api", createCheckoutRoutes(gateway ? { gateway, ...(currency !== null ? { currency } : {}) } : {}));
  return app;
}

const createBody = {
  currency: "inr",
  countryCode: "IN",
  lineItems: [
    { description: "Pro plan", quantity: 1, unitAmountCents: 10000 },
    { description: "Seats", quantity: 2, unitAmountCents: 2500 },
  ],
};

async function createSession(app: Hono<CheckoutEnv>, body: unknown = createBody) {
  return app.request(
    "/api/checkout/sessions",
    { method: "POST", headers: { "content-type": "application/json", "x-workspace-id": WS, "x-test-user": USER }, body: JSON.stringify(body) },
    { DB: db },
  );
}

const postWebhook = (app: Hono<CheckoutEnv>, hook: { body: string; headers: Headers }) =>
  app.request("/api/checkout/webhook", { method: "POST", headers: hook.headers, body: hook.body }, { DB: db });

const invoiceCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM pay_invoices").first<{ n: number }>())!.n;
const sessionStatus = async (id: string) => (await new CheckoutService(db).getSession(WS, id))?.status;

async function paidSession(gateway: FakeGateway, app: Hono<CheckoutEnv>) {
  const res = await createSession(app);
  expect(res.status).toBe(201);
  const { session } = (await res.json()) as { session: { id: string; total_cents: number; payment_session_id: string; checkout_url: string } };
  gateway.setOrder(session.id, { status: "PAID" });
  return session;
}

describe("checkout with a payment gateway (story 2.3)", () => {
  it("creates the provider order for the session total, currency and caller, and returns the provider session id", async () => {
    const gateway = createFakeGateway();
    const app = appWith(gateway);
    const res = await createSession(app);
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: Record<string, unknown> };
    expect(session.payment_session_id).toBe(`session_${session.id}`);
    expect(session.checkout_url).toBe(""); // no placeholder URL
    expect(session.customer_id).toBe(USER);
    // 15000 + 18% GST = 17700, in the smallest unit, upper-case currency
    expect(await gateway.fetchOrder(session.id as string, undefined)).toEqual({
      orderId: session.id,
      status: "ACTIVE",
      amountMinor: 17700,
      currency: "INR",
      customerId: USER,
    });
    // the provider's reference is stored, and the order is fetched by it
    const stored = await db
      .prepare("SELECT provider_ref, line_items_json FROM pay_checkout_sessions WHERE id = ?")
      .bind(session.id)
      .first<{ provider_ref: string; line_items_json: string }>();
    expect(stored?.provider_ref).toBe(`ref_${session.id}`);
    expect(JSON.parse(stored!.line_items_json)).toEqual(createBody.lineItems);
  });

  it("the currency is the configured one: a body without one uses it, a different one is 400, none configured is 503", async () => {
    const gateway = createFakeGateway();
    const ok = await createSession(appWith(gateway), { lineItems: createBody.lineItems });
    expect(ok.status).toBe(201);
    const { session } = (await ok.json()) as { session: { id: string } };
    expect((await gateway.fetchOrder(session.id, undefined)).currency).toBe("INR");
    expect((await createSession(appWith(gateway), { currency: "usd", lineItems: createBody.lineItems })).status).toBe(400);
    const unconfigured = await createSession(appWith(gateway, null));
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ code: "NOT_CONFIGURED" });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM pay_checkout_sessions").first<{ n: number }>())!.n).toBe(1);
  });

  it("the provider is charged the server-computed total: a client amountCents that differs is 400", async () => {
    const gateway = createFakeGateway();
    const res = await createSession(appWith(gateway), { ...createBody, amountCents: 1 });
    expect(res.status).toBe(400);
    const same = await createSession(appWith(gateway), { ...createBody, amountCents: 15000 });
    expect(same.status).toBe(201);
    const { session } = (await same.json()) as { session: { id: string } };
    expect((await gateway.fetchOrder(session.id, undefined)).amountMinor).toBe(17700);
  });

  it("caps a gateway session's line items at 50 (a session without a gateway is not capped)", async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ description: `i${i}`, quantity: 1, unitAmountCents: 1 }));
    expect((await createSession(appWith(createFakeGateway()), { currency: "inr", lineItems: many })).status).toBe(400);
    expect((await createSession(appWith(), { lineItems: many })).status).toBe(201);
  });

  it("refuses, before any provider order, a total that is zero or not a safe whole number", async () => {
    const gateway = createFakeGateway();
    const created = vi.spyOn(gateway, "createOrder");
    expect((await createSession(appWith(gateway), { lineItems: [{ description: "free", quantity: 1, unitAmountCents: 0 }] })).status).toBe(400);
    const huge = Array.from({ length: 50 }, (_, i) => ({ description: `i${i}`, quantity: 1_000_000, unitAmountCents: 1_000_000_000_000 }));
    expect((await createSession(appWith(gateway), { lineItems: huge })).status).toBe(400);
    expect((await createSession(appWith(gateway), { lineItems: [{ description: "x", quantity: 1_000_001, unitAmountCents: 1 }] })).status).toBe(400);
    expect(created).not.toHaveBeenCalled();
  });

  it("refuses, before any provider order, metadata or an email the session table cannot hold", async () => {
    const gateway = createFakeGateway();
    const created = vi.spyOn(gateway, "createOrder");
    expect((await createSession(appWith(gateway), { ...createBody, metadata: { blob: "x".repeat(2100) } })).status).toBe(400);
    expect((await createSession(appWith(gateway), { ...createBody, customerEmail: `${"a".repeat(250)}@example.com` })).status).toBe(400);
    expect(created).not.toHaveBeenCalled();
  });

  it("a correctly signed event about no order is acknowledged (200 ignored); an oversized body is 413", async () => {
    const gateway = createFakeGateway();
    const app = appWith(gateway);
    const ignored = await postWebhook(app, await gateway.signWebhook(null));
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toMatchObject({ status: "ignored" });
    const big = await app.request("/api/checkout/webhook", { method: "POST", body: "x".repeat(64 * 1024 + 1) }, { DB: db });
    expect(big.status).toBe(413);
  });

  it("a signed webhook for an unknown session is 200 ignored, logged at error level with the order id and reference", async () => {
    const gateway = createFakeGateway();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unknown = `cs_${"0".repeat(32)}`;
    const res = await postWebhook(appWith(gateway), await gateway.signWebhook(unknown));
    expect(res.status).toBe(200);
    expect(logged.mock.calls.flat().join(" ")).toMatch(new RegExp(`${unknown}.*ref_${unknown}`));
  });

  it("a signed webhook for another brick's order (not a cs_ session id) is 200 ignored, with no error log", async () => {
    const gateway = createFakeGateway();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await postWebhook(appWith(gateway), await gateway.signWebhook("order_0123456789abcdef"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ignored" });
    expect(logged).not.toHaveBeenCalled();
  });

  it("a session insert that fails after the provider order was created logs the provider order at error level and answers 502", async () => {
    const gateway = createFakeGateway();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await db.prepare("DROP TABLE pay_checkout_sessions").run();
    const res = await createSession(appWith(gateway));
    expect(res.status).toBe(502);
    expect(logged.mock.calls.flat().join(" ")).toMatch(/provider order created but not recorded \(order cs_[0-9a-f]+, provider ref ref_cs_/);
  });

  it("a provider failure is 502 with no provider text, and no session is recorded", async () => {
    const gateway = createFakeGateway();
    gateway.failCreates(true);
    const res = await createSession(appWith(gateway));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("gateway unavailable");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM pay_checkout_sessions").first<{ n: number }>())!.n).toBe(0);
  });

  it("a verified webhook for a paid, matching order completes the session and issues one invoice; a duplicate issues none", async () => {
    const gateway = createFakeGateway();
    const app = appWith(gateway);
    const session = await paidSession(gateway, app);
    const hook = await gateway.signWebhook(session.id);

    const first = await postWebhook(app, hook); // no workspace header: the provider has none
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "PAID" });
    expect(await sessionStatus(session.id)).toBe("completed");
    const invoice = await new CheckoutService(db).getInvoiceBySessionId(WS, session.id);
    expect(invoice).toMatchObject({
      workspace_id: WS,
      total_cents: 17700,
      subtotal_cents: 15000,
      tax_cents: 2700,
      currency: "inr",
      status: "paid",
      invoice_number: `INV-${session.id}`,
    });
    expect(invoice!.line_items).toEqual(createBody.lineItems);

    const second = await postWebhook(app, hook);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "already_processed" });
    expect(await invoiceCount()).toBe(1);
  });

  it("two concurrent deliveries issue one invoice", async () => {
    const gateway = createFakeGateway();
    const app = appWith(gateway);
    const session = await paidSession(gateway, app);
    const hook = await gateway.signWebhook(session.id);
    const answers = await Promise.all([postWebhook(app, hook), postWebhook(app, hook)]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    expect(await invoiceCount()).toBe(1);
  });

  it("recording a payment twice through the service issues one invoice", async () => {
    const gateway = createFakeGateway();
    const session = await paidSession(gateway, appWith(gateway));
    const service = new CheckoutService(db);
    expect((await service.recordVerifiedPayment(WS, session.id)).status).toBe("recorded");
    expect((await service.recordVerifiedPayment(WS, session.id)).status).toBe("already_processed");
    expect(await invoiceCount()).toBe(1);
  });

  it("a forged webhook is 401: the session stays pending and no invoice is issued", async () => {
    const gateway = createFakeGateway();
    const app = appWith(gateway);
    const session = await paidSession(gateway, app);
    const forged = await createFakeGateway().signWebhook(session.id);
    expect((await postWebhook(app, forged)).status).toBe(401);
    expect(await sessionStatus(session.id)).toBe("pending");
    expect(await invoiceCount()).toBe(0);
  });

  it.each([
    ["orderId", { orderId: "cs_someone_else" }],
    ["amount", { amountMinor: 100 }],
    ["currency", { currency: "USD" }],
    ["customerId", { customerId: "user-intruder" }],
  ] as const)("a re-fetched order with a different %s is 409: no completion, no invoice", async (_field, patch) => {
    const gateway = createFakeGateway();
    const app = appWith(gateway);
    const session = await paidSession(gateway, app);
    gateway.setOrder(session.id, patch);
    const res = await postWebhook(app, await gateway.signWebhook(session.id));
    expect(res.status).toBe(409);
    expect(await sessionStatus(session.id)).toBe("pending");
    expect(await invoiceCount()).toBe(0);
  });

  it("an unpaid order is 200 and completes nothing; a provider outage is 502", async () => {
    const gateway = createFakeGateway();
    const app = appWith(gateway);
    const res = await createSession(app);
    const { session } = (await res.json()) as { session: { id: string } };
    const hook = await gateway.signWebhook(session.id);
    expect((await postWebhook(app, hook)).status).toBe(200);
    gateway.setOrder(session.id, { status: "PAID" });
    gateway.failFetches(true);
    expect((await postWebhook(app, hook)).status).toBe(502);
    expect(await sessionStatus(session.id)).toBe("pending");
    expect(await invoiceCount()).toBe(0);
  });

  it("a session made without a gateway can never be completed by a webhook (no customer to match)", async () => {
    const gateway = createFakeGateway();
    const plain = await new CheckoutService(db).createSession({ workspaceId: WS, currency: "inr", lineItems: createBody.lineItems });
    gateway.setOrder(plain.id, { orderId: plain.id, status: "PAID", amountMinor: plain.total_cents, currency: "INR", customerId: "" });
    expect((await postWebhook(appWith(gateway), await gateway.signWebhook(plain.id))).status).toBe(409);
    expect(await invoiceCount()).toBe(0);
  });
});

describe("checkout without a payment gateway (behaviour unchanged; only migration 0002's empty columns are new)", () => {
  it("sessions keep the placeholder URL and the webhook answers 503 NOT_CONFIGURED", async () => {
    const app = appWith();
    const res = await createSession(app, { lineItems: createBody.lineItems });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: { id: string; checkout_url: string; currency: string } };
    expect(session.checkout_url).toMatch(/^https:\/\/checkout\.projectx\.dev\/stripe\/cs_/);
    expect(session.currency).toBe("usd");
    // no gateway: nothing new is stored (no line items, no provider fields)
    const stored = await db.prepare("SELECT line_items_json, provider_ref, customer_id FROM pay_checkout_sessions WHERE id = ?").bind(session.id).first();
    expect(stored).toEqual({ line_items_json: null, provider_ref: null, customer_id: null });
    const hook = await createFakeGateway().signWebhook(session.id);
    const webhook = await postWebhook(app, hook);
    expect(webhook.status).toBe(503);
    expect(await webhook.json()).toMatchObject({ code: "NOT_CONFIGURED" });
    expect(await sessionStatus(session.id)).toBe("pending");
  });
});
