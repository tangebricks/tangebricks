// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsView } from "../src/components/ConnectionsView.tsx";
import { StudioShell } from "../src/components/StudioShell.tsx";
import { useStudioStore } from "../src/store.ts";

describe("Story 5.5 — Studio Web Drift Badge, Deployment History & Rollback Modal", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useStudioStore.setState({
      user: {
        id: "user_1",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
      orgs: [
        {
          id: "org_default",
          slug: "default-org",
          name: "Default Org",
          role: "owner",
        },
      ],
      activeOrgId: "org_default",
      projects: [
        {
          project: "drift-ui-app",
          orgId: "org_default",
          revision: 2,
          semanticHash: "sem_r2",
          updatedAt: "2026-10-31T10:00:00Z",
        },
      ],
      activeProjectId: "drift-ui-app",
      currentRevision: 2,
      projectState: {
        project: "drift-ui-app",
        identity: "better-auth",
        bricks: [],
        entities: [],
        workflows: [],
        secretRefs: [],
        metadata: {},
      },
      readiness: {
        ready: true,
        needs: [],
      },
      activeNav: "connections",
      secrets: [],
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("displays topbar environment badge and Drift warning chip, lists v1/v2 history, and executes rollback with Destructive-Migration Guard", async () => {
    let previewRolledBack = false;

    const makeEnvironmentsPayload = () => ({
      project: "drift-ui-app",
      orgId: "org_default",
      currentRevision: 2,
      activeToken: {
        tokenRef: "cf_tok_ui_55",
        orgId: "org_default",
        accountId: "acc_ui_55",
        accountName: "Ada Cloudflare Account",
        tokenLast4: "9a8b",
        scopes: ["Workers Scripts:Edit", "D1:Edit", "Queues:Edit"],
        status: "active",
        createdAt: "2026-10-31T09:00:00Z",
        lastVerifiedAt: "2026-10-31T09:00:00Z",
      },
      environments: [
        {
          projectId: "drift-ui-app",
          orgId: "org_default",
          envName: "preview",
          target: {
            type: "byoc",
            accountId: "acc_ui_55",
            tokenRef: "cf_tok_ui_55",
            envName: "preview",
          },
          accountName: "Ada Cloudflare Account",
          deployedRev: previewRolledBack ? 1 : 2,
          currentRev: 2,
          buildHash: previewRolledBack ? "build_hash_r1_aaa111" : "build_hash_r2_bbb222",
          codeHash: previewRolledBack ? "code_hash_r1_aaa111" : "code_hash_r2_bbb222",
          graphHash: previewRolledBack ? "graph_hash_r1_aaa111" : "graph_hash_r2_bbb222",
          deployedAt: "2026-10-31T10:05:00Z",
          deployedBy: "user_1",
          status: "deployed",
          updatedAt: "2026-10-31T10:05:00Z",
          driftReport: {
            inSync: false,
            blueprintDrift: {
              hasCodeDrift: previewRolledBack,
              hasGraphDrift: true,
              deployedRev: previewRolledBack ? 1 : 2,
              currentRev: 2,
              deployedBuildHash: previewRolledBack
                ? "build_hash_r1_aaa111"
                : "build_hash_r2_bbb222",
              currentBuildHash: "build_hash_r2_bbb222",
              deployedCodeHash: previewRolledBack
                ? "code_hash_r1_aaa111"
                : "code_hash_r2_bbb222",
              currentCodeHash: "code_hash_r2_bbb222",
              deployedGraphHash: previewRolledBack
                ? "graph_hash_r1_aaa111"
                : "graph_hash_r2_bbb222",
              currentGraphHash: "graph_hash_r2_bbb222",
            },
            outOfBandDrift: previewRolledBack
              ? []
              : [
                  {
                    resource: "worker",
                    expected: "code_hash_r2_bbb222",
                    actual: "tampered_script_hash_xyz",
                    message:
                      'Worker script "px-drift-ui-app-preview" hash mismatch: expected code_hash_r2, found tampered_script',
                  },
                ],
            checkedAt: "2026-10-31T10:06:00Z",
          },
          deployments: previewRolledBack
            ? [
                {
                  deployId: "dep_v3_rb",
                  versionNumber: 3,
                  versionLabel: "v3",
                  projectId: "drift-ui-app",
                  orgId: "org_default",
                  envName: "preview",
                  revision: 1,
                  buildHash: "build_hash_r1_aaa111",
                  codeHash: "code_hash_r1_aaa111",
                  graphHash: "graph_hash_r1_aaa111",
                  action: "rollback",
                  status: "succeeded",
                  reusedCachedBuild: true,
                  liveWithoutRedeploy: false,
                  noChanges: false,
                  rollbackFromDeploymentId: "dep_v2_ second",
                  workerUrl: "https://px-drift-ui-app-preview.workers.dev",
                  versionId: "ver_r1",
                  databaseId: "db_1",
                  actorId: "user_1",
                  createdAt: "2026-10-31T10:10:00Z",
                },
                {
                  deployId: "dep_v2_second",
                  versionNumber: 2,
                  versionLabel: "v2",
                  projectId: "drift-ui-app",
                  orgId: "org_default",
                  envName: "preview",
                  revision: 2,
                  buildHash: "build_hash_r2_bbb222",
                  codeHash: "code_hash_r2_bbb222",
                  graphHash: "graph_hash_r2_bbb222",
                  action: "update",
                  status: "succeeded",
                  reusedCachedBuild: false,
                  liveWithoutRedeploy: false,
                  noChanges: false,
                  rollbackFromDeploymentId: null,
                  workerUrl: "https://px-drift-ui-app-preview.workers.dev",
                  versionId: "ver_r2",
                  databaseId: "db_1",
                  actorId: "user_1",
                  createdAt: "2026-10-31T10:05:00Z",
                },
                {
                  deployId: "dep_v1_first",
                  versionNumber: 1,
                  versionLabel: "v1",
                  projectId: "drift-ui-app",
                  orgId: "org_default",
                  envName: "preview",
                  revision: 1,
                  buildHash: "build_hash_r1_aaa111",
                  codeHash: "code_hash_r1_aaa111",
                  graphHash: "graph_hash_r1_aaa111",
                  action: "create",
                  status: "succeeded",
                  reusedCachedBuild: false,
                  liveWithoutRedeploy: false,
                  noChanges: false,
                  rollbackFromDeploymentId: null,
                  workerUrl: "https://px-drift-ui-app-preview.workers.dev",
                  versionId: "ver_r1",
                  databaseId: "db_1",
                  actorId: "user_1",
                  createdAt: "2026-10-31T10:00:00Z",
                },
              ]
            : [
                {
                  deployId: "dep_v2_second",
                  versionNumber: 2,
                  versionLabel: "v2",
                  projectId: "drift-ui-app",
                  orgId: "org_default",
                  envName: "preview",
                  revision: 2,
                  buildHash: "build_hash_r2_bbb222",
                  codeHash: "code_hash_r2_bbb222",
                  graphHash: "graph_hash_r2_bbb222",
                  action: "update",
                  status: "succeeded",
                  reusedCachedBuild: false,
                  liveWithoutRedeploy: false,
                  noChanges: false,
                  rollbackFromDeploymentId: null,
                  workerUrl: "https://px-drift-ui-app-preview.workers.dev",
                  versionId: "ver_r2",
                  databaseId: "db_1",
                  actorId: "user_1",
                  createdAt: "2026-10-31T10:05:00Z",
                },
                {
                  deployId: "dep_v1_first",
                  versionNumber: 1,
                  versionLabel: "v1",
                  projectId: "drift-ui-app",
                  orgId: "org_default",
                  envName: "preview",
                  revision: 1,
                  buildHash: "build_hash_r1_aaa111",
                  codeHash: "code_hash_r1_aaa111",
                  graphHash: "graph_hash_r1_aaa111",
                  action: "create",
                  status: "succeeded",
                  reusedCachedBuild: false,
                  liveWithoutRedeploy: false,
                  noChanges: false,
                  rollbackFromDeploymentId: null,
                  workerUrl: "https://px-drift-ui-app-preview.workers.dev",
                  versionId: "ver_r1",
                  databaseId: "db_1",
                  actorId: "user_1",
                  createdAt: "2026-10-31T10:00:00Z",
                },
              ],
        },
      ],
    });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/environments/preview/check-drift")) {
        const payload = makeEnvironmentsPayload();
        return new Response(
          JSON.stringify({
            ok: true,
            project: "drift-ui-app",
            orgId: "org_default",
            envName: "preview",
            driftReport: payload.environments[0]!.driftReport,
            environment: payload.environments[0]!,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/environments/preview/rollback")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          targetDeploymentId: string;
          dryRun?: boolean;
          confirmDestructive?: boolean;
        };
        const plan = {
          action: "update",
          worker: {
            scriptName: "px-drift-ui-app-preview",
            currentBuildHash: "build_hash_r2_bbb222",
            nextBuildHash: "build_hash_r1_aaa111",
            currentCodeHash: "code_hash_r2_bbb222",
            nextCodeHash: "code_hash_r1_aaa111",
            currentGraphHash: "graph_hash_r2_bbb222",
            nextGraphHash: "graph_hash_r1_aaa111",
            changed: true,
          },
          d1: {
            databaseName: "px-drift-ui-app-preview",
            createDatabase: false,
            pendingMigrations: [],
            destructiveWarnings: [
              {
                migrationName: "0002_create_invoices.sql",
                statement: "DROP TABLE invoices;",
                kind: "drop_table",
                affectedTable: "invoices",
                message:
                  'Applied D1 migration "0002_create_invoices.sql" created table "invoices" after the rollback target revision.',
              },
            ],
          },
          queues: [],
          cronTriggers: {
            currentCrons: ["*/30 * * * *"],
            nextCrons: ["*/15 * * * *"],
            schedulesCount: 1,
            changed: true,
          },
          workflows: [
            {
              workflowName: "wf_orders",
              className: "GraphRunner",
              action: "update",
            },
          ],
          secrets: [],
          blockers: [],
        };

        if (body.dryRun) {
          return new Response(
            JSON.stringify({
              ok: true,
              dryRun: true,
              project: "drift-ui-app",
              orgId: "org_default",
              envName: "preview",
              targetDeploymentId: body.targetDeploymentId,
              rollbackFromDeploymentId: "dep_v2_second",
              currentRevision: 2,
              targetRevision: 1,
              reusedCachedBuild: true,
              assembleCount: 1,
              plan,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        previewRolledBack = true;
        const nextPayload = makeEnvironmentsPayload();
        return new Response(
          JSON.stringify({
            ok: true,
            deployId: "dep_v3_rb",
            rollbackFromDeploymentId: "dep_v2_second",
            targetDeploymentId: body.targetDeploymentId,
            project: "drift-ui-app",
            orgId: "org_default",
            envName: "preview",
            revision: 1,
            buildHash: "build_hash_r1_aaa111",
            codeHash: "code_hash_r1_aaa111",
            graphHash: "graph_hash_r1_aaa111",
            action: "rollback",
            statusMessage: "Rolled back to r1",
            reusedCachedBuild: true,
            assembleCount: 1,
            plan,
            environment: nextPayload.environments[0]!,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/environments")) {
        return new Response(JSON.stringify(makeEnvironmentsPayload()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/secrets")) {
        return new Response(JSON.stringify({ secrets: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    render(<StudioShell renderConnections={() => <ConnectionsView />} />);

    // Top bar shows Preview r2 and Drift warning badge
    await waitFor(() => {
      expect(screen.getByTestId("env-badge").textContent).toBe("Preview r2");
    });
    expect(screen.getByTestId("topbar-drift-badge")).toBeTruthy();

    // Drift card in ConnectionsView shows Drift Detected and out-of-band drift item
    await waitFor(() => {
      expect(screen.getByTestId("env-drift-status-preview").textContent).toContain(
        "Drift Detected",
      );
    });
    expect(
      screen.getByTestId("out-of-band-drift-item-preview-0").textContent,
    ).toContain("hash mismatch");

    // Deployment history shows v2 and v1
    expect(screen.getByTestId("deployment-version-preview-v2").textContent).toBe(
      "v2",
    );
    expect(screen.getByTestId("deployment-version-preview-v1").textContent).toBe(
      "v1",
    );

    // Click Roll back on v1
    fireEvent.click(screen.getByTestId("rollback-button-dep_v1_first"));

    await waitFor(() => {
      expect(screen.getByTestId("rollback-confirmation-modal")).toBeTruthy();
    });

    // Wait for destructive migration guard to appear
    await waitFor(() => {
      expect(
        screen.getByTestId("rollback-destructive-migration-guard"),
      ).toBeTruthy();
    });

    const confirmBtn = screen.getByTestId(
      "confirm-rollback-button",
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // Check destructive migration confirmation checkbox
    fireEvent.click(
      screen.getByTestId("rollback-confirm-destructive-checkbox"),
    );
    expect(confirmBtn.disabled).toBe(false);

    // Confirm rollback
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByTestId("rollback-success-banner").textContent).toContain(
        "Rolled back to r1",
      );
    });

    // Close modal and verify v3 is now at the top of deployment history with rollback badge
    fireEvent.click(screen.getByTestId("cancel-rollback-button"));
    await waitFor(() => {
      expect(screen.getByTestId("deployment-version-preview-v3").textContent).toBe(
        "v3",
      );
    });
    expect(
      screen.getByTestId("deployment-rollback-badge-dep_v3_rb").textContent,
    ).toContain("rolled back from");
  });
});
