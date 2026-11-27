import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { PX_RATE_LIMITS_DDL, applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";

// Story 2.2: the bricks work outside the monorepo. The packages (sdk and four bricks) are packed with `pnpm pack`, a fixture project in
// a temp directory outside the repo installs the tarballs (not workspace links), bundles its own Hono entry with
// esbuild from its own node_modules, runs it in workerd (Miniflare) with a D1 binding, applies the migrations the
// installed packages ship, and passes a smoke test: one user's workspace, wallet and audit log, and a second user in
// another workspace who cannot see any of it.
const root = resolve(import.meta.dirname, "..");
const FIXTURE = join(root, "fixtures", "external-app");
const PACKAGES = {
  "@poc/sdk": join(root, "packages", "sdk"),
  "@poc/multi-workspace": join(root, "bricks", "multi-workspace"),
  "@poc/credit-wallet": join(root, "bricks", "credit-wallet"),
  "@poc/audit-trail": join(root, "bricks", "audit-trail"),
  "@poc/edge-traffic-armor": join(root, "bricks", "edge-traffic-armor"),
  "@poc/oidc-verify": join(root, "bricks", "oidc-verify"),
  "@poc/rbac-policy": join(root, "bricks", "rbac-policy"),
  "@poc/platform-admin": join(root, "bricks", "platform-admin"),
} as const;
type PackageName = keyof typeof PACKAGES;
const BRICKS = [
  "@poc/multi-workspace",
  "@poc/credit-wallet",
  "@poc/audit-trail",
  "@poc/edge-traffic-armor",
  "@poc/oidc-verify",
  "@poc/rbac-policy",
  "@poc/platform-admin",
] as const;
/** Packages whose tarball ships no migrations (they own no tables). */
const NO_MIGRATIONS = new Set<string>(["@poc/sdk", "@poc/oidc-verify"]);
/** Each package's runtime dependencies: only what its src imports at runtime. */
const RUNTIME_DEPS: Record<string, string[]> = { "@poc/sdk": ["zod"], "@poc/oidc-verify": ["@poc/sdk", "hono"] };
/** A test-only HS256 secret for the fixture's oidc-verify mount (a Miniflare binding, never a real secret). */
const OIDC_SECRET = "test-only-external-app-hs256-secret-0123456789";
const SETUP_TIMEOUT = 900_000;

const isInside = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
};

// Child budgets, all well inside SETUP_TIMEOUT: 8 packs + install + typecheck = 8*45 + 240 + 90 = 690 s. The children
// run asynchronously, so each one's own timeout fires (with its clear message) before the hook's.
const PACK_TIMEOUT = 45_000;
const INSTALL_TIMEOUT = 240_000;
const TSC_TIMEOUT = 90_000;
const ROOT_PNPM_VERSION = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager: string }).packageManager;

/**
 * The pnpm JS entry of the pnpm running this repo, run with this Node (never through a shell, so a timeout kills pnpm
 * itself). From npm_execpath when pnpm set it, otherwise found next to a `pnpm` on PATH (npm-global and pnpm/action-setup
 * layouts).
 */
function pnpmEntry(): string {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && /pnpm\.c?js$/i.test(fromEnv) && existsSync(fromEnv)) return fromEnv;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const shim = join(dir, "pnpm");
    if (existsSync(shim)) {
      try {
        const real = realpathSync(shim);
        if (/pnpm\.c?js$/i.test(real)) return real;
      } catch {
        // not a link; try the layouts below
      }
    }
    for (const candidate of [
      join(dir, "node_modules", "pnpm", "bin", "pnpm.cjs"),
      join(dir, "..", "pnpm", "bin", "pnpm.cjs"),
      join(dir, "..", "lib", "node_modules", "pnpm", "bin", "pnpm.cjs"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Cannot find pnpm's JS entry (bin/pnpm.cjs) from npm_execpath or PATH; install ${ROOT_PNPM_VERSION} with npm or pnpm/action-setup.`);
}

// The child must not inherit the workspace's package or lifecycle context from a parent `pnpm` run.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_package_|npm_lifecycle_|npm_config_workspace|PNPM_SCRIPT_SRC_DIR)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Runs `node <script> ...args` without a shell; resolves with the outcome, never rejects. */
function runNode(script: string, args: string[], cwd: string, timeout: number) {
  return new Promise<{ ok: boolean; timedOut: boolean; output: string }>((done) => {
    let output = "";
    let timedOut = false;
    const child = spawn(process.execPath, [script, ...args], { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({
        ok: false,
        timedOut,
        output: `${output}
${error.message}`.trim(),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0 && !timedOut, timedOut, output: output.trim() });
    });
  });
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path, base) : [relative(base, path).split(sep).join("/")];
  });
}

