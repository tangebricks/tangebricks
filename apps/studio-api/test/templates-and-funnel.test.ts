import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import {
  computeBlueprintBuildHash,
  computeBlueprintGraphHash,
  semanticHash,
} from "@poc/blueprint";
import {
  app as studioApp,
  ensureDefaultTestAuth,
  ensureStudioD1Schema,
  recordStudioOnboardingEvent,
} from "../src/index.ts";
import type {
  OnboardingFunnelAnalyticsReport,
  ProjectStatePayload,
  StarterTemplateDescriptor,
  StudioApiEnv,
  StudioOnboardingEvent,
} from "../src/index.ts";
import { signInTestHuman } from "./human-session.ts";
import { ensureTestAuthForPath } from "./project-token.ts";

const studioEnv = env as unknown as StudioApiEnv;

async function studioReq(
  path: string,
  init: RequestInit = {},
  targetEnv: StudioApiEnv = studioEnv,
): Promise<Response> {
  const { headers: authHeaders } = await ensureTestAuthForPath(targetEnv, path);
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(authHeaders)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return studioApp.request(path, { ...init, headers }, targetEnv);
}

async function createHumanSession(
  emailSuffix: string,
  targetEnv: StudioApiEnv = studioEnv,
): Promise<{
  userId: string;
  orgId: string;
  cookie: string;
  req: (path: string, init?: RequestInit, envOverride?: Partial<StudioApiEnv>) => Promise<Response>;
}> {
  const email = `beta-${emailSuffix}-${Date.now()}@example.test`;
  const regRes = await studioApp.request(
    "/api/auth/signup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "Password12345!",
        name: `Beta User ${emailSuffix}`,
      }),
    },
    targetEnv,
  );
  expect(regRes.status).toBe(201);
  const setCookie = regRes.headers.get("set-cookie") ?? "";
  const regBody = (await regRes.json()) as {
    token: string;
    user: { id: string };
  };
  const cookieHeader = setCookie.split(";")[0] ?? "";
  const authHeader = `Bearer ${regBody.token}`;

  const req = async (
    path: string,
    init: RequestInit = {},
    envOverride: Partial<StudioApiEnv> = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookieHeader && !headers.has("cookie")) {
      headers.set("cookie", cookieHeader);
      // Story 0.14: a cookie-authenticated write must come from an allowed Origin (CSRF guard); this is the same origin.
      if (!headers.has("origin")) headers.set("origin", "http://localhost");
    }
    if (!headers.has("authorization")) {
      headers.set("authorization", authHeader);
    }
    return studioApp.request(path, { ...init, headers }, { ...targetEnv, ...envOverride });
  };

  const orgsRes = await req("/api/orgs");
  expect(orgsRes.status).toBe(200);
  const orgsBody = (await orgsRes.json()) as {
    orgs: Array<{ id: string }>;
  };
  const orgId = orgsBody.orgs[0]!.id;

  return {
    userId: regBody.user.id,
    orgId,
    cookie: cookieHeader,
    req,
  };
}

