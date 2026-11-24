import { expect, test } from "@playwright/test";
// THROWAWAY (story 0.22): deliberate Playwright failure to prove the e2e job and cp0 fail.
test("deliberate failure", () => {
  expect(1).toBe(2);
});
