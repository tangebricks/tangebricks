import { defineConfig } from "vitest/config";

// Tests that need Node itself: the file system, child processes, process-wide traps. Anything that must prove a claim
// about Workers runs in vitest.workers.config.ts instead. Files are named *.node.test.ts.
export default defineConfig({
  test: {
    name: "node",
    environment: "node",
    setupFiles: [
      "./apps/studio-api/test/miniflare-dispose-guard.ts",
      "./test/support/assertion-counter.ts",
    ],
    include: ["packages/*/test/**/*.node.test.ts", "bricks/*/test/**/*.node.test.ts", "test/**/*.node.test.ts", "scripts/test/**/*.node.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