describe("Story 8.1 — Starter templates, layout coordinate persistence, and onboarding funnel analytics", () => {
  beforeEach(async () => {
    await ensureStudioD1Schema(studioEnv.STUDIO_DB);
    await ensureDefaultTestAuth(studioEnv);
  });

  test("GET /api/templates returns all 4 one-click starter templates with persisted node layout positions", async () => {
    const res = await studioReq("/api/templates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { templates: StarterTemplateDescriptor[] };
    expect(body.templates.map((t) => t.id)).toEqual([
      "ai-credits-saas",
      "b2b-workspace-app",
      "marketplace",
      "stripe-discord-ops",
    ]);

    for (const tpl of body.templates) {
      expect(tpl.bricks.length).toBeGreaterThanOrEqual(4);
      expect(tpl.entities.length).toBeGreaterThanOrEqual(1);
      expect(tpl.workflows.length).toBeGreaterThanOrEqual(1);
      for (const wf of tpl.blueprint.workflows ?? []) {
        expect(wf.nodes.length).toBeGreaterThanOrEqual(2);
        for (const node of wf.nodes) {
          expect(node.position).toBeDefined();
          expect(typeof node.position?.x).toBe("number");
          expect(typeof node.position?.y).toBe("number");
        }
      }
    }
  });

  test("POST /api/projects instantiates starter templates at rev=1, preserves layout coordinates, and keeps hashes invariant to node position edits", async () => {
    // Story 0.15: MCP tokens cannot create projects, so a signed-in owner of the default org creates them; the reads below
    // use each project's own token.
    const owner = await signInTestHuman(studioEnv, "tpl-owner");
    for (const templateId of [
      "ai-credits-saas",
      "b2b-workspace-app",
      "marketplace",
    ] as const) {
      const slug = `tpl-${templateId}`;
      const createRes = await studioReq("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", ...owner.headers },
        body: JSON.stringify({
          orgId: owner.orgId,
          slug,
          name: `Starter ${templateId}`,
          templateId,
          source: "template",
        }),
      });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as {
        project: string;
        revision: number;
        templateId: string | null;
        seededFromTemplate: boolean;
      };
      expect(createBody.project).toBe(slug);
      expect(createBody.revision).toBe(1);
      expect(createBody.templateId).toBe(templateId);
      expect(createBody.seededFromTemplate).toBe(true);

      const stateRes = await studioReq(`/api/projects/${slug}`);
      expect(stateRes.status).toBe(200);
      const stateBody = (await stateRes.json()) as ProjectStatePayload;
      expect(stateBody.revision).toBe(1);
      expect(stateBody.readiness.ready).toBe(true);
      expect(stateBody.readiness.needs).toEqual([]);
      expect(stateBody.state.bricks.length).toBeGreaterThanOrEqual(4);
      expect(stateBody.state.entities.length).toBeGreaterThanOrEqual(1);
      expect(stateBody.state.workflows.length).toBeGreaterThanOrEqual(1);
    }

    // Verify layout position persistence & hash invariance on ai-credits-saas
    const targetSlug = "tpl-ai-credits-saas";
    const beforeRes = await studioReq(`/api/projects/${targetSlug}`);
    const beforeState = (await beforeRes.json()) as ProjectStatePayload;
    const wf = beforeState.state.workflows[0]!;
    const firstNode = wf.nodes.find((n) => n.id === "n_trigger") ?? wf.nodes[0]!;
    expect(firstNode.position).toEqual({ x: 120, y: 180 });

    const beforeSemanticHash = semanticHash(beforeState.state);
    const beforeGraphHash = computeBlueprintGraphHash(beforeState.state);
    const beforeBuildHash = computeBlueprintBuildHash(beforeState.state);

    const moveRes = await studioReq(`/api/projects/${targetSlug}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: beforeState.revision,
        ops: [
          {
            opId: "move-node-pos-1",
            type: "update_node",
            workflowId: wf.id,
            nodeId: firstNode.id,
            patch: {
              position: { x: 720, y: 540 },
            },
          },
        ],
      }),
    });
    expect(moveRes.status).toBe(200);

    const afterRes = await studioReq(`/api/projects/${targetSlug}`);
    const afterState = (await afterRes.json()) as ProjectStatePayload;
    const movedNode = afterState.state.workflows[0]!.nodes.find(
      (n) => n.id === firstNode.id,
    )!;
    expect(movedNode.position).toEqual({ x: 720, y: 540 });

    expect(afterState.semanticHash).toBe(beforeSemanticHash);
    expect(computeBlueprintGraphHash(afterState.state)).toBe(beforeGraphHash);
    expect(computeBlueprintBuildHash(afterState.state)).toBe(beforeBuildHash);
  });

  test("stripe-discord-ops template reports UNBOUND_CONNECTION for sec_discord_bot until bound in Connections Center", async () => {
    const human = await createHumanSession("stripe-discord");
    const slug = "tpl-stripe-discord-ops";
    const createRes = await human.req("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgId: human.orgId,
        slug,
        templateId: "stripe-discord-ops",
      }),
    });
    expect(createRes.status).toBe(201);

    const initialRes = await human.req(`/api/projects/${slug}`);
    expect(initialRes.status).toBe(200);
    const initialState = (await initialRes.json()) as ProjectStatePayload;
    expect(initialState.revision).toBe(1);
    expect(initialState.readiness.ready).toBe(false);
    const unboundConnectionNeeds = initialState.readiness.needs.filter(
      (n) => n.code === "UNBOUND_CONNECTION",
    );
    expect(unboundConnectionNeeds.length).toBe(1);
    expect(unboundConnectionNeeds[0]?.message).toContain("sec_discord_bot");

    // Bind Case A connection via Connections Center
    const bindDiscordRes = await human.req(`/api/projects/${slug}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: "sec_discord_bot",
        app: "discord",
        authType: "apiKey",
        value: "Bot discord_ops_token_123456",
        bindTarget: {
          targetKind: "connection",
          targetId: "n_discord_notify",
          secretName: "DISCORD_BOT_TOKEN",
        },
      }),
    });
    expect(bindDiscordRes.status).toBe(200);

    const readyRes = await human.req(`/api/projects/${slug}`);
    expect(readyRes.status).toBe(200);
    const readyState = (await readyRes.json()) as ProjectStatePayload;
    expect(readyState.readiness.ready).toBe(true);
    expect(readyState.readiness.needs).toEqual([]);
  });

  test("End-to-end onboarding funnel events are recorded and aggregated by GET /api/admin/onboarding-funnel", async () => {
    // 1. Register user (automatically records signup_completed on personal org)
    const human = await createHumanSession("funnel-e2e");
    const { orgId } = human;
    const projectSlug = "funnel-e2e-project";

    // 2. Create project from template (records project_created)
    const createRes = await human.req(`/api/orgs/${orgId}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: projectSlug,
        templateId: "b2b-workspace-app",
        source: "template",
      }),
    });
    expect(createRes.status).toBe(201);

    // 3. Apply a blueprint edit op (records first_blueprint_edit once per project)
    const editRes1 = await human.req(`/api/projects/${projectSlug}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 1,
        ops: [
          {
            opId: "edit-1",
            type: "update_node",
            workflowId: "rbac_audit_workflow",
            nodeId: "n_record_created",
            patch: {
              label: "Project Created Trigger (Edited)",
            },
          },
        ],
      }),
    });
    expect(editRes1.status).toBe(200);

    const editRes2 = await human.req(`/api/projects/${projectSlug}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 2,
        ops: [
          {
            opId: "edit-2",
            type: "update_node",
            workflowId: "rbac_audit_workflow",
            nodeId: "n_notify_team",
            patch: {
              label: "Notify Workspace Members (Edited)",
            },
          },
        ],
      }),
    });
    expect(editRes2.status).toBe(200);

    // 4. Run Test Step on a workflow node (records first_test_step_run once per project)
    const stepRes = await human.req(
      `/api/projects/${projectSlug}/workflows/rbac_audit_workflow/nodes/n_record_created/test-step`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: {
            title: "Launch Project",
            status: "active",
            workspaceId: "ws_123",
          },
        }),
      },
    );
    expect(stepRes.status).toBe(200);

    // 5. Connect Cloudflare wizard funnel events + verify-and-save
    const wizOpenRes = await human.req(
      `/api/orgs/${orgId}/cloudflare-tokens/funnel-event`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          step: "wizard_opened",
          projectId: projectSlug,
        }),
      },
    );
    expect(wizOpenRes.status).toBe(201);

    const linkClickRes = await human.req(
      `/api/orgs/${orgId}/cloudflare-tokens/funnel-event`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          step: "template_link_clicked",
          projectId: projectSlug,
        }),
      },
    );
    expect(linkClickRes.status).toBe(201);

    const verifyRes = await human.req(
      `/api/orgs/${orgId}/cloudflare-tokens/verify-and-save`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "cf_valid_all_scopes_token_funnel_12345",
          accountId: "0123456789abcdef0123456789abcdef",
          accountName: "Funnel Cloudflare Account",
          projectId: projectSlug,
        }),
      },
    );
    expect(verifyRes.status).toBe(201);

    // 6. Bind core-auth required secrets so preview deploy preflight passes
    for (const [ref, secretName, val] of [
      ["sec_better_auth", "BETTER_AUTH_SECRET", "better_auth_secret_value_123456"],
      ["sec_github_id", "GITHUB_CLIENT_ID", "gh_client_id_123456"],
      ["sec_github_secret", "GITHUB_CLIENT_SECRET", "gh_client_secret_123456"],
    ] as const) {
      const secRes = await human.req(`/api/projects/${projectSlug}/secrets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ref,
          kind: "brick_secret",
          label: secretName,
          appOrBrick: "core-auth",
          envScope: "all",
          value: val,
        }),
      });
      expect(secRes.status).toBe(200);
    }

    // 7. Deploy to preview (records first_preview_deploy_started & first_preview_deploy_succeeded)
    const previewDeployRes = await human.req(
      `/api/projects/${projectSlug}/environments/preview/deploy`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId }),
      },
    );
    expect(previewDeployRes.status).toBe(200);

    // 8. Promote to production (records first_production_deploy_succeeded)
    const prodPromoteRes = await human.req(
      `/api/projects/${projectSlug}/environments/production/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId }),
      },
    );
    expect(prodPromoteRes.status).toBe(200);

    // Verify recorded studio_onboarding_events for this org
    const eventsRes = await human.req(`/api/orgs/${orgId}/onboarding-events`);
    expect(eventsRes.status).toBe(200);
    const eventsBody = (await eventsRes.json()) as {
      orgId: string;
      events: StudioOnboardingEvent[];
    };
    const recordedSteps = eventsBody.events.map((e) => e.step);
    expect(recordedSteps).toContain("signup_completed");
    expect(recordedSteps).toContain("project_created");
    expect(recordedSteps).toContain("first_blueprint_edit");
    expect(recordedSteps).toContain("first_test_step_run");
    expect(recordedSteps).toContain("connect_cf_wizard_opened");
    expect(recordedSteps).toContain("connect_cf_token_link_clicked");
    expect(recordedSteps).toContain("connect_cf_token_submitted");
    expect(recordedSteps).toContain("connect_cf_verified");
    expect(recordedSteps).toContain("first_preview_deploy_started");
    expect(recordedSteps).toContain("first_preview_deploy_succeeded");
    expect(recordedSteps).toContain("first_production_deploy_succeeded");

    // Ensure first_blueprint_edit was recorded only once despite 2 edit calls
    expect(
      eventsBody.events.filter(
        (e) =>
          e.projectId === projectSlug && e.step === "first_blueprint_edit",
      ).length,
    ).toBe(1);

    // 9. Query operator funnel report endpoint
    // Story 16: /api/admin/* is for platform operators only (PX_PLATFORM_OPERATORS); an org owner is not one.
    const refusedFunnel = await human.req(`/api/admin/onboarding-funnel?orgId=${orgId}`);
    expect(refusedFunnel.status).toBe(403);
    const funnelRes = await human.req(`/api/admin/onboarding-funnel?orgId=${orgId}`, {}, {
      PX_PLATFORM_OPERATORS: human.userId,
    });
    expect(funnelRes.status).toBe(200);
    const report = (await funnelRes.json()) as OnboardingFunnelAnalyticsReport;
    expect(report.stepCounts.signup_completed).toBeGreaterThanOrEqual(1);
    expect(report.stepCounts.project_created).toBeGreaterThanOrEqual(1);
    expect(report.stepCounts.first_blueprint_edit).toBeGreaterThanOrEqual(1);
    expect(report.stepCounts.first_test_step_run).toBeGreaterThanOrEqual(1);
    expect(report.stepCounts.connect_cf_wizard_opened).toBeGreaterThanOrEqual(1);
    expect(report.stepCounts.connect_cf_verified).toBeGreaterThanOrEqual(1);
    expect(
      report.stepCounts.first_preview_deploy_succeeded,
    ).toBeGreaterThanOrEqual(1);
    expect(
      report.stepCounts.first_production_deploy_succeeded,
    ).toBeGreaterThanOrEqual(1);
    expect(report.connectCloudflare.dropOffRate).toBe(0);
    expect(report.connectCloudflare.cp9TriggerFired).toBe(false);
    expect(report.ttfd.sampleSize).toBeGreaterThanOrEqual(1);
    expect(report.ttfd.ttfdPassed).toBe(true);
  });

  test("CP9 Managed Preview trigger fires when Connect Cloudflare wizard drop-off exceeds 25%", async () => {
    const highDropOrg = "org_high_dropoff_test";
    // 4 actors open wizard, only 2 complete connect_cf_verified -> 50% drop-off (> 25%)
    for (let i = 1; i <= 4; i += 1) {
      await recordStudioOnboardingEvent(studioEnv.STUDIO_DB, {
        orgId: highDropOrg,
        projectId: `proj_${i}`,
        actorId: `user_${i}`,
        step: "connect_cf_wizard_opened",
        createdAt: "2026-11-01T10:00:00.000Z",
      });
      if (i <= 2) {
        await recordStudioOnboardingEvent(studioEnv.STUDIO_DB, {
          orgId: highDropOrg,
          projectId: `proj_${i}`,
          actorId: `user_${i}`,
          step: "connect_cf_verified",
          createdAt: "2026-11-01T10:03:00.000Z",
        });
      } else {
        await recordStudioOnboardingEvent(studioEnv.STUDIO_DB, {
          orgId: highDropOrg,
          projectId: `proj_${i}`,
          actorId: `user_${i}`,
          step: "connect_cf_permission_check_failed",
          metadata: { missingScopes: ["Workers Scripts:Edit"] },
          createdAt: "2026-11-01T10:02:00.000Z",
        });
      }
    }

    const { computeOnboardingFunnelAnalytics } = await import("../src/index.ts");
    const report = await computeOnboardingFunnelAnalytics(studioEnv.STUDIO_DB, {
      orgId: highDropOrg,
    });
    expect(report.connectCloudflare.wizardOpenedCount).toBe(4);
    expect(report.connectCloudflare.verifiedCount).toBe(2);
    expect(report.connectCloudflare.permissionCheckFailedCount).toBe(2);
    expect(report.connectCloudflare.dropOffRate).toBe(0.5);
    expect(report.connectCloudflare.cp9TriggerFired).toBe(true);
  });
});
