// Story 2.11: a reconciliation result as the sdk's generic ShadowReport.
import { describe, expect, test } from "vitest";
import { walletShadowReport } from "../src/index.ts";
import type { ReconcileReport } from "../src/index.ts";
import type { ShadowReport } from "@poc/sdk";

const base: ReconcileReport = {
  rows: [
    { workspaceId: "ws-a", hostMilli: 1000, brickMilli: 1000, diffMilli: 0, refused: false },
    { workspaceId: "ws-b", hostMilli: 0, brickMilli: null, diffMilli: 0, refused: false },
  ],
  hostTotalMilli: 1000,
  brickTotalMilli: 1000,
  diffTotalMilli: 0,
  mismatchedRows: 0,
  missingWallets: 1,
  refusedRows: 0,
  exact: true,
};

describe("walletShadowReport", () => {
  test("an exact reconciliation", () => {
    const report: ShadowReport = walletShadowReport("wallet", base, "2026-11-28T00:00:00.000Z");
    expect(report).toEqual({ group: "wallet", exact: true, compared: 2, differing: 0, checkedAt: "2026-11-28T00:00:00.000Z" });
  });

  test("mismatched and refused rows both count as differing", () => {
    const result: ReconcileReport = {
      ...base,
      rows: [
        ...base.rows,
        { workspaceId: "ws-c", hostMilli: 5, brickMilli: 3, diffMilli: -2, refused: false },
        { workspaceId: "", hostMilli: 0, brickMilli: null, diffMilli: 0, refused: true, error: "bad id" },
      ],
      mismatchedRows: 1,
      refusedRows: 1,
      exact: false,
    };
    const report = walletShadowReport("wallet", result, new Date("2026-11-28T12:30:00Z"));
    expect(report).toEqual({ group: "wallet", exact: false, compared: 4, differing: 2, checkedAt: "2026-11-28T12:30:00.000Z" });
  });

  test("checkedAt defaults to now, as ISO-8601 UTC", () => {
    const before = Date.now();
    const { checkedAt } = walletShadowReport("wallet", base);
    expect(checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(checkedAt)).toBeGreaterThanOrEqual(before);
  });
});
