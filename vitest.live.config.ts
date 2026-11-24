import { defineConfig } from "vitest/config";

// The H12 test that runs against the real Cloudflare account (packages/*/client/live/). It is NOT part of `pnpm test`: it needs the
// owner's credentials and writes to their account, so it is run on purpose with the env file, see the header of the test.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    name: "live",
    environment: "jsdom",
    include: ["packages/*/client/live/**/*.test.{ts,tsx}", "bricks/*/client/live/**/*.test.{ts,tsx}"],
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
