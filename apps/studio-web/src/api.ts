import { createEmptyBlueprint } from "@poc/blueprint";
import { QueryClient } from "@tanstack/react-query";
import { DEFAULT_CATALOG } from "./types.ts";
import type {
  BlueprintState,
  CatalogBrickManifest,
  ProposalRecord,
  ProposalStatus,
  ReadinessResult,
  RevisionSummary,
  SemanticDiffPayload,
  StudioConnectionRequest,
  StudioOrg,
  StudioProjectSummary,
  StudioSecretKind,
  StudioSecretMetadata,
  StudioSecretStatus,
  StudioUser,
  WorkflowDefinition,
} from "./types.ts";

export function createStudioQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export async function fetchAuthMe(): Promise<{
  user: StudioUser | null;
  orgs: StudioOrg[];
}> {
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!res.ok) {
      return { user: null, orgs: [] };
    }
    const data = (await res.json()) as {
      user?: { id: string; email?: string; name?: string; displayName?: string };
      orgs?: StudioOrg[];
    };
    if (!data.user?.id) {
      return { user: null, orgs: [] };
    }
    return {
      user: {
        id: data.user.id,
        email: data.user.email ?? "",
        name: data.user.name ?? data.user.displayName ?? data.user.email ?? "User",
      },
      orgs: data.orgs ?? [],
    };
  } catch {
    return { user: null, orgs: [] };
  }
}

export async function signInWithEmail(input: {
  email: string;
  password: string;
}): Promise<{ user: StudioUser }> {
  const res = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(body?.error?.message ?? body?.message ?? `Sign-in failed (${res.status})`);
  }
  const data = (await res.json()) as { user?: StudioUser };
  return {
    user: data.user ?? {
      id: "user_session",
      email: input.email,
      name: input.email.split("@")[0] ?? "User",
    },
  };
}

export async function signUpWithEmail(input: {
  name: string;
  email: string;
  password: string;
}): Promise<{ user: StudioUser }> {
  const res = await fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(body?.error?.message ?? body?.message ?? `Sign-up failed (${res.status})`);
  }
  const data = (await res.json()) as { user?: StudioUser };
  return {
    user: data.user ?? {
      id: "user_session",
      email: input.email,
      name: input.name,
    },
  };
}

export async function fetchStudioOrgs(): Promise<StudioOrg[]> {
  const res = await fetch("/api/orgs", { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      body?.error?.message ?? body?.message ?? `Failed to load organizations (${res.status})`,
    );
  }
  const data = (await res.json()) as { orgs?: StudioOrg[] };
  return data.orgs ?? [];
}

export async function fetchStudioProjects(): Promise<StudioProjectSummary[]> {
  const res = await fetch("/api/projects", { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      body?.error?.message ?? body?.message ?? `Failed to load projects (${res.status})`,
    );
  }
  const data = (await res.json()) as { projects?: StudioProjectSummary[] };
  return data.projects ?? [];
}

export async function createOrgProject(
  orgId: string,
  project: string,
): Promise<{
  project: string;
  orgId: string;
  revision: number;
  state: BlueprintState;
  readiness?: ReadinessResult;
}> {
  const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ project }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      err?.error?.message ?? err?.message ?? `Failed to create project (${res.status})`,
    );
  }
  const data = (await res.json()) as {
    project: string;
    orgId: string;
    revision: number;
    state?: BlueprintState;
    readiness?: ReadinessResult;
  };
  return {
    project: data.project,
    orgId: data.orgId,
    revision: data.revision ?? 0,
    state: data.state ?? createEmptyBlueprint(project),
    readiness: data.readiness,
  };
}

export async function importProjectBundle(
  project: string,
  blueprint: BlueprintState,
  mode: "create" | "replace" = "replace",
  templateId?: string,
): Promise<{
  project: string;
  revision: number;
  state: BlueprintState;
  semanticHash?: string;
  readiness?: ReadinessResult;
}> {
  const bundle = {
    ...blueprint,
    project,
  };
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      bundle,
      mode,
      ...(templateId ? { templateId } : {}),
    }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      err?.error?.message ?? err?.message ?? `Failed to import preset (${res.status})`,
    );
  }
  return (await res.json()) as {
    project: string;
    revision: number;
    state: BlueprintState;
    semanticHash?: string;
    readiness?: ReadinessResult;
  };
}

export async function fetchProjectDetail(project: string): Promise<{
  project: string;
  revision: number;
  state: BlueprintState;
  semanticHash: string;
  readiness: ReadinessResult;
  revisions?: RevisionSummary[];
}> {
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to load project "${project}" (${res.status})`);
  }
  const data = (await res.json()) as {
    project: string;
    revision: number;
    state: BlueprintState;
    semanticHash: string;
    readiness: ReadinessResult;
  };
  return data;
}

export async function fetchBrickCatalog(): Promise<Record<string, CatalogBrickManifest>> {
  try {
    const res = await fetch("/api/catalog", { credentials: "include" });
    if (!res.ok) return DEFAULT_CATALOG;
    const data = (await res.json()) as { bricks?: Record<string, CatalogBrickManifest> };
    return data.bricks ?? DEFAULT_CATALOG;
  } catch {
    return DEFAULT_CATALOG;
  }
}

export async function fetchProjectRevisions(
  project: string,
  limit = 50,
): Promise<RevisionSummary[]> {
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(project)}/revisions?limit=${limit}`,
      { credentials: "include" },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { revisions?: RevisionSummary[] };
    return data.revisions ?? [];
  } catch {
    return [];
  }
}

export async function fetchProjectDiff(
  project: string,
  fromRev: number,
  toRev: number,
): Promise<SemanticDiffPayload> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/diff?from=${fromRev}&to=${toRev}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to load diff r${fromRev}..r${toRev} (${res.status})`);
  }
  return (await res.json()) as SemanticDiffPayload;
}

export interface CommitOpsResponse {
  project: string;
  revision: number;
  parentRevision?: number;
  state: BlueprintState;
  semanticHash: string;
  readiness: ReadinessResult;
}

export interface CommitOpsConflictDetail {
  code?: string;
  message?: string;
  baseRevision?: number;
  currentRevision?: number;
  conflicts?: Array<{
    opIndex: number;
    incomingOp: Record<string, unknown>;
    conflictingRevision: number;
    conflictingOp: Record<string, unknown>;
    target: string;
  }>;
  currentState?: BlueprintState;
  interveningOps?: Array<{
    revision: number;
    author: { type: "human" | "agent"; id: string; client?: string };
    ops: Array<Record<string, unknown>>;
  }>;
}

export interface CommitOpsError extends Error {
  status?: number;
  conflict?: CommitOpsConflictDetail;
}

export async function commitProjectOps(
  project: string,
  input: {
    ops: Array<Record<string, unknown>>;
    baseRevision?: number;
    summary?: string;
  },
): Promise<CommitOpsResponse> {
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      ops: input.ops,
      ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: CommitOpsConflictDetail & {
        issues?: Array<{ code?: string; path?: string; message?: string }>;
      };
      message?: string;
    } | null;
    const issueMessages = body?.error?.issues
      ?.map((iss) => `${iss.path ? `${iss.path}: ` : ""}${iss.message ?? iss.code ?? "Invalid"}`)
      .join("; ");
    const detail =
      issueMessages ||
      body?.error?.message ||
      body?.message ||
      body?.error?.code ||
      `Request failed (${res.status})`;
    const err = new Error(detail) as CommitOpsError;
    err.status = res.status;
    if (res.status === 409 && body?.error) {
      err.conflict = body.error;
    }
    throw err;
  }
  return (await res.json()) as CommitOpsResponse;
}

export async function fetchProjectRevisionState(
  project: string,
  revision: number,
): Promise<{
  project: string;
  revision: number;
  state: BlueprintState;
  semanticHash: string;
  readiness: ReadinessResult;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/revisions/${revision}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to load revision r${revision} (${res.status})`);
  }
  return (await res.json()) as {
    project: string;
    revision: number;
    state: BlueprintState;
    semanticHash: string;
    readiness: ReadinessResult;
  };
}

export async function revertProjectToRevision(
  project: string,
  targetRevision: number,
  baseRevision?: number,
): Promise<CommitOpsResponse> {
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/revert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      targetRevision,
      ...(baseRevision !== undefined ? { baseRevision } : {}),
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
      message?: string;
    } | null;
    throw new Error(
      body?.error?.message ??
        body?.message ??
        body?.error?.code ??
        `Revert to r${targetRevision} failed (${res.status})`,
    );
  }
  return (await res.json()) as CommitOpsResponse;
}

