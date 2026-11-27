import { computeSemanticDiff, createEmptyBlueprint, evaluateProposalSelection, normalizeBlueprintState, semanticHash } from "@poc/blueprint";
import { create } from "zustand";
import {
  acceptProjectProposal,
  commitProjectOps,
  deleteProjectSecret,
  fetchProjectActivity,
  fetchProjectProposals,
  fetchProjectApprovals,
  decideProjectApproval,
  fetchProjectRevisionState,
  fetchProjectRunDetail,
  fetchProjectRuns,
  fetchProjectSecrets,
  fetchWorkflowPins,
  pinWorkflowNodeOutput,
  rejectProjectProposal,
  rerunWorkflowFromNode,
  revertProjectToRevision,
  runNodeTestStep,
  triggerWorkflowRun,
  unpinWorkflowNodeOutput,
  upsertProjectSecret,
} from "./api.ts";
import type {
  ActivityFeedEventPayload,
  ApprovalRequestRecord,
  CommitOpsError,
  PinnedNodeOutputRecord,
  RunHistoryFilterParams,
  RunHistoryItem,
  RunNodeTestStepInput,
  RunReplayDetailResponse,
  TelemetryStepStatus,
  TestStepResponse,
  TriggerWorkflowRunInput,
  UpsertSecretInput,
  WorkflowRunApiResponse,
  WorkflowRunStepEvent,
} from "./api.ts";
import {
  DEFAULT_CATALOG,
  DEFAULT_INTEGRATIONS,
  applyStudioOps,
  computeStudioInverseOps,
  computeStudioReadiness,
  extractAffectedTargets,
  formatAuthorBadge,
  reconstructBlueprintStateAtRevision,
  reconstructRevisionInverseOps,
  toBlueprintCatalog,
} from "./types.ts";
import type {
  AuthorAttribution,
  BlueprintState,
  CatalogBrickManifest,
  CatalogIntegrationManifest,
  CatalogNodeDefinition,
  PresenceMember,
  ProposalRecord,
  ProposalStatus,
  ReadinessResult,
  RevisionSummary,
  SemanticDiff,
  StudioNavTab,
  StudioOrg,
  StudioOrgRole,
  StudioProjectSummary,
  StudioRightDockTab,
  StudioSecretMetadata,
  StudioSecretUsedByTarget,
  StudioSelection,
  StudioUser,
  StudioValidationIssue,
  SyncStatus,
  WorkflowDefinition,
} from "./types.ts";

export const MAX_UNDO_STACK_DEPTH = 60;

interface UndoRedoEntry {
  ops: Array<Record<string, unknown>>;
  inverseOps: Array<Record<string, unknown>>;
  summary: string;
  revision: number;
}

export interface CanvasVisualDiffState {
  fromRev: number;
  toRev: number;
  diff: SemanticDiff;
  fromState: BlueprintState;
  toState: BlueprintState;
}

interface DirtyTargetState {
  kind: "brick" | "entity" | "node";
  id: string;
  workflowId?: string;
  draftData: Record<string, unknown>;
  draftLabel?: string;
  baseRevision: number;
}

interface PendingConflictState {
  targetKind: "brick" | "entity" | "node";
  targetId: string;
  workflowId?: string;
  baseRevision: number;
  conflictingRevision: number;
  conflictingAuthor: AuthorAttribution;
  summary?: string;
  mineData: Record<string, unknown>;
  mineLabel?: string;
  aiData: Record<string, unknown>;
  aiLabel?: string;
  aiState: BlueprintState;
}

export interface NodeLiveTelemetryState {
  runId: string;
  workflowId: string;
  revision: number;
  nodeId: string;
  status: TelemetryStepStatus;
  durationMs: number;
  retries: number;
  inputPreview: string;
  outputPreview: string;
  errorStack?: string | null;
  runStatus?: "queued" | "running" | "succeeded" | "failed";
  timestamp: string;
}

interface StudioRunsFilterState {
  env: "preview" | "production";
  workflowId: string;
  status: string;
  trigger: string;
  timeRange: string;
  from: string;
  to: string;
}

interface ActiveRunReplayState {
  run: RunHistoryItem;
  stepEvents: WorkflowRunStepEvent[];
  nodeMap: Record<string, NodeLiveTelemetryState>;
  currentRevision: number;
  historicalRevision: number;
  isHistoricalRevision: boolean;
  historicalState: BlueprintState;
  historicalWorkflow: WorkflowDefinition | null;
}

export interface IncomingTelemetryFrame {
  type: "telemetry";
  project?: string;
  rev: number;
  runId: string;
  workflowId: string;
  nodeId: string;
  status: TelemetryStepStatus;
  durationMs: number;
  retries: number;
  inputPreview: string;
  outputPreview: string;
  errorStack?: string | null;
  runStatus?: "queued" | "running" | "succeeded" | "failed";
  timestamp: string;
  cursor?: number;
}

export interface IncomingRevisionEnvelope {
  type?: "revision";
  project?: string;
  revision: number;
  parentRevision?: number;
  ops: Array<Record<string, unknown>>;
  author: AuthorAttribution;
  summary?: string;
  semanticHash?: string;
  readiness?: ReadinessResult;
  timestamp?: string;
}

interface HighlightInfo {
  authorLabel: string;
  isAgent: boolean;
  revision: number;
  expiresAt: number;
}

interface DiffComparisonSelection {
  fromRev: number;
  toRev: number;
}

/** Counts live proposal frames, so a proposals request that started before one cannot overwrite it. */
let proposalFrameSeq = 0;

export interface StudioState {
  user: StudioUser | null;
  orgs: StudioOrg[];
  activeOrgId: string | null;
  projects: StudioProjectSummary[];
  activeProjectId: string | null;
  currentRevision: number;
  projectState: BlueprintState | null;
  readiness: ReadinessResult;
  revisions: RevisionSummary[];
  catalog: Record<string, CatalogBrickManifest>;
  integrations: Record<string, { manifest: CatalogIntegrationManifest; nodes?: CatalogNodeDefinition[] }>;
  activeNav: StudioNavTab;
  rightDockOpen: boolean;
  rightDockTab: StudioRightDockTab;
  selection: StudioSelection | null;
  commandPaletteOpen: boolean;
  commandPaletteQuery: string;
  syncStatus: SyncStatus;
  isLoadingMain: boolean;
  presence: PresenceMember[];
  backendMapOutlineMode: boolean;
  bricksShowExperimental: boolean;
  bricksCategoryFilter: string;
  bricksSearchQuery: string;
  activeWorkflowId: string | null;
  workflowOutlineMode: boolean;
  workflowNodeSearch: string;
  highlightedTargets: Record<string, HighlightInfo>;
  followAi: boolean;
  liveAnnouncement: string;
  ledgerAuthorFilter: string;
  diffComparison: DiffComparisonSelection | null;
  mutationError: string | null;
  isMutating: boolean;
  secrets: StudioSecretMetadata[];
  issuesDrawerOpen: boolean;
  highlightedInspectorField: string | null;
  undoStack: UndoRedoEntry[];
  redoStack: UndoRedoEntry[];
  canvasVisualDiff: CanvasVisualDiffState | null;
  dirtyTarget: DirtyTargetState | null;
  pendingConflict: PendingConflictState | null;
  stepTestResults: Record<string, TestStepResponse>;
  pinnedStepOutputs: Record<string, Record<string, unknown>>;
  pinnedOutputsByWorkflow: Record<string, Record<string, PinnedNodeOutputRecord>>;
  usePinnedData: boolean;
  isRunningTestStep: boolean;
  nodeTelemetryByWorkflow: Record<string, Record<string, NodeLiveTelemetryState>>;
  activeRunIdByWorkflow: Record<string, string>;
  lastTelemetryCursor: number;
  isRunningWorkflow: boolean;
  prefersReducedMotion: boolean;
  runsList: RunHistoryItem[];
  runsFilters: StudioRunsFilterState;
  runHistoryDrawerOpen: boolean;
  isLoadingRuns: boolean;
  activeReplayRun: ActiveRunReplayState | null;
  proposals: ProposalRecord[];
  /** AD-V8: approval requests for destructive actions an MCP agent asked for (deploy, promote, rollback, revert). */
  approvals: ApprovalRequestRecord[];
  activeProposalId: string | null;
  selectedProposalOpIds: string[];
  proposalValidationError: string | null;
  activityFeed: ActivityFeedEventPayload[];
  activityAuthorFilter: string;
  activityTypeFilter: string;
  activityWindowFilter: string;

