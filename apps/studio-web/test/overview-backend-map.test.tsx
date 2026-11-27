import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioApp } from "../src/App.tsx";
import { useStudioStore } from "../src/store.ts";
import { PRESET_BLUEPRINTS, createEmptyBlueprintState } from "../src/types.ts";
import type { BlueprintState } from "../src/types.ts";

const b2bBlueprint: BlueprintState = {
  ...PRESET_BLUEPRINTS["b2b-workspace-app"]!,
  secretRefs: [
    {
      ref: "sec_better_auth",
      targetKind: "brick",
      targetId: "core-auth",
      secretName: "BETTER_AUTH_SECRET",
    },
    {
      ref: "sec_github_id",
      targetKind: "brick",
      targetId: "core-auth",
      secretName: "GITHUB_CLIENT_ID",
    },
    {
      ref: "sec_github_secret",
      targetKind: "brick",
      targetId: "core-auth",
      secretName: "GITHUB_CLIENT_SECRET",
    },
  ],
  workflows: [
    {
      id: "wf-project-audit",
      name: "Project Audit Trail Flow",
      trigger: { kind: "webhook", path: "/webhooks/project-created" },
      nodes: [
        { id: "n1", type: "trigger.manual", label: "Webhook Trigger", data: {} },
        {
          id: "n2",
          type: "audit-trail.log",
          label: "Record Audit Event",
          data: { entity: "projects" },
        },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
    },
  ],
};

describe("Story 2.3: Project Overview and generated Backend Map", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("1. renders the b2b-workspace-app preset on the Backend Map with Identity, Capability Wiring, Enabled Bricks, Entities, and Workflows (AC 1, AC 6)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: b2bBlueprint,
    });

    render(<StudioApp />);

    expect(screen.getByTestId("overview-backend-map")).toBeDefined();

    // Identity provider block
    const idProvider = screen.getByTestId("backend-map-identity-provider");
    expect(idProvider.textContent).toContain("Identity: core-auth");

    // Capability wiring (multi-workspace provides workspace-context -> required by rbac-policy, audit-trail, etc.)
    const wsLink = screen.getByTestId("capability-link-workspace-context");
    expect(wsLink.textContent).toContain("multi-workspace");
    expect(wsLink.textContent).toContain("workspace-context");
    expect(wsLink.textContent).toContain("rbac-policy");

    // All 8 enabled bricks in b2b-workspace-app are rendered with maturity badges
    for (const brickEntry of b2bBlueprint.bricks) {
      const card = screen.getByTestId(`backend-map-brick-card-${brickEntry.id}`);
      expect(card).toBeDefined();
      const mat = screen.getByTestId(`backend-map-brick-maturity-${brickEntry.id}`);
      expect(["Production ✓", "Beta ◆"]).toContain(mat.textContent);
      const status = screen.getByTestId(`backend-map-brick-status-${brickEntry.id}`);
      expect(status.textContent).toContain("Ready");
    }

    // Data (Entities) block shows "projects" entity and active dynamic-entities handler
    expect(screen.getByTestId("backend-map-entity-handler-status").textContent).toContain("dynamic-entities");
    expect(screen.getByTestId("backend-map-entity-card-projects").textContent).toContain("ent_projects");

    // Workflows block shows trigger icon/type, node count, and touched bricks/entities
    const wfCard = screen.getByTestId("backend-map-workflow-card-wf-project-audit");
    expect(wfCard.textContent).toContain("Project Audit Trail Flow");
    expect(wfCard.textContent).toContain("2 nodes");
    expect(wfCard.textContent).toContain("audit-trail");
    expect(wfCard.textContent).toContain("projects");
  });

  it("2. clicking a brick, entity, or workflow on the Backend Map opens its Inspector or navigates to its dedicated tab (AC 2, AC 6)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: b2bBlueprint,
    });

    render(<StudioApp />);

    // Click brick card -> opens brick in Right Dock Inspector
    fireEvent.click(screen.getByTestId("backend-map-brick-card-rbac-policy"));
    expect(screen.getByTestId("inspector-brick-detail").textContent).toContain("rbac-policy");

    // Click "Inspect in Data ->" on entity -> navigates to Data tab with entity selected in Inspector
    fireEvent.click(screen.getByTestId("backend-map-nav-entity-projects"));
    expect(screen.getByTestId("view-data")).toBeDefined();
    expect(screen.getByTestId("inspector-entity-detail").textContent).toContain("Entity: projects");

    // Return to Overview and click "Open Canvas ->" on workflow -> navigates to Workflows tab
    fireEvent.click(screen.getByTestId("nav-tab-overview"));
    fireEvent.click(screen.getByTestId("backend-map-nav-workflow-wf-project-audit"));
    expect(screen.getByTestId("view-workflows")).toBeDefined();
    expect(screen.getByTestId("inspector-workflow-detail").textContent).toContain("Project Audit Trail Flow");
  });

  it("3. renders Readiness & Needs issues when dependencies or secrets are missing and links each issue to the target brick (AC 3, AC 6)", () => {
    const incompleteBlueprint: BlueprintState = {
      schemaVersion: 2,
      project: "needs-setup-app",
      identity: "stub",
      // rbac-policy requires workspace-context, which is not enabled
      bricks: [{ id: "rbac-policy", config: {} }],
      entities: [
        {
          name: "invoices",
          workspaceScoped: true,
          fields: [{ name: "amount", type: "number", required: true }],
        },
      ],
      workflows: [],
      secretRefs: [],
    };

    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: incompleteBlueprint,
    });

    render(<StudioApp />);

    expect(screen.getByTestId("backend-map-brick-status-rbac-policy").textContent).toContain("Needs setup");
    const missingCapNeed = screen.getByTestId("readiness-need-MISSING_CAPABILITY_PROVIDER");
    expect(missingCapNeed.textContent).toContain('rbac-policy requires "workspace-context"');

    const missingEntityHandler = screen.getByTestId("readiness-need-MISSING_ENTITY_HANDLER");
    expect(missingEntityHandler.textContent).toContain("no enabled brick handles them");

    // Clicking Inspect -> on MISSING_CAPABILITY_PROVIDER navigates to Bricks and selects rbac-policy
    fireEvent.click(screen.getByTestId("readiness-need-link-MISSING_CAPABILITY_PROVIDER"));
    expect(screen.getByTestId("view-bricks")).toBeDefined();
    expect(screen.getByTestId("inspector-brick-detail").textContent).toContain("rbac-policy");
  });

  it("4. toggles the Accessible Outline View exposing a semantic landmark region and tree list (AC 4, AC 6)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: b2bBlueprint,
    });

    render(<StudioApp />);

    expect(screen.queryByRole("region", { name: "Backend Map Outline" })).toBeNull();

    fireEvent.click(screen.getByTestId("backend-map-outline-toggle"));

    const outlineRegion = screen.getByRole("region", { name: "Backend Map Outline" });
    expect(outlineRegion).toBeDefined();
    expect(outlineRegion.textContent).toContain("Identity Provider:");
    expect(outlineRegion.textContent).toContain("Enabled Bricks (8)");
    expect(outlineRegion.textContent).toContain("Capability Wiring");
  });

  it("5. renders the Empty Project onboarding state with MCP connection snippet when bricks.length === 0 and persists preset via POST /api/projects/:project/import (AC 5, AC 6)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/orgs/") && url.endsWith("/projects")) {
        return new Response(
          JSON.stringify({
            project: "fresh-saas",
            orgId: "org_1",
            revision: 0,
            state: createEmptyBlueprintState("fresh-saas"),
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/import")) {
        return new Response(
          JSON.stringify({
            project: "fresh-saas",
            revision: 1,
            state: PRESET_BLUEPRINTS["b2b-workspace-app"]!,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/revisions")) {
        return new Response(JSON.stringify({ revisions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "fresh-saas",
      projectState: createEmptyBlueprintState("fresh-saas"),
    });

    render(<StudioApp />);

    expect(screen.getByTestId("overview-empty-state")).toBeDefined();
    const snippet = screen.getByTestId("mcp-connection-snippet");
    expect(snippet.textContent).toContain("mcpServers");
    expect(snippet.textContent).toContain("projectx-studio");

    // Clicking a preset button calls POST /api/projects/:project/import and loads the preset onto the Backend Map
    fireEvent.click(screen.getByTestId("load-preset-b2b-workspace-app"));
    await waitFor(() => {
      expect(screen.getByTestId("overview-backend-map")).toBeDefined();
    });
  });

  it("6. surfaces an accessible error banner (role='alert') when POST /api/projects/:project/import fails instead of fabricating fake state", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/import")) {
        return new Response(
          JSON.stringify({
            error: { message: "Database unavailable during preset import" },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "fresh-saas",
      projectState: createEmptyBlueprintState("fresh-saas"),
    });

    render(<StudioApp />);
    fireEvent.click(screen.getByTestId("load-preset-b2b-workspace-app"));

    await waitFor(() => {
      const alert = screen.getByTestId("preset-error-banner");
      expect(alert.getAttribute("role")).toBe("alert");
      expect(alert.textContent).toContain("Database unavailable during preset import");
    });
    expect(screen.getByTestId("overview-empty-state")).toBeDefined();
  });
});