export async function fetchProjectSecrets(
  project: string,
): Promise<StudioSecretMetadata[]> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/secrets`,
    { credentials: "include" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      body?.error?.message ??
        body?.message ??
        `Failed to load secrets (${res.status})`,
    );
  }
  const data = (await res.json()) as { secrets?: StudioSecretMetadata[] };
  return data.secrets ?? [];
}

export interface UpsertSecretInput {
  ref: string;
  kind: StudioSecretKind;
  label: string;
  appOrBrick: string;
  envScope?: string;
  value: string;
  bindTarget?: {
    targetKind: "brick" | "node" | "connection";
    targetId: string;
    secretName: string;
  };
}

export interface UpsertSecretResponse {
  secret: StudioSecretMetadata;
  revision?: number;
  state?: BlueprintState;
  semanticHash?: string;
  readiness?: ReadinessResult;
}

export async function upsertProjectSecret(
  project: string,
  input: UpsertSecretInput,
): Promise<UpsertSecretResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/secrets`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      body?.error?.message ??
        body?.message ??
        `Failed to save secret (${res.status})`,
    );
  }
  return (await res.json()) as UpsertSecretResponse;
}

export interface DeleteSecretResponse {
  deleted: boolean;
  ref: string;
  revision?: number;
  state?: BlueprintState;
  semanticHash?: string;
  readiness?: ReadinessResult;
}

export async function deleteProjectSecret(
  project: string,
  ref: string,
  unbind = true,
): Promise<DeleteSecretResponse> {
  const url = `/api/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(ref)}${unbind ? "?unbind=true" : ""}`;
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      body?.error?.message ??
        body?.message ??
        `Failed to delete secret (${res.status})`,
    );
  }
  return (await res.json()) as DeleteSecretResponse;
}

export async function fetchProjectConnections(
  project: string,
): Promise<{
  connections: StudioSecretMetadata[];
  connectionRequests: StudioConnectionRequest[];
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/connections`,
    { credentials: "include" },
  );
  if (!res.ok) {
    return { connections: [], connectionRequests: [] };
  }
  const data = (await res.json()) as {
    connections?: StudioSecretMetadata[];
    connectionRequests?: StudioConnectionRequest[];
  };
  return {
    connections: data.connections ?? [],
    connectionRequests: data.connectionRequests ?? [],
  };
}

export async function testProjectConnection(
  project: string,
  ref: string,
): Promise<{
  ok: boolean;
  ref: string;
  status: StudioSecretStatus;
  lastCheckedAt: string;
  keyHint?: string;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/connections/${encodeURIComponent(ref)}/test`,
    {
      method: "POST",
      credentials: "include",
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      body?.error?.message ??
        body?.message ??
        `Connection test failed (${res.status})`,
    );
  }
  return (await res.json()) as {
    ok: boolean;
    ref: string;
    status: StudioSecretStatus;
    lastCheckedAt: string;
    keyHint?: string;
  };
}

export async function reauthorizeProjectConnection(
  project: string,
  ref: string,
  input?: { value?: string; accessToken?: string; refreshToken?: string },
): Promise<{
  ok: boolean;
  ref: string;
  status: StudioSecretStatus;
  authorizeUrl?: string;
  state?: string;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/connections/${encodeURIComponent(ref)}/reauthorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input ?? {}),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      body?.error?.message ??
        body?.message ??
        `Connection re-authorization failed (${res.status})`,
    );
  }
  return (await res.json()) as {
    ok: boolean;
    ref: string;
    status: StudioSecretStatus;
    authorizeUrl?: string;
    state?: string;
  };
}

export async function startOAuthConnection(
  project: string,
  app: string,
  options?: { ref?: string; scopes?: string[] },
): Promise<{
  ok: boolean;
  app: string;
  connectionRef: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  authorizeUrl: string;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/connections/oauth/${encodeURIComponent(app)}/start`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(options ?? {}),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      body?.error?.message ??
        body?.message ??
        `OAuth2 start failed (${res.status})`,
    );
  }
  return (await res.json()) as {
    ok: boolean;
    app: string;
    connectionRef: string;
    state: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    authorizeUrl: string;
  };
}

export interface TestStepStructuredError {
  message: string;
  whatHappened: string;
  why: string;
  whatToDo: string;
  field?: string | null;
  stack?: string | null;
}

export interface TestStepResponse {
  ok: boolean;
  runId: string;
  workflowId: string;
  revision: number;
  nodeId: string;
  nodeType: string;
  status: "succeeded" | "failed";
  durationMs: number;
  inputPreview: string;
  outputPreview: string;
  output: Record<string, unknown>;
  error?: TestStepStructuredError;
}

export interface RunNodeTestStepInput {
  nodeType?: string;
  config?: Record<string, unknown>;
  input?: unknown;
  workspaceId?: string;
  upstreamSteps?: Record<string, Record<string, unknown>>;
  env?: string;
  orgId?: string;
}

export async function runNodeTestStep(
  project: string,
  workflowId: string,
  nodeId: string,
  body: RunNodeTestStepInput,
): Promise<TestStepResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/test-step`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
      message?: string;
    } | null;
    const msg =
      errBody?.error?.message ??
      errBody?.message ??
      `Test step failed (${res.status})`;
    throw new Error(msg);
  }
  return (await res.json()) as TestStepResponse;
}

export type TelemetryStepStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export interface WorkflowRunStepEvent {
  eventId: string;
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
  createdAt: string;
  cursor?: number;
  fromPinned?: boolean;
  reused?: boolean;
}

export interface WorkflowRunApiResponse {
  ok: boolean;
  runId: string;
  workflowId: string;
  revision: number;
  triggerType: string;
  workspaceId: string;
  env?: "preview" | "production";
  status: "queued" | "running" | "succeeded" | "failed";
  runStatus?: "succeeded" | "failed";
  durationMs: number;
  outputs: Record<string, Record<string, unknown>>;
  failed: Record<string, string>;
  skipped: string[];
  stepEvents: WorkflowRunStepEvent[];
  retryOfRunId?: string | null;
  sourceRunId?: string;
  fromNodeId?: string;
}

export interface TriggerWorkflowRunInput {
  triggerPayload?: unknown;
  env?: "preview" | "production";
  workspaceId?: string;
  triggerType?: string;
  usePinnedOutputs?: boolean;
}

export async function triggerWorkflowRun(
  project: string,
  workflowId: string,
  body: TriggerWorkflowRunInput = {},
): Promise<WorkflowRunApiResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/workflows/${encodeURIComponent(workflowId)}/runs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
      message?: string;
    } | null;
    const msg =
      errBody?.error?.message ??
      errBody?.message ??
      `Workflow run failed (${res.status})`;
    throw new Error(msg);
  }
  return (await res.json()) as WorkflowRunApiResponse;
}

export interface TelemetryEventsPage {
  project: string;
  events: WorkflowRunStepEvent[];
  nextCursor: number;
  hasMore: boolean;
}