let work: string;
let appDir: string;
let mf: Miniflare | undefined;
let bundleInputs: string[] = [];
const migrated: string[] = [];

const installed = (name: PackageName) => join(appDir, "node_modules", ...name.split("/"));

async function call(method: string, path: string, opts: { user?: string; ws?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.user) headers["x-test-user"] = opts.user;
  if (opts.ws) headers["x-workspace-id"] = opts.ws;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = (await mf!.dispatchFetch(`https://external-app.test${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  } as never)) as unknown as Response;
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

beforeAll(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "tangebricks-external-")));
  expect(isInside(work, root)).toBe(false);
  const packDir = join(work, "tarballs");
  appDir = join(work, "external-app");

  // 1. Pack each package into the temp directory.
  const pnpm = pnpmEntry();
  const tarballs = {} as Record<PackageName, string>;
  for (const [name, dir] of Object.entries(PACKAGES) as [PackageName, string][]) {
    const before = new Set(existsSync(packDir) ? readdirSync(packDir) : []);
    const packed = await runNode(pnpm, ["pack", "--pack-destination", packDir], dir, PACK_TIMEOUT);
    if (!packed.ok) throw new Error(`pnpm pack failed for ${name}:\n${packed.output}`);
    const made = readdirSync(packDir).filter((f) => f.endsWith(".tgz") && !before.has(f));
    if (made.length !== 1) throw new Error(`pnpm pack for ${name} made ${made.length} tarballs: ${made.join(", ")}`);
    tarballs[name] = join(packDir, made[0]!).split(sep).join("/");
  }

  // 2. Copy the fixture outside the repo, and 3. point its dependencies (and the bricks' @poc/sdk) at the tarballs.
  cpSync(FIXTURE, appDir, { recursive: true, filter: (src) => !src.split(sep).includes("node_modules") });
  const manifestPath = join(appDir, "package.json");
  const fileSpec = (name: string) => `file:${tarballs[name as PackageName]}`;
  writeFileSync(
    manifestPath,
    readFileSync(manifestPath, "utf8").replace(/TARBALL:(@poc\/[a-z-]+)/g, (_, name: string) => fileSpec(name)),
  );
  expect(readFileSync(manifestPath, "utf8")).not.toContain("TARBALL:");

  // 4. Install as a standalone project: no workspace, cache first. CI sets CI=true, which would default pnpm to a
  // frozen lockfile; the fixture has none, so that is turned off explicitly.
  const install = await runNode(
    pnpm,
    [
      "install",
      "--ignore-workspace",
      "--prefer-offline",
      "--no-frozen-lockfile",
      "--reporter=append-only",
      "--config.fetch-retries=1",
      "--config.fetch-timeout=30000",
    ],
    appDir,
    INSTALL_TIMEOUT,
  );
  if (!install.ok) {
    throw new Error(
      `Installing the packed bricks in the fixture failed${install.timedOut ? " (timed out)" : ""}. ` +
        "The fixture fetches hono and zod from the npm registry unless the local pnpm store already has them " +
        `(and ${ROOT_PNPM_VERSION} itself, if the pnpm running this test is another version); ` +
        `check the network or warm the store with \`pnpm install\` in the repo.\n${install.output.slice(-4000)}`,
    );
  }

  // The fixture's entry typechecks against what it installed (its tsconfig resolves only its own node_modules).
  // tsc also checks the bricks' .ts sources it reaches; any type error in them or in the fixture fails.
  const tsc = await runNode(join(root, "node_modules", "typescript", "bin", "tsc"), ["--noEmit", "-p", join(appDir, "tsconfig.json")], appDir, TSC_TIMEOUT);
  const tscErrors = tsc.output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line));
  if (tsc.timedOut || tscErrors.length > 0 || (!tsc.ok && !/error TS\d+/.test(tsc.output))) {
    throw new Error(`tsc on the fixture failed${tsc.timedOut ? " (timed out)" : ""}:\n${tsc.output.slice(-4000)}`);
  }

  // 5. Bundle the fixture's entry with esbuild, resolving only from the fixture directory.
  const result = await build({
    absWorkingDir: appDir,
    entryPoints: [join(appDir, "src", "index.ts")],
    outfile: join(appDir, "dist", "worker.js"),
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*"],
    metafile: true,
    logLevel: "silent",
  });
  bundleInputs = Object.keys(result.metafile!.inputs);

  // 6. Run it in workerd with a D1 binding.
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: result.outputFiles[0]!.text,
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
      bindings: { OIDC_HS256_SECRET: OIDC_SECRET },
    }),
  );
  await mf.ready;

  // 7. Apply the migrations the installed packages ship, in the order each manifest lists them.
  const db = (await mf.getD1Database("DB")) as unknown as D1Like;
  for (const brick of BRICKS) {
    const manifest = JSON.parse(readFileSync(join(installed(brick), "brick.manifest.json"), "utf8")) as { migrations: string[] };
    for (const migration of manifest.migrations) {
      await applyMigration(db, readFileSync(join(installed(brick), migration), "utf8"));
      migrated.push(`${brick}/${migration}`);
    }
  }
  // The SDK's rate limiter counts in px_rate_limits; the SDK ships its DDL rather than a migration file.
  await applyMigration(db, PX_RATE_LIMITS_DDL);
}, SETUP_TIMEOUT);

