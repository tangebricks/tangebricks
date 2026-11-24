import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  createOrgProject,
  deployProjectToSandbox,
  fetchProjectEnvironments,
  promoteSandboxToByoc,
} from "../api.ts";
import type {
  ProjectDeployEnvironmentRecord,
  StudioSandboxSummaryPayload,
} from "../api.ts";
import { getActiveOrg, getActiveRole, useStudioStore } from "../store.ts";
import { computeStudioValidationIssues, formatRoleLabel } from "../types.ts";
import type { StudioNavTab } from "../types.ts";
import { useLiveProjectSync } from "../useLiveProjectSync.ts";
import { BricksView } from "./BricksView.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { ConnectionsView } from "./ConnectionsView.tsx";
import { DeployPlanModal } from "./DeployPlanModal.tsx";
import { EntitiesView } from "./EntitiesView.tsx";
import { HistoryAndLedgerView } from "./HistoryAndLedgerView.tsx";
import { OverviewBackendMap } from "./OverviewBackendMap.tsx";
import { ProposalReviewBar } from "./ProposalReviewBar.tsx";
import { RightDock } from "./RightDock.tsx";
import { WorkflowCanvasView } from "./WorkflowCanvasView.tsx";

export interface StudioShellProps {
  renderOverview?: () => ReactNode;
  renderBricks?: () => ReactNode;
  renderData?: () => ReactNode;
  renderWorkflows?: () => ReactNode;
  renderConnections?: () => ReactNode;
  renderHistory?: () => ReactNode;
}

const NAV_ITEMS: Array<{
  id: StudioNavTab;
  label: string;
  subtitle: string;
  icon: string;
}> = [
  { id: "overview", label: "Overview", subtitle: "Backend Map", icon: "◈" },
  { id: "bricks", label: "Bricks", subtitle: "Capabilities & Catalog", icon: "▣" },
  { id: "data", label: "Data", subtitle: "Entities & Tables", icon: "▤" },
  { id: "workflows", label: "Workflows", subtitle: "Graph Canvas", icon: "☍" },
  { id: "connections", label: "Connections", subtitle: "Secrets & Vault", icon: "🔐" },
  { id: "history", label: "History", subtitle: "Revisions & Ledger", icon: "◷" },
];