export async function fetchTelemetryEvents(
  project: string,
  params: { after?: number; runId?: string; limit?: number } = {},
): Promise<TelemetryEventsPage> {
  const search = new URLSearchParams();
  if (params.after !== undefined) search.set("after", String(params.after));
  if (params.runId) search.set("runId", params.runId);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const qs = search.toString();
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/telemetry/events${qs ? `?${qs}` : ""}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch telemetry events (${res.status})`);
  }
  return (await res.json()) as TelemetryEventsPage;
}

export interface RunHistoryItem {
  runId: string;
  workflowId: string;
  revision: number;
  triggerType: string;
  workspaceId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  durationMs: number;
  retries: number;
  retryOfRunId?: string | null;
  errorStack?: string | null;
  startedAt: string;
  endedAt?: string | null;
  failedNodeId?: string | null;
  stepCount?: number;
  resolvedByRunId?: string | null;
}

export interface RunHistoryFilterParams {
  env?: "preview" | "production";
  workflowId?: string;
  status?: string;
  trigger?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface RunHistoryPageResponse {
  project: string;
  env: "preview" | "production";
  runs: RunHistoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function fetchProjectRuns(
  project: string,
  filters: RunHistoryFilterParams = {},
): Promise<RunHistoryPageResponse> {
  const search = new URLSearchParams();
  if (filters.env) search.set("env", filters.env);
  if (filters.workflowId && filters.workflowId !== "all") {
    search.set("workflowId", filters.workflowId);
  }
  if (filters.status && filters.status !== "all") {
    search.set("status", filters.status);
  }
  if (filters.trigger && filters.trigger !== "all") {
    search.set("trigger", filters.trigger);
  }
  if (filters.from) search.set("from", filters.from);
  if (filters.to) search.set("to", filters.to);
  if (filters.cursor) search.set("cursor", filters.cursor);
  if (filters.limit !== undefined) search.set("limit", String(filters.limit));

  const qs = search.toString();
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/runs${qs ? `?${qs}` : ""}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      errBody?.error?.message ??
        errBody?.message ??
        `Failed to load run history (${res.status})`,
    );
  }
  return (await res.json()) as RunHistoryPageResponse;
}

export interface RunReplayDetailResponse {
  project: string;
  env: "preview" | "production";
  run: RunHistoryItem;
  stepEvents: WorkflowRunStepEvent[];
  currentRevision: number;
  historicalRevision: number;
  isHistoricalRevision: boolean;
  historicalState: BlueprintState;
  historicalWorkflow: WorkflowDefinition | null;
}

export async function fetchProjectRunDetail(
  project: string,
  runId: string,
  env: "preview" | "production" = "preview",
): Promise<RunReplayDetailResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/runs/${encodeURIComponent(runId)}?env=${encodeURIComponent(env)}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      errBody?.error?.message ??
        errBody?.message ??
        `Failed to load run replay detail (${res.status})`,
    );
  }
  return (await res.json()) as RunReplayDetailResponse;
}

export interface PinnedNodeOutputRecord {
  output: unknown;
  sourceRunId?: string | null;
  pinnedAt: string;
}

export interface WorkflowPinsResponse {
  project: string;
  workflowId: string;
  pinnedOutputs: Record<string, PinnedNodeOutputRecord>;
}

export async function fetchWorkflowPins(
  project: string,
  workflowId: string,
): Promise<WorkflowPinsResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/workflows/${encodeURIComponent(workflowId)}/pins`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch pinned outputs (${res.status})`);
  }
  return (await res.json()) as WorkflowPinsResponse;
}

export async function pinWorkflowNodeOutput(
  project: string,
  workflowId: string,
  nodeId: string,
  body: { output: unknown; sourceRunId?: string | null },
): Promise<{
  ok: true;
  project: string;
  workflowId: string;
  nodeId: string;
  pin: PinnedNodeOutputRecord;
  pinnedOutputs: Record<string, PinnedNodeOutputRecord>;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/pin`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(
      errBody?.error?.message ??
        errBody?.message ??
        `Failed to pin node output (${res.status})`,
    );
  }
  return (await res.json()) as {
    ok: true;
    project: string;
    workflowId: string;
    nodeId: string;
    pin: PinnedNodeOutputRecord;
    pinnedOutputs: Record<string, PinnedNodeOutputRecord>;
  };
}

export async function unpinWorkflowNodeOutput(
  project: string,
  workflowId: string,
  nodeId: string,
): Promise<{
  ok: true;
  project: string;
  workflowId: string;
  nodeId: string;
  pinnedOutputs: Record<string, PinnedNodeOutputRecord>;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/pin`,
    {
      method: "DELETE",
      credentials: "include",
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to unpin node output (${res.status})`);
  }
  return (await res.json()) as {
    ok: true;
    project: string;
    workflowId: string;
    nodeId: string;
    pinnedOutputs: Record<string, PinnedNodeOutputRecord>;
  };
}

export async function rerunWorkflowFromNode(
  project: string,
  runId: string,
  body: {
    fromNodeId: string;
    useCurrentDraftRev?: boolean;
    env?: "preview" | "production";
  },
): Promise<WorkflowRunApiResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/runs/${encodeURIComponent(runId)}/rerun`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
      message?: string;
    } | null;
    throw new Error(
      errBody?.error?.message ??
        errBody?.message ??
        `Re-run from node failed (${res.status})`,
    );
  }
  return (await res.json()) as WorkflowRunApiResponse;
}

export interface CloudflarePermissionStatusRow {
  id:
    | "account_settings_read"
    | "workers_scripts_edit"
    | "d1_edit"
    | "queues_edit";
  label: string;
  required: boolean;
  granted: boolean;
  remediationUrl: string;
  plainError?: string;
}

export interface CloudflareAccountChoice {
  id: string;
  name: string;
  subdomain?: string | null;
}

export interface CloudflareTokenMetadataSummary {
  tokenRef: string;
  orgId: string;
  accountId: string;
  accountName: string;
  tokenLast4: string;
  scopes: string[];
  status: "active" | "revoked" | "expired";
  createdAt: string;
  lastVerifiedAt: string | null;
  revokedAt?: string | null;
}

export interface BlueprintDriftReportPayload {
  hasCodeDrift: boolean;
  hasGraphDrift: boolean;
  deployedRev: number | null;
  currentRev: number;
  deployedBuildHash: string | null;
  currentBuildHash: string;
  deployedCodeHash: string | null;
  currentCodeHash: string;
  deployedGraphHash: string | null;
  currentGraphHash: string;
}

export interface OutOfBandDriftItemPayload {
  resource: "worker" | "d1" | "queue" | "cron";
  expected: string;
  actual: string | null;
  message: string;
}

export interface DriftReportPayload {
  inSync: boolean;
  blueprintDrift: BlueprintDriftReportPayload;
  outOfBandDrift: OutOfBandDriftItemPayload[];
  checkedAt: string;
}

export interface EnvironmentDeploymentRecordPayload {
  deployId: string;
  versionNumber: number;
  versionLabel: string;
  projectId: string;
  orgId: string;
  envName: "preview" | "production";
  revision: number;
  buildHash: string;
  codeHash: string;
  graphHash: string;
  action: string;
  status: string;
  reusedCachedBuild: boolean;
  liveWithoutRedeploy: boolean;
  noChanges: boolean;
  rollbackFromDeploymentId: string | null;
  workerUrl: string;
  versionId: string;
  databaseId: string;
  actorId: string;
  steps?: DeploymentStepPayload[];
  createdAt: string;
}

export interface ProjectDeployEnvironmentRecord {
  projectId: string;
  orgId: string;
  envName: "preview" | "production";
  target: {
    type: "byoc";
    accountId: string;
    tokenRef: string;
    envName: "preview" | "production";
  };
  accountName: string;
  deployedRev: number | null;
  currentRev?: number;
  buildHash: string | null;
  codeHash: string | null;
  graphHash: string | null;
  deployedAt?: string | null;
  deployedBy?: string | null;
  rollbackFromDeploymentId?: string | null;
  driftReport?: DriftReportPayload;
  deployments?: EnvironmentDeploymentRecordPayload[];
  status: string;
  updatedAt: string;
}

export interface CloudflareVerificationReportPayload {
  ok: boolean;
  status: "active" | "disabled" | "expired" | "invalid";
  isGlobalApiKey: boolean;
  accountId?: string;
  accountName?: string;
  accounts?: CloudflareAccountChoice[];
  permissions: CloudflarePermissionStatusRow[];
  missingPermissionIds: string[];
  missingPermissionLabels: string[];
  remediationUrl: string;
  summaryMessage: string;
}

export interface CloudflareTemplateUrlPayload {
  orgId: string;
  templateUrl: string;
  dashboardUrl: string;
  tokenName: string;
  explanation: string;
  permissions: Array<{
    id: string;
    label: string;
    key: string;
    access: "read" | "edit";
    description: string;
  }>;
}

export const DEFAULT_CLOUDFLARE_TEMPLATE_URL =
  "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22queues%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&name=ProjectX+Studio+Deploy";

export async function fetchCloudflareTokenTemplate(
  orgId: string,
): Promise<CloudflareTemplateUrlPayload> {
  const res = await fetch(
    `/api/orgs/${encodeURIComponent(orgId)}/cloudflare-tokens/template-url`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch Cloudflare token template (${res.status})`);
  }
  return (await res.json()) as CloudflareTemplateUrlPayload;
}

export interface StudioSandboxSummaryPayload {
  sandboxId: string;
  projectId: string;
  orgId: string;
  status: "active" | "expired" | "promoted";
  previewUrl: string;
  buildHash: string;
  codeHash: string;
  graphHash: string;
  revision: number;
  createdAt: string;
  expiresAt: string;
  remainingDays: number;
  dailyRequestCount: number;
  dailyRequestLimit: number;
  d1RowCount: number;
  d1RowLimit: number;
}