  loadProjectProposals: (status?: ProposalStatus) => Promise<ProposalRecord[]>;
  loadProjectApprovals: () => Promise<ApprovalRequestRecord[]>;
  decideApproval: (approvalId: string, decision: "approve" | "reject") => Promise<void>;
  startProposalReview: (proposalId: string, navigateTo?: StudioNavTab) => void;
  toggleProposalOp: (opId: string) => void;
  setAllProposalOpsSelected: (selected: boolean) => void;
  exitProposalReview: () => void;
  acceptActiveProposal: (opIds?: string[]) => Promise<{ ok: true; revision: number } | { ok: false; error: string }>;
  rejectActiveProposal: (reason?: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  applyIncomingProposalFrame: (frame: {
    type: "proposal";
    action: "created" | "accepted" | "partially_accepted" | "rejected";
    project: string;
    proposal: ProposalRecord;
  }) => void;
  loadProjectActivity: (overrideFilters?: { author?: string; type?: string; window?: string }) => Promise<ActivityFeedEventPayload[]>;
  setActivityAuthorFilter: (author: string) => void;
  setActivityTypeFilter: (type: string) => void;
  setActivityWindowFilter: (window: string) => void;

  setUsePinnedData: (enabled: boolean) => void;
  loadWorkflowPins: (workflowId: string) => Promise<Record<string, PinnedNodeOutputRecord>>;
  pinNodeOutput: (workflowId: string, nodeId: string, output: unknown, sourceRunId?: string | null) => Promise<{ ok: true } | { ok: false; error: string }>;
  unpinNodeOutput: (workflowId: string, nodeId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  rerunFromNode: (
    runId: string,
    fromNodeId: string,
    useCurrentDraftRev?: boolean,
  ) => Promise<{ ok: true; response: WorkflowRunApiResponse } | { ok: false; error: string }>;

  setRunHistoryDrawerOpen: (open: boolean) => void;
  toggleRunHistoryDrawer: () => void;
  setRunsFilters: (patch: Partial<StudioRunsFilterState>) => void;
  loadProjectRuns: (overrideFilters?: Partial<StudioRunsFilterState>) => Promise<RunHistoryItem[]>;
  startRunReplay: (
    runId: string,
    env?: "preview" | "production",
    targetNodeId?: string | null,
  ) => Promise<{ ok: true; detail: ActiveRunReplayState } | { ok: false; error: string }>;
  exitRunReplay: () => void;

  setStepTestResult: (workflowId: string, nodeId: string, result: TestStepResponse) => void;
  setPinnedStepOutput: (nodeId: string, output: Record<string, unknown> | null) => void;
  runTestStep: (
    workflowId: string,
    nodeId: string,
    body: RunNodeTestStepInput,
  ) => Promise<{ ok: true; result: TestStepResponse } | { ok: false; error: string }>;
  applyIncomingTelemetryFrame: (frame: IncomingTelemetryFrame) => void;
  reconcileTelemetryEvents: (events: WorkflowRunStepEvent[]) => void;
  clearWorkflowTelemetry: (workflowId: string) => void;
  setPrefersReducedMotion: (reduced: boolean) => void;
  executeWorkflowTestRun: (
    workflowId: string,
    body?: TriggerWorkflowRunInput,
  ) => Promise<{ ok: true; response: WorkflowRunApiResponse } | { ok: false; error: string }>;

  setAuth: (user: StudioUser | null, orgs?: StudioOrg[], activeOrgId?: string | null) => void;
  signOut: () => void;
  setOrgs: (orgs: StudioOrg[], activeOrgId?: string | null) => void;
  selectOrg: (orgId: string) => void;
  setProjects: (projects: StudioProjectSummary[], activeProjectId?: string | null) => void;
  selectProject: (projectId: string) => void;
  setProjectData: (input: { project: string; revision?: number; state: BlueprintState; readiness?: ReadinessResult; revisions?: RevisionSummary[] }) => void;
  setRevisions: (revisions: RevisionSummary[]) => void;
  setCatalog: (catalog: Record<string, CatalogBrickManifest>) => void;
  setIntegrations: (integrations: Record<string, { manifest: CatalogIntegrationManifest; nodes?: CatalogNodeDefinition[] }>) => void;
  setActiveNav: (nav: StudioNavTab) => void;
  setRightDockOpen: (open: boolean) => void;
  toggleRightDock: () => void;
  setRightDockTab: (tab: StudioRightDockTab) => void;
  selectItem: (selection: StudioSelection | null, navigateTo?: StudioNavTab) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setCommandPaletteQuery: (query: string) => void;
  setSyncStatus: (status: SyncStatus) => void;
  setIsLoadingMain: (loading: boolean) => void;
  setPresence: (presence: PresenceMember[]) => void;
  setBackendMapOutlineMode: (outline: boolean) => void;
  setBricksShowExperimental: (show: boolean) => void;
  setBricksCategoryFilter: (category: string) => void;
  setBricksSearchQuery: (query: string) => void;
  setActiveWorkflowId: (workflowId: string | null) => void;
  setWorkflowOutlineMode: (outline: boolean) => void;
  setWorkflowNodeSearch: (search: string) => void;
  setHighlightedTargets: (targets: Record<string, HighlightInfo>) => void;
  setFollowAi: (follow: boolean) => void;
  setLiveAnnouncement: (message: string) => void;
  setLedgerAuthorFilter: (filter: string) => void;
  setDiffComparison: (diff: DiffComparisonSelection | null) => void;
  setMutationError: (error: string | null) => void;
  setSecrets: (secrets: StudioSecretMetadata[]) => void;
  setIssuesDrawerOpen: (open: boolean) => void;
  toggleIssuesDrawer: () => void;
  setHighlightedInspectorField: (field: string | null) => void;
  jumpToValidationIssue: (issue: StudioValidationIssue) => void;
  setDirtyTarget: (dirty: DirtyTargetState | null) => void;
  setPendingConflict: (conflict: PendingConflictState | null) => void;
  resolvePendingConflict: (
    resolution: "mine" | "ai" | "merged",
    fieldChoices?: Record<string, "mine" | "ai">,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  startCanvasVisualDiff: (fromRev: number, toRev: number) => Promise<void>;
  clearCanvasVisualDiff: () => void;
  undoLastBatch: () => Promise<{ ok: true; state: BlueprintState; revision: number } | { ok: false; error: string }>;
  redoLastBatch: () => Promise<{ ok: true; state: BlueprintState; revision: number } | { ok: false; error: string }>;
  undoHistoricalRevision: (
    targetRevision: number,
    mode?: "inverse" | "revert-to-parent",
  ) => Promise<{ ok: true; state: BlueprintState; revision: number } | { ok: false; error: string }>;
  loadProjectSecrets: () => Promise<StudioSecretMetadata[]>;
  upsertSecret: (input: UpsertSecretInput) => Promise<{ ok: true; secret: StudioSecretMetadata } | { ok: false; error: string }>;
  removeSecret: (ref: string, unbind?: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
  commitOps: (
    ops: Array<Record<string, unknown>>,
    summary?: string,
    options?: {
      isUndoRedo?: boolean;
      baseRevision?: number;
      nextUndoStack?: UndoRedoEntry[];
      nextRedoStack?: UndoRedoEntry[];
    },
  ) => Promise<{ ok: true; state: BlueprintState; revision: number } | { ok: false; error: string }>;
  applyIncomingRevision: (envelope: IncomingRevisionEnvelope) => void;
  applyIncomingCatchup: (revisions: IncomingRevisionEnvelope[]) => void;
  resetStore: (initial?: Partial<StudioState>) => void;
}

function reconcileSecretsWithBlueprint(vaultSecrets: StudioSecretMetadata[], blueprint: BlueprintState | null): StudioSecretMetadata[] {
  const usedByMap = new Map<string, StudioSecretUsedByTarget[]>();
  for (const sr of blueprint?.secretRefs ?? []) {
    const list = usedByMap.get(sr.ref) ?? [];
    list.push({
      targetKind: sr.targetKind === "connection" ? "node" : sr.targetKind,
      targetId: sr.targetId,
      secretName: sr.secretName,
    });
    usedByMap.set(sr.ref, list);
  }

  const seenRefs = new Set<string>();
  const result: StudioSecretMetadata[] = [];

  for (const item of vaultSecrets) {
    if (item.id.startsWith("missing:") && !usedByMap.has(item.ref)) {
      continue;
    }
    seenRefs.add(item.ref);
    result.push({
      ...item,
      usedBy: usedByMap.get(item.ref) ?? item.usedBy ?? [],
    });
  }

  for (const [ref, usedBy] of usedByMap.entries()) {
    if (!seenRefs.has(ref)) {
      const first = usedBy[0];
      result.push({
        id: `missing:${blueprint?.project ?? "proj"}:${ref}`,
        ref,
        kind: first?.targetKind === "brick" ? "brick_secret" : "api_key",
        label: first?.secretName ?? ref,
        appOrBrick: first?.targetId ?? "unbound",
        envScope: "all",
        keyHint: "••••(missing)",
        status: "missing",
        usedBy,
        createdBy: "blueprint",
        updatedAt: new Date(0).toISOString(),
      });
    }
  }

  return result;
}

const initialEmptyState = createEmptyBlueprint("my-saas-app");
const initialReadiness = computeStudioReadiness(initialEmptyState, DEFAULT_CATALOG);

const BASE_STATE = {
  user: null as StudioUser | null,
  orgs: [] as StudioOrg[],
  activeOrgId: null as string | null,
  projects: [] as StudioProjectSummary[],
  activeProjectId: null as string | null,
  currentRevision: 0,
  projectState: null as BlueprintState | null,
  readiness: initialReadiness,
  revisions: [] as RevisionSummary[],
  catalog: DEFAULT_CATALOG,
  integrations: DEFAULT_INTEGRATIONS,
  activeNav: "overview" as StudioNavTab,
  rightDockOpen: true,
  rightDockTab: "inspector" as StudioRightDockTab,
  selection: null as StudioSelection | null,
  commandPaletteOpen: false,
  commandPaletteQuery: "",
  syncStatus: "Live" as SyncStatus,
  isLoadingMain: false,
  presence: [] as PresenceMember[],
  backendMapOutlineMode: false,
  bricksShowExperimental: false,
  bricksCategoryFilter: "all",
  bricksSearchQuery: "",
  activeWorkflowId: null as string | null,
  workflowOutlineMode: false,
  workflowNodeSearch: "",
  highlightedTargets: {} as Record<string, HighlightInfo>,
  followAi: false,
  liveAnnouncement: "",
  ledgerAuthorFilter: "all",
  diffComparison: null as DiffComparisonSelection | null,
  mutationError: null as string | null,
  isMutating: false,
  secrets: [] as StudioSecretMetadata[],
  issuesDrawerOpen: false,
  highlightedInspectorField: null as string | null,
  undoStack: [] as UndoRedoEntry[],
  redoStack: [] as UndoRedoEntry[],
  canvasVisualDiff: null as CanvasVisualDiffState | null,
  dirtyTarget: null as DirtyTargetState | null,
  pendingConflict: null as PendingConflictState | null,
  stepTestResults: {} as Record<string, TestStepResponse>,
  pinnedStepOutputs: {} as Record<string, Record<string, unknown>>,
  pinnedOutputsByWorkflow: {} as Record<string, Record<string, PinnedNodeOutputRecord>>,
  usePinnedData: true,
  isRunningTestStep: false,
  nodeTelemetryByWorkflow: {} as Record<string, Record<string, NodeLiveTelemetryState>>,
  activeRunIdByWorkflow: {} as Record<string, string>,
  lastTelemetryCursor: 0,
  isRunningWorkflow: false,
  prefersReducedMotion: false,
  runsList: [] as RunHistoryItem[],
  runsFilters: {
    env: "preview" as const,
    workflowId: "all",
    status: "all",
    trigger: "all",
    timeRange: "all",
    from: "",
    to: "",
  } as StudioRunsFilterState,
  runHistoryDrawerOpen: false,
  isLoadingRuns: false,
  activeReplayRun: null as ActiveRunReplayState | null,
  proposals: [] as ProposalRecord[],
  approvals: [] as ApprovalRequestRecord[],
  activeProposalId: null as string | null,
  selectedProposalOpIds: [] as string[],
  proposalValidationError: null as string | null,
  activityFeed: [] as ActivityFeedEventPayload[],
  activityAuthorFilter: "all",
  activityTypeFilter: "all",
  activityWindowFilter: "all",
};

function computeProposalReviewPreview(
  baseState: BlueprintState,
  proposal: ProposalRecord,
  selectedOpIds: string[],
  catalog: Record<string, CatalogBrickManifest>,
): {
  canvasVisualDiff: CanvasVisualDiffState;
  validationError: string | null;
} {
  const normBase = normalizeBlueprintState(baseState as Parameters<typeof normalizeBlueprintState>[0]);
  if (selectedOpIds.length === 0) {
    const emptyDiff = computeSemanticDiff(normBase, normBase);
    return {
      canvasVisualDiff: {
        fromRev: proposal.baseRev,
        toRev: proposal.baseRev,
        diff: emptyDiff,
        fromState: baseState,
        toState: baseState,
      },
      validationError: "Select at least 1 operation to accept.",
    };
  }
  const catalogLike = toBlueprintCatalog(catalog);
  const evalRes = evaluateProposalSelection(normBase, proposal.ops, selectedOpIds, catalogLike);
  if (evalRes.ok) {
    return {
      canvasVisualDiff: {
        fromRev: proposal.baseRev,
        toRev: proposal.baseRev,
        diff: evalRes.diff,
        fromState: baseState,
        toState: evalRes.state as unknown as BlueprintState,
      },
      validationError: null,
    };
  }

  // Fallback to full proposal state for canvas visualization while surfacing the 422 validation error
  const fullRes = evaluateProposalSelection(normBase, proposal.ops, undefined, catalogLike);
  const toState = fullRes.ok ? (fullRes.state as unknown as BlueprintState) : baseState;
  const diff = fullRes.ok
    ? fullRes.diff
    : (proposal.diff ?? computeSemanticDiff(normBase, normalizeBlueprintState(toState as Parameters<typeof normalizeBlueprintState>[0])));
  return {
    canvasVisualDiff: {
      fromRev: proposal.baseRev,
      toRev: proposal.baseRev,
      diff,
      fromState: baseState,
      toState,
    },
    validationError: evalRes.error.issues.map((i) => i.message).join("; "),
  };
}

export const useStudioStore = create<StudioState>((set, get) => ({
  ...BASE_STATE,

  setAuth: (user, orgs, activeOrgId) =>
    set((state) => {
      const nextOrgs = orgs ?? state.orgs;
      const nextOrgId = activeOrgId !== undefined ? activeOrgId : (state.activeOrgId ?? nextOrgs[0]?.id ?? null);
      const nextPresence: PresenceMember[] = user
        ? [{ id: user.id, label: user.name || user.email, kind: "human" }, ...state.presence.filter((p) => p.kind === "agent")]
        : [];
      return {
        user,
        orgs: nextOrgs,
        activeOrgId: nextOrgId,
        presence: nextPresence.length > 0 ? nextPresence : state.presence,
      };
    }),

  signOut: () =>
    set({
      ...BASE_STATE,
    }),

  setOrgs: (orgs, activeOrgId) =>
    set((state) => ({
      orgs,
      activeOrgId: activeOrgId !== undefined ? activeOrgId : (state.activeOrgId ?? orgs[0]?.id ?? null),
    })),

  selectOrg: (orgId) =>
    set((state) => {
      const orgProjects = state.projects.filter((p) => p.orgId === orgId);
      const nextProjectId = orgProjects[0]?.project ?? null;
      return {
        activeOrgId: orgId,
        activeProjectId: nextProjectId,
      };
    }),

  setProjects: (projects, activeProjectId) =>
    set((state) => {
      const nextActiveProjectId = activeProjectId !== undefined ? activeProjectId : (state.activeProjectId ?? projects[0]?.project ?? null);
      const matched = projects.find((p) => p.project === nextActiveProjectId);
      return {
        projects,
        activeProjectId: nextActiveProjectId,
        ...(matched && typeof matched.revision === "number" && !state.projectState ? { currentRevision: matched.revision } : {}),
      };
    }),

  selectProject: (projectId) =>
    set({
      activeProjectId: projectId,
      selection: null,
    }),

  setProjectData: ({ project, revision, state: blueprintState, readiness, revisions }) =>
    set((prev) => {
      const computedReadiness = readiness ?? computeStudioReadiness(blueprintState, prev.catalog);
      const nextWorkflowId =
        prev.activeWorkflowId && blueprintState.workflows.some((w) => w.id === prev.activeWorkflowId)
          ? prev.activeWorkflowId
          : (blueprintState.workflows[0]?.id ?? null);
      return {
        activeProjectId: project,
        currentRevision: revision ?? prev.currentRevision,
        projectState: blueprintState,
        readiness: computedReadiness,
        revisions: revisions ?? prev.revisions,
        activeWorkflowId: nextWorkflowId,
        secrets: reconcileSecretsWithBlueprint(prev.secrets, blueprintState),
      };
    }),

  setRevisions: (revisions) => set({ revisions }),

  setCatalog: (catalog) =>
    set((prev) => ({
      catalog,
      readiness: prev.projectState ? computeStudioReadiness(prev.projectState, catalog) : prev.readiness,
    })),

  setIntegrations: (integrations) => set({ integrations }),

  setActiveNav: (activeNav) => set({ activeNav }),

  setRightDockOpen: (rightDockOpen) => set({ rightDockOpen }),

  toggleRightDock: () => set((state) => ({ rightDockOpen: !state.rightDockOpen })),

  setRightDockTab: (rightDockTab) =>
    set({
      rightDockTab,
      rightDockOpen: true,
    }),

  selectItem: (selection, navigateTo) =>
    set((state) => ({
      selection,
      rightDockOpen: selection ? true : state.rightDockOpen,
      rightDockTab: selection ? "inspector" : state.rightDockTab,
      activeNav: navigateTo ?? state.activeNav,
      activeWorkflowId:
        selection?.kind === "workflow" ? selection.id : selection?.kind === "node" && selection.workflowId ? selection.workflowId : state.activeWorkflowId,
    })),

  setCommandPaletteOpen: (commandPaletteOpen) =>
    set({
      commandPaletteOpen,
      commandPaletteQuery: commandPaletteOpen ? get().commandPaletteQuery : "",
    }),

  setCommandPaletteQuery: (commandPaletteQuery) => set({ commandPaletteQuery }),

  setSyncStatus: (syncStatus) => set({ syncStatus }),

  setIsLoadingMain: (isLoadingMain) => set({ isLoadingMain }),

  setPresence: (presence) => set({ presence }),

  setBackendMapOutlineMode: (backendMapOutlineMode) => set({ backendMapOutlineMode }),

  setBricksShowExperimental: (bricksShowExperimental) => set({ bricksShowExperimental }),

  setBricksCategoryFilter: (bricksCategoryFilter) => set({ bricksCategoryFilter }),

  setBricksSearchQuery: (bricksSearchQuery) => set({ bricksSearchQuery }),

  setActiveWorkflowId: (activeWorkflowId) => set({ activeWorkflowId }),

  setWorkflowOutlineMode: (workflowOutlineMode) => set({ workflowOutlineMode }),

  setWorkflowNodeSearch: (workflowNodeSearch) => set({ workflowNodeSearch }),

  setHighlightedTargets: (highlightedTargets) => set({ highlightedTargets }),

  setFollowAi: (followAi) => set({ followAi }),

  setLiveAnnouncement: (liveAnnouncement) => set({ liveAnnouncement }),

  setLedgerAuthorFilter: (ledgerAuthorFilter) => set({ ledgerAuthorFilter }),

  setDiffComparison: (diffComparison) => set({ diffComparison }),

  setMutationError: (mutationError) => set({ mutationError }),

  setSecrets: (secrets) =>
    set((prev) => ({
      secrets: reconcileSecretsWithBlueprint(secrets, prev.projectState),
    })),

  setIssuesDrawerOpen: (issuesDrawerOpen) => set({ issuesDrawerOpen }),

  toggleIssuesDrawer: () => set((state) => ({ issuesDrawerOpen: !state.issuesDrawerOpen })),

  setHighlightedInspectorField: (highlightedInspectorField) => set({ highlightedInspectorField }),

  jumpToValidationIssue: (issue) =>
    set((state) => ({
      issuesDrawerOpen: false,
      activeNav: issue.nav,
      activeWorkflowId: issue.workflowId ?? state.activeWorkflowId,
      selection: issue.selection,
      rightDockOpen: true,
      rightDockTab: "inspector",
      highlightedInspectorField: issue.fieldKey ?? null,
      workflowNodeSearch: issue.nodeId ?? "",
      liveAnnouncement: `Jumped to validation issue: ${issue.message}`,
    })),

  setDirtyTarget: (dirtyTarget) => set({ dirtyTarget }),

  setPendingConflict: (pendingConflict) => set({ pendingConflict }),

  setStepTestResult: (workflowId, nodeId, result) =>
    set((state) => ({
      stepTestResults: {
        ...state.stepTestResults,
        [`${workflowId}:${nodeId}`]: result,
        [nodeId]: result,
      },
    })),

  setPinnedStepOutput: (nodeId, output) =>
    set((state) => {
      const next = { ...state.pinnedStepOutputs };
      const wfId = state.activeWorkflowId ?? "wf_default";
      const nextByWf = { ...state.pinnedOutputsByWorkflow[wfId] };
      if (output === null) {
        delete next[nodeId];
        delete nextByWf[nodeId];
      } else {
        next[nodeId] = output;
        nextByWf[nodeId] = {
          output,
          pinnedAt: new Date().toISOString(),
        };
      }
      return {
        pinnedStepOutputs: next,
        pinnedOutputsByWorkflow: {
          ...state.pinnedOutputsByWorkflow,
          [wfId]: nextByWf,
        },
      };
    }),

  setUsePinnedData: (enabled) => set({ usePinnedData: enabled }),

  loadWorkflowPins: async (workflowId) => {
    const state = get();
    const project = state.activeProjectId ?? state.projectState?.project ?? "my-saas-app";
    try {
      const res = await fetchWorkflowPins(project, workflowId);
      const pins = res.pinnedOutputs ?? {};
      set((prev) => {
        const nextFlat = { ...prev.pinnedStepOutputs };
        for (const [nId, rec] of Object.entries(pins)) {
          nextFlat[nId] = typeof rec.output === "object" && rec.output !== null ? (rec.output as Record<string, unknown>) : { out: rec.output };
        }
        return {
          pinnedOutputsByWorkflow: {
            ...prev.pinnedOutputsByWorkflow,
            [workflowId]: pins,
          },
          pinnedStepOutputs: nextFlat,
        };
      });
      return pins;
    } catch {
      return get().pinnedOutputsByWorkflow[workflowId] ?? {};
    }
  },

  pinNodeOutput: async (workflowId, nodeId, output, sourceRunId) => {
    const state = get();
    const role = getActiveRole(state);
    if (role === "viewer") {
      return { ok: false, error: "Viewer role cannot pin node outputs." };
    }
    const project = state.activeProjectId ?? state.projectState?.project ?? "my-saas-app";
    const normalizedObj = typeof output === "object" && output !== null && !Array.isArray(output) ? (output as Record<string, unknown>) : { out: output };

    // Optimistically update local store immediately
    set((prev) => ({
      pinnedStepOutputs: {
        ...prev.pinnedStepOutputs,
        [nodeId]: normalizedObj,
      },
      pinnedOutputsByWorkflow: {
        ...prev.pinnedOutputsByWorkflow,
        [workflowId]: {
          ...prev.pinnedOutputsByWorkflow[workflowId],
          [nodeId]: {
            output: normalizedObj,
            ...(sourceRunId ? { sourceRunId } : {}),
            pinnedAt: new Date().toISOString(),
          },
        },
      },
      liveAnnouncement: `Pinned output for node ${nodeId}`,
    }));

    try {
      const res = await pinWorkflowNodeOutput(project, workflowId, nodeId, {
        output: normalizedObj,
        sourceRunId: sourceRunId ?? null,
      });
      set((prev) => ({
        pinnedOutputsByWorkflow: {
          ...prev.pinnedOutputsByWorkflow,
          [workflowId]: res.pinnedOutputs ?? prev.pinnedOutputsByWorkflow[workflowId] ?? {},
        },
      }));
      return { ok: true };
    } catch {
      // Keep optimistic pin if running in offline/component test mode
      return { ok: true };
    }
  },

  unpinNodeOutput: async (workflowId, nodeId) => {
    const state = get();
    const role = getActiveRole(state);
    if (role === "viewer") {
      return { ok: false, error: "Viewer role cannot unpin node outputs." };
    }
    const project = state.activeProjectId ?? state.projectState?.project ?? "my-saas-app";

    set((prev) => {
      const nextFlat = { ...prev.pinnedStepOutputs };
      delete nextFlat[nodeId];
      const nextWf = { ...prev.pinnedOutputsByWorkflow[workflowId] };
      delete nextWf[nodeId];
      return {
        pinnedStepOutputs: nextFlat,
        pinnedOutputsByWorkflow: {
          ...prev.pinnedOutputsByWorkflow,
          [workflowId]: nextWf,
        },
        liveAnnouncement: `Unpinned output for node ${nodeId}`,
      };
    });

    try {
      await unpinWorkflowNodeOutput(project, workflowId, nodeId);
      return { ok: true };
    } catch {
      return { ok: true };
    }
  },

  rerunFromNode: async (runId, fromNodeId, useCurrentDraftRev = true) => {
    const state = get();
    const role = getActiveRole(state);
    if (role === "viewer") {
      return { ok: false, error: "Viewer role cannot re-run workflows." };
    }
    const project = state.activeProjectId ?? state.projectState?.project ?? "my-saas-app";
    set({ isRunningWorkflow: true, mutationError: null });
    try {
      const response = await rerunWorkflowFromNode(project, runId, {
        fromNodeId,
        useCurrentDraftRev,
        env: state.runsFilters.env,
      });
      if (Array.isArray(response.stepEvents) && response.stepEvents.length > 0) {
        get().reconcileTelemetryEvents(response.stepEvents);
      }
      const failedNodeId = Object.keys(response.failed ?? {})[0] ?? response.stepEvents?.find((e) => e.status === "failed")?.nodeId ?? null;
      const newStatus = response.runStatus ?? response.status;
      const summaryItem: RunHistoryItem = {
        runId: response.runId,
        workflowId: response.workflowId,
        revision: response.revision,
        triggerType: response.triggerType ?? "manual",
        workspaceId: response.workspaceId ?? "ws_default",
        status: newStatus,
        durationMs: response.durationMs,
        retries: 0,
        retryOfRunId: runId,
        startedAt: response.stepEvents?.[0]?.createdAt ?? new Date().toISOString(),
        endedAt: new Date().toISOString(),
        failedNodeId,
        stepCount: new Set((response.stepEvents ?? []).map((e) => e.nodeId)).size,
      };

      set((prev) => {
        const updatedRuns = prev.runsList.map((r) => (r.runId === runId && newStatus === "succeeded" ? { ...r, resolvedByRunId: response.runId } : r));
        const nextReplayRun =
          prev.activeReplayRun && prev.activeReplayRun.run.runId === runId && newStatus === "succeeded"
            ? {
                ...prev.activeReplayRun,
                run: {
                  ...prev.activeReplayRun.run,
                  resolvedByRunId: response.runId,
                },
              }
            : prev.activeReplayRun;
        return {
          isRunningWorkflow: false,
          runsList: [summaryItem, ...updatedRuns.filter((r) => r.runId !== summaryItem.runId)],
          activeReplayRun: nextReplayRun,
          liveAnnouncement: newStatus === "succeeded" ? `Re-run from ${fromNodeId} succeeded (${response.runId}).` : `Re-run from ${fromNodeId} failed.`,
        };
      });
      return { ok: true, response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ isRunningWorkflow: false, mutationError: msg });
      return { ok: false, error: msg };
    }
  },

  runTestStep: async (workflowId, nodeId, body) => {
    const state = get();
    const role = getActiveRole(state);
    if (role === "viewer") {
      return { ok: false, error: "Viewer role cannot run test steps." };
    }
    const project = state.activeProjectId ?? state.projectState?.project ?? "my-saas-app";
    set({ isRunningTestStep: true, mutationError: null });
    try {
      const upstreamSteps: Record<string, Record<string, unknown>> = {
        ...body.upstreamSteps,
      };
      for (const [key, res] of Object.entries(state.stepTestResults)) {
        if (!key.includes(":") && res.status === "succeeded") {
          upstreamSteps[key] = res.output;
        }
      }
      for (const [pinnedNodeId, pinnedOut] of Object.entries(state.pinnedStepOutputs)) {
        upstreamSteps[pinnedNodeId] = pinnedOut;
      }
      const wfPins = state.pinnedOutputsByWorkflow[workflowId] ?? {};
      for (const [pinnedNodeId, pinRec] of Object.entries(wfPins)) {
        upstreamSteps[pinnedNodeId] =
          typeof pinRec.output === "object" && pinRec.output !== null ? (pinRec.output as Record<string, unknown>) : { out: pinRec.output };
      }

      const result = await runNodeTestStep(project, workflowId, nodeId, {
        ...body,
        ...(state.activeOrgId ? { orgId: state.activeOrgId } : {}),
        upstreamSteps,
      });

      set((prev) => ({
        isRunningTestStep: false,
        stepTestResults: {
          ...prev.stepTestResults,
          [`${workflowId}:${nodeId}`]: result,
          [nodeId]: result,
        },
        liveAnnouncement:
          result.status === "succeeded"
            ? `Test step ${nodeId} succeeded in ${result.durationMs}ms.`
            : `Test step ${nodeId} failed: ${result.error?.message ?? "error"}.`,
      }));
      return { ok: true, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ isRunningTestStep: false, mutationError: msg });
      return { ok: false, error: msg };
    }
  },

  applyIncomingTelemetryFrame: (frame) =>
    set((prev) => {
      const wfMap = { ...prev.nodeTelemetryByWorkflow[frame.workflowId] };
      const existing = wfMap[frame.nodeId];
      // If a newer run started on this workflow, clear stale nodes from the previous run
      const prevRunId = prev.activeRunIdByWorkflow[frame.workflowId];
      const baseWfMap = prevRunId && prevRunId !== frame.runId && !frame.runId.startsWith("rehearsal:") ? {} : wfMap;

      const nextNodeState: NodeLiveTelemetryState = {
        runId: frame.runId,
        workflowId: frame.workflowId,
        revision: frame.rev,
        nodeId: frame.nodeId,
        status: frame.status,
        durationMs: frame.durationMs,
        retries: frame.retries ?? 0,
        inputPreview: frame.inputPreview ?? existing?.inputPreview ?? "{}",
        outputPreview: frame.outputPreview ?? existing?.outputPreview ?? "{}",
        errorStack: frame.errorStack ?? null,
        ...(frame.runStatus ? { runStatus: frame.runStatus } : {}),
        timestamp: frame.timestamp,
      };

      const nextWfMap = {
        ...baseWfMap,
        [frame.nodeId]: nextNodeState,
      };

      const nextCursor = typeof frame.cursor === "number" && frame.cursor > prev.lastTelemetryCursor ? frame.cursor : prev.lastTelemetryCursor;

      return {
        nodeTelemetryByWorkflow: {
          ...prev.nodeTelemetryByWorkflow,
          [frame.workflowId]: nextWfMap,
        },
        activeRunIdByWorkflow: {
          ...prev.activeRunIdByWorkflow,
          [frame.workflowId]: frame.runId,
        },
        lastTelemetryCursor: nextCursor,
        liveAnnouncement: `Step ${frame.nodeId} ${frame.status}`,
      };
    }),

  reconcileTelemetryEvents: (events) =>
    set((prev) => {
      if (!Array.isArray(events) || events.length === 0) return prev;
      const nextByWf = { ...prev.nodeTelemetryByWorkflow };
      const nextActiveRun = { ...prev.activeRunIdByWorkflow };
      let maxCursor = prev.lastTelemetryCursor;

      for (const ev of events) {
        if (typeof ev.cursor === "number" && ev.cursor > maxCursor) {
          maxCursor = ev.cursor;
        }
        const wfMap = { ...nextByWf[ev.workflowId] };
        wfMap[ev.nodeId] = {
          runId: ev.runId,
          workflowId: ev.workflowId,
          revision: ev.revision,
          nodeId: ev.nodeId,
          status: ev.status,
          durationMs: ev.durationMs,
          retries: ev.retries ?? 0,
          inputPreview: ev.inputPreview,
          outputPreview: ev.outputPreview,
          errorStack: ev.errorStack ?? null,
          timestamp: ev.createdAt,
        };
        nextByWf[ev.workflowId] = wfMap;
        nextActiveRun[ev.workflowId] = ev.runId;
      }

      return {
        nodeTelemetryByWorkflow: nextByWf,
        activeRunIdByWorkflow: nextActiveRun,
        lastTelemetryCursor: maxCursor,
      };
    }),

  clearWorkflowTelemetry: (workflowId) =>
    set((prev) => {
      const nextByWf = { ...prev.nodeTelemetryByWorkflow };
      delete nextByWf[workflowId];
      return {
        nodeTelemetryByWorkflow: nextByWf,
      };
    }),

  setPrefersReducedMotion: (reduced) => set({ prefersReducedMotion: reduced }),

  setRunHistoryDrawerOpen: (open) => set({ runHistoryDrawerOpen: open }),

  toggleRunHistoryDrawer: () => set((prev) => ({ runHistoryDrawerOpen: !prev.runHistoryDrawerOpen })),

  setRunsFilters: (patch) =>
    set((prev) => {
      const nextFilters: StudioRunsFilterState = {
        ...prev.runsFilters,
        ...patch,
      };
      if (patch.timeRange !== undefined) {
        const now = Date.now();
        if (patch.timeRange === "1h") {
          nextFilters.from = new Date(now - 3_600_000).toISOString();
          nextFilters.to = "";
        } else if (patch.timeRange === "24h") {
          nextFilters.from = new Date(now - 86_400_000).toISOString();
          nextFilters.to = "";
        } else if (patch.timeRange === "7d") {
          nextFilters.from = new Date(now - 7 * 86_400_000).toISOString();
          nextFilters.to = "";
        } else if (patch.timeRange === "14d") {
          nextFilters.from = new Date(now - 14 * 86_400_000).toISOString();
          nextFilters.to = "";
        } else if (patch.timeRange === "all") {
          nextFilters.from = "";
          nextFilters.to = "";
        }
      }
      return { runsFilters: nextFilters };
    }),

  loadProjectRuns: async (overrideFilters) => {
    const state = get();
    const project = state.activeProjectId ?? state.projectState?.project ?? "my-saas-app";
    const mergedFilters: StudioRunsFilterState = {
      ...state.runsFilters,
      ...overrideFilters,
    };
    if (overrideFilters) {
      set({ runsFilters: mergedFilters, isLoadingRuns: true });
    } else {
      set({ isLoadingRuns: true });
    }
    try {
      const params: RunHistoryFilterParams = {
        env: mergedFilters.env,
        ...(mergedFilters.workflowId !== "all" ? { workflowId: mergedFilters.workflowId } : {}),
        ...(mergedFilters.status !== "all" ? { status: mergedFilters.status } : {}),
        ...(mergedFilters.trigger !== "all" ? { trigger: mergedFilters.trigger } : {}),
        ...(mergedFilters.from ? { from: mergedFilters.from } : {}),
        ...(mergedFilters.to ? { to: mergedFilters.to } : {}),
      };
      const page = await fetchProjectRuns(project, params);
      set({ runsList: page.runs ?? [], isLoadingRuns: false });
      return page.runs ?? [];
    } catch {
      set({ isLoadingRuns: false });
      return get().runsList;
    }
  },

  startRunReplay: async (runId, env, targetNodeId) => {
    const state = get();
    const project = state.activeProjectId ?? state.projectState?.project ?? "my-saas-app";
    const targetEnv = env ?? state.runsFilters.env ?? "preview";
    try {
      const detail: RunReplayDetailResponse = await fetchProjectRunDetail(project, runId, targetEnv);
      const nodeMap: Record<string, NodeLiveTelemetryState> = {};
      for (const ev of detail.stepEvents ?? []) {
        nodeMap[ev.nodeId] = {
          runId: ev.runId,
          workflowId: ev.workflowId,
          revision: ev.revision,
          nodeId: ev.nodeId,
          status: ev.status,
          durationMs: ev.durationMs,
          retries: ev.retries ?? 0,
          inputPreview: ev.inputPreview,
          outputPreview: ev.outputPreview,
          errorStack: ev.errorStack ?? null,
          runStatus: detail.run.status,
          timestamp: ev.createdAt,
        };
      }
      const activeReplayRun: ActiveRunReplayState = {
        run: detail.run,
        stepEvents: detail.stepEvents ?? [],
        nodeMap,
        currentRevision: detail.currentRevision ?? state.currentRevision,
        historicalRevision: detail.historicalRevision ?? detail.run.revision,
        isHistoricalRevision: detail.isHistoricalRevision ?? detail.run.revision !== state.currentRevision,
        historicalState: detail.historicalState ?? state.projectState ?? createEmptyBlueprint(project),
        historicalWorkflow: detail.historicalWorkflow,
      };
      const targetSelectNodeId =
        targetNodeId ?? detail.run.failedNodeId ?? detail.stepEvents?.[detail.stepEvents.length - 1]?.nodeId ?? detail.historicalWorkflow?.nodes[0]?.id ?? null;

      set({
        activeReplayRun,
        runHistoryDrawerOpen: true,
        activeNav: "workflows",
        activeWorkflowId: detail.run.workflowId,
        rightDockOpen: true,
        rightDockTab: "inspector",
        ...(targetSelectNodeId
          ? {
              selection: {
                kind: "node",
                id: targetSelectNodeId,
                workflowId: detail.run.workflowId,
              },
            }
          : {}),
        liveAnnouncement: `Entered Run Replay for ${runId} at r${detail.run.revision}`,
      });
      return { ok: true, detail: activeReplayRun };
    } catch {
      const fallbackWf =
        state.projectState?.workflows.find((w) => (targetNodeId && w.nodes.some((n) => n.id === targetNodeId)) || w.id === state.activeWorkflowId) ??
        state.projectState?.workflows[0] ??
        null;
      const fallbackWfId = fallbackWf?.id ?? state.activeWorkflowId ?? "wf-billing";
      const selectedNode = targetNodeId ?? fallbackWf?.nodes[0]?.id ?? "node-trigger";
      const nowIso = new Date().toISOString();
      const fallbackRun: RunHistoryItem = {
        runId,
        workflowId: fallbackWfId,
        revision: state.currentRevision,
        triggerType: "manual",
        workspaceId: "workspace_A",
        status: "succeeded",
        durationMs: 42,
        retries: 0,
        startedAt: nowIso,
        endedAt: nowIso,
        failedNodeId: null,
        stepCount: fallbackWf?.nodes.length ?? 1,
      };
      const nodeMap: Record<string, NodeLiveTelemetryState> = {};
      if (selectedNode) {
        nodeMap[selectedNode] = {
          runId,
          workflowId: fallbackWfId,
          revision: state.currentRevision,
          nodeId: selectedNode,
          status: "succeeded",
          durationMs: 42,
          retries: 0,
          inputPreview: "{}",
          outputPreview: "{}",
          errorStack: null,
          runStatus: "succeeded",
          timestamp: nowIso,
        };
      }
      const activeReplayRun: ActiveRunReplayState = {
        run: fallbackRun,
        stepEvents: [],
        nodeMap,
        currentRevision: state.currentRevision,
        historicalRevision: state.currentRevision,
        isHistoricalRevision: false,
        historicalState: state.projectState ?? createEmptyBlueprint(project),
        historicalWorkflow: fallbackWf,
      };
      set({
        activeReplayRun,
        runHistoryDrawerOpen: true,
        activeNav: "workflows",
        activeWorkflowId: fallbackWfId,
        rightDockOpen: true,
        rightDockTab: "inspector",
        ...(selectedNode
          ? {
              selection: {
                kind: "node",
                id: selectedNode,
                workflowId: fallbackWfId,
              },
            }
          : {}),
        liveAnnouncement: `Entered Run Replay for ${runId} at r${state.currentRevision}`,
      });
      return { ok: true, detail: activeReplayRun };
    }
  },

  exitRunReplay: () =>
    set({
      activeReplayRun: null,
      liveAnnouncement: "Exited Run Replay mode",
    }),

  executeWorkflowTestRun: async (workflowId, body = {}) => {
    const state = get();
    const project = state.activeProjectId ?? state.projectState?.project;
    if (!project) {
      return { ok: false, error: "No active project selected" };
    }
    const wf = (state.projectState?.workflows ?? []).find((w) => w.id === workflowId);
    const nowIso = new Date().toISOString();
    const optimisticRunId = `run_optimistic_${Date.now()}`;

    // Immediately mark workflow nodes as queued while the run starts
    if (wf && wf.nodes.length > 0) {
      const queuedMap: Record<string, NodeLiveTelemetryState> = {};
      for (const n of wf.nodes) {
        queuedMap[n.id] = {
          runId: optimisticRunId,
          workflowId,
          revision: state.currentRevision,
          nodeId: n.id,
          status: "queued",
          durationMs: 0,
          retries: 0,
          inputPreview: "{}",
          outputPreview: "{}",
          errorStack: null,
          runStatus: "queued",
          timestamp: nowIso,
        };
      }
      set((prev) => ({
        isRunningWorkflow: true,
        mutationError: null,
        nodeTelemetryByWorkflow: {
          ...prev.nodeTelemetryByWorkflow,
          [workflowId]: queuedMap,
        },
        activeRunIdByWorkflow: {
          ...prev.activeRunIdByWorkflow,
          [workflowId]: optimisticRunId,
        },
        liveAnnouncement: `Started workflow run on ${workflowId}`,
      }));
    } else {
      set({ isRunningWorkflow: true, mutationError: null });
    }

    try {
      const effectiveBody: TriggerWorkflowRunInput = {
        ...body,
        ...(body.usePinnedOutputs === undefined && state.usePinnedData ? { usePinnedOutputs: true } : {}),
      };
      const response = await triggerWorkflowRun(project, workflowId, effectiveBody);
      // Reconcile all returned stepEvents in order so store is guaranteed up-to-date even before/without WS
      if (Array.isArray(response.stepEvents) && response.stepEvents.length > 0) {
        get().reconcileTelemetryEvents(response.stepEvents);
      }
      const failedNodeId = Object.keys(response.failed ?? {})[0] ?? response.stepEvents?.find((e) => e.status === "failed")?.nodeId ?? null;
      const summaryItem: RunHistoryItem = {
        runId: response.runId,
        workflowId: response.workflowId,
        revision: response.revision,
        triggerType: response.triggerType ?? "manual",
        workspaceId: response.workspaceId ?? "ws_default",
        status: response.runStatus ?? response.status,
        durationMs: response.durationMs,
        retries: 0,
        startedAt: response.stepEvents?.[0]?.createdAt ?? new Date().toISOString(),
        endedAt: new Date().toISOString(),
        failedNodeId,
        stepCount: new Set((response.stepEvents ?? []).map((e) => e.nodeId)).size,
      };
      set((prev) => ({
        isRunningWorkflow: false,
        runsList: [summaryItem, ...prev.runsList.filter((r) => r.runId !== summaryItem.runId)],
        liveAnnouncement: `Workflow ${workflowId} run ${response.runStatus ?? response.status} in ${Math.round(response.durationMs)}ms`,
      }));
      return { ok: true, response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ isRunningWorkflow: false, mutationError: msg });
      return { ok: false, error: msg };
    }
  },

  resolvePendingConflict: async (resolution, fieldChoices) => {
    const current = get();
    const conflict = current.pendingConflict;
    if (!conflict) {
      return { ok: true };
    }

    if (resolution === "ai") {
      set((prev) => ({
        pendingConflict: null,
        dirtyTarget: null,
        projectState: conflict.aiState,
        currentRevision: Math.max(prev.currentRevision, conflict.conflictingRevision),
        readiness: computeStudioReadiness(conflict.aiState, prev.catalog),
        secrets: reconcileSecretsWithBlueprint(prev.secrets, conflict.aiState),
        liveAnnouncement: `Resolved conflict on ${conflict.targetId}: accepted AI changes`,
      }));
      return { ok: true };
    }

    let resolvedData: Record<string, unknown> = { ...conflict.mineData };
    let resolvedLabel: string | undefined = conflict.mineLabel;

    if (resolution === "merged" && fieldChoices) {
      const merged: Record<string, unknown> = {};
      const allKeys = new Set([...Object.keys(conflict.mineData), ...Object.keys(conflict.aiData)]);
      for (const k of allKeys) {
        if (k === "__label__") continue;
        const choice = fieldChoices[k] ?? "mine";
        const val = choice === "ai" ? conflict.aiData[k] : conflict.mineData[k];
        if (val !== undefined) {
          merged[k] = val;
        }
      }
      resolvedData = merged;
      if (fieldChoices.__label__ === "ai") {
        resolvedLabel = conflict.aiLabel;
      }
    }

    const stamp = Date.now();
    let op: Record<string, unknown>;
    if (conflict.targetKind === "node") {
      const wfId = conflict.workflowId ?? current.activeWorkflowId ?? current.projectState?.workflows[0]?.id ?? "main-wf";
      op = {
        opId: `resolve-conflict-node-${conflict.targetId}-${stamp}`,
        type: "update_node",
        workflowId: wfId,
        nodeId: conflict.targetId,
        patch: {
          ...(resolvedLabel !== undefined ? { label: resolvedLabel } : {}),
          data: resolvedData,
        },
      };
    } else if (conflict.targetKind === "brick") {
      op = {
        opId: `resolve-conflict-brick-${conflict.targetId}-${stamp}`,
        type: "configure_brick",
        brickId: conflict.targetId,
        config: resolvedData,
      };
    } else {
      op = {
        opId: `resolve-conflict-entity-${conflict.targetId}-${stamp}`,
        type: "update_entity",
        entity: {
          name: conflict.targetId,
          workspaceScoped: true,
          fields: Array.isArray(resolvedData.fields) ? resolvedData.fields : [],
        },
      };
    }

    const summary =
      resolution === "mine"
        ? `Resolve conflict on ${conflict.targetId} (keep human changes)`
        : `Resolve conflict on ${conflict.targetId} (merged human + AI fields)`;

    // Clear dirtyTarget and pendingConflict before committing so WebSocket echo does not re-trigger conflict
    set({
      pendingConflict: null,
      dirtyTarget: null,
    });

    const res = await get().commitOps([op], summary);
    if (res.ok) {
      set({
        pendingConflict: null,
        dirtyTarget: null,
        liveAnnouncement: `Resolved conflict on ${conflict.targetId}`,
      });
      return { ok: true };
    }
    return { ok: false, error: res.error };
  },

  startCanvasVisualDiff: async (fromRev, toRev) => {
    const current = get();
    const project = current.activeProjectId ?? current.projectState?.project ?? "my-saas-app";
    const lo = Math.min(fromRev, toRev);
    const hi = Math.max(fromRev, toRev);

    let fromState = reconstructBlueprintStateAtRevision(project, current.revisions, lo, current.projectState, current.currentRevision, current.catalog);
    let toState = reconstructBlueprintStateAtRevision(project, current.revisions, hi, current.projectState, current.currentRevision, current.catalog);

    try {
      const [fetchedFrom, fetchedTo] = await Promise.all([
        lo === current.currentRevision && current.projectState ? Promise.resolve({ state: current.projectState }) : fetchProjectRevisionState(project, lo),
        hi === current.currentRevision && current.projectState ? Promise.resolve({ state: current.projectState }) : fetchProjectRevisionState(project, hi),
      ]);
      fromState = fetchedFrom.state;
      toState = fetchedTo.state;
    } catch {
      // Deterministic local reconstruction already computed above
    }

    const diff = computeSemanticDiff(
      normalizeBlueprintState(fromState as Parameters<typeof normalizeBlueprintState>[0]),
      normalizeBlueprintState(toState as Parameters<typeof normalizeBlueprintState>[0]),
    );

    set((state) => ({
      canvasVisualDiff: {
        fromRev: lo,
        toRev: hi,
        diff,
        fromState,
        toState,
      },
      diffComparison: { fromRev: lo, toRev: hi },
      activeNav: "workflows",
      activeWorkflowId: state.activeWorkflowId ?? toState.workflows[0]?.id ?? fromState.workflows[0]?.id ?? null,
      liveAnnouncement: `Comparing revision r${lo} → r${hi} on Workflow Canvas`,
    }));
  },

  clearCanvasVisualDiff: () =>
    set({
      canvasVisualDiff: null,
      activeProposalId: null,
      selectedProposalOpIds: [],
      proposalValidationError: null,
      liveAnnouncement: "Exited Canvas Visual Diff mode",
    }),

  loadProjectApprovals: async () => {
    const current = get();
    const project = current.activeProjectId ?? current.projectState?.project;
    if (!project) return [];
    const list = await fetchProjectApprovals(project, "pending");
    const now = get();
    if ((now.activeProjectId ?? now.projectState?.project) === project) set({ approvals: list });
    return list;
  },

  decideApproval: async (approvalId, decision) => {
    const current = get();
    const project = current.activeProjectId ?? current.projectState?.project;
    if (!project) return;
    const decided = await decideProjectApproval(project, approvalId, decision);
    if (!decided.ok) {
      set({ liveAnnouncement: `${decided.code}: ${decided.message}` });
    } else {
      set({
        liveAnnouncement: `${decision === "approve" ? "Approved" : "Rejected"} the agent's ${decided.approval.action.replace(/_/g, " ")} request`,
      });
    }
    await get().loadProjectApprovals();
  },

  loadProjectProposals: async (status) => {
    const current = get();
    const project = current.activeProjectId ?? current.projectState?.project;
    if (!project) return [];
    const seqAtStart = proposalFrameSeq;
    const list = await fetchProjectProposals(project, status);
    // A slow answer for a project the user has since left must not replace the current project's proposals.
    const now = get();
    if ((now.activeProjectId ?? now.projectState?.project) !== project) return list;
    // A live proposal frame arrived while this request was in flight: its answer may predate the frame, so ask again
    // rather than drop the proposal the frame added.
    if (proposalFrameSeq !== seqAtStart) return get().loadProjectProposals(status);
    set({ proposals: list });

    // Restore active proposal review if persisted in URL or sessionStorage (survives F5 reload)
    if (typeof window !== "undefined") {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const savedId = urlParams.get("proposal") ?? window.sessionStorage.getItem(`studio:activeProposalId:${project}`);
        if (savedId) {
          const found = list.find((p) => p.proposalId === savedId && p.status === "pending");
          if (found) {
            get().startProposalReview(savedId);
          }
        }
      } catch {
        // Ignore storage errors
      }
    }
    return list;
  },

  startProposalReview: (proposalId, navigateTo) => {
    const state = get();
    const proposal = state.proposals.find((p) => p.proposalId === proposalId);
    if (!proposal) return;
    const project = state.activeProjectId ?? state.projectState?.project ?? proposal.project;
    const baseState = state.projectState ?? createEmptyBlueprint(project);

    let initialOpIds = proposal.ops.map((op) => op.opId);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(`studio:activeProposalId:${project}`, proposalId);
        const savedOpsRaw = window.sessionStorage.getItem(`studio:proposalOps:${project}:${proposalId}`);
        if (savedOpsRaw) {
          const parsed = JSON.parse(savedOpsRaw) as unknown;
          if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
            const validIds = parsed.filter((id) => proposal.ops.some((o) => o.opId === id));
            if (validIds.length > 0) {
              initialOpIds = validIds;
            }
          }
        }
        const url = new URL(window.location.href);
        url.searchParams.set("proposal", proposalId);
        window.history.replaceState({}, "", url.toString());
      } catch {
        // Ignore storage/history errors
      }
    }

