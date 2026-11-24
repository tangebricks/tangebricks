import { defineConfig } from "vitest/config";

// Runs both test environments as projects, so `vitest run` and scripts/verify.ts see every test and the evidence
// reporter collects results from both. Reporters are a root-level setting.
export default defineConfig({
  test: {
    projects: ["./vitest.workers.config.ts", "./vitest.dom.config.ts", "./vitest.node.config.ts"],
    reporters: ["default", "./reporters/evidence-reporter.ts"],
  },
});