export async function fetchProjectEnvironments(
  project: string,
  orgId?: string,
): Promise<{
  project: string;
  orgId: string;
  activeToken: CloudflareTokenMetadataSummary | null;
  environments: ProjectDeployEnvironmentRecord[];
  sandbox?: StudioSandboxSummaryPayload | null;
}> {
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments${qs}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch project environments (${res.status})`);
  }
  return (await res.json()) as {
    project: string;
    orgId: string;
    activeToken: CloudflareTokenMetadataSummary | null;
    environments: ProjectDeployEnvironmentRecord[];
    sandbox?: StudioSandboxSummaryPayload | null;
  };
}

export async function fetchProjectSandbox(
  project: string,
  orgId?: string,
): Promise<{
  project: string;
  orgId: string;
  sandbox: StudioSandboxSummaryPayload | null;
}> {
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/sandbox${qs}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch project sandbox (${res.status})`);
  }
  return (await res.json()) as {
    project: string;
    orgId: string;
    sandbox: StudioSandboxSummaryPayload | null;
  };
}

export async function deployProjectToSandbox(
  project: string,
  body: {
    orgId?: string;
    rev?: number;
  } = {},
): Promise<{
  ok: true;
  project: string;
  orgId: string;
  sandboxId: string;
  previewUrl: string;
  buildHash: string;
  codeHash: string;
  graphHash: string;
  revision: number;
  reusedCachedBuild: boolean;
  assembleCount: number;
  timeToPreviewMs: number;
  expiresAt: string;
  sandbox: StudioSandboxSummaryPayload;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/sandbox/deploy`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data?.ok) {
    const errObj = data?.error as { message?: string } | undefined;
    throw new Error(
      errObj?.message ?? `Failed to deploy instant sandbox preview (${res.status})`,
    );
  }
  return data as unknown as {
    ok: true;
    project: string;
    orgId: string;
    sandboxId: string;
    previewUrl: string;
    buildHash: string;
    codeHash: string;
    graphHash: string;
    revision: number;
    reusedCachedBuild: boolean;
    assembleCount: number;
    timeToPreviewMs: number;
    expiresAt: string;
    sandbox: StudioSandboxSummaryPayload;
  };
}

export async function promoteSandboxToByoc(
  project: string,
  body: {
    orgId?: string;
    token?: string;
    accountId?: string;
    accountName?: string;
  } = {},
): Promise<{
  ok: true;
  project: string;
  orgId: string;
  sandboxId: string;
  sandboxBuildHash: string;
  byocBuildHash: string;
  buildHash: string;
  codeHash: string;
  graphHash: string;
  assembleCalledDuringPromote: boolean;
  assembleCount: number;
  oldSandboxDestroyed: boolean;
  byocDeploy: {
    scriptName: string;
    versionId: string;
    databaseId: string;
    databaseName: string;
    url: string;
    buildHash: string;
    codeHash: string;
    graphHash: string;
    deployedAt: string;
  };
  environment: ProjectDeployEnvironmentRecord;
  token: CloudflareTokenMetadataSummary;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/sandbox/promote-to-byoc`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data?.ok) {
    const errObj = data?.error as { message?: string } | undefined;
    throw new Error(
      errObj?.message ?? `Failed to promote sandbox to BYOC (${res.status})`,
    );
  }
  return data as unknown as {
    ok: true;
    project: string;
    orgId: string;
    sandboxId: string;
    sandboxBuildHash: string;
    byocBuildHash: string;
    buildHash: string;
    codeHash: string;
    graphHash: string;
    assembleCalledDuringPromote: boolean;
    assembleCount: number;
    oldSandboxDestroyed: boolean;
    byocDeploy: {
      scriptName: string;
      versionId: string;
      databaseId: string;
      databaseName: string;
      url: string;
      buildHash: string;
      codeHash: string;
      graphHash: string;
      deployedAt: string;
    };
    environment: ProjectDeployEnvironmentRecord;
    token: CloudflareTokenMetadataSummary;
  };
}

export async function postCloudflareFunnelEvent(
  orgId: string,
  body: {
    step:
      | "wizard_opened"
      | "template_link_clicked"
      | "token_submitted"
      | "verification_failed"
      | "verification_succeeded"
      | "token_disconnected";
    projectId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await fetch(
      `/api/orgs/${encodeURIComponent(orgId)}/cloudflare-tokens/funnel-event`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      },
    );
  } catch {
    // Non-blocking funnel telemetry
  }
}

export async function verifyAndSaveCloudflareToken(
  orgId: string,
  body: {
    token: string;
    accountId?: string;
    accountName?: string;
    projectId?: string;
    replaceTokenRef?: string;
  },
): Promise<
  | {
      ok: true;
      status: number;
      token: CloudflareTokenMetadataSummary;
      tokenRef: string;
      accountId: string;
      accountName: string;
      verification: CloudflareVerificationReportPayload;
      environments: ProjectDeployEnvironmentRecord[];
    }
  | {
      ok: false;
      status: number;
      verification?: CloudflareVerificationReportPayload;
      error: {
        code: string;
        message: string;
        missingPermissionIds?: string[];
        missingPermissionLabels?: string[];
        remediationUrl?: string;
        permissions?: CloudflarePermissionStatusRow[];
      };
    }
> {
  const res = await fetch(
    `/api/orgs/${encodeURIComponent(orgId)}/cloudflare-tokens/verify-and-save`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && data.ok) {
    return {
      ok: true,
      status: res.status,
      token: data.token as CloudflareTokenMetadataSummary,
      tokenRef: String(data.tokenRef),
      accountId: String(data.accountId),
      accountName: String(data.accountName),
      verification: data.verification as CloudflareVerificationReportPayload,
      environments: (data.environments ?? []) as ProjectDeployEnvironmentRecord[],
    };
  }

  const verification = data.verification as
    | CloudflareVerificationReportPayload
    | undefined;
  const errObj = (data.error ?? {}) as {
    code?: string;
    message?: string;
    missingPermissionIds?: string[];
    missingPermissionLabels?: string[];
    remediationUrl?: string;
    permissions?: CloudflarePermissionStatusRow[];
  };

  return {
    ok: false,
    status: res.status,
    verification,
    error: {
      code: errObj.code ?? "VERIFICATION_FAILED",
      message:
        errObj.message ??
        verification?.summaryMessage ??
        "Cloudflare token verification failed",
      missingPermissionIds: errObj.missingPermissionIds,
      missingPermissionLabels: errObj.missingPermissionLabels,
      remediationUrl: errObj.remediationUrl ?? verification?.remediationUrl,
      permissions: errObj.permissions ?? verification?.permissions,
    },
  };
}

export async function recheckCloudflareToken(
  orgId: string,
  tokenRef: string,
  body: {
    simulatedStatus?: "active" | "expired" | "revoked" | "disabled";
    token?: string;
  } = {},
): Promise<{
  ok: boolean;
  token: CloudflareTokenMetadataSummary;
  verification: CloudflareVerificationReportPayload;
}> {
  const res = await fetch(
    `/api/orgs/${encodeURIComponent(orgId)}/cloudflare-tokens/${encodeURIComponent(tokenRef)}/recheck`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to re-verify Cloudflare token (${res.status})`);
  }
  return (await res.json()) as {
    ok: boolean;
    token: CloudflareTokenMetadataSummary;
    verification: CloudflareVerificationReportPayload;
  };
}

export async function disconnectCloudflareToken(
  orgId: string,
  tokenRef: string,
): Promise<{
  ok: boolean;
  tokenRef: string;
  status: "revoked";
  revokedAt: string;
  cloudflareDashboardUrl: string;
  workersKeepRunningMessage?: string;
}> {
  const res = await fetch(
    `/api/orgs/${encodeURIComponent(orgId)}/cloudflare-tokens/${encodeURIComponent(tokenRef)}`,
    {
      method: "DELETE",
      credentials: "include",
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to disconnect Cloudflare token (${res.status})`);
  }
  return (await res.json()) as {
    ok: boolean;
    tokenRef: string;
    status: "revoked";
    revokedAt: string;
    cloudflareDashboardUrl: string;
    workersKeepRunningMessage?: string;
  };
}

export interface DestructiveMigrationWarningPayload {
  migrationName: string;
  statement: string;
  kind: "drop_table" | "drop_column" | "type_narrowing" | "truncate";
  affectedTable: string;
  affectedColumn?: string;
  message: string;
}

export interface DeployPlanSecretCheckPayload {
  name: string;
  ref?: string;
  requiredByBrick: string;
  status: "present" | "missing";
}

export interface DeployPlanBlockerPayload {
  code: string;
  message: string;
  remediation: string;
}

