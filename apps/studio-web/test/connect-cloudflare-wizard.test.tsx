import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsView } from "../src/components/ConnectionsView.tsx";
import { useStudioStore } from "../src/store.ts";
import { PRESET_BLUEPRINTS } from "../src/types.ts";

describe("Story 5.2 — Connect Cloudflare Wizard Modal & Deploy Target Card (apps/studio-web)", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_owner", email: "owner@example.com", name: "Owner" },
      orgs: [{ id: "org_acme", slug: "acme", name: "Acme Labs", role: "owner" }],
      activeOrgId: "org_acme",
      activeProjectId: "acme-billing",
      projectState: PRESET_BLUEPRINTS["b2b-workspace-app"]!,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders BYOC explanation, opens Connect Cloudflare wizard, displays missing-permission diagnostics with Fix in Cloudflare & Re-check, and transitions to Connected state with preview/production badges on valid token", async () => {
    const funnelSteps: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("/secrets")) {
        return new Response(JSON.stringify({ secrets: [] }), { status: 200 });
      }
      if (url.includes("/environments")) {
        return new Response(
          JSON.stringify({
            project: "acme-billing",
            orgId: "org_acme",
            activeToken: null,
            environments: [],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/cloudflare-tokens/template-url")) {
        return new Response(
          JSON.stringify({
            orgId: "org_acme",
            templateUrl:
              "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=test&name=ProjectX+Studio+Deploy",
            dashboardUrl: "https://dash.cloudflare.com/profile/api-tokens",
            tokenName: "ProjectX Studio Deploy",
            explanation:
              "Your backend runs in your own Cloudflare account. We never host it.",
            permissions: [],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/cloudflare-tokens/funnel-event")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.step) funnelSteps.push(String(body.step));
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      if (url.includes("/cloudflare-tokens/verify-and-save")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const submittedToken = String(body.token ?? "");
        if (submittedToken.includes("missing_workers")) {
          return new Response(
            JSON.stringify({
              ok: false,
              verification: {
                ok: false,
                status: "active",
                isGlobalApiKey: false,
                accounts: [
                  {
                    id: "abcdef0123456789abcdef0123456789",
                    name: "Acme Production",
                  },
                  {
                    id: "fedcba9876543210fedcba9876543210",
                    name: "Acme Staging",
                  },
                ],
                permissions: [
                  {
                    id: "account_settings_read",
                    label: "Account Settings: Read",
                    required: true,
                    granted: true,
                    remediationUrl:
                      "https://dash.cloudflare.com/profile/api-tokens",
                  },
                  {
                    id: "workers_scripts_edit",
                    label: "Workers Scripts: Edit",
                    required: true,
                    granted: false,
                    remediationUrl:
                      "https://dash.cloudflare.com/profile/api-tokens",
                    plainError:
                      "Workers Scripts: Edit missing ✕ — required to upload Worker scripts.",
                  },
                  {
                    id: "d1_edit",
                    label: "D1: Edit",
                    required: true,
                    granted: true,
                    remediationUrl:
                      "https://dash.cloudflare.com/profile/api-tokens",
                  },
                  {
                    id: "queues_edit",
                    label: "Queues: Edit",
                    required: true,
                    granted: true,
                    remediationUrl:
                      "https://dash.cloudflare.com/profile/api-tokens",
                  },
                ],
                missingPermissionIds: ["workers_scripts_edit"],
                missingPermissionLabels: ["Workers Scripts: Edit"],
                remediationUrl:
                  "https://dash.cloudflare.com/profile/api-tokens",
                summaryMessage:
                  "Missing required permissions: Workers Scripts: Edit missing ✕",
              },
              error: {
                code: "MISSING_REQUIRED_PERMISSIONS",
                message:
                  "Missing required permissions: Workers Scripts: Edit missing ✕",
                remediationUrl:
                  "https://dash.cloudflare.com/profile/api-tokens",
              },
            }),
            { status: 422 },
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
            tokenRef: "tok_0192b8e4-5a6c-7f12-8b3d-0123456789ab",
            accountId: "abcdef0123456789abcdef0123456789",
            accountName: "Acme Production",
            token: {
              tokenRef: "tok_0192b8e4-5a6c-7f12-8b3d-0123456789ab",
              orgId: "org_acme",
              accountId: "abcdef0123456789abcdef0123456789",
              accountName: "Acme Production",
              tokenLast4: "7788",
              scopes: [
                "Account Settings: Read",
                "Workers Scripts: Edit",
                "D1: Edit",
                "Queues: Edit",
              ],
              status: "active",
              createdAt: "2026-10-30T00:00:00.000Z",
              lastVerifiedAt: "2026-10-30T00:00:00.000Z",
            },
            verification: {
              ok: true,
              status: "active",
              isGlobalApiKey: false,
              accountId: "abcdef0123456789abcdef0123456789",
              accountName: "Acme Production",
              permissions: [
                {
                  id: "account_settings_read",
                  label: "Account Settings: Read",
                  required: true,
                  granted: true,
                  remediationUrl:
                    "https://dash.cloudflare.com/profile/api-tokens",
                },
                {
                  id: "workers_scripts_edit",
                  label: "Workers Scripts: Edit",
                  required: true,
                  granted: true,
                  remediationUrl:
                    "https://dash.cloudflare.com/profile/api-tokens",
                },
                {
                  id: "d1_edit",
                  label: "D1: Edit",
                  required: true,
                  granted: true,
                  remediationUrl:
                    "https://dash.cloudflare.com/profile/api-tokens",
                },
                {
                  id: "queues_edit",
                  label: "Queues: Edit",
                  required: true,
                  granted: true,
                  remediationUrl:
                    "https://dash.cloudflare.com/profile/api-tokens",
                },
              ],
              missingPermissionIds: [],
              missingPermissionLabels: [],
              remediationUrl: "https://dash.cloudflare.com/profile/api-tokens",
              summaryMessage: "All 4 permissions verified.",
            },
            environments: [
              {
                projectId: "acme-billing",
                orgId: "org_acme",
                envName: "preview",
                target: {
                  type: "byoc",
                  accountId: "abcdef0123456789abcdef0123456789",
                  tokenRef: "tok_0192b8e4-5a6c-7f12-8b3d-0123456789ab",
                  envName: "preview",
                },
                accountName: "Acme Production",
                deployedRev: null,
                buildHash: null,
                codeHash: null,
                graphHash: null,
                status: "connected",
                updatedAt: "2026-10-30T00:00:00.000Z",
              },
              {
                projectId: "acme-billing",
                orgId: "org_acme",
                envName: "production",
                target: {
                  type: "byoc",
                  accountId: "abcdef0123456789abcdef0123456789",
                  tokenRef: "tok_0192b8e4-5a6c-7f12-8b3d-0123456789ab",
                  envName: "production",
                },
                accountName: "Acme Production",
                deployedRev: null,
                buildHash: null,
                codeHash: null,
                graphHash: null,
                status: "connected",
                updatedAt: "2026-10-30T00:00:00.000Z",
              },
            ],
          }),
          { status: 201 },
        );
      }

      if (url.includes("/cloudflare-tokens/tok_") && init?.method === "DELETE") {
        return new Response(
          JSON.stringify({
            ok: true,
            tokenRef: "tok_0192b8e4-5a6c-7f12-8b3d-0123456789ab",
            status: "revoked",
            revokedAt: "2026-10-30T00:01:00.000Z",
            cloudflareDashboardUrl:
              "https://dash.cloudflare.com/profile/api-tokens",
            workersKeepRunningMessage:
              "Disconnected. Deployed Workers keep running in your Cloudflare account.",
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({}), { status: 200 });
    });

    render(<ConnectionsView />);

    expect(screen.getByTestId("cloudflare-byoc-explanation").textContent).toBe(
      "Your backend runs in your own Cloudflare account. We never host it.",
    );
    expect(screen.getByTestId("cloudflare-connection-status").textContent).toContain(
      "Not connected",
    );

    // Open Connect Cloudflare wizard
    fireEvent.click(screen.getByTestId("connect-cloudflare-button"));
    expect(screen.getByTestId("connect-cloudflare-modal")).toBeDefined();
    expect(screen.getByTestId("cf-wizard-explanation").textContent).toBe(
      "Your backend runs in your own Cloudflare account. We never host it.",
    );

    // Click Create token in Cloudflare link
    fireEvent.click(screen.getByTestId("cf-create-token-link"));

    // Submit a token missing Workers Scripts: Edit
    fireEvent.change(screen.getByTestId("cf-token-input"), {
      target: { value: "cf_missing_workers_edit_token_1111" },
    });
    fireEvent.click(screen.getByTestId("cf-verify-submit-button"));

    await waitFor(() => {
      expect(screen.getByTestId("cf-verification-error")).toBeDefined();
    });
    expect(
      screen.getByTestId("cf-perm-status-account_settings_read").textContent,
    ).toBe("Account found ✓");
    expect(
      screen.getByTestId("cf-perm-status-workers_scripts_edit").textContent,
    ).toBe("Workers Scripts: Edit missing ✕");
    expect(screen.getByTestId("cf-fix-in-cloudflare-link")).toBeDefined();
    // Multi-account selector rendered when multiple accounts returned
    expect(screen.getByTestId("cf-account-selector")).toBeDefined();

    // Fix token and Re-check
    fireEvent.change(screen.getByTestId("cf-token-input"), {
      target: { value: "cf_valid_least_priv_token_7788" },
    });
    fireEvent.click(screen.getByTestId("cf-recheck-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("connect-cloudflare-modal")).toBeNull();
    });

    // Connected card shows account name, preview & production badges, Replace token & Disconnect
    expect(
      screen.getByTestId("cloudflare-connected-account-name").textContent,
    ).toBe("Acme Production");
    expect(screen.getByTestId("cloudflare-env-badge-preview").textContent).toContain(
      "preview",
    );
    expect(
      screen.getByTestId("cloudflare-env-badge-production").textContent,
    ).toContain("production");

    // Disconnect flow explains that deployed Workers keep running in user's Cloudflare account
    fireEvent.click(screen.getByTestId("cloudflare-disconnect-button"));
    const confirmPanel = screen.getByTestId(
      "cloudflare-disconnect-confirm-panel",
    );
    expect(confirmPanel.textContent).toContain("keep running in your Cloudflare account");

    fireEvent.click(screen.getByTestId("cloudflare-confirm-disconnect-button"));
    await waitFor(() => {
      expect(
        screen.getByTestId("cloudflare-connection-status").textContent,
      ).toContain("Not connected");
    });

    expect(funnelSteps).toContain("wizard_opened");
    expect(funnelSteps).toContain("template_link_clicked");
  });
});