afterAll(async () => {
  await mf?.dispose();
  if (work) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A Windows file lock left by workerd; the OS temp directory is cleaned eventually.
    }
  }
}, 60_000);

describe("story 2.2: the packed packages install outside the monorepo", () => {
  test("each package is installed from its tarball into the fixture, not linked to the workspace", () => {
    for (const name of Object.keys(PACKAGES) as PackageName[]) {
      const real = realpathSync(installed(name));
      expect(isInside(real, appDir), `${name} resolved to ${real}`).toBe(true);
      expect(isInside(real, root), `${name} resolved to ${real}`).toBe(false);
    }
    // The override makes every brick's @poc/sdk the one sdk tarball: exactly one copy is installed.
    const sdkCopies = readdirSync(join(appDir, "node_modules", ".pnpm")).filter((d) => d.startsWith("@poc+sdk@"));
    expect(sdkCopies).toHaveLength(1);
  });

  test("each tarball holds src, README and (for bricks) migrations and manifest, and no tests, client UI or fixtures", () => {
    for (const name of Object.keys(PACKAGES) as PackageName[]) {
      const files = listFiles(installed(name)).filter((f) => !f.startsWith("node_modules/"));
      expect(files, name).toContain("src/index.ts");
      expect(files, name).toContain("README.md");
      expect(files, name).toContain("package.json");
      if (name !== "@poc/sdk") expect(files, name).toContain("brick.manifest.json");
      expect(
        files.some((f) => f.startsWith("migrations/") && f.endsWith(".sql")),
        name,
      ).toBe(!NO_MIGRATIONS.has(name));
      const stray = files.filter((f) => /^(test|client|fixtures)\//.test(f) || /\.test\.tsx?$/.test(f));
      expect(stray, name).toEqual([]);
      const pkg = JSON.parse(readFileSync(join(installed(name), "package.json"), "utf8")) as {
        private?: boolean;
        dependencies?: Record<string, string>;
      };
      expect(pkg.private, name).toBe(true);
      expect((pkg as { license?: string }).license, name).toBe("Apache-2.0");
      // The licence text travels with the tarball and is the repo's own, byte for byte (line endings aside).
      const text = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      for (const file of ["LICENSE", "NOTICE"]) {
        expect(files, name).toContain(file);
        expect(text(join(installed(name), file)), `${name} ${file}`).toBe(text(join(root, file)));
      }
      // pack rewrote workspace:* to concrete versions
      expect(JSON.stringify(pkg), name).not.toContain("workspace:");
      // runtime dependencies are only what src imports at runtime
      const allowed = RUNTIME_DEPS[name] ?? ["@poc/sdk", "hono", "zod"];
      expect(Object.keys(pkg.dependencies ?? {}).sort(), name).toEqual(allowed.sort());
    }
  });

  test("the bundle resolved every brick from the fixture's node_modules, never from the repo's sources", () => {
    expect(bundleInputs.length).toBeGreaterThan(0);
    for (const input of bundleInputs) {
      const abs = resolve(appDir, input);
      expect(isInside(abs, appDir), input).toBe(true);
      expect(isInside(abs, root), input).toBe(false);
    }
    const normalised = bundleInputs.map((i) => i.split(sep).join("/"));
    for (const name of Object.keys(PACKAGES)) {
      expect(
        normalised.some((i) => i.includes(`node_modules/${name}/src/`)),
        name,
      ).toBe(true);
    }
    expect(normalised.some((i) => i.includes("node_modules/hono/"))).toBe(true);
  });

  test("the shipped migrations apply to a fresh D1 and create every brick table", async () => {
    expect(migrated).toEqual([
      "@poc/multi-workspace/migrations/0001_multi_workspace.sql",
      "@poc/multi-workspace/migrations/0002_invite_email_expiry.sql",
      "@poc/credit-wallet/migrations/0001_credit_wallet.sql",
      "@poc/credit-wallet/migrations/0002_workspace_scoped_idempotency.sql",
      "@poc/credit-wallet/migrations/0003_order_currency.sql",
      "@poc/credit-wallet/migrations/0004_milli_credits.sql",
      "@poc/audit-trail/migrations/0001_audit_trail.sql",
      "@poc/audit-trail/migrations/0002_capability_rows.sql",
      "@poc/edge-traffic-armor/migrations/0001_edge_traffic_armor.sql",
      "@poc/edge-traffic-armor/migrations/0002_px_rate_limits.sql",
      "@poc/rbac-policy/migrations/0001_rbac_policy.sql",
      "@poc/platform-admin/migrations/0001_platform_admin.sql",
    ]);
    const db = (await mf!.getD1Database("DB")) as unknown as D1Like;
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const tables = results.map((r) => r.name);
    for (const table of [
      "mw_workspaces",
      "mw_members",
      "mw_invites",
      "credit_wallets",
      "credit_ledger",
      "credit_orders",
      "credit_action_costs",
      "audit_events",
      "arm_ip_rules",
      "arm_blocked_requests",
      "px_rate_limits",
      "rbac_roles",
      "rbac_role_assignments",
      "pa_user_approvals",
    ]) {
      expect(tables).toContain(table);
    }
  });
});

describe("story 2.2: smoke test of the mounted bricks in workerd", () => {
  const A = "user-a";
  const B = "user-b";
  let wsA: string;
  let wsB: string;

  test("a request with no identity is refused", async () => {
    expect((await call("GET", "/v1/workspaces")).status).toBe(401);
    expect((await call("GET", "/v1/wallet", { ws: "anything" })).status).toBe(401);
  });

  test("user A and user B each create a workspace", async () => {
    const a = await call("POST", "/v1/workspaces", { user: A, body: { name: "Workspace A" } });
    expect(a.status, a.text).toBe(201);
    wsA = a.json.workspace.id;
    const b = await call("POST", "/v1/workspaces", { user: B, body: { name: "Workspace B" } });
    expect(b.status, b.text).toBe(201);
    wsB = b.json.workspace.id;
    expect(wsA).not.toBe(wsB);
    const listed = await call("GET", "/v1/workspaces", { user: A });
    expect(listed.json.workspaces.map((w: { id: string }) => w.id)).toEqual([wsA]);
  });

  test("A credits the wallet through the payment routes, reads the balance, spends, and reads the ledger", async () => {
    const start = await call("GET", "/v1/wallet", { user: A, ws: wsA });
    expect(start.status, start.text).toBe(200);
    expect(start.json.currentBalance).toBe(0);

    const order = await call("POST", "/v1/payments/create-order", { user: A, ws: wsA, body: { amount: 5 } });
    expect(order.status, order.text).toBe(200);
    const orderId = order.json.order_id as string;
    expect((await call("POST", `/__test__/gateway/orders/${orderId}/paid`)).status).toBe(200);

    // B cannot confirm A's order: it answers like a missing one.
    expect((await call("POST", "/v1/payments/verify", { user: B, body: { order_id: orderId } })).status).toBe(404);

    const verified = await call("POST", "/v1/payments/verify", { user: A, body: { order_id: orderId } });
    expect(verified.status, verified.text).toBe(200);
    expect(verified.json).toMatchObject({ status: "PAID", credited: true, credits: 50 });

    const balance = await call("GET", "/v1/wallet", { user: A, ws: wsA });
    expect(balance.json.currentBalance).toBe(50);

    const spent = await call("POST", "/v1/wallet/deduct", { user: A, ws: wsA, body: { amount: 7, reason: "usage" } });
    expect(spent.status, spent.text).toBe(200);
    expect(spent.json.balanceAfter).toBe(43);

    const history = await call("GET", "/v1/wallet/history", { user: A, ws: wsA });
    expect(history.status).toBe(200);
    expect(history.json.ledgers.map((l: { amount: number }) => l.amount)).toEqual([-7, 50]);

    // Story 2.5: a fractional amount is taken exactly, and every amount comes back in credits and in thousandths.
    const fraction = await call("POST", "/v1/wallet/deduct", { user: A, ws: wsA, body: { amount: "0.25", reason: "usage" } });
    expect(fraction.status, fraction.text).toBe(200);
    expect(fraction.json).toMatchObject({ charged: 0.25, chargedMilli: 250, balanceAfter: 42.75, balanceAfterMilli: 42_750 });
    expect((await call("GET", "/v1/wallet", { user: A, ws: wsA })).json).toMatchObject({ currentBalance: 42.75, currentBalanceMilli: 42_750 });
    // The new routes are mounted behind their rate limits too; neither request below moves anything.
    expect((await call("POST", "/v1/wallet/charge", { user: A, ws: wsA, body: { action: "nothing.priced", idempotencyKey: "c-1" } })).status).toBe(404);
    expect(
      (await call("POST", "/v1/wallet/transfer", { user: A, ws: wsA, body: { toWorkspaceId: "ws-nowhere", amount: 1, idempotencyKey: "t-1" } })).status,
    ).toBe(404);
  });

  test("A records an audit entry and lists it", async () => {
    const recorded = await call("POST", "/v1/audit/events", {
      user: A,
      ws: wsA,
      body: { action: "wallet.topup", targetType: "wallet", targetId: wsA },
    });
    expect(recorded.status, recorded.text).toBe(201);
    const listed = await call("GET", "/v1/audit/events", { user: A, ws: wsA });
    expect(listed.status).toBe(200);
    expect(listed.json.events).toHaveLength(1);
    expect(listed.json.events[0]).toMatchObject({ action: "wallet.topup", actor_id: A, workspace_id: wsA });
  });

  test("B, in another workspace, cannot see A's wallet or audit rows", async () => {
    // Naming A's workspace is refused: B is not a member.
    for (const path of ["/v1/wallet", "/v1/wallet/history", "/v1/audit/events", "/v1/audit/export"]) {
      const res = await call("GET", path, { user: B, ws: wsA });
      expect(res.status, `${path}: ${res.text}`).toBe(403);
      expect(res.text).not.toContain("wallet.topup");
    }
    const deduct = await call("POST", "/v1/wallet/deduct", { user: B, ws: wsA, body: { amount: 1 } });
    expect(deduct.status).toBe(403);
    expect((await call("GET", `/v1/workspaces/${wsA}`, { user: B })).status).toBe(404);

    // In B's own workspace there is nothing of A's.
    const wallet = await call("GET", "/v1/wallet", { user: B, ws: wsB });
    expect(wallet.status).toBe(200);
    expect(wallet.json.currentBalance).toBe(0);
    const history = await call("GET", "/v1/wallet/history", { user: B, ws: wsB });
    expect(history.json.ledgers).toEqual([]);
    const audit = await call("GET", "/v1/audit/events", { user: B, ws: wsB });
    expect(audit.status).toBe(200);
    expect(audit.json.events).toEqual([]);

    // A's balance is untouched by B's attempts.
    expect((await call("GET", "/v1/wallet", { user: A, ws: wsA })).json.currentBalance).toBe(42.75);
  });

  test("the mounted rate limits counted the wallet requests", async () => {
    const db = (await mf!.getD1Database("DB")) as unknown as D1Like;
    for (const bucket of ["wallet-deduct", "wallet-create-order", "wallet-verify", "wallet-charge", "wallet-transfer"]) {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM px_rate_limits WHERE key LIKE ?").bind(`${bucket}:%`).first<{ n: number }>();
      expect(row?.n, bucket).toBeGreaterThan(0);
    }
  });

  test("edge-traffic-armor: a named bucket keyed by user answers 429 past its limit, per user, and logs an incident", async () => {
    const db = (await mf!.getD1Database("DB")) as unknown as D1Like;
    expect((await call("GET", "/v1/ping", { user: A })).status).toBe(200);
    expect((await call("GET", "/v1/ping", { user: A })).status).toBe(200);
    const limited = await call("GET", "/v1/ping", { user: A });
    expect(limited.status, limited.text).toBe(429);
    expect(limited.json.code).toBe("RATE_LIMITED");
    // B comes from the same address (the test sends no client IP) and still has their own count.
    expect((await call("GET", "/v1/ping", { user: B })).status).toBe(200);
    const counters = await db.prepare("SELECT COUNT(*) AS n FROM px_rate_limits WHERE key LIKE 'fixture-ping:%'").first<{ n: number }>();
    expect(counters?.n).toBe(2);
    const incidents = await db
      .prepare("SELECT COUNT(*) AS n FROM arm_blocked_requests WHERE block_reason = 'rate_limit' AND path = '/v1/ping'")
      .first<{ n: number }>();
    expect(incidents?.n).toBe(1);
  });

  test("a suspended workspace cannot spend: requireNotSuspended runs after the workspace guard", async () => {
    const db = (await mf!.getD1Database("DB")) as unknown as D1Like;
    await db.prepare("UPDATE mw_workspaces SET suspended = 1 WHERE id = ?").bind(wsA).run();
    const deduct = await call("POST", "/v1/wallet/deduct", { user: A, ws: wsA, body: { amount: 1 } });
    expect(deduct.status, deduct.text).toBe(403);
    expect(deduct.json.code).toBe("WORKSPACE_SUSPENDED");
    await db.prepare("UPDATE mw_workspaces SET suspended = 0 WHERE id = ?").bind(wsA).run();
    expect((await call("GET", "/v1/wallet", { user: A, ws: wsA })).json.currentBalance).toBe(42.75);
  });
});

/** Signs an HS256 JWT with the fixture's test secret. */
async function hs256(payload: Record<string, unknown>, secret = OIDC_SECRET): Promise<string> {
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  const head = b64(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64(sig)}`;
}

describe("story 2.8: oidc-verify, rbac-policy, platform-admin and the new workspace routes, installed from tarballs", () => {
  const OWNER = "user-c";
  const JOINER = "user-d";
  let ws: string;

  test("oidc-verify verifies an HS256 token and sets the user's id and email; a bad token is 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await hs256({ iss: "https://idp.external-app.test", aud: "external-app", sub: "oidc-user", email: "Oidc@Example.test", exp: now + 600 });
    const me = (await mf!.dispatchFetch("https://external-app.test/oidc/me", {
      headers: { Authorization: `Bearer ${token}` },
    } as never)) as unknown as Response;
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ uid: "oidc-user", email: "Oidc@Example.test" });
    const forged = await hs256({ iss: "https://idp.external-app.test", aud: "external-app", sub: "oidc-user", exp: now + 600 }, "another-secret-0123456789");
    const bad = (await mf!.dispatchFetch("https://external-app.test/oidc/me", {
      headers: { Authorization: `Bearer ${forged}` },
    } as never)) as unknown as Response;
    expect(bad.status).toBe(401);
  });

  test("multi-workspace 1.1.0: emailed invite, the invitee's pending list, accept, members, role and rename", async () => {
    const created = await call("POST", "/v1/workspaces", { user: OWNER, body: { name: "Workspace C" } });
    expect(created.status, created.text).toBe(201);
    ws = created.json.workspace.id;
    const invite = await call("POST", `/v1/workspaces/${ws}/invites`, {
      user: OWNER,
      body: { role: "member", email: `${JOINER}@example.test`, expiresInSeconds: 3600 },
    });
    expect(invite.status, invite.text).toBe(201);
    const mine = await call("GET", "/v1/workspaces/invites/mine", { user: JOINER });
    expect(mine.json.invites).toEqual([expect.objectContaining({ token: invite.json.token, workspace: { id: ws, name: "Workspace C" } })]);
    expect((await call("POST", `/v1/workspaces/invites/${invite.json.token}/accept`, { user: "user-e" })).status).toBe(403);
    const accepted = await call("POST", `/v1/workspaces/invites/${invite.json.token}/accept`, { user: JOINER });
    expect(accepted.status, accepted.text).toBe(200);
    const members = await call("GET", `/v1/workspaces/${ws}/members`, { user: JOINER });
    expect(members.json.members.map((m: { userId: string }) => m.userId).sort()).toEqual([OWNER, JOINER].sort());
    expect((await call("PATCH", `/v1/workspaces/${ws}/members/${JOINER}`, { user: OWNER, body: { role: "admin" } })).status).toBe(200);
    const renamed = await call("PATCH", `/v1/workspaces/${ws}`, { user: JOINER, body: { name: "Workspace C2" } });
    expect(renamed.status, renamed.text).toBe(200);
    expect(renamed.json.workspace.name).toBe("Workspace C2");
  });

  test("rbac-policy answers behind the workspace guard; platform-admin refuses a non-operator", async () => {
    const owner = await call("GET", "/v1/policies/check?resource=docs&action=read", { user: OWNER, ws });
    expect(owner.status, owner.text).toBe(200);
    expect(owner.json).toEqual({ allowed: true, reason: "workspace_owner" });
    const admin = await call("GET", "/v1/policies/check?resource=docs&action=read", { user: JOINER, ws });
    expect(admin.json).toEqual({ allowed: false });
    expect((await call("GET", "/v1/policies/check?resource=docs&action=read", { user: "user-e", ws })).status).toBe(403);

    const platform = await call("GET", "/v1/platform/workspaces", { user: OWNER });
    expect(platform.status, platform.text).toBe(403);
    expect(platform.json.code).toBe("NOT_PLATFORM_OPERATOR");
    expect((await call("GET", "/v1/platform/workspaces")).status).toBe(401);
  });
});
