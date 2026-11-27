import { defineConfig } from "vitest/config";

// Coverage for the money and auth code only (strictness H7). `pnpm coverage:money` runs the listed bricks' and
// packages/gateway-adapters' tests through this config; the whole-repo `vitest run` and its CI shards do not use it.
//
// Provider: @vitest/coverage-v8. @cloudflare/vitest-plugin supports it inside workerd (it turns on the
// nodejs_inspector_module flags and collects the V8 profile over its loopback), so one run covers both the workers and
// the node project and no istanbul instrumentation pass is needed.
//
// Thresholds: one entry per brick, started at the measured values floored to whole percents. `autoUpdate` raises them
// when a local run measures more (commit the change); it is off under CI, where a run below a threshold only fails.
export default defineConfig({
  test: {
    projects: ["./vitest.workers.config.ts", "./vitest.node.config.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", ["text", { file: "coverage-table.txt" }], "json-summary"],
      include: [
        "bricks/credit-wallet/src/**/*.ts",
        "bricks/metered-usage/src/**/*.ts",
        "bricks/checkout-gateway/src/**/*.ts",
        "bricks/subscription-plans/src/**/*.ts",
        "bricks/core-auth/src/**/*.ts",
        "bricks/llm-gateway/src/**/*.ts",
        "packages/gateway-adapters/src/**/*.ts",
      ],
      // Test files, generated and type-only files (d1.ts only re-exports types), and client code are not measured.
      exclude: ["**/*.test.ts", "**/*.d.ts", "**/types.ts", "**/*.generated.ts", "**/client/**", "bricks/credit-wallet/src/d1.ts"],
      thresholds: {
        // Whole percents only, so a run that measures 85.4 % writes 85, not 85.4.
        autoUpdate: process.env.CI ? false : (measured) => Math.floor(measured),
        "bricks/credit-wallet/src/**": { statements: 89, branches: 83, functions: 96, lines: 92 },
        "bricks/metered-usage/src/**": { statements: 88, branches: 79, functions: 89, lines: 91 },
        "bricks/checkout-gateway/src/**": { statements: 90, branches: 77, functions: 100, lines: 94 },
        "bricks/subscription-plans/src/**": { statements: 88, branches: 82, functions: 83, lines: 90 },
        "bricks/core-auth/src/**": { statements: 85, branches: 60, functions: 76, lines: 88 },
        "bricks/llm-gateway/src/**": { statements: 91, branches: 87, functions: 95, lines: 94 },
        "packages/gateway-adapters/src/**": { statements: 95, branches: 87, functions: 91, lines: 97 },
      },
    },
  },
});