export interface DeployPlanPayload {
  project?: string;
  orgId?: string;
  envName?: "preview" | "production";
  revision?: number;
  deployedRev?: number | null;
  codeHash?: string;
  graphHash?: string;
  reusedCachedBuild?: boolean;
  assembleCount?: number;
  liveWithoutRedeploy?: boolean;
  identity?: string;
  action: "create" | "update" | "hot_apply_graphs" | "noop";
  noChanges?: boolean;
  worker: {
    scriptName: string;
    currentBuildHash: string | null;
    nextBuildHash: string;
    currentCodeHash?: string | null;
    nextCodeHash?: string;
    currentGraphHash?: string | null;
    nextGraphHash?: string;
    changed: boolean;
  };
  d1: {
    databaseName: string;
    createDatabase: boolean;
    pendingMigrations: string[];
    pendingMigrationSql?: Record<string, string>;
    destructiveWarnings: DestructiveMigrationWarningPayload[];
  };
  queues: Array<{
    queueName: string;
    action: "create" | "update" | "unchanged";
  }>;
  cronTriggers: {
    currentCrons: string[];
    nextCrons: string[];
    schedulesCount: number;
    changed: boolean;
  };
  workflows: Array<{
    workflowName: string;
    className: string;
    action: "create" | "update" | "unchanged";
  }>;
  secrets: DeployPlanSecretCheckPayload[];
  blockers: DeployPlanBlockerPayload[];
  preflight?: {
    tokenPermissions: {
      ok: boolean;
      accountId: string;
      accountName: string;
      tokenRef: string;
      scopes: string[];
    };
    readiness: {
      ok: boolean;
      ready: boolean;
      issues: Array<{ code: string; message: string; path?: string }>;
    };
    secrets: {
      ok: boolean;
      items: DeployPlanSecretCheckPayload[];
    };
  };
  environment?: ProjectDeployEnvironmentRecord;
}

export interface DeploymentStepPayload {
  stepOrder: number;
  stepName: string;
  resourceKind: "token" | "d1" | "migration" | "queue" | "worker" | "workflow" | "graph";
  resourceName: string;
  action: "create" | "update" | "hot_apply" | "noop" | "verify";
  status: "succeeded" | "skipped";
  summary: string;
  timestamp: string;
}

export type DeployExecutionResponse =
  | {
      ok: true;
      deployId: string;
      project: string;
      envName: "preview" | "production";
      revision: number;
      buildHash: string;
      codeHash: string;
      graphHash: string;
      action: "create" | "update" | "hot_apply_graphs" | "noop";
      statusMessage: string;
      reusedCachedBuild: boolean;
      assembleCount: number;
      liveWithoutRedeploy: boolean;
      noChanges: boolean;
      mutatingCallCount?: number;
      scriptUploadCount?: number;
      promotedFromEnv?: "preview" | "production";
      steps: DeploymentStepPayload[];
      deployment: {
        scriptName: string;
        versionId: string;
        databaseId: string;
        databaseName: string;
        url: string;
        buildHash: string;
        codeHash?: string;
        graphHash: string;
        deployedAt: string;
        action?: "create" | "update" | "hot_apply_graphs" | "noop";
        liveWithoutRedeploy?: boolean;
        noChanges?: boolean;
        reusedCachedBuild?: boolean;
        statusMessage?: string;
      };
      plan: DeployPlanPayload;
      environment: ProjectDeployEnvironmentRecord;
    }
  | {
      ok: false;
      status: number;
      error: {
        code: string;
        message: string;
        remediation?: string;
        blockers?: DeployPlanBlockerPayload[];
        destructiveWarnings?: DestructiveMigrationWarningPayload[];
        requiredMigrationNames?: string[];
      };
      plan?: DeployPlanPayload;
    };

export async function fetchEnvironmentDeployPlan(
  project: string,
  envName: "preview" | "production",
  body: {
    orgId?: string;
    rev?: number;
    migrations?: Array<{ name?: string; sql: string }>;
  } = {},
): Promise<DeployPlanPayload> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/plan`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
      message?: string;
    } | null;
    throw new Error(
      errBody?.error?.message ??
        errBody?.message ??
        `Failed to compute deploy plan (${res.status})`,
    );
  }
  return (await res.json()) as DeployPlanPayload;
}

export async function executeEnvironmentDeploy(
  project: string,
  envName: "preview" | "production",
  body: {
    orgId?: string;
    confirmDestructive?: boolean;
    confirmedMigrationNames?: string[];
    migrations?: Array<{ name?: string; sql: string }>;
  } = {},
): Promise<DeployExecutionResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/deploy`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && data.ok) {
    return data as unknown as Extract<DeployExecutionResponse, { ok: true }>;
  }

  const errObj = (data.error ?? {}) as {
    code?: string;
    message?: string;
    remediation?: string;
    blockers?: DeployPlanBlockerPayload[];
    destructiveWarnings?: DestructiveMigrationWarningPayload[];
    requiredMigrationNames?: string[];
  };

  return {
    ok: false,
    status: res.status,
    error: {
      code: errObj.code ?? "DEPLOY_FAILED",
      message: errObj.message ?? "Deployment failed",
      remediation: errObj.remediation,
      blockers: errObj.blockers,
      destructiveWarnings: errObj.destructiveWarnings,
      requiredMigrationNames: errObj.requiredMigrationNames,
    },
    plan: data.plan as DeployPlanPayload | undefined,
  };
}

export async function promoteEnvironmentDeployment(
  project: string,
  envName: "preview" | "production" = "production",
  body: {
    orgId?: string;
    confirmDestructive?: boolean;
    confirmedMigrationNames?: string[];
    migrations?: Array<{ name?: string; sql: string }>;
  } = {},
): Promise<DeployExecutionResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/promote`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && data.ok) {
    return data as unknown as Extract<DeployExecutionResponse, { ok: true }>;
  }

  const errObj = (data.error ?? {}) as {
    code?: string;
    message?: string;
    remediation?: string;
    blockers?: DeployPlanBlockerPayload[];
    destructiveWarnings?: DestructiveMigrationWarningPayload[];
    requiredMigrationNames?: string[];
  };

  return {
    ok: false,
    status: res.status,
    error: {
      code: errObj.code ?? "PROMOTE_FAILED",
      message: errObj.message ?? "Promotion failed",
      remediation: errObj.remediation,
      blockers: errObj.blockers,
      destructiveWarnings: errObj.destructiveWarnings,
      requiredMigrationNames: errObj.requiredMigrationNames,
    },
    plan: data.plan as DeployPlanPayload | undefined,
  };
}

export async function checkProjectEnvironmentDrift(
  project: string,
  envName: "preview" | "production",
  body: {
    orgId?: string;
    simulateOutOfBand?: {
      workerHash?: string;
      deleteWorker?: boolean;
      appliedMigrations?: string[];
      deleteQueue?: string;
      cronTriggers?: string[];
    };
  } = {},
): Promise<{
  ok: boolean;
  project: string;
  orgId: string;
  envName: "preview" | "production";
  driftReport: DriftReportPayload;
  environment: ProjectDeployEnvironmentRecord;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/check-drift`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to check environment drift (${res.status})`);
  }
  return (await res.json()) as {
    ok: boolean;
    project: string;
    orgId: string;
    envName: "preview" | "production";
    driftReport: DriftReportPayload;
    environment: ProjectDeployEnvironmentRecord;
  };
}

export async function fetchEnvironmentDeployments(
  project: string,
  envName: "preview" | "production",
  orgId?: string,
): Promise<{
  project: string;
  envName: "preview" | "production";
  deployments: EnvironmentDeploymentRecordPayload[];
}> {
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/deployments${qs}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch environment deployments (${res.status})`);
  }
  return (await res.json()) as {
    project: string;
    envName: "preview" | "production";
    deployments: EnvironmentDeploymentRecordPayload[];
  };
}

export type RollbackExecutionResponse =
  | {
      ok: true;
      dryRun?: boolean;
      deployId?: string;
      rollbackFromDeploymentId: string | null;
      targetDeploymentId: string;
      project: string;
      orgId: string;
      envName: "preview" | "production";
      revision?: number;
      currentRevision?: number;
      targetRevision?: number;
      buildHash?: string;
      codeHash?: string;
      graphHash?: string;
      action?: "rollback";
      statusMessage?: string;
      reusedCachedBuild: boolean;
      assembleCount: number;
      liveWithoutRedeploy?: boolean;
      steps?: DeploymentStepPayload[];
      plan: DeployPlanPayload;
      deployment?: EnvironmentDeploymentRecordPayload;
      environment?: ProjectDeployEnvironmentRecord;
    }
  | {
      ok: false;
      status: number;
      error: {
        code: string;
        message: string;
        destructiveWarnings?: DestructiveMigrationWarningPayload[];
        requiredMigrationNames?: string[];
      };
      plan?: DeployPlanPayload;
    };

