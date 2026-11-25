import { env } from "cloudflare:workers";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigration, type D1Like } from "@poc/sdk";
import { createFakeGateway, createWallet, createWalletRoutes } from "@poc/credit-wallet";
import walletMigration from "../../../bricks/credit-wallet/migrations/0001_credit_wallet.sql?raw";
import walletMigration0002 from "../../../bricks/credit-wallet/migrations/0002_workspace_scoped_idempotency.sql?raw";
import walletMigration0003 from "../../../bricks/credit-wallet/migrations/0003_order_currency.sql?raw";
import { cashfreeProvider, fakeProvider, stripeProvider, type TamperField, type TestProvider } from "./support/providers.ts";

// Story 2.3: the wallet's verification checks and its webhook route, run the same way against the fake gateway, the
// Cashfree adapter and the Stripe adapter (both reached through an injected fetch; no provider is ever called).

const db = env.DB as D1Like;
const WS = "ws-verify";
const OWNER = "user-123";

// STUB IDENTITY, test only: trusts a header. The webhook route needs no identity at all.
const stubIdentity: MiddlewareHandler = async (c, next) => {
  const uid = c.req.header("x-test-user");
  if (uid) c.set("user", { uid });
  await next();
};

async function reset(): Promise<void> {
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, walletMigration);
  await applyMigration(db, walletMigration0002);
  await applyMigration(db, walletMigration0003);
}

const providers: Array<[string, () => TestProvider]> = [
  ["fake", fakeProvider],
  ["cashfree", cashfreeProvider],
  ["stripe", stripeProvider],
];

