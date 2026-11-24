import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    name: "studio-web",
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
  },
});
