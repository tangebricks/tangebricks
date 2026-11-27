// Unused files, exports and dependencies (story 1.31). Run with `pnpm lint:unused` (scripts/lint-unused.ts), which runs
// knip with this file and fails on any finding that is not an exact, reasoned entry in scripts/lint-unused-allowlist.ts.
//
// How code is reached, and so what knip treats as an entry point:
// - Each workspace's package.json `exports`/`main`, its `scripts`, and the commands in .github/workflows/*.yml (knip
//   reads those itself).
// - Brick manifests: a brick.manifest.json names route factories, executors, capability exports, guards and schedule
//   handlers, and the assembler imports them by name from the brick's package entry (`exports["."]`). check-manifests
//   (`pnpm catalog:conformance`) fails unless every such name is exported by that entry. Knip treats the entry as an
//   entry file and never reports an entry file's exports (`includeEntryExports` stays off), so no manifest-named export
//   is ever reported. scripts/test/knip-gate.node.test.ts checks that this still holds.
// - vitest configs and test files, the wrangler config, studio-web's vite and tailwind configs and the Playwright config
//   (knip's plugins read these).
// - The files below, which are reached by path at run time (a spawned script, an esbuild entry or a generated import
//   string) or run by hand, each with its reason.
//
// Ignored outright: generated output (out/, coverage/, dist/), recorded evidence, catalogs, the corpus and test fixtures.
// Every other exception is narrow and lives in scripts/lint-unused-allowlist.ts with its reason.
import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: [
        // Mutation scripts: each one breaks a proof claim on purpose and shows its check fails (the proof procedure in
        // PROOF.md and docs). Run by hand, never imported.
        "scripts/mutate-*.ts",
        // Spawned by packages/assembler/test/H7.assembly.node.test.ts (h7-run spawns h7-shift-clock).
        "scripts/h7-run.ts",
        "scripts/h7-shift-clock.ts",
        // Spawned by scripts/refresh-evidence.ts to regenerate evidence/mcp-scaling-benchmark.json.
        "scripts/benchmark-mcp-scale.ts",
        // Hand-run tools, documented where they are used: docs/integration-importer.md (pack responses), the credit-wallet
        // README (balance import), docs/retired-hypotheses.md (knowledge-graph build).
        "scripts/generate-pack-responses.ts",
        "scripts/import-wallet-balances.ts",
        "scripts/build-ua-graph.ts",
        // The Node-side loader that packages/sdk/src/platform-limits.ts (getPlatformLimits) tells callers to use.
        "scripts/lib/load-workflow-limits-evidence.ts",
        // The story 10.4 CLI location for the OpenAPI importer (`pnpm openapi:import` runs the same code from
        // packages/integrations/src/cli.ts).
        "tools/openapi-import/cli.ts",
      ],
      ignore: [
        // Test fixtures: small stand-alone projects the tests read or lint as data.
        "fixtures/**",
        "scripts/test/fixtures/**",
      ],
    },
    "apps/*": {},
    "packages/*": {},
    "packages/deploy": {
      entry: [
        // esbuild entry of the H12 demo page (packages/deploy/src/bundle.ts) and a GLUE_SCAN_FILES file.
        "client/demo-entry.tsx",
        // Imported by path from the deploy entry that packages/deploy/src/bundle.ts generates as a string.
        "src/worker/graph-workflow.ts",
        "src/worker/proof-routes.ts",
        "src/worker/catalog-bricks.ts",
        // Imported as @poc/deploy/worker/limits-probe from the Worker that scripts/probe-workflow-limits.ts generates.
        "src/worker/limits-probe.ts",
      ],
    },
    "bricks/*": {},
  },
  // Generated and recorded files are never analysed, nor the agent tooling folders (.agents/, .claude/, _bmad/), which
  // hold vendored skill scripts run by the coding agents, not product code (oxlint and Prettier ignore them too).
  ignore: [
    "out/**",
    "coverage/**",
    "**/dist/**",
    "evidence/**",
    "corpus/**",
    "catalog.json",
    "**/catalog-*.json",
    ".agents/**",
    ".claude/**",
    "_bmad/**",
    "_bmad-output/**",
  ],
};

export default config;