const balance = () => createWallet(db, undefined).getBalance(WS);
const ledgerRows = async () => (await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE workspace_id = ?").bind(WS).first<{ n: number }>())!.n;

beforeEach(async () => {
  expect.hasAssertions();
  await reset();
});

describe.each(providers)("wallet verification with the %s gateway", (_name, make) => {
  // The currency each provider is exercised in: Cashfree is INR-first; the others are run in USD so a currency check
  // is not only ever tested with one value.
  const currencyFor = (provider: TestProvider) => (provider.name === "cashfree" ? "INR" : "USD");

  function setup() {
    const provider = make();
    const currency = currencyFor(provider);
    const wallet = createWallet(db, provider.gateway, { currency, creditsPerUnit: 10 });
    const app = new Hono();
    app.use("/api/*", stubIdentity);
    app.route("/api", createWalletRoutes({ gateway: provider.gateway, currency, creditsPerUnit: 10 }));
    const verify = (orderId: string, user = OWNER) =>
      app.fetch(
        new Request("http://localhost/api/payments/verify", {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-user": user },
          body: JSON.stringify({ order_id: orderId }),
        }),
        { DB: db },
      );
    const webhook = (hook: { body: string; headers: Headers }) =>
      app.fetch(new Request("http://localhost/api/payments/webhook", { method: "POST", headers: hook.headers, body: hook.body }), { DB: db });
    const newOrder = async (amount = 150) => {
      await wallet.openWallet(WS, 0);
      return (await wallet.createOrder({ workspaceId: WS, userId: OWNER, amount })).orderId;
    };
    return { provider, wallet, verify, webhook, newOrder, currency };
  }

  it("a paid order whose id, amount, currency and customer match is credited once (client verify)", async () => {
    const { provider, verify, newOrder } = setup();
    const orderId = await newOrder();
    await provider.markPaid(orderId);
    const first = await verify(orderId);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "PAID", credited: true, credits: 1500 });
    const again = await verify(orderId);
    expect(await again.json()).toMatchObject({ status: "already_processed", credited: false });
    expect(await balance()).toBe(1500);
    expect(await ledgerRows()).toBe(1);
  });

  it.each(["orderId", "amount", "currency", "customerId"] as TamperField[])("a %s mismatch is refused with 409 and credits nothing (client verify)", async (field) => {
    const { provider, verify, newOrder } = setup();
    const orderId = await newOrder();
    await provider.markPaid(orderId);
    await provider.tamper(orderId, field);
    const res = await verify(orderId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: "verification_mismatch", credited: false });
    expect(await balance()).toBe(0);
    expect(await ledgerRows()).toBe(0);
  });

  it.each(["orderId", "amount", "currency", "customerId"] as TamperField[])("a %s mismatch is refused by confirmOrder and names the field", async (field) => {
    const { provider, wallet, newOrder } = setup();
    const orderId = await newOrder();
    await provider.markPaid(orderId);
    await provider.tamper(orderId, field);
    expect(await wallet.confirmOrder(orderId)).toMatchObject({ status: "verification_mismatch", credited: false, field });
    expect(await balance()).toBe(0);
  });

  it.each(["amountTimes100", "amountOver100"] as TamperField[])("a provider amount off by a factor of 100 (%s) is an amount mismatch", async (field) => {
    const { provider, wallet, newOrder } = setup();
    const orderId = await newOrder();
    await provider.markPaid(orderId);
    await provider.tamper(orderId, field);
    expect(await wallet.confirmOrder(orderId)).toMatchObject({ status: "verification_mismatch", credited: false, field: "amount" });
    expect(await balance()).toBe(0);
  });

  it("a valid webhook credits once, and a duplicate delivery is 200 already_processed", async () => {
    const { provider, webhook, newOrder } = setup();
    const orderId = await newOrder();
    await provider.markPaid(orderId);
    const hook = await provider.signedWebhook(orderId);
    const first = await webhook(hook);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "PAID", credited: true });
    const second = await webhook(hook);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "already_processed", credited: false });
    expect(await balance()).toBe(1500);
    expect(await ledgerRows()).toBe(1);
  });

  it("two concurrent deliveries of the same webhook credit once", async () => {
    const { provider, webhook, newOrder } = setup();
    const orderId = await newOrder();
    await provider.markPaid(orderId);
    const hook = await provider.signedWebhook(orderId);
    const answers = await Promise.all([webhook(hook), webhook(hook)]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    expect(await balance()).toBe(1500);
    expect(await ledgerRows()).toBe(1);
  });

  it("a forged webhook is 401 and credits nothing, even for a paid order", async () => {
    const { provider, webhook, newOrder } = setup();
    const orderId = await newOrder();
    await provider.markPaid(orderId);
    const res = await webhook(await provider.forgedWebhook(orderId));
    expect(res.status).toBe(401);
    expect(await balance()).toBe(0);
  });

  it("a webhook for an unpaid order is 200 and credits nothing", async () => {
    const { provider, webhook, newOrder } = setup();
    const orderId = await newOrder();
    const res = await webhook(await provider.signedWebhook(orderId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ credited: false });
    expect(await balance()).toBe(0);
  });

  it.each(["orderId", "amount", "currency", "customerId"] as TamperField[])("a webhook whose re-fetched order has a %s mismatch is 409 and credits nothing", async (field) => {
    const { provider, webhook, newOrder } = setup();
    const orderId = await newOrder();
    await provider.markPaid(orderId);
    await provider.tamper(orderId, field);
    const res = await webhook(await provider.signedWebhook(orderId));
    expect(res.status).toBe(409);
    expect(await balance()).toBe(0);
  });

  it("a provider outage is 502 (retry later) on both paths and credits nothing", async () => {
    const { provider, verify, webhook, newOrder } = setup();
    const orderId = await newOrder();
    await provider.markPaid(orderId);
    const hook = await provider.signedWebhook(orderId);
    provider.goDown();
    expect((await webhook(hook)).status).toBe(502);
    expect((await verify(orderId)).status).toBe(502);
    expect(await balance()).toBe(0);
  });

  it("an order created before migration 0003 (no stored currency) is held to the configured currency", async () => {
    const { provider, wallet, newOrder } = setup();
    const orderId = await newOrder();
    await provider.markPaid(orderId);
    await db.prepare("UPDATE credit_orders SET currency = NULL WHERE order_id = ?").bind(orderId).run();
    expect(await wallet.confirmOrder(orderId)).toMatchObject({ status: "PAID", credited: true });
  });
});

