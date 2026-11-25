import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { workspaceMiddleware } from "@poc/multi-workspace";
import type { WorkspaceEnv } from "@poc/multi-workspace";
import { applyMigration } from "@poc/sdk";
import mwMigration from "../../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import { stubIdentity } from "../../../multi-workspace/test/support/stub-identity.ts";
import walletMigration from "../../migrations/0001_credit_wallet.sql?raw";
import walletMigration0002 from "../../migrations/0002_workspace_scoped_idempotency.sql?raw";
import walletMigration0003 from "../../migrations/0003_order_currency.sql?raw";
import walletMigration0004 from "../../migrations/0004_milli_credits.sql?raw";
import { createFakeGateway, createWallet, createWalletRoutes } from "../../src/index.ts";
import { CreditWidget } from "../CreditWidget.tsx";
import { createWalletClient } from "../wallet-client.ts";
import type { WalletClient } from "../wallet-client.ts";
import { createSqliteD1 } from "./support/sqlite-d1.ts";

// The widget mounted against the brick's own routes: real migrations, real SQL, the real workspace middleware and
// wallet routes, reached through the brick's own client. Only the network and the database engine are stand-ins.

const db = createSqliteD1();
const wallet = createWallet(db, createFakeGateway());

const app = new Hono<WorkspaceEnv>();
app.use("/api/*", stubIdentity);
app.use("/api/wallet", workspaceMiddleware);
app.use("/api/wallet/*", workspaceMiddleware);
app.route("/api", createWalletRoutes({ gateway: createFakeGateway() }));

/** A client whose fetch goes straight into the app above, and remembers what it was asked. */
function clientFor(workspaceId: string, user = "alice", override?: (input: string, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = createWalletClient({
    baseUrl: "http://app.test/api/",
    workspaceId,
    headers: { "x-test-user": user },
    fetch:
      override ??
      (async (input, init) => {
        calls.push({ url: input, headers: { ...(init?.headers as Record<string, string>) } });
        return app.fetch(new Request(input, init), { DB: db });
      }),
  });
  return { client, calls };
}

beforeEach(async () => {
  for (const table of ["credit_ledger", "credit_orders", "credit_wallets", "credit_action_costs", "mw_members", "mw_workspaces"]) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await applyMigration(db, mwMigration);
  await applyMigration(db, walletMigration);
  await applyMigration(db, walletMigration0002);
  await applyMigration(db, walletMigration0003);
  await applyMigration(db, walletMigration0004);
  for (const [id, user] of [["ws-a", "alice"], ["ws-b", "bob"]] as const) {
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, ?)").bind(id, id, user).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, user).run();
  }
  await wallet.openWallet("ws-a", 1_000_000);
  await wallet.openWallet("ws-b", 42_000);
});
afterEach(() => cleanup());

const mount = (client: WalletClient) => render(<CreditWidget client={client} />);
const balanceText = () => screen.findByTestId("balance").then((el) => el.textContent);