export async function rollbackProjectEnvironment(
  project: string,
  envName: "preview" | "production",
  body: {
    targetDeploymentId: string;
    confirmDestructive?: boolean;
    confirmedMigrationNames?: string[];
    dryRun?: boolean;
    orgId?: string;
  },
): Promise<RollbackExecutionResponse> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/rollback`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && data.ok) {
    return data as unknown as Extract<RollbackExecutionResponse, { ok: true }>;
  }

  const errObj = (data.error ?? {}) as {
    code?: string;
    message?: string;
    destructiveWarnings?: DestructiveMigrationWarningPayload[];
    requiredMigrationNames?: string[];
  };

  return {
    ok: false,
    status: res.status,
    error: {
      code: errObj.code ?? "ROLLBACK_FAILED",
      message: errObj.message ?? "Rollback failed",
      destructiveWarnings: errObj.destructiveWarnings,
      requiredMigrationNames: errObj.requiredMigrationNames,
    },
    plan: data.plan as DeployPlanPayload | undefined,
  };
}

// ============================================================================
// CP6 Story 6.1 — Workspace-Scoped Data Browser API Client
// ============================================================================

export interface DataBrowserColumnPayload {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  readOnly: boolean;
}

export interface DataBrowserTablePayload {
  name: string;
  tableName: string;
  label: string;
  category: "entity" | "brick";
  readOnly: boolean;
  isLedger: boolean;
  columns: DataBrowserColumnPayload[];
  rowCount?: number;
}

export interface DataBrowserWorkspacesResponse {
  ok: boolean;
  envName: "preview" | "production";
  workspaces: string[];
}

export interface DataBrowserTablesResponse {
  ok: boolean;
  envName: "preview" | "production";
  readOnly: boolean;
  tables: DataBrowserTablePayload[];
}

export interface DataBrowserRowsResponse {
  ok: boolean;
  envName: "preview" | "production";
  readOnly: boolean;
  workspaceId: string;
  tableName: string;
  sqlTable: string;
  category: "entity" | "brick";
  columns: DataBrowserColumnPayload[];
  rows: Array<Record<string, unknown>>;
  totalCount: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor: string | null;
  sortCol: string;
  sortDir: "asc" | "desc";
  compiledSql: string;
}

export interface DataBrowserWriteResponse {
  ok: boolean;
  operation?: "insert" | "update" | "delete";
  envName?: "preview" | "production";
  workspaceId?: string;
  tableName?: string;
  rowId?: string;
  row?: Record<string, unknown> | null;
  beforeSnapshot?: Record<string, unknown> | null;
  afterSnapshot?: Record<string, unknown> | null;
  auditId?: string;
  auditedAt?: string;
  status?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface DataBrowserAuditEntryPayload {
  auditId: string;
  orgId: string;
  projectId: string;
  envName: "preview" | "production";
  workspaceId: string;
  tableName: string;
  rowId: string;
  operation: "insert" | "update" | "delete";
  actor: string;
  beforeSnapshot: Record<string, unknown> | null;
  afterSnapshot: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Story 17: the environment has no data store Studio can reach (no active preview sandbox, or production). The API
 * answers 503 NOT_CONFIGURED; the data browser and ledger views show a dedicated state for it.
 */
export class DataStoreNotConfiguredError extends Error {
  readonly code = "NOT_CONFIGURED" as const;
  constructor(message: string) {
    super(message);
    this.name = "DataStoreNotConfiguredError";
  }
}

export function isDataStoreNotConfiguredError(err: unknown): err is DataStoreNotConfiguredError {
  return err instanceof DataStoreNotConfiguredError;
}

async function throwDataBrowserReadError(res: Response, fallback: string): Promise<never> {
  const errBody = (await res.json().catch(() => null)) as {
    error?: { message?: string; code?: string };
  } | null;
  const message = errBody?.error?.message ?? `${fallback} (${res.status})`;
  if (errBody?.error?.code === "NOT_CONFIGURED") {
    throw new DataStoreNotConfiguredError(message);
  }
  throw new Error(message);
}

export async function fetchDataBrowserWorkspaces(
  project: string,
  envName: "preview" | "production",
  orgId?: string,
): Promise<DataBrowserWorkspacesResponse> {
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/data/workspaces${qs}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    await throwDataBrowserReadError(res, "Failed to load workspaces");
  }
  return (await res.json()) as DataBrowserWorkspacesResponse;
}

export async function fetchDataBrowserTables(
  project: string,
  envName: "preview" | "production",
  params: { workspaceId?: string; orgId?: string } = {},
): Promise<DataBrowserTablesResponse> {
  const search = new URLSearchParams();
  if (params.workspaceId) search.set("workspaceId", params.workspaceId);
  if (params.orgId) search.set("orgId", params.orgId);
  const qs = search.toString();
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/data/tables${qs ? `?${qs}` : ""}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    await throwDataBrowserReadError(res, "Failed to load tables");
  }
  return (await res.json()) as DataBrowserTablesResponse;
}

export async function fetchDataBrowserRows(
  project: string,
  envName: "preview" | "production",
  tableName: string,
  params: {
    workspaceId: string;
    orgId?: string;
    filterCol?: string;
    filterOp?: "eq" | "contains" | "gt" | "lt";
    filterVal?: string;
    sortCol?: string;
    sortDir?: "asc" | "desc";
    limit?: number;
    offset?: number;
  },
): Promise<DataBrowserRowsResponse> {
  const search = new URLSearchParams();
  search.set("workspaceId", params.workspaceId);
  if (params.orgId) search.set("orgId", params.orgId);
  if (params.filterCol && params.filterVal !== undefined && params.filterVal !== "") {
    search.set("filterCol", params.filterCol);
    search.set("filterOp", params.filterOp ?? "eq");
    search.set("filterVal", params.filterVal);
  }
  if (params.sortCol) search.set("sortCol", params.sortCol);
  if (params.sortDir) search.set("sortDir", params.sortDir);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.offset !== undefined) search.set("offset", String(params.offset));

  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/data/tables/${encodeURIComponent(tableName)}/rows?${search.toString()}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    await throwDataBrowserReadError(res, "Failed to load rows");
  }
  return (await res.json()) as DataBrowserRowsResponse;
}

export async function mutateDataBrowserRow(
  project: string,
  envName: "preview" | "production",
  tableName: string,
  input: {
    method: "POST" | "PATCH" | "DELETE";
    workspaceId: string;
    confirmWrite: boolean;
    rowId?: string;
    row?: Record<string, unknown>;
    patch?: Record<string, unknown>;
    orgId?: string;
  },
): Promise<DataBrowserWriteResponse> {
  const rowSuffix =
    input.rowId && (input.method === "PATCH" || input.method === "DELETE")
      ? `/${encodeURIComponent(input.rowId)}`
      : "";
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/data/tables/${encodeURIComponent(tableName)}/rows${rowSuffix}`,
    {
      method: input.method,
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        confirmWrite: input.confirmWrite,
        ...(input.rowId ? { rowId: input.rowId } : {}),
        ...(input.row ? { row: input.row } : {}),
        ...(input.patch ? { patch: input.patch } : {}),
        ...(input.orgId ? { orgId: input.orgId } : {}),
      }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && data.ok) {
    return {
      ...(data as unknown as DataBrowserWriteResponse),
      ok: true,
      status: res.status,
    };
  }
  const errObj = (data.error ?? {}) as { code?: string; message?: string };
  return {
    ok: false,
    status: res.status,
    error: {
      code: errObj.code ?? "DATA_BROWSER_WRITE_FAILED",
      message: errObj.message ?? `Write failed (${res.status})`,
    },
  };
}

export async function fetchDataBrowserAuditLog(
  project: string,
  envName: "preview" | "production",
  params: { workspaceId?: string; tableName?: string; orgId?: string } = {},
): Promise<{
  ok: boolean;
  entries: DataBrowserAuditEntryPayload[];
}> {
  const search = new URLSearchParams();
  if (params.workspaceId) search.set("workspaceId", params.workspaceId);
  if (params.tableName) search.set("tableName", params.tableName);
  if (params.orgId) search.set("orgId", params.orgId);
  const qs = search.toString();
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/data/audit-log${qs ? `?${qs}` : ""}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error(`Failed to load data browser audit log (${res.status})`);
  }
  return (await res.json()) as {
    ok: boolean;
    entries: DataBrowserAuditEntryPayload[];
  };
}

export interface WorkspaceUsageSummaryItemPayload {
  metricKey: string;
  periodStart: string;
  periodEnd: string;
  totalQuantity: number;
}

export interface WorkspaceLedgerEntryPayload {
  entryId: string;
  workspaceId: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  idempotencyKey: string | null;
  runId?: string | null;
  nodeId?: string | null;
  createdAt: string;
}

