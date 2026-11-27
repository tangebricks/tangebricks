import { runBrickConformance } from "@poc/harness/conformance";
import { Hono } from "hono";
import { createWalletRoutes, createFakeGateway, type WalletEnv } from "../src/index.ts";

const app = new Hono<WalletEnv>();
app.use("*", async (c, next) => {
  const ws = c.req.header("x-workspace-id");
  if (ws && !c.get("workspace")) {
    c.set("workspace", { id: ws, role: "owner", suspended: false });
  }
  if (!c.get("user")) {
    c.set("user", { uid: "usr_conf_test" });
  }
  await next();
});
app.route("/", createWalletRoutes({ gateway: createFakeGateway(), currency: "INR" }));

runBrickConformance({
  brickDir: "bricks/credit-wallet",
  app,
  seed: async (db, { workspaceA, workspaceB }) => {
    await db.prepare("INSERT OR IGNORE INTO credit_wallets (workspace_id, balance_milli) VALUES (?, 1000000)").bind(workspaceA).run();
    // A different balance from A's, so the kit can tell B's own wallet from a leak of A's.
    await db.prepare("INSERT OR IGNORE INTO credit_wallets (workspace_id, balance_milli) VALUES (?, 500000)").bind(workspaceB).run();
    // One ledger row for A only, so A's history is not the same (empty) list B gets for its own workspace.
    await db
      .prepare(
        "INSERT OR IGNORE INTO credit_ledger (id, workspace_id, user_id, type, amount_milli, balance_after_milli, reason) VALUES ('led_conf_a', ?, 'usr_conf_test', 'topup', 1000000, 1000000, 'seed A')",
      )
      .bind(workspaceA)
      .run();
  },
  testRequests: [
    {
      method: "GET",
      path: "/wallet?workspaceId=ws_conf_alpha",
    },
    {
      method: "GET",
      path: "/wallet/history?workspaceId=ws_conf_alpha",
    },
  ],
  writeRequests: [
    {
      method: "POST",
      path: "/wallet/deduct",
      body: { amount: 10, reason: "conformance deduction" },
    },
  ],
  skip: {
    CONF_ERROR_CONTRACT: "Credit wallet preserves legacy cephlow error format verified by H5.payment-routes.test.ts",
  },
});
