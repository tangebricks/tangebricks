import { defineConfig } from "vitest/config";

// Client-side tests: React components mounted in a DOM (jsdom) and run by Node, not by workerd. They exist because a
// brick's client layer is browser code. Anything that must prove a server-side claim stays in vitest.workers.config.ts.
// The server routes these tests call run in Node on Node's built-in SQLite behind a D1-shaped adapter; see
// bricks/credit-wallet/client/test/support/sqlite-d1.ts for what that does and does not show.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    name: "dom",
    environment: "jsdom",
    include: [
      "packages/*/client/test/**/*.test.{ts,tsx}",
      "bricks/*/client/test/**/*.test.{ts,tsx}",
      "apps/studio-web/test/**/*.test.{ts,tsx}",
    ],
    globalSetup: ["./test/support/dom-global-setup.ts"],
    setupFiles: [
      "./test/support/dom-setup.ts",
      "./test/support/assertion-counter.ts",
    ],
    testTimeout: 60_000,
  },
});