describe("amount units: the wallet's whole rupees cross the interface as paise (story 2.3)", () => {
  it("a 500-rupee order is sent to Cashfree as order_amount 500.00, and credited after the paid fetch round-trip", async () => {
    const provider = cashfreeProvider();
    const wallet = createWallet(db, provider.gateway, { currency: "INR" });
    await wallet.openWallet(WS, 0);
    const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: OWNER, amount: 500 });
    const sent = provider.requests.find((r) => r.method === "POST")!;
    expect(sent.body).toContain('"order_amount":500.00,');
    expect(provider.orders.get(orderId)!.amount).toBe(500);
    provider.markPaid(orderId);
    expect(await wallet.confirmOrder(orderId)).toMatchObject({ status: "PAID", credited: true, credits: 500, amount: 500 });
    expect(await balance()).toBe(500);
  });

  it("a 500-rupee order is sent to Stripe as amount 50000 (paise)", async () => {
    const provider = stripeProvider();
    const wallet = createWallet(db, provider.gateway, { currency: "INR" });
    await wallet.openWallet(WS, 0);
    const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: OWNER, amount: 500 });
    expect(provider.sentAmounts).toEqual([50000]);
    provider.markPaid(orderId);
    expect(await wallet.confirmOrder(orderId)).toMatchObject({ status: "PAID", credited: true, credits: 500 });
  });

  it("a Cashfree order that reports 5.00 rupees for a 500-rupee order is refused", async () => {
    const provider = cashfreeProvider();
    const wallet = createWallet(db, provider.gateway, { currency: "INR" });
    await wallet.openWallet(WS, 0);
    const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: OWNER, amount: 500 });
    provider.setRaw(orderId, { status: "PAID", amount: 5 });
    expect(await wallet.confirmOrder(orderId)).toMatchObject({ status: "verification_mismatch", field: "amount" });
    expect(await balance()).toBe(0);
  });

  it("zero-decimal (JPY) and three-decimal (KWD) wallets convert exactly and are credited", async () => {
    for (const [currency, sentAmount] of [["JPY", "500"], ["KWD", "500.000"]] as const) {
      await reset();
      const provider = cashfreeProvider();
      const wallet = createWallet(db, provider.gateway, { currency });
      await wallet.openWallet(WS, 0);
      const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: OWNER, amount: 500 });
      expect(provider.requests.find((r) => r.method === "POST")!.body).toContain(`"order_amount":${sentAmount},`);
      provider.markPaid(orderId);
      expect(await wallet.confirmOrder(orderId)).toMatchObject({ status: "PAID", credited: true, credits: 500 });
    }
  });
});