export function StudioShell({
  renderOverview,
  renderBricks,
  renderData,
  renderWorkflows,
  renderConnections,
  renderHistory,
}: StudioShellProps = {}) {
  const user = useStudioStore((s) => s.user);
  const orgs = useStudioStore((s) => s.orgs);
  const activeOrgId = useStudioStore((s) => s.activeOrgId);
  const projects = useStudioStore((s) => s.projects);
  const activeProjectId = useStudioStore((s) => s.activeProjectId);
  const currentRevision = useStudioStore((s) => s.currentRevision);
  const projectState = useStudioStore((s) => s.projectState);
  const readiness = useStudioStore((s) => s.readiness);
  const revisions = useStudioStore((s) => s.revisions);
  const catalog = useStudioStore((s) => s.catalog);
  const secrets = useStudioStore((s) => s.secrets);
  const activeNav = useStudioStore((s) => s.activeNav);
  const syncStatus = useStudioStore((s) => s.syncStatus);
  const isLoadingMain = useStudioStore((s) => s.isLoadingMain);
  const presence = useStudioStore((s) => s.presence);
  const followAi = useStudioStore((s) => s.followAi);
  const liveAnnouncement = useStudioStore((s) => s.liveAnnouncement);
  const issuesDrawerOpen = useStudioStore((s) => s.issuesDrawerOpen);
  const undoStack = useStudioStore((s) => s.undoStack);
  const redoStack = useStudioStore((s) => s.redoStack);
  const isMutating = useStudioStore((s) => s.isMutating);

  const selectOrg = useStudioStore((s) => s.selectOrg);
  const selectProject = useStudioStore((s) => s.selectProject);
  const setProjects = useStudioStore((s) => s.setProjects);
  const setProjectData = useStudioStore((s) => s.setProjectData);
  const setActiveNav = useStudioStore((s) => s.setActiveNav);
  const setCommandPaletteOpen = useStudioStore((s) => s.setCommandPaletteOpen);
  const selectItem = useStudioStore((s) => s.selectItem);
  const setFollowAi = useStudioStore((s) => s.setFollowAi);
  const toggleIssuesDrawer = useStudioStore((s) => s.toggleIssuesDrawer);
  const setIssuesDrawerOpen = useStudioStore((s) => s.setIssuesDrawerOpen);
  const jumpToValidationIssue = useStudioStore((s) => s.jumpToValidationIssue);
  const undoLastBatch = useStudioStore((s) => s.undoLastBatch);
  const redoLastBatch = useStudioStore((s) => s.redoLastBatch);
  const loadProjectProposals = useStudioStore((s) => s.loadProjectProposals);
  const startProposalReview = useStudioStore((s) => s.startProposalReview);
  const activeProposalId = useStudioStore((s) => s.activeProposalId);
  const backendMapOutlineMode = useStudioStore((s) => s.backendMapOutlineMode);
  const setBackendMapOutlineMode = useStudioStore(
    (s) => s.setBackendMapOutlineMode,
  );
  const workflowOutlineMode = useStudioStore((s) => s.workflowOutlineMode);
  const setWorkflowOutlineMode = useStudioStore(
    (s) => s.setWorkflowOutlineMode,
  );
  const setLiveAnnouncement = useStudioStore((s) => s.setLiveAnnouncement);
  const setPrefersReducedMotion = useStudioStore(
    (s) => s.setPrefersReducedMotion,
  );

  useLiveProjectSync(true);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mql.matches);
    const onChange = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    return undefined;
  }, [setPrefersReducedMotion]);

  const [newProjectSlug, setNewProjectSlug] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [topBarDeployModalOpen, setTopBarDeployModalOpen] = useState(false);
  const [topBarEnvironments, setTopBarEnvironments] = useState<
    ProjectDeployEnvironmentRecord[]
  >([]);
  const [topBarSandbox, setTopBarSandbox] =
    useState<StudioSandboxSummaryPayload | null>(null);
  const [zeroCredModalOpen, setZeroCredModalOpen] = useState(false);
  const [moveToByocModalOpen, setMoveToByocModalOpen] = useState(false);
  const [deployingSandbox, setDeployingSandbox] = useState(false);
  const [promotingToByoc, setPromotingToByoc] = useState(false);
  const [byocTokenInput, setByocTokenInput] = useState(
    "cf_ut_valid_promote_byoc_token_1234567890",
  );
  const [byocAccountIdInput, setByocAccountIdInput] = useState(
    "abcdef0123456789abcdef0123456789",
  );
  const [byocAccountNameInput, setByocAccountNameInput] = useState(
    "Promoted BYOC Account",
  );
  const [promotedByocResult, setPromotedByocResult] = useState<{
    buildHash: string;
    sandboxBuildHash: string;
    byocBuildHash: string;
    url: string;
    oldSandboxDestroyed: boolean;
    assembleCalledDuringPromote: boolean;
  } | null>(null);

  const activeOrg = getActiveOrg({ orgs, activeOrgId });
  const activeRole = getActiveRole({ orgs, activeOrgId });
  const roleLabel = formatRoleLabel(activeRole);
  const isViewer = activeRole === "viewer";

  const orgProjects = projects.filter(
    (p) => !activeOrg || p.orgId === activeOrg.id,
  );
  const displayProjectName =
    projectState?.project ?? activeProjectId ?? orgProjects[0]?.project ?? "unselected-project";

  useEffect(() => {
    if (
      !displayProjectName ||
      displayProjectName === "unselected-project" ||
      typeof fetch !== "function"
    ) {
      return;
    }
    let cancelled = false;
    const refreshEnvs = () => {
      void fetchProjectEnvironments(displayProjectName, activeOrg?.id)
        .then((res) => {
          if (!cancelled) {
            setTopBarEnvironments(res.environments ?? []);
            setTopBarSandbox(res.sandbox ?? null);
          }
        })
        .catch(() => {
          // Ignore in unit tests without mocked /environments endpoint
        });
    };
    refreshEnvs();
    const onEnvUpdated = () => refreshEnvs();
    const onOpenMoveToByoc = () => setMoveToByocModalOpen(true);
    window.addEventListener("studio:environments-updated", onEnvUpdated);
    window.addEventListener("studio:open-move-to-byoc", onOpenMoveToByoc);
    return () => {
      cancelled = true;
      window.removeEventListener("studio:environments-updated", onEnvUpdated);
      window.removeEventListener("studio:open-move-to-byoc", onOpenMoveToByoc);
    };
  }, [displayProjectName, activeOrg?.id, currentRevision]);

  useEffect(() => {
    if (
      !displayProjectName ||
      displayProjectName === "unselected-project" ||
      typeof fetch !== "function"
    ) {
      return;
    }
    void loadProjectProposals();
  }, [displayProjectName, currentRevision, loadProjectProposals]);

  useEffect(() => {
    if (typeof window !== "undefined" && activeProjectId) {
      try {
        window.sessionStorage.setItem("studio:activeProjectId", activeProjectId);
      } catch {
        // Ignore storage errors
      }
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (typeof window !== "undefined" && activeNav) {
      try {
        window.sessionStorage.setItem("studio:activeNav", activeNav);
      } catch {
        // Ignore storage errors
      }
    }
  }, [activeNav]);

  const validationIssues = useMemo(
    () =>
      computeStudioValidationIssues(projectState, catalog, secrets, readiness),
    [projectState, catalog, secrets, readiness],
  );
  const totalIssueCount = Math.max(
    readiness.needs.length,
    validationIssues.length,
  );
  const isFullyReady = readiness.ready && validationIssues.length === 0;
  const canUndo =
    !isViewer &&
    !isMutating &&
    (undoStack.length > 0 || (revisions.length > 0 && currentRevision > 0));
  const canRedo = !isViewer && !isMutating && redoStack.length > 0;

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        if (activeNav === "overview") {
          const next = !backendMapOutlineMode;
          setBackendMapOutlineMode(next);
          setLiveAnnouncement(
            next
              ? "Backend Map Outline View enabled"
              : "Backend Map Outline View disabled",
          );
        } else {
          const next = !workflowOutlineMode;
          setWorkflowOutlineMode(next);
          setLiveAnnouncement(
            next
              ? "Workflow Outline View enabled"
              : "Workflow Outline View disabled",
          );
        }
        return;
      }
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable =
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        Boolean(target?.isContentEditable);
      if (isEditable || isViewer) return;

      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          void redoLastBatch();
        } else {
          void undoLastBatch();
        }
      } else if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "y"
      ) {
        e.preventDefault();
        void redoLastBatch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    setCommandPaletteOpen,
    activeNav,
    backendMapOutlineMode,
    setBackendMapOutlineMode,
    workflowOutlineMode,
    setWorkflowOutlineMode,
    setLiveAnnouncement,
    isViewer,
    undoLastBatch,
    redoLastBatch,
  ]);

  const handleCreateProject = async () => {
    if (isViewer || !activeOrg) return;
    const urlNewProject =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("newProject")?.trim()
        : null;
    const canUseUrlSlug =
      Boolean(urlNewProject) &&
      !orgProjects.some((p) => p.project === urlNewProject);
    let fallbackIndex = orgProjects.length + 1;
    while (orgProjects.some((p) => p.project === `project-${fallbackIndex}`)) {
      fallbackIndex += 1;
    }
    const slug = (
      newProjectSlug.trim() ||
      (canUseUrlSlug ? urlNewProject! : `project-${fallbackIndex}`)
    )
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    setCreatingProject(true);
    setActionError(null);
    try {
      const created = await createOrgProject(activeOrg.id, slug);
      const nextSummary = {
        project: created.project,
        orgId: activeOrg.id,
        revision: created.revision,
        semanticHash: "initial",
        updatedAt: new Date().toISOString(),
      };
      setProjects([...projects, nextSummary], created.project);
      setProjectData({
        project: created.project,
        revision: created.revision,
        state: created.state,
        readiness: created.readiness,
      });
      setNewProjectSlug("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreatingProject(false);
    }
  };

  const syncChipContent =
    syncStatus === "Live"
      ? { icon: "●", text: "Live", classes: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" }
      : syncStatus === "Connecting…"
        ? { icon: "◌", text: "Connecting…", classes: "bg-sky-400/10 text-sky-300 border-sky-400/30" }
        : { icon: "⚠", text: "Offline", classes: "bg-amber-500/10 text-amber-300 border-amber-500/30" };

  return (
    <div
      data-testid="studio-shell"
      className="min-w-[1280px] min-h-screen bg-surface-base text-text-primary flex flex-col"
    >
      {/* Top Bar (56px height) */}
      <header
        data-testid="studio-topbar"
        className="h-[56px] px-4 bg-surface-raised border-b border-border flex items-center justify-between gap-4 shrink-0"
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-bold text-sm text-text-primary">
            <span className="text-accent">◆</span>
            <span>ProjectX Studio</span>
          </div>

          <span className="text-border-strong">/</span>

          {/* Organization switcher */}
          <div className="flex items-center gap-2">
            <label htmlFor="studio-org-select" className="sr-only">
              Organization
            </label>
            <select
              id="studio-org-select"
              data-testid="org-selector"
              value={activeOrg?.id ?? ""}
              onChange={(e) => selectOrg(e.target.value)}
              className="px-2.5 py-1 rounded bg-surface-control border border-border-strong text-xs text-text-primary"
            >
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name} ({formatRoleLabel(org.role)})
                </option>
              ))}
            </select>

            <span
              data-testid="role-badge"
              className={`px-2 py-0.5 rounded text-[11px] font-bold border ${
                isViewer
                  ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
                  : "bg-surface-control text-text-secondary border-border-strong"
              }`}
            >
              {roleLabel}
            </span>
          </div>

          <span className="text-border-strong">/</span>

          {/* Project switcher */}
          <div className="flex items-center gap-2">
            <label htmlFor="studio-project-select" className="sr-only">
              Project
            </label>
            <select
              id="studio-project-select"
              data-testid="project-selector"
              value={displayProjectName}
              onChange={(e) => selectProject(e.target.value)}
              className="px-2.5 py-1 rounded bg-surface-control border border-border-strong text-xs font-mono text-text-primary"
            >
              {orgProjects.length === 0 ? (
                <option value={displayProjectName}>{displayProjectName}</option>
              ) : (
                orgProjects.map((proj) => (
                  <option key={proj.project} value={proj.project}>
                    {proj.project}
                  </option>
                ))
              )}
            </select>

            <button
              type="button"
              data-testid="new-project-button"
              disabled={isViewer || creatingProject}
              onClick={handleCreateProject}
              title={
                isViewer
                  ? "Viewer role cannot create or mutate projects"
                  : "Create a new empty project in this organization"
              }
              className="px-2.5 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs font-semibold text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              + New Project
            </button>
          </div>

          {/* Environment badge & Current revision */}
          {(() => {
            const previewEnv = topBarEnvironments.find(
              (e) =>
                e.envName === "preview" &&
                e.deployedRev !== null &&
                e.deployedRev !== undefined,
            );
            const prodEnv = topBarEnvironments.find(
              (e) =>
                e.envName === "production" &&
                e.deployedRev !== null &&
                e.deployedRev !== undefined,
            );
            const activeDeployedEnv = prodEnv ?? previewEnv ?? null;
            const envLabel = prodEnv
              ? `Production r${prodEnv.deployedRev}`
              : previewEnv
                ? `Preview r${previewEnv.deployedRev}`
                : "Draft";
            const hasDrift = [previewEnv, prodEnv].some(
              (e) =>
                e &&
                ((e.driftReport && !e.driftReport.inSync) ||
                  e.deployedRev !== currentRevision),
            );
            return (
              <>
                <span
                  data-testid="env-badge"
                  className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                    activeDeployedEnv
                      ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                      : "bg-surface-control border-border-strong text-text-secondary"
                  }`}
                >
                  {envLabel}
                </span>
                {topBarSandbox && topBarSandbox.status === "active" && (
                  <>
                    <span
                      data-testid="topbar-sandbox-badge"
                      data-sandbox-build-hash={topBarSandbox.buildHash}
                      title={`Requests: ${topBarSandbox.dailyRequestCount}/${topBarSandbox.dailyRequestLimit} today · D1 rows: ${topBarSandbox.d1RowCount}/${topBarSandbox.d1RowLimit}`}
                      className="px-2 py-0.5 rounded border bg-sky-500/15 border-sky-500/40 text-sky-200 text-[11px] font-semibold"
                    >
                      Sandbox v{topBarSandbox.revision || 1} ·{" "}
                      {topBarSandbox.remainingDays}d left
                    </span>
                    <span
                      data-testid="sandbox-preview-url"
                      className="px-2 py-0.5 rounded bg-surface-base border border-border font-mono text-[10px] text-sky-300"
                    >
                      {topBarSandbox.previewUrl}
                    </span>
                    <button
                      type="button"
                      data-testid="move-to-byoc-button"
                      disabled={isViewer}
                      onClick={() => setMoveToByocModalOpen(true)}
                      className="px-2.5 py-0.5 rounded bg-amber-400 text-slate-950 font-bold text-[11px] hover:opacity-90 disabled:opacity-40"
                    >
                      Move to my Cloudflare account
                    </button>
                  </>
                )}
                {hasDrift && (
                  <button
                    type="button"
                    data-testid="topbar-drift-badge"
                    onClick={() => setActiveNav("connections")}
                    title="Environment drift detected — click to inspect in Connections & Deploy"
                    className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-[11px] font-bold text-amber-300 hover:bg-amber-500/30"
                  >
                    ⚠ Drift
                  </button>
                )}
              </>
            );
          })()}
          <span
            data-testid="topbar-revision-badge"
            className="px-2 py-0.5 rounded bg-surface-base border border-border font-mono text-[11px] text-accent"
          >
            r{currentRevision}
          </span>
        </div>

        {/* Right side of Top Bar */}
        <div className="flex items-center gap-3">
          {/* Undo / Redo Controls */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="topbar-undo-button"
              disabled={!canUndo}
              onClick={() => void undoLastBatch()}
              title={
                undoStack.length > 0
                  ? `Undo: ${undoStack[undoStack.length - 1]?.summary ?? "last action"} (Ctrl+Z)`
                  : "Undo last revision (Ctrl+Z)"
              }
              className="px-2 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-[11px] font-semibold text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ↶ Undo{undoStack.length > 0 ? ` (${undoStack.length})` : ""}
            </button>
            <button
              type="button"
              data-testid="topbar-redo-button"
              disabled={!canRedo}
              onClick={() => void redoLastBatch()}
              title={
                redoStack.length > 0
                  ? `Redo: ${redoStack[redoStack.length - 1]?.summary ?? "next action"} (Ctrl+Shift+Z)`
                  : "Redo (Ctrl+Shift+Z)"
              }
              className="px-2 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-[11px] font-semibold text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ↷ Redo{redoStack.length > 0 ? ` (${redoStack.length})` : ""}
            </button>
          </div>

          {/* Follow AI Toggle */}
          <button
            type="button"
            data-testid="follow-ai-toggle"
            aria-pressed={followAi}
            onClick={() => setFollowAi(!followAi)}
            className={`px-2.5 py-1 rounded border text-[11px] font-semibold transition ${
              followAi
                ? "bg-sky-400/20 text-sky-200 border-sky-400/50"
                : "bg-surface-control text-text-muted border-border hover:text-text-secondary"
            }`}
          >
            🤖 Follow AI: {followAi ? "On" : "Off"}
          </button>

          {/* Sync status chip */}
          <span
            data-testid="sync-status-chip"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold ${syncChipContent.classes}`}
          >
            <span>{syncChipContent.icon}</span>
            <span>{syncChipContent.text}</span>
          </span>

          {/* Readiness status badge (toggles Issues Drawer) */}
          <button
            type="button"
            data-testid="readiness-badge"
            aria-expanded={issuesDrawerOpen}
            onClick={toggleIssuesDrawer}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-semibold transition ${
              isFullyReady
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20"
                : "bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/25"
            }`}
          >
            <span>{isFullyReady ? "✓" : "⚠"}</span>
            <span>
              {isFullyReady
                ? "Ready"
                : `${totalIssueCount} ${totalIssueCount === 1 ? "issue" : "issues"}`}
            </span>
          </button>

          {/* Presence indicator */}
          <div
            data-testid="presence-indicator"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-surface-control border border-border text-[11px] text-text-secondary"
          >
            <span>👤 {user?.name || user?.email || "Human"}</span>
            {presence
              .filter((p) => p.kind === "agent")
              .map((agent) => (
                <span
                  key={agent.id}
                  className="ml-1 px-1.5 py-0.5 rounded bg-sky-400/15 text-sky-300 font-mono text-[10px]"
                >
                  🤖 {agent.label}
                </span>
              ))}
          </div>

          {/* Command Palette Trigger */}
          <button
            type="button"
            data-testid="command-palette-trigger"
            onClick={() => setCommandPaletteOpen(true)}
            className="px-3 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border-strong text-xs text-text-secondary flex items-center gap-2"
          >
            <span>Search</span>
            <kbd className="px-1.5 py-0.5 rounded bg-surface-base text-[10px] font-mono text-accent">
              Ctrl+K
            </kbd>
          </button>

          {/* Deploy button */}
          <button
            type="button"
            disabled={isViewer}
            data-testid="deploy-button"
            onClick={() => {
              void (async () => {
                try {
                  const envData = await fetchProjectEnvironments(
                    displayProjectName,
                    activeOrg?.id,
                  );
                  if (envData.activeToken) {
                    setTopBarDeployModalOpen(true);
                    return;
                  }
                } catch {
                  // Fallback to zero-credential choice modal
                }
                setZeroCredModalOpen(true);
              })();
            }}
            title={
              isViewer
                ? "Viewer role cannot deploy or connect Cloudflare accounts"
                : "Open Pre-deploy Plan & Diff or Instant Sandbox Preview"
            }
            className="px-3 py-1.5 rounded-md bg-accent text-text-on-accent font-bold text-xs hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Deploy
          </button>
        </div>
      </header>

      {/* Promoted BYOC Confirmation Banner (Story 9.3) */}
      {promotedByocResult && (
        <div
          role="status"
          data-testid="promoted-byoc-banner"
          className="px-4 py-2 bg-emerald-950/80 border-b border-emerald-600/60 text-emerald-200 text-xs flex items-center justify-between gap-4 flex-wrap"
        >
          <div className="flex items-center gap-3 flex-wrap">
            <span>
              ✓ Promoted Sandbox to your Cloudflare account (BYOC preview) — 0 extra{" "}
              <code className="font-mono">assemble()</code> calls!
            </span>
            <span className="font-mono text-[11px]">
              sandboxBuildHash:{" "}
              <strong data-testid="promoted-sandbox-build-hash">
                {promotedByocResult.sandboxBuildHash}
              </strong>
            </span>
            <span className="font-mono text-[11px]">
              byocBuildHash:{" "}
              <strong data-testid="promoted-byoc-build-hash">
                {promotedByocResult.byocBuildHash}
              </strong>
            </span>
            <span className="font-mono text-[11px]">
              oldSandboxDestroyed:{" "}
              <strong data-testid="promoted-old-sandbox-destroyed">
                {String(promotedByocResult.oldSandboxDestroyed)}
              </strong>
            </span>
          </div>
          <button
            type="button"
            onClick={() => setPromotedByocResult(null)}
            className="px-2 py-0.5 rounded bg-emerald-900/60 hover:bg-emerald-800 text-emerald-100 text-[11px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Viewer Role Read-Only Banner */}
      {isViewer && (
        <div
          role="status"
          data-testid="viewer-readonly-banner"
          className="px-4 py-1.5 bg-amber-500/15 border-b border-amber-500/30 text-amber-200 text-xs flex items-center justify-between"
        >
          <span>
            🔒 Read-only access (Viewer role) — project creation and blueprint mutations are disabled.
          </span>
          <span className="font-mono text-[11px]">Role: Viewer</span>
        </div>
      )}

      {/* Draft-Branch Proposal Visual Diff Review Bar / Pending Proposals Banner (Story 7.2) */}
      <ProposalReviewBar />

      {/* Action Error Alert Banner */}
      {actionError && (
        <div
          role="alert"
          data-testid="studio-error-banner"
          className="px-4 py-2 bg-red-950/80 border-b border-red-700 text-red-200 text-xs flex items-center justify-between"
        >
          <span>✕ {actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="px-2 py-0.5 rounded bg-red-900/60 hover:bg-red-800 text-red-100 text-[11px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Top Bar Issues Drawer */}
      {issuesDrawerOpen && (
        <section
          aria-label="Blueprint Validation Issues"
          data-testid="studio-issues-drawer"
          className="px-4 py-3 bg-surface-raised border-b border-amber-500/40 shadow-lg max-h-72 overflow-y-auto space-y-2"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-amber-300">
                {validationIssues.length === 0
                  ? "✓ Blueprint Validation — 0 Issues"
                  : `⚠ Blueprint Validation Issues (${validationIssues.length})`}
              </span>
              <span className="text-[11px] text-text-muted">
                Click any issue to jump directly to the offending brick, entity, node, or field
              </span>
            </div>
            <button
              type="button"
              data-testid="close-issues-drawer"
              onClick={() => setIssuesDrawerOpen(false)}
              className="px-2 py-0.5 rounded bg-surface-control hover:bg-slate-700 border border-border text-[11px] text-text-secondary"
            >
              Close ✕
            </button>
          </div>

          {validationIssues.length === 0 ? (
            <div className="p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300">
              ✓ All brick capabilities, secrets, entity relations, and workflow expressions are valid.
            </div>
          ) : (
            <div className="space-y-1.5">
              {validationIssues.map((issue, idx) => (
                <button
                  key={issue.id}
                  type="button"
                  data-testid={`issue-jump-item-${idx}`}
                  data-issue-target={
                    issue.nodeId ?? issue.brickId ?? issue.entityName ?? issue.id
                  }
                  onClick={() => jumpToValidationIssue(issue)}
                  className="w-full p-2.5 rounded bg-surface-base hover:bg-surface-control border border-amber-500/30 text-left flex items-center justify-between gap-3 transition"
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    <span
                      className={`mt-0.5 font-bold text-xs ${
                        issue.severity === "error"
                          ? "text-rose-400"
                          : "text-amber-300"
                      }`}
                    >
                      {issue.severity === "error" ? "✕" : "⚠"}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-mono text-[10px] uppercase">
                          {issue.category}
                        </span>
                        <span className="font-mono text-[10px] text-text-muted">
                          {issue.code}
                        </span>
                        {(issue.brickId ||
                          issue.nodeId ||
                          issue.entityName ||
                          issue.workflowId) && (
                          <span
                            data-testid={`issue-jump-target-${issue.nodeId ?? issue.brickId ?? issue.entityName ?? issue.workflowId}`}
                            className="px-1.5 py-0.5 rounded bg-surface-control border border-border font-mono text-[10px] text-accent"
                          >
                            {issue.nodeId
                              ? `node:${issue.nodeId}`
                              : issue.brickId
                                ? `brick:${issue.brickId}`
                                : issue.entityName
                                  ? `entity:${issue.entityName}`
                                  : `workflow:${issue.workflowId}`}
                            {issue.fieldKey ? `.${issue.fieldKey}` : ""}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-text-primary mt-1">
                        {issue.message}
                      </div>
                      {issue.suggestedFix && (
                        <div className="text-[11px] text-text-muted mt-0.5">
                          Fix: {issue.suggestedFix}
                        </div>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 px-2 py-1 rounded bg-amber-500/15 text-amber-200 border border-amber-500/30 text-[11px] font-semibold">
                    Jump to field →
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 3-panel body: Left Nav Rail + Main Area + Right Dock */}
      <div className="flex-1 flex min-h-0">
        {/* Left Navigation Rail (256px width) */}
        <nav
          aria-label="Studio Navigation"
          data-testid="studio-left-nav"
          className="w-[256px] shrink-0 bg-surface-raised border-r border-border p-3 flex flex-col justify-between"
        >
          <div className="space-y-1">
            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-text-muted">
              Project Workspace
            </div>
            {NAV_ITEMS.map((item) => {
              const active = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`nav-tab-${item.id}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setActiveNav(item.id)}
                  className={`w-full px-3 py-2 rounded-md text-left flex items-center gap-3 transition ${
                    active
                      ? "bg-surface-control text-accent font-bold border border-amber-500/40"
                      : "text-text-secondary hover:bg-surface-control/60 hover:text-text-primary border border-transparent"
                  }`}
                >
                  <span className="text-sm">{item.icon}</span>
                  <div>
                    <div className="text-xs leading-tight">{item.label}</div>
                    <div className="text-[10px] text-text-muted font-normal">
                      {item.subtitle}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="p-2.5 rounded bg-surface-base border border-border text-[11px] text-text-muted space-y-1">
            <div className="font-semibold text-text-secondary">
              Project: <span className="font-mono">{displayProjectName}</span>
            </div>
            <div>
              Bricks: {projectState?.bricks.length ?? 0} · Entities:{" "}
              {projectState?.entities.length ?? 0} · Workflows:{" "}
              {projectState?.workflows.length ?? 0}
            </div>
          </div>
        </nav>

        {/* Main Area */}
        <main
          data-testid="main-area"
          className="flex-1 bg-surface-canvas overflow-y-auto p-6"
        >
          {isLoadingMain ? (
            <div
              data-testid="main-area-skeleton"
              aria-busy="true"
              aria-label="Loading active view"
              className="space-y-4 animate-pulse"
            >
              <div className="h-7 w-64 rounded bg-surface-control" />
              <div className="grid grid-cols-3 gap-4">
                <div className="h-32 rounded-lg bg-surface-raised border border-border" />
                <div className="h-32 rounded-lg bg-surface-raised border border-border" />
                <div className="h-32 rounded-lg bg-surface-raised border border-border" />
              </div>
              <div className="h-64 rounded-lg bg-surface-raised border border-border" />
            </div>
          ) : activeNav === "overview" ? (
            renderOverview ? (
              renderOverview()
            ) : (
              <div data-testid="view-overview">
                <OverviewBackendMap />
              </div>
            )
          ) : activeNav === "bricks" ? (
            renderBricks ? (
              renderBricks()
            ) : (
              <BricksView />
            )
          ) : activeNav === "data" ? (
            renderData ? (
              renderData()
            ) : (
              <EntitiesView />
            )
          ) : activeNav === "workflows" ? (
            renderWorkflows ? (
              renderWorkflows()
            ) : (
              <WorkflowCanvasView />
            )
          ) : activeNav === "connections" ? (
            renderConnections ? (
              renderConnections()
            ) : (
              <ConnectionsView />
            )
          ) : renderHistory ? (
            renderHistory()
          ) : (
            <HistoryAndLedgerView />
          )}
        </main>

        {/* Collapsible Right Dock */}
        <RightDock />
      </div>

      {/* Screen-reader live sync announcer */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="live-sync-announcer"
        className="sr-only"
      >
        {liveAnnouncement}
      </div>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="studio-aria-live-region"
        className="sr-only"
      >
        {liveAnnouncement}
      </div>

      {/* Ctrl/Cmd+K Command Palette Modal */}
      <CommandPalette />

      {/* Pre-deploy Plan & Diff Modal triggered from Top Bar Deploy button */}
      <DeployPlanModal
        open={topBarDeployModalOpen}
        projectSlug={displayProjectName}
        orgId={activeOrg?.id}
        initialEnvName="preview"
        onClose={() => setTopBarDeployModalOpen(false)}
        onDeployed={() => {
          window.dispatchEvent(new CustomEvent("studio:environments-updated"));
        }}
      />

      {/* Story 9.3: Zero-Credential Deploy Choice Modal */}
      {zeroCredModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Deploy Backend"
          data-testid="zero-credential-deploy-modal"
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-xl rounded-xl bg-surface-raised border border-border-strong shadow-2xl p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-text-primary">
                  Deploy Your Backend
                </h2>
                <p className="text-xs text-text-secondary mt-1">
                  Try a live preview immediately with zero credentials, or connect your own Cloudflare account (BYOC).
                </p>
              </div>
              <button
                type="button"
                data-testid="close-zero-cred-modal"
                onClick={() => setZeroCredModalOpen(false)}
                className="px-2 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border text-xs text-text-secondary"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <button
                type="button"
                data-testid="deploy-instant-sandbox-button"
                disabled={deployingSandbox || isViewer}
                onClick={() => {
                  void (async () => {
                    setDeployingSandbox(true);
                    setActionError(null);
                    try {
                      const res = await deployProjectToSandbox(
                        displayProjectName,
                        { orgId: activeOrg?.id },
                      );
                      setTopBarSandbox(res.sandbox);
                      setZeroCredModalOpen(false);
                      window.dispatchEvent(
                        new CustomEvent("studio:environments-updated"),
                      );
                    } catch (err) {
                      setActionError(
                        err instanceof Error
                          ? err.message
                          : "Failed to deploy instant sandbox preview",
                      );
                    } finally {
                      setDeployingSandbox(false);
                    }
                  })();
                }}
                className="w-full p-4 rounded-lg bg-accent text-text-on-accent font-bold text-left hover:opacity-90 disabled:opacity-50 transition space-y-1"
              >
                <div className="text-sm">
                  {deployingSandbox
                    ? "Provisioning Instant Sandbox Preview…"
                    : "Try in Instant Sandbox Preview (No Cloudflare account needed — free for 7 days)"}
                </div>
                <div className="text-xs font-normal opacity-90">
                  Provisions an isolated Workers for Platforms preview at{" "}
                  <code className="font-mono">*.sandbox.projectx.dev</code> with
                  D1 &amp; test-mode integrations in seconds.
                </div>
              </button>

              <button
                type="button"
                data-testid="deploy-connect-byoc-button"
                disabled={isViewer}
                onClick={() => {
                  setZeroCredModalOpen(false);
                  setActiveNav("connections");
                  setTimeout(() => {
                    window.dispatchEvent(
                      new CustomEvent("studio:open-cf-wizard"),
                    );
                  }, 50);
                }}
                className="w-full p-4 rounded-lg bg-surface-base hover:bg-surface-control border border-border-strong text-left transition space-y-1"
              >
                <div className="text-sm font-bold text-text-primary">
                  Connect my Cloudflare account (BYOC)
                </div>
                <div className="text-xs text-text-secondary">
                  Deploy directly into your own Cloudflare Workers &amp; D1
                  account with zero platform lock-in.
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Story 9.3: One-Click "Move to my Cloudflare account" Promotion Modal */}
      {moveToByocModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Move to my Cloudflare account"
          data-testid="move-to-byoc-modal"
          className="fixed inset-0 z-50 bg-slate-950/80 flex items-center justify-center p-4"
        >
          <div className="w-full max-w-xl rounded-xl bg-surface-raised border border-border-strong shadow-2xl p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-text-primary">
                  Move to my Cloudflare account (BYOC)
                </h2>
                <p className="text-xs text-text-secondary mt-1">
                  Promotes your exact verified Sandbox artifact (
                  <code className="font-mono text-amber-300">
                    {topBarSandbox?.buildHash ?? "cached-build"}
                  </code>
                  ) into your own Cloudflare account without re-running{" "}
                  <code className="font-mono">assemble()</code>, then tears down
                  the temporary sandbox.
                </p>
              </div>
              <button
                type="button"
                data-testid="close-move-to-byoc-modal"
                onClick={() => setMoveToByocModalOpen(false)}
                className="px-2 py-1 rounded bg-surface-control hover:bg-slate-700 border border-border text-xs text-text-secondary"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label
                  htmlFor="move-to-byoc-token-input"
                  className="block font-semibold text-text-secondary mb-1"
                >
                  Cloudflare API Token (Workers Scripts:Edit, D1:Edit, Queues:Edit)
                </label>
                <input
                  id="move-to-byoc-token-input"
                  data-testid="move-to-byoc-token-input"
                  type="password"
                  value={byocTokenInput}
                  onChange={(e) => setByocTokenInput(e.target.value)}
                  placeholder="cf_ut_..."
                  className="w-full px-3 py-2 rounded bg-surface-base border border-border-strong font-mono text-xs text-text-primary"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="move-to-byoc-account-id-input"
                    className="block font-semibold text-text-secondary mb-1"
                  >
                    Cloudflare Account ID
                  </label>
                  <input
                    id="move-to-byoc-account-id-input"
                    data-testid="move-to-byoc-account-id-input"
                    type="text"
                    value={byocAccountIdInput}
                    onChange={(e) => setByocAccountIdInput(e.target.value)}
                    className="w-full px-3 py-1.5 rounded bg-surface-base border border-border font-mono text-xs text-text-primary"
                  />
                </div>
                <div>
                  <label
                    htmlFor="move-to-byoc-account-name-input"
                    className="block font-semibold text-text-secondary mb-1"
                  >
                    Account Label
                  </label>
                  <input
                    id="move-to-byoc-account-name-input"
                    data-testid="move-to-byoc-account-name-input"
                    type="text"
                    value={byocAccountNameInput}
                    onChange={(e) => setByocAccountNameInput(e.target.value)}
                    className="w-full px-3 py-1.5 rounded bg-surface-base border border-border text-xs text-text-primary"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={() => setMoveToByocModalOpen(false)}
                className="px-3 py-1.5 rounded bg-surface-control border border-border text-xs text-text-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="move-to-byoc-submit-button"
                disabled={promotingToByoc || isViewer}
                onClick={() => {
                  void (async () => {
                    setPromotingToByoc(true);
                    setActionError(null);
                    try {
                      const res = await promoteSandboxToByoc(
                        displayProjectName,
                        {
                          orgId: activeOrg?.id,
                          token: byocTokenInput.trim(),
                          accountId: byocAccountIdInput.trim(),
                          accountName: byocAccountNameInput.trim(),
                        },
                      );
                      setPromotedByocResult({
                        buildHash: res.buildHash,
                        sandboxBuildHash: res.sandboxBuildHash,
                        byocBuildHash: res.byocBuildHash ?? res.buildHash,
                        url: res.byocDeploy?.url ?? "",
                        oldSandboxDestroyed: res.oldSandboxDestroyed ?? true,
                        assembleCalledDuringPromote:
                          res.assembleCalledDuringPromote ?? false,
                      });
                      setTopBarSandbox(null);
                      if (res.environment) {
                        setTopBarEnvironments([res.environment]);
                      }
                      setMoveToByocModalOpen(false);
                      window.dispatchEvent(
                        new CustomEvent("studio:environments-updated"),
                      );
                    } catch (err) {
                      setActionError(
                        err instanceof Error
                          ? err.message
                          : "Failed to promote sandbox to BYOC",
                      );
                    } finally {
                      setPromotingToByoc(false);
                    }
                  })();
                }}
                className="px-4 py-1.5 rounded bg-amber-400 text-slate-950 font-bold text-xs hover:opacity-90 disabled:opacity-50"
              >
                {promotingToByoc
                  ? "Promoting to BYOC…"
                  : "Promote Sandbox to My Cloudflare Account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
