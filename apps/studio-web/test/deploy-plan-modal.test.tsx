import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployPlanPayload } from "../src/api.ts";
import { DeployPlanModal } from "../src/components/DeployPlanModal.tsx";
import { useStudioStore } from "../src/store.ts";
import { PRESET_BLUEPRINTS } from "../src/types.ts";

describe("Story 5.3 — Pre-deploy Plan & Diff Modal, Stub-Identity Blocker & Destructive-Migration Guard (apps/studio-web)", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_owner", email: "owner@example.com", name: "Owner" },
      orgs: [{ id: "org_acme", slug: "acme", name: "Acme Labs", role: "owner" }],
      activeOrgId: "org_acme",
      activeProjectId: "acme-saas",
      currentRevision: 4,
      projectState: PRESET_BLUEPRINTS["b2b-workspace-app"]!,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders resource diff cards, expandable SQL preview, inline secret addition, production stub-identity blocker, destructive migration guard, and noop banner", async () => {
    let secretAdded = false;
    let identitySwitched = false;
    let deployed = false;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("/secrets") && init?.method === "POST") {
        secretAdded = true;
        return new Response(
          JSON.stringify({
            secret: {
              id: "vault_1",
              ref: "sec_stripe_secret_key",
              kind: "brick_secret",
              label: "STRIPE_SECRET_KEY",
              appOrBrick: "credit-wallet",
              envScope: "all",
              keyHint: "••••9999",
              status: "valid",
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes("/secrets")) {
        return new Response(JSON.stringify({ secrets: [] }), { status: 200 });
      }

      if (url.includes("/environments/preview/plan")) {
        if (deployed) {
          const noopPlan: DeployPlanPayload = {
            project: "acme-saas",
            envName: "preview",
            revision: 4,
            action: "noop",
            noChanges: true,
            worker: {
              scriptName: "px-acme-saas-preview",
              currentBuildHash: "sha256_build_v4_abcdef",
              nextBuildHash: "sha256_build_v4_abcdef",
              changed: false,
            },
            d1: {
              databaseName: "px-acme-saas-preview-db",
              createDatabase: false,
              pendingMigrations: [],
              pendingMigrationSql: {},
              destructiveWarnings: [],
            },
            queues: [
              { queueName: "px-acme-saas-preview-events", action: "unchanged" },
            ],
            cronTriggers: {
              currentCrons: ["0 * * * *"],
              nextCrons: ["0 * * * *"],
              schedulesCount: 1,
              changed: false,
            },
            workflows: [
              {
                workflowName: "wf-billing",
                className: "GraphRunner",
                action: "unchanged",
              },
            ],
            secrets: [
              {
                name: "STRIPE_SECRET_KEY",
                requiredByBrick: "credit-wallet",
                status: "present",
              },
            ],
            blockers: [],
          };
          return new Response(JSON.stringify(noopPlan), { status: 200 });
        }

        const previewPlan: DeployPlanPayload = {
          project: "acme-saas",
          envName: "preview",
          revision: 4,
          action: "update",
          worker: {
            scriptName: "px-acme-saas-preview",
            currentBuildHash: "sha256_build_v3_111111",
            nextBuildHash: "sha256_build_v4_abcdef",
            changed: true,
          },
          d1: {
            databaseName: "px-acme-saas-preview-db",
            createDatabase: false,
            pendingMigrations: ["9002_drop_column__invoices_legacy_note.sql"],
            pendingMigrationSql: {
              "9002_drop_column__invoices_legacy_note.sql":
                "ALTER TABLE invoices DROP COLUMN legacy_note;",
            },
            destructiveWarnings: [
              {
                migrationName: "9002_drop_column__invoices_legacy_note.sql",
                statement: "ALTER TABLE invoices DROP COLUMN legacy_note",
                kind: "drop_column",
                affectedTable: "invoices",
                affectedColumn: "legacy_note",
                message:
                  'Drops column "legacy_note" from table "invoices", permanently deleting its data.',
              },
            ],
          },
          queues: [
            { queueName: "px-acme-saas-preview-events", action: "create" },
          ],
          cronTriggers: {
            currentCrons: [],
            nextCrons: ["0 * * * *"],
            schedulesCount: 1,
            changed: true,
          },
          workflows: [
            {
              workflowName: "wf-billing",
              className: "GraphRunner",
              action: "create",
            },
          ],
          secrets: [
            {
              name: "STRIPE_SECRET_KEY",
              requiredByBrick: "credit-wallet",
              status: secretAdded ? "present" : "missing",
            },
          ],
          blockers: secretAdded
            ? []
            : [
                {
                  code: "MISSING_REQUIRED_SECRETS",
                  message: "Missing required secrets: STRIPE_SECRET_KEY",
                  remediation: "Add STRIPE_SECRET_KEY before deploying.",
                },
              ],
        };
        return new Response(JSON.stringify(previewPlan), { status: 200 });
      }

      if (url.includes("/environments/production/plan")) {
        const prodPlan: DeployPlanPayload = {
          project: "acme-saas",
          envName: "production",
          revision: 4,
          action: "create",
          worker: {
            scriptName: "px-acme-saas-production",
            currentBuildHash: null,
            nextBuildHash: "sha256_build_v4_abcdef",
            changed: true,
          },
          d1: {
            databaseName: "px-acme-saas-production-db",
            createDatabase: true,
            pendingMigrations: ["0001_init.sql"],
            pendingMigrationSql: {
              "0001_init.sql":
                "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY);",
            },
            destructiveWarnings: [],
          },
          queues: [],
          cronTriggers: {
            currentCrons: [],
            nextCrons: [],
            schedulesCount: 0,
            changed: false,
          },
          workflows: [],
          secrets: [],
          blockers: identitySwitched
            ? []
            : [
                {
                  code: "PRODUCTION_IDENTITY_STUB_FORBIDDEN",
                  message:
                    'Production deployments cannot use stub identity (identity: "stub").',
                  remediation:
                    'Switch blueprint identity from "stub" to "core-auth" (Better Auth).',
                },
              ],
        };
        return new Response(JSON.stringify(prodPlan), { status: 200 });
      }

      if (url.includes("/environments/preview/deploy")) {
        deployed = true;
        return new Response(
          JSON.stringify({
            ok: true,
            deployId: "dep_test_01",
            project: "acme-saas",
            envName: "preview",
            revision: 4,
            deployment: {
              scriptName: "px-acme-saas-preview",
              versionId: "ver_1",
              databaseId: "d1_1",
              databaseName: "px-acme-saas-preview-db",
              url: "https://px-acme-saas-preview.workers.dev",
              buildHash: "sha256_build_v4_abcdef",
              graphHash: "sha256_graph_v4",
              deployedAt: new Date().toISOString(),
            },
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    render(
      <DeployPlanModal
        open={true}
        projectSlug="acme-saas"
        orgId="org_acme"
        initialEnvName="preview"
        onClose={() => {}}
        onSwitchIdentityOverride={async () => {
          identitySwitched = true;
        }}
      />,
    );

    // 1. Wait for preview plan to load
    await waitFor(() => {
      expect(screen.getByTestId("deploy-plan-preflight")).toBeTruthy();
    });

    // Verify SQL preview toggle on pending migration
    const sqlToggle = screen.getByTestId(
      "deploy-plan-migration-sql-toggle-9002_drop_column__invoices_legacy_note.sql",
    );
    fireEvent.click(sqlToggle);
    expect(
      screen.getByTestId(
        "deploy-plan-migration-sql-9002_drop_column__invoices_legacy_note.sql",
      ).textContent,
    ).toContain("ALTER TABLE invoices DROP COLUMN legacy_note;");

    // 2. Confirm & Deploy button is disabled while secret is missing and destructive migration is unconfirmed
    const confirmBtn = screen.getByTestId(
      "confirm-and-deploy-button",
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // Add missing STRIPE_SECRET_KEY inline
    const secretInput = screen.getByTestId(
      "inline-secret-input-STRIPE_SECRET_KEY",
    );
    fireEvent.change(secretInput, {
      target: { value: "sk_test_inline_secret_999" },
    });
    fireEvent.click(
      screen.getByTestId("inline-secret-save-STRIPE_SECRET_KEY"),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("preflight-secret-row-STRIPE_SECRET_KEY").textContent,
      ).toContain("present ✓");
    });

    // 3. Destructive Migration Guard is visible; Confirm & Deploy stays disabled until checkbox is checked
    expect(screen.getByTestId("destructive-migration-guard")).toBeTruthy();
    expect(confirmBtn.disabled).toBe(true);

    const confirmCheckbox = screen.getByTestId(
      "destructive-migration-confirm-checkbox",
    );
    fireEvent.click(confirmCheckbox);
    expect(confirmBtn.disabled).toBe(false);

    // 4. Execute deploy on preview -> after deploy, plan refreshes to noop banner
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(screen.getByTestId("deploy-plan-noop-banner").textContent).toContain(
        "No changes — environment is already at revision r4 (build sha256_build)",
      );
    });

    // 5. Switch to production tab -> verify PRODUCTION_IDENTITY_STUB_FORBIDDEN blocker banner
    fireEvent.click(screen.getByTestId("deploy-plan-env-tab-production"));
    await waitFor(() => {
      expect(
        screen.getByTestId("deploy-plan-stub-identity-blocker"),
      ).toBeTruthy();
    });
    expect(
      (screen.getByTestId("confirm-and-deploy-button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Click Switch to Better Auth (core-auth) -> blocker clears
    fireEvent.click(screen.getByTestId("switch-to-core-auth-button"));
    await dbWaitForSwitch();

    async function dbWaitForSwitch() {
      fireEvent.click(screen.getByTestId("refresh-deploy-plan-button"));
      await waitFor(() => {
        expect(
          screen.queryByTestId("deploy-plan-stub-identity-blocker"),
        ).toBeNull();
      });
    }
  });
});