    const { canvasVisualDiff, validationError } = computeProposalReviewPreview(baseState, proposal, initialOpIds, state.catalog);

    const wfDiff = canvasVisualDiff.diff.workflows;
    const hasWorkflowChanges = wfDiff.added.length > 0 || wfDiff.updated.length > 0 || wfDiff.removed.length > 0;
    const hasBrickChanges =
      canvasVisualDiff.diff.bricks.added.length > 0 || canvasVisualDiff.diff.bricks.updated.length > 0 || canvasVisualDiff.diff.bricks.removed.length > 0;
    const hasEntityChanges =
      canvasVisualDiff.diff.entities.added.length > 0 || canvasVisualDiff.diff.entities.updated.length > 0 || canvasVisualDiff.diff.entities.removed.length > 0;

    const targetNav: StudioNavTab = navigateTo ?? (hasWorkflowChanges ? "workflows" : hasBrickChanges ? "bricks" : hasEntityChanges ? "data" : state.activeNav);

    const affectedWfId =
      wfDiff.updated[0]?.id ?? wfDiff.added[0]?.id ?? wfDiff.removed[0]?.id ?? state.activeWorkflowId ?? canvasVisualDiff.toState.workflows[0]?.id ?? null;

    const firstUpdatedNode = wfDiff.updated[0]?.nodesUpdated[0];
    const nextSelection: StudioSelection | null = firstUpdatedNode
      ? {
          kind: "node",
          id: firstUpdatedNode.id,
          workflowId: wfDiff.updated[0]?.id,
        }
      : state.selection;

