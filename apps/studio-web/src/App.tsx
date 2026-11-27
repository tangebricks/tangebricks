import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { createStudioQueryClient, fetchAuthMe, fetchStudioOrgs, fetchStudioProjects } from "./api.ts";
import { AuthScreen } from "./components/AuthScreen.tsx";
import { StudioShell } from "./components/StudioShell.tsx";
import type { StudioShellProps } from "./components/StudioShell.tsx";
import { createSynthetic200NodeBlueprint } from "./components/WorkflowCanvasView.tsx";
import { useStudioStore } from "./store.ts";
import type { StudioState } from "./store.ts";

// Dev-only test hooks; see the `import.meta.env.DEV` block in StudioApp.
declare global {
  interface Window {
    __STUDIO_STORE__?: typeof useStudioStore;
    __STUDIO_BOOTSTRAP__?: Partial<StudioState>;
  }
}

export function StudioApp(props: StudioShellProps = {}) {
  const queryClient = useMemo(() => createStudioQueryClient(), []);
  const user = useStudioStore((s) => s.user);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      // Test-only hooks for the e2e suite and the jsdom unit tests. `import.meta.env.DEV` is a literal `false` in a
      // production `vite build`, so this whole block (and the fake benchmark session) is dropped from the bundle.
      if (import.meta.env.DEV) {
        window.__STUDIO_STORE__ = useStudioStore;
        if (window.__STUDIO_BOOTSTRAP__) {
          useStudioStore.getState().resetStore(window.__STUDIO_BOOTSTRAP__);
          return;
        }
        if (params.get("benchmark") === "200") {
          const synthetic = createSynthetic200NodeBlueprint();
          useStudioStore.getState().resetStore({
            user: { id: "usr_bench", email: "bench@example.com", name: "Benchmark Runner" },
            orgs: [{ id: "org_bench", slug: "bench", name: "Benchmark Org", role: "owner" }],
            activeOrgId: "org_bench",
            projectState: synthetic,
            activeNav: "workflows",
            activeWorkflowId: "wf-200-nodes",
          });
          return;
        }
      }
      if (!useStudioStore.getState().user) {
        let cancelled = false;
        void (async () => {
          const me = await fetchAuthMe();
          if (cancelled || !me.user || useStudioStore.getState().user) return;
          const orgs = me.orgs.length > 0 ? me.orgs : await fetchStudioOrgs().catch(() => []);
          const projects = await fetchStudioProjects().catch(() => []);
          if (cancelled || useStudioStore.getState().user) return;
          let savedProject: string | null = params.get("project");
          if (!savedProject) {
            try {
              savedProject = window.sessionStorage.getItem("studio:activeProjectId");
            } catch {
              savedProject = null;
            }
          }
          const matchedProject = savedProject && projects.some((p) => p.project === savedProject) ? savedProject : (projects[0]?.project ?? null);
          useStudioStore.getState().setAuth(me.user, orgs, orgs[0]?.id ?? null);
          useStudioStore.getState().setProjects(projects, matchedProject);
          const urlNav = params.get("nav");
          const urlDrawer = params.get("drawer");
          let savedNav: string | null = urlNav;
          if (!savedNav && urlDrawer === "logs") {
            savedNav = "workflows";
          }
          if (!savedNav) {
            try {
              savedNav = window.sessionStorage.getItem("studio:activeNav");
            } catch {
              savedNav = null;
            }
          }
          if (
            savedNav === "overview" ||
            savedNav === "bricks" ||
            savedNav === "data" ||
            savedNav === "workflows" ||
            savedNav === "connections" ||
            savedNav === "history"
          ) {
            useStudioStore.getState().setActiveNav(savedNav);
          }
          if (urlDrawer === "logs") {
            useStudioStore.getState().setRunHistoryDrawerOpen(true);
          }
        })();
        return () => {
          cancelled = true;
        };
      }
    }
  }, []);

  return <QueryClientProvider client={queryClient}>{user ? <StudioShell {...props} /> : <AuthScreen />}</QueryClientProvider>;
}

export default StudioApp;
