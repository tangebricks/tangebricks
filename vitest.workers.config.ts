import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const brickAliases = readdirSync(here("./bricks"))
  .filter((dir) => existsSync(here(`./bricks/${dir}/src/index.ts`)))
  .map((dir) => ({
    find: new RegExp(`^@poc/${dir}$`),
    replacement: here(`./bricks/${dir}/src/index.ts`),
  }));

export default defineConfig({
  resolve: {
    alias: [
      ...brickAliases,
    ],
  },
  plugins: [
    cloudflareTest({
      main: here("./apps/studio-api/src/index.ts"),
      miniflare: {
        // Pinned so a workerd upgrade cannot silently change runtime behaviour under test.
        compatibilityDate: "2026-10-01",
        // nodejs_compat is kept (it was added for the retired Dafthunk bridge, but other suites may rely on it). The
        // runtime packages import no node: module; a test in H2.runtime.test.ts enforces that, so this flag cannot hide a
        // Node-only API there.
        compatibilityFlags: ["nodejs_compat"],
        // Fake values that stand in for the host's secrets, used only by the H3 tests.
        bindings: {
          POC_TEST_DECLARED: "declared-value-123",
          POC_TEST_UNDECLARED: "undeclared-value-456",
          // The access token the MCP endpoint tests present. A fake value; no real secret is in the repository.
          MCP_TOKEN: "test-mcp-token-0123456789",
          // Test-only stand-ins for the secrets production code now requires (no source fallbacks exist any more).
          // Fake values; real deployments set these with `wrangler secret put`.
          BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
          PX_VAULT_KEY: "test-only-px-vault-key-0123456789abcdef",
          PX_CONN_KEY: "test-only-px-conn-key-0123456789abcdef",
          PX_TOKEN_KEK: "test-only-px-token-kek-0123456789abcdef",
          PX_TELEMETRY_SECRET: "test-only-px-telemetry-secret-0123456789",
          // Story 0.21: requests in tests carry no client IP, so every signup and login in the whole run counts against
          // the one "unknown" IP bucket. The IP-keyed auth limits are raised for the suite (never removed); the
          // rate-limit tests pass their own PX_RATE_LIMITS (or none) to exercise the real numbers.
          PX_RATE_LIMITS: JSON.stringify({
            "auth-signup-ip": { limit: 100_000, windowSeconds: 3600 },
            "auth-login-ip": { limit: 100_000, windowSeconds: 600 },
          }),
        },
        // A local D1 database (workerd's own SQLite-backed implementation), used by the wallet tests. SANDBOX_DB_A and
        // SANDBOX_DB_B are two separate real databases that stand in for two projects' sandbox D1s (story 17 tests).
        d1Databases: ["DB", "STUDIO_DB", "SANDBOX_DB_A", "SANDBOX_DB_B"],
        r2Buckets: ["BUCKET"],
        durableObjects: {
          BLUEPRINT_DO: {
            className: "BlueprintDO",
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    name: "workers",
    // Assembles the two-brick project into out/two-brick/ before any test runs, and checks afterwards that nothing in it changed.
    globalSetup: ["./test/support/global-setup.ts"],
    setupFiles: ["./test/support/assertion-counter.ts"],
    include: ["test/**/*.test.ts", "apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts", "bricks/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.node.test.ts"],
    // The default is 5 s. The H5 sweeps run twenty rounds of fifty database operations each and take 4-6 s on a
    // normal machine, so on a busy one a correct run was timing out and being scored as a failure. A timeout fails
    // closed (it can never produce a pass), but a verdict that depends on machine load cannot be defended.
    testTimeout: 60_000,
  },
});
