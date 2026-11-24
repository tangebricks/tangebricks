import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { assemble, hashFiles, sha256Hex } from "../packages/assembler/src/index.ts";
import { catalog } from "../packages/assembler/catalog.generated.ts";
import { computeMaxCompatible } from "../scripts/max-compatible.ts";
import aiCreditsBlueprint from "../presets/ai-credits-saas.blueprint.json" with { type: "json" };
import b2bBlueprint from "../presets/b2b-workspace-app.blueprint.json" with { type: "json" };
import marketplaceBlueprint from "../presets/marketplace.blueprint.json" with { type: "json" };
import stripeDiscordOpsBlueprint from "../presets/stripe-discord-ops.blueprint.json" with { type: "json" };

type WorkerApp = { fetch(request: Request, env: unknown): Response | Promise<Response> };

const emittedEntries = import.meta.glob("../out/*/src/index.ts", { eager: true }) as Record<string, { default: WorkerApp }>;
const getApp = (project: string): WorkerApp => {
  const mod = emittedEntries[`../out/${project}/src/index.ts`];
  if (!mod?.default) throw new Error(`missing emitted worker entry for ${project}`);
  return mod.default;
};

interface BootTarget {
  name: string;
  blueprint: {
    project: string;
    identity?: string;
    bricks: Array<string | { id: string; config?: Record<string, unknown> }>;
    entities?: Array<{ name: string; fields: Array<Record<string, unknown>> }>;
  };
}

const maxSet = computeMaxCompatible(catalog);
const maxCompatibleBlueprint: BootTarget["blueprint"] = {
  project: maxSet.project,
  bricks: maxSet.bricks,
  entities: [
    {
      name: "records",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "amount", type: "number" },
      ],
    },
  ],
};

export const BOOT_TARGETS: BootTarget[] = [
  { name: "ai-credits-saas", blueprint: aiCreditsBlueprint },
  { name: "b2b-workspace-app", blueprint: b2bBlueprint },
  { name: "marketplace", blueprint: marketplaceBlueprint },
  { name: "stripe-discord-ops", blueprint: stripeDiscordOpsBlueprint },
  { name: "max-compatible", blueprint: maxCompatibleBlueprint },
];

const db = env.DB as unknown as D1Like;

async function resetAndMigrate(migrations: Array<[string, string]>): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts_%'",
      )
      .all<{ name: string }>();
    if (tables.results.length === 0) break;
    for (const row of [...tables.results].reverse()) {
      try {
        await db.prepare(`DROP TABLE IF EXISTS "${row.name}"`).run();
      } catch {
        // Dependent parent table; dropped on next pass after child tables are dropped.
      }
    }
  }
  for (const [, sql] of migrations) {
    await applyMigration(db, sql);
  }
}

async function computeBuildHash(files: Record<string, string>): Promise<string> {
  const fileHashes = await hashFiles(files);
  return sha256Hex(JSON.stringify(fileHashes));
}

/**
 * `notConfigured`: the route deliberately answers 503 NOT_CONFIGURED in an assembled app with no provider
 * configured (story 0.9: no fake success), so the probe checks that explicit refusal instead of < 500.
 */
const AUTH_ROUTE_BY_PREFIX: Record<string, { method?: string; path: string; body?: unknown; notConfigured?: boolean }> = {
  admin: { path: "/api/admin/impersonations" },
  mcp: { path: "/api/mcp/tools" },
  audit: { path: "/api/audit/events" },
  assets: { path: "/api/assets" },
  checkout: { method: "POST", path: "/api/checkout/sessions", body: { amountCents: 500, currency: "usd", mode: "payment" } },
  auth: { path: "/api/auth/me" },
  wallet: { path: "/api/wallet" },
  payments: { method: "POST", path: "/api/payments/create-order", body: { amount: 100 }, notConfigured: true },
  schedules: { path: "/api/schedules" },
  domains: { path: "/api/domains" },
  privacy: { path: "/api/privacy/consents?subjectId=alice" },
  docs: { path: "/api/docs" },
  documents: { path: "/api/documents/templates" },
  armor: { path: "/api/armor/rules" },
  flags: { path: "/api/flags" },
  sso: { path: "/api/sso/discover?email=alice@example.com" },
  notifications: { path: "/api/notifications" },
  chat: { path: "/api/chat/conversations" },
  ai: { path: "/api/ai/templates" },
  marketplace: { path: "/api/marketplace/payouts" },
  meters: { path: "/api/meters" },
  events: { method: "POST", path: "/api/events", body: { meterSlug: "tokens", quantity: 1 } },
  usage: { path: "/api/usage?meterSlug=tokens" },
  workspaces: { path: "/api/workspaces" },
  oauth: { path: "/api/oauth/clients" },
  messages: { path: "/api/messages/history" },
  subscriptions: { path: "/api/subscriptions/webhooks" },
  plans: { path: "/api/plans" },
  analytics: { path: "/api/analytics/counts?eventName=page_view" },
  "api-keys": { path: "/api/api-keys" },
  jobs: { path: "/api/jobs" },
  roles: { path: "/api/roles" },
  policies: { path: "/api/policies/check?permission=read" },
  presence: { path: "/api/presence/rooms/general" },
  scripts: { path: "/api/scripts" },
  search: { path: "/api/search/typeahead?prefix=te" },
  tabular: { path: "/api/tabular/views" },
  threads: { path: "/api/threads?targetType=doc&targetId=1" },
  onboarding: { path: "/api/onboarding/flows" },
  me: { path: "/api/me/profile" },
  users: { path: "/api/users/alice/profile" },
  vectors: { path: "/api/vectors/indexes" },
  webhooks: { path: "/api/webhooks/endpoints" },
  workflows: { path: "/api/workflows" },
  runs: { path: "/api/runs/nonexistent-run" },
  integrations: { path: "/api/integrations" },
  connect: { path: "/api/connect/google", notConfigured: true },
};

