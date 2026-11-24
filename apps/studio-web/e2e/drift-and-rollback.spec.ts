import { expect, test } from "@playwright/test";

test.describe("Epic 5 Story 5.5 — Environment Drift Detection & One-Click Rollback E2E", () => {
  test("deploys v1 and v2, detects out-of-band Worker script hash drift, and rolls back to v1 creating v3 without rebuilding", async ({
    page,
  }) => {
    const VALID_TOKEN = "cf_scoped_valid_token_e2e_story55_8899";
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    await page.goto("/");

    // 1. Sign in as Alice (Owner) against real Better Auth + STUDIO_DB
    const emailInput = page.getByTestId("auth-email-input");
    if (await emailInput.isVisible()) {
      await emailInput.fill("alice@example.com");
      await page.getByTestId("auth-password-input").fill("password12345");
      await page.getByTestId("auth-submit-button").click();
    }

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // 2. Create a dedicated project for Story 5.5 E2E and seed r1 via authenticated fetch
    const projectSlug = `e2e-s55-rb-${Date.now().toString(36).slice(-5)}`;
    const setupData = await page.evaluate(
      async ({ slug, token }) => {
        const orgsRes = await fetch("/api/orgs", { credentials: "include" });
        const orgsJson = (await orgsRes.json()) as {
          orgs?: Array<{ id: string }>;
        };
        const orgId = orgsJson.orgs?.[0]?.id ?? "org_default";

        await fetch(`/api/orgs/${orgId}/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ project: slug }),
        });

        await fetch(`/api/projects/${slug}/ops`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-org-id": orgId,
          },
          credentials: "include",
          body: JSON.stringify({
            summary: "Seed r1 with core-auth, orders entity, and workflow v1",
            ops: [
              {
                opId: "op_e2e55_brick_ws",
                type: "enable_brick",
                brickId: "multi-workspace",
                config: {},
              },
              {
                opId: "op_e2e55_brick_auth",
                type: "enable_brick",
                brickId: "core-auth",
                config: {},
              },
              {
                opId: "op_e2e55_brick_ent",
                type: "enable_brick",
                brickId: "dynamic-entities",
                config: {},
              },
              {
                opId: "op_e2e55_brick_wallet",
                type: "enable_brick",
                brickId: "credit-wallet",
                config: {},
              },
              {
                opId: "op_e2e55_brick_notif",
                type: "enable_brick",
                brickId: "in-app-notifications",
                config: {},
              },
              {
                opId: "op_e2e55_identity",
                type: "set_identity",
                identity: "core-auth",
              },
              {
                opId: "op_e2e55_orders",
                type: "add_entity",
                entity: {
                  name: "orders",
                  workspaceScoped: true,
                  fields: [{ name: "total", type: "text", required: true }],
                },
              },
              {
                opId: "op_e2e55_wf",
                type: "add_workflow",
                workflow: {
                  id: "wf_orders",
                  name: "Order Sync v1",
                  nodes: [
                    {
                      id: "n_sched",
                      type: "core.webhook",
                      label: "Order Webhook",
                      data: { method: "post" },
                    },
                    {
                      id: "n_debit",
                      type: "credit-wallet.debit",
                      label: "Debit Order Wallet",
                      data: { amount: 15 },
                    },
                  ],
                  edges: [
                    {
                      id: "e_1",
                      source: "n_sched",
                      target: "n_debit",
                      sourceHandle: "out",
                      targetHandle: "in",
                    },
                  ],
                },
              },
            ],
          }),
        });

        for (const secName of [
          "BETTER_AUTH_SECRET",
          "GITHUB_CLIENT_ID",
          "GITHUB_CLIENT_SECRET",
        ]) {
          await fetch(`/api/projects/${slug}/secrets`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-org-id": orgId,
            },
            credentials: "include",
            body: JSON.stringify({
              ref: `sec_${secName.toLowerCase()}`,
              kind: "brick_secret",
              label: secName,
              appOrBrick: "core-auth",
              value: `super_secret_${secName.toLowerCase()}_value_12345`,
              bindTarget: {
                targetKind: "brick",
                targetId: "core-auth",
                secretName: secName,
              },
            }),
          });
        }

        await fetch(`/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            token,
            accountName: "E2E Story 5.5 Account",
            projectId: slug,
          }),
        });

        // Deploy v1
        const dep1Res = await fetch(
          `/api/projects/${slug}/environments/preview/deploy`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-org-id": orgId,
            },
            credentials: "include",
            body: JSON.stringify({}),
          },
        );
        const dep1 = (await dep1Res.json()) as {
          deployId: string;
          revision: number;
          buildHash: string;
          assembleCount: number;
        };

        // Mutate workflow in next revision and deploy v2
        await fetch(`/api/projects/${slug}/ops`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-org-id": orgId,
          },
          credentials: "include",
          body: JSON.stringify({
            summary: "Update workflow debit node in v2",
            ops: [
              {
                opId: "op_e2e55_wf_v2",
                type: "update_node",
                workflowId: "wf_orders",
                nodeId: "n_debit",
                data: { amount: 25 },
              },
            ],
          }),
        });

        const dep2Res = await fetch(
          `/api/projects/${slug}/environments/preview/deploy`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-org-id": orgId,
            },
            credentials: "include",
            body: JSON.stringify({}),
          },
        );
        const dep2 = (await dep2Res.json()) as {
          deployId: string;
          revision: number;
          buildHash: string;
          assembleCount: number;
        };

        window.sessionStorage.setItem("studio:activeProjectId", slug);
        return { orgId, dep1, dep2 };
      },
      { slug: projectSlug, token: VALID_TOKEN },
    );

    const { orgId, dep1, dep2 } = setupData;
    expect(dep2.buildHash).not.toBe(dep1.buildHash);

    // 3. Reload Studio so activeProjectId is our new project and navigate to Connections
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("project-selector")).toHaveValue(projectSlug);

    await page.getByTestId("nav-tab-connections").click();
    await expect(page.getByTestId("view-connections")).toBeVisible();

    await expect(page.getByTestId("env-drift-card-preview")).toBeVisible();
    await expect(page.getByTestId("env-drift-status-preview")).toContainText(
      "In Sync",
    );
    await expect(page.getByTestId("env-badge")).toHaveText(
      `Preview r${dep2.revision}`,
    );

    // 4. Simulate an out-of-band Worker script hash change on the mock control plane
    await page.evaluate(
      async ({ slug, oid }) => {
        await fetch(`/api/projects/${slug}/environments/preview/check-drift`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-org-id": oid,
          },
          credentials: "include",
          body: JSON.stringify({
            simulateOutOfBand: {
              workerHash: "oob_tampered_worker_hash_e2e",
            },
          }),
        });
      },
      { slug: projectSlug, oid: orgId },
    );

    // Trigger Check Drift button in Studio UI
    await page.getByTestId("check-drift-button-preview").click();

    // Verify the Drift warning badge in top bar and out-of-band drift details in ConnectionsView
    await expect(page.getByTestId("env-drift-status-preview")).toContainText(
      "Drift Detected",
    );
    await expect(page.getByTestId("topbar-drift-badge")).toBeVisible();
    const driftBadgeStyle = await page
      .getByTestId("topbar-drift-badge")
      .evaluate((el) => {
        const s = window.getComputedStyle(el);
        return {
          fontWeight: s.fontWeight,
          borderRadius: s.borderRadius,
        };
      });
    expect(driftBadgeStyle.fontWeight).toBe("700");
    expect(driftBadgeStyle.borderRadius).toBe("4px");

    await expect(
      page.getByTestId("out-of-band-drift-item-preview-0"),
    ).toContainText("oob_tampered");

    // 5. Click Roll back on v1 in deployment history
    const rollbackV1Btn = page.getByTestId(`rollback-button-${dep1.deployId}`);
    await expect(rollbackV1Btn).toBeVisible();
    await rollbackV1Btn.click();

    const modal = page.getByTestId("rollback-confirmation-modal");
    await expect(modal).toBeVisible();
    const modalStyle = await modal.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return {
        display: s.display,
        flexDirection: s.flexDirection,
      };
    });
    expect(modalStyle.display).toBe("flex");
    expect(modalStyle.flexDirection).toBe("row");

    await expect(modal.getByTestId("rollback-target-summary")).toContainText(
      `v1 · r${dep1.revision} (${dep1.buildHash.slice(0, 10)})`,
    );
    await expect(modal.getByTestId("rollback-worker-diff-card")).toContainText(
      "Cached Build Reused",
    );

    // 6. Confirm rollback in modal
    await modal.getByTestId("confirm-rollback-button").click();
    await expect(modal.getByTestId("rollback-success-banner")).toContainText(
      `Rolled back to r${dep1.revision}`,
    );
    await modal.getByTestId("cancel-rollback-button").click();

    // 7. Verify v3 deployment is recorded with rollbackFromDeploymentId: v2, topbar badge returns to Preview r<dep1.revision>, and v1 buildHash is active
    await expect(page.getByTestId("env-badge")).toHaveText(
      `Preview r${dep1.revision}`,
    );
    await expect(
      page.getByTestId("deployment-version-preview-v3"),
    ).toBeVisible();
    await expect(page.getByTestId("deployment-history-preview")).toContainText(
      `rolled back from ${dep2.deployId.slice(0, 12)}`,
    );
    await expect(
      page.getByTestId("cloudflare-env-badge-preview"),
    ).toHaveAttribute("data-build-hash", dep1.buildHash);

    // 8. Reload (F5) and verify persistence of rolled-back deployment state and history
    await page.reload();
    await expect(page.getByTestId("env-badge")).toHaveText(
      `Preview r${dep1.revision}`,
    );
    await page.getByTestId("nav-tab-connections").click();
    await expect(
      page.getByTestId("deployment-version-preview-v3"),
    ).toBeVisible();
    await expect(page.getByTestId("deployment-history-preview")).toContainText(
      `rolled back from ${dep2.deployId.slice(0, 12)}`,
    );
    await expect(
      page.getByTestId("cloudflare-env-badge-preview"),
    ).toHaveAttribute("data-build-hash", dep1.buildHash);

    expect(pageErrors).toEqual([]);
  });
});