describe("the credit widget against the brick's own routes", () => {
  test("shows the workspace's live balance", async () => {
    mount(clientFor("ws-a").client);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    expect(await balanceText()).toBe("1,000");
    expect(screen.getByText(/credits/).textContent).toContain("Balance:");
  });

  test("the balance is what the database holds, not a constant: another workspace shows its own", async () => {
    mount(clientFor("ws-b", "bob").client);
    expect(await balanceText()).toBe("42");
  });

  test("story 2.5: fractional credits are shown exactly, to the thousandth", async () => {
    await wallet.deduct({ workspaceId: "ws-a", userId: "alice", amountMilli: 200, reason: "email" });
    await wallet.deduct({ workspaceId: "ws-a", userId: "alice", amountMilli: 1_001, reason: "message" });
    mount(clientFor("ws-a").client);
    expect(await balanceText()).toBe("998.799");
    const items = (await screen.findAllByRole("listitem")).map((li) => li.textContent);
    expect(items).toEqual(["message: -1.001 (balance 998.799)", "email: -0.2 (balance 999.8)"]);
  });

  test("lists recent transactions, newest first, with the amount and the balance after", async () => {
    await wallet.deduct({ workspaceId: "ws-a", userId: "alice", amountMilli: 250_000, reason: "report export" });
    await wallet.deduct({ workspaceId: "ws-a", userId: "alice", amountMilli: 100_000, reason: "email send" });
    mount(clientFor("ws-a").client);
    expect(await balanceText()).toBe("650");
    const items = (await screen.findAllByRole("listitem")).map((li) => li.textContent);
    expect(items).toEqual(["email send: -100 (balance 650)", "report export: -250 (balance 750)"]);
  });

  test("an empty ledger says so", async () => {
    mount(clientFor("ws-a").client);
    await balanceText();
    expect(screen.getByText("No transactions yet.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  test("shows only the most recent entries up to its limit", async () => {
    for (let i = 1; i <= 8; i += 1) await wallet.deduct({ workspaceId: "ws-a", userId: "alice", amountMilli: 1_000, reason: `job ${i}` });
    mount(clientFor("ws-a").client);
    await balanceText();
    expect((await screen.findAllByRole("listitem")).map((li) => li.textContent?.split(":")[0])).toEqual(["job 8", "job 7", "job 6", "job 5", "job 4"]);
  });

  test("Refresh picks up a change made after the widget loaded", async () => {
    mount(clientFor("ws-a").client);
    expect(await balanceText()).toBe("1,000");
    await wallet.deduct({ workspaceId: "ws-a", userId: "alice", amountMilli: 400_000, reason: "late job" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByTestId("balance").textContent).toBe("600"));
  });

  test("asks the brick's own routes, naming the workspace and passing the host's headers", async () => {
    const { client, calls } = clientFor("ws-a");
    mount(client);
    await balanceText();
    expect(calls.map((c) => c.url).sort()).toEqual(["http://app.test/api/wallet", "http://app.test/api/wallet/history"]);
    for (const call of calls) {
      expect(call.headers["x-workspace-id"]).toBe("ws-a");
      expect(call.headers["x-test-user"]).toBe("alice");
    }
  });
});

describe("when something goes wrong", () => {
  test("a workspace the user does not belong to shows the server's refusal and no balance, never another tenant's", async () => {
    mount(clientFor("ws-b", "alice").client); // alice asks for bob's workspace
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Not a member of this workspace");
    expect(screen.queryByTestId("balance")).toBeNull();
    expect(document.body.textContent).not.toContain("42");
  });

  test("an unauthenticated user sees the refusal, and Try again recovers once they are allowed in", async () => {
    let user = "";
    // Replaces the client's headers entirely, so that "no identity" really means no identity header is sent.
    const { client } = clientFor("ws-a", "alice", async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("x-test-user");
      if (user) headers.set("x-test-user", user);
      return app.fetch(new Request(input, { ...init, headers }), { DB: db });
    });
    mount(client);
    expect((await screen.findByRole("alert")).textContent).toContain("Unauthorized");
    user = "alice";
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await balanceText()).toBe("1,000");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a server that cannot be reached says so", async () => {
    mount(clientFor("ws-a", "alice", () => Promise.reject(new TypeError("fetch failed"))).client);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the server");
  });

  test("an answer that is not JSON, or not the shape the client expects, is reported and not rendered", async () => {
    mount(clientFor("ws-a", "alice", async () => new Response("<html>oops</html>", { status: 200 })).client);
    expect((await screen.findByRole("alert")).textContent).toContain("The server's answer was not understood");
    cleanup();
    mount(clientFor("ws-a", "alice", async () => Response.json({ currentBalance: "lots", ledgers: [] })).client);
    expect((await screen.findByRole("alert")).textContent).toContain("The server's answer was not understood");
    expect(screen.queryByTestId("balance")).toBeNull();
  });

  test("a failing server shows its error message, and a server error without one shows the status", async () => {
    mount(clientFor("ws-a", "alice", async () => Response.json({ error: "Failed to fetch wallet balance" }, { status: 500 })).client);
    expect((await screen.findByRole("alert")).textContent).toContain("Failed to fetch wallet balance");
    cleanup();
    mount(clientFor("ws-a", "alice", async () => Response.json({}, { status: 503 })).client);
    expect((await screen.findByRole("alert")).textContent).toContain("Request failed (503)");
  });
});

describe("what the server sends is shown as text", () => {
  test("a ledger description containing markup is rendered as text, not as elements", async () => {
    const hostile = '<img src=x onerror="document.title=\'pwned\'"><script>document.title="pwned"</script>';
    await wallet.deduct({ workspaceId: "ws-a", userId: "alice", amountMilli: 5_000, reason: hostile });
    const { container } = mount(clientFor("ws-a").client);
    await balanceText();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("listitem").textContent).toContain(hostile);
    expect(document.title).not.toBe("pwned");
  });
});
