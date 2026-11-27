import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { assemble, hashFiles } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";
import { TWO_BRICK_BLUEPRINT } from "../../../test/support/blueprints.ts";

// The emitted project is written to out/two-brick/ by test/support/global-setup.ts (Node, before any test starts).
// A workerd test has no file system, so it imports what is already there, like any other module.
const entry = import.meta.glob("../../../out/two-brick/src/index.ts", { eager: true }) as Record<string, { default: App }>;
const emittedText = import.meta.glob("../../../out/two-brick/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const emittedSql = import.meta.glob("../../../out/two-brick/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

interface App {
  fetch(request: Request, env: unknown): Response | Promise<Response>;
}
const app = Object.values(entry)[0]?.default;
const db = env.DB as D1Like;
const PREFIX = "../../../out/two-brick/";
const emittedFiles = Object.fromEntries(Object.entries(emittedText).map(([path, text]) => [path.slice(PREFIX.length), text]));

const call = async (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) => {
  const response = await app!.fetch(
    new Request(`http://localhost${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }),
    { DB: db },
  );
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, any> | null };
};

/** Applies the emitted migrations, in the order the project's own file names give, to an empty database. */
async function freshDatabase(): Promise<void> {
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets", "mw_invites", "mw_members", "mw_workspaces"])
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const path of Object.keys(emittedSql).sort()) await applyMigration(db, emittedSql[path]!);
}

describe("the project the setup step wrote", () => {
  test("is there, and is the whole project", () => {
    expect(app, "the setup step should have written out/two-brick/src/index.ts").toBeDefined();
    expect(typeof app!.fetch).toBe("function");
    expect(Object.keys(emittedFiles).sort()).toEqual([
      "migrations/0001_multi-workspace__0001_multi_workspace.sql",
      "migrations/0002_multi-workspace__0002_invite_email_expiry.sql", // story 2.8: invite email and expiry
      "migrations/0003_credit-wallet__0001_credit_wallet.sql",
      "migrations/0004_credit-wallet__0002_workspace_scoped_idempotency.sql",
      "migrations/0005_credit-wallet__0003_order_currency.sql", // story 2.3: credit-wallet's order currency
      "migrations/0006_credit-wallet__0004_milli_credits.sql", // story 2.5: credit-wallet's milli-credits
      "migrations/0007_shell__px_rate_limits.sql", // story 0.21: credit-wallet declares rate limits
      "openapi.json",
      "package.json",
      "project.json",
      "src/identity.stub.ts",
      "src/index.ts",
      "src/privacy.generated.ts",
      "wrangler.jsonc",
    ]);
  });

  test("is byte-identical to what the assembler produces here in workerd (Node and workerd agree)", async () => {
    const result = assemble(TWO_BRICK_BLUEPRINT, catalog);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(emittedFiles).toEqual(result.files);
    expect(await hashFiles(emittedFiles)).toEqual(await hashFiles(result.files));
  });
});

describe("the emitted project runs", () => {
  beforeEach(freshDatabase);

  // Story 2.3: the provider calls the payment webhook with no user and no workspace. In the assembled app it must reach
  // the brick (which answers 503 NOT_CONFIGURED, since no gateway is wired), not be stopped by a guard's 400/401/403.
  test("POST /api/payments/webhook with no user and no workspace reaches the brick: 503 NOT_CONFIGURED", async () => {
    const res = await call("/api/payments/webhook", { "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ data: {} }) });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "NOT_CONFIGURED" });
  });

  test("the emitted migrations apply, in order, to an empty database", async () => {
    const tables = (
      await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%' ORDER BY name")
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["credit_ledger", "credit_orders", "credit_wallets", "mw_members", "mw_workspaces"]));
  });

  test("a signed-in user creates a workspace and reads its wallet through the emitted Worker: 200", async () => {
    const created = await call(
      "/api/workspaces",
      { "x-test-user": "alice", "content-type": "application/json" },
      { method: "POST", body: JSON.stringify({ name: "Acme" }) },
    );
    expect(created.status).toBe(201);
    const workspaceId = created.body!.workspace.id as string;

    const wallet = await call("/api/wallet", { "x-test-user": "alice", "x-workspace-id": workspaceId });
    expect(wallet.status).toBe(200);
    expect(wallet.body).toEqual({ currentBalance: 0, currentBalanceMilli: 0, creditsPerUnit: 1, minOrderAmount: 1 });
  });

  test("the wallet shows what the database holds", async () => {
    const created = await call(
      "/api/workspaces",
      { "x-test-user": "alice", "content-type": "application/json" },
      { method: "POST", body: JSON.stringify({ name: "Acme" }) },
    );
    const workspaceId = created.body!.workspace.id as string;
    await call("/api/wallet", { "x-test-user": "alice", "x-workspace-id": workspaceId }); // opens the wallet
    await db.prepare("UPDATE credit_wallets SET balance_milli = 77000 WHERE workspace_id = ?").bind(workspaceId).run();
    expect((await call("/api/wallet", { "x-test-user": "alice", "x-workspace-id": workspaceId })).body!.currentBalance).toBe(77);
  });

  test("the workspace brick's list route is mounted and scoped to the caller", async () => {
    await call(
      "/api/workspaces",
      { "x-test-user": "alice", "content-type": "application/json" },
      { method: "POST", body: JSON.stringify({ name: "Alice's" }) },
    );
    await call("/api/workspaces", { "x-test-user": "bob", "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ name: "Bob's" }) });
    const list = await call("/api/workspaces", { "x-test-user": "alice" });
    expect(list.body!.workspaces.map((w: { name: string }) => w.name)).toEqual(["Alice's"]);
  });

  test("the wiring refuses what it should: no identity 401, no workspace 400, not a member 403", async () => {
    const created = await call(
      "/api/workspaces",
      { "x-test-user": "alice", "content-type": "application/json" },
      { method: "POST", body: JSON.stringify({ name: "Acme" }) },
    );
    const workspaceId = created.body!.workspace.id as string;
    expect((await call("/api/wallet", { "x-workspace-id": workspaceId })).status).toBe(401);
    expect((await call("/api/wallet", { "x-test-user": "alice" })).status).toBe(400);
    expect((await call("/api/wallet", { "x-test-user": "bob", "x-workspace-id": workspaceId })).status).toBe(403);
    expect((await call("/api/wallet/history", { "x-test-user": "bob", "x-workspace-id": workspaceId })).status).toBe(403);
    expect(
      (
        await call(
          "/api/payments/create-order",
          { "x-test-user": "bob", "x-workspace-id": workspaceId, "content-type": "application/json" },
          { method: "POST", body: JSON.stringify({ amount: 100 }) },
        )
      ).status,
    ).toBe(403);
  });

  test("a route the project does not have is a 404, not an error", async () => {
    expect((await call("/api/nothing-here", { "x-test-user": "alice" })).status).toBe(404);
  });
});
