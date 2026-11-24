import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_SCOPED_TOKEN_TEMPLATE_URL,
  MockCloudflareControlPlane,
  buildCloudflareTokenTemplateUrl,
  verifyCloudflareToken,
} from "../src/index.ts";

describe("Story 5.2 — Cloudflare Scoped Token Template & Per-Permission Verifier (packages/deploy)", () => {
  const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

  it("returns pre-filled least-privilege Cloudflare scoped token template URL and 4 required permissions", () => {
    const template = buildCloudflareTokenTemplateUrl();
    expect(template.templateUrl).toBe(CLOUDFLARE_SCOPED_TOKEN_TEMPLATE_URL);
    expect(template.templateUrl).toContain(
      "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=",
    );
    expect(template.templateUrl).toContain("name=ProjectX+Studio+Deploy");
    expect(template.explanation).toBe(
      "Your backend runs in your own Cloudflare account. We never host it.",
    );
    expect(template.permissions.map((p) => p.label)).toEqual([
      "Account Settings: Read",
      "Workers Scripts: Edit",
      "D1: Edit",
      "Queues: Edit",
    ]);
  });

  it("verifies a valid least-privilege token with all 4 permissions granted", async () => {
    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: "cf_valid_least_priv_token_12345",
      accountId: ACCOUNT_ID,
      accountName: "Acme BYOC Production",
    });

    const report = await verifyCloudflareToken(
      "cf_valid_least_priv_token_12345",
      ACCOUNT_ID,
      controlPlane,
    );

    expect(report.ok).toBe(true);
    expect(report.status).toBe("active");
    expect(report.isGlobalApiKey).toBe(false);
    expect(report.accountId).toBe(ACCOUNT_ID);
    expect(report.accountName).toBe("Acme BYOC Production");
    expect(report.missingPermissionIds).toEqual([]);
    expect(report.permissions).toHaveLength(4);
    expect(report.permissions.every((p) => p.granted && p.required)).toBe(true);
  });

  it("flags exact missing permission (Workers Scripts: Edit or D1: Edit) with plainError and remediationUrl", async () => {
    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: "cf_token_missing_d1_and_workers",
      accountId: ACCOUNT_ID,
      accountName: "Acme BYOC Production",
      permissions: ["Account Settings: Read", "Queues: Edit"],
    });

    const report = await verifyCloudflareToken(
      "cf_token_missing_d1_and_workers",
      ACCOUNT_ID,
      controlPlane,
    );

    expect(report.ok).toBe(false);
    expect(report.status).toBe("active");
    expect(report.missingPermissionIds).toEqual(["workers_scripts_edit", "d1_edit"]);
    expect(report.missingPermissionLabels).toEqual([
      "Workers Scripts: Edit",
      "D1: Edit",
    ]);

    const workersRow = report.permissions.find(
      (p) => p.id === "workers_scripts_edit",
    );
    expect(workersRow?.granted).toBe(false);
    expect(workersRow?.plainError).toContain("Workers Scripts: Edit missing ✕");
    expect(workersRow?.remediationUrl).toBe(CLOUDFLARE_SCOPED_TOKEN_TEMPLATE_URL);

    const d1Row = report.permissions.find((p) => p.id === "d1_edit");
    expect(d1Row?.granted).toBe(false);
    expect(d1Row?.plainError).toContain("D1: Edit missing ✕");
  });

  it("rejects expired, disabled, or invalid tokens and legacy Global API Keys", async () => {
    const controlPlane = new MockCloudflareControlPlane();
    controlPlane.registerToken({
      token: "cf_token_expired_999",
      accountId: ACCOUNT_ID,
      status: "expired",
    });
    controlPlane.registerToken({
      token: "cf_token_global_key_999",
      accountId: ACCOUNT_ID,
      isGlobalApiKey: true,
    });

    const expiredReport = await verifyCloudflareToken(
      "cf_token_expired_999",
      ACCOUNT_ID,
      controlPlane,
    );
    expect(expiredReport.ok).toBe(false);
    expect(expiredReport.status).toBe("expired");
    expect(expiredReport.summaryMessage).toContain(
      "Token is invalid or expired — Reconnect",
    );

    const globalKeyReport = await verifyCloudflareToken(
      "cf_token_global_key_999",
      ACCOUNT_ID,
      controlPlane,
    );
    expect(globalKeyReport.ok).toBe(false);
    expect(globalKeyReport.isGlobalApiKey).toBe(true);
    expect(globalKeyReport.summaryMessage).toContain("Global API Key rejected");

    const invalidReport = await verifyCloudflareToken(
      "cf_unknown_token_000",
      ACCOUNT_ID,
      controlPlane,
    );
    expect(invalidReport.ok).toBe(false);
    expect(invalidReport.status).toBe("invalid");
    expect(invalidReport.summaryMessage).toContain(
      "Token is invalid or expired — Reconnect",
    );
  });

  it("supports multi-account tokens and selects requestedAccountId when provided", async () => {
    const multiReportDefault = await verifyCloudflareToken(
      "cf_multi_account_valid_token_1234",
    );
    expect(multiReportDefault.ok).toBe(true);
    expect(multiReportDefault.accounts).toHaveLength(2);
    expect(multiReportDefault.accountId).toBe("abcdef0123456789abcdef0123456789");

    const multiReportSecond = await verifyCloudflareToken(
      "cf_multi_account_valid_token_1234",
      "fedcba9876543210fedcba9876543210",
    );
    expect(multiReportSecond.ok).toBe(true);
    expect(multiReportSecond.accountId).toBe("fedcba9876543210fedcba9876543210");
    expect(multiReportSecond.accountName).toBe("Acme Sandbox Cloudflare");
  });
});