function getUnauthenticatedProbe(brickId: string, entityName?: string): { method: string; path: string } {
  const manifest = catalog.bricks[brickId]!.manifest;
  const route = manifest.worker.routes[0];
  if (route && route.guardPaths.length > 0) {
    const rawPath = route.guardPaths[0]!;
    const expanded = rawPath.includes("{entity}") ? rawPath.replaceAll("{entity}", entityName ?? "records") : rawPath;
    const cleanPath = expanded.endsWith("/*") ? expanded.slice(0, -2) : expanded;
    return { method: "GET", path: cleanPath };
  }
  switch (brickId) {
    case "multi-workspace":
      return { method: "GET", path: "/api/workspaces" };
    case "core-auth":
      return { method: "GET", path: "/api/auth/me" };
    case "identity-federation":
      return { method: "POST", path: "/api/sso/scim/v2/Users" };
    case "in-app-notifications":
      return { method: "GET", path: "/api/notifications" };
    case "user-profile":
      return { method: "GET", path: "/api/me/profile" };
    default:
      return { method: "GET", path: `/api/${manifest.routePrefixes[0] ?? brickId}` };
  }
}

async function sendRequest(
  app: WorkerApp,
  path: string,
  options: {
    method?: string;
    user?: string;
    token?: string;
    workspaceId?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  } else if (options.user) {
    headers.set("x-test-user", options.user);
  }
  if (options.workspaceId) headers.set("x-workspace-id", options.workspaceId);
  let bodyText: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    bodyText = JSON.stringify(options.body);
  }
  return app.fetch(
    new Request(`https://example.test${path}`, {
      method: options.method ?? (bodyText !== undefined ? "POST" : "GET"),
      headers,
      body: bodyText,
    }),
    env,
  );
}