describe("webhook edge cases (story 2.3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const appFor = (gateway: Parameters<typeof createWalletRoutes>[0]["gateway"]) => {
    const app = new Hono();
    app.route("/api", createWalletRoutes({ gateway, currency: "INR" }));
    return app;
  };
  const post = (app: Hono, body: string, headers: Headers | Record<string, string> = {}) =>
    app.fetch(new Request("http://localhost/api/payments/webhook", { method: "POST", headers, body }), { DB: db });

  it("a correctly signed event about no order is 200 ignored, not 401 (so the provider stops retrying)", async () => {
    const fake = createFakeGateway();
    const hook = await fake.signWebhook(null);
    const res = await post(appFor(fake), hook.body, hook.headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ignored", credited: false });
  });

  it("a signed non-payment Stripe event is 200 ignored", async () => {
    const provider = stripeProvider();
    const { hmacSha256, toHex } = await import("../src/webhook-signature.ts");
    const { NOW, STRIPE_WEBHOOK_SECRET } = await import("./support/providers.ts");
    const body = JSON.stringify({ id: "evt_x", type: "customer.created", data: { object: { id: "cus_1" } } });
    const t = String(Math.floor(NOW / 1000));
    const res = await post(appFor(provider.gateway), body, { "stripe-signature": `t=${t},v1=${toHex(await hmacSha256(STRIPE_WEBHOOK_SECRET, `${t}.${body}`))}` });
    expect(res.status).toBe(200);
  });

  it("a body over 64 KiB is 413 before any signature check, declared or not", async () => {
    const fake = createFakeGateway();
    const verify = vi.spyOn(fake, "verifyWebhook");
    expect((await post(appFor(fake), "x".repeat(64 * 1024 + 1))).status).toBe(413);
    expect((await post(appFor(fake), "{}", { "content-length": String(10 * 1024 * 1024) })).status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
  });

  it("a signed webhook for a wallet-format order the wallet never recorded is 200 ignored and logged at error level", async () => {
    const fake = createFakeGateway();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const hook = await fake.signWebhook("order_0123456789abcdef");
    const res = await post(appFor(fake), hook.body, hook.headers);
    expect(res.status).toBe(200);
    expect(logged.mock.calls.flat().join(" ")).toMatch(/unknown order \(order order_0123456789abcdef, provider ref ref_order_0123456789abcdef\)/);
  });

  it("a signed webhook for another brick's order (not the wallet's id format) is 200 ignored, with no error log", async () => {
    const fake = createFakeGateway();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const hook = await fake.signWebhook(`cs_${"a".repeat(32)}`);
    const res = await post(appFor(fake), hook.body, hook.headers);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ignored", credited: false });
    expect(logged).not.toHaveBeenCalled();
  });

  it("a paid order whose workspace has no wallet keeps the 404 and is logged at error level", async () => {
    const fake = createFakeGateway();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const wallet = createWallet(db, fake, { currency: "INR" });
    await wallet.openWallet(WS, 0);
    const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: OWNER, amount: 100 });
    fake.setOrder(orderId, { status: "PAID" });
    await db.prepare("DELETE FROM credit_wallets WHERE workspace_id = ?").bind(WS).run();
    const hook = await fake.signWebhook(orderId);
    expect((await post(appFor(fake), hook.body, hook.headers)).status).toBe(404);
    expect(logged.mock.calls.flat().join(" ")).toMatch(new RegExp(`cannot be credited.*order ${orderId}`));
  });

  it("an order stored without a provider reference says so when the provider cannot be asked", async () => {
    const provider = stripeProvider();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const wallet = createWallet(db, provider.gateway, { currency: "USD" });
    await wallet.openWallet(WS, 0);
    const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: OWNER, amount: 5 });
    await db.prepare("UPDATE credit_orders SET provider_ref = NULL WHERE order_id = ?").bind(orderId).run();
    expect(await wallet.confirmOrder(orderId)).toMatchObject({ status: "gateway_error" });
    expect(logged.mock.calls.flat().join(" ")).toMatch(new RegExp(`order has no provider reference.*order ${orderId}`));
  });

  it("an order the provider created but the wallet could not record is logged at error level with the provider reference", async () => {
    const fake = createFakeGateway();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await db.prepare("DROP TABLE credit_orders").run();
    await expect(createWallet(db, fake, { currency: "INR" }).createOrder({ workspaceId: WS, userId: OWNER, amount: 100 })).rejects.toThrow();
    expect(logged.mock.calls.flat().join(" ")).toMatch(/provider order created but not recorded \(order order_[0-9a-f]+, provider ref ref_order_/);
  });

  it("Stripe orders are fetched by the stored pi_ intent id, never by the wallet's order id", async () => {
    const provider = stripeProvider();
    const wallet = createWallet(db, provider.gateway, { currency: "USD" });
    await wallet.openWallet(WS, 0);
    const { orderId } = await wallet.createOrder({ workspaceId: WS, userId: OWNER, amount: 5 });
    const row = await db.prepare("SELECT provider_ref FROM credit_orders WHERE order_id = ?").bind(orderId).first<{ provider_ref: string }>();
    expect(row?.provider_ref).toMatch(/^pi_[0-9a-f]{24}$/);
    await expect(provider.gateway.fetchOrder(orderId, orderId)).rejects.toThrow(/HTTP 404/);
    provider.markPaid(orderId);
    expect(await wallet.confirmOrder(orderId)).toMatchObject({ status: "PAID", credited: true });
  });
});

