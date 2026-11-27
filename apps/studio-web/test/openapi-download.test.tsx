import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConnectionsView } from "../src/components/ConnectionsView.tsx";
import { DeployPlanModal } from "../src/components/DeployPlanModal.tsx";
import { OverviewBackendMap } from "../src/components/OverviewBackendMap.tsx";
import { useStudioStore } from "../src/store.ts";

describe("Story 10.5 — Studio Web Download OpenAPI 3.1 Spec button", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "dev@example.com", name: "Developer" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "invoice-flow",
      currentRevision: 3,
      projectState: {
        schemaVersion: 2,
        project: "invoice-flow",
        identity: "stub",
        bricks: [
          { id: "multi-workspace", config: {} },
          { id: "credit-wallet", config: {} },
        ],
        entities: [],
        workflows: [],
        secretRefs: [],
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("renders Download OpenAPI 3.1 Spec button in Project Overview and fetches /api/projects/:project/openapi.json", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            openapi: "3.1.0",
            info: { title: "invoice-flow", version: "0.0.0" },
            paths: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    render(<OverviewBackendMap />);

    const btn = screen.getByTestId("download-openapi-btn");
    expect(btn).toBeDefined();
    expect(btn.getAttribute("data-openapi-url")).toBe("/api/projects/invoice-flow/openapi.json");

    fireEvent.click(btn);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/projects/invoice-flow/openapi.json", expect.objectContaining({ credentials: "include" }));
    });
  });

  test("renders Download OpenAPI 3.1 Spec button in DeployPlanModal and ConnectionsView", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/connections/requests")) {
        return new Response(JSON.stringify({ requests: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/connections")) {
        return new Response(JSON.stringify({ connections: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/secrets")) {
        return new Response(JSON.stringify({ secrets: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          openapi: "3.1.0",
          info: { title: "invoice-flow", version: "0.0.0" },
          paths: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const { unmount } = render(<DeployPlanModal open={true} projectSlug="invoice-flow" orgId="org_1" onClose={() => {}} />);

    const modalBtn = screen.getByTestId("download-openapi-btn");
    expect(modalBtn).toBeDefined();
    expect(modalBtn.getAttribute("data-openapi-url")).toBe("/api/projects/invoice-flow/openapi.json?rev=3");
    fireEvent.click(modalBtn);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith("/api/projects/invoice-flow/openapi.json?rev=3", expect.objectContaining({ credentials: "include" }));
    });

    unmount();

    render(<ConnectionsView />);
    const cardBtn = screen.getByTestId("download-openapi-btn");
    expect(cardBtn).toBeDefined();
  });
});