export interface WorkspaceLedgerResponse {
  ok: boolean;
  envName: "preview" | "production";
  readOnly: boolean;
  immutable: boolean;
  workspaceId: string;
  wallet: {
    balance: number;
    currencyOrUnit: string;
    updatedAt: string;
    netChange30d: number;
  };
  usageSummary: WorkspaceUsageSummaryItemPayload[];
  journalEntries: WorkspaceLedgerEntryPayload[];
  totalCount: number;
  nextCursor: string | null;
}

export async function fetchWorkspaceLedger(
  project: string,
  envName: "preview" | "production",
  params: {
    workspaceId: string;
    cursor?: string;
    limit?: number;
    orgId?: string;
  },
): Promise<WorkspaceLedgerResponse> {
  const search = new URLSearchParams();
  search.set("workspaceId", params.workspaceId);
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  if (params.orgId) search.set("orgId", params.orgId);
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/ledger?${search.toString()}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    await throwDataBrowserReadError(res, "Failed to load workspace ledger");
  }
  return (await res.json()) as WorkspaceLedgerResponse;
}

// ============================================================================
// CP6 Story 6.3 — Structured Logs & Errors Panel API Client
// ============================================================================

export type StructuredLogLevelPayload = "debug" | "info" | "warn" | "error";

export interface StructuredLogEntryPayload {
  seq?: number;
  logId: string;
  ts: string;
  level: StructuredLogLevelPayload;
  message: string;
  runId?: string | null;
  workflowId?: string | null;
  revision?: number | null;
  nodeId?: string | null;
  brickId?: string | null;
  workspaceId?: string | null;
  requestId?: string | null;
  fields: Record<string, unknown>;
  fieldsJson: string;
  errorStack?: string | null;
  envName?: string;
}

export interface EnvironmentLogsResponse {
  ok: boolean;
  project?: string;
  envName?: "preview" | "production";
  env?: string;
  after: number;
  limit: number;
  nextCursor: number;
  hasMore: boolean;
  logs: StructuredLogEntryPayload[];
}

export async function fetchEnvironmentLogs(
  project: string,
  envName: "preview" | "production",
  params: {
    level?: string;
    workspaceId?: string;
    brickId?: string;
    workflowId?: string;
    runId?: string;
    nodeId?: string;
    q?: string;
    after?: number;
    limit?: number;
    orgId?: string;
  } = {},
): Promise<EnvironmentLogsResponse> {
  const search = new URLSearchParams();
  if (params.level && params.level !== "all") search.set("level", params.level);
  if (params.workspaceId && params.workspaceId !== "all") {
    search.set("workspaceId", params.workspaceId);
  }
  if (params.brickId && params.brickId !== "all") {
    search.set("brickId", params.brickId);
  }
  if (params.workflowId && params.workflowId !== "all") {
    search.set("workflowId", params.workflowId);
  }
  if (params.runId && params.runId !== "all") {
    search.set("runId", params.runId);
  }
  if (params.nodeId && params.nodeId !== "all") {
    search.set("nodeId", params.nodeId);
  }
  if (params.q && params.q.trim()) {
    search.set("q", params.q.trim());
  }
  if (params.after !== undefined) {
    search.set("after", String(params.after));
  }
  if (params.limit !== undefined) {
    search.set("limit", String(params.limit));
  }
  if (params.orgId) {
    search.set("orgId", params.orgId);
  }
  const qs = search.toString();
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/logs${qs ? `?${qs}` : ""}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    throw new Error(
      errBody?.error?.message ?? `Failed to load structured logs (${res.status})`,
    );
  }
  return (await res.json()) as EnvironmentLogsResponse;
}

export async function ingestEnvironmentLogs(
  project: string,
  envName: "preview" | "production",
  body: {
    orgId?: string;
    entries: Array<Partial<StructuredLogEntryPayload> & { level: StructuredLogLevelPayload; message: string }>;
    secretValues?: string[];
  },
): Promise<{
  ok: boolean;
  ingestedCount: number;
  logs: StructuredLogEntryPayload[];
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/logs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to ingest structured logs (${res.status})`);
  }
  return (await res.json()) as {
    ok: boolean;
    ingestedCount: number;
    logs: StructuredLogEntryPayload[];
  };
}

// ============================================================================
// CP6 Story 6.4 — Backend Health & Metrics Panel API Client
// ============================================================================

export type HealthWindowPayload = "1h" | "24h" | "7d";

export interface BrickHealthMetricPayload {
  brickId: string;
  routePrefix: string;
  requestCount: number;
  error4xxCount: number;
  error5xxCount: number;
  errorRatePercent: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface QueueHealthMetricPayload {
  queueName: string;
  depth: number;
  dlqCount: number;
  updatedAt: string;
}

export interface TopFailingWorkflowMetricPayload {
  workflowId: string;
  failedCount: number;
  lastFailedRunId: string | null;
}

export interface HealthTimeSeriesBucketPayload {
  bucketTs: string;
  requestCount: number;
  error5xxCount: number;
  p95Ms: number;
  failedRuns: number;
}

export interface EnvironmentHealthSummaryPayload {
  ok: boolean;
  project?: string;
  envName?: "preview" | "production";
  env: string;
  window: HealthWindowPayload;
  generatedAt: string;
  requestCount: number;
  requestsPerMinute: number;
  error4xxCount: number;
  error5xxCount: number;
  errorRatePercent: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  d1: {
    queryCount: number;
    p50Ms: number;
    p95Ms: number;
    errorCount: number;
  };
  workflows: {
    totalRuns: number;
    succeededRuns: number;
    failedRuns: number;
    successRatePercent: number;
    topFailingWorkflows: TopFailingWorkflowMetricPayload[];
  };
  queues: QueueHealthMetricPayload[];
  perBrick: BrickHealthMetricPayload[];
  series: HealthTimeSeriesBucketPayload[];
  analyticsReconciliation?: {
    source: "d1-sovereign" | "cloudflare-graphql+d1";
    cloudflareRequests?: number;
    cloudflareErrors?: number;
    cloudflareP95Ms?: number;
    deltaPercent?: number;
  };
}

export async function fetchEnvironmentHealth(
  project: string,
  envName: "preview" | "production",
  params: {
    window?: HealthWindowPayload;
    now?: string;
    orgId?: string;
  } = {},
): Promise<EnvironmentHealthSummaryPayload> {
  const search = new URLSearchParams();
  search.set("window", params.window ?? "1h");
  if (params.now) search.set("now", params.now);
  if (params.orgId) search.set("orgId", params.orgId);

  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/health?${search.toString()}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    throw new Error(
      errBody?.error?.message ??
        `Failed to load backend health metrics (${res.status})`,
    );
  }
  return (await res.json()) as EnvironmentHealthSummaryPayload;
}

export async function seedEnvironmentHealth(
  project: string,
  envName: "preview" | "production",
  body: Record<string, unknown>,
): Promise<EnvironmentHealthSummaryPayload> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(envName)}/health/seed`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to seed backend health metrics (${res.status})`);
  }
  return (await res.json()) as EnvironmentHealthSummaryPayload;
}

// ============================================================================
// CP7 Story 7.2 — Draft-Branch Proposal Mode & Unified Activity Feed API Client
// ============================================================================

export interface ActivityFeedEventPayload {
  id: string;
  type: "revision" | "proposal" | "build" | "deploy" | "connection" | "run";
  action: string;
  project: string;
  revision?: number | null;
  proposalId?: string;
  proposalStatus?: ProposalStatus;
  runId?: string;
  workflowId?: string;
  timestamp: string;
  actor: {
    type: "human" | "agent";
    id: string;
    displayId: string;
    client?: string;
    onBehalfOf?: string;
  };
  summary: string;
  details: Record<string, unknown>;
}

export interface ProjectActivityFeedResponse {
  project: string;
  events: ActivityFeedEventPayload[];
  total: number;
  filters: {
    author: string;
    type: string;
    window: string;
  };
}

export async function fetchProjectProposals(
  project: string,
  status?: ProposalStatus,
): Promise<ProposalRecord[]> {
  try {
    const search = new URLSearchParams();
    if (status) search.set("status", status);
    const qs = search.toString();
    const res = await fetch(
      `/api/projects/${encodeURIComponent(project)}/proposals${qs ? `?${qs}` : ""}`,
      { credentials: "include" },
    );
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { proposals?: ProposalRecord[] };
    return data.proposals ?? [];
  } catch {
    return [];
  }
}

export async function createProjectProposal(
  project: string,
  body: {
    baseRevision?: number;
    summary?: string;
    ops: unknown[];
    author?: { type: "human" | "agent"; id: string; client?: string };
  },
): Promise<{
  ok: true;
  proposalId: string;
  proposal: ProposalRecord;
  revision: number;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/proposals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data) {
    const errObj = data?.error as { message?: string; issues?: Array<{ message: string }> } | undefined;
    const msg =
      errObj?.issues?.map((i) => i.message).join("; ") ??
      errObj?.message ??
      `Failed to create proposal (${res.status})`;
    throw new Error(msg);
  }
  return {
    ok: true,
    proposalId: String(data.proposalId ?? ""),
    proposal: data.proposal as ProposalRecord,
    revision: Number(data.revision ?? 0),
  };
}

export async function acceptProjectProposal(
  project: string,
  proposalId: string,
  opIds?: string[],
): Promise<
  | {
      ok: true;
      status: 200;
      revision: number;
      state: BlueprintState;
      semanticHash: string;
      readiness: ReadinessResult;
      proposal: ProposalRecord;
    }
  | {
      ok: false;
      status: number;
      message: string;
      issues?: Array<{ code: string; path: string; message: string; suggestedFix?: string }>;
    }
> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/proposals/${encodeURIComponent(proposalId)}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(opIds !== undefined ? { opIds } : {}),
    },
  );
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data) {
    const errObj = data?.error as
      | {
          message?: string;
          issues?: Array<{ code: string; path: string; message: string; suggestedFix?: string }>;
        }
      | undefined;
    const message =
      errObj?.issues?.map((i) => i.message).join("; ") ??
      errObj?.message ??
      `Failed to accept proposal (${res.status})`;
    return {
      ok: false,
      status: res.status,
      message,
      ...(errObj?.issues ? { issues: errObj.issues } : {}),
    };
  }
  return {
    ok: true,
    status: 200,
    revision: Number(data.revision ?? 0),
    state: data.state as BlueprintState,
    semanticHash: String(data.semanticHash ?? ""),
    readiness: data.readiness as ReadinessResult,
    proposal: data.proposal as ProposalRecord,
  };
}

export async function rejectProjectProposal(
  project: string,
  proposalId: string,
  reason?: string,
): Promise<{
  ok: true;
  proposal: ProposalRecord;
  revision: number;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/proposals/${encodeURIComponent(proposalId)}/reject`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data) {
    const errObj = data?.error as { message?: string } | undefined;
    throw new Error(errObj?.message ?? `Failed to reject proposal (${res.status})`);
  }
  return {
    ok: true,
    proposal: data.proposal as ProposalRecord,
    revision: Number(data.revision ?? 0),
  };
}