describe("payment configuration", () => {
  const post = (app: Hono, path: string, body: unknown) =>
    app.fetch(new Request(`http://localhost/api${path}`, { method: "POST", headers: { "content-type": "application/json", "x-test-user": OWNER }, body: JSON.stringify(body) }), { DB: db });

  it("a gateway without a currency answers 503 NOT_CONFIGURED on every payment route", async () => {
    const app = new Hono();
    app.use("/api/*", stubIdentity);
    app.route("/api", createWalletRoutes({ gateway: fakeProvider().gateway }));
    for (const path of ["/payments/verify", "/payments/webhook"]) {
      const res = await post(app, path, { order_id: "order_x" });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "NOT_CONFIGURED" });
    }
  });

  it("an empty or lower-case currency is not a currency", async () => {
    for (const currency of ["", "inr", "RUPEE"]) {
      const app = new Hono();
      app.use("/api/*", stubIdentity);
      app.route("/api", createWalletRoutes({ gateway: fakeProvider().gateway, currency }));
      expect((await post(app, "/payments/webhook", {})).status).toBe(503);
    }
  });

  it("the wallet refuses to create or confirm an order without a currency", async () => {
    const provider = fakeProvider();
    const wallet = createWallet(db, provider.gateway);
    await wallet.openWallet(WS, 0);
    await expect(wallet.createOrder({ workspaceId: WS, userId: OWNER, amount: 100 })).rejects.toThrow(/NOT_CONFIGURED/);
    const { orderId } = await createWallet(db, provider.gateway, { currency: "INR" }).createOrder({ workspaceId: WS, userId: OWNER, amount: 100 });
    await provider.markPaid(orderId);
    await expect(wallet.confirmOrder(orderId)).rejects.toThrow(/NOT_CONFIGURED/);
    expect(await balance()).toBe(0);
  });

  it("a Stripe adapter without a webhook secret answers 503 on the webhook, never accepting it", async () => {
    const { createStripePaymentGateway } = await import("../src/stripe-payment-gateway.ts");
    const { stripeManifest } = await import("./support/stripe-manifest.ts");
    const gateway = createStripePaymentGateway({ manifest: stripeManifest, connection: { apiKey: "sk_test_x" }, fetcher: async () => new Response("{}") });
    const app = new Hono();
    app.use("/api/*", stubIdentity);
    app.route("/api", createWalletRoutes({ gateway, currency: "USD" }));
    expect((await post(app, "/payments/webhook", { type: "payment_intent.succeeded" })).status).toBe(503);
  });
});

describe("checkout-gateway through the Cashfree adapter: minor units pass straight through (story 2.3)", () => {
  it("a 12345-paise session is sent as order_amount 123.45, and the paid webhook issues the invoice", async () => {
    const { createCheckoutRoutes } = await import("@poc/checkout-gateway");
    const checkoutMigration = (await import("../../../bricks/checkout-gateway/migrations/0001_checkout_gateway.sql?raw")).default;
    const checkoutMigration0002 = (await import("../../../bricks/checkout-gateway/migrations/0002_verified_payments.sql?raw")).default;
    await db.prepare("DROP TABLE IF EXISTS pay_invoices").run();
    await db.prepare("DROP TABLE IF EXISTS pay_checkout_sessions").run();
    await applyMigration(db, checkoutMigration);
    await applyMigration(db, checkoutMigration0002);

    const provider = cashfreeProvider();
    const app = new Hono();
    // Test-only workspace context (the checkout routes read the verified ctx the workspace guard sets).
    app.use("/api/checkout/sessions", async (c, next) => {
      c.set("ctx" as never, Object.freeze({ userId: OWNER, workspaceId: WS, role: "owner" }) as never);
      await next();
    });
    app.route("/api", createCheckoutRoutes({ gateway: provider.gateway, currency: "INR" }) as never);
    const created = await app.fetch(
      new Request("http://localhost/api/checkout/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currency: "INR", lineItems: [{ description: "Plan", quantity: 1, unitAmountCents: 12345 }] }),
      }),
      { DB: db },
    );
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string; total_cents: number } };
    expect(session.total_cents).toBe(12345);
    expect(provider.requests.find((r) => r.method === "POST")!.body).toContain('"order_amount":123.45,');

    provider.markPaid(session.id);
    const hook = await provider.signedWebhook(session.id);
    const res = await app.fetch(new Request("http://localhost/api/checkout/webhook", { method: "POST", headers: hook.headers, body: hook.body }), { DB: db });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "PAID" });
    expect((await db.prepare("SELECT total_cents FROM pay_invoices WHERE session_id = ?").bind(session.id).first<{ total_cents: number }>())?.total_cents).toBe(12345);
  });
});
