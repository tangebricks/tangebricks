// A small Hono worker that mounts installed bricks on its own app, the way a project outside the monorepo would.
// Everything below comes from the project's own node_modules: no assembler, no Studio, no generated code.
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createWorkspaceRoutes, requireNotSuspended, workspaceMiddleware } from "@poc/multi-workspace";
import { createFakeGateway, createWalletRoutes } from "@poc/credit-wallet";
import { createAuditRoutes } from "@poc/audit-trail";
import { trafficArmorMiddleware } from "@poc/edge-traffic-armor";
import { createOidcMiddleware } from "@poc/oidc-verify";
import { createRbacRoutes } from "@poc/rbac-policy";
import { createPlatformAdminRoutes } from "@poc/platform-admin";
import { auditRecorder } from "@poc/audit-trail";
import { rateLimit } from "@poc/sdk";

// The project chooses where the bricks live. Every brick route is relative, so any prefix works. The manifests'
// guardPaths say /api (the assembler's prefix); here they are under /v1.
const PREFIX = "/v1";

/**
 * STUB IDENTITY, for this test fixture only. It trusts a plain `x-test-user` header, which a real project must never
 * do: a real project verifies its own session or JWT here and sets the same `user` variable ({ uid, email? }).
 */
const stubIdentity: MiddlewareHandler = async (c, next) => {
  const uid = c.req.header("x-test-user");
  if (uid) c.set("user", { id: uid, uid, email: `${uid}@example.test` });
  await next();
};

// The payment provider. A real project passes its own PaymentGateway; the fixture uses the brick's fake so the test
// can mark an order paid. It lives as long as the isolate, which is enough for one test run.
const gateway = createFakeGateway();

const app = new Hono();

// 1. Identity first, for every route.
app.use("*", stubIdentity);

// 2. The workspace guard on the workspace-scoped paths (each manifest's guardPaths). workspaceMiddleware resolves the
//    workspace from the x-workspace-id header and refuses non-members; requireNotSuspended then refuses a suspended
//    workspace (multi-workspace's manifest names it as the guard's `suspension`).
for (const path of ["/wallet", "/wallet/*", "/payments/create-order", "/audit", "/audit/*", "/roles", "/roles/*", "/policies", "/policies/*"]) {
  app.use(`${PREFIX}${path}`, workspaceMiddleware);
  app.use(`${PREFIX}${path}`, requireNotSuspended);
}

// 3. credit-wallet's manifest `rateLimits`, mounted with the SDK's limiter (it counts in the px_rate_limits table).
app.on("POST", `${PREFIX}/wallet/deduct`, rateLimit({ bucket: "wallet-deduct", limit: 60, windowSeconds: 60, key: "workspace" }));
app.on("POST", `${PREFIX}/wallet/charge`, rateLimit({ bucket: "wallet-charge", limit: 600, windowSeconds: 60, key: "workspace" }));
app.on("POST", `${PREFIX}/wallet/transfer`, rateLimit({ bucket: "wallet-transfer", limit: 30, windowSeconds: 60, key: "workspace" }));
app.on("POST", `${PREFIX}/payments/create-order`, rateLimit({ bucket: "wallet-create-order", limit: 60, windowSeconds: 60, key: "workspace" }));
app.on("POST", `${PREFIX}/payments/verify`, rateLimit({ bucket: "wallet-verify", limit: 60, windowSeconds: 60, key: "ip" }));
app.on("POST", `${PREFIX}/payments/webhook`, rateLimit({ bucket: "wallet-webhook", limit: 300, windowSeconds: 60, key: "ip" }));

// 4. edge-traffic-armor's middleware on one of the project's own paths: a named bucket counted per signed-in user (it
//    falls back to the IP for a request with no user). Past the limit it answers 429 and logs an incident in
//    arm_blocked_requests. IP rules are per workspace, and this path has none, so they are off.
//    The window is an hour so the test's few requests never straddle a window boundary.
app.use(`${PREFIX}/ping`, trafficArmorMiddleware({ enforceIpRules: false, rateLimit: { bucket: "fixture-ping", limit: 2, windowSeconds: 3600, key: "user" } }));
app.get(`${PREFIX}/ping`, (c) => c.json({ ok: true }));

// 5. The bricks' route factories, mounted under the project's prefix. platform-admin sits outside the workspace guard
//    (operators act across workspaces) and writes its audit rows through audit-trail's recorder.
app.route(PREFIX, createWorkspaceRoutes());
app.route(PREFIX, createWalletRoutes({ gateway, currency: "INR", creditsPerUnit: 10 }));
app.route(PREFIX, createAuditRoutes());
app.route(PREFIX, createRbacRoutes());
app.route(PREFIX, createPlatformAdminRoutes({ auditRecorder }));

// 6. oidc-verify on its own path, the way a project with a real identity provider mounts it in place of the stub: HS256
//    with the secret from the OIDC_HS256_SECRET binding, the email copied from the token's `email` claim.
const oidc = new Hono();
oidc.use("*", createOidcMiddleware({ issuer: "https://idp.external-app.test", audience: "external-app", algorithms: ["HS256"], hs256SecretName: "OIDC_HS256_SECRET" }));
oidc.get("/me", (c) => {
  const user = c.get("user" as never) as { uid?: string; email?: string } | undefined;
  return user ? c.json({ uid: user.uid, email: user.email ?? null }) : c.json({ error: "Unauthorized" }, 401);
});
app.route("/oidc", oidc);

// Test-only: plays the payment provider's part by marking an order paid. A real project has no such route.
app.post("/__test__/gateway/orders/:orderId/paid", async (c) => {
  // The fake keeps the order's own amount, currency and customer, so the wallet's verification checks pass.
  gateway.setOrder(c.req.param("orderId"), { status: "PAID" });
  return c.json({ ok: true });
});

export default app;