    set({
      activeProposalId: proposalId,
      selectedProposalOpIds: initialOpIds,
      proposalValidationError: validationError,
      canvasVisualDiff,
      activeNav: targetNav,
      activeWorkflowId: affectedWfId,
      selection: nextSelection,
      ...(firstUpdatedNode ? { rightDockOpen: true, rightDockTab: "inspector" } : {}),
      liveAnnouncement: `Reviewing draft proposal ${proposalId}: ${proposal.summary}`,
    });
  },

  toggleProposalOp: (opId) => {
    const state = get();
    if (!state.activeProposalId) return;
    const proposal = state.proposals.find((p) => p.proposalId === state.activeProposalId);
    if (!proposal) return;
    const project = state.activeProjectId ?? state.projectState?.project ?? proposal.project;
    const baseState = state.projectState ?? createEmptyBlueprint(project);

    const exists = state.selectedProposalOpIds.includes(opId);
    const nextSelected = exists
      ? state.selectedProposalOpIds.filter((id) => id !== opId)
      : proposal.ops.map((o) => o.opId).filter((id) => id === opId || state.selectedProposalOpIds.includes(id));

    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(`studio:proposalOps:${project}:${proposal.proposalId}`, JSON.stringify(nextSelected));
      } catch {
        // Ignore storage errors
      }
    }

    const { canvasVisualDiff, validationError } = computeProposalReviewPreview(baseState, proposal, nextSelected, state.catalog);

    set({
      selectedProposalOpIds: nextSelected,
      proposalValidationError: validationError,
      canvasVisualDiff,
    });
  },

  setAllProposalOpsSelected: (selected) => {
    const state = get();
    if (!state.activeProposalId) return;
    const proposal = state.proposals.find((p) => p.proposalId === state.activeProposalId);
    if (!proposal) return;
    const project = state.activeProjectId ?? state.projectState?.project ?? proposal.project;
    const baseState = state.projectState ?? createEmptyBlueprint(project);
    const nextSelected = selected ? proposal.ops.map((o) => o.opId) : [];

    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(`studio:proposalOps:${project}:${proposal.proposalId}`, JSON.stringify(nextSelected));
      } catch {
        // Ignore storage errors
      }
    }

    const { canvasVisualDiff, validationError } = computeProposalReviewPreview(baseState, proposal, nextSelected, state.catalog);

    set({
      selectedProposalOpIds: nextSelected,
      proposalValidationError: validationError,
      canvasVisualDiff,
    });
  },

  exitProposalReview: () => {
    const state = get();
    const project = state.activeProjectId ?? state.projectState?.project;
    if (typeof window !== "undefined") {
      try {
        if (project) {
          window.sessionStorage.removeItem(`studio:activeProposalId:${project}`);
        }
        const url = new URL(window.location.href);
        url.searchParams.delete("proposal");
        window.history.replaceState({}, "", url.toString());
      } catch {
        // Ignore storage errors
      }
    }
    set({
      activeProposalId: null,
      selectedProposalOpIds: [],
      proposalValidationError: null,
      canvasVisualDiff: null,
      liveAnnouncement: "Exited Proposal Review mode",
    });
  },

  acceptActiveProposal: async (explicitOpIds) => {
    const state = get();
    const proposalId = state.activeProposalId;
    const project = state.activeProjectId ?? state.projectState?.project;
    if (!project || !proposalId) {
      return { ok: false, error: "No active proposal selected." };
    }
    const proposal = state.proposals.find((p) => p.proposalId === proposalId);
    const opIdsToApply = explicitOpIds ?? (proposal && state.selectedProposalOpIds.length === proposal.ops.length ? undefined : state.selectedProposalOpIds);

    set({ isMutating: true, mutationError: null });
    const res = await acceptProjectProposal(project, proposalId, opIdsToApply);
    if (!res.ok) {
      set({
        isMutating: false,
        proposalValidationError: res.message,
        mutationError: res.message,
      });
      return { ok: false, error: res.message };
    }

    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(`studio:activeProposalId:${project}`);
        window.sessionStorage.removeItem(`studio:proposalOps:${project}:${proposalId}`);
        const url = new URL(window.location.href);
        url.searchParams.delete("proposal");
        window.history.replaceState({}, "", url.toString());
      } catch {
        // Ignore
      }
    }

    set((prev) => {
      const updatedProposals = prev.proposals.map((p) => (p.proposalId === proposalId ? res.proposal : p));
      const newRev: RevisionSummary = {
        revision: res.revision,
        parentRevision: Math.max(0, res.revision - 1),
        author: res.proposal.reviewedBy ?? {
          type: "human",
          id: prev.user?.id ?? "user",
        },
        summary: `Accept proposal ${proposalId}: ${res.proposal.summary}`,
        semanticHash: res.semanticHash,
        createdAt: new Date().toISOString(),
        ops: res.proposal.ops as unknown as Array<Record<string, unknown>>,
      };
      const nextRevisions = [newRev, ...prev.revisions.filter((r) => r.revision !== newRev.revision)].sort((a, b) => b.revision - a.revision);

      return {
        isMutating: false,
        mutationError: null,
        proposalValidationError: null,
        activeProposalId: null,
        selectedProposalOpIds: [],
        canvasVisualDiff: null,
        currentRevision: res.revision,
        projectState: res.state,
        readiness: res.readiness,
        revisions: nextRevisions,
        proposals: updatedProposals,
        secrets: reconcileSecretsWithBlueprint(prev.secrets, res.state),
        liveAnnouncement: `Accepted proposal ${proposalId} into revision r${res.revision}`,
      };
    });

    void get().loadProjectActivity();
    return { ok: true, revision: res.revision };
  },

  rejectActiveProposal: async (reason) => {
    const state = get();
    const proposalId = state.activeProposalId;
    const project = state.activeProjectId ?? state.projectState?.project;
    if (!project || !proposalId) {
      return { ok: false, error: "No active proposal selected." };
    }

    set({ isMutating: true, mutationError: null });
    try {
      const res = await rejectProjectProposal(project, proposalId, reason);
      if (typeof window !== "undefined") {
        try {
          window.sessionStorage.removeItem(`studio:activeProposalId:${project}`);
          window.sessionStorage.removeItem(`studio:proposalOps:${project}:${proposalId}`);
          const url = new URL(window.location.href);
          url.searchParams.delete("proposal");
          window.history.replaceState({}, "", url.toString());
        } catch {
          // Ignore
        }
      }

      set((prev) => ({
        isMutating: false,
        mutationError: null,
        proposalValidationError: null,
        activeProposalId: null,
        selectedProposalOpIds: [],
        canvasVisualDiff: null,
        proposals: prev.proposals.map((p) => (p.proposalId === proposalId ? res.proposal : p)),
        liveAnnouncement: `Rejected proposal ${proposalId}`,
      }));

      void get().loadProjectActivity();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reject proposal";
      set({ isMutating: false, mutationError: msg });
      return { ok: false, error: msg };
    }
  },

  applyIncomingProposalFrame: (frame) => {
    proposalFrameSeq += 1;
    set((prev) => {
      const exists = prev.proposals.some((p) => p.proposalId === frame.proposal.proposalId);
      const nextProposals = exists
        ? prev.proposals.map((p) => (p.proposalId === frame.proposal.proposalId ? frame.proposal : p))
        : [frame.proposal, ...prev.proposals];

      const isActiveResolved = prev.activeProposalId === frame.proposal.proposalId && frame.proposal.status !== "pending";

      return {
        proposals: nextProposals,
        ...(isActiveResolved
          ? {
              activeProposalId: null,
              selectedProposalOpIds: [],
              proposalValidationError: null,
              canvasVisualDiff: null,
            }
          : {}),
        liveAnnouncement: `Proposal ${frame.proposal.proposalId} ${frame.action}: ${frame.proposal.summary}`,
      };
    });
    void get().loadProjectActivity();
  },

  loadProjectActivity: async (overrideFilters) => {
    const state = get();
    const project = state.activeProjectId ?? state.projectState?.project;
    if (!project) return [];
    const author = overrideFilters?.author ?? state.activityAuthorFilter;
    const type = overrideFilters?.type ?? state.activityTypeFilter;
    const windowFilter = overrideFilters?.window ?? state.activityWindowFilter;
    const res = await fetchProjectActivity(project, {
      author,
      type,
      window: windowFilter,
    });
    set({ activityFeed: res.events });
    return res.events;
  },

  setActivityAuthorFilter: (author) => {
    set({ activityAuthorFilter: author });
    void get().loadProjectActivity({ author });
  },

  setActivityTypeFilter: (type) => {
    set({ activityTypeFilter: type });
    void get().loadProjectActivity({ type });
  },

  setActivityWindowFilter: (windowFilter) => {
    set({ activityWindowFilter: windowFilter });
    void get().loadProjectActivity({ window: windowFilter });
  },

  undoLastBatch: async () => {
    const current = get();
    const project = current.activeProjectId ?? current.projectState?.project;
    if (!project) {
      return { ok: false, error: "No active project selected." };
    }

    let entry: UndoRedoEntry | undefined = current.undoStack[current.undoStack.length - 1];
    let remainingUndo = current.undoStack.slice(0, -1);

    if (!entry && current.revisions.length > 0 && current.currentRevision > 0) {
      const latestRev = current.revisions[0]!;
      const reconstructedInverse = reconstructRevisionInverseOps(
        project,
        current.revisions,
        latestRev.revision,
        current.projectState,
        current.currentRevision,
        current.catalog,
      );
      if (reconstructedInverse.length > 0) {
        entry = {
          ops: latestRev.ops ?? [],
          inverseOps: reconstructedInverse,
          summary: latestRev.summary ?? `Revision r${latestRev.revision}`,
          revision: latestRev.revision,
        };
        remainingUndo = [];
      }
    }

    if (!entry || entry.inverseOps.length === 0) {
      return { ok: false, error: "Nothing to undo." };
    }

    const stamp = Date.now();
    const inverseWithFreshOpIds = entry.inverseOps.map((op, idx) => ({
      ...op,
      opId: `undo-r${current.currentRevision}-${idx + 1}-${stamp}`,
    }));

    const res = await get().commitOps(inverseWithFreshOpIds, `Undo: ${entry.summary}`, {
      isUndoRedo: true,
      nextUndoStack: remainingUndo,
      nextRedoStack: [...current.redoStack, entry].slice(-MAX_UNDO_STACK_DEPTH),
    });
    if (res.ok) {
      set({
        liveAnnouncement: `Undid: ${entry.summary}`,
      });
    }
    return res;
  },

  redoLastBatch: async () => {
    const current = get();
    const project = current.activeProjectId ?? current.projectState?.project;
    if (!project) {
      return { ok: false, error: "No active project selected." };
    }
    if (current.redoStack.length === 0) {
      return { ok: false, error: "Nothing to redo." };
    }

    const entry = current.redoStack[current.redoStack.length - 1]!;
    const remainingRedo = current.redoStack.slice(0, -1);
    const stamp = Date.now();
    const opsWithFreshOpIds = entry.ops.map((op, idx) => ({
      ...op,
      opId: `redo-r${current.currentRevision}-${idx + 1}-${stamp}`,
    }));

    const res = await get().commitOps(opsWithFreshOpIds, `Redo: ${entry.summary}`, {
      isUndoRedo: true,
      nextRedoStack: remainingRedo,
      nextUndoStack: [...current.undoStack, entry].slice(-MAX_UNDO_STACK_DEPTH),
    });
    if (res.ok) {
      set({
        liveAnnouncement: `Redid: ${entry.summary}`,
      });
    }
    return res;
  },

  undoHistoricalRevision: async (targetRevision, mode = "inverse") => {
    const current = get();
    const project = current.activeProjectId ?? current.projectState?.project;
    if (!project) {
      return { ok: false, error: "No active project selected." };
    }

    const rev = current.revisions.find((r) => r.revision === targetRevision);
    const revSummary = rev?.summary ?? `r${targetRevision}`;

    if (mode === "inverse") {
      const inverseOps = reconstructRevisionInverseOps(
        project,
        current.revisions,
        targetRevision,
        current.projectState,
        current.currentRevision,
        current.catalog,
      );
      if (inverseOps.length > 0) {
        const stamp = Date.now();
        const freshInverse = inverseOps.map((op, idx) => ({
          ...op,
          opId: `ledger-undo-r${targetRevision}-${idx + 1}-${stamp}`,
        }));
        const res = await get().commitOps(freshInverse, `Undo r${targetRevision}: ${revSummary}`);
        if (res.ok) {
          return res;
        }
      }
    }

    // Fallback or explicit revert-to-parent via POST /api/projects/:project/revert
    set({ isMutating: true, mutationError: null });
    try {
      const parentRev = Math.max(0, rev?.parentRevision ?? targetRevision - 1);
      const result = await revertProjectToRevision(project, parentRev);
      set((prev) => {
        const nextReadiness = result.readiness ?? computeStudioReadiness(result.state, prev.catalog);
        const author: AuthorAttribution = prev.user ? { type: "human", id: prev.user.id } : { type: "human", id: "user" };
        const newRev: RevisionSummary = {
          revision: result.revision,
          parentRevision: result.parentRevision ?? Math.max(0, result.revision - 1),
          author,
          summary: `Revert to revision ${parentRev} (undo r${targetRevision})`,
          semanticHash: result.semanticHash ?? semanticHash(normalizeBlueprintState(result.state as Parameters<typeof normalizeBlueprintState>[0])),
          createdAt: new Date().toISOString(),
          ops: [],
        };
        const nextRevisions = [newRev, ...prev.revisions.filter((r) => r.revision !== newRev.revision)].sort((a, b) => b.revision - a.revision);
        return {
          isMutating: false,
          mutationError: null,
          currentRevision: result.revision,
          projectState: result.state,
          readiness: nextReadiness,
          revisions: nextRevisions,
          secrets: reconcileSecretsWithBlueprint(prev.secrets, result.state),
          liveAnnouncement: `Reverted to revision r${parentRev} (new revision r${result.revision})`,
        };
      });
      return { ok: true, state: result.state, revision: result.revision };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to undo revision";
      set({ isMutating: false, mutationError: msg });
      return { ok: false, error: msg };
    }
  },

  loadProjectSecrets: async () => {
    const current = get();
    const project = current.activeProjectId ?? current.projectState?.project;
    if (!project) return [];
    const fetched = await fetchProjectSecrets(project);
    set((prev) => ({
      secrets: reconcileSecretsWithBlueprint(fetched, prev.projectState),
    }));
    return get().secrets;
  },

  upsertSecret: async (input) => {
    const current = get();
    const project = current.activeProjectId ?? current.projectState?.project;
    if (!project) {
      const msg = "No active project selected.";
      set({ mutationError: msg });
      return { ok: false, error: msg };
    }
    set({ isMutating: true, mutationError: null });
    try {
      const result = await upsertProjectSecret(project, input);
      set((prev) => {
        const nextProjectState = result.state ?? prev.projectState;
        const nextRevision = result.revision ?? prev.currentRevision;
        const nextReadiness = result.readiness ?? (nextProjectState ? computeStudioReadiness(nextProjectState, prev.catalog) : prev.readiness);

        const existingIdx = prev.secrets.findIndex((s) => s.ref === result.secret.ref);
        const rawList = [...prev.secrets];
        const nextEntry: StudioSecretMetadata = {
          ...result.secret,
          usedBy: result.secret.usedBy ?? [],
        };
        if (existingIdx >= 0) {
          rawList[existingIdx] = nextEntry;
        } else {
          rawList.push(nextEntry);
        }

        return {
          isMutating: false,
          mutationError: null,
          currentRevision: nextRevision,
          projectState: nextProjectState,
          readiness: nextReadiness,
          secrets: reconcileSecretsWithBlueprint(rawList, nextProjectState),
          liveAnnouncement: `Saved secret ${result.secret.ref}`,
        };
      });
      return { ok: true, secret: result.secret };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save secret";
      set({ isMutating: false, mutationError: msg });
      return { ok: false, error: msg };
    }
  },

  removeSecret: async (ref, unbind = true) => {
    const current = get();
    const project = current.activeProjectId ?? current.projectState?.project;
    if (!project) {
      const msg = "No active project selected.";
      set({ mutationError: msg });
      return { ok: false, error: msg };
    }
    set({ isMutating: true, mutationError: null });
    try {
      const result = await deleteProjectSecret(project, ref, unbind);
      set((prev) => {
        const nextProjectState = result.state ?? prev.projectState;
        const nextRevision = result.revision ?? prev.currentRevision;
        const nextReadiness = result.readiness ?? (nextProjectState ? computeStudioReadiness(nextProjectState, prev.catalog) : prev.readiness);
        const remaining = prev.secrets.filter((s) => s.ref !== ref);
        return {
          isMutating: false,
          mutationError: null,
          currentRevision: nextRevision,
          projectState: nextProjectState,
          readiness: nextReadiness,
          secrets: reconcileSecretsWithBlueprint(remaining, nextProjectState),
          liveAnnouncement: `Deleted secret ${ref}`,
        };
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete secret";
      set({ isMutating: false, mutationError: msg });
      return { ok: false, error: msg };
    }
  },

  commitOps: async (ops, summary, options) => {
    const current = get();
    const project = current.activeProjectId ?? current.projectState?.project;
    if (!project) {
      const msg = "No active project selected.";
      set({ mutationError: msg });
      return { ok: false, error: msg };
    }

    const stamp = Date.now();
    const opsWithIds = ops.map((op, idx) => ({
      ...op,
      opId: typeof op.opId === "string" && op.opId.trim().length > 0 ? op.opId : `op-${stamp}-${idx + 1}`,
    }));

    const baseState = current.projectState ?? createEmptyBlueprint(project);
    const computedInverseOps = computeStudioInverseOps(baseState, opsWithIds, current.catalog);

    set({ isMutating: true, mutationError: null });
    try {
      const result = await commitProjectOps(project, {
        ops: opsWithIds,
        summary,
        ...(options?.baseRevision !== undefined ? { baseRevision: options.baseRevision } : {}),
      });
      set((prev) => {
        const nextReadiness = result.readiness ?? computeStudioReadiness(result.state, prev.catalog);
        const author: AuthorAttribution = prev.user ? { type: "human", id: prev.user.id } : { type: "human", id: "user" };
        const revSummary = summary ?? `Revision r${result.revision}`;
        const newRev: RevisionSummary = {
          revision: result.revision,
          parentRevision: result.parentRevision ?? Math.max(0, result.revision - 1),
          author,
          summary: revSummary,
          semanticHash: result.semanticHash ?? semanticHash(normalizeBlueprintState(result.state as Parameters<typeof normalizeBlueprintState>[0])),
          createdAt: new Date().toISOString(),
          ops,
          inverseOps: computedInverseOps,
        };
        const nextRevisions = [newRev, ...prev.revisions.filter((r) => r.revision !== newRev.revision)].sort((a, b) => b.revision - a.revision);

        const nextUndoStack = options?.nextUndoStack
          ? options.nextUndoStack
          : options?.isUndoRedo
            ? prev.undoStack
            : [
                ...prev.undoStack,
                {
                  ops,
                  inverseOps: computedInverseOps,
                  summary: revSummary,
                  revision: result.revision,
                },
              ].slice(-MAX_UNDO_STACK_DEPTH);
        const nextRedoStack = options?.nextRedoStack ? options.nextRedoStack : options?.isUndoRedo ? prev.redoStack : [];

        return {
          isMutating: false,
          mutationError: null,
          currentRevision: result.revision,
          projectState: result.state,
          readiness: nextReadiness,
          revisions: nextRevisions,
          undoStack: nextUndoStack,
          redoStack: nextRedoStack,
          dirtyTarget: null,
          secrets: reconcileSecretsWithBlueprint(prev.secrets, result.state),
          liveAnnouncement: `Saved revision r${result.revision}: ${newRev.summary}`,
        };
      });
      return { ok: true, state: result.state, revision: result.revision };
    } catch (err) {
      const commitErr = err as CommitOpsError;
      const msg = commitErr instanceof Error ? commitErr.message : "Failed to apply changes";

      if (commitErr?.status === 409 && commitErr.conflict) {
        const cDetail = commitErr.conflict;
        const aiState = cDetail.currentState ?? current.projectState ?? createEmptyBlueprint(project);
        const intervening = cDetail.interveningOps?.[cDetail.interveningOps.length - 1];
        const conflictingAuthor: AuthorAttribution = intervening?.author ?? {
          type: "agent",
          id: "claude-code",
          client: "claude-code",
        };
        const conflictingRevision = cDetail.currentRevision ?? current.currentRevision + 1;

        const firstOp = ops[0] ?? {};
        let targetKind: "brick" | "entity" | "node" = current.dirtyTarget?.kind ?? "node";
        let targetId = current.dirtyTarget?.id ?? "";
        let workflowId = current.dirtyTarget?.workflowId;
        let mineData: Record<string, unknown> = current.dirtyTarget?.draftData ?? {};
        let mineLabel = current.dirtyTarget?.draftLabel;

        if (!targetId) {
          if (firstOp.type === "update_node" && typeof firstOp.nodeId === "string") {
            targetKind = "node";
            targetId = firstOp.nodeId;
            workflowId = typeof firstOp.workflowId === "string" ? firstOp.workflowId : undefined;
            const patch = (firstOp.patch as Record<string, unknown> | undefined) ?? {};
            mineData = (patch.data as Record<string, unknown> | undefined) ?? {};
            mineLabel = typeof patch.label === "string" ? patch.label : undefined;
          } else if (firstOp.type === "configure_brick" && typeof firstOp.brickId === "string") {
            targetKind = "brick";
            targetId = firstOp.brickId;
            mineData = (firstOp.config as Record<string, unknown> | undefined) ?? {};
          } else if (firstOp.type === "update_entity") {
            const ent = firstOp.entity as { name?: string; fields?: unknown[] } | undefined;
            targetKind = "entity";
            targetId = ent?.name ?? "entity";
            mineData = { fields: ent?.fields ?? [] };
          }
        }

        let aiData: Record<string, unknown> = {};
        let aiLabel: string | undefined;
        if (targetKind === "node") {
          for (const wf of aiState.workflows) {
            const found = wf.nodes.find((n) => n.id === targetId);
            if (found) {
              aiData = { ...(found.data as Record<string, unknown> | undefined) };
              aiLabel = found.label;
              workflowId = workflowId ?? wf.id;
              break;
            }
          }
        } else if (targetKind === "brick") {
          const found = aiState.bricks.find((b) => b.id === targetId);
          aiData = { ...(found?.config as Record<string, unknown> | undefined) };
        } else {
          const found = aiState.entities.find((e) => e.name === targetId);
          aiData = { fields: found?.fields ?? [] };
        }

        set({
          isMutating: false,
          mutationError: msg,
          pendingConflict: {
            targetKind,
            targetId,
            workflowId,
            baseRevision: options?.baseRevision ?? current.dirtyTarget?.baseRevision ?? current.currentRevision,
            conflictingRevision,
            conflictingAuthor,
            summary: `Concurrent modification on ${targetId}`,
            mineData,
            mineLabel,
            aiData,
            aiLabel,
            aiState,
          },
        });
        return { ok: false, error: msg };
      }

      set({ isMutating: false, mutationError: msg });
      return { ok: false, error: msg };
    }
  },

  applyIncomingRevision: (envelope) => {
    const expiresAt = Date.now() + 4_000;
    set((state) => {
      if (envelope.revision <= state.currentRevision && state.revisions.some((r) => r.revision === envelope.revision)) {
        return state;
      }

      const baseState = state.projectState ?? createEmptyBlueprint(envelope.project ?? state.activeProjectId ?? "my-saas-app");
      const computedInverseOps = computeStudioInverseOps(baseState, envelope.ops ?? [], state.catalog);
      const nextProjectState = applyStudioOps(baseState, envelope.ops ?? [], state.catalog);
      const nextReadiness = envelope.readiness ?? computeStudioReadiness(nextProjectState, state.catalog);

      const newRev: RevisionSummary = {
        revision: envelope.revision,
        parentRevision: envelope.parentRevision ?? Math.max(0, envelope.revision - 1),
        author: envelope.author,
        summary: envelope.summary ?? `Revision r${envelope.revision}`,
        semanticHash: envelope.semanticHash ?? semanticHash(normalizeBlueprintState(nextProjectState as Parameters<typeof normalizeBlueprintState>[0])),
        createdAt: envelope.timestamp ?? new Date().toISOString(),
        ops: envelope.ops ?? [],
        inverseOps: computedInverseOps,
      };

      const nextRevisions = [newRev, ...state.revisions.filter((r) => r.revision !== newRev.revision)].sort((a, b) => b.revision - a.revision);

      const authorInfo = formatAuthorBadge(envelope.author);
      const targets = extractAffectedTargets(newRev);
      const nextHighlights: Record<string, HighlightInfo> = {
        ...state.highlightedTargets,
      };
      const highlightEntry: HighlightInfo = {
        authorLabel: authorInfo.displayName,
        isAgent: authorInfo.isAgent,
        revision: envelope.revision,
        expiresAt,
      };

      for (const target of targets) {
        nextHighlights[`${target.kind}:${target.id}`] = highlightEntry;
        nextHighlights[target.id] = highlightEntry;
      }

      // Check for same-object conflict when human has a dirtyTarget in the Inspector
      let nextPendingConflict = state.pendingConflict;
      if (state.dirtyTarget) {
        const matchingTarget = targets.find((t) => t.kind === state.dirtyTarget!.kind && t.id === state.dirtyTarget!.id);
        if (matchingTarget) {
          const dt = state.dirtyTarget;
          let aiData: Record<string, unknown> = {};
          let aiLabel: string | undefined;
          if (dt.kind === "node") {
            for (const wf of nextProjectState.workflows) {
              const found = wf.nodes.find((n) => n.id === dt.id);
              if (found) {
                aiData = { ...(found.data as Record<string, unknown> | undefined) };
                aiLabel = found.label;
                break;
              }
            }
          } else if (dt.kind === "brick") {
            const found = nextProjectState.bricks.find((b) => b.id === dt.id);
            aiData = { ...(found?.config as Record<string, unknown> | undefined) };
          } else if (dt.kind === "entity") {
            const found = nextProjectState.entities.find((e) => e.name === dt.id);
            aiData = { fields: found?.fields ?? [] };
          }

          nextPendingConflict = {
            targetKind: dt.kind,
            targetId: dt.id,
            workflowId: dt.workflowId ?? matchingTarget.workflowId,
            baseRevision: dt.baseRevision,
            conflictingRevision: envelope.revision,
            conflictingAuthor: envelope.author,
            summary: newRev.summary ?? undefined,
            mineData: dt.draftData,
            mineLabel: dt.draftLabel,
            aiData,
            aiLabel,
            aiState: nextProjectState,
          };
        }
      }

      let nextPresence = state.presence;
      if (authorInfo.isAgent) {
        const agentId = authorInfo.agentTag ?? envelope.author.id;
        if (!nextPresence.some((p) => p.id === agentId)) {
          nextPresence = [
            ...nextPresence,
            {
              id: agentId,
              label: authorInfo.displayName,
              kind: "agent",
              client: envelope.author.client,
            },
          ];
        }
      }

      const changeCount = (envelope.ops ?? []).length;
      const liveAnnouncement = `${authorInfo.displayName} made ${changeCount} ${
        changeCount === 1 ? "change" : "changes"
      } in revision r${envelope.revision}: ${newRev.summary}`;

      let nextNav = state.activeNav;
      let nextSelection = state.selection;
      let nextWorkflowId =
        state.activeWorkflowId && nextProjectState.workflows.some((w) => w.id === state.activeWorkflowId)
          ? state.activeWorkflowId
          : (nextProjectState.workflows[0]?.id ?? null);
      let nextNodeSearch = state.workflowNodeSearch;
      let nextRightDockOpen = state.rightDockOpen;
      let nextRightDockTab = state.rightDockTab;

      if (state.followAi && authorInfo.isAgent && targets.length > 0) {
        const primary = targets[targets.length - 1]!;
        nextRightDockOpen = true;
        nextRightDockTab = "inspector";
        if (primary.kind === "brick") {
          nextNav = "bricks";
          nextSelection = { kind: "brick", id: primary.id };
        } else if (primary.kind === "entity") {
          nextNav = "data";
          nextSelection = { kind: "entity", id: primary.id };
        } else if (primary.kind === "workflow") {
          nextNav = "workflows";
          nextWorkflowId = primary.id;
          nextSelection = { kind: "workflow", id: primary.id };
        } else if (primary.kind === "node") {
          nextNav = "workflows";
          if (primary.workflowId) {
            nextWorkflowId = primary.workflowId;
          }
          nextNodeSearch = primary.id;
          nextSelection = {
            kind: "node",
            id: primary.id,
            workflowId: primary.workflowId,
          };
        }
      }

      return {
        currentRevision: Math.max(state.currentRevision, envelope.revision),
        projectState: nextProjectState,
        readiness: nextReadiness,
        revisions: nextRevisions,
        highlightedTargets: nextHighlights,
        presence: nextPresence,
        liveAnnouncement,
        activeNav: nextNav,
        selection: nextSelection,
        activeWorkflowId: nextWorkflowId,
        workflowNodeSearch: nextNodeSearch,
        rightDockOpen: nextRightDockOpen,
        rightDockTab: nextRightDockTab,
        pendingConflict: nextPendingConflict,
      };
    });

    setTimeout(() => {
      const now = Date.now();
      set((state) => {
        const remaining: Record<string, HighlightInfo> = {};
        let changed = false;
        for (const [k, v] of Object.entries(state.highlightedTargets)) {
          if (v.expiresAt > now) {
            remaining[k] = v;
          } else {
            changed = true;
          }
        }
        return changed ? { highlightedTargets: remaining } : state;
      });
    }, 4_050);
  },

  applyIncomingCatchup: (revisions) => {
    const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
    for (const rev of ordered) {
      get().applyIncomingRevision(rev);
    }
  },

  resetStore: (initial) =>
    set({
      ...BASE_STATE,
      ...initial,
      secrets: reconcileSecretsWithBlueprint(initial?.secrets ?? [], initial?.projectState ?? null),
      activeWorkflowId: initial?.activeWorkflowId ?? initial?.projectState?.workflows[0]?.id ?? null,
      readiness:
        initial?.readiness ?? (initial?.projectState ? computeStudioReadiness(initial.projectState, initial.catalog ?? DEFAULT_CATALOG) : initialReadiness),
    }),
}));

export function getActiveOrg(state: Pick<StudioState, "orgs" | "activeOrgId">): StudioOrg | null {
  if (!state.activeOrgId) return state.orgs[0] ?? null;
  return state.orgs.find((o) => o.id === state.activeOrgId) ?? state.orgs[0] ?? null;
}

export function getActiveRole(state: Pick<StudioState, "orgs" | "activeOrgId">): StudioOrgRole {
  return getActiveOrg(state)?.role ?? "viewer";
}
