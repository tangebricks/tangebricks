import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/studio-web/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/playwright-report.json" }],
  ],
  globalSetup: "./apps/studio-web/e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 900 },
    headless: true,
  },
});