export async function fetchProjectActivity(
  project: string,
  filters: {
    author?: string;
    type?: string;
    window?: string;
    limit?: number;
  } = {},
): Promise<ProjectActivityFeedResponse> {
  try {
    const search = new URLSearchParams();
    if (filters.author) search.set("author", filters.author);
    if (filters.type) search.set("type", filters.type);
    if (filters.window) search.set("window", filters.window);
    if (filters.limit !== undefined) search.set("limit", String(filters.limit));
    const qs = search.toString();
    const res = await fetch(
      `/api/projects/${encodeURIComponent(project)}/activity${qs ? `?${qs}` : ""}`,
      { credentials: "include" },
    );
    if (!res.ok) {
      return {
        project,
        events: [],
        total: 0,
        filters: {
          author: filters.author ?? "all",
          type: filters.type ?? "all",
          window: filters.window ?? "all",
        },
      };
    }
    return (await res.json()) as ProjectActivityFeedResponse;
  } catch {
    return {
      project,
      events: [],
      total: 0,
      filters: {
        author: filters.author ?? "all",
        type: filters.type ?? "all",
        window: filters.window ?? "all",
      },
    };
  }
}

export function getProjectOpenApiUrl(project: string, rev?: number): string {
  const base = `/api/projects/${encodeURIComponent(project)}/openapi.json`;
  return rev !== undefined && rev > 0 ? `${base}?rev=${encodeURIComponent(String(rev))}` : base;
}

export async function downloadProjectOpenApiSpec(
  project: string,
  rev?: number,
): Promise<{ ok: boolean; spec: Record<string, unknown> | null; url: string; filename: string }> {
  const url = getProjectOpenApiUrl(project, rev);
  const filename = `${project}-openapi.json`;
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) {
      return { ok: false, spec: null, url, filename };
    }
    const spec = (await res.json()) as Record<string, unknown>;
    if (
      typeof window !== "undefined" &&
      typeof document !== "undefined" &&
      typeof URL !== "undefined" &&
      typeof URL.createObjectURL === "function"
    ) {
      try {
        const blob = new Blob([JSON.stringify(spec, null, 2) + "\n"], {
          type: "application/json; charset=utf-8",
        });
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
      } catch {
        // Ignore DOM download errors in headless test environments
      }
    }
    return { ok: true, spec, url, filename };
  } catch {
    return { ok: false, spec: null, url, filename };
  }
}

// ============================================================================
// CP8 Story 8.2 — Immutable Audit Log & Retention / Privacy Settings API Client
// ============================================================================

export interface StudioAuditLogEntry {
  id: string;
  ts: string;
  createdAt: string;
  orgId: string;
  projectId: string | null;
  actor: string;
  actorType: string;
  actorId: string;
  action: string;
  targetRef: string | null;
  metadata: Record<string, unknown>;
  ipHash: string;
}

export interface StudioAuditLogsResponse {
  project?: string;
  orgId: string;
  auditLogs: StudioAuditLogEntry[];
  entries: StudioAuditLogEntry[];
}

export async function fetchProjectAuditLogs(
  project: string,
  params: { action?: string; actor?: string; limit?: number } = {},
): Promise<StudioAuditLogEntry[]> {
  try {
    const search = new URLSearchParams();
    if (params.action) search.set("action", params.action);
    if (params.actor) search.set("actor", params.actor);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    const qs = search.toString();
    const res = await fetch(
      `/api/projects/${encodeURIComponent(project)}/audit-logs${qs ? `?${qs}` : ""}`,
      { credentials: "include" },
    );
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as Partial<StudioAuditLogsResponse>;
    return data.auditLogs ?? data.entries ?? [];
  } catch {
    return [];
  }
}

export interface ProjectRetentionSettingsPayload {
  projectId: string;
  orgId: string;
  runRetentionDays: number;
  telemetryRetentionDays: number;
  captureStepIoInProd: boolean;
  additionalRedactKeys: string[];
  updatedAt: string;
  updatedBy: string | null;
}

export async function fetchProjectRetentionSettings(
  project: string,
): Promise<ProjectRetentionSettingsPayload> {
  const fallback: ProjectRetentionSettingsPayload = {
    projectId: project,
    orgId: "org_default",
    runRetentionDays: 14,
    telemetryRetentionDays: 7,
    captureStepIoInProd: true,
    additionalRedactKeys: [],
    updatedAt: new Date(0).toISOString(),
    updatedBy: null,
  };
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(project)}/settings/retention`,
      { credentials: "include" },
    );
    if (!res.ok) {
      return fallback;
    }
    const data = (await res.json()) as {
      settings?: ProjectRetentionSettingsPayload;
      runRetentionDays?: number;
      telemetryRetentionDays?: number;
      captureStepIoInProd?: boolean;
      additionalRedactKeys?: string[];
    };
    if (data.settings) {
      return data.settings;
    }
    return {
      ...fallback,
      ...(typeof data.runRetentionDays === "number"
        ? { runRetentionDays: data.runRetentionDays }
        : {}),
      ...(typeof data.telemetryRetentionDays === "number"
        ? { telemetryRetentionDays: data.telemetryRetentionDays }
        : {}),
      ...(typeof data.captureStepIoInProd === "boolean"
        ? { captureStepIoInProd: data.captureStepIoInProd }
        : {}),
      ...(Array.isArray(data.additionalRedactKeys)
        ? { additionalRedactKeys: data.additionalRedactKeys }
        : {}),
    };
  } catch {
    return fallback;
  }
}

export async function updateProjectRetentionSettings(
  project: string,
  body: {
    runRetentionDays?: number;
    telemetryRetentionDays?: number;
    captureStepIoInProd?: boolean;
    additionalRedactKeys?: string[];
  },
): Promise<ProjectRetentionSettingsPayload> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(project)}/settings/retention`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json().catch(() => null)) as {
    settings?: ProjectRetentionSettingsPayload;
    error?: { message?: string };
  } | null;
  if (!res.ok || !data?.settings) {
    throw new Error(
      data?.error?.message ??
        `Failed to update retention settings (${res.status})`,
    );
  }
  return data.settings;
}