describe.each(BOOT_TARGETS)("preset boot in workerd: $name", ({ name, blueprint }) => {
  test("assembles deterministically, migrates D1, serves all brick routes (<500), enforces guards (401/403), and isolates workspaces (404/403)", async () => {
    const app = getApp(blueprint.project);
    // 1. Assemble twice; buildHash values are equal.
    const first = assemble(blueprint, catalog);
    const second = assemble(blueprint, catalog);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("blueprint failed to assemble");

    const buildHash1 = await computeBuildHash(first.files);
    const buildHash2 = await computeBuildHash(second.files);
    expect(buildHash1).toBe(buildHash2);
    expect(buildHash1).toMatch(/^[0-9a-f]{64}$/);

    // Only production-tier bricks remain in the 3 presets (Story 0.9 AC 6)
    if (name !== "max-compatible") {
      for (const brickId of first.order) {
        expect(
          ["production", "beta"],
          `${name} preset brick ${brickId} must be production or beta tier`,
        ).toContain(catalog.bricks[brickId]!.manifest.ui?.maturity);
      }
    }

    // 2 & 3. Apply all migrations to a fresh D1 database.
    const migrations = Object.entries(first.files)
      .filter(([filePath]) => filePath.startsWith("migrations/"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    expect(migrations.length).toBeGreaterThan(0);
    await resetAndMigrate(migrations);

    const usesRealAuth = (blueprint.identity ?? "stub") !== "stub";
    const tokenByUser: Record<string, string> = {};

    if (usesRealAuth) {
      // Sign up Alice via Better Auth, then sign in to get a fresh session token
      const signUpAlice = await sendRequest(app, "/api/auth/sign-up/email", {
        method: "POST",
        body: { email: "alice@example.com", password: "alice-password-1234", name: "Alice" },
      });
      expect(signUpAlice.status).toBe(200);

      const signInAlice = await sendRequest(app, "/api/auth/sign-in/email", {
        method: "POST",
        body: { email: "alice@example.com", password: "alice-password-1234" },
      });
      expect(signInAlice.status).toBe(200);
      tokenByUser.alice = ((await signInAlice.json()) as { token: string }).token;

      // Sign up Bob via Better Auth
      const signUpBob = await sendRequest(app, "/api/auth/sign-up/email", {
        method: "POST",
        body: { email: "bob@example.com", password: "bob-password-1234", name: "Bob" },
      });
      expect(signUpBob.status).toBe(200);
      tokenByUser.bob = ((await signUpBob.json()) as { token: string }).token;

      // Forged session token returns 401
      const forgedRes = await sendRequest(app, "/api/workspaces", {
        method: "GET",
        token: "forged-token-that-does-not-exist",
      });
      expect(forgedRes.status).toBe(401);

      // Expired session in D1 returns 401
      const signUpCarol = await sendRequest(app, "/api/auth/sign-up/email", {
        method: "POST",
        body: { email: "carol@example.com", password: "carol-password-1234", name: "Carol" },
      });
      expect(signUpCarol.status).toBe(200);
      const carolToken = ((await signUpCarol.json()) as { token: string }).token;
      // Story 0.14: the session row holds sha256(token), not the token.
      const backdated = await db
        .prepare('UPDATE "session" SET "expiresAt" = ? WHERE "token" = ?')
        .bind("2000-01-01T00:00:00.000Z", await sha256Hex(carolToken))
        .run();
      expect(backdated.meta.changes).toBe(1);
      const expiredRes = await sendRequest(app, "/api/workspaces", {
        method: "GET",
        token: carolToken,
      });
      expect(expiredRes.status).toBe(401);

      // Story 0.14: the generated entry mounts the CSRF guard on /api. A cookie-authenticated write from another
      // origin is refused and creates nothing; the same write from the app's own origin goes through.
      const signInCookie = await sendRequest(app, "/api/auth/sign-in/email", {
        method: "POST",
        body: { email: "alice@example.com", password: "alice-password-1234" },
      });
      expect(signInCookie.status).toBe(200);
      const aliceCookie = (signInCookie.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      expect(aliceCookie).toContain("better-auth.session_token=");
      const workspacesBefore = await db.prepare("SELECT COUNT(*) AS n FROM mw_workspaces").first<{ n: number }>();
      const crossSite = await sendRequest(app, "/api/workspaces", {
        method: "POST",
        headers: { cookie: aliceCookie, origin: "https://evil.example" },
        body: { name: "Forged Workspace" },
      });
      expect(crossSite.status).toBe(403);
      expect(((await crossSite.json()) as { error: { code: string } }).error.code).toBe("CSRF_ORIGIN_MISMATCH");
      const workspacesAfter = await db.prepare("SELECT COUNT(*) AS n FROM mw_workspaces").first<{ n: number }>();
      expect(workspacesAfter?.n).toBe(workspacesBefore?.n);
      const sameOrigin = await sendRequest(app, "/api/workspaces", {
        method: "POST",
        headers: { cookie: aliceCookie, origin: "https://example.test" },
        body: { name: "Same Origin Workspace" },
      });
      expect(sameOrigin.status).toBe(201);
    }

    const authOpts = (user: "alice" | "bob") =>
      usesRealAuth ? { token: tokenByUser[user] } : { user };

    // Seed workspace A (alice) and workspace B (bob).
    const createWsA = await sendRequest(app, "/api/workspaces", {
      method: "POST",
      ...authOpts("alice"),
      body: { name: `${name}-ws-a` },
    });
    expect(createWsA.status).toBe(201);
    const wsA = ((await createWsA.json()) as { workspace: { id: string } }).workspace.id;

    const createWsB = await sendRequest(app, "/api/workspaces", {
      method: "POST",
      ...authOpts("bob"),
      body: { name: `${name}-ws-b` },
    });
    expect(createWsB.status).toBe(201);
    const wsB = ((await createWsB.json()) as { workspace: { id: string } }).workspace.id;

    const entityName = blueprint.entities?.[0]?.name;

    // 4. Per enabled brick: one authenticated request to each route prefix (< 500)
    // and one unauthenticated request to a guarded path (401 or 403).
    for (const brickId of first.order) {
      const manifest = catalog.bricks[brickId]!.manifest;
      const prefixes = manifest.routePrefixes.length > 0 ? manifest.routePrefixes : entityName ? [entityName] : [];

      for (const prefix of prefixes) {
        const probe: { method?: string; path: string; body?: unknown; notConfigured?: boolean } =
          brickId === "subscription-plans" && prefix === "subscriptions"
            ? { path: "/api/subscriptions/current" }
            : AUTH_ROUTE_BY_PREFIX[prefix] ?? { path: `/api/${prefix}` };
        const authRes = await sendRequest(app, probe.path, {
          method: probe.method,
          ...authOpts("alice"),
          workspaceId: wsA,
          body: probe.body,
        });
        if (probe.notConfigured) {
          // No provider is configured here (OAuth client id, payment gateway): an explicit NOT_CONFIGURED, never a fake success.
          expect(authRes.status, `${name} -> ${brickId} authenticated ${probe.path}`).toBe(503);
          const refusal = (await authRes.json()) as { code?: string; error?: { code?: string } | string };
          expect(refusal.code ?? (typeof refusal.error === "object" ? refusal.error?.code : undefined)).toBe("NOT_CONFIGURED");
        } else {
          expect(authRes.status, `${name} -> ${brickId} authenticated ${probe.path}`).toBeLessThan(500);
        }
      }

      const unauthProbe = getUnauthenticatedProbe(brickId, entityName);
      const unauthRes = await sendRequest(app, unauthProbe.path, { method: unauthProbe.method });
      expect([401, 403], `${name} -> ${brickId} unauthenticated ${unauthProbe.path} returned ${unauthRes.status}`).toContain(
        unauthRes.status,
      );
    }

    // 5. Cross-workspace isolation smoke test: workspace A creates a record through a tenant-scoped brick;
    // workspace B's request for it returns 404 or 403.
    if (first.order.includes("dynamic-entities") && entityName) {
      const payload =
        entityName === "listings"
          ? { title: "Alpha Listing", price_cents: 2500 }
          : entityName === "records"
            ? { title: "Alpha Record", amount: 42 }
            : { title: "Alpha Project", status: "active" };

      const createRes = await sendRequest(app, `/api/${entityName}`, {
        method: "POST",
        ...authOpts("alice"),
        workspaceId: wsA,
        body: payload,
      });
      expect(createRes.status).toBe(201);
      const createdId = ((await createRes.json()) as { item: { id: string } }).item.id;

      // Workspace B requests workspace A's record under its own workspace -> 404
      const crossReadB = await sendRequest(app, `/api/${entityName}/${createdId}`, {
        method: "GET",
        ...authOpts("bob"),
        workspaceId: wsB,
      });
      expect([403, 404]).toContain(crossReadB.status);

      // Workspace B attempts to spoof Workspace A's header -> 403
      const crossSpoofB = await sendRequest(app, `/api/${entityName}/${createdId}`, {
        method: "GET",
        ...authOpts("bob"),
        workspaceId: wsA,
      });
      expect([403, 404]).toContain(crossSpoofB.status);

      // Workspace B attempts to write into Workspace A -> 403
      const crossWriteB = await sendRequest(app, `/api/${entityName}`, {
        method: "POST",
        ...authOpts("bob"),
        workspaceId: wsA,
        body: payload,
      });
      expect([403, 404]).toContain(crossWriteB.status);
    } else if (first.order.includes("public-api-keys")) {
      const createKey = await sendRequest(app, "/api/api-keys", {
        method: "POST",
        ...authOpts("alice"),
        workspaceId: wsA,
        body: { name: "tenant-a-key", scopes: ["read"] },
      });
      expect(createKey.status).toBe(201);
      const keyId = ((await createKey.json()) as { key: { id: string } }).key.id;

      // Workspace B attempts to revoke Workspace A's key under its own workspace -> 404
      const crossRevokeB = await sendRequest(app, `/api/api-keys/${keyId}`, {
        method: "DELETE",
        ...authOpts("bob"),
        workspaceId: wsB,
      });
      expect([403, 404]).toContain(crossRevokeB.status);

      // Workspace B attempts to spoof Workspace A's header -> 403
      const crossSpoofB = await sendRequest(app, `/api/api-keys/${keyId}`, {
        method: "DELETE",
        ...authOpts("bob"),
        workspaceId: wsA,
      });
      expect([403, 404]).toContain(crossSpoofB.status);
    }
  });
});
