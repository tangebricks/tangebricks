import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioApp } from "../src/App.tsx";
import { useStudioStore } from "../src/store.ts";
import { PRESET_BLUEPRINTS } from "../src/types.ts";
import type { BlueprintState } from "../src/types.ts";

const sampleBlueprint: BlueprintState = {
  ...PRESET_BLUEPRINTS["b2b-workspace-app"]!,
  workflows: [
    {
      id: "wf-onboarding",
      name: "Workspace Onboarding Flow",
      trigger: { kind: "webhook", path: "/webhooks/onboarding" },
      nodes: [
        { id: "n-trigger", type: "trigger.manual", label: "Onboarding Trigger", data: {} },
        { id: "n-notify", type: "in-app-notifications.send", label: "Send Welcome Alert", data: { channel: "inbox" } },
      ],
      edges: [{ id: "e1", source: "n-trigger", target: "n-notify" }],
    },
  ],
};

describe("Story 2.2: Clean-room apps/studio-web scaffold, login flow, and 3-panel Studio shell", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("1. renders the Better Auth login/signup screen when unauthenticated and transitions to the 3-panel Studio shell on sign-in (AC 1, AC 2, AC 3)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/auth/sign-in/email")) {
        return new Response(
          JSON.stringify({
            user: { id: "usr_asha", email: "asha@example.com", name: "Asha Founder" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/orgs")) {
        return new Response(
          JSON.stringify({
            orgs: [{ id: "org_acme", slug: "acme", name: "Acme Labs", role: "owner" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/projects")) {
        return new Response(
          JSON.stringify({
            projects: [
              {
                project: "b2b-workspace-app",
                orgId: "org_acme",
                revision: 3,
                semanticHash: "abc123",
                updatedAt: "2026-10-28T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    render(<StudioApp />);

    expect(screen.getByTestId("auth-screen")).toBeDefined();
    expect(screen.getByText("Sign in to ProjectX Studio")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "asha@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "CorrectHorseBatteryStaple1!" },
    });
    fireEvent.click(screen.getByTestId("auth-submit-button"));

    await waitFor(() => {
      expect(screen.getByTestId("studio-shell")).toBeDefined();
    });

    expect(fetchSpy).toHaveBeenCalled();
    expect(screen.getByTestId("role-badge").textContent).toBe("Owner");
    expect(screen.getByTestId("env-badge").textContent).toBe("Draft");
    expect(screen.getByTestId("sync-status-chip").textContent).toContain("Live");
  });

  it("2. renders organization role badges (Owner, Admin, Builder, Viewer) and enforces Viewer read-only banner and disabled create/mutate actions (AC 3, AC 4, AC 6)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "viewer@example.com", name: "Meera Viewer" },
      orgs: [
        { id: "org_owner", slug: "owner-org", name: "Owner Org", role: "owner" },
        { id: "org_admin", slug: "admin-org", name: "Admin Org", role: "admin" },
        { id: "org_builder", slug: "builder-org", name: "Builder Org", role: "builder" },
        { id: "org_viewer", slug: "viewer-org", name: "Viewer Org", role: "viewer" },
      ],
      activeOrgId: "org_owner",
      projectState: sampleBlueprint,
    });

    render(<StudioApp />);

    expect(screen.getByTestId("role-badge").textContent).toBe("Owner");
    expect(screen.queryByTestId("viewer-readonly-banner")).toBeNull();
    expect((screen.getByTestId("new-project-button") as HTMLButtonElement).disabled).toBe(false);

    // Switch to Admin org
    fireEvent.change(screen.getByTestId("org-selector"), {
      target: { value: "org_admin" },
    });
    expect(screen.getByTestId("role-badge").textContent).toBe("Admin");

    // Switch to Builder org
    fireEvent.change(screen.getByTestId("org-selector"), {
      target: { value: "org_builder" },
    });
    expect(screen.getByTestId("role-badge").textContent).toBe("Builder");

    // Switch to Viewer org
    fireEvent.change(screen.getByTestId("org-selector"), {
      target: { value: "org_viewer" },
    });
    expect(screen.getByTestId("role-badge").textContent).toBe("Viewer");

    const banner = screen.getByTestId("viewer-readonly-banner");
    expect(banner.textContent).toContain("Read-only access (Viewer role)");

    const newProjectBtn = screen.getByTestId("new-project-button") as HTMLButtonElement;
    expect(newProjectBtn.disabled).toBe(true);
    expect(newProjectBtn.getAttribute("title")).toContain("Viewer role cannot create or mutate projects");
  });

  it("3. switches Main Area views via the Left Navigation Rail and preserves layout with skeleton loading states (AC 4, AC 6)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: sampleBlueprint,
      revisions: [
        {
          revision: 1,
          parentRevision: 0,
          author: { type: "agent", id: "tok_1", client: "claude-desktop" },
          summary: "Enable core bricks and projects entity",
          semanticHash: "hash1",
          createdAt: "2026-10-28T00:00:00.000Z",
        },
      ],
    });

    render(<StudioApp />);

    expect(screen.getByTestId("view-overview")).toBeDefined();

    fireEvent.click(screen.getByTestId("nav-tab-bricks"));
    expect(screen.getByTestId("view-bricks")).toBeDefined();

    fireEvent.click(screen.getByTestId("nav-tab-data"));
    expect(screen.getByTestId("view-data")).toBeDefined();

    fireEvent.click(screen.getByTestId("nav-tab-workflows"));
    expect(screen.getByTestId("view-workflows")).toBeDefined();

    fireEvent.click(screen.getByTestId("nav-tab-history"));
    expect(screen.getByTestId("view-history")).toBeDefined();

    // Verify skeleton loading state preserves shell layout
    useStudioStore.getState().setIsLoadingMain(true);
    fireEvent.click(screen.getByTestId("nav-tab-overview"));
    expect(screen.getByTestId("main-area-skeleton")).toBeDefined();
    expect(screen.getByTestId("studio-topbar")).toBeDefined();
    expect(screen.getByTestId("studio-left-nav")).toBeDefined();
  });

  it("4. toggles Right Dock tabs between Inspector and AI Change Ledger and supports collapsing/expanding (AC 4, AC 6)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: sampleBlueprint,
      revisions: [
        {
          revision: 2,
          parentRevision: 1,
          author: { type: "agent", id: "tok_1", client: "claude-desktop" },
          summary: "Added onboarding workflow",
          semanticHash: "hash2",
          createdAt: "2026-10-28T00:05:00.000Z",
        },
      ],
    });

    render(<StudioApp />);

    expect(screen.getByTestId("right-dock-inspector-panel")).toBeDefined();

    // Switch to AI Change Ledger tab
    fireEvent.click(screen.getByTestId("right-dock-tab-ledger"));
    expect(screen.getByTestId("right-dock-ledger-panel")).toBeDefined();
    expect(screen.getByTestId("ledger-entry-2").textContent).toContain("agent:claude-desktop");

    // Collapse Right Dock
    fireEvent.click(screen.getByTestId("right-dock-toggle"));
    expect(screen.getByTestId("right-dock-collapsed")).toBeDefined();

    // Expand Right Dock
    fireEvent.click(screen.getByTestId("right-dock-toggle"));
    expect(screen.getByTestId("right-dock")).toBeDefined();
  });

  it("5. opens Ctrl/Cmd+K Command Palette, searches across bricks/entities/workflows/nodes/revisions, and navigates + opens Inspector on selection (AC 5, AC 6)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: sampleBlueprint,
      revisions: [
        {
          revision: 4,
          parentRevision: 3,
          author: { type: "human", id: "usr_1" },
          summary: "Configure credit-wallet",
          semanticHash: "hash4",
          createdAt: "2026-10-28T00:10:00.000Z",
        },
      ],
    });

    render(<StudioApp />);

    // Trigger Ctrl+K on window
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByTestId("command-palette-modal")).toBeDefined();

    const searchInput = screen.getByTestId("command-palette-input");
    fireEvent.change(searchInput, { target: { value: "projects" } });

    const entityResult = screen.getByTestId("command-palette-item-entity:projects");
    expect(entityResult).toBeDefined();
    fireEvent.click(entityResult);

    // Command palette closes, activeNav switches to "data", and Inspector opens entity "projects"
    expect(screen.queryByTestId("command-palette-modal")).toBeNull();
    expect(screen.getByTestId("view-data")).toBeDefined();
    expect(screen.getByTestId("inspector-entity-detail").textContent).toContain("Entity: projects");

    // Reopen Command Palette and navigate to a workflow node via keyboard Enter
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const searchInput2 = screen.getByTestId("command-palette-input");
    fireEvent.change(searchInput2, { target: { value: "Send Welcome Alert" } });
    fireEvent.keyDown(screen.getByTestId("command-palette-modal"), { key: "Enter" });

    expect(screen.getByTestId("view-workflows")).toBeDefined();
    expect(screen.getByTestId("inspector-node-detail").textContent).toContain("Send Welcome Alert");
  });
});
