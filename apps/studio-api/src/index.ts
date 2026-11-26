import { Hono } from "hono";
import { STUDIO_PREVIEW_WORKSPACE } from "./preview-workspace.ts";
import { entityAddColumnStatements } from "./entity-evolution.ts";
import { readProjectLogs, signedDataBrowserRequest } from "./telemetry-reads.ts";
import { z } from "zod";
import {
  allowedOriginsFromEnv,
  applyMigration,
  checkWebSocketOrigin,
  createHttpGuard,
  entityDdl,
  isProductionEnvironment,
  parseEntities,
  tableName as entityTableName,
} from "@poc/sdk";
import type { D1Like, Entity as SdkEntity, Executors } from "@poc/sdk";
import {
  DEFAULT_CATALOG_VERSION,
  assemble,
  computeArtifactHashes,
  computeBuildHash,
  computeCodeHash,
  computeGraphHash,
  generateOpenApiSpec,
  hashFiles,
  secretDeclarations,
  sha256Hex,
} from "@poc/assembler";
import type { ArtifactHashes, CompositeBuildHashInput } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import {
  EntityDefinitionSchema,
  PROJECT_SLUG_PATTERN,
  canonicalCodePayload,
  canonicalGraphPayload,
  computeBlueprintBuildHash,
  computeBlueprintCodeHash,
  computeBlueprintGraphHash,
  computeSemanticDiff,
  createEmptyBlueprint,
  evaluateProposalSelection,
  isValidSecretRefHandle,
  parseBlueprintBundle,
  summarizeProposalOps,
  toAssemblerBlueprint,
  toSdkEntity,
} from "@poc/blueprint";
import type {
  ProposalActor,
  ProposalRecord,
  ProposalSelectionEvaluation,
  ProposalStatus,
} from "@poc/blueprint";
import {
  ALL_TOOLS,
  PROTOCOL_VERSION,
  SERVER_INFO,
  TOOLS,
  ProjectOutOfScopeError,
  checkArguments,
  classifyApplyRisk,
  createDurableObjectBlueprintClient,
  pinBlueprintClient,
  proposalRequiredError,
  revertToRevisionTool,
  summarizeSemanticDiff,
  toolDescriptions,
} from "@poc/mcp-server";
import {
  computePlanFingerprint,
  decideApprovalRequest,
  listApprovalRequests,
  releaseApproval,
  requireApproval,
  summarizePlanMigrations,
  sessionReviewerRefusal,
} from "./approvals.ts";
import type { ApprovalBinding, ApprovalStatus } from "./approvals.ts";
import type { BlueprintAuthor, BlueprintClient, StudioRequestFn } from "@poc/mcp-server";
import {
  authorizeProjectAccess,
  chooseSessionCreateOrg,
  refuseMcpTokenOnOrgRoute,
  refuseNonPlatformOperator,
  canManageOrg,
  canMutateProject,
  canReadProject,
  createStudioAuthAndOrgRoutes,
  createStudioBetterAuth,
  ensureDefaultTestAuth,
  normalizeOrgRole,
  normalizeStudioAuthHeaders,
  parseTokenScopes,
  queryStudioAuditLogs,
  recordStudioAuditLog,
  resolveStudioAuthSession,
  resolveStudioCaller,
} from "./auth.ts";
import type {
  StudioAuditLogInput,
  StudioAuditLogRecord,
  StudioAuthSession,
  StudioAuthUser,
  StudioCaller,
  StudioMcpScope,
  StudioOrgRole,
  StudioOrgRoleInput,
} from "./auth.ts";
import {
  BlueprintDO,
  STUDIO_API_MIGRATION_SQL,
  ensureStudioD1Schema,
  generateBatchSummary,
} from "./blueprint-do.ts";
import type {
  AcceptProposalInput,
  ApplyBatchOutcome,
  ApplyOpsInput,
  AuthorAttribution,
  ConflictDetail,
  ConflictErrorPayload,
  ImportBundleInput,
  InterveningOpRecord,
  PinnedNodeOutput,
  ProjectStatePayload,
  RejectProposalInput,
  RevertInput,
  RevisionHistoryPayload,
  RevisionSummary,
  SemanticDiffPayload,
  SnapshotRecord,
  StudioApiEnv,
} from "./blueprint-do.ts";

import {
  computeSecretKeyHint,
  decryptSecretValue,
  deriveAesGcmVaultKey,
  encryptSecretValue,
} from "./secrets-vault.ts";
import type { SealedSecretRecord } from "./secrets-vault.ts";
import { realUploadCompatibilityFlags, storeGeneratedSecrets } from "./generated-secrets.ts";
import {
  CLOUDFLARE_API_TOKENS_DASHBOARD_URL,
  DeployTokenVaultError,
  STUDIO_ONBOARDING_STEPS,
  computeOnboardingFunnelAnalytics,
  computeTokenLast4,
  createStudioTokenResolver,
  createTokenVault,
  decryptToken,
  generateTokenRef,
  generateUuidV7,
  getDeployTokenMetadata,
  listDeployTokenAuditLog,
  listOnboardingFunnelEvents,
  listOrgDeployTokens,
  listProjectDeployEnvironments,
  listStudioOnboardingEvents,
  markDeployTokenVerificationStatus,
  recordOnboardingFunnelEvent,
  recordStudioOnboardingEvent,
  revokeDeployToken,
  rotateDeployTokenKek,
  sealDeployToken,
  upsertProjectDeployEnvironments,
} from "./security/token-vault.ts";
import type {
  DeployTokenAuditEntry,
  DeployTokenMetadata,
  DeployTokenStatus,
  DeployTokenVaultErrorCode,
  OnboardingFunnelAnalyticsReport,
  OnboardingFunnelEvent,
  OnboardingFunnelStep,
  ProjectEnvironmentTargetRecord,
  RevokeDeployTokenOptions,
  RevokeDeployTokenResult,
  RotateKekResult,
  SealDeployTokenInput,
  StudioOnboardingEvent,
  StudioOnboardingStep,
  StudioTokenVault,
  TokenKekConfig,
  TokenResolutionContext,
  TokenResolver,
} from "./security/token-vault.ts";
import {
  STARTER_TEMPLATES,
  getStarterTemplate,
  instantiateStarterTemplateForProject,
  listStarterTemplates,
} from "./templates.ts";
import type { StarterTemplateDescriptor, StarterTemplateId } from "./templates.ts";
import {
  BETA_PARTNER_TYPES,
  BetaPartnerTypeSchema,
  CohortPartnerSeedInputSchema,
  CohortPartnerSessionTelemetrySchema,
  CohortProvisionRequestSchema,
  DEFAULT_COHORT_1_PARTNERS,
  computeCohortBetaMetrics,
  provisionBetaCohortPartners,
  validateCohort1Composition,
} from "./beta-readiness.ts";
import type {
  BetaPartnerType,
  BetaReadinessReport,
  CohortCompositionValidationResult,
  CohortPartnerSeedInput,
  CohortPartnerSessionTelemetry,
  CohortProvisionRequest,
  ProvisionedCohortPartnerRecord,
} from "./beta-readiness.ts";
import {
  ByocCloudflareTarget,
  DeployEnvNameSchema,
  HostedSandboxTarget,
  PlatformSandboxDeployTargetSchema,
  SANDBOX_D1_MAX_BYTES,
  SANDBOX_D1_MAX_ROWS,
  SANDBOX_DAILY_REQUEST_LIMIT,
  SANDBOX_OUTBOUND_RPM_LIMIT,
  SANDBOX_TTL_DAYS,
  SANDBOX_TTL_MS,
  SandboxDispatchPlatform,
  SandboxGuardrailError,
  analyzeSqlMigrations,
  assertNoLivePaymentCredential,
  buildCloudflareTokenTemplateUrl,
  checkEnvironmentDrift,
  computeDeployPlan,
  computeRollbackPlan,
  createByocProvisioner,
  createHostedSandboxProvisioner,
  createSandboxDispatcher,
  createSandboxOutboundFetch,
  deriveEnvironmentResourceNames,
  inspectOutboundPaymentAndSsrf,
  isLivePaymentCredential,
  inactiveTokenReport,
  verifyCloudflareToken,
  wrapSandboxD1WithStorageCap,
} from "../../../packages/deploy/src/target.ts";
import type { CloudflareApiClient } from "../../../packages/deploy/src/target.ts";
import { WORKFLOW_BINDING, WORKFLOW_CLASS } from "../../../packages/deploy/src/worker/graph-run.ts";
import { KEY_HEADER } from "../../../packages/deploy/src/worker/gate.ts";
import { NO_WORKERS_DEV_SUBDOMAIN_MESSAGE, isHttpWriteCall } from "../../../packages/deploy/src/http-control-plane.ts";
import type { HttpCloudflareApiClient } from "../../../packages/deploy/src/http-control-plane.ts";
import {
  CloudflareApiError,
  CloudflareMalformedError,
  CloudflareNetworkError,
  RequestGuardError,
} from "../../../packages/deploy/src/provisioner/cloudflare.ts";
import { createRedactor } from "../../../packages/deploy/src/provisioner/redact.ts";
import {
  asFakeControlPlane,
  deriveWorkerAccessKey,
  getStudioControlPlane,
  getStudioFakeControlPlane,
  getStudioVerificationClient,
  resetStudioFakeControlPlanes,
  studioDeployClientMode,
  StudioDeployClientConfigError,
} from "./deploy-client.ts";
import type { StudioDeployClientEnv, StudioDeployOptions } from "./deploy-client.ts";
export {
  deriveWorkerAccessKey,
  getStudioControlPlane,
  getStudioFakeControlPlane,
  getStudioVerificationClient,
  studioDeployClientMode,
  StudioDeployClientConfigError,
};
export type { StudioDeployClientEnv, StudioDeployOptions };
import {
  handleDataBrowserRequest,
  isImmutableLedgerTable,
  workspaceHasBrowsableData,
} from "../../../packages/deploy/src/worker/data-browser.ts";
import type {
  BlueprintDriftReport,
  CloudflareTokenTemplateMetadata,
  CloudflareTokenVerificationReport,
  CurrentBlueprintHashes,
  DeployEnvName,
  DeployPlan,
  DeployPlanAction,
  DeployPlanBlocker,
  DeployPlanEnvironmentState,
  DeployPlanSecretCheck,
  DeployPlanSecretRequirement,
  DeployTarget,
  DestructiveMigrationWarning,
  DriftReport,
  ExpectedDeploymentState,
  HostedSandboxProvisioner,
  OutOfBandDriftItem,
  PlatformSandboxDeployTarget,
  ProvisionerApplyResult,
  ProvisionerMigrationItem,
  ProvisionerPlanResult,
  RollbackPlanSnapshot,
} from "../../../packages/deploy/src/target.ts";
import {
  HealthWindowSchema,
  LogLevelSchema,
  TELEMETRY_SIGNATURE_HEADER,
  TelemetryWebhookPayloadSchema,
  TelemetryWriteRefusedError,
  deriveProjectSecret,
  ensureTelemetryTables,
  findTelemetryIdCollision,
  findResolvingRetryRunId,
  getRunRecord,
  handleTelemetryLogsPullRequest,
  handleTelemetryMetricsRequest,
  insertStepEvent,
  insertStructuredLog,
  listRunRecords,
  listStepEventsAfterCursor,
  listStepEventsForRun,
  pruneExpiredTelemetryRuns,
  queryEnvironmentMetrics,
  queryRunHistory,
  queryStructuredLogs,
  reconcileCloudflareAnalyticsWithD1Metrics,
  recordHttpRequestSamples,
  redactStructuredLogEntry,
  redactTelemetryPayload,
  signControlPlaneRequest,
  upsertHttpRollup,
  upsertQueueMetrics,
  upsertRunRecord,
  verifyTelemetryWebhook,
} from "@poc/telemetry";
import type {
  CloudflareAnalyticsSnapshot,
  ProjectSecretPurpose,
  EnvironmentHealthSummary,
  HealthWindow,
  HttpRequestSampleInput,
  HttpRollupInput,
  LogLevel,
  PruneTelemetryResult,
  TelemetryScope,
  QueueMetricInput,
  RawStructuredLogInput,
  RunHistorySummary,
  RunRecord,
  StepEvent,
  StructuredLogEntry,
} from "@poc/telemetry";
import {
  assertNoPlaceholderExecutors,
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  computeConnectionKeyHint,
  ensureConnectionsTable,
  handleStepRehearsalRequest,
  handleWorkflowRerunRequest,
  handleWorkflowRunRequest,
  isTenantWorkspaceId,
  normalizeNodePortOutput,
  unsealConnectionCredentials,
  upsertSealedConnection,
} from "@poc/runtime";
import type { StepRehearsalResult, WorkflowRunResponse } from "@poc/runtime";

/** The HMAC key shared with deployed workers' /__px routes. No source fallback: a missing key fails the request. */
export function requireTelemetrySecret(env: { PX_TELEMETRY_SECRET?: string }): string {
  const secret = env.PX_TELEMETRY_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error("Missing required secret PX_TELEMETRY_SECRET");
  }
  return secret;
}

/**
 * The scope of every telemetry read in Studio (story 1.4): the project the caller is authorised for, and, when the caller
 * names one, a workspace inside it. STUDIO_DB holds every project's telemetry; nothing outside the project is returned.
 */
export function studioTelemetryScope(project: string, workspaceId?: string | null): TelemetryScope {
  const ws = typeof workspaceId === "string" ? workspaceId.trim() : "";
  return { projectId: project, ...(ws && ws !== "all" ? { workspaceId: ws } : {}) };
}

/**
 * Project `project`'s derived secret for `purpose` (story 1.17), from Studio's root PX_TELEMETRY_SECRET; null when Studio
 * has no root secret (never BETTER_AUTH_SECRET or another fallback). Studio signs and verifies everything for a project
 * with that project's derived secret only: the root secret itself never goes on the wire or into a worker's env.
 */
async function studioProjectSecret(
  env: { PX_TELEMETRY_SECRET?: string },
  project: string,
  purpose: ProjectSecretPurpose,
): Promise<string | null> {
  const root = env.PX_TELEMETRY_SECRET;
  if (typeof root !== "string" || root.trim().length === 0) return null;
  return deriveProjectSecret(root, project, purpose);
}

/** As studioProjectSecret, but a missing root secret fails the request (the in-process run paths). */
async function requireProjectSecret(
  env: { PX_TELEMETRY_SECRET?: string },
  project: string,
  purpose: ProjectSecretPurpose,
): Promise<string> {
  return deriveProjectSecret(requireTelemetrySecret(env), project, purpose);
}

/**
 * The env bindings an in-process Studio run gets for its project (story 1.17), as a deployed worker of that project would:
 * the derived control-plane secret (under the PX_TELEMETRY_SECRET name), the derived webhook secret and the project id.
 * Never the root secret.
 */
async function projectWorkerSecretBindings(env: { PX_TELEMETRY_SECRET?: string }, project: string): Promise<Record<string, string>> {
  return {
    PX_PROJECT_ID: project,
    PX_TELEMETRY_SECRET: await requireProjectSecret(env, project, "control-plane"),
    PX_TELEMETRY_WEBHOOK_SECRET: await requireProjectSecret(env, project, "telemetry-webhook"),
  };
}

/**
 * The workspace a Studio run, `/run` or Test Step uses (story 1.17). None named: STUDIO_PREVIEW_WORKSPACE. A named one
 * (trimmed, and a tenant workspace id) must be one of the project's own preview workspaces: the preview workspace, a
 * workspace present in the project's OWN preview data store (its active sandbox database), or one the project's own runs
 * already name. A shared `env.DB` (every project's rows in one database) is never consulted: without a store of its own,
 * only the preview workspace and the project's own px_runs count. A malformed id is
 * 400 BAD_WORKSPACE; any other workspace is 403 WORKSPACE_NOT_IN_PROJECT; either way before anything is signed or run.
 */
async function resolveProjectPreviewWorkspace(params: {
  studioDb: D1Like;
  /** The project's own preview data store (resolveProjectDataStore); null when it has none. Never the shared `env.DB`. */
  projectDataDb: D1Like | null;
  project: string;
  requested: unknown;
}): Promise<{ ok: true; workspaceId: string } | { ok: false; response: Response }> {
  if (params.requested === undefined || params.requested === null) return { ok: true, workspaceId: STUDIO_PREVIEW_WORKSPACE };
  const refuse = () => ({
    ok: false as const,
    response: Response.json(
      {
        error: {
          code: "WORKSPACE_NOT_IN_PROJECT",
          message: "workspaceId must be this project's preview workspace or a workspace in the project's own preview data.",
        },
      },
      { status: 403 },
    ),
  });
  const ws = typeof params.requested === "string" ? params.requested.trim() : "";
  if (!ws || !isTenantWorkspaceId(ws)) {
    // A malformed id is the caller's error (400, as the runtime would answer); nothing is signed or run either way.
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: "BAD_WORKSPACE",
            message: "workspaceId must be a tenant workspace id (letters, digits, _ and -, up to 64, no double underscore).",
          },
        },
        { status: 400 },
      ),
    };
  }
  if (ws === STUDIO_PREVIEW_WORKSPACE) return { ok: true, workspaceId: ws };
  // The cheap indexed px_runs check first; the per-table scan of the project's own store only when it fails.
  if (await projectOwnsWorkspace(params.studioDb, params.project, ws)) return { ok: true, workspaceId: ws };
  if (params.projectDataDb && (await workspaceHasBrowsableData(params.projectDataDb, ws).catch(() => false))) {
    return { ok: true, workspaceId: ws };
  }
  return refuse();
}

/**
 * The workspace a Case-A connection is stored under (story 1.17): none named (or `default`) is the project-shared
 * `default` bucket; any other is trimmed and must pass the same preview-workspace check as the run paths (400 for a
 * malformed id, 403 for a workspace that is not the project's).
 */
async function resolveConnectionWorkspace(params: {
  studioDb: D1Like;
  projectDataDb: D1Like | null;
  project: string;
  requested: unknown;
}): Promise<{ ok: true; workspaceId: string } | { ok: false; response: Response }> {
  const requested = typeof params.requested === "string" ? params.requested.trim() : params.requested;
  if (requested === undefined || requested === null || requested === "" || requested === "default") {
    return { ok: true, workspaceId: "default" };
  }
  return resolveProjectPreviewWorkspace({ ...params, requested });
}

/** A signed in-process request to one of the executing /__px routes, with a fresh one-time requestId (story 1.17). */
async function signedExecutingRequest(path: string, payload: Record<string, unknown>, controlPlaneSecret: string): Promise<Request> {
  const url = `http://preview-worker.local${path}`;
  const body = JSON.stringify({ requestId: crypto.randomUUID(), ...payload });
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(await signControlPlaneRequest(controlPlaneSecret, "POST", path, body)),
    },
    body,
  });
}

/**
 * Whether `workspaceId` is one of this project's own workspaces (story 1.4): Studio's preview workspace, or a workspace
 * the project's own telemetry already names (rows Studio stamped with the project after authorising it).
 */
async function projectOwnsWorkspace(db: D1Like, project: string, workspaceId: string): Promise<boolean> {
  if (workspaceId === STUDIO_PREVIEW_WORKSPACE) return true;
  await ensureTelemetryTables(db);
  const row = await db
    .prepare("SELECT 1 AS hit FROM px_runs WHERE project_id = ?1 AND workspace_id = ?2 LIMIT 1")
    .bind(project, workspaceId)
    .first<{ hit: number }>();
  return Boolean(row);
}

/** 409 ID_COLLISION: a payload id is held by another workspace or project, so nothing of the payload was written. */
const idCollisionResponse = (claim: { table: string; id: string }) =>
  Response.json(
    {
      error: {
        code: "ID_COLLISION",
        message: `${claim.table} id "${claim.id}" is held by another workspace or project; nothing was written.`,
      },
    },
    { status: 409 },
  );

/** Runs a group of telemetry writes, answering 409 for a refused write instead of letting it become a 500. */
async function refusedWriteAs409(write: () => Promise<void>): Promise<Response | null> {
  try {
    await write();
    return null;
  } catch (error) {
    if (error instanceof TelemetryWriteRefusedError) {
      return Response.json(
        { error: { code: error.kind === "ID_COLLISION" ? "ID_COLLISION" : "TELEMETRY_WRITE_REFUSED", message: error.message } },
        { status: error.kind === "ID_COLLISION" ? 409 : 400 },
      );
    }
    throw error;
  }
}

const signingSecretNotConfigured = () =>
  Response.json(
    {
      error: {
        code: "NOT_CONFIGURED",
        message: "Studio has no PX_TELEMETRY_SECRET, so it cannot sign the request; nothing was read or written.",
      },
    },
    { status: 503 },
  );

const runtimeRegistry = buildRegistryFromCatalog(catalog);
/**
 * Story 0.9 (R-B): the default executors carry no placeholder brick executors.
 * A brick action node with no real executor fails NOT_CONFIGURED. Tests that
 * want fakes pass them through `createStudioApiApp({ executors })`.
 */
export const defaultStudioRuntimeExecutors: Executors = buildExecutorsFromCatalog(catalog);
const productionStudioRuntimeExecutors: Executors = buildExecutorsFromCatalog(catalog, { environment: "production" });

/**
 * The executors for one request. The default map is built with the request's `PX_ENVIRONMENT`, and any map
 * (including one passed to `createStudioApiApp`) is refused when it holds a placeholder in production.
 */
export function studioExecutorsFor(injected: Executors | undefined, env: { PX_ENVIRONMENT?: string }): Executors {
  const environment = env.PX_ENVIRONMENT;
  const executors =
    injected ?? (isProductionEnvironment(environment) ? productionStudioRuntimeExecutors : defaultStudioRuntimeExecutors);
  assertNoPlaceholderExecutors(executors, environment);
  return executors;
}

function executorsNotConfiguredBody(error: unknown) {
  return { error: { code: "NOT_CONFIGURED", message: error instanceof Error ? error.message : String(error) } };
}

export interface StudioApiAppOptions {
  /** Executors for workflow runs, rehearsals and reruns. Tests inject fakes here; the default has none. */
  readonly executors?: Executors;
  /**
   * How the real Cloudflare client reaches Cloudflare and bundles what it uploads (story R53). Default: global fetch and no
   * bundler. Tests pass a fake Cloudflare's fetch; the live proof script passes the real fetch and the Node bundler.
   */
  readonly deploy?: StudioDeployOptions;
}

export {
  BlueprintDO,
  CLOUDFLARE_API_TOKENS_DASHBOARD_URL,
  DeployTokenVaultError,
  STARTER_TEMPLATES,
  STUDIO_API_MIGRATION_SQL,
  STUDIO_ONBOARDING_STEPS,
  authorizeProjectAccess,
  buildCloudflareTokenTemplateUrl,
  canManageOrg,
  canMutateProject,
  canReadProject,
  computeOnboardingFunnelAnalytics,
  computeSecretKeyHint,
  computeTokenLast4,
  createStudioAuthAndOrgRoutes,
  createStudioBetterAuth,
  createStudioTokenResolver,
  createTokenVault,
  decryptSecretValue,
  decryptToken,
  deriveAesGcmVaultKey,
  encryptSecretValue,
  ensureDefaultTestAuth,
  ensureStudioD1Schema,
  generateBatchSummary,
  generateTokenRef,
  generateUuidV7,
  getDeployTokenMetadata,
  getStarterTemplate,
  instantiateStarterTemplateForProject,
  listDeployTokenAuditLog,
  listOnboardingFunnelEvents,
  listOrgDeployTokens,
  listProjectDeployEnvironments,
  listStarterTemplates,
  listStudioOnboardingEvents,
  markDeployTokenVerificationStatus,
  normalizeOrgRole,
  normalizeStudioAuthHeaders,
  parseTokenScopes,
  recordOnboardingFunnelEvent,
  recordStudioAuditLog,
  recordStudioOnboardingEvent,
  resolveStudioAuthSession,
  resolveStudioCaller,
  revokeDeployToken,
  rotateDeployTokenKek,
  sealDeployToken,
  upsertProjectDeployEnvironments,
  verifyCloudflareToken,
  analyzeSqlMigrations,
  checkEnvironmentDrift,
  computeDeployPlan,
  computeRollbackPlan,
  DEFAULT_CATALOG_VERSION,
  computeArtifactHashes,
  computeBuildHash,
  computeCodeHash,
  computeGraphHash,
  canonicalCodePayload,
  canonicalGraphPayload,
  computeBlueprintBuildHash,
  computeBlueprintCodeHash,
  computeBlueprintGraphHash,
  evaluateProposalSelection,
  summarizeProposalOps,
  BETA_PARTNER_TYPES,
  BetaPartnerTypeSchema,
  CohortPartnerSeedInputSchema,
  CohortPartnerSessionTelemetrySchema,
  CohortProvisionRequestSchema,
  DEFAULT_COHORT_1_PARTNERS,
  computeCohortBetaMetrics,
  provisionBetaCohortPartners,
  validateCohort1Composition,
  ByocCloudflareTarget,
  HostedSandboxTarget,
  PlatformSandboxDeployTargetSchema,
  SANDBOX_D1_MAX_BYTES,
  SANDBOX_D1_MAX_ROWS,
  SANDBOX_DAILY_REQUEST_LIMIT,
  SANDBOX_OUTBOUND_RPM_LIMIT,
  SANDBOX_TTL_DAYS,
  SANDBOX_TTL_MS,
  SandboxDispatchPlatform,
  SandboxGuardrailError,
  assertNoLivePaymentCredential,
  createHostedSandboxProvisioner,
  createSandboxDispatcher,
  createSandboxOutboundFetch,
  inspectOutboundPaymentAndSsrf,
  isLivePaymentCredential,
  wrapSandboxD1WithStorageCap,
};
export type {
  BetaPartnerType,
  BetaReadinessReport,
  CohortCompositionValidationResult,
  CohortPartnerSeedInput,
  CohortPartnerSessionTelemetry,
  CohortProvisionRequest,
  ProvisionedCohortPartnerRecord,
  HostedSandboxProvisioner,
  PlatformSandboxDeployTarget,
};
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

export interface ActivityFeedPayload {
  project: string;
  events: ActivityFeedEventPayload[];
  total: number;
  filters: {
    author: string;
    type: string;
    window: string;
  };
}

export type {
  AcceptProposalInput,
  ArtifactHashes,
  BlueprintDriftReport,
  CompositeBuildHashInput,
  CloudflareTokenTemplateMetadata,
  CloudflareTokenVerificationReport,
  CurrentBlueprintHashes,
  DeployEnvName,
  DeployPlan,
  DeployPlanAction,
  DeployPlanBlocker,
  DeployPlanEnvironmentState,
  DeployPlanSecretCheck,
  DeployPlanSecretRequirement,
  DeployTarget,
  DestructiveMigrationWarning,
  DriftReport,
  ExpectedDeploymentState,
  OutOfBandDriftItem,
  ProposalActor,
  ProposalRecord,
  ProposalSelectionEvaluation,
  ProposalStatus,
  ProvisionerApplyResult,
  ProvisionerMigrationItem,
  ProvisionerPlanResult,
  RejectProposalInput,
  RollbackPlanSnapshot,
  DeployTokenAuditEntry,
  DeployTokenMetadata,
  DeployTokenStatus,
  DeployTokenVaultErrorCode,
  OnboardingFunnelAnalyticsReport,
  OnboardingFunnelEvent,
  OnboardingFunnelStep,
  ProjectEnvironmentTargetRecord,
  RevokeDeployTokenOptions,
  RevokeDeployTokenResult,
  RotateKekResult,
  SealDeployTokenInput,
  SealedSecretRecord,
  StarterTemplateDescriptor,
  StarterTemplateId,
  StudioOnboardingEvent,
  StudioOnboardingStep,
  StudioTokenVault,
  TokenKekConfig,
  TokenResolutionContext,
  TokenResolver,
  ApplyBatchOutcome,
  ApplyOpsInput,
  AuthorAttribution,
  ConflictDetail,
  ConflictErrorPayload,
  ImportBundleInput,
  InterveningOpRecord,
  PinnedNodeOutput,
  ProjectStatePayload,
  RevertInput,
  RevisionHistoryPayload,
  RevisionSummary,
  SemanticDiffPayload,
  SnapshotRecord,
  StudioApiEnv,
  StudioAuditLogInput,
  StudioAuthSession,
  StudioAuthUser,
  StudioCaller,
  StudioOrgRole,
  StudioOrgRoleInput,
};

const AuthorSchema = z.strictObject({
  type: z.enum(["human", "agent"]),
  id: z.string().min(1).max(128),
  client: z.string().min(1).max(128).optional(),
  onBehalfOf: z.string().min(1).max(128).optional(),
});

const ApplyOpsBodySchema = z.strictObject({
  baseRevision: z.number().int().min(0).optional(),
  author: AuthorSchema.optional(),
  summary: z.string().max(240).optional(),
  mode: z.enum(["apply", "propose"]).optional(),
  proposalId: z.string().min(1).max(120).optional(),
  ops: z.array(z.unknown()).min(1).max(100),
  orgId: z.string().min(1).max(128).optional(),
});

const AcceptProposalBodySchema = z.strictObject({
  opIds: z.array(z.string().min(1)).optional(),
  author: AuthorSchema.optional(),
  orgId: z.string().min(1).max(128).optional(),
});

const RejectProposalBodySchema = z.strictObject({
  reason: z.string().max(500).optional(),
  author: AuthorSchema.optional(),
  orgId: z.string().min(1).max(128).optional(),
});

const RevertBodySchema = z.strictObject({
  targetRevision: z.number().int().min(0),
  baseRevision: z.number().int().min(0).optional(),
  author: AuthorSchema.optional(),
  orgId: z.string().min(1).max(128).optional(),
  approvalId: z.string().min(1).max(128).optional(),
});

const ImportBodySchema = z.strictObject({
  bundle: z.unknown(),
  approvalId: z.string().min(1).max(128).optional(),
  author: AuthorSchema.optional(),
  mode: z.enum(["create", "replace"]).optional(),
  orgId: z.string().min(1).max(128).optional(),
  templateId: z.string().min(1).max(80).optional(),
});

const UpsertSecretBodySchema = z.strictObject({
  ref: z.string().min(1).max(128),
  kind: z.enum(["api_key", "webhook_secret", "brick_secret"]).default("api_key"),
  label: z.string().min(1).max(120),
  appOrBrick: z.string().min(1).max(120).default("custom"),
  envScope: z.string().min(1).max(60).default("all"),
  value: z.string().min(1).max(8192),
  orgId: z.string().min(1).max(128).optional(),
  bindTarget: z
    .strictObject({
      targetKind: z.enum(["brick", "node", "connection"]),
      targetId: z.string().min(1).max(120),
      secretName: z.string().min(1).max(120),
    })
    .optional(),
});

const UpsertConnectionBodySchema = z.object({
  ref: z.string().min(1).max(128),
  app: z.string().min(1).max(120),
  authType: z
    .enum(["oauth2", "apiKey", "bearer", "basic", "webhookSecret", "api-key", "webhook-secret"])
    .default("apiKey"),
  label: z.string().min(1).max(120).optional(),
  envScope: z.string().min(1).max(60).default("preview"),
  workspaceId: z.string().min(1).max(120).default("default"),
  scopes: z.array(z.string()).default([]),
  value: z.string().min(1).max(8192).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().nullable().optional(),
  orgId: z.string().min(1).max(128).optional(),
  bindTarget: z
    .strictObject({
      targetKind: z.enum(["brick", "node", "connection"]),
      targetId: z.string().min(1).max(120),
      secretName: z.string().min(1).max(120),
    })
    .optional(),
});

const CreateConnectionRequestBodySchema = z.object({
  app: z.string().min(1).max(120),
  reason: z.string().min(1).max(500),
  scopes: z.array(z.string()).default([]),
  suggestedRef: z.string().min(1).max(128).optional(),
  orgId: z.string().min(1).max(128).optional(),
});

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generateRandomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function computePkceS256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return toBase64Url(new Uint8Array(digest));
}

function getIntegrationOAuthConfig(appSlug: string): {
  authorizationUrl: string;
  tokenUrl: string;
  defaultScopes: string[];
} {
  const pack = (catalog.nodePacks ?? {})[appSlug] as
    | {
        manifest?: {
          kind?: string;
          auth?: {
            type?: string;
            oauth2?: {
              authorizationUrl?: string;
              tokenUrl?: string;
              scopes?: string[];
            };
          };
        };
      }
    | undefined;
  const oauth2 = pack?.manifest?.auth?.oauth2;
  return {
    authorizationUrl:
      oauth2?.authorizationUrl ?? `https://oauth.${appSlug}.example.com/authorize`,
    tokenUrl: oauth2?.tokenUrl ?? `https://oauth.${appSlug}.example.com/token`,
    defaultScopes: oauth2?.scopes ?? [],
  };
}

const studioProjectAssembleCounts = new Map<string, number>();
let studioSandboxPlatform = new SandboxDispatchPlatform();

export function getStudioSandboxPlatform(): SandboxDispatchPlatform {
  return studioSandboxPlatform;
}

export interface StudioSandboxSummary {
  sandboxId: string;
  projectId: string;
  orgId: string;
  dispatchNamespace: string;
  buildHash: string;
  codeHash: string;
  graphHash: string;
  deployedRev: number;
  previewUrl: string;
  url: string;
  status: "active" | "expired" | "promoted" | "destroyed";
  createdAt: string;
  expiresAt: string;
  destroyedAt: string | null;
  remainingDays: number;
  isExpired: boolean;
  quotas: {
    dailyRequestLimit: number;
    dailyRequestsUsed: number;
    d1MaxRows: number;
    d1RowsUsed: number;
    d1MaxBytes: number;
    d1BytesUsed: number;
  };
}

export interface PruneExpiredSandboxesResult {
  ok: true;
  evaluatedAt: string;
  prunedCount: number;
  prunedSandboxIds: string[];
  prunedProjects: string[];
}

export async function pruneExpiredSandboxes(
  db: D1Like,
  options?: {
    now?: number | string | Date;
    platform?: SandboxDispatchPlatform;
  },
): Promise<PruneExpiredSandboxesResult> {
  await ensureStudioD1Schema(db);
  const nowMs =
    options?.now instanceof Date
      ? options.now.getTime()
      : typeof options?.now === "number"
        ? options.now
        : typeof options?.now === "string"
          ? Date.parse(options.now)
          : Date.now();
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowIso = new Date(effectiveNowMs).toISOString();
  const platform = options?.platform ?? studioSandboxPlatform;
  const targetDriver = new HostedSandboxTarget({
    platform,
    now: () => effectiveNowMs,
  });

  const rowsRes = await db
    .prepare(
      `SELECT sandbox_id, project_id, org_id, dispatch_namespace, expires_at
       FROM studio_sandboxes
       WHERE status = 'active'
       ORDER BY created_at ASC`,
    )
    .all<{
      sandbox_id: string;
      project_id: string;
      org_id: string;
      dispatch_namespace: string;
      expires_at: string;
    }>();

  const prunedSandboxIds: string[] = [];
  const prunedProjects: string[] = [];
  const seenSandboxIds = new Set<string>();

  for (const row of rowsRes.results ?? []) {
    const expMs = Date.parse(row.expires_at);
    if (Number.isFinite(expMs) && expMs <= effectiveNowMs) {
      seenSandboxIds.add(row.sandbox_id);
      await targetDriver.destroy({
        type: "platform-sandbox",
        sandboxId: row.sandbox_id,
        dispatchNamespace: row.dispatch_namespace || "px-sandboxes",
        expiresAt: row.expires_at,
      });
      await db
        .prepare(
          `UPDATE studio_sandboxes
           SET status = 'expired', destroyed_at = ?
           WHERE sandbox_id = ?`,
        )
        .bind(nowIso, row.sandbox_id)
        .run();
      await recordStudioAuditLog(db, {
        orgId: row.org_id || "org_default",
        projectId: row.project_id,
        actorType: "agent",
        actorId: "system:sandbox-reaper",
        action: "sandbox.expire_reap",
        status: "succeeded",
        targetRef: row.sandbox_id,
        details: {
          sandboxId: row.sandbox_id,
          projectId: row.project_id,
          expiresAt: row.expires_at,
          evaluatedAt: nowIso,
        },
      });
      prunedSandboxIds.push(row.sandbox_id);
      if (!prunedProjects.includes(row.project_id)) {
        prunedProjects.push(row.project_id);
      }
    }
  }

  // Also check any in-memory platform sandboxes that might not have been persisted or were created directly on platform
  for (const worker of platform.listActiveSandboxes()) {
    if (seenSandboxIds.has(worker.sandboxId)) continue;
    const expMs = Date.parse(worker.expiresAt);
    if (Number.isFinite(expMs) && expMs <= effectiveNowMs) {
      await targetDriver.destroy({
        type: "platform-sandbox",
        sandboxId: worker.sandboxId,
        dispatchNamespace: worker.dispatchNamespace || "px-sandboxes",
        expiresAt: worker.expiresAt,
      });
      await db
        .prepare(
          `UPDATE studio_sandboxes
           SET status = 'expired', destroyed_at = ?
           WHERE sandbox_id = ?`,
        )
        .bind(nowIso, worker.sandboxId)
        .run()
        .catch(() => {});
      prunedSandboxIds.push(worker.sandboxId);
      if (worker.projectId && !prunedProjects.includes(worker.projectId)) {
        prunedProjects.push(worker.projectId);
      }
    }
  }

  return {
    ok: true,
    evaluatedAt: nowIso,
    prunedCount: prunedSandboxIds.length,
    prunedSandboxIds,
    prunedProjects,
  };
}

async function loadProjectSandboxSummary(
  db: D1Like,
  project: string,
  nowMs: number = Date.now(),
): Promise<StudioSandboxSummary | null> {
  await ensureStudioD1Schema(db);
  const row = await db
    .prepare(
      `SELECT sandbox_id, project_id, org_id, dispatch_namespace, build_hash, code_hash, graph_hash,
              deployed_rev, preview_url, status, daily_requests_used, d1_rows_used, d1_bytes_used,
              created_at, expires_at, destroyed_at
       FROM studio_sandboxes
       WHERE project_id = ?
       ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END ASC, created_at DESC
       LIMIT 1`,
    )
    .bind(project)
    .first<{
      sandbox_id: string;
      project_id: string;
      org_id: string;
      dispatch_namespace: string;
      build_hash: string;
      code_hash: string;
      graph_hash: string;
      deployed_rev: number;
      preview_url: string;
      status: "active" | "expired" | "promoted" | "destroyed";
      daily_requests_used: number;
      d1_rows_used: number;
      d1_bytes_used: number;
      created_at: string;
      expires_at: string;
      destroyed_at: string | null;
    }>();

  if (!row) return null;

  let dailyRequestsUsed = Number(row.daily_requests_used ?? 0);
  let d1RowsUsed = Number(row.d1_rows_used ?? 0);
  let d1BytesUsed = Number(row.d1_bytes_used ?? 0);

  const liveRecord = studioSandboxPlatform.getSandbox(row.sandbox_id);
  if (liveRecord?.worker) {
    dailyRequestsUsed = Math.max(
      dailyRequestsUsed,
      studioSandboxPlatform.getDailyRequestCount(row.sandbox_id, nowMs),
    );
  }
  if (liveRecord?.d1) {
    const stats = await liveRecord.d1.d1Binding.getStorageStats();
    d1RowsUsed = Math.max(d1RowsUsed, stats.totalRows);
    d1BytesUsed = Math.max(d1BytesUsed, stats.totalBytes);
  }

  const expMs = Date.parse(row.expires_at);
  const diffMs = Number.isFinite(expMs) ? expMs - nowMs : 0;
  const remainingDays = Math.max(
    0,
    Math.min(7, Math.ceil(diffMs / (24 * 60 * 60 * 1000))),
  );
  const isExpired =
    row.status === "expired" || (Number.isFinite(expMs) && expMs <= nowMs);

  return {
    sandboxId: row.sandbox_id,
    projectId: row.project_id,
    orgId: row.org_id,
    dispatchNamespace: row.dispatch_namespace,
    buildHash: row.build_hash,
    codeHash: row.code_hash,
    graphHash: row.graph_hash,
    deployedRev: Number(row.deployed_rev),
    previewUrl: row.preview_url,
    url: row.preview_url,
    status: isExpired && row.status === "active" ? "expired" : row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    destroyedAt: row.destroyed_at,
    remainingDays,
    isExpired,
    quotas: {
      dailyRequestLimit: SANDBOX_DAILY_REQUEST_LIMIT,
      dailyRequestsUsed,
      d1MaxRows: SANDBOX_D1_MAX_ROWS,
      d1RowsUsed,
      d1MaxBytes: SANDBOX_D1_MAX_BYTES,
      d1BytesUsed,
    },
  };
}

export function getProjectAssembleCount(project: string, revision?: number): number {
  if (revision !== undefined) {
    return studioProjectAssembleCounts.get(`${project}:r${revision}`) ?? 0;
  }
  return studioProjectAssembleCounts.get(project) ?? 0;
}

/**
 * Test-only reset. `createSandboxD1` lets a test stand a real D1 binding in for each sandbox database (the default is
 * the platform's lightweight in-memory D1).
 */
export function resetStudioDeployTestState(options?: {
  createSandboxD1?: (sandboxId: string, dbName: string) => D1Like;
}): void {
  resetStudioFakeControlPlanes();
  studioProjectAssembleCounts.clear();
  studioSandboxPlatform = new SandboxDispatchPlatform(
    options?.createSandboxD1 ? { createD1: options.createSandboxD1 } : undefined,
  );
}

function getBlueprintStub(env: StudioApiEnv, project: string): DurableObjectStub {
  const id = env.BLUEPRINT_DO.idFromName(project);
  return env.BLUEPRINT_DO.get(id);
}

/**
 * The author of a write is always the verified caller: the session user, or the MCP token (on behalf of its user).
 * A body `author` or an `x-mcp-client-*` header can never set it (story 0.15).
 */
function resolveEffectiveAuthor(caller: StudioCaller): AuthorAttribution {
  return caller.author;
}

/** AD-V8 / AD-S10: true when the project has a live production deployment, so a direct edit would reach production. */
async function projectHasLiveProduction(
  env: StudioApiEnv,
  orgId: string,
  project: string,
): Promise<boolean> {
  const environments = await listProjectDeployEnvironments(env.STUDIO_DB, {
    orgId,
    projectId: project,
  });
  return environments.some(
    (e) => e.envName === "production" && e.deployedRev !== null && e.deployedRev !== undefined,
  );
}

/**
 * AD-V8: what a revert would change, for the reviewer: the semantic diff from the current revision to the target, by
 * name (bricks, entities, workflows, secret refs added, removed or changed).
 */
async function revertApprovalSummary(
  env: StudioApiEnv,
  project: string,
  targetRevision: number,
): Promise<Record<string, unknown>> {
  const client = createDurableObjectBlueprintClient(env.BLUEPRINT_DO);
  const current = await client.getProject(project);
  const target = await client.getProject(project, targetRevision);
  if (!current || !target) return { targetRevision, fromRevision: current?.revision ?? 0 };
  return {
    targetRevision,
    fromRevision: current.revision,
    diff: summarizeSemanticDiff(computeSemanticDiff(current.state, target.state)),
  };
}

/** The project's committed blueprint revision (0 when it has none), for binding an approval. */
async function currentBlueprintRevision(env: StudioApiEnv, project: string): Promise<number> {
  const snapshot = await createDurableObjectBlueprintClient(env.BLUEPRINT_DO).getProject(project);
  return snapshot?.revision ?? 0;
}

/**
 * AD-V8: the approval gate as a route sees it. A session caller passes; an MCP token needs an approved, unused,
 * matching `approvalId`. Returns the refusal response, or null when the action may run.
 */
async function gateDestructiveAction(
  c: { env: StudioApiEnv; req: { raw: Request } },
  caller: StudioCaller,
  binding: ApprovalBinding,
  approvalId: string | undefined,
): Promise<Response | null> {
  const gate = await requireApproval(c.env.STUDIO_DB, caller, binding, approvalId);
  if (gate.ok) {
    if (gate.approvalId && gate.consumedAt) {
      approvalLeases.set(c.req.raw, {
        orgId: binding.orgId,
        projectId: binding.projectId,
        approvalId: gate.approvalId,
        consumedAt: gate.consumedAt,
        caller,
      });
    }
    return null;
  }
  return Response.json({ ok: false, ...gate.body }, { status: gate.status });
}

/**
 * AD-V8: approvals consumed by the request now running. The approval is consumed before the action (so it can never be
 * used twice); if the action then fails, `settleApprovalLease` gives it back so the same bound retry can run.
 */
const approvalLeases = new WeakMap<
  Request,
  { orgId: string; projectId: string; approvalId: string; consumedAt: string; caller: StudioCaller }
>();

/** True when a gated action's answer is a failure: an error status, `ok: false`, or a failed deployment. */
async function actionFailed(res: Response): Promise<boolean> {
  if (res.status >= 400) return true;
  try {
    const body = (await res.clone().json()) as { ok?: unknown; status?: unknown; environment?: { status?: unknown } };
    return body.ok === false || body.status === "failed" || body.environment?.status === "failed";
  } catch {
    return false;
  }
}

async function settleApprovalLease(env: StudioApiEnv, request: Request, failed: boolean, reason: string): Promise<void> {
  const lease = approvalLeases.get(request);
  if (!lease) return;
  approvalLeases.delete(request);
  if (!failed) return;
  await releaseApproval(env.STUDIO_DB, lease.caller, {
    orgId: lease.orgId,
    projectId: lease.projectId,
    approvalId: lease.approvalId,
    consumedAt: lease.consumedAt,
    reason,
  });
}

/** The Studio routes AD-V8 gates for an MCP token; their consumed approval is released if the action fails. */
const APPROVAL_GATED_ROUTES = [
  "/api/projects/:project/revert",
  "/api/projects/:project/import",
  "/api/projects/:project/environments/:envName/deploy",
  "/api/projects/:project/environments/:envName/promote",
  "/api/projects/:project/environments/:envName/rollback",
  "/api/projects/:project/sandbox/deploy",
  "/api/projects/:project/sandbox/promote-to-byoc",
] as const;

function createOrgScopedBlueprintClient(
  env: StudioApiEnv,
  orgId: string,
  role: StudioOrgRole,
): BlueprintClient {
  const baseClient = createDurableObjectBlueprintClient(env.BLUEPRINT_DO);
  return {
    getProject: (project, revision) => baseClient.getProject(project, revision),
    async applyOps(input) {
      const stub = getBlueprintStub(env, input.project);
      const res = await stub.fetch("http://blueprint-do/ops", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-studio-caller-role": role,
        },
        body: JSON.stringify({
          ...input,
          orgId,
          callerRole: role,
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status === 200) {
        return {
          ok: true,
          status: 200,
          data: body as unknown as Awaited<ReturnType<BlueprintClient["applyOps"]>> & {
            ok: true;
          } extends { data: infer D }
            ? D
            : never,
        };
      }
      if (res.status === 409) {
        return {
          ok: false,
          status: 409,
          error: body.error as never,
        };
      }
      return {
        ok: false,
        status: 422,
        error: body.error as never,
      };
    },
    async revertToRevision(input) {
      const stub = getBlueprintStub(env, input.project);
      const res = await stub.fetch("http://blueprint-do/revert", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-studio-caller-role": role,
        },
        body: JSON.stringify({
          ...input,
          orgId,
          callerRole: role,
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status === 200) {
        return {
          ok: true,
          status: 200,
          data: body as never,
        };
      }
      if (res.status === 409) {
        return {
          ok: false,
          status: 409,
          error: body.error as never,
        };
      }
      return {
        ok: false,
        status: 422,
        error: body.error as never,
      };
    },
  };
}

/**
 * `px_connections` is keyed by `ref` alone, so a ref held by one project must never be written by another (story 16):
 * the write is refused with 409 instead of overwriting (or silently skipping) the other project's credentials.
 */
class ConnectionRefConflictError extends Error {
  readonly ref: string;
  constructor(ref: string) {
    super(`Connection ref "${ref}" is already used by another project; choose a different ref`);
    this.name = "ConnectionRefConflictError";
    this.ref = ref;
  }
}

async function assertConnectionRefFree(envDb: D1Like, ref: string, project: string): Promise<void> {
  await ensureConnectionsTable(envDb);
  const row = await envDb
    .prepare("SELECT project_id FROM px_connections WHERE ref = ? LIMIT 1")
    .bind(ref)
    .first<{ project_id: string }>();
  if (row && row.project_id !== project) throw new ConnectionRefConflictError(ref);
}

/** After the guarded upsert: the row for `ref` must now be this project's, else another project took it in between. */
async function assertConnectionRefOwned(envDb: D1Like, ref: string, project: string): Promise<void> {
  const row = await envDb
    .prepare("SELECT project_id FROM px_connections WHERE ref = ? LIMIT 1")
    .bind(ref)
    .first<{ project_id: string }>();
  if (!row || row.project_id !== project) throw new ConnectionRefConflictError(ref);
}

/** Routes authenticated by their own signature (HMAC), not by a session cookie: exempt from the CSRF Origin check. */
const STUDIO_SIGNED_INGRESS_PATHS: ReadonlyArray<string | RegExp> = [
  "/api/webhooks/in/",
  "/api/webhooks/ingress/",
  /^\/api\/projects\/[^/]+\/telemetry\/webhook$/,
];

/** A deploy the real client refuses before writing anything; app.onError answers it as JSON with its status. */
export class StudioDeployRefusal extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: Record<string, unknown>;
  constructor(code: string, message: string, status = 422, detail?: Record<string, unknown>) {
    super(message);
    this.name = "StudioDeployRefusal";
    this.code = code;
    this.status = status;
    if (detail) this.detail = detail;
  }
  getResponse(): Response {
    return Response.json({ error: { code: this.code, message: this.message, ...(this.detail ?? {}) } }, { status: this.status });
  }
}

export function createStudioApiApp(appOptions: StudioApiAppOptions = {}) {
  const app = new Hono<{ Bindings: StudioApiEnv }>();

  // Studio keeps an HMAC of each Worker secret in its own state (secretHashes). It is bookkeeping, never part of an answer:
  // every JSON response from the API and MCP routes has the key removed, wherever it sits.
  app.use("*", async (c, next) => {
    await next();
    const path = new URL(c.req.url).pathname;
    if (!(path.startsWith("/api/") || path === "/mcp")) return;
    const type = c.res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) return;
    const text = await c.res.clone().text();
    if (!text.includes("secretHashes")) return;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => k !== "secretHashes").map(([k, v]) => [k, strip(v)]));
      }
      // MCP answers carry tool results as JSON text
      if (typeof value === "string" && value.includes("secretHashes") && value.trimStart().startsWith("{")) {
        try {
          return JSON.stringify(strip(JSON.parse(value)));
        } catch {
          return value;
        }
      }
      return value;
    };
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(JSON.stringify(strip(body)), { status: c.res.status, statusText: c.res.statusText, headers });
  });

  app.onError((err, c) => {
    if (err instanceof ConnectionRefConflictError) {
      return c.json({ error: { code: "CONNECTION_REF_IN_USE", message: err.message } }, 409);
    }
    if (typeof (err as { getResponse?: unknown }).getResponse === "function") {
      return (err as unknown as { getResponse: () => Response }).getResponse();
    }
    console.error(err);
    return c.text("Internal Server Error", 500);
  });

  // Story 0.14: CSRF (Origin check on cookie-authenticated writes) and the CORS allow-list (PX_ALLOWED_ORIGINS) for
  // every route. Signed webhook ingress keeps its own signature check and is not Origin-checked.
  app.use("*", createHttpGuard({ exemptPaths: STUDIO_SIGNED_INGRESS_PATHS }));

  // AD-V8: after a gated action, a consumed approval whose action failed is released for the same bound retry.
  for (const path of APPROVAL_GATED_ROUTES) {
    app.use(path, async (c, next) => {
      await next();
      if (!approvalLeases.has(c.req.raw)) return;
      const failed = await actionFailed(c.res);
      await settleApprovalLease(c.env, c.req.raw, failed, `the action answered HTTP ${c.res.status}`);
    });
  }

  // Mount Better Auth (/api/auth/*) and Organizations / Members / MCP Tokens (/api/orgs/*)
  app.route("/", createStudioAuthAndOrgRoutes());

  // Studio MCP endpoint (/mcp and /api/mcp) enforcing scoped MCP tokens, org isolation, RBAC, and audit log
  const handleStudioMcp = async (c: { req: { raw: Request }; env: StudioApiEnv }) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: resolved.error.message, data: resolved.error },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": 'Bearer realm="mcp"',
          },
        },
      );
    }

    let message: Record<string, unknown>;
    try {
      message = (await c.req.raw.json()) as Record<string, unknown>;
    } catch {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } },
        { status: 400 },
      );
    }

    const id = (message.id as string | number | null) ?? null;
    const method = message.method;
    // Story R55: a notification (no id, nothing to answer) is accepted with 202 and no body, as the Streamable HTTP
    // transport requires; the MCP clients (Claude Code, the protocol SDK) send notifications/initialized after initialize.
    if (typeof method === "string" && method.startsWith("notifications/") && !("id" in message)) {
      return new Response(null, { status: 202 });
    }
    const params =
      typeof message.params === "object" && message.params !== null
        ? (message.params as Record<string, unknown>)
        : {};

    if (method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      });
    }

    if (method === "ping") {
      return Response.json({ jsonrpc: "2.0", id, result: {} });
    }

    if (method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: { tools: toolDescriptions() },
      });
    }

    if (method === "tools/call") {
      const caller = resolved.caller;
      const name = typeof params.name === "string" ? params.name : "";
      let rawArgs =
        typeof params.arguments === "object" &&
        params.arguments !== null &&
        !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      // Story 0.15: an MCP token's tool project defaults to the token's project, so a call without `project` still
      // runs against (and is authorised for) that one project only.
      if (caller.kind === "mcp_token" && !("project" in rawArgs)) {
        rawArgs = { ...rawArgs, project: caller.projectId };
      }
      const targetProject: string | undefined =
        typeof rawArgs.project === "string"
          ? rawArgs.project
          : caller.kind === "mcp_token"
            ? caller.projectId
            : undefined;

      if (name === "get_history") {
        if (!targetProject) {
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: "Invalid arguments: project is required" }],
              isError: true,
            },
          });
        }
        const authz = await authorizeProjectAccess(
          c.env.STUDIO_DB,
          caller,
          targetProject,
          "read",
        );
        if (!authz.ok) {
          return Response.json(
            {
              jsonrpc: "2.0",
              id,
              error: authz.error,
            },
            { status: authz.status },
          );
        }
        const stub = getBlueprintStub(c.env, targetProject);
        const revRes = await stub.fetch(
          `http://blueprint-do/revisions?project=${encodeURIComponent(targetProject)}`,
          { method: "GET" },
        );
        const revBody = await revRes.text();
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: revBody }],
          },
        });
      }
      const isRevertAlias =
        name === "apply_ops" &&
        ("revertTo" in rawArgs || "targetRevision" in rawArgs) &&
        !("ops" in rawArgs);
      const tool = isRevertAlias
        ? revertToRevisionTool
        : (ALL_TOOLS.find((t) => t.name === name) ??
          (name === "revert_to_revision" ? revertToRevisionTool : undefined));

      if (!tool) {
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` },
        });
      }

      const origin = (() => {
        try {
          return new URL(c.req.raw.url).origin;
        } catch {
          return "https://studio.projectx.local";
        }
      })();
      const studioRequest: StudioRequestFn = async (path, init) => {
        const url = new URL(path, origin);
        const headers = new Headers(c.req.raw.headers);
        if (init?.headers) {
          const extra = new Headers(init.headers);
          extra.forEach((v, k) => headers.set(k, v));
        }
        // Story 0.15: the organization comes from the verified caller and the project, never from a client header.
        headers.delete("x-org-id");
        headers.delete("content-length");
        return app.fetch(
          new Request(url.toString(), {
            method: init?.method ?? "GET",
            headers,
            ...(init?.body !== undefined ? { body: init.body } : {}),
          }),
          c.env,
        );
      };

      const mode: "read" | "mutate" = tool.readOnly ? "read" : "mutate";
      const requiredScope: StudioMcpScope =
        name === "deploy_apply"
          ? "deploy"
          : name === "request_connection"
            ? "connect"
            : "edit";

      if (targetProject === undefined && mode === "mutate") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: "Invalid arguments: project is required" }],
            isError: true,
          },
        });
      }

      // Every call that names (or defaults to) a project is authorised for it. A session caller's read-only call with
      // no project reaches the catalog only: its blueprint client is pinned to no project.
      let authzOrgId: string | null = null;
      let authzRole: StudioOrgRole | null = null;
      if (targetProject !== undefined) {
        const authz = await authorizeProjectAccess(
          c.env.STUDIO_DB,
          caller,
          targetProject,
          mode,
          undefined,
          requiredScope,
        );

        if (!authz.ok) {
          if (mode === "mutate") {
            await recordStudioAuditLog(c.env.STUDIO_DB, {
              orgId: authz.orgId,
              projectId: targetProject,
              actorType: caller.author.type,
              actorId: caller.author.id,
              action: `mcp.${name}`,
              status: "forbidden",
              details: {
                code: authz.error.code,
                message: authz.error.message,
                role: authz.role,
              },
            });
          }
          return Response.json(
            {
              jsonrpc: "2.0",
              id,
              error: authz.error,
            },
            { status: authz.status },
          );
        }
        authzOrgId = authz.orgId;
        authzRole = authz.role;
      }

      const effectiveArgs = isRevertAlias
        ? {
            project: rawArgs.project,
            targetRevision: rawArgs.revertTo ?? rawArgs.targetRevision,
            ...(rawArgs.baseRevision !== undefined ? { baseRevision: rawArgs.baseRevision } : {}),
            ...(rawArgs.approvalId !== undefined ? { approvalId: rawArgs.approvalId } : {}),
          }
        : rawArgs;

      const checked = checkArguments(tool, effectiveArgs);
      if (!checked.ok) {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Invalid arguments: ${checked.message}` }],
            isError: true,
          },
        });
      }

      let mcpRevertLease: { orgId: string; projectId: string; approvalId: string; consumedAt: string } | null = null;
      // AD-V8: an MCP token's revert (revert_to_revision or the apply_ops `revertTo` alias) needs a Studio approval.
      // The tool applies the revert through the blueprint client, so the gate runs here, keyed on the verified caller.
      if (
        tool === revertToRevisionTool &&
        caller.kind === "mcp_token" &&
        targetProject !== undefined &&
        authzOrgId !== null
      ) {
        const revertArgs = checked.value as unknown as { targetRevision: number; approvalId?: string };
        const gate = await requireApproval(
          c.env.STUDIO_DB,
          caller,
          {
            orgId: authzOrgId,
            projectId: targetProject,
            action: "revert",
            target: String(revertArgs.targetRevision),
            blueprintRev: await currentBlueprintRevision(c.env, targetProject),
            summary: await revertApprovalSummary(c.env, targetProject, revertArgs.targetRevision),
          },
          revertArgs.approvalId,
        );
        if (gate.ok && gate.approvalId && gate.consumedAt) {
          mcpRevertLease = { orgId: authzOrgId, projectId: targetProject, approvalId: gate.approvalId, consumedAt: gate.consumedAt };
        }
        if (!gate.ok) {
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ ...gate.body, project: targetProject }) }],
              isError: true,
            },
          });
        }
      }

      const blueprintClient = pinBlueprintClient(
        authzOrgId !== null && authzRole !== null
          ? createOrgScopedBlueprintClient(c.env, authzOrgId, authzRole)
          : createDurableObjectBlueprintClient(c.env.BLUEPRINT_DO),
        targetProject ?? null,
      );
      // The author is the verified caller only: the session user, or the MCP token on behalf of its user. Request
      // headers (`x-mcp-client-*`) and the body cannot set it.
      const author: BlueprintAuthor = {
        type: caller.author.type,
        id: caller.author.id,
        ...(caller.author.client ? { client: caller.author.client } : {}),
        ...(caller.author.onBehalfOf ? { onBehalfOf: caller.author.onBehalfOf } : {}),
      };

      const mcpDb = c.env.DB ?? c.env.STUDIO_DB;
      await ensureStudioD1Schema(mcpDb);
      let toolResult: { text: string; isError: boolean };
      try {
        toolResult = await tool.run(
          {
            db: mcpDb,
            catalog,
            blueprint: blueprintClient,
            author,
            studioRequest,
            baseUrl: origin,
            // AD-V8: keyed on the verified caller kind; a Studio session user is the reviewer and is not gated.
            reviewRequired: caller.kind !== "session",
            ...(authzOrgId !== null
              ? {
                  hasLiveProduction: (project: string) =>
                    projectHasLiveProduction(c.env, authzOrgId as string, project),
                }
              : {}),
          },
          checked.value,
        );
      } catch (error) {
        // AD-V8: a revert that threw after its approval was consumed gives the approval back for the same retry.
        if (mcpRevertLease) {
          await releaseApproval(c.env.STUDIO_DB, caller, { ...mcpRevertLease, reason: "the revert threw" });
        }
        if (error instanceof ProjectOutOfScopeError) {
          return Response.json(
            {
              jsonrpc: "2.0",
              id,
              error: { code: "FORBIDDEN_PROJECT", message: error.message },
            },
            { status: 403 },
          );
        }
        throw error;
      }

      // AD-V8: a revert that failed after its approval was consumed gives the approval back for the same retry.
      if (mcpRevertLease && toolResult.isError) {
        await releaseApproval(c.env.STUDIO_DB, caller, { ...mcpRevertLease, reason: "the revert failed" });
      }

      if (mode === "mutate" && authzOrgId !== null) {
        await recordStudioAuditLog(c.env.STUDIO_DB, {
          orgId: authzOrgId,
          projectId: targetProject ?? null,
          actorType: author.type,
          actorId: author.id,
          action: `mcp.${name}`,
          status: toolResult.isError ? "refused" : "succeeded",
          details: {
            isError: toolResult.isError,
            ...(author.client ? { client: author.client } : {}),
          },
        });
      }

      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: toolResult.text }],
          ...(toolResult.isError ? { isError: true } : {}),
        },
      });
    }

    return Response.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${String(method)}` },
    });
  };

  app.post("/mcp", handleStudioMcp);
  app.post("/api/mcp", handleStudioMcp);
  // Story R55: one POST endpoint with no server-to-client stream or sessions, so GET (the SSE stream) and DELETE (session
  // end) are 405, as packages/mcp-server answers them; a client then carries on over POST alone. The caller is checked
  // first, so an unauthenticated request gets the same 401 as every other control-plane route.
  const mcpMethodNotAllowed = async (c: { req: { raw: Request }; env: StudioApiEnv }) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: resolved.error.message, data: resolved.error } }),
        { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="mcp"' } },
      );
    }
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  };
  app.get("/mcp", mcpMethodNotAllowed);
  app.delete("/mcp", mcpMethodNotAllowed);
  app.get("/api/mcp", mcpMethodNotAllowed);
  app.delete("/api/mcp", mcpMethodNotAllowed);

  app.get("/api/catalog", (c) => {
    const bricks: Record<string, (typeof catalog.bricks)[string]["manifest"]> = {};
    for (const [id, entry] of Object.entries(catalog.bricks)) {
      bricks[id] = entry.manifest;
    }
    return c.json(
      {
        catalogVersion: catalog.catalogVersion,
        bricks,
        nodePacks: catalog.nodePacks ?? {},
      },
      200,
    );
  });

  app.get("/api/templates", (c) => {
    const templates = listStarterTemplates();
    return c.json(
      {
        templates,
      },
      200,
    );
  });

  app.get("/api/projects", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    type ProjectListRow = {
      project_id: string;
      org_id: string;
      current_revision: number;
      semantic_hash: string;
      updated_at: string;
    };
    const toPayload = (rows: ProjectListRow[]) =>
      rows.map((row) => ({
        project: row.project_id,
        orgId: row.org_id,
        revision: Number(row.current_revision),
        semanticHash: row.semantic_hash,
        updatedAt: row.updated_at,
      }));

    // Story 16: an MCP token sees only the one project it is bound to; a client-sent org is ignored.
    if (resolved.caller.kind === "mcp_token") {
      const row = await db
        .prepare(
          "SELECT project_id, org_id, current_revision, semantic_hash, updated_at FROM projects WHERE project_id = ? AND org_id = ? LIMIT 1",
        )
        .bind(resolved.caller.projectId, resolved.caller.orgId)
        .first<ProjectListRow>();
      return c.json({ projects: toPayload(row ? [row] : []) }, 200);
    }

    // A session caller may select one of its own orgs; an org it is not a member of is refused.
    const requestedOrgId = c.req.query("orgId") ?? c.req.header("x-org-id");
    if (requestedOrgId) {
      const memberRow = await db
        .prepare("SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1")
        .bind(requestedOrgId, resolved.caller.userId)
        .first<{ role: StudioOrgRole }>();

      if (!memberRow) {
        return c.json(
          { error: { code: "FORBIDDEN_ORG", message: "Caller is not a member of this organization" } },
          403,
        );
      }

      const result = await db
        .prepare(
          "SELECT project_id, org_id, current_revision, semantic_hash, updated_at FROM projects WHERE org_id = ? ORDER BY project_id ASC",
        )
        .bind(requestedOrgId)
        .all<ProjectListRow>();
      return c.json({ projects: toPayload(result.results ?? []) }, 200);
    }

    const result = await db
      .prepare(
        `SELECT p.project_id, p.org_id, p.current_revision, p.semantic_hash, p.updated_at
         FROM projects p
         JOIN studio_org_members m ON m.org_id = p.org_id
         WHERE m.user_id = ?
         ORDER BY p.project_id ASC`,
      )
      .bind(resolved.caller.userId)
      .all<ProjectListRow>();

    return c.json({ projects: toPayload(result.results ?? []) }, 200);
  });

  app.post("/api/projects", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    let targetOrgId: string;
    if (resolved.caller.kind === "mcp_token") {
      // Forwarded to the org route, which refuses MCP tokens; a client-sent org is never used for a token.
      targetOrgId = resolved.caller.orgId;
    } else {
      // Story 16: a client-sent org only selects among the caller's own orgs (else 403); with none, the caller's only
      // or personal org.
      const selected =
        typeof rawBody.orgId === "string" && rawBody.orgId.trim()
          ? rawBody.orgId.trim()
          : (c.req.query("orgId") ?? c.req.header("x-org-id") ?? undefined);
      const chosen = await chooseSessionCreateOrg(db, resolved.caller.userId, selected);
      if (!chosen.ok) {
        return c.json({ error: chosen.error }, chosen.status);
      }
      targetOrgId = chosen.orgId;
    }

    const forwardHeaders = new Headers(c.req.raw.headers);
    forwardHeaders.set("content-type", "application/json");
    forwardHeaders.delete("x-org-id");
    forwardHeaders.delete("content-length");
    const forwardReq = new Request(
      new URL(`/api/orgs/${encodeURIComponent(targetOrgId)}/projects`, c.req.url).toString(),
      {
        method: "POST",
        headers: forwardHeaders,
        body: JSON.stringify(rawBody),
      },
    );
    return app.fetch(forwardReq, c.env);
  });

  app.get("/api/projects/:project", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const revisionQuery = c.req.query("revision");
    const stub = getBlueprintStub(c.env, project);
    const targetUrl = new URL("http://blueprint-do/state");
    targetUrl.searchParams.set("project", project);
    if (revisionQuery !== undefined) {
      targetUrl.searchParams.set("revision", revisionQuery);
    }

    const response = await stub.fetch(targetUrl.toString(), { method: "GET" });
    const body = (await response.json()) as Record<string, unknown>;

    if (
      response.status === 200 &&
      revisionQuery === undefined &&
      typeof body.readiness === "object" &&
      body.readiness !== null &&
      Array.isArray((body.readiness as { needs?: unknown[] }).needs)
    ) {
      const readinessObj = body.readiness as {
        ready: boolean;
        needs: Array<{ code: string; id: string; message: string; suggestedFix?: string }>;
        checks?: Record<string, boolean>;
      };
      if (
        readinessObj.needs.some(
          (n) => n.code === "UNBOUND_CONNECTION" || n.code === "UNBOUND_BRICK_SECRET",
        )
      ) {
        const db = c.env.STUDIO_DB;
        await ensureStudioD1Schema(db);
        const boundRefs = new Set<string>();
        const vaultRows = await db
          .prepare(
            "SELECT ref FROM studio_secret_vault WHERE project_id = ? AND status = 'valid'",
          )
          .bind(project)
          .all<{ ref: string }>();
        for (const r of vaultRows.results ?? []) {
          boundRefs.add(r.ref);
        }
        const connRows = await db
          .prepare(
            "SELECT ref FROM studio_connections_metadata WHERE project_id = ? AND status = 'connected'",
          )
          .bind(project)
          .all<{ ref: string }>();
        for (const r of connRows.results ?? []) {
          boundRefs.add(r.ref);
        }

        if (boundRefs.size > 0) {
          const stateObj = body.state as ProjectStatePayload["state"] | undefined;
          const nodeConnRefByNodeId = new Map<string, string>();
          for (const wf of stateObj?.workflows ?? []) {
            for (const node of wf.nodes ?? []) {
              const dataRec = (node.data ?? {}) as Record<string, unknown>;
              const connRef =
                typeof dataRec.connectionRef === "string"
                  ? dataRec.connectionRef.trim()
                  : typeof dataRec.connection === "string"
                    ? dataRec.connection.trim()
                    : "";
              if (connRef) {
                nodeConnRefByNodeId.set(node.id, connRef);
              }
            }
          }

          const filteredNeeds = readinessObj.needs.filter((need) => {
            if (need.code === "UNBOUND_CONNECTION") {
              const nodeConnRef = nodeConnRefByNodeId.get(need.id);
              if (boundRefs.has(need.id) || (nodeConnRef && boundRefs.has(nodeConnRef))) {
                return false;
              }
            }
            return true;
          });
          body.readiness = {
            ...readinessObj,
            ready: filteredNeeds.length === 0,
            needs: filteredNeeds,
          };
        }
      }
    }

    return c.json(body, response.status as 200 | 400 | 404);
  });

  app.get("/api/projects/:project/revisions", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const limit = c.req.query("limit");
    const beforeRevision = c.req.query("beforeRevision");
    const stub = getBlueprintStub(c.env, project);
    const targetUrl = new URL("http://blueprint-do/revisions");
    targetUrl.searchParams.set("project", project);
    if (limit !== undefined) {
      targetUrl.searchParams.set("limit", limit);
    }
    if (beforeRevision !== undefined) {
      targetUrl.searchParams.set("beforeRevision", beforeRevision);
    }

    const response = await stub.fetch(targetUrl.toString(), { method: "GET" });
    const body = (await response.json()) as Record<string, unknown>;
    return c.json(body, response.status as 200 | 400);
  });

  app.get("/api/projects/:project/revisions/:revision", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const revision = c.req.param("revision");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const stub = getBlueprintStub(c.env, project);
    const targetUrl = new URL("http://blueprint-do/state");
    targetUrl.searchParams.set("project", project);
    targetUrl.searchParams.set("revision", revision);

    const response = await stub.fetch(targetUrl.toString(), { method: "GET" });
    const body = (await response.json()) as Record<string, unknown>;
    return c.json(body, response.status as 200 | 400 | 404);
  });

  app.get("/api/projects/:project/diff", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const from = c.req.query("from");
    const to = c.req.query("to");
    const stub = getBlueprintStub(c.env, project);
    const targetUrl = new URL("http://blueprint-do/diff");
    targetUrl.searchParams.set("project", project);
    if (from !== undefined) {
      targetUrl.searchParams.set("from", from);
    }
    if (to !== undefined) {
      targetUrl.searchParams.set("to", to);
    }

    const response = await stub.fetch(targetUrl.toString(), { method: "GET" });
    const body = (await response.json()) as Record<string, unknown>;
    return c.json(body, response.status as 200 | 400 | 404);
  });

  app.post("/api/projects/:project/revert", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "INVALID_PROJECT_SLUG",
                path: "project",
                message: `Invalid project slug "${project}"`,
                suggestedFix: "Use a lowercase slug matching ^[a-z][a-z0-9-]{0,39}$",
              },
            ],
          },
        },
        422,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "mutate",
      c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.revert",
        status: "forbidden",
        details: { code: authz.error.code, role: authz.role },
      });
      return c.json({ error: authz.error }, authz.status);
    }

    let rawJson: unknown;
    try {
      rawJson = await c.req.json();
    } catch {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.revert",
        status: "validation_failed",
        details: { code: "INVALID_JSON" },
      });
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "INVALID_JSON",
                path: "body",
                message: "Request body must be valid JSON",
              },
            ],
          },
        },
        422,
      );
    }

    const parsedBody = RevertBodySchema.safeParse(rawJson);
    if (!parsedBody.success) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.revert",
        status: "validation_failed",
        details: { code: "INVALID_REQUEST" },
      });
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: parsedBody.error.issues.map((issue) => ({
              code: "INVALID_REQUEST",
              path: issue.path.join(".") || "body",
              message: issue.message,
              suggestedFix:
                "Provide { targetRevision: <number>, baseRevision?: <number>, author?: { type, id } }",
            })),
          },
        },
        422,
      );
    }

    // AD-V8: an MCP token's revert needs a Studio approval bound to this target and the current revision.
    const revertGate = await gateDestructiveAction(
      c,
      resolved.caller,
      {
        orgId: authz.orgId,
        projectId: project,
        action: "revert",
        target: String(parsedBody.data.targetRevision),
        blueprintRev: await currentBlueprintRevision(c.env, project),
        summary: await revertApprovalSummary(c.env, project, parsedBody.data.targetRevision),
      },
      parsedBody.data.approvalId,
    );
    if (revertGate) return revertGate;

    const effectiveAuthor = resolveEffectiveAuthor(resolved.caller);
    const stub = getBlueprintStub(c.env, project);
    const payload: RevertInput = {
      project,
      orgId: authz.orgId,
      callerRole: authz.role,
      targetRevision: parsedBody.data.targetRevision,
      ...(parsedBody.data.baseRevision !== undefined
        ? { baseRevision: parsedBody.data.baseRevision }
        : {}),
      author: effectiveAuthor,
    };

    const response = await stub.fetch("http://blueprint-do/revert", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studio-caller-role": authz.role,
      },
      body: JSON.stringify(payload),
    });

    const resultBody = (await response.json()) as Record<string, unknown>;
    await recordStudioAuditLog(c.env.STUDIO_DB, {
      orgId: authz.orgId,
      projectId: project,
      actorType: effectiveAuthor.type,
      actorId: effectiveAuthor.id,
      action: "project.revert",
      status:
        response.status === 200
          ? "succeeded"
          : response.status === 409
            ? "conflict"
            : "validation_failed",
      details: {
        httpStatus: response.status,
        targetRevision: parsedBody.data.targetRevision,
        revision: (resultBody.revision as number | undefined) ?? null,
      },
    });
    return c.json(resultBody, response.status as 200 | 403 | 409 | 422);
  });

  app.get("/api/projects/:project/export", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const revisionQuery = c.req.query("revision");
    const stub = getBlueprintStub(c.env, project);
    const targetUrl = new URL("http://blueprint-do/export");
    targetUrl.searchParams.set("project", project);
    if (revisionQuery !== undefined) {
      targetUrl.searchParams.set("revision", revisionQuery);
    }

    const response = await stub.fetch(targetUrl.toString(), { method: "GET" });
    const body = (await response.json()) as Record<string, unknown>;
    return c.json(body, response.status as 200 | 400 | 404 | 422);
  });

  app.post("/api/projects/:project/import", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "INVALID_PROJECT_SLUG",
                path: "project",
                message: `Invalid project slug "${project}"`,
                suggestedFix: "Use a lowercase slug matching ^[a-z][a-z0-9-]{0,39}$",
              },
            ],
          },
        },
        422,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "mutate",
      c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.import",
        status: "forbidden",
        details: { code: authz.error.code, role: authz.role },
      });
      return c.json({ error: authz.error }, authz.status);
    }

    let rawJson: unknown;
    try {
      rawJson = await c.req.json();
    } catch {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.import",
        status: "validation_failed",
        details: { code: "INVALID_JSON" },
      });
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "INVALID_JSON",
                path: "body",
                message: "Request body must be valid JSON",
              },
            ],
          },
        },
        422,
      );
    }

    // Accept either { bundle, author?, mode? } or a direct saas.blueprint.json object
    const normalizedInput =
      typeof rawJson === "object" && rawJson !== null && "bundle" in rawJson
        ? rawJson
        : { bundle: rawJson };

    const parsedBody = ImportBodySchema.safeParse(normalizedInput);
    if (!parsedBody.success || parsedBody.data.bundle === undefined) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.import",
        status: "validation_failed",
        details: { code: "INVALID_REQUEST" },
      });
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: parsedBody.success
              ? [
                  {
                    code: "INVALID_REQUEST",
                    path: "bundle",
                    message: "bundle is required",
                    suggestedFix:
                      "Provide { bundle: <saas.blueprint.json>, author?: { type, id }, mode?: 'create' | 'replace' }",
                  },
                ]
              : parsedBody.error.issues.map((issue) => ({
                  code: "INVALID_REQUEST",
                  path: issue.path.join(".") || "body",
                  message: issue.message,
                  suggestedFix:
                    "Provide { bundle: <saas.blueprint.json>, author?: { type, id }, mode?: 'create' | 'replace' }",
                })),
          },
        },
        422,
      );
    }

    // AD-V8: an import replaces the whole blueprint (money settings included), so an MCP token's import needs a Studio
    // approval bound to the revision and a sha256 of the imported bundle. A bundle that does not parse is left to the
    // import's own 422 and creates no request. Session users are not gated.
    if (resolved.caller.kind === "mcp_token") {
      const parsedBundle = parseBlueprintBundle(parsedBody.data.bundle, { targetProject: project, catalog });
      if (parsedBundle.ok) {
        const currentSnapshot = await createDurableObjectBlueprintClient(c.env.BLUEPRINT_DO).getProject(project);
        const importGate = await gateDestructiveAction(
          c,
          resolved.caller,
          {
            orgId: authz.orgId,
            projectId: project,
            action: "import",
            target: parsedBody.data.mode ?? "create",
            blueprintRev: currentSnapshot?.revision ?? 0,
            planFingerprint: await sha256Hex(JSON.stringify(parsedBody.data.bundle)),
            summary: {
              mode: parsedBody.data.mode ?? "create",
              fromRevision: currentSnapshot?.revision ?? 0,
              importedSemanticHash: parsedBundle.semanticHash,
              diff: summarizeSemanticDiff(
                computeSemanticDiff(currentSnapshot?.state ?? createEmptyBlueprint(project), parsedBundle.state),
              ),
            },
          },
          parsedBody.data.approvalId,
        );
        if (importGate) return importGate;
      }
    }

    const effectiveAuthor = resolveEffectiveAuthor(resolved.caller);
    const stub = getBlueprintStub(c.env, project);
    const payload: ImportBundleInput = {
      project,
      orgId: authz.orgId,
      callerRole: authz.role,
      bundle: parsedBody.data.bundle,
      author: effectiveAuthor,
      ...(parsedBody.data.mode !== undefined ? { mode: parsedBody.data.mode } : {}),
    };

    const response = await stub.fetch("http://blueprint-do/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studio-caller-role": authz.role,
      },
      body: JSON.stringify(payload),
    });

    const resultBody = (await response.json()) as Record<string, unknown>;
    if (response.status === 200) {
      const bundleRec =
        typeof parsedBody.data.bundle === "object" && parsedBody.data.bundle !== null
          ? (parsedBody.data.bundle as Record<string, unknown>)
          : {};
      const bundleMeta =
        typeof bundleRec.metadata === "object" && bundleRec.metadata !== null
          ? (bundleRec.metadata as Record<string, unknown>)
          : {};
      const sourceStr = typeof bundleMeta.source === "string" ? bundleMeta.source : "";
      const explicitTemplate = parsedBody.data.templateId
        ? getStarterTemplate(parsedBody.data.templateId)
        : undefined;
      const matchedTemplate =
        explicitTemplate ??
        getStarterTemplate(
          sourceStr.startsWith("presets/") ? sourceStr.slice("presets/".length) : sourceStr,
        ) ??
        (typeof bundleRec.project === "string" ? getStarterTemplate(bundleRec.project) : undefined);
      await recordStudioOnboardingEvent(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorId: effectiveAuthor.id,
        step: "project_created",
        templateId: matchedTemplate?.id ?? null,
        source: matchedTemplate ? "template" : "import",
        metadata: {
          templateId: matchedTemplate?.id ?? null,
          source: matchedTemplate ? "template" : "import",
          revision: (resultBody.revision as number | undefined) ?? null,
        },
        onlyOncePerProject: true,
      });
    }
    await recordStudioAuditLog(c.env.STUDIO_DB, {
      orgId: authz.orgId,
      projectId: project,
      actorType: effectiveAuthor.type,
      actorId: effectiveAuthor.id,
      action: "project.import",
      status:
        response.status === 200
          ? "succeeded"
          : response.status === 409
            ? "conflict"
            : "validation_failed",
      details: {
        httpStatus: response.status,
        revision: (resultBody.revision as number | undefined) ?? null,
      },
    });
    return c.json(resultBody, response.status as 200 | 403 | 409 | 422);
  });

  app.get("/api/projects/:project/snapshots", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const stub = getBlueprintStub(c.env, project);
    const targetUrl = new URL("http://blueprint-do/snapshots");
    targetUrl.searchParams.set("project", project);

    const response = await stub.fetch(targetUrl.toString(), { method: "GET" });
    const body = (await response.json()) as Record<string, unknown>;
    return c.json(body, 200);
  });

  app.get("/api/projects/:project/ws", async (c) => {
    // Story 0.14 (C8): the socket is cookie-authenticated, so a browser page on another origin must not open it.
    const wsOriginRefusal = checkWebSocketOrigin(c.req.raw, allowedOriginsFromEnv(c.env));
    if (wsOriginRefusal) return wsOriginRefusal;
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const sinceRevision = c.req.query("sinceRevision");
    if (sinceRevision !== undefined) {
      const parsedSince = Number(sinceRevision);
      if (!Number.isInteger(parsedSince) || parsedSince < 0) {
        return c.json(
          {
            error: {
              code: "INVALID_REVISION",
              message: "sinceRevision must be a non-negative integer",
            },
          },
          400,
        );
      }
    }

    const upgradeHeader = c.req.header("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return c.json(
        {
          error: {
            code: "UPGRADE_REQUIRED",
            message: "Expected Upgrade: websocket header",
          },
        },
        426,
      );
    }

    const stub = getBlueprintStub(c.env, project);
    const targetUrl = new URL("http://blueprint-do/ws");
    targetUrl.searchParams.set("project", project);
    if (sinceRevision !== undefined) {
      targetUrl.searchParams.set("sinceRevision", sinceRevision);
    }

    return stub.fetch(
      new Request(targetUrl.toString(), {
        method: "GET",
        headers: c.req.raw.headers,
      }),
    );
  });

  app.post("/api/projects/:project/ops", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "INVALID_PROJECT_SLUG",
                path: "project",
                message: `Invalid project slug "${project}"`,
                suggestedFix: "Use a lowercase slug matching ^[a-z][a-z0-9-]{0,39}$",
              },
            ],
          },
        },
        422,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "mutate",
      c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.ops",
        status: "forbidden",
        details: { code: authz.error.code, role: authz.role },
      });
      return c.json({ error: authz.error }, authz.status);
    }

    let rawJson: unknown;
    try {
      rawJson = await c.req.json();
    } catch {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.ops",
        status: "validation_failed",
        details: { code: "INVALID_JSON" },
      });
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "INVALID_JSON",
                path: "body",
                message: "Request body must be valid JSON",
              },
            ],
          },
        },
        422,
      );
    }

    const parsedBody = ApplyOpsBodySchema.safeParse(rawJson);
    if (!parsedBody.success) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.ops",
        status: "validation_failed",
        details: { code: "INVALID_REQUEST" },
      });
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: parsedBody.error.issues.map((issue) => ({
              code: "INVALID_REQUEST",
              path: issue.path.join(".") || "body",
              message: issue.message,
              suggestedFix: "Provide { author?: { type, id }, ops: [...] }",
            })),
          },
        },
        422,
      );
    }

    const effectiveAuthor = resolveEffectiveAuthor(resolved.caller);
    // AD-V8: an MCP token's edit is a proposal unless it asks to apply, and it may apply only preview-safe ops. The
    // decision keys on the verified caller kind; a Studio session user applies as before.
    const isAgentCaller = resolved.caller.kind === "mcp_token";
    const effectiveMode: "apply" | "propose" =
      parsedBody.data.mode ?? (isAgentCaller ? "propose" : "apply");
    if (isAgentCaller && effectiveMode === "apply") {
      // The current blueprint: a `set_metadata` with replace drops its pinned catalogVersion (a brick upgrade), and an
      // edit inside a workflow that holds a money node is a money change.
      const currentState =
        (await createDurableObjectBlueprintClient(c.env.BLUEPRINT_DO).getProject(project))?.state ?? null;
      const risk = classifyApplyRisk(
        parsedBody.data.ops.filter(
          (op): op is Record<string, unknown> => typeof op === "object" && op !== null,
        ),
        {
          liveProduction: await projectHasLiveProduction(c.env, authz.orgId, project),
          currentCatalogVersion: currentState?.metadata?.catalogVersion ?? null,
          currentState,
        },
      );
      if (risk.risky) {
        await recordStudioAuditLog(c.env.STUDIO_DB, {
          orgId: authz.orgId,
          projectId: project,
          actorType: effectiveAuthor.type,
          actorId: effectiveAuthor.id,
          action: "project.ops",
          status: "refused",
          details: {
            code: "PROPOSAL_REQUIRED",
            reasons: risk.reasons,
            ...(effectiveAuthor.client ? { client: effectiveAuthor.client } : {}),
          },
        });
        return c.json(proposalRequiredError(project, risk.reasons), 403);
      }
    }
    const stub = getBlueprintStub(c.env, project);
    const payload: ApplyOpsInput = {
      project,
      orgId: authz.orgId,
      callerRole: authz.role,
      ...(parsedBody.data.baseRevision !== undefined
        ? { baseRevision: parsedBody.data.baseRevision }
        : {}),
      author: effectiveAuthor,
      ...(parsedBody.data.summary !== undefined ? { summary: parsedBody.data.summary } : {}),
      ...(parsedBody.data.mode !== undefined || isAgentCaller ? { mode: effectiveMode } : {}),
      ...(parsedBody.data.proposalId !== undefined
        ? { proposalId: parsedBody.data.proposalId }
        : {}),
      ops: parsedBody.data.ops,
    };

    const response = await stub.fetch("http://blueprint-do/ops", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studio-caller-role": authz.role,
      },
      body: JSON.stringify(payload),
    });

    const resultBody = (await response.json()) as Record<string, unknown>;
    if (response.status === 200 && effectiveMode !== "propose") {
      await recordStudioOnboardingEvent(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorId: effectiveAuthor.id,
        step: "first_blueprint_edit",
        metadata: {
          revision: (resultBody.revision as number | undefined) ?? null,
          opCount: parsedBody.data.ops.length,
        },
        onlyOncePerProject: true,
      });
    }
    await recordStudioAuditLog(c.env.STUDIO_DB, {
      orgId: authz.orgId,
      projectId: project,
      actorType: effectiveAuthor.type,
      actorId: effectiveAuthor.id,
      action:
        effectiveMode === "propose"
          ? "project.proposal.create"
          : "project.ops",
      status:
        response.status === 200
          ? "succeeded"
          : response.status === 409
            ? "conflict"
            : "validation_failed",
      details: {
        httpStatus: response.status,
        revision: (resultBody.revision as number | undefined) ?? null,
        ...(resultBody.proposalId
          ? { proposalId: resultBody.proposalId as string }
          : {}),
        ...(effectiveAuthor.client ? { client: effectiveAuthor.client } : {}),
      },
    });
    return c.json(resultBody, response.status as 200 | 403 | 409 | 422);
  });

  app.get("/api/projects/:project/proposals", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const status = c.req.query("status");
    const proposalId = c.req.query("proposalId");
    const stub = getBlueprintStub(c.env, project);
    const targetUrl = new URL("http://blueprint-do/proposals");
    targetUrl.searchParams.set("project", project);
    if (status) {
      targetUrl.searchParams.set("status", status);
    }
    if (proposalId) {
      targetUrl.searchParams.set("proposalId", proposalId);
    }

    const response = await stub.fetch(targetUrl.toString(), { method: "GET" });
    const body = (await response.json()) as Record<string, unknown>;
    return c.json(body, response.status as 200 | 400 | 404);
  });

  app.post("/api/projects/:project/proposals", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "INVALID_PROJECT_SLUG",
                path: "project",
                message: `Invalid project slug "${project}"`,
                suggestedFix: "Use a lowercase slug matching ^[a-z][a-z0-9-]{0,39}$",
              },
            ],
          },
        },
        422,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "mutate",
      c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.proposal.create",
        status: "forbidden",
        details: { code: authz.error.code, role: authz.role },
      });
      return c.json({ error: authz.error }, authz.status);
    }

    let rawJson: unknown;
    try {
      rawJson = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "INVALID_JSON",
                path: "body",
                message: "Request body must be valid JSON",
              },
            ],
          },
        },
        422,
      );
    }

    const parsedBody = ApplyOpsBodySchema.safeParse(rawJson);
    if (!parsedBody.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: parsedBody.error.issues.map((issue) => ({
              code: "INVALID_REQUEST",
              path: issue.path.join(".") || "body",
              message: issue.message,
              suggestedFix: "Provide { baseRevision?: number, summary?: string, ops: [...] }",
            })),
          },
        },
        422,
      );
    }

    const effectiveAuthor = resolveEffectiveAuthor(resolved.caller);
    const stub = getBlueprintStub(c.env, project);
    const payload: ApplyOpsInput = {
      project,
      orgId: authz.orgId,
      callerRole: authz.role,
      ...(parsedBody.data.baseRevision !== undefined
        ? { baseRevision: parsedBody.data.baseRevision }
        : {}),
      author: effectiveAuthor,
      ...(parsedBody.data.summary !== undefined ? { summary: parsedBody.data.summary } : {}),
      ...(parsedBody.data.proposalId !== undefined
        ? { proposalId: parsedBody.data.proposalId }
        : {}),
      ops: parsedBody.data.ops,
      mode: "propose",
    };

    const response = await stub.fetch("http://blueprint-do/proposals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studio-caller-role": authz.role,
      },
      body: JSON.stringify(payload),
    });

    const resultBody = (await response.json()) as Record<string, unknown>;
    await recordStudioAuditLog(c.env.STUDIO_DB, {
      orgId: authz.orgId,
      projectId: project,
      actorType: effectiveAuthor.type,
      actorId: effectiveAuthor.id,
      action: "project.proposal.create",
      status:
        response.status === 200
          ? "succeeded"
          : response.status === 409
            ? "conflict"
            : "validation_failed",
      details: {
        httpStatus: response.status,
        proposalId: (resultBody.proposalId as string | undefined) ?? null,
        baseRevision: (resultBody.revision as number | undefined) ?? null,
        ...(effectiveAuthor.client ? { client: effectiveAuthor.client } : {}),
      },
    });
    return c.json(resultBody, response.status as 200 | 403 | 409 | 422);
  });

  app.post("/api/projects/:project/proposals/:proposalId/accept", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const proposalId = c.req.param("proposalId");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    // AD-V8: accepting is a human reviewer's action; an MCP token is refused whatever its scopes.
    const notReviewer = sessionReviewerRefusal(resolved.caller);
    if (notReviewer && resolved.caller.kind === "mcp_token") {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: resolved.caller.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.proposal.accept",
        status: "forbidden",
        details: { code: notReviewer.error.code, proposalId },
      });
      return c.json(notReviewer, 403);
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "mutate",
      c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.proposal.accept",
        status: "forbidden",
        details: { code: authz.error.code, role: authz.role, proposalId },
      });
      return c.json({ error: authz.error }, authz.status);
    }

    let rawJson: unknown = {};
    try {
      const text = await c.req.text();
      rawJson = text.trim() ? JSON.parse(text) : {};
    } catch {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "INVALID_JSON",
                path: "body",
                message: "Request body must be valid JSON",
              },
            ],
          },
        },
        422,
      );
    }

    const parsedBody = AcceptProposalBodySchema.safeParse(rawJson);
    if (!parsedBody.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: parsedBody.error.issues.map((issue) => ({
              code: "INVALID_REQUEST",
              path: issue.path.join(".") || "body",
              message: issue.message,
              suggestedFix: "Provide { opIds?: string[], author?: { type, id } }",
            })),
          },
        },
        422,
      );
    }

    const effectiveReviewer = resolveEffectiveAuthor(resolved.caller);
    const stub = getBlueprintStub(c.env, project);
    const payload: AcceptProposalInput = {
      project,
      orgId: authz.orgId,
      callerRole: authz.role,
      proposalId,
      ...(parsedBody.data.opIds !== undefined ? { opIds: parsedBody.data.opIds } : {}),
      reviewer: effectiveReviewer,
    };

    const response = await stub.fetch("http://blueprint-do/proposals/accept", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studio-caller-role": authz.role,
      },
      body: JSON.stringify(payload),
    });

    const resultBody = (await response.json()) as Record<string, unknown>;
    const proposalObj = resultBody.proposal as ProposalRecord | undefined;
    await recordStudioAuditLog(c.env.STUDIO_DB, {
      orgId: authz.orgId,
      projectId: project,
      actorType: effectiveReviewer.type,
      actorId: effectiveReviewer.id,
      action:
        proposalObj?.status === "partially_accepted"
          ? "project.proposal.partially_accept"
          : "project.proposal.accept",
      status:
        response.status === 200
          ? "succeeded"
          : response.status === 409
            ? "conflict"
            : "validation_failed",
      details: {
        httpStatus: response.status,
        proposalId,
        revision: (resultBody.revision as number | undefined) ?? null,
        proposalStatus: proposalObj?.status ?? null,
        acceptedOpIds: proposalObj?.acceptedOpIds ?? null,
        ...(effectiveReviewer.client ? { client: effectiveReviewer.client } : {}),
      },
    });
    return c.json(resultBody, response.status as 200 | 403 | 404 | 409 | 422);
  });

  app.post("/api/projects/:project/proposals/:proposalId/reject", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const proposalId = c.req.param("proposalId");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    // AD-V8: rejecting is a human reviewer's action; an MCP token is refused whatever its scopes.
    const notReviewer = sessionReviewerRefusal(resolved.caller);
    if (notReviewer && resolved.caller.kind === "mcp_token") {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: resolved.caller.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.proposal.reject",
        status: "forbidden",
        details: { code: notReviewer.error.code, proposalId },
      });
      return c.json(notReviewer, 403);
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "mutate",
      c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.proposal.reject",
        status: "forbidden",
        details: { code: authz.error.code, role: authz.role, proposalId },
      });
      return c.json({ error: authz.error }, authz.status);
    }

    let rawJson: unknown = {};
    try {
      const text = await c.req.text();
      rawJson = text.trim() ? JSON.parse(text) : {};
    } catch {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "INVALID_JSON",
                path: "body",
                message: "Request body must be valid JSON",
              },
            ],
          },
        },
        422,
      );
    }

    const parsedBody = RejectProposalBodySchema.safeParse(rawJson);
    if (!parsedBody.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: parsedBody.error.issues.map((issue) => ({
              code: "INVALID_REQUEST",
              path: issue.path.join(".") || "body",
              message: issue.message,
              suggestedFix: "Provide { reason?: string, author?: { type, id } }",
            })),
          },
        },
        422,
      );
    }

    const effectiveReviewer = resolveEffectiveAuthor(resolved.caller);
    const stub = getBlueprintStub(c.env, project);
    const payload: RejectProposalInput = {
      project,
      orgId: authz.orgId,
      callerRole: authz.role,
      proposalId,
      ...(parsedBody.data.reason !== undefined ? { reason: parsedBody.data.reason } : {}),
      reviewer: effectiveReviewer,
    };

    const response = await stub.fetch("http://blueprint-do/proposals/reject", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-studio-caller-role": authz.role,
      },
      body: JSON.stringify(payload),
    });

    const resultBody = (await response.json()) as Record<string, unknown>;
    await recordStudioAuditLog(c.env.STUDIO_DB, {
      orgId: authz.orgId,
      projectId: project,
      actorType: effectiveReviewer.type,
      actorId: effectiveReviewer.id,
      action: "project.proposal.reject",
      status: response.status === 200 ? "succeeded" : "conflict",
      details: {
        httpStatus: response.status,
        proposalId,
        reason: parsedBody.data.reason ?? null,
        ...(effectiveReviewer.client ? { client: effectiveReviewer.client } : {}),
      },
    });
    return c.json(resultBody, response.status as 200 | 403 | 404 | 409 | 422);
  });

  // AD-V8: approval requests for destructive actions an MCP agent asked for. Listing is a read; approving and
  // rejecting are a Studio session user's action with editor+ (builder, admin, owner). An MCP token is refused.
  app.get("/api/projects/:project/approvals", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }
    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        { error: { code: "INVALID_PROJECT_SLUG", message: `Invalid project slug "${project}"` } },
        400,
      );
    }
    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }
    const statusParam = c.req.query("status");
    const allowedStatuses: readonly ApprovalStatus[] = [
      "pending",
      "approved",
      "rejected",
      "consumed",
      "expired",
    ];
    const status = allowedStatuses.find((s) => s === statusParam);
    const approvals = await listApprovalRequests(c.env.STUDIO_DB, authz.orgId, project, status);
    return c.json({ project, approvals }, 200);
  });

  const handleApprovalDecision = (decision: "approved" | "rejected") =>
    async (c: { req: { raw: Request; param(name: string): string; header(name: string): string | undefined }; env: StudioApiEnv }) => {
      const auditAction = decision === "approved" ? "project.approval.approve" : "project.approval.reject";
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return Response.json({ error: resolved.error }, { status: 401 });
      }
      const project = c.req.param("project");
      const approvalId = c.req.param("approvalId");
      if (!PROJECT_SLUG_PATTERN.test(project)) {
        return Response.json(
          { error: { code: "INVALID_PROJECT_SLUG", message: `Invalid project slug "${project}"` } },
          { status: 400 },
        );
      }
      const caller = resolved.caller;
      const notReviewer = sessionReviewerRefusal(caller);
      if (notReviewer || caller.kind !== "session") {
        if (caller.kind === "mcp_token") {
          await recordStudioAuditLog(c.env.STUDIO_DB, {
            orgId: caller.orgId,
            projectId: project,
            actorType: caller.author.type,
            actorId: caller.author.id,
            action: auditAction,
            status: "forbidden",
            details: { code: "APPROVAL_SESSION_REQUIRED", approvalId },
          });
        }
        return Response.json(notReviewer, { status: 403 });
      }
      const authz = await authorizeProjectAccess(
        c.env.STUDIO_DB,
        caller,
        project,
        "mutate",
        c.req.header("x-org-id"),
      );
      if (!authz.ok) {
        await recordStudioAuditLog(c.env.STUDIO_DB, {
          orgId: authz.orgId,
          projectId: project,
          actorType: caller.author.type,
          actorId: caller.author.id,
          action: auditAction,
          status: "forbidden",
          details: { code: authz.error.code, role: authz.role, approvalId },
        });
        return Response.json({ error: authz.error }, { status: authz.status });
      }
      if (!canMutateProject(authz.role)) {
        return Response.json(
          { error: { code: "FORBIDDEN_ROLE", message: "Caller lacks mutate permission for project" } },
          { status: 403 },
        );
      }
      const decided = await decideApprovalRequest(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        approvalId,
        decision,
        userId: caller.userId,
      });
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: caller.author.type,
        actorId: caller.author.id,
        action: auditAction,
        status: decided.ok ? "succeeded" : "refused",
        details: {
          approvalId,
          ...(decided.ok
            ? { gatedAction: decided.approval.action, env: decided.approval.env }
            : { code: decided.body.error.code }),
        },
      });
      if (!decided.ok) {
        return Response.json(decided.body, { status: decided.status });
      }
      return Response.json({ project, approval: decided.approval }, { status: 200 });
    };

  app.post("/api/projects/:project/approvals/:approvalId/approve", handleApprovalDecision("approved"));
  app.post("/api/projects/:project/approvals/:approvalId/reject", handleApprovalDecision("rejected"));

  app.get("/api/projects/:project/activity", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const authorFilter = (c.req.query("author") ?? "all").trim();
    const typeFilter = (c.req.query("type") ?? "all").trim().toLowerCase();
    const windowFilter = (
      c.req.query("window") ??
      c.req.query("since") ??
      "all"
    ).trim();
    const limitRaw = c.req.query("limit");
    const limit =
      limitRaw !== undefined && Number.isFinite(Number(limitRaw))
        ? Math.max(1, Math.min(500, Math.floor(Number(limitRaw))))
        : 100;

    const normalizeIso = (raw: string | null | undefined): string => {
      if (!raw) return new Date(0).toISOString();
      const trimmed = raw.trim();
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
        return `${trimmed.replace(" ", "T")}Z`;
      }
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : trimmed;
    };

    const tokenClientsById = new Map<string, string>();
    try {
      const tokenRows = await db
        .prepare("SELECT id, client_name FROM studio_mcp_tokens WHERE org_id = ?")
        .bind(authz.orgId)
        .all<{ id: string; client_name: string }>();
      for (const r of tokenRows.results ?? []) {
        tokenClientsById.set(r.id, r.client_name);
        tokenClientsById.set(`agent:${r.id}`, r.client_name);
      }
    } catch {
      // Ignore if table not populated
    }

    const formatActivityActor = (input: {
      type: "human" | "agent";
      id: string;
      client?: string;
      onBehalfOf?: string;
    }) => {
      const rawId = input.id.trim();
      const isAgent =
        input.type === "agent" ||
        rawId.startsWith("agent:") ||
        rawId.startsWith("mcp_") ||
        tokenClientsById.has(rawId);
      const effectiveType: "human" | "agent" = isAgent ? "agent" : "human";
      const displayId =
        effectiveType === "agent"
          ? rawId.startsWith("agent:")
            ? rawId
            : `agent:${rawId}`
          : rawId.startsWith("user:")
            ? rawId
            : `user:${rawId}`;
      const inferredClient =
        input.client ??
        tokenClientsById.get(rawId) ??
        (effectiveType === "agent" && rawId.startsWith("agent:")
          ? rawId.slice("agent:".length)
          : undefined);
      return {
        type: effectiveType,
        id: rawId,
        displayId,
        ...(inferredClient ? { client: inferredClient } : {}),
        ...(input.onBehalfOf ? { onBehalfOf: input.onBehalfOf } : {}),
      };
    };

    interface ActivityFeedEvent {
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

    const events: ActivityFeedEvent[] = [];
    const stub = getBlueprintStub(c.env, project);

    // 1. Committed Revisions
    const revRes = await stub.fetch(
      `http://blueprint-do/revisions?project=${encodeURIComponent(project)}&limit=200`,
      { method: "GET" },
    );
    if (revRes.ok) {
      const revData = (await revRes.json()) as RevisionHistoryPayload;
      for (const rev of revData.revisions ?? []) {
        const actor = formatActivityActor(rev.author);
        events.push({
          id: `rev_${rev.revision}`,
          type: "revision",
          action: rev.summary.startsWith("Revert to r")
            ? "revision.reverted"
            : rev.summary.startsWith("Accept proposal ")
              ? "revision.proposal_merged"
              : "revision.committed",
          project,
          revision: rev.revision,
          timestamp: normalizeIso(rev.createdAt),
          actor,
          summary: `r${rev.revision}: ${rev.summary}`,
          details: {
            revision: rev.revision,
            parentRevision: rev.parentRevision,
            opCount: rev.opCount,
            semanticHash: rev.semanticHash,
          },
        });
      }
    }

    // 2. Proposals (created + reviewed)
    const propRes = await stub.fetch(
      `http://blueprint-do/proposals?project=${encodeURIComponent(project)}`,
      { method: "GET" },
    );
    if (propRes.ok) {
      const propData = (await propRes.json()) as {
        proposals?: ProposalRecord[];
      };
      for (const prop of propData.proposals ?? []) {
        const createdActor = formatActivityActor(prop.actor);
        events.push({
          id: `prop_created_${prop.proposalId}`,
          type: "proposal",
          action: "proposal.created",
          project,
          revision: prop.baseRev,
          proposalId: prop.proposalId,
          proposalStatus: prop.status,
          timestamp: normalizeIso(prop.createdAt),
          actor: createdActor,
          summary: `Proposed (${prop.ops.length} op${prop.ops.length === 1 ? "" : "s"} on r${prop.baseRev}): ${prop.summary}`,
          details: {
            proposalId: prop.proposalId,
            baseRev: prop.baseRev,
            opCount: prop.ops.length,
            status: prop.status,
          },
        });

        if (prop.status !== "pending" && prop.reviewedAt) {
          const reviewedActor = formatActivityActor(
            prop.reviewedBy ?? { type: "human", id: "user:reviewer" },
          );
          events.push({
            id: `prop_reviewed_${prop.proposalId}`,
            type: "proposal",
            action: `proposal.${prop.status}`,
            project,
            revision: prop.acceptedRev ?? prop.baseRev,
            proposalId: prop.proposalId,
            proposalStatus: prop.status,
            timestamp: normalizeIso(prop.reviewedAt),
            actor: reviewedActor,
            summary:
              prop.status === "accepted"
                ? `Accepted proposal ${prop.proposalId} -> r${prop.acceptedRev ?? prop.baseRev}`
                : prop.status === "partially_accepted"
                  ? `Partially accepted proposal ${prop.proposalId} (${prop.acceptedOpIds?.length ?? 0}/${prop.ops.length} ops) -> r${prop.acceptedRev ?? prop.baseRev}`
                  : `Rejected proposal ${prop.proposalId}${prop.rejectionReason ? `: ${prop.rejectionReason}` : ""}`,
            details: {
              proposalId: prop.proposalId,
              baseRev: prop.baseRev,
              status: prop.status,
              acceptedRev: prop.acceptedRev ?? null,
              acceptedOpIds: prop.acceptedOpIds ?? null,
              rejectionReason: prop.rejectionReason ?? null,
            },
          });
        }
      }
    }

    // 3. Audit Log Events (Builds, Connections/Secrets, Deploys, Workflow Runs)
    const auditRows = await db
      .prepare(
        `SELECT id, actor_type, actor_id, action, status, details_json, created_at
         FROM studio_audit_log
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT 300`,
      )
      .bind(project)
      .all<{
        id: string;
        actor_type: string;
        actor_id: string;
        action: string;
        status: string;
        details_json: string | null;
        created_at: string;
      }>();

    const runActorByRunId = new Map<
      string,
      ReturnType<typeof formatActivityActor>
    >();
    const seenBuildRevisions = new Set<number>();
    const seenDeployIds = new Set<string>();

    for (const row of auditRows.results ?? []) {
      let details: Record<string, unknown> = {};
      if (row.details_json) {
        try {
          details = JSON.parse(row.details_json) as Record<string, unknown>;
        } catch {
          details = {};
        }
      }
      const actor = formatActivityActor({
        type: row.actor_type === "agent" ? "agent" : "human",
        id: row.actor_id,
        ...(typeof details.client === "string" ? { client: details.client } : {}),
      });

      if (row.action === "workflow.run" && typeof details.runId === "string") {
        runActorByRunId.set(details.runId, actor);
      }

      if (row.action === "project.build" && row.status === "succeeded") {
        const revNum =
          typeof details.revision === "number" ? details.revision : null;
        if (revNum !== null) {
          seenBuildRevisions.add(revNum);
        }
        events.push({
          id: `build_${row.id}`,
          type: "build",
          action: "build.succeeded",
          project,
          revision: revNum,
          timestamp: normalizeIso(row.created_at),
          actor,
          summary: `Built project${revNum !== null ? ` at r${revNum}` : ""} (${String(details.buildHash ?? "").slice(0, 12)})`,
          details,
        });
      } else if (
        row.action.startsWith("secret.") ||
        row.action.startsWith("connection.") ||
        row.action.startsWith("token.")
      ) {
        const refLabel =
          typeof details.ref === "string"
            ? details.ref
            : typeof details.tokenRef === "string"
              ? details.tokenRef
              : "";
        events.push({
          id: `conn_${row.id}`,
          type: "connection",
          action: row.action,
          project,
          timestamp: normalizeIso(row.created_at),
          actor,
          summary: `${row.action}${refLabel ? ` (${refLabel})` : ""} [${row.status}]`,
          details: { ...details, status: row.status },
        });
      } else if (
        row.action === "deploy.apply" ||
        row.action === "deploy.rollback" ||
        row.action === "mcp.deploy_apply" ||
        row.action === "environment.deploy" ||
        row.action === "environment.promote" ||
        row.action === "environment.rollback"
      ) {
        const deployId =
          typeof details.deployId === "string" ? details.deployId : row.id;
        seenDeployIds.add(deployId);
        const envName =
          typeof details.env === "string"
            ? details.env
            : typeof details.envName === "string"
              ? details.envName
              : "preview";
        const revNum =
          typeof details.revision === "number" ? details.revision : null;
        events.push({
          id: `deploy_${deployId}`,
          type: "deploy",
          action: row.action,
          project,
          revision: revNum,
          timestamp: normalizeIso(row.created_at),
          actor,
          summary: `Deployed${revNum !== null ? ` r${revNum}` : ""} to ${envName} [${row.status}]`,
          details: { ...details, status: row.status },
        });
      }
    }

    // 4. Fallback Builds from studio_builds (e.g. if built via MCP tool or direct table insert)
    const buildRows = await db
      .prepare(
        `SELECT revision, build_hash, semantic_hash, file_count, byte_count, created_at
         FROM studio_builds
         WHERE project_id = ?
         ORDER BY revision DESC
         LIMIT 50`,
      )
      .bind(project)
      .all<{
        revision: number;
        build_hash: string;
        semantic_hash: string;
        file_count: number;
        byte_count: number;
        created_at: string;
      }>();
    for (const b of buildRows.results ?? []) {
      const revNum = Number(b.revision);
      if (seenBuildRevisions.has(revNum)) continue;
      events.push({
        id: `build_r${revNum}`,
        type: "build",
        action: "build.succeeded",
        project,
        revision: revNum,
        timestamp: normalizeIso(b.created_at),
        actor: formatActivityActor({ type: "human", id: "user:builder" }),
        summary: `Built project at r${revNum} (${b.build_hash.slice(0, 12)})`,
        details: {
          revision: revNum,
          buildHash: b.build_hash,
          semanticHash: b.semantic_hash,
          files: Number(b.file_count),
          bytes: Number(b.byte_count),
        },
      });
    }

    // 5. Deployments from deployments table
    const deployRows = await db
      .prepare(
        `SELECT deploy_id, env_name, revision, build_hash, action, status, worker_url, actor_id, created_at
         FROM deployments
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .bind(project)
      .all<{
        deploy_id: string;
        env_name: string;
        revision: number;
        build_hash: string;
        action: string;
        status: string;
        worker_url: string;
        actor_id: string;
        created_at: string;
      }>();
    for (const d of deployRows.results ?? []) {
      if (seenDeployIds.has(d.deploy_id)) continue;
      const actor = formatActivityActor({
        type:
          d.actor_id.startsWith("agent:") ||
          d.actor_id.startsWith("mcp_") ||
          tokenClientsById.has(d.actor_id)
            ? "agent"
            : "human",
        id: d.actor_id,
      });
      events.push({
        id: `deploy_${d.deploy_id}`,
        type: "deploy",
        action: `deploy.${d.action}`,
        project,
        revision: Number(d.revision),
        timestamp: normalizeIso(d.created_at),
        actor,
        summary: `Deployed r${d.revision} to ${d.env_name} (${d.action}) [${d.status}]`,
        details: {
          deployId: d.deploy_id,
          env: d.env_name,
          revision: Number(d.revision),
          buildHash: d.build_hash,
          action: d.action,
          status: d.status,
          workerUrl: d.worker_url,
        },
      });
    }

    // 6. Workflow Runs from telemetry store: this project's runs only (story 1.4)
    const runPage = await queryRunHistory(db, { projectId: project }, { limit: 100 });
    for (const r of runPage.runs) {
      const actor =
        runActorByRunId.get(r.runId) ??
        formatActivityActor({
          type: r.triggerType === "agent" ? "agent" : "human",
          id: r.triggerType === "agent" ? "agent:mcp" : "user:runner",
        });
      events.push({
        id: `run_${r.runId}`,
        type: "run",
        action: `run.${r.status}`,
        project,
        revision: r.revision,
        runId: r.runId,
        workflowId: r.workflowId,
        timestamp: normalizeIso(r.startedAt),
        actor,
        summary: `Workflow run ${r.workflowId} (${r.runId}) [${r.status}]`,
        details: {
          runId: r.runId,
          workflowId: r.workflowId,
          revision: r.revision,
          status: r.status,
          triggerType: r.triggerType,
          durationMs: r.durationMs,
          failedNodeId: r.failedNodeId,
        },
      });
    }

    // Apply filters
    let sinceMs: number | null = null;
    if (windowFilter && windowFilter !== "all") {
      const now = Date.now();
      if (windowFilter === "1h") sinceMs = now - 60 * 60 * 1000;
      else if (windowFilter === "24h") sinceMs = now - 24 * 60 * 60 * 1000;
      else if (windowFilter === "7d") sinceMs = now - 7 * 24 * 60 * 60 * 1000;
      else if (windowFilter === "30d") sinceMs = now - 30 * 24 * 60 * 60 * 1000;
      else {
        const parsedSince = Date.parse(windowFilter);
        if (Number.isFinite(parsedSince)) sinceMs = parsedSince;
      }
    }

    const allowedTypes =
      typeFilter && typeFilter !== "all"
        ? new Set(
            typeFilter
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          )
        : null;

    const filtered = events.filter((ev) => {
      if (allowedTypes && !allowedTypes.has(ev.type)) {
        return false;
      }
      if (sinceMs !== null) {
        const tsMs = Date.parse(ev.timestamp);
        if (Number.isFinite(tsMs) && tsMs < sinceMs) {
          return false;
        }
      }
      if (authorFilter && authorFilter.toLowerCase() !== "all") {
        const lower = authorFilter.toLowerCase();
        if (lower === "humans" || lower === "human") {
          return ev.actor.type === "human";
        }
        if (lower === "agents" || lower === "agent") {
          return ev.actor.type === "agent";
        }
        const matchId =
          ev.actor.id.toLowerCase() === lower ||
          ev.actor.displayId.toLowerCase() === lower ||
          (ev.actor.client && ev.actor.client.toLowerCase() === lower);
        return Boolean(matchId);
      }
      return true;
    });

    filtered.sort((a, b) => {
      const ta = Date.parse(a.timestamp);
      const tb = Date.parse(b.timestamp);
      if (Number.isFinite(ta) && Number.isFinite(tb) && tb !== ta) {
        return tb - ta;
      }
      return b.timestamp.localeCompare(a.timestamp);
    });

    return c.json(
      {
        project,
        events: filtered.slice(0, limit),
        total: filtered.length,
        filters: {
          author: authorFilter,
          type: typeFilter,
          window: windowFilter,
        },
      },
      200,
    );
  });

  app.post("/api/projects/:project/build", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "mutate",
      c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.build",
        status: "forbidden",
        details: { code: authz.error.code, role: authz.role },
      });
      return c.json({ error: authz.error }, authz.status);
    }

    const stub = getBlueprintStub(c.env, project);
    const stateRes = await stub.fetch(
      `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
      { method: "GET" },
    );
    const current = (await stateRes.json()) as ProjectStatePayload;

    const buildBlockingNeeds = current.readiness.needs.filter(
      (n) => n.code !== "UNBOUND_BRICK_SECRET" && n.code !== "UNBOUND_CONNECTION",
    );

    if (current.revision === 0 || buildBlockingNeeds.length > 0) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.build",
        status: "validation_failed",
        details: { code: "PROJECT_NOT_READY", revision: current.revision },
      });
      return c.json(
        {
          error: {
            code: "PROJECT_NOT_READY",
            message: "Project is not ready to build",
            issues: current.readiness.needs,
          },
        },
        422,
      );
    }

    const assembled = assemble(toAssemblerBlueprint(current.state), catalog);
    if (!assembled.ok) {
      await recordStudioAuditLog(c.env.STUDIO_DB, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.build",
        status: "validation_failed",
        details: { code: "ASSEMBLE_FAILED", errors: assembled.errors },
      });
      return c.json(
        {
          error: {
            code: "ASSEMBLE_FAILED",
            message: assembled.errors.join("; "),
            issues: assembled.errors.map((err) => ({
              code: "ASSEMBLE_ERROR",
              path: "project",
              message: err,
            })),
          },
        },
        422,
      );
    }

    const buildHash = await computeBuildHash(assembled.files);
    const fileCount = Object.keys(assembled.files).length;
    const byteCount = Object.values(assembled.files).reduce(
      (sum, text) => sum + new TextEncoder().encode(text).length,
      0,
    );

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);
    await db
      .prepare(
        `INSERT INTO studio_builds (project_id, revision, build_hash, semantic_hash, file_count, byte_count, files_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(project_id, revision) DO UPDATE SET
           build_hash = excluded.build_hash,
           semantic_hash = excluded.semantic_hash,
           file_count = excluded.file_count,
           byte_count = excluded.byte_count,
           files_json = excluded.files_json,
           created_at = excluded.created_at`,
      )
      .bind(
        project,
        current.revision,
        buildHash,
        current.semanticHash,
        fileCount,
        byteCount,
        JSON.stringify(assembled.files),
      )
      .run();

    await recordStudioAuditLog(db, {
      orgId: authz.orgId,
      projectId: project,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "project.build",
      status: "succeeded",
      details: { revision: current.revision, buildHash, files: fileCount, bytes: byteCount },
    });

    return c.json(
      {
        project,
        revision: current.revision,
        buildHash,
        semanticHash: current.semanticHash,
        files: fileCount,
        bytes: byteCount,
      },
      200,
    );
  });

  app.get("/api/projects/:project/build", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const studioRow = await db
      .prepare(
        `SELECT revision, build_hash, semantic_hash, file_count, byte_count, files_json
         FROM studio_builds
         WHERE project_id = ?
         ORDER BY revision DESC
         LIMIT 1`,
      )
      .bind(project)
      .first<{
        revision: number;
        build_hash: string;
        semantic_hash: string;
        file_count: number;
        byte_count: number;
        files_json: string;
      }>();

    if (studioRow) {
      return c.json(
        {
          project,
          revision: Number(studioRow.revision),
          buildHash: studioRow.build_hash,
          semanticHash: studioRow.semantic_hash,
          files: Number(studioRow.file_count),
          bytes: Number(studioRow.byte_count),
          emittedFiles: JSON.parse(studioRow.files_json) as Record<string, string>,
        },
        200,
      );
    }

    const mcpBuildRow = await db
      .prepare(
        `SELECT project_hash, file_count, byte_count
         FROM mcp_builds
         WHERE project = ?
         LIMIT 1`,
      )
      .bind(project)
      .first<{
        project_hash: string;
        file_count: number;
        byte_count: number;
      }>();

    if (mcpBuildRow) {
      const mcpFilesRows = await db
        .prepare(`SELECT path, content FROM mcp_files WHERE project = ? ORDER BY path ASC`)
        .bind(project)
        .all<{ path: string; content: string }>();
      const emittedFiles: Record<string, string> = {};
      for (const r of mcpFilesRows.results ?? []) {
        emittedFiles[r.path] = r.content;
      }
      return c.json(
        {
          project,
          buildHash: mcpBuildRow.project_hash,
          files: Number(mcpBuildRow.file_count),
          bytes: Number(mcpBuildRow.byte_count),
          emittedFiles,
        },
        200,
      );
    }

    return c.json(
      {
        error: {
          code: "BUILD_NOT_FOUND",
          message: `No build found for project "${project}"`,
        },
      },
      404,
    );
  });

  // --- Studio Connections & AES-GCM Sealed Secret Vault Routes ---

  app.get("/api/projects/:project/secrets", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const stub = getBlueprintStub(c.env, project);
    const stateRes = await stub.fetch(
      `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
      { method: "GET" },
    );
    const current = (await stateRes.json()) as ProjectStatePayload;
    const secretRefs = current.state?.secretRefs ?? [];

    const usedByMap = new Map<
      string,
      Array<{
        targetKind: "brick" | "node" | "connection";
        targetId: string;
        secretName: string;
      }>
    >();
    for (const sr of secretRefs) {
      const list = usedByMap.get(sr.ref) ?? [];
      list.push({
        targetKind: sr.targetKind === "connection" ? "node" : sr.targetKind,
        targetId: sr.targetId,
        secretName: sr.secretName,
      });
      usedByMap.set(sr.ref, list);
    }

    for (const wf of current.state?.workflows ?? []) {
      for (const node of wf.nodes ?? []) {
        const dataRec = (node.data as Record<string, unknown> | undefined) ?? {};
        const nodeConnRef =
          typeof dataRec.connectionRef === "string" && dataRec.connectionRef.trim()
            ? dataRec.connectionRef.trim()
            : typeof dataRec.connection === "string" && dataRec.connection.trim()
              ? dataRec.connection.trim()
              : null;
        if (nodeConnRef) {
          const list = usedByMap.get(nodeConnRef) ?? [];
          if (!list.some((item) => item.targetId === node.id)) {
            list.push({
              targetKind: "node",
              targetId: node.id,
              secretName: "connection",
            });
            usedByMap.set(nodeConnRef, list);
          }
        }
      }
    }

    const envDb = c.env.DB ?? db;
    await ensureConnectionsTable(envDb);

    const livePxRows = await envDb
      .prepare(
        `SELECT ref, app, auth_type, label, scopes_json, key_hint, status, expires_at, last_checked_at, updated_at
         FROM px_connections
         WHERE project_id = ?`,
      )
      .bind(project)
      .all<{
        ref: string;
        app: string;
        auth_type: string;
        label: string;
        scopes_json: string;
        key_hint: string;
        status: string;
        expires_at: string | null;
        last_checked_at: string | null;
        updated_at: string;
      }>();
    const livePxByRef = new Map<
      string,
      {
        app: string;
        auth_type: string;
        label: string;
        scopes_json: string;
        key_hint: string;
        status: string;
        expires_at: string | null;
        last_checked_at: string | null;
        updated_at: string;
      }
    >();
    for (const r of livePxRows.results ?? []) {
      livePxByRef.set(r.ref, r);
    }

    const metaRows = await db
      .prepare(
        `SELECT id, org_id, project_id, ref, app, auth_type, label, env_scope, scopes_json, status, expires_at, last_checked_at, key_hint, created_by, updated_at
         FROM studio_connections_metadata
         WHERE project_id = ?
         ORDER BY ref ASC`,
      )
      .bind(project)
      .all<{
        id: string;
        org_id: string;
        project_id: string;
        ref: string;
        app: string;
        auth_type: string;
        label: string;
        env_scope: string;
        scopes_json: string;
        status: string;
        expires_at: string | null;
        last_checked_at: string | null;
        key_hint: string;
        created_by: string;
        updated_at: string;
      }>();

    const vaultRows = await db
      .prepare(
        `SELECT id, org_id, project_id, ref, kind, label, app_or_brick, env_scope, key_hint, status, created_by, updated_at
         FROM studio_secret_vault
         WHERE project_id = ?
         ORDER BY ref ASC`,
      )
      .bind(project)
      .all<{
        id: string;
        org_id: string;
        project_id: string;
        ref: string;
        kind: "api_key" | "webhook_secret" | "brick_secret";
        label: string;
        app_or_brick: string;
        env_scope: string;
        key_hint: string;
        status: string;
        created_by: string;
        updated_at: string;
      }>();

    const rows = vaultRows.results ?? [];
    const seenRefs = new Set<string>();
    const secrets: Array<Record<string, unknown>> = rows.map((row) => {
      seenRefs.add(row.ref);
      const livePx = livePxByRef.get(row.ref);
      const effectiveStatus =
        livePx?.status === "expired" || livePx?.status === "revoked" || livePx?.status === "error"
          ? livePx.status
          : row.status;
      return {
        id: row.id,
        ref: row.ref,
        kind: row.kind,
        authType: livePx?.auth_type ?? (row.kind === "webhook_secret" ? "webhook-secret" : "api-key"),
        label: row.label,
        appOrBrick: row.app_or_brick,
        envScope: row.env_scope,
        keyHint: row.key_hint,
        status: effectiveStatus as "valid" | "connected" | "expired" | "revoked" | "error" | "missing",
        expiresAt: livePx?.expires_at ?? null,
        lastCheckedAt: livePx?.last_checked_at ?? null,
        usedBy: usedByMap.get(row.ref) ?? [],
        createdBy: row.created_by,
        updatedAt: livePx?.updated_at ?? row.updated_at,
      };
    });

    for (const meta of metaRows.results ?? []) {
      if (seenRefs.has(meta.ref)) continue;
      seenRefs.add(meta.ref);
      const livePx = livePxByRef.get(meta.ref);
      let scopes: string[] = [];
      try {
        const parsed = JSON.parse(livePx?.scopes_json ?? meta.scopes_json);
        if (Array.isArray(parsed)) scopes = parsed.map(String);
      } catch {
        scopes = [];
      }
      const rawStatus = livePx?.status ?? meta.status;
      secrets.push({
        id: meta.id,
        ref: meta.ref,
        kind: meta.auth_type === "webhook-secret" || meta.auth_type === "webhookSecret" ? "webhook_secret" : "api_key",
        authType: meta.auth_type,
        scopes,
        label: meta.label,
        appOrBrick: meta.app,
        envScope: meta.env_scope,
        keyHint: livePx?.key_hint ?? meta.key_hint,
        status: (rawStatus === "connected" ? "valid" : rawStatus) as
          | "valid"
          | "connected"
          | "expired"
          | "revoked"
          | "error"
          | "missing",
        connectionStatus: rawStatus,
        expiresAt: livePx?.expires_at ?? meta.expires_at ?? null,
        lastCheckedAt: livePx?.last_checked_at ?? meta.last_checked_at ?? null,
        usedBy: usedByMap.get(meta.ref) ?? [],
        createdBy: meta.created_by,
        updatedAt: livePx?.updated_at ?? meta.updated_at,
      });
    }

    for (const [ref, usedBy] of usedByMap.entries()) {
      if (!seenRefs.has(ref)) {
        const firstTarget = usedBy[0];
        secrets.push({
          id: `missing:${project}:${ref}`,
          ref,
          kind:
            firstTarget?.targetKind === "brick" ? "brick_secret" : "api_key",
          label: firstTarget?.secretName ?? ref,
          appOrBrick: firstTarget?.targetId ?? "unbound",
          envScope: "all",
          keyHint: "••••(missing)",
          status: "missing",
          usedBy,
          createdBy: "blueprint",
          updatedAt: new Date(0).toISOString(),
        });
      }
    }

    const reqRows = await db
      .prepare(
        `SELECT request_id, app, reason, scopes_json, suggested_ref, connect_url, status, requested_by, created_at
         FROM studio_connection_requests
         WHERE project_id = ? AND status = 'pending_user_consent'
         ORDER BY created_at DESC`,
      )
      .bind(project)
      .all<{
        request_id: string;
        app: string;
        reason: string;
        scopes_json: string;
        suggested_ref: string;
        connect_url: string;
        status: string;
        requested_by: string;
        created_at: string;
      }>();
    const connectionRequests = (reqRows.results ?? []).map((r) => {
      let scopes: string[] = [];
      try {
        const parsed = JSON.parse(r.scopes_json);
        if (Array.isArray(parsed)) scopes = parsed.map(String);
      } catch {
        scopes = [];
      }
      return {
        requestId: r.request_id,
        app: r.app,
        reason: r.reason,
        scopes,
        suggestedRef: r.suggested_ref,
        connectUrl: r.connect_url,
        status: r.status === "pending_user_consent" ? "pending" : r.status,
        rawStatus: r.status,
        requestedBy: r.requested_by,
        createdAt: r.created_at,
      };
    });

    return c.json({ project, secrets, connectionRequests }, 200);
  });

  app.post("/api/projects/:project/secrets", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    // AD-S12: MCP agent callers are strictly forbidden from writing or rotating secret values
    const isAgentCaller =
      resolved.caller.kind === "mcp_token" ||
      resolved.caller.author.type === "agent" ||
      Boolean(c.req.header("x-mcp-client-name")) ||
      Boolean(c.req.header("x-mcp-client-id"));

    if (isAgentCaller) {
      const fallbackOrgId =
        resolved.caller.kind === "mcp_token"
          ? resolved.caller.orgId
          : // Story 16: the audit row goes to the project's own org when the caller is a member of it, never to a
            // client-named org.
            ((
              await db
                .prepare(
                  `SELECT p.org_id FROM projects p
                   JOIN studio_org_members m ON m.org_id = p.org_id AND m.user_id = ?
                   WHERE p.project_id = ? LIMIT 1`,
                )
                .bind(resolved.caller.userId, project)
                .first<{ org_id: string }>()
            )?.org_id ?? "unassigned");
      await recordStudioAuditLog(db, {
        orgId: fallbackOrgId,
        projectId: project,
        actorType: "agent",
        actorId: resolved.caller.author.id,
        action: "secret.upsert",
        status: "forbidden",
        details: {
          code: "FORBIDDEN_AGENT_SECRET_ACCESS",
          message: "MCP agents are forbidden from reading or writing secret values",
        },
      });
      return c.json(
        {
          error: {
            code: "FORBIDDEN_AGENT_SECRET_ACCESS",
            message:
              "MCP agent tokens are forbidden from writing or rotating secret values. Use the human Studio Connections Center.",
          },
        },
        403,
      );
    }

    let rawJson: unknown;
    try {
      rawJson = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: "INVALID_JSON",
            message: "Request body must be valid JSON",
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      (rawJson && typeof rawJson === "object" && typeof (rawJson as { orgId?: unknown }).orgId === "string"
        ? (rawJson as { orgId: string }).orgId
        : undefined) ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "secret.upsert",
        status: "forbidden",
        details: { code: authz.error.code, role: authz.role },
      });
      return c.json({ error: authz.error }, authz.status);
    }

    const parsedBody = UpsertSecretBodySchema.safeParse(rawJson);
    if (!parsedBody.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: parsedBody.error.issues.map((i) => i.message).join("; "),
            issues: parsedBody.error.issues,
          },
        },
        422,
      );
    }

    const refCheck = isValidSecretRefHandle(parsedBody.data.ref);
    if (!refCheck.ok) {
      return c.json(
        {
          error: {
            code: "INVALID_SECRET_REF",
            message:
              refCheck.reason ??
              `Secret ref "${parsedBody.data.ref}" must start with sec_ and match ^sec_[a-z0-9_]{3,60}$`,
          },
        },
        422,
      );
    }

    const activeSandboxForSecret = await db
      .prepare(
        "SELECT sandbox_id FROM studio_sandboxes WHERE project_id = ? AND status = 'active' LIMIT 1",
      )
      .bind(project)
      .first<{ sandbox_id: string }>();

    if (
      activeSandboxForSecret ||
      parsedBody.data.envScope === "sandbox"
    ) {
      const livePaymentCheck = isLivePaymentCredential(
        `${parsedBody.data.ref}:${parsedBody.data.label}:${parsedBody.data.appOrBrick}`,
        parsedBody.data.value,
      );
      if (livePaymentCheck.blocked) {
        return c.json(
          {
            error: {
              code: "SANDBOX_LIVE_PAYMENTS_BLOCKED",
              message:
                livePaymentCheck.reason ??
                "Live payment credentials (sk_live_*, Cashfree production keys) are blocked in hosted sandboxes.",
            },
          },
          403,
        );
      }
    }

    const vaultKeySecret = c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
    const connKeySecret = c.env.PX_CONN_KEY ?? vaultKeySecret;
    const sealed = await encryptSecretValue(parsedBody.data.value, vaultKeySecret);
    const nowIso = new Date().toISOString();
    const secretId = `vault_${project}_${parsedBody.data.ref}`;

    await db
      .prepare(
        `INSERT INTO studio_secret_vault (
           id, org_id, project_id, ref, kind, label, app_or_brick, env_scope,
           ciphertext_b64, iv_b64, key_hint, status, created_by, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?)
         ON CONFLICT(project_id, ref) DO UPDATE SET
           kind = excluded.kind,
           label = excluded.label,
           app_or_brick = excluded.app_or_brick,
           env_scope = excluded.env_scope,
           ciphertext_b64 = excluded.ciphertext_b64,
           iv_b64 = excluded.iv_b64,
           key_hint = excluded.key_hint,
           status = 'valid',
           updated_at = excluded.updated_at`,
      )
      .bind(
        secretId,
        authz.orgId,
        project,
        parsedBody.data.ref,
        parsedBody.data.kind,
        parsedBody.data.label,
        parsedBody.data.appOrBrick,
        parsedBody.data.envScope,
        sealed.ciphertextB64,
        sealed.ivB64,
        sealed.keyHint,
        resolved.caller.userId,
        nowIso,
      )
      .run();

    // Also seal into Case A px_connections (environment D1) and record non-secret metadata in studio_connections_metadata
    const envDb = c.env.DB ?? db;
    const authType =
      parsedBody.data.kind === "webhook_secret" ? "webhook-secret" : "api-key";
    await assertConnectionRefFree(envDb, parsedBody.data.ref, project);
    await upsertSealedConnection(
      envDb,
      {
        ref: parsedBody.data.ref,
        projectId: project,
        envName: parsedBody.data.envScope === "production" ? "production" : "preview",
        workspaceId: "default",
        app: parsedBody.data.appOrBrick,
        authType,
        label: parsedBody.data.label,
        scopes: [],
        credentials:
          parsedBody.data.kind === "webhook_secret"
            ? { webhookSecret: parsedBody.data.value, signingSecret: parsedBody.data.value }
            : { apiKey: parsedBody.data.value, token: parsedBody.data.value },
        status: "connected",
        lastCheckedAt: nowIso,
      },
      connKeySecret,
    );
    await assertConnectionRefOwned(envDb, parsedBody.data.ref, project);

    await db
      .prepare(
        `INSERT INTO studio_connections_metadata (
           id, org_id, project_id, ref, app, auth_type, label, env_scope, scopes_json,
           status, expires_at, last_checked_at, key_hint, created_by, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 'connected', NULL, ?, ?, ?, ?)
         ON CONFLICT(project_id, ref) DO UPDATE SET
           app = excluded.app,
           auth_type = excluded.auth_type,
           label = excluded.label,
           env_scope = excluded.env_scope,
           status = 'connected',
           last_checked_at = excluded.last_checked_at,
           key_hint = excluded.key_hint,
           updated_at = excluded.updated_at`,
      )
      .bind(
        `conn_${project}_${parsedBody.data.ref}`,
        authz.orgId,
        project,
        parsedBody.data.ref,
        parsedBody.data.appOrBrick,
        authType,
        parsedBody.data.label,
        parsedBody.data.envScope,
        nowIso,
        sealed.keyHint,
        resolved.caller.userId,
        nowIso,
      )
      .run();

    await db
      .prepare(
        "UPDATE studio_connection_requests SET status = 'connected', resolved_at = ? WHERE project_id = ? AND app = ? AND status = 'pending_user_consent'",
      )
      .bind(nowIso, project, parsedBody.data.appOrBrick)
      .run();

    await recordStudioAuditLog(db, {
      orgId: authz.orgId,
      projectId: project,
      actorType: "human",
      actorId: resolved.caller.userId,
      action: "secret.upsert",
      status: "succeeded",
      details: {
        ref: parsedBody.data.ref,
        kind: parsedBody.data.kind,
        label: parsedBody.data.label,
        appOrBrick: parsedBody.data.appOrBrick,
        keyHint: sealed.keyHint,
      },
    });

    let bindResponsePayload: Record<string, unknown> | null = null;
    if (parsedBody.data.bindTarget) {
      const target = parsedBody.data.bindTarget;
      const stub = getBlueprintStub(c.env, project);
      const bindOp = {
        opId: `bind-sec-${parsedBody.data.ref}-${target.targetId}-${Date.now()}`,
        type: "bind_secret_ref",
        targetKind: target.targetKind === "node" ? "connection" : target.targetKind,
        targetId: target.targetId,
        secretName: target.secretName,
        ref: parsedBody.data.ref,
      };
      const doRes = await stub.fetch("http://blueprint-do/ops", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-studio-caller-role": authz.role,
        },
        body: JSON.stringify({
          project,
          orgId: authz.orgId,
          callerRole: authz.role,
          author: resolved.caller.author,
          summary: `Bind secret ${parsedBody.data.ref} to ${target.targetKind} ${target.targetId}`,
          ops: [bindOp],
        }),
      });
      if (doRes.status === 200) {
        bindResponsePayload = (await doRes.json()) as Record<string, unknown>;
      }
    }

    return c.json(
      {
        secret: {
          id: secretId,
          ref: parsedBody.data.ref,
          kind: parsedBody.data.kind,
          label: parsedBody.data.label,
          appOrBrick: parsedBody.data.appOrBrick,
          envScope: parsedBody.data.envScope,
          keyHint: sealed.keyHint,
          status: "valid",
          updatedAt: nowIso,
        },
        ...(bindResponsePayload
          ? {
              revision: bindResponsePayload.revision,
              state: bindResponsePayload.state,
              semanticHash: bindResponsePayload.semanticHash,
              readiness: bindResponsePayload.readiness,
            }
          : {}),
      },
      200,
    );
  });

  app.delete("/api/projects/:project/secrets/:ref", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const ref = c.req.param("ref");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const isAgentCaller =
      resolved.caller.kind === "mcp_token" ||
      resolved.caller.author.type === "agent" ||
      Boolean(c.req.header("x-mcp-client-name")) ||
      Boolean(c.req.header("x-mcp-client-id"));

    if (isAgentCaller) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN_AGENT_SECRET_ACCESS",
            message: "MCP agent tokens are forbidden from deleting secrets.",
          },
        },
        403,
      );
    }

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    // Story 16: only this project's own secret can be deleted; a ref this project does not hold is 404, never a success.
    const envDbForDelete = c.env.DB ?? db;
    await ensureConnectionsTable(envDbForDelete);
    const heldVault = await db
      .prepare("SELECT ref FROM studio_secret_vault WHERE project_id = ? AND ref = ? LIMIT 1")
      .bind(project, ref)
      .first<{ ref: string }>();
    const heldMeta = await db
      .prepare("SELECT ref FROM studio_connections_metadata WHERE project_id = ? AND ref = ? LIMIT 1")
      .bind(project, ref)
      .first<{ ref: string }>();
    const heldLive = await envDbForDelete
      .prepare("SELECT ref FROM px_connections WHERE ref = ? AND project_id = ? LIMIT 1")
      .bind(ref, project)
      .first<{ ref: string }>();
    if (!heldVault && !heldMeta && !heldLive) {
      return c.json(
        { error: { code: "SECRET_NOT_FOUND", message: `Secret "${ref}" not found in this project` } },
        404,
      );
    }

    await db
      .prepare("DELETE FROM studio_secret_vault WHERE project_id = ? AND ref = ?")
      .bind(project, ref)
      .run();
    await db
      .prepare("DELETE FROM studio_connections_metadata WHERE project_id = ? AND ref = ?")
      .bind(project, ref)
      .run();
    await envDbForDelete
      .prepare("DELETE FROM px_connections WHERE ref = ? AND project_id = ?")
      .bind(ref, project)
      .run();

    await recordStudioAuditLog(db, {
      orgId: authz.orgId,
      projectId: project,
      actorType: "human",
      actorId: resolved.caller.userId,
      action: "secret.delete",
      status: "succeeded",
      details: { ref },
    });

    let unbindResponsePayload: Record<string, unknown> | null = null;
    if (c.req.query("unbind") === "true") {
      const stub = getBlueprintStub(c.env, project);
      const stateRes = await stub.fetch(
        `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
        { method: "GET" },
      );
      const current = (await stateRes.json()) as ProjectStatePayload;
      const matchingRefs = (current.state?.secretRefs ?? []).filter(
        (sr) => sr.ref === ref,
      );
      if (matchingRefs.length > 0) {
        const ops = matchingRefs.map((sr, idx) => ({
          opId: `unbind-sec-${ref}-${idx}-${Date.now()}`,
          type: "unbind_secret_ref",
          targetKind: sr.targetKind,
          targetId: sr.targetId,
          secretName: sr.secretName,
        }));
        const doRes = await stub.fetch("http://blueprint-do/ops", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-studio-caller-role": authz.role,
          },
          body: JSON.stringify({
            project,
            orgId: authz.orgId,
            callerRole: authz.role,
            author: resolved.caller.author,
            summary: `Unbind deleted secret ${ref}`,
            ops,
          }),
        });
        if (doRes.status === 200) {
          unbindResponsePayload = (await doRes.json()) as Record<string, unknown>;
        }
      }
    }

    return c.json(
      {
        deleted: true,
        ref,
        ...(unbindResponsePayload
          ? {
              revision: unbindResponsePayload.revision,
              state: unbindResponsePayload.state,
              semanticHash: unbindResponsePayload.semanticHash,
              readiness: unbindResponsePayload.readiness,
            }
          : {}),
      },
      200,
    );
  });

  // --- Case A Connections Center (OAuth2 PKCE S256, API Key, Bearer, Webhook Secret) Routes (AD-S17) ---

  const handleOAuthStart = async (c: import("hono").Context<{ Bindings: StudioApiEnv }>) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const isAgentCaller =
      resolved.caller.kind === "mcp_token" ||
      resolved.caller.author.type === "agent" ||
      Boolean(c.req.header("x-mcp-client-name")) ||
      Boolean(c.req.header("x-mcp-client-id"));
    if (isAgentCaller) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN_AGENT_SECRET_ACCESS",
            message:
              "MCP agents are forbidden from initiating OAuth2 flows directly. Use request_connection to ask the user to authorize in Studio.",
          },
        },
        403,
      );
    }

    let rawBody: Record<string, unknown> = {};
    if (c.req.method === "POST") {
      try {
        const parsed = await c.req.json();
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          rawBody = parsed as Record<string, unknown>;
        }
      } catch {
        rawBody = {};
      }
    }

    const appSlug = (c.req.param("app") ?? "").trim().toLowerCase();
    const project =
      (c.req.param("project") ??
        c.req.query("project") ??
        (typeof rawBody.project === "string" ? rawBody.project : "default")).trim();
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      (typeof rawBody.orgId === "string" ? rawBody.orgId : undefined) ??
        c.req.query("orgId") ??
        c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const oauthCfg = getIntegrationOAuthConfig(appSlug);
    const requestedScopesRaw =
      c.req.query("scopes") ??
      (Array.isArray(rawBody.scopes) ? (rawBody.scopes as string[]).join(",") : undefined);
    const scopes = requestedScopesRaw
      ? requestedScopesRaw
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : oauthCfg.defaultScopes;

    const rawRef =
      c.req.query("ref") ??
      (typeof rawBody.ref === "string" && rawBody.ref.trim()
        ? rawBody.ref.trim()
        : `sec_${appSlug.replace(/[^a-z0-9_]/g, "_")}_oauth`);
    const label =
      c.req.query("label") ??
      (typeof rawBody.label === "string" && rawBody.label.trim()
        ? rawBody.label.trim()
        : `${appSlug} OAuth2 Connection`);
    const envScope =
      c.req.query("env") ??
      (typeof rawBody.envScope === "string" && rawBody.envScope.trim()
        ? rawBody.envScope.trim()
        : "preview");
    // Story 1.17: trimmed; `default` (the project-shared bucket) or one of the project's own preview workspaces.
    const connectionWorkspace = await resolveConnectionWorkspace({
      studioDb: db,
      projectDataDb: ((await resolveProjectDataStore(db, project, authz.orgId, "preview"))?.d1 ?? null),
      project,
      requested: c.req.query("workspaceId") ?? rawBody.workspaceId,
    });
    if (!connectionWorkspace.ok) return connectionWorkspace.response;
    const workspaceId = connectionWorkspace.workspaceId;

    const origin = (() => {
      try {
        return new URL(c.req.url).origin;
      } catch {
        return "http://localhost:8787";
      }
    })();
    const redirectUri =
      c.req.query("redirectUri") ??
      (typeof rawBody.redirectUri === "string" && rawBody.redirectUri.trim()
        ? rawBody.redirectUri.trim()
        : `${origin}/api/connections/oauth/${encodeURIComponent(appSlug)}/callback`);

    const state = `st_${generateRandomBase64Url(24)}`;
    const codeVerifier = generateRandomBase64Url(32);
    const codeChallenge = await computePkceS256Challenge(codeVerifier);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAtIso = new Date(nowMs + 10 * 60 * 1000).toISOString();

    await db
      .prepare(
        `INSERT INTO studio_oauth_states (
           state, org_id, project_id, app, ref, label, env_scope, workspace_id,
           code_verifier, code_challenge, scopes_json, redirect_uri, created_by, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        state,
        authz.orgId,
        project,
        appSlug,
        rawRef,
        label,
        envScope,
        workspaceId,
        codeVerifier,
        codeChallenge,
        JSON.stringify(scopes),
        redirectUri,
        resolved.caller.userId,
        expiresAtIso,
        nowIso,
      )
      .run();

    const authUrl = new URL(oauthCfg.authorizationUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", `px_studio_${appSlug}`);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    if (scopes.length > 0) {
      authUrl.searchParams.set("scope", scopes.join(" "));
    }
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    if (c.req.query("redirect") === "true") {
      return c.redirect(authUrl.toString(), 302);
    }

    return c.json(
      {
        ok: true,
        app: appSlug,
        project,
        ref: rawRef,
        connectionRef: rawRef,
        state,
        codeChallenge,
        codeChallengeMethod: "S256",
        authorizeUrl: authUrl.toString(),
        authorizationUrl: authUrl.toString(),
        redirectUri,
        scopes,
      },
      200,
    );
  };

  app.get("/api/connections/oauth/:app/start", handleOAuthStart);
  app.post("/api/projects/:project/connections/oauth/:app/start", handleOAuthStart);

  const handleOAuthCallback = async (c: import("hono").Context<{ Bindings: StudioApiEnv }>) => {
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const isAgentCaller =
      Boolean(c.req.header("x-mcp-client-name")) ||
      Boolean(c.req.header("x-mcp-client-id"));
    if (isAgentCaller) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN_AGENT_SECRET_ACCESS",
            message: "MCP agents are forbidden from invoking OAuth2 callbacks.",
          },
        },
        403,
      );
    }

    let rawBody: Record<string, unknown> = {};
    if (c.req.method === "POST") {
      try {
        const parsed = await c.req.json();
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          rawBody = parsed as Record<string, unknown>;
        }
      } catch {
        rawBody = {};
      }
    }

    const appSlug = (c.req.param("app") ?? "").trim().toLowerCase();
    const stateParam = (
      c.req.query("state") ??
      (typeof rawBody.state === "string" ? rawBody.state : "")
    ).trim();
    const codeParam = (
      c.req.query("code") ??
      (typeof rawBody.code === "string" ? rawBody.code : "")
    ).trim();

    if (!stateParam || !codeParam) {
      return c.json(
        {
          error: {
            code: "OAUTH_STATE_MISMATCH",
            message: "Missing required OAuth2 code or CSRF state parameter",
          },
        },
        400,
      );
    }

    const stateRow = await db
      .prepare(
        `SELECT state, org_id, project_id, app, ref, label, env_scope, workspace_id,
                code_verifier, code_challenge, scopes_json, redirect_uri, created_by, expires_at
         FROM studio_oauth_states
         WHERE state = ?
         LIMIT 1`,
      )
      .bind(stateParam)
      .first<{
        state: string;
        org_id: string;
        project_id: string;
        app: string;
        ref: string;
        label: string;
        env_scope: string;
        workspace_id: string;
        code_verifier: string;
        code_challenge: string;
        scopes_json: string;
        redirect_uri: string;
        created_by: string;
        expires_at: string;
      }>();

    if (!stateRow || stateRow.app !== appSlug) {
      return c.json(
        {
          error: {
            code: "OAUTH_STATE_MISMATCH",
            message: "Invalid or mismatched OAuth2 CSRF state parameter",
          },
        },
        400,
      );
    }

    // Consume single-use state immediately
    await db
      .prepare("DELETE FROM studio_oauth_states WHERE state = ?")
      .bind(stateParam)
      .run();

    const expMs = Date.parse(stateRow.expires_at);
    if (Number.isFinite(expMs) && expMs < Date.now()) {
      return c.json(
        {
          error: {
            code: "OAUTH_STATE_EXPIRED",
            message: "OAuth2 CSRF state parameter has expired",
          },
        },
        400,
      );
    }

    const oauthCfg = getIntegrationOAuthConfig(appSlug);
    const oauthFetcher = c.env.__OAUTH_FETCHER ?? globalThis.fetch;

    let tokenPayload: Record<string, unknown>;
    if (!c.env.__OAUTH_FETCHER && codeParam.startsWith("studio_local_code_")) {
      tokenPayload = {
        access_token: `oauth_tok_${appSlug}_${codeParam.slice("studio_local_code_".length)}`,
        refresh_token: `oauth_ref_${appSlug}_${codeParam.slice("studio_local_code_".length)}`,
        expires_in: 3600,
        token_type: "Bearer",
      };
    } else {
      const form = new URLSearchParams();
      form.set("grant_type", "authorization_code");
      form.set("code", codeParam);
      form.set("redirect_uri", stateRow.redirect_uri);
      form.set("code_verifier", stateRow.code_verifier);
      form.set("client_id", `px_studio_${appSlug}`);

      const tokenRes = await oauthFetcher(oauthCfg.tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form.toString(),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text().catch(() => "");
        return c.json(
          {
            error: {
              code: "OAUTH_TOKEN_EXCHANGE_FAILED",
              message: `OAuth2 token exchange failed with HTTP ${tokenRes.status}`,
              details: errBody.slice(0, 200),
            },
          },
          400,
        );
      }
      tokenPayload = (await tokenRes.json()) as Record<string, unknown>;
    }

    const accessToken =
      typeof tokenPayload.access_token === "string"
        ? tokenPayload.access_token
        : typeof tokenPayload.accessToken === "string"
          ? tokenPayload.accessToken
          : "";
    const refreshToken =
      typeof tokenPayload.refresh_token === "string"
        ? tokenPayload.refresh_token
        : typeof tokenPayload.refreshToken === "string"
          ? tokenPayload.refreshToken
          : undefined;
    const expiresInSec =
      typeof tokenPayload.expires_in === "number" && Number.isFinite(tokenPayload.expires_in)
        ? tokenPayload.expires_in
        : 3600;
    const tokenType =
      typeof tokenPayload.token_type === "string" ? tokenPayload.token_type : "Bearer";

    if (!accessToken) {
      return c.json(
        {
          error: {
            code: "OAUTH_TOKEN_MISSING",
            message: "OAuth2 token response did not include an access_token",
          },
        },
        400,
      );
    }

    let scopes: string[] = [];
    try {
      const parsed = JSON.parse(stateRow.scopes_json);
      if (Array.isArray(parsed)) scopes = parsed.map(String);
    } catch {
      scopes = [];
    }
    if (typeof tokenPayload.scope === "string" && tokenPayload.scope.trim()) {
      scopes = tokenPayload.scope
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAtIso = new Date(nowMs + expiresInSec * 1000).toISOString();
    const connKeySecret =
      c.env.PX_CONN_KEY ?? c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
    const envDb = c.env.DB ?? db;

    await assertConnectionRefFree(envDb, stateRow.ref, stateRow.project_id);
    const sealedMeta = await upsertSealedConnection(
      envDb,
      {
        ref: stateRow.ref,
        projectId: stateRow.project_id,
        envName: stateRow.env_scope === "production" ? "production" : "preview",
        workspaceId: stateRow.workspace_id,
        app: appSlug,
        authType: "oauth2",
        label: stateRow.label,
        scopes,
        credentials: {
          accessToken,
          ...(refreshToken ? { refreshToken } : {}),
          tokenType,
          expiresAt: expiresAtIso,
          scopes,
        },
        status: "connected",
        expiresAt: expiresAtIso,
        lastCheckedAt: nowIso,
      },
      connKeySecret,
    );
    await assertConnectionRefOwned(envDb, stateRow.ref, stateRow.project_id);

    const connId = `conn_${stateRow.project_id}_${stateRow.ref}`;
    await db
      .prepare(
        `INSERT INTO studio_connections_metadata (
           id, org_id, project_id, ref, app, auth_type, label, env_scope, scopes_json,
           status, expires_at, last_checked_at, key_hint, created_by, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'oauth2', ?, ?, ?, 'connected', ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, ref) DO UPDATE SET
           app = excluded.app,
           auth_type = 'oauth2',
           label = excluded.label,
           env_scope = excluded.env_scope,
           scopes_json = excluded.scopes_json,
           status = 'connected',
           expires_at = excluded.expires_at,
           last_checked_at = excluded.last_checked_at,
           key_hint = excluded.key_hint,
           updated_at = excluded.updated_at`,
      )
      .bind(
        connId,
        stateRow.org_id,
        stateRow.project_id,
        stateRow.ref,
        appSlug,
        stateRow.label,
        stateRow.env_scope,
        JSON.stringify(scopes),
        expiresAtIso,
        nowIso,
        sealedMeta.keyHint,
        stateRow.created_by,
        nowIso,
      )
      .run();

    await db
      .prepare(
        "UPDATE studio_connection_requests SET status = 'connected', resolved_at = ? WHERE project_id = ? AND app = ? AND status = 'pending_user_consent'",
      )
      .bind(nowIso, stateRow.project_id, appSlug)
      .run();

    await recordStudioAuditLog(db, {
      orgId: stateRow.org_id,
      projectId: stateRow.project_id,
      actorType: "human",
      actorId: stateRow.created_by,
      action: "connection.oauth_connected",
      status: "succeeded",
      details: {
        ref: stateRow.ref,
        app: appSlug,
        authType: "oauth2",
        scopes,
        expiresAt: expiresAtIso,
        keyHint: sealedMeta.keyHint,
      },
    });

    return c.json(
      {
        ok: true,
        connection: {
          id: connId,
          ref: stateRow.ref,
          project: stateRow.project_id,
          app: appSlug,
          authType: "oauth2",
          label: stateRow.label,
          envScope: stateRow.env_scope,
          scopes,
          status: "connected",
          expiresAt: expiresAtIso,
          lastCheckedAt: nowIso,
          keyHint: sealedMeta.keyHint,
          updatedAt: nowIso,
        },
      },
      200,
    );
  };

  app.get("/api/connections/oauth/:app/callback", handleOAuthCallback);
  app.post("/api/connections/oauth/:app/callback", handleOAuthCallback);

  app.get("/api/projects/:project/connections", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const stub = getBlueprintStub(c.env, project);
    const stateRes = await stub.fetch(
      `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
      { method: "GET" },
    );
    const current = (await stateRes.json()) as ProjectStatePayload;
    const secretRefs = current.state?.secretRefs ?? [];

    const usedByMap = new Map<
      string,
      Array<{
        targetKind: "brick" | "node" | "connection";
        targetId: string;
        secretName: string;
      }>
    >();
    for (const sr of secretRefs) {
      const list = usedByMap.get(sr.ref) ?? [];
      list.push({
        targetKind: sr.targetKind === "connection" ? "node" : sr.targetKind,
        targetId: sr.targetId,
        secretName: sr.secretName,
      });
      usedByMap.set(sr.ref, list);
    }
    for (const wf of current.state?.workflows ?? []) {
      for (const node of wf.nodes ?? []) {
        const dataRec = (node.data as Record<string, unknown> | undefined) ?? {};
        const nodeConnRef =
          typeof dataRec.connectionRef === "string" && dataRec.connectionRef.trim()
            ? dataRec.connectionRef.trim()
            : typeof dataRec.connection === "string" && dataRec.connection.trim()
              ? dataRec.connection.trim()
              : null;
        if (nodeConnRef) {
          const list = usedByMap.get(nodeConnRef) ?? [];
          if (!list.some((item) => item.targetId === node.id)) {
            list.push({
              targetKind: "node",
              targetId: node.id,
              secretName: "connection",
            });
            usedByMap.set(nodeConnRef, list);
          }
        }
      }
    }

    const envDb = c.env.DB ?? db;
    await ensureConnectionsTable(envDb);
    const livePxRows = await envDb
      .prepare(
        `SELECT ref, app, auth_type, label, scopes_json, key_hint, status, expires_at, last_checked_at, updated_at
         FROM px_connections
         WHERE project_id = ?
         ORDER BY ref ASC`,
      )
      .bind(project)
      .all<{
        ref: string;
        app: string;
        auth_type: string;
        label: string;
        scopes_json: string;
        key_hint: string;
        status: string;
        expires_at: string | null;
        last_checked_at: string | null;
        updated_at: string;
      }>();
    const livePxByRef = new Map<string, (typeof livePxRows.results)[number]>();
    for (const r of livePxRows.results ?? []) {
      livePxByRef.set(r.ref, r);
    }

    const metaRows = await db
      .prepare(
        `SELECT id, org_id, project_id, ref, app, auth_type, label, env_scope, scopes_json, status, expires_at, last_checked_at, key_hint, created_by, updated_at
         FROM studio_connections_metadata
         WHERE project_id = ?
         ORDER BY ref ASC`,
      )
      .bind(project)
      .all<{
        id: string;
        org_id: string;
        project_id: string;
        ref: string;
        app: string;
        auth_type: string;
        label: string;
        env_scope: string;
        scopes_json: string;
        status: string;
        expires_at: string | null;
        last_checked_at: string | null;
        key_hint: string;
        created_by: string;
        updated_at: string;
      }>();

    const seenRefs = new Set<string>();
    const connections: Array<Record<string, unknown>> = [];

    for (const meta of metaRows.results ?? []) {
      seenRefs.add(meta.ref);
      const livePx = livePxByRef.get(meta.ref);
      let scopes: string[] = [];
      try {
        const parsed = JSON.parse(livePx?.scopes_json ?? meta.scopes_json);
        if (Array.isArray(parsed)) scopes = parsed.map(String);
      } catch {
        scopes = [];
      }
      connections.push({
        id: meta.id,
        ref: meta.ref,
        app: meta.app,
        authType: meta.auth_type,
        label: meta.label,
        envScope: meta.env_scope,
        scopes,
        status: (livePx?.status ?? meta.status) as "connected" | "expired" | "revoked" | "error",
        expiresAt: livePx?.expires_at ?? meta.expires_at ?? null,
        lastCheckedAt: livePx?.last_checked_at ?? meta.last_checked_at ?? null,
        keyHint: livePx?.key_hint ?? meta.key_hint,
        usedBy: usedByMap.get(meta.ref) ?? [],
        createdBy: meta.created_by,
        updatedAt: livePx?.updated_at ?? meta.updated_at,
      });
    }

    for (const [ref, livePx] of livePxByRef.entries()) {
      if (seenRefs.has(ref) || !livePx) continue;
      seenRefs.add(ref);
      let scopes: string[] = [];
      try {
        const parsed = JSON.parse(livePx.scopes_json);
        if (Array.isArray(parsed)) scopes = parsed.map(String);
      } catch {
        scopes = [];
      }
      connections.push({
        id: `conn_${project}_${ref}`,
        ref,
        app: livePx.app,
        authType: livePx.auth_type,
        label: livePx.label || ref,
        envScope: "preview",
        scopes,
        status: livePx.status as "connected" | "expired" | "revoked" | "error",
        expiresAt: livePx.expires_at ?? null,
        lastCheckedAt: livePx.last_checked_at ?? null,
        keyHint: livePx.key_hint,
        usedBy: usedByMap.get(ref) ?? [],
        createdBy: "system",
        updatedAt: livePx.updated_at,
      });
    }

    const reqRows = await db
      .prepare(
        `SELECT request_id, app, reason, scopes_json, suggested_ref, connect_url, status, requested_by, created_at
         FROM studio_connection_requests
         WHERE project_id = ? AND status = 'pending_user_consent'
         ORDER BY created_at DESC`,
      )
      .bind(project)
      .all<{
        request_id: string;
        app: string;
        reason: string;
        scopes_json: string;
        suggested_ref: string;
        connect_url: string;
        status: string;
        requested_by: string;
        created_at: string;
      }>();
    const connectionRequests = (reqRows.results ?? []).map((r) => {
      let scopes: string[] = [];
      try {
        const parsed = JSON.parse(r.scopes_json);
        if (Array.isArray(parsed)) scopes = parsed.map(String);
      } catch {
        scopes = [];
      }
      return {
        requestId: r.request_id,
        app: r.app,
        reason: r.reason,
        scopes,
        suggestedRef: r.suggested_ref,
        connectUrl: r.connect_url,
        status: r.status === "pending_user_consent" ? "pending" : r.status,
        rawStatus: r.status,
        requestedBy: r.requested_by,
        createdAt: r.created_at,
      };
    });

    return c.json({ project, connections, connectionRequests }, 200);
  });

  app.post("/api/projects/:project/connections", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const isAgentCaller =
      resolved.caller.kind === "mcp_token" ||
      resolved.caller.author.type === "agent" ||
      Boolean(c.req.header("x-mcp-client-name")) ||
      Boolean(c.req.header("x-mcp-client-id"));
    if (isAgentCaller) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN_AGENT_SECRET_ACCESS",
            message:
              "MCP agent tokens are forbidden from writing or rotating connection credentials. Use request_connection instead.",
          },
        },
        403,
      );
    }

    let rawJson: unknown;
    try {
      rawJson = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: "INVALID_JSON",
            message: "Request body must be valid JSON",
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      (rawJson && typeof rawJson === "object" && typeof (rawJson as { orgId?: unknown }).orgId === "string"
        ? (rawJson as { orgId: string }).orgId
        : undefined) ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const parsedBody = UpsertConnectionBodySchema.safeParse(rawJson);
    if (!parsedBody.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: parsedBody.error.issues.map((i) => i.message).join("; "),
            issues: parsedBody.error.issues,
          },
        },
        422,
      );
    }

    const data = parsedBody.data;
    // Story 1.17: the stored workspace is trimmed and must be `default` or one of the project's own preview workspaces.
    const connectionWorkspace = await resolveConnectionWorkspace({
      studioDb: db,
      projectDataDb: ((await resolveProjectDataStore(db, project, authz.orgId, "preview"))?.d1 ?? null),
      project,
      requested: data.workspaceId,
    });
    if (!connectionWorkspace.ok) return connectionWorkspace.response;
    const rawValue = data.value ?? "";
    const credentialsPayload: Record<string, unknown> = data.credentials
      ? { ...data.credentials }
      : data.authType === "webhookSecret" || data.authType === "webhook-secret"
        ? { webhookSecret: rawValue, signingSecret: rawValue, secret: rawValue }
        : data.authType === "bearer" || data.authType === "oauth2"
          ? { accessToken: rawValue, token: rawValue }
          : { apiKey: rawValue, token: rawValue };

    const activeSandboxForConn = await db
      .prepare(
        "SELECT sandbox_id FROM studio_sandboxes WHERE project_id = ? AND status = 'active' LIMIT 1",
      )
      .bind(project)
      .first<{ sandbox_id: string }>();

    if (activeSandboxForConn || data.envScope === "sandbox") {
      const checkPayloadStr = `${rawValue} ${JSON.stringify(credentialsPayload)}`;
      const livePaymentCheck = isLivePaymentCredential(
        `${data.ref}:${data.app}:${data.label ?? ""}`,
        checkPayloadStr,
      );
      if (livePaymentCheck.blocked) {
        return c.json(
          {
            error: {
              code: "SANDBOX_LIVE_PAYMENTS_BLOCKED",
              message:
                livePaymentCheck.reason ??
                "Live payment credentials (sk_live_*, Cashfree production keys) are blocked in hosted sandboxes.",
            },
          },
          403,
        );
      }
    }

    const nowIso = new Date().toISOString();
    const connKeySecret =
      c.env.PX_CONN_KEY ?? c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
    const envDb = c.env.DB ?? db;
    const label = data.label ?? `${data.app} (${data.authType})`;

    await assertConnectionRefFree(envDb, data.ref, project);
    const sealedMeta = await upsertSealedConnection(
      envDb,
      {
        ref: data.ref,
        projectId: project,
        envName: data.envScope === "production" ? "production" : "preview",
        workspaceId: connectionWorkspace.workspaceId,
        app: data.app,
        authType: data.authType,
        label,
        scopes: data.scopes,
        credentials: credentialsPayload,
        status: "connected",
        expiresAt: data.expiresAt ?? null,
        lastCheckedAt: nowIso,
      },
      connKeySecret,
    );
    await assertConnectionRefOwned(envDb, data.ref, project);

    const connId = `conn_${project}_${data.ref}`;
    await db
      .prepare(
        `INSERT INTO studio_connections_metadata (
           id, org_id, project_id, ref, app, auth_type, label, env_scope, scopes_json,
           status, expires_at, last_checked_at, key_hint, created_by, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, ref) DO UPDATE SET
           app = excluded.app,
           auth_type = excluded.auth_type,
           label = excluded.label,
           env_scope = excluded.env_scope,
           scopes_json = excluded.scopes_json,
           status = 'connected',
           expires_at = excluded.expires_at,
           last_checked_at = excluded.last_checked_at,
           key_hint = excluded.key_hint,
           updated_at = excluded.updated_at`,
      )
      .bind(
        connId,
        authz.orgId,
        project,
        data.ref,
        data.app,
        data.authType,
        label,
        data.envScope,
        JSON.stringify(data.scopes),
        data.expiresAt ?? null,
        nowIso,
        sealedMeta.keyHint,
        resolved.caller.userId,
        nowIso,
      )
      .run();

    await db
      .prepare(
        "UPDATE studio_connection_requests SET status = 'connected', resolved_at = ? WHERE project_id = ? AND app = ? AND status = 'pending_user_consent'",
      )
      .bind(nowIso, project, data.app)
      .run();

    await recordStudioAuditLog(db, {
      orgId: authz.orgId,
      projectId: project,
      actorType: "human",
      actorId: resolved.caller.userId,
      action: "connection.upsert",
      status: "succeeded",
      details: {
        ref: data.ref,
        app: data.app,
        authType: data.authType,
        keyHint: sealedMeta.keyHint,
      },
    });

    let bindResponsePayload: Record<string, unknown> | null = null;
    if (data.bindTarget) {
      const target = data.bindTarget;
      const stub = getBlueprintStub(c.env, project);
      const bindOp = {
        opId: `bind-conn-${data.ref}-${target.targetId}-${Date.now()}`,
        type: "bind_secret_ref",
        targetKind: target.targetKind === "node" ? "connection" : target.targetKind,
        targetId: target.targetId,
        secretName: target.secretName,
        ref: data.ref,
      };
      const doRes = await stub.fetch("http://blueprint-do/ops", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-studio-caller-role": authz.role,
        },
        body: JSON.stringify({
          project,
          orgId: authz.orgId,
          callerRole: authz.role,
          author: resolved.caller.author,
          summary: `Bind connection ${data.ref} to ${target.targetKind} ${target.targetId}`,
          ops: [bindOp],
        }),
      });
      if (doRes.status === 200) {
        bindResponsePayload = (await doRes.json()) as Record<string, unknown>;
      }
    }

    return c.json(
      {
        connection: {
          id: connId,
          ref: data.ref,
          project,
          app: data.app,
          authType: data.authType,
          label,
          envScope: data.envScope,
          scopes: data.scopes,
          status: "connected",
          expiresAt: data.expiresAt ?? null,
          lastCheckedAt: nowIso,
          keyHint: sealedMeta.keyHint,
          updatedAt: nowIso,
        },
        ...(bindResponsePayload
          ? {
              revision: bindResponsePayload.revision,
              state: bindResponsePayload.state,
              semanticHash: bindResponsePayload.semanticHash,
              readiness: bindResponsePayload.readiness,
            }
          : {}),
      },
      200,
    );
  });

  app.post("/api/projects/:project/connections/:ref/test", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const ref = c.req.param("ref");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const isAgentCaller =
      resolved.caller.kind === "mcp_token" ||
      resolved.caller.author.type === "agent" ||
      Boolean(c.req.header("x-mcp-client-name")) ||
      Boolean(c.req.header("x-mcp-client-id"));
    if (isAgentCaller) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN_AGENT_SECRET_ACCESS",
            message: "MCP agent tokens are forbidden from testing connection credentials.",
          },
        },
        403,
      );
    }

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const envDb = c.env.DB ?? db;
    await ensureConnectionsTable(envDb);
    const pxRow = await envDb
      .prepare(
        "SELECT ref, app, auth_type, ciphertext_b64, iv_b64, status, expires_at FROM px_connections WHERE ref = ? AND project_id = ? LIMIT 1",
      )
      .bind(ref, project)
      .first<{
        ref: string;
        app: string;
        auth_type: string;
        ciphertext_b64: string;
        iv_b64: string;
        status: string;
        expires_at: string | null;
      }>();

    if (!pxRow) {
      return c.json(
        {
          error: {
            code: "CONNECTION_NOT_FOUND",
            message: `Connection "${ref}" not found`,
          },
        },
        404,
      );
    }

    const nowIso = new Date().toISOString();
    const connKeySecret =
      c.env.PX_CONN_KEY ?? c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
    let status: "connected" | "expired" | "revoked" | "error" =
      pxRow.status === "revoked" ? "revoked" : "connected";

    try {
      await unsealConnectionCredentials(
        pxRow.ciphertext_b64,
        pxRow.iv_b64,
        connKeySecret,
      );
      if (pxRow.expires_at) {
        const expMs = Date.parse(pxRow.expires_at);
        if (Number.isFinite(expMs) && expMs <= Date.now()) {
          status = "expired";
        }
      }
    } catch {
      status = "error";
    }

    await envDb
      .prepare(
        "UPDATE px_connections SET status = ?, last_checked_at = ?, updated_at = ? WHERE ref = ? AND project_id = ?",
      )
      .bind(status, nowIso, nowIso, ref, project)
      .run();
    await db
      .prepare(
        "UPDATE studio_connections_metadata SET status = ?, last_checked_at = ?, updated_at = ? WHERE project_id = ? AND ref = ?",
      )
      .bind(status, nowIso, nowIso, project, ref)
      .run();

    return c.json(
      {
        ok: status === "connected",
        ref,
        status,
        lastCheckedAt: nowIso,
      },
      200,
    );
  });

  app.post("/api/projects/:project/connections/:ref/reauthorize", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const ref = c.req.param("ref");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const isAgentCaller =
      resolved.caller.kind === "mcp_token" ||
      resolved.caller.author.type === "agent" ||
      Boolean(c.req.header("x-mcp-client-name")) ||
      Boolean(c.req.header("x-mcp-client-id"));
    if (isAgentCaller) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN_AGENT_SECRET_ACCESS",
            message: "MCP agent tokens are forbidden from re-authorizing connections.",
          },
        },
        403,
      );
    }

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    let rawBody: Record<string, unknown> = {};
    try {
      const parsed = await c.req.json();
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        rawBody = parsed as Record<string, unknown>;
      }
    } catch {
      rawBody = {};
    }

    const envDb = c.env.DB ?? db;
    await ensureConnectionsTable(envDb);
    const existing = await envDb
      .prepare(
        "SELECT ref, app, auth_type, label, scopes_json, workspace_id, env_name FROM px_connections WHERE ref = ? AND project_id = ? LIMIT 1",
      )
      .bind(ref, project)
      .first<{
        ref: string;
        app: string;
        auth_type: string;
        label: string;
        scopes_json: string;
        workspace_id: string;
        env_name: string;
      }>();

    // Story 16: a ref held by another project is not this project's connection to update.
    if (!existing) {
      const foreign = await envDb
        .prepare("SELECT project_id FROM px_connections WHERE ref = ? LIMIT 1")
        .bind(ref)
        .first<{ project_id: string }>();
      if (foreign) {
        return c.json(
          { error: { code: "CONNECTION_NOT_FOUND", message: `Connection "${ref}" not found` } },
          404,
        );
      }
    }

    const appSlug =
      (typeof rawBody.app === "string" && rawBody.app.trim()
        ? rawBody.app.trim()
        : existing?.app) ?? "custom";
    const authType =
      (typeof rawBody.authType === "string" && rawBody.authType.trim()
        ? rawBody.authType.trim()
        : existing?.auth_type) ?? "oauth2";

    const nowIso = new Date().toISOString();
    const connKeySecret =
      c.env.PX_CONN_KEY ?? c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;

    if (typeof rawBody.value === "string" || typeof rawBody.credentials === "object") {
      const valStr = typeof rawBody.value === "string" ? rawBody.value : "";
      const creds: Record<string, unknown> =
        typeof rawBody.credentials === "object" && rawBody.credentials !== null
          ? (rawBody.credentials as Record<string, unknown>)
          : authType === "oauth2"
            ? {
                accessToken: valStr,
                tokenType: "Bearer",
                expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              }
            : { apiKey: valStr, token: valStr };
      const expiresAt =
        typeof creds.expiresAt === "string"
          ? creds.expiresAt
          : authType === "oauth2"
            ? new Date(Date.now() + 3600_000).toISOString()
            : null;
      let scopes: string[] = [];
      try {
        const parsed = JSON.parse(existing?.scopes_json ?? "[]");
        if (Array.isArray(parsed)) scopes = parsed.map(String);
      } catch {
        scopes = [];
      }
      await assertConnectionRefFree(envDb, ref, project);
      const sealedMeta = await upsertSealedConnection(
        envDb,
        {
          ref,
          projectId: project,
          envName: existing?.env_name === "production" ? "production" : "preview",
          workspaceId: existing?.workspace_id ?? "default",
          app: appSlug,
          authType,
          label: existing?.label ?? ref,
          scopes,
          credentials: creds,
          status: "connected",
          expiresAt,
          lastCheckedAt: nowIso,
        },
        connKeySecret,
      );
      await assertConnectionRefOwned(envDb, ref, project);
      await db
        .prepare(
          "UPDATE studio_connections_metadata SET status = 'connected', expires_at = ?, last_checked_at = ?, key_hint = ?, updated_at = ? WHERE project_id = ? AND ref = ?",
        )
        .bind(expiresAt, nowIso, sealedMeta.keyHint, nowIso, project, ref)
        .run();
      await db
        .prepare(
          "UPDATE studio_secret_vault SET status = 'valid', key_hint = ?, updated_at = ? WHERE project_id = ? AND ref = ?",
        )
        .bind(sealedMeta.keyHint, nowIso, project, ref)
        .run();
      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: "human",
        actorId: resolved.caller.userId,
        action: "connection.reauthorize",
        status: "succeeded",
        targetRef: ref,
        details: {
          ref,
          app: appSlug,
          authType,
          keyHint: sealedMeta.keyHint,
        },
        request: c.req.raw,
      });
      return c.json(
        {
          ok: true,
          ref,
          app: appSlug,
          status: "connected",
          expiresAt,
          lastCheckedAt: nowIso,
          keyHint: sealedMeta.keyHint,
        },
        200,
      );
    }

    // For OAuth2 without inline credentials, generate a fresh PKCE state & authorizationUrl AND mark connected if requested in studio local reauth
    const oauthCfg = getIntegrationOAuthConfig(appSlug);
    const state = `st_${generateRandomBase64Url(24)}`;
    const codeVerifier = generateRandomBase64Url(32);
    const codeChallenge = await computePkceS256Challenge(codeVerifier);
    const redirectUri = `http://localhost:8787/api/connections/oauth/${encodeURIComponent(appSlug)}/callback`;

    await db
      .prepare(
        `INSERT INTO studio_oauth_states (
           state, org_id, project_id, app, ref, label, env_scope, workspace_id,
           code_verifier, code_challenge, scopes_json, redirect_uri, created_by, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'preview', 'default', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        state,
        authz.orgId,
        project,
        appSlug,
        ref,
        existing?.label ?? `${appSlug} OAuth2`,
        codeVerifier,
        codeChallenge,
        existing?.scopes_json ?? "[]",
        redirectUri,
        resolved.caller.userId,
        new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        nowIso,
      )
      .run();

    const authUrl = new URL(oauthCfg.authorizationUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", `px_studio_${appSlug}`);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    await recordStudioAuditLog(db, {
      orgId: authz.orgId,
      projectId: project,
      actorType: "human",
      actorId: resolved.caller.userId,
      action: "connection.reauthorize",
      status: "succeeded",
      targetRef: ref,
      details: {
        ref,
        app: appSlug,
        authType: "oauth2",
        state,
      },
      request: c.req.raw,
    });

    return c.json(
      {
        ok: true,
        ref,
        app: appSlug,
        state,
        codeChallenge,
        codeChallengeMethod: "S256",
        authorizationUrl: authUrl.toString(),
        status: existing ? "connected" : "pending",
      },
      200,
    );
  });

  app.delete("/api/projects/:project/connections/:ref", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const ref = c.req.param("ref");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const isAgentCaller =
      resolved.caller.kind === "mcp_token" ||
      resolved.caller.author.type === "agent" ||
      Boolean(c.req.header("x-mcp-client-name")) ||
      Boolean(c.req.header("x-mcp-client-id"));
    if (isAgentCaller) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN_AGENT_SECRET_ACCESS",
            message: "MCP agent tokens are forbidden from deleting connections.",
          },
        },
        403,
      );
    }

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const envDb = c.env.DB ?? db;
    await ensureConnectionsTable(envDb);
    // Story 16: only this project's own connection can be deleted; a ref that is not this project's is 404.
    const ownLive = await envDb
      .prepare("SELECT ref FROM px_connections WHERE ref = ? AND project_id = ? LIMIT 1")
      .bind(ref, project)
      .first<{ ref: string }>();
    const ownMeta = await db
      .prepare("SELECT ref FROM studio_connections_metadata WHERE project_id = ? AND ref = ? LIMIT 1")
      .bind(project, ref)
      .first<{ ref: string }>();
    if (!ownLive && !ownMeta) {
      return c.json(
        { error: { code: "CONNECTION_NOT_FOUND", message: `Connection "${ref}" not found` } },
        404,
      );
    }
    await envDb
      .prepare("DELETE FROM px_connections WHERE ref = ? AND project_id = ?")
      .bind(ref, project)
      .run();
    await db
      .prepare("DELETE FROM studio_connections_metadata WHERE project_id = ? AND ref = ?")
      .bind(project, ref)
      .run();
    await db
      .prepare("DELETE FROM studio_secret_vault WHERE project_id = ? AND ref = ?")
      .bind(project, ref)
      .run();

    await recordStudioAuditLog(db, {
      orgId: authz.orgId,
      projectId: project,
      actorType: "human",
      actorId: resolved.caller.userId,
      action: "connection.delete",
      status: "succeeded",
      details: { ref },
    });

    return c.json({ deleted: true, ref }, 200);
  });

  app.post("/api/projects/:project/connections/requests", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    let rawJson: unknown;
    try {
      rawJson = await c.req.json();
    } catch {
      return c.json(
        {
          error: {
            code: "INVALID_JSON",
            message: "Request body must be valid JSON",
          },
        },
        400,
      );
    }

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      (rawJson && typeof rawJson === "object" && typeof (rawJson as { orgId?: unknown }).orgId === "string"
        ? (rawJson as { orgId: string }).orgId
        : undefined) ?? c.req.header("x-org-id"),
      "connect",
    );
    if (!authz.ok) {
      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "connection.request",
        status: "forbidden",
        details: { code: authz.error.code, role: authz.role },
        request: c.req.raw,
      });
      return c.json({ error: authz.error }, authz.status);
    }

    const parsedBody = CreateConnectionRequestBodySchema.safeParse(rawJson);
    if (!parsedBody.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: parsedBody.error.issues.map((i) => i.message).join("; "),
          },
        },
        422,
      );
    }

    const appSlug = parsedBody.data.app.trim().toLowerCase();
    const suggestedRef =
      parsedBody.data.suggestedRef ??
      `sec_${appSlug.replace(/[^a-z0-9_]/g, "_")}_conn`;
    const requestId = `connreq_${project}_${appSlug}_${Date.now()}`;
    const connectUrl = `https://studio.projectx.local/projects/${encodeURIComponent(project)}/connections/new?app=${encodeURIComponent(appSlug)}&ref=${encodeURIComponent(suggestedRef)}`;
    const nowIso = new Date().toISOString();

    await db
      .prepare(
        `INSERT INTO studio_connection_requests (
           request_id, org_id, project_id, app, reason, scopes_json, suggested_ref,
           connect_url, status, requested_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_user_consent', ?, ?)`,
      )
      .bind(
        requestId,
        authz.orgId,
        project,
        appSlug,
        parsedBody.data.reason,
        JSON.stringify(parsedBody.data.scopes),
        suggestedRef,
        connectUrl,
        resolved.caller.author.id,
        nowIso,
      )
      .run();

    await recordStudioAuditLog(db, {
      orgId: authz.orgId,
      projectId: project,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "connection.request",
      status: "succeeded",
      targetRef: suggestedRef,
      details: {
        requestId,
        app: appSlug,
        suggestedRef,
        scopes: parsedBody.data.scopes,
      },
      request: c.req.raw,
    });

    return c.json(
      {
        requestId,
        project,
        app: appSlug,
        reason: parsedBody.data.reason,
        scopes: parsedBody.data.scopes,
        suggestedRef,
        connectUrl,
        status: "pending_user_consent",
        createdAt: nowIso,
      },
      200,
    );
  });

  app.post("/api/projects/:project/telemetry/webhook", async (c) => {
    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const signatureHeader = c.req.header(TELEMETRY_SIGNATURE_HEADER);
    // Story 1.4: each project's webhook is signed with its own derived secret, so a body signed for another project
    // (or with the shared root secret) does not verify on this project's URL.
    // Story 1.17: the webhook signature is domain-separated (px-telemetry-webhook/v1), so a control-plane signature never
    // verifies here, and the reverse.
    const telemetrySecret = await studioProjectSecret(c.env, project, "telemetry-webhook");
    if (!telemetrySecret) return signingSecretNotConfigured();
    const rawBody = await c.req.raw.text();

    const validSig = await verifyTelemetryWebhook(
      rawBody,
      signatureHeader,
      telemetrySecret,
    );
    if (!validSig) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED_TELEMETRY_SIGNATURE",
            message: "Missing or invalid X-Px-Signature",
          },
        },
        401,
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return c.json(
        {
          error: {
            code: "INVALID_JSON",
            message: "Webhook body must be valid JSON",
          },
        },
        400,
      );
    }

    // The signed payload must name the project of this URL (story 1.4): a payload signed for another project, or for
    // none, is refused before anything is written, so it cannot land in this project's telemetry.
    const signedProject =
      parsedJson !== null && typeof parsedJson === "object" && !Array.isArray(parsedJson)
        ? (parsedJson as { project?: unknown }).project
        : undefined;
    if (signedProject !== project) {
      return c.json(
        {
          error: {
            code: signedProject === undefined ? "PROJECT_REQUIRED" : "PROJECT_MISMATCH",
            message: "The signed telemetry payload must name this URL's project; nothing was written.",
          },
        },
        400,
      );
    }

    const validated = TelemetryWebhookPayloadSchema.safeParse(parsedJson);
    if (!validated.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: validated.error.issues.map((i) => i.message).join("; "),
            issues: validated.error.issues,
          },
        },
        422,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    // Every row is stamped with this (signed, URL-matching) project. A run or event id held by another workspace or
    // project is a collision: 409, and nothing is broadcast.
    const stamp = { projectId: project };
    const payload = validated.data;
    const persistedEvents: StepEvent[] = [];
    const persistedLogs: StructuredLogEntry[] = [];
    // Refuse the whole payload, before writing any of it, when one of its ids is held by another workspace or project.
    const webhookCollision = await findTelemetryIdCollision(db, [
      ...(payload.run ? [{ table: "px_runs" as const, id: payload.run.runId, workspaceId: payload.run.workspaceId, projectId: project }] : []),
      ...payload.events.map((ev) => ({ table: "px_step_events" as const, id: ev.eventId, workspaceId: ev.workspaceId, projectId: project })),
      ...(payload.logs ?? []).map((log) => ({ table: "px_logs" as const, id: log.logId, workspaceId: log.workspaceId ?? null, projectId: project })),
    ]);
    if (webhookCollision) return idCollisionResponse(webhookCollision);
    try {
      if (payload.run) {
        await upsertRunRecord(db, payload.run, stamp);
      }
      for (const ev of payload.events) {
        const saved = await insertStepEvent(db, ev, stamp);
        persistedEvents.push(saved);
      }
      for (const logItem of payload.logs ?? []) {
        const savedLog = await insertStructuredLog(db, logItem, {}, stamp);
        persistedLogs.push(savedLog);
      }
    } catch (error) {
      if (error instanceof TelemetryWriteRefusedError) {
        return c.json(
          { error: { code: error.kind === "ID_COLLISION" ? "ID_COLLISION" : "TELEMETRY_WRITE_REFUSED", message: error.message } },
          error.kind === "ID_COLLISION" ? 409 : 400,
        );
      }
      throw error;
    }

    const stub = getBlueprintStub(c.env, project);
    const doRes = await stub.fetch(
      `http://blueprint-do/telemetry?project=${encodeURIComponent(project)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project,
          run: payload.run,
          events: persistedEvents,
          logs: persistedLogs,
        }),
      },
    );
    const doBody = (await doRes.json()) as {
      broadcastedCount?: number;
      frames?: unknown[];
    };

    return c.json(
      {
        ok: true,
        project,
        ingestedEvents: persistedEvents.length,
        ingestedLogs: persistedLogs.length,
        broadcastedCount: doBody.broadcastedCount ?? 0,
      },
      200,
    );
  });

  app.get("/api/projects/:project/telemetry/events", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const runId = c.req.query("runId");
    const afterRaw = c.req.query("after");
    const limitRaw = c.req.query("limit");
    const after = afterRaw !== undefined ? Number(afterRaw) : 0;
    const limit = limitRaw !== undefined ? Number(limitRaw) : 100;
    const scope = studioTelemetryScope(project, c.req.query("workspaceId"));

    await ensureTelemetryTables(db);
    const runs = await listRunRecords(db, scope, { limit: 50 });
    if (runId) {
      const events = await listStepEventsForRun(db, runId, scope);
      return c.json({ project, runs, events, nextCursor: events.length, hasMore: false }, 200);
    }

    const page = await listStepEventsAfterCursor(
      db,
      scope,
      Number.isInteger(after) && after >= 0 ? after : 0,
      Number.isInteger(limit) && limit >= 1 ? limit : 100,
    );
    return c.json(
      {
        project,
        runs,
        events: page.events,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      },
      200,
    );
  });

  app.post("/api/projects/:project/telemetry/reconcile", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate", // story 16: it writes runs and step events (viewer gets 403)
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      workerUrl?: unknown;
      env?: unknown;
      after?: number;
      limit?: number;
      workspaceId?: string;
    };
    const after = typeof body.after === "number" && body.after >= 0 ? Math.floor(body.after) : 0;
    const limit = typeof body.limit === "number" && body.limit >= 1 ? Math.floor(body.limit) : 100;
    // Story 1.4: Studio signs this pull, so it goes only to the project's own registered deploy target, never to an
    // address the caller supplies (a signed request sent elsewhere could be replayed within its 300 s window).
    if (body.workerUrl !== undefined) {
      return c.json(
        {
          error: {
            code: "WORKER_URL_NOT_ACCEPTED",
            message: "Reconcile pulls from the project's own deploy target; a workerUrl in the body is refused.",
          },
        },
        400,
      );
    }
    // The Worker's events pull reads one workspace, the one its signed query names; it must be one of this project's.
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    if (!workspaceId) {
      return c.json(
        {
          error: {
            code: "WORKSPACE_ID_REQUIRED",
            message: "Reconcile pulls one workspace's events: the body must name workspaceId.",
          },
        },
        400,
      );
    }
    // Story 1.17: any valid tenant workspace of the project's own deploy target is accepted, including one Studio has
    // not seen yet. The pull goes only to the project's target, its rows are kept only for this workspace and stamped
    // with the project, and the id-collision check below still refuses ids held by another workspace or project.
    if (!isTenantWorkspaceId(workspaceId)) {
      return c.json(
        {
          error: {
            code: "BAD_WORKSPACE",
            message: "workspaceId must be a tenant workspace id (letters, digits, _ and -, no double underscore).",
          },
        },
        400,
      );
    }

    const targetEnv = body.env === "production" ? "production" : "preview";
    const target =
      (await db
        .prepare(
          "SELECT worker_url FROM project_deployments WHERE project_id = ?1 AND org_id = ?2 AND env_name = ?3 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(project, authz.orgId, targetEnv)
        .first<{ worker_url: string }>()
        .catch(() => null)) ??
      (await db
        .prepare(
          "SELECT worker_url FROM deployments WHERE project_id = ?1 AND org_id = ?2 AND env_name = ?3 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(project, authz.orgId, targetEnv)
        .first<{ worker_url: string }>()
        .catch(() => null));
    if (!target?.worker_url) {
      return c.json(
        { error: { code: "NO_TARGET", message: `Project "${project}" has no deployed ${targetEnv} target to reconcile from.` } },
        409,
      );
    }
    const workerUrl = target.worker_url;

    const telemetrySecret = await studioProjectSecret(c.env, project, "control-plane");
    if (!telemetrySecret) {
      return signingSecretNotConfigured();
    }
    const pullUrl = new URL("/__px/events", workerUrl);
    pullUrl.searchParams.set("workspaceId", workspaceId);
    pullUrl.searchParams.set("after", String(after));
    pullUrl.searchParams.set("limit", String(limit));

    const pullRes = await fetch(pullUrl.toString(), {
      method: "GET",
      headers: await signControlPlaneRequest(telemetrySecret, "GET", pullUrl),
    });

    if (!pullRes.ok) {
      return c.json(
        {
          error: {
            code: "WORKER_EVENTS_PULL_FAILED",
            message: `Worker /__px/events returned HTTP ${pullRes.status}`,
          },
        },
        502,
      );
    }

    const pulled = (await pullRes.json()) as {
      events?: StepEvent[];
      runs?: RunRecord[];
      nextCursor?: number;
      hasMore?: boolean;
    };

    // Only rows of the workspace that was pulled are kept, each stamped with this project.
    const stamp = { projectId: project };
    const pulledRuns = (pulled.runs ?? []).filter((run) => run?.workspaceId === workspaceId);
    const pulledEvents = (pulled.events ?? []).filter((ev) => ev?.workspaceId === workspaceId);
    const reconcileCollision = await findTelemetryIdCollision(db, [
      ...pulledRuns.map((run) => ({ table: "px_runs" as const, id: run.runId, workspaceId, projectId: project })),
      ...pulledEvents.map((ev) => ({ table: "px_step_events" as const, id: ev.eventId, workspaceId, projectId: project })),
    ]);
    if (reconcileCollision) return idCollisionResponse(reconcileCollision);
    const persistedEvents: StepEvent[] = [];
    const reconcileRefused = await refusedWriteAs409(async () => {
      for (const run of pulledRuns) {
        await upsertRunRecord(db, run, stamp);
      }
      for (const ev of pulledEvents) {
        persistedEvents.push(await insertStepEvent(db, ev, stamp));
      }
    });
    if (reconcileRefused) return reconcileRefused;

    const stub = getBlueprintStub(c.env, project);
    await stub.fetch(
      `http://blueprint-do/telemetry?project=${encodeURIComponent(project)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project,
          ...(pulledRuns[0] ? { run: pulledRuns[0] } : {}),
          events: persistedEvents,
        }),
      },
    );

    return c.json(
      {
        ok: true,
        project,
        reconciledEvents: persistedEvents.length,
        nextCursor: pulled.nextCursor ?? after,
        hasMore: pulled.hasMore ?? false,
      },
      200,
    );
  });

  app.post(
    "/api/projects/:project/workflows/:workflowId/nodes/:nodeId/test-step",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project") ?? "";
      const workflowId = c.req.param("workflowId") ?? "";
      const nodeId = c.req.param("nodeId");

      if (!PROJECT_SLUG_PATTERN.test(project)) {
        return c.json(
          {
            error: {
              code: "INVALID_PROJECT_SLUG",
              message: `Invalid project slug "${project}"`,
            },
          },
          400,
        );
      }

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      let rawBody: Record<string, unknown> = {};
      try {
        const parsed = await c.req.json();
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          rawBody = parsed as Record<string, unknown>;
        }
      } catch {
        rawBody = {};
      }

      const targetEnv =
        typeof rawBody.env === "string"
          ? rawBody.env
          : (c.req.query("env") ?? c.req.header("x-px-env") ?? "preview");

      if (targetEnv === "production") {
        return c.json(
          {
            error: {
              code: "REHEARSAL_FORBIDDEN_IN_PRODUCTION",
              message:
                "Test step rehearsal targets the preview environment only and is forbidden against production.",
            },
          },
          403,
        );
      }

      const requestedOrgId =
        typeof rawBody.orgId === "string"
          ? rawBody.orgId
          : (c.req.query("orgId") ?? c.req.header("x-org-id"));

      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "mutate",
        requestedOrgId,
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      const stub = getBlueprintStub(c.env, project);
      const stateRes = await stub.fetch(
        `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
        { method: "GET" },
      );
      const projectState = (await stateRes.json()) as ProjectStatePayload;

      const workflow = (projectState.state?.workflows ?? []).find(
        (wf) => wf.id === workflowId,
      );
      const bpNode = (workflow?.nodes ?? []).find((n) => n.id === nodeId);

      const nodeType =
        typeof rawBody.nodeType === "string" && rawBody.nodeType.length > 0
          ? rawBody.nodeType
          : bpNode?.type;

      if (!nodeType) {
        return c.json(
          {
            error: {
              code: "NODE_NOT_FOUND",
              message: `Node "${nodeId}" not found in workflow "${workflowId}"`,
            },
          },
          404,
        );
      }

      const mergedConfig: Record<string, unknown> = {
        ...(bpNode?.data ?? {}),
        ...(typeof rawBody.config === "object" &&
        rawBody.config !== null &&
        !Array.isArray(rawBody.config)
          ? (rawBody.config as Record<string, unknown>)
          : {}),
      };

      // Load and unseal project secrets for preview execution while tracking them for strict redaction
      const vaultRows = await db
        .prepare(
          "SELECT ref, ciphertext_b64, iv_b64 FROM studio_secret_vault WHERE project_id = ? AND status = 'valid'",
        )
        .bind(project)
        .all<{ ref: string; ciphertext_b64: string; iv_b64: string }>();

      const vaultKeySecret = c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
      const unsealedByRef = new Map<string, string>();
      const secretValues = new Set<string>();

      for (const row of vaultRows.results ?? []) {
        try {
          const plaintext = await decryptSecretValue(
            row.ciphertext_b64,
            row.iv_b64,
            vaultKeySecret,
          );
          unsealedByRef.set(row.ref, plaintext);
          if (plaintext.trim().length >= 3) {
            secretValues.add(plaintext);
          }
        } catch {
          // Ignore unseal failures for unrelated keys
        }
      }

      if (Array.isArray(rawBody.secretValues)) {
        for (const sv of rawBody.secretValues) {
          if (typeof sv === "string" && sv.trim().length >= 3) {
            secretValues.add(sv);
          }
        }
      }

      const connKeySecret =
        c.env.PX_CONN_KEY ?? c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
      const envDbForRehearse = c.env.DB ?? db;
      await ensureConnectionsTable(envDbForRehearse);
      const pxConnRows = await envDbForRehearse
        .prepare(
          "SELECT ref, ciphertext_b64, iv_b64 FROM px_connections WHERE project_id = ?",
        )
        .bind(project)
        .all<{ ref: string; ciphertext_b64: string; iv_b64: string }>();
      for (const pxRow of pxConnRows.results ?? []) {
        try {
          const creds = await unsealConnectionCredentials(
            pxRow.ciphertext_b64,
            pxRow.iv_b64,
            connKeySecret,
          );
          for (const val of Object.values(creds)) {
            if (typeof val === "string" && val.trim().length >= 3) {
              secretValues.add(val);
            }
          }
        } catch {
          // Ignore unseal failures
        }
      }

      // Story 17: brick executors write the app's tables; never into STUDIO_DB.
      const rehearseDataDb = await resolveRunDataDb(
        c.env,
        db,
        project,
        authz.orgId,
        targetEnv === "production" ? "production" : "preview",
      );
      if (!rehearseDataDb) {
        return projectDataStoreNotConfigured(project, targetEnv === "production" ? "production" : "preview");
      }
      // Story 1.17: the workspace is one of the project's own preview workspaces, checked before anything is signed.
      const rehearsalWorkspace = await resolveProjectPreviewWorkspace({
        studioDb: db,
        projectDataDb: ((await resolveProjectDataStore(db, project, authz.orgId, "preview"))?.d1 ?? null),
        project,
        requested: rawBody.workspaceId,
      });
      if (!rehearsalWorkspace.ok) return rehearsalWorkspace.response;
      // Without Studio's root secret nothing can be signed: 503, as the other signing routes answer.
      if (!(await studioProjectSecret(c.env, project, "control-plane"))) return signingSecretNotConfigured();
      const rehearsalEnv: Record<string, unknown> = {
        DB: rehearseDataDb,
        PX_ENV: targetEnv,
        ...(connKeySecret ? { PX_CONN_KEY: connKeySecret } : {}),
        ...(c.env.__OAUTH_FETCHER ? { __OAUTH_FETCHER: c.env.__OAUTH_FETCHER } : {}),
      };
      if (typeof rawBody.secrets === "object" && rawBody.secrets !== null) {
        for (const [k, v] of Object.entries(rawBody.secrets as Record<string, unknown>)) {
          if (typeof v === "string") {
            rehearsalEnv[k] = v;
            if (v.trim().length >= 3) {
              secretValues.add(v);
            }
          }
        }
      }
      for (const [ref, plaintext] of unsealedByRef.entries()) {
        rehearsalEnv[ref] = plaintext;
      }
      for (const binding of projectState.state?.secretRefs ?? []) {
        const val = unsealedByRef.get(binding.ref);
        if (val !== undefined) {
          rehearsalEnv[binding.secretName] = val;
        }
      }
      // Story 1.17: the project's own bindings, as its deployed worker holds them (derived secrets only, never the root),
      // applied last so nothing the client sends replaces them.
      Object.assign(rehearsalEnv, await projectWorkerSecretBindings(c.env, project));

      const connections =
        typeof rawBody.connections === "object" &&
        rawBody.connections !== null &&
        !Array.isArray(rawBody.connections)
          ? (rawBody.connections as Record<string, Record<string, unknown>>)
          : undefined;

      const workflowPins: Record<string, PinnedNodeOutput> =
        projectState.pinnedOutputs?.[workflowId] ?? {};

      // Determine default input from pinned upstream output first, falling back to upstream node's last recorded output
      let effectiveInput: unknown = rawBody.input;
      if (effectiveInput === undefined && workflow) {
        const incomingEdge = (workflow.edges ?? []).find((e) => e.target === nodeId);
        if (incomingEdge) {
          const pinnedUpstream = workflowPins[incomingEdge.source];
          if (pinnedUpstream !== undefined) {
            effectiveInput = pinnedUpstream.output;
          } else {
            await ensureTelemetryTables(db);
            const lastUpstreamRow = await db
              .prepare(
                "SELECT output_preview FROM px_step_events WHERE project_id = ? AND workflow_id = ? AND node_id = ? AND status = 'succeeded' ORDER BY seq DESC LIMIT 1",
              )
              .bind(project, workflowId, incomingEdge.source)
              .first<{ output_preview: string }>();
            if (lastUpstreamRow?.output_preview) {
              try {
                effectiveInput = JSON.parse(lastUpstreamRow.output_preview);
              } catch {
                effectiveInput = {};
              }
            }
          }
        }
      }

      const mergedUpstreamSteps: Record<string, Record<string, unknown>> = {};
      for (const [pinnedNodeId, pinRec] of Object.entries(workflowPins)) {
        mergedUpstreamSteps[pinnedNodeId] = normalizeNodePortOutput(
          pinRec.output,
        );
      }
      if (
        typeof rawBody.upstreamSteps === "object" &&
        rawBody.upstreamSteps !== null &&
        !Array.isArray(rawBody.upstreamSteps)
      ) {
        for (const [stepId, stepVal] of Object.entries(
          rawBody.upstreamSteps as Record<string, unknown>,
        )) {
          mergedUpstreamSteps[stepId] = normalizeNodePortOutput(stepVal);
        }
      }

      const rehearsalPayload = {
        workflowId,
        revision: projectState.revision,
        nodeId,
        nodeType,
        config: mergedConfig,
        input: effectiveInput ?? {},
        workspaceId: rehearsalWorkspace.workspaceId,
        ...(Object.keys(mergedUpstreamSteps).length > 0
          ? { upstreamSteps: mergedUpstreamSteps }
          : {}),
      };

      // Story 1.17: signed with the project's derived control-plane secret over method, path, time and body, with a
      // fresh one-time requestId.
      const telemetrySecret = await requireProjectSecret(c.env, project, "control-plane");
      const previewReq = await signedExecutingRequest("/__px/rehearse", rehearsalPayload, telemetrySecret);

      let runtimeExecutors: Executors;
      try {
        runtimeExecutors = studioExecutorsFor(appOptions.executors, c.env);
      } catch (error) {
        return c.json(executorsNotConfiguredBody(error), 503);
      }
      const previewRes = await handleStepRehearsalRequest(previewReq, {
        registry: runtimeRegistry,
        executors: runtimeExecutors,
        db,
        telemetryProjectId: project,
        env: rehearsalEnv,
        ...(connections ? { connections } : {}),
        pxEnv: targetEnv,
        telemetrySecret,
        secretValues,
      });

      if (!previewRes) {
        return c.json(
          {
            error: {
              code: "REHEARSAL_DISPATCH_FAILED",
              message: "Preview rehearsal handler did not match /__px/rehearse",
            },
          },
          500,
        );
      }

      const resultBody = (await previewRes.json()) as StepRehearsalResult;
      if (previewRes.status !== 200) {
        return c.json(resultBody, previewRes.status as 400 | 401 | 403 | 422);
      }

      // Broadcast rehearsal telemetry event to BlueprintDO so connected Studio sessions also see the rehearsal event
      const projectScope = { projectId: project };
      const stepEvents = await listStepEventsForRun(db, resultBody.runId, projectScope);
      const runRecord = (await listRunRecords(db, projectScope, { workflowId, limit: 5 })).find(
        (r) => r.runId === resultBody.runId,
      );
      await stub.fetch(
        `http://blueprint-do/telemetry?project=${encodeURIComponent(project)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project,
            ...(runRecord ? { run: runRecord } : {}),
            events: stepEvents,
          }),
        },
      );

      await recordStudioOnboardingEvent(db, {
        orgId: authz.orgId,
        projectId: project,
        actorId: resolved.caller.author.id,
        step: "first_test_step_run",
        metadata: {
          runId: resultBody.runId,
          workflowId,
          nodeId,
          status: resultBody.status,
        },
        onlyOncePerProject: true,
      });

      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "workflow.run",
        status: String(resultBody.status) === "failed" ? "failed" : "succeeded",
        details: {
          runId: resultBody.runId,
          workflowId,
          nodeId,
          rehearsal: true,
          ...(resolved.caller.author.client
            ? { client: resolved.caller.author.client }
            : {}),
        },
      });

      return c.json(resultBody, 200);
    },
  );

  const handleExecuteWorkflowRun = async (c: import("hono").Context<{ Bindings: StudioApiEnv }>) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project") ?? "";
      const workflowId = c.req.param("workflowId") ?? "";

      if (!PROJECT_SLUG_PATTERN.test(project)) {
        return c.json(
          {
            error: {
              code: "INVALID_PROJECT_SLUG",
              message: `Invalid project slug "${project}"`,
            },
          },
          400,
        );
      }

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      let rawBody: Record<string, unknown> = {};
      try {
        const parsed = await c.req.json();
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          rawBody = parsed as Record<string, unknown>;
        }
      } catch {
        rawBody = {};
      }

      const requestedOrgId =
        typeof rawBody.orgId === "string"
          ? rawBody.orgId
          : (c.req.query("orgId") ?? c.req.header("x-org-id"));

      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "mutate",
        requestedOrgId,
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      const targetEnv =
        typeof rawBody.env === "string" &&
        (rawBody.env === "preview" || rawBody.env === "production")
          ? rawBody.env
          : "preview";

      const stub = getBlueprintStub(c.env, project);
      const stateRes = await stub.fetch(
        `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
        { method: "GET" },
      );
      const projectState = (await stateRes.json()) as ProjectStatePayload;

      let workflow = (projectState.state?.workflows ?? []).find(
        (wf) => wf.id === workflowId,
      );

      if (rawBody.useDeployedGraph === true) {
        const envRow = await db
          .prepare(
            "SELECT deployed_state_json FROM project_environments WHERE project_id = ? AND env_name = ? LIMIT 1",
          )
          .bind(project, targetEnv)
          .first<{ deployed_state_json: string | null }>();
        if (envRow?.deployed_state_json) {
          try {
            const parsedDeployed = JSON.parse(envRow.deployed_state_json) as {
              graphs?: Record<string, string>;
            };
            const deployedGraphJson = parsedDeployed.graphs?.[workflowId];
            if (deployedGraphJson) {
              workflow = JSON.parse(deployedGraphJson) as typeof workflow;
            }
          } catch {
            // Fall back to current draft workflow
          }
        }
      }

      if (!workflow) {
        return c.json(
          {
            error: {
              code: "WORKFLOW_NOT_FOUND",
              message: `Workflow "${workflowId}" not found in project "${project}"`,
            },
          },
          404,
        );
      }

      // Unseal project secrets for runtime execution while tracking all secret values for telemetry redaction
      const vaultRows = await db
        .prepare(
          "SELECT ref, ciphertext_b64, iv_b64 FROM studio_secret_vault WHERE project_id = ? AND status = 'valid'",
        )
        .bind(project)
        .all<{ ref: string; ciphertext_b64: string; iv_b64: string }>();

      const vaultKeySecret = c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
      const unsealedByRef = new Map<string, string>();
      const secretValues = new Set<string>();

      for (const row of vaultRows.results ?? []) {
        try {
          const plaintext = await decryptSecretValue(
            row.ciphertext_b64,
            row.iv_b64,
            vaultKeySecret,
          );
          unsealedByRef.set(row.ref, plaintext);
          if (plaintext.trim().length >= 3) {
            secretValues.add(plaintext);
          }
        } catch {
          // Ignore unseal failures for unrelated keys
        }
      }

      if (Array.isArray(rawBody.secretValues)) {
        for (const sv of rawBody.secretValues) {
          if (typeof sv === "string" && sv.trim().length >= 3) {
            secretValues.add(sv);
          }
        }
      }

      const connKeySecret =
        c.env.PX_CONN_KEY ?? c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
      const envDbForRun = c.env.DB ?? db;
      await ensureConnectionsTable(envDbForRun);
      const pxConnRows = await envDbForRun
        .prepare(
          "SELECT ref, ciphertext_b64, iv_b64 FROM px_connections WHERE project_id = ?",
        )
        .bind(project)
        .all<{ ref: string; ciphertext_b64: string; iv_b64: string }>();
      for (const pxRow of pxConnRows.results ?? []) {
        try {
          const creds = await unsealConnectionCredentials(
            pxRow.ciphertext_b64,
            pxRow.iv_b64,
            connKeySecret,
          );
          for (const val of Object.values(creds)) {
            if (typeof val === "string" && val.trim().length >= 3) {
              secretValues.add(val);
            }
          }
        } catch {
          // Ignore unseal failures
        }
      }

      // Story 17: brick executors write the app's tables; never into STUDIO_DB.
      const runDataDb = await resolveRunDataDb(c.env, db, project, authz.orgId, targetEnv);
      if (!runDataDb) {
        return projectDataStoreNotConfigured(project, targetEnv);
      }
      // Story 1.17: the workspace is one of the project's own preview workspaces, checked before anything is signed.
      const runWorkspace = await resolveProjectPreviewWorkspace({
        studioDb: db,
        projectDataDb: ((await resolveProjectDataStore(db, project, authz.orgId, "preview"))?.d1 ?? null),
        project,
        requested: rawBody.workspaceId,
      });
      if (!runWorkspace.ok) return runWorkspace.response;
      // Without Studio's root secret nothing can be signed: 503, as the other signing routes answer.
      if (!(await studioProjectSecret(c.env, project, "control-plane"))) return signingSecretNotConfigured();
      const runEnv: Record<string, unknown> = {
        DB: runDataDb,
        PX_ENV: targetEnv,
        ...(connKeySecret ? { PX_CONN_KEY: connKeySecret } : {}),
        ...(c.env.__OAUTH_FETCHER ? { __OAUTH_FETCHER: c.env.__OAUTH_FETCHER } : {}),
      };
      if (typeof rawBody.secrets === "object" && rawBody.secrets !== null) {
        for (const [k, v] of Object.entries(rawBody.secrets as Record<string, unknown>)) {
          if (typeof v === "string") {
            runEnv[k] = v;
            if (v.trim().length >= 3) {
              secretValues.add(v);
            }
          }
        }
      }
      for (const [ref, plaintext] of unsealedByRef.entries()) {
        runEnv[ref] = plaintext;
      }
      for (const binding of projectState.state?.secretRefs ?? []) {
        const val = unsealedByRef.get(binding.ref);
        if (val !== undefined) {
          runEnv[binding.secretName] = val;
        }
      }
      // Story 1.17: the project's own bindings (derived secrets only, never the root), applied last.
      Object.assign(runEnv, await projectWorkerSecretBindings(c.env, project));

      const connections =
        typeof rawBody.connections === "object" &&
        rawBody.connections !== null &&
        !Array.isArray(rawBody.connections)
          ? (rawBody.connections as Record<string, Record<string, unknown>>)
          : undefined;

      const triggerPayload =
        rawBody.triggerPayload !== undefined
          ? rawBody.triggerPayload
          : (rawBody.payload ?? {});

      const runId =
        typeof rawBody.runId === "string" && rawBody.runId.trim().length > 0
          ? rawBody.runId.trim()
          : `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const usePinnedOutputs =
        targetEnv !== "production" &&
        (rawBody.usePinnedOutputs === true || rawBody.usePinnedData === true);
      const pinnedOutputsMap: Record<string, unknown> = {};
      if (usePinnedOutputs) {
        const storedPins = projectState.pinnedOutputs?.[workflowId] ?? {};
        for (const [pNodeId, pinRec] of Object.entries(storedPins)) {
          pinnedOutputsMap[pNodeId] = (pinRec as { output?: unknown }).output;
        }
        if (
          typeof rawBody.pinnedOutputs === "object" &&
          rawBody.pinnedOutputs !== null &&
          !Array.isArray(rawBody.pinnedOutputs)
        ) {
          for (const [pNodeId, pVal] of Object.entries(
            rawBody.pinnedOutputs as Record<string, unknown>,
          )) {
            pinnedOutputsMap[pNodeId] = pVal;
          }
        }
      }

      const runRequestPayload = {
        runId,
        project,
        workflowId,
        revision: projectState.revision,
        triggerType:
          typeof rawBody.triggerType === "string" ? rawBody.triggerType : "manual",
        triggerPayload,
        workspaceId: runWorkspace.workspaceId,
        ...(usePinnedOutputs
          ? { usePinnedOutputs: true, pinnedOutputs: pinnedOutputsMap }
          : {}),
        graph: {
          nodes: (workflow.nodes ?? []).map((n) => ({
            id: n.id,
            type: n.type,
            data: (n.data as Record<string, unknown> | undefined) ?? {},
          })),
          edges: (workflow.edges ?? []).map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
            ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
          })),
        },
      };

      // Story 1.17: signed with the project's derived control-plane secret, with a fresh one-time requestId.
      const telemetrySecret = await requireProjectSecret(c.env, project, "control-plane");
      const workerReq = await signedExecutingRequest("/__px/runs", runRequestPayload, telemetrySecret);

      const webhookUrl = `http://localhost/api/projects/${encodeURIComponent(
        project,
      )}/telemetry/webhook`;

      let runtimeExecutors: Executors;
      try {
        runtimeExecutors = studioExecutorsFor(appOptions.executors, c.env);
      } catch (error) {
        return c.json(executorsNotConfiguredBody(error), 503);
      }
      const workerRes = await handleWorkflowRunRequest(workerReq, {
        registry: runtimeRegistry,
        executors: runtimeExecutors,
        db,
        telemetryProjectId: project,
        env: runEnv,
        ...(connections ? { connections } : {}),
        pxEnv: targetEnv,
        telemetrySecret,
        telemetryWebhookUrl: webhookUrl,
        telemetryWebhookSecret: await requireProjectSecret(c.env, project, "telemetry-webhook"),
        telemetryWebhookFetcher: async (input, init) =>
          app.fetch(new Request(input, init), c.env),
        secretValues,
      });

      if (!workerRes) {
        return c.json(
          {
            error: {
              code: "WORKFLOW_RUN_DISPATCH_FAILED",
              message: "Worker run handler did not match /__px/runs",
            },
          },
          500,
        );
      }

      const resultBody = (await workerRes.json()) as WorkflowRunResponse;
      if (workerRes.status !== 200) {
        return c.json(resultBody, workerRes.status as 400 | 401 | 403 | 422);
      }

      await recordStudioOnboardingEvent(db, {
        orgId: authz.orgId,
        projectId: project,
        actorId: resolved.caller.author.id,
        step: "first_test_step_run",
        metadata: {
          runId: resultBody.runId,
          workflowId,
          revision: projectState.revision,
          env: targetEnv,
        },
        onlyOncePerProject: true,
      });

      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "workflow.run",
        status: String(resultBody.status) === "failed" ? "failed" : "succeeded",
        details: {
          runId: resultBody.runId,
          workflowId,
          revision: projectState.revision,
          env: targetEnv,
          ...(resolved.caller.author.client
            ? { client: resolved.caller.author.client }
            : {}),
        },
      });

      return c.json(
        {
          ...resultBody,
          env: targetEnv,
        },
        200,
      );
  };

  app.post(
    "/api/projects/:project/workflows/:workflowId/runs",
    handleExecuteWorkflowRun,
  );
  app.post(
    "/api/projects/:project/workflows/:workflowId/run",
    handleExecuteWorkflowRun,
  );

  app.get("/api/projects/:project/runs", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const envParam = c.req.query("env") === "production" ? "production" : "preview";
    const workflowId = c.req.query("workflowId") ?? undefined;
    const status = c.req.query("status") ?? undefined;
    const trigger =
      c.req.query("trigger") ?? c.req.query("triggerType") ?? undefined;
    const from = c.req.query("from") ?? undefined;
    const to = c.req.query("to") ?? undefined;
    const cursor = c.req.query("cursor") ?? undefined;
    const limitRaw = c.req.query("limit");
    const limit =
      limitRaw !== undefined && Number.isFinite(Number(limitRaw))
        ? Math.max(1, Math.min(200, Math.floor(Number(limitRaw))))
        : 50;

    const page = await queryRunHistory(db, studioTelemetryScope(project, c.req.query("workspaceId")), {
      ...(workflowId ? { workflowId } : {}),
      ...(status ? { status } : {}),
      ...(trigger ? { trigger } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
    });

    return c.json(
      {
        project,
        env: envParam,
        runs: page.runs,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      },
      200,
    );
  });

  app.post("/api/projects/:project/runs/prune", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    let rawBody: Record<string, unknown> = {};
    try {
      const parsed = await c.req.json();
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        rawBody = parsed as Record<string, unknown>;
      }
    } catch {
      rawBody = {};
    }

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      typeof rawBody.orgId === "string"
        ? rawBody.orgId
        : (c.req.query("orgId") ?? c.req.header("x-org-id")),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const retentionDays =
      rawBody.retentionDays !== undefined
        ? (rawBody.retentionDays as number | string)
        : (c.req.query("retentionDays") ?? undefined);
    const nowParam =
      typeof rawBody.now === "string" || typeof rawBody.now === "number"
        ? rawBody.now
        : undefined;

    // Story 16: px_runs has no project or org column, so this prune deletes expired runs of every org. Only a platform
    // operator may run it; a project's own builders and MCP tokens are refused.
    const pruneRefusal = refuseNonPlatformOperator(c.env, resolved.caller);
    if (pruneRefusal) {
      return c.json({ error: pruneRefusal }, 403);
    }

    const pruned: PruneTelemetryResult = await pruneExpiredTelemetryRuns(db, {
      ...(retentionDays !== undefined ? { retentionDays } : {}),
      ...(nowParam !== undefined ? { now: nowParam } : {}),
    });

    return c.json(
      {
        ok: true,
        project,
        ...pruned,
      },
      200,
    );
  });

  app.get("/api/projects/:project/runs/:runId", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const runId = c.req.param("runId");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const envParam = c.req.query("env") === "production" ? "production" : "preview";
    // Only this project's run: another project's run id is not found here (404), never read across (story 1.4).
    const projectScope = { projectId: project };
    let run = await getRunRecord(db, runId, projectScope);
    let stepEvents = run ? await listStepEventsForRun(db, runId, projectScope) : [];

    const stub = getBlueprintStub(c.env, project);
    if (!run || stepEvents.length === 0) {
      const doTelRes = await stub.fetch(
        `http://blueprint-do/telemetry?project=${encodeURIComponent(project)}&runId=${encodeURIComponent(runId)}`,
        { method: "GET" },
      );
      if (doTelRes.ok) {
        const doTel = (await doTelRes.json()) as {
          runs?: RunRecord[];
          events?: StepEvent[];
        };
        if (!run) {
          run = (doTel.runs ?? []).find((r) => r.runId === runId) ?? null;
        }
        if (stepEvents.length === 0 && Array.isArray(doTel.events)) {
          stepEvents = doTel.events;
        }
      }
    }

    if (!run) {
      return c.json(
        {
          error: {
            code: "RUN_NOT_FOUND",
            message: `Run "${runId}" not found in project "${project}"`,
          },
        },
        404,
      );
    }

    const currentStateRes = await stub.fetch(
      `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
      { method: "GET" },
    );
    const currentStatePayload = (await currentStateRes.json()) as ProjectStatePayload;
    const currentRevision = currentStatePayload.revision;

    let historicalStatePayload: ProjectStatePayload = currentStatePayload;
    if (run.revision !== currentRevision) {
      const histRes = await stub.fetch(
        `http://blueprint-do/state?project=${encodeURIComponent(project)}&revision=${run.revision}`,
        { method: "GET" },
      );
      if (histRes.ok) {
        historicalStatePayload = (await histRes.json()) as ProjectStatePayload;
      }
    }

    const historicalWorkflow =
      (historicalStatePayload.state?.workflows ?? []).find(
        (w) => w.id === run!.workflowId,
      ) ??
      (currentStatePayload.state?.workflows ?? []).find(
        (w) => w.id === run!.workflowId,
      ) ??
      null;

    const failedNodeId =
      stepEvents.find((ev) => ev.status === "failed")?.nodeId ?? null;

    const resolvedByRunId =
      run.status === "failed"
        ? await findResolvingRetryRunId(db, run.runId, projectScope)
        : null;

    return c.json(
      {
        project,
        env: envParam,
        run: {
          ...run,
          failedNodeId,
          stepCount: new Set(stepEvents.map((e) => e.nodeId)).size,
          resolvedByRunId,
        } satisfies RunHistorySummary,
        stepEvents,
        currentRevision,
        historicalRevision: run.revision,
        isHistoricalRevision: run.revision !== currentRevision,
        historicalState: historicalStatePayload.state,
        historicalWorkflow,
      },
      200,
    );
  });

  app.get(
    "/api/projects/:project/workflows/:workflowId/pins",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project") ?? "";
      const workflowId = c.req.param("workflowId") ?? "";
      if (!PROJECT_SLUG_PATTERN.test(project)) {
        return c.json(
          {
            error: {
              code: "INVALID_PROJECT_SLUG",
              message: `Invalid project slug "${project}"`,
            },
          },
          400,
        );
      }

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "read",
        c.req.query("orgId") ?? c.req.header("x-org-id"),
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      const stub = getBlueprintStub(c.env, project);
      const pinsRes = await stub.fetch(
        `http://blueprint-do/pins?project=${encodeURIComponent(
          project,
        )}&workflowId=${encodeURIComponent(workflowId)}`,
        { method: "GET" },
      );
      const body = (await pinsRes.json()) as {
        project: string;
        workflowId: string;
        pinnedOutputs: Record<string, PinnedNodeOutput>;
      };
      return c.json(body, 200);
    },
  );

  app.put(
    "/api/projects/:project/workflows/:workflowId/nodes/:nodeId/pin",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project") ?? "";
      const workflowId = c.req.param("workflowId") ?? "";
      const nodeId = c.req.param("nodeId");
      if (!PROJECT_SLUG_PATTERN.test(project)) {
        return c.json(
          {
            error: {
              code: "INVALID_PROJECT_SLUG",
              message: `Invalid project slug "${project}"`,
            },
          },
          400,
        );
      }

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      let rawBody: Record<string, unknown> = {};
      try {
        const parsed = await c.req.json();
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          rawBody = parsed as Record<string, unknown>;
        }
      } catch {
        rawBody = {};
      }

      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "mutate",
        typeof rawBody.orgId === "string"
          ? rawBody.orgId
          : (c.req.query("orgId") ?? c.req.header("x-org-id")),
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      // Unseal project secrets so pinned payloads are strictly redacted before storage (AC 1)
      const vaultRows = await db
        .prepare(
          "SELECT ref, ciphertext_b64, iv_b64 FROM studio_secret_vault WHERE project_id = ? AND status = 'valid'",
        )
        .bind(project)
        .all<{ ref: string; ciphertext_b64: string; iv_b64: string }>();

      const vaultKeySecret = c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
      const secretValues = new Set<string>();
      for (const row of vaultRows.results ?? []) {
        try {
          const plaintext = await decryptSecretValue(
            row.ciphertext_b64,
            row.iv_b64,
            vaultKeySecret,
          );
          if (plaintext.trim().length >= 3) {
            secretValues.add(plaintext);
          }
        } catch {
          // Ignore unseal failures
        }
      }
      if (Array.isArray(rawBody.secretValues)) {
        for (const sv of rawBody.secretValues) {
          if (typeof sv === "string" && sv.trim().length >= 3) {
            secretValues.add(sv);
          }
        }
      }

      const rawOutput =
        rawBody.output !== undefined ? rawBody.output : rawBody;
      const redactedOutput = redactTelemetryPayload(rawOutput, {
        secretValues,
      });

      const stub = getBlueprintStub(c.env, project);
      const putRes = await stub.fetch(
        `http://blueprint-do/pins?project=${encodeURIComponent(project)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project,
            workflowId,
            nodeId,
            output: redactedOutput,
            sourceRunId:
              typeof rawBody.sourceRunId === "string"
                ? rawBody.sourceRunId
                : null,
          }),
        },
      );
      const putBody = (await putRes.json()) as Record<string, unknown>;
      return c.json(putBody, 200);
    },
  );

  app.delete(
    "/api/projects/:project/workflows/:workflowId/nodes/:nodeId/pin",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project") ?? "";
      const workflowId = c.req.param("workflowId") ?? "";
      const nodeId = c.req.param("nodeId");
      if (!PROJECT_SLUG_PATTERN.test(project)) {
        return c.json(
          {
            error: {
              code: "INVALID_PROJECT_SLUG",
              message: `Invalid project slug "${project}"`,
            },
          },
          400,
        );
      }

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "mutate",
        c.req.query("orgId") ?? c.req.header("x-org-id"),
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      const stub = getBlueprintStub(c.env, project);
      const delRes = await stub.fetch(
        `http://blueprint-do/pins?project=${encodeURIComponent(
          project,
        )}&workflowId=${encodeURIComponent(
          workflowId,
        )}&nodeId=${encodeURIComponent(nodeId)}`,
        { method: "DELETE" },
      );
      const delBody = (await delRes.json()) as Record<string, unknown>;
      return c.json(delBody, 200);
    },
  );

  app.post("/api/projects/:project/runs/:runId/rerun", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const sourceRunId = c.req.param("runId");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    let rawBody: Record<string, unknown> = {};
    try {
      const parsed = await c.req.json();
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        rawBody = parsed as Record<string, unknown>;
      }
    } catch {
      rawBody = {};
    }

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      typeof rawBody.orgId === "string"
        ? rawBody.orgId
        : (c.req.query("orgId") ?? c.req.header("x-org-id")),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    // The source run must be this project's: another project's run id is 404 RUN_NOT_FOUND and nothing starts.
    const projectScope = { projectId: project };
    let sourceRun = await getRunRecord(db, sourceRunId, projectScope);
    let sourceStepEvents = sourceRun ? await listStepEventsForRun(db, sourceRunId, projectScope) : [];

    const stub = getBlueprintStub(c.env, project);
    if (!sourceRun || sourceStepEvents.length === 0) {
      const doTelRes = await stub.fetch(
        `http://blueprint-do/telemetry?project=${encodeURIComponent(
          project,
        )}&runId=${encodeURIComponent(sourceRunId)}`,
        { method: "GET" },
      );
      if (doTelRes.ok) {
        const doTel = (await doTelRes.json()) as {
          runs?: RunRecord[];
          events?: StepEvent[];
        };
        if (!sourceRun) {
          sourceRun =
            (doTel.runs ?? []).find((r) => r.runId === sourceRunId) ?? null;
        }
        if (sourceStepEvents.length === 0 && Array.isArray(doTel.events)) {
          sourceStepEvents = doTel.events;
        }
      }
    }

    if (!sourceRun) {
      return c.json(
        {
          error: {
            code: "RUN_NOT_FOUND",
            message: `Source run "${sourceRunId}" not found in project "${project}"`,
          },
        },
        404,
      );
    }

    const failedStep = sourceStepEvents.find((ev) => ev.status === "failed");
    const fromNodeId =
      typeof rawBody.fromNodeId === "string" && rawBody.fromNodeId.trim()
        ? rawBody.fromNodeId.trim()
        : (failedStep?.nodeId ?? "");

    if (!fromNodeId) {
      return c.json(
        {
          error: {
            code: "MISSING_FROM_NODE_ID",
            message:
              'Provide { fromNodeId: "<nodeId>" } to specify the starting node for partial re-run.',
          },
        },
        422,
      );
    }

    const useCurrentDraftRev = rawBody.useCurrentDraftRev !== false;
    const currentStateRes = await stub.fetch(
      `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
      { method: "GET" },
    );
    const currentStatePayload =
      (await currentStateRes.json()) as ProjectStatePayload;

    let targetStatePayload: ProjectStatePayload = currentStatePayload;
    if (!useCurrentDraftRev && sourceRun.revision !== currentStatePayload.revision) {
      const histRes = await stub.fetch(
        `http://blueprint-do/state?project=${encodeURIComponent(
          project,
        )}&revision=${sourceRun.revision}`,
        { method: "GET" },
      );
      if (histRes.ok) {
        targetStatePayload = (await histRes.json()) as ProjectStatePayload;
      }
    }

    const workflow =
      (targetStatePayload.state?.workflows ?? []).find(
        (w) => w.id === sourceRun!.workflowId,
      ) ??
      (currentStatePayload.state?.workflows ?? []).find(
        (w) => w.id === sourceRun!.workflowId,
      );

    if (!workflow) {
      return c.json(
        {
          error: {
            code: "WORKFLOW_NOT_FOUND",
            message: `Workflow "${sourceRun.workflowId}" not found in project "${project}"`,
          },
        },
        404,
      );
    }

    const vaultRows = await db
      .prepare(
        "SELECT ref, ciphertext_b64, iv_b64 FROM studio_secret_vault WHERE project_id = ? AND status = 'valid'",
      )
      .bind(project)
      .all<{ ref: string; ciphertext_b64: string; iv_b64: string }>();

    const vaultKeySecret = c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
    const unsealedByRef = new Map<string, string>();
    const secretValues = new Set<string>();

    for (const row of vaultRows.results ?? []) {
      try {
        const plaintext = await decryptSecretValue(
          row.ciphertext_b64,
          row.iv_b64,
          vaultKeySecret,
        );
        unsealedByRef.set(row.ref, plaintext);
        if (plaintext.trim().length >= 3) {
          secretValues.add(plaintext);
        }
      } catch {
        // Ignore unseal failures
      }
    }

    const targetEnv =
      typeof rawBody.env === "string" &&
      (rawBody.env === "preview" || rawBody.env === "production")
        ? rawBody.env
        : "preview";

    // Story 17: brick executors write the app's tables; never into STUDIO_DB.
    const rerunDataDb = await resolveRunDataDb(c.env, db, project, authz.orgId, targetEnv);
    if (!rerunDataDb) {
      return projectDataStoreNotConfigured(project, targetEnv);
    }
    const runEnv: Record<string, unknown> = {
      DB: rerunDataDb,
      PX_ENV: targetEnv,
    };
    for (const [ref, plaintext] of unsealedByRef.entries()) {
      runEnv[ref] = plaintext;
    }
    for (const binding of targetStatePayload.state?.secretRefs ?? []) {
      const val = unsealedByRef.get(binding.ref);
      if (val !== undefined) {
        runEnv[binding.secretName] = val;
      }
    }
    // Without Studio's root secret nothing can be signed: 503, as the other signing routes answer.
    if (!(await studioProjectSecret(c.env, project, "control-plane"))) return signingSecretNotConfigured();
    // Story 1.17: the project's own bindings (derived secrets only, never the root), applied last.
    Object.assign(runEnv, await projectWorkerSecretBindings(c.env, project));

    const newRunId =
      typeof rawBody.runId === "string" && rawBody.runId.trim().length > 0
        ? rawBody.runId.trim()
        : `run_retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const rerunPayload = {
      runId: newRunId,
      project,
      workflowId: sourceRun.workflowId,
      revision: targetStatePayload.revision,
      triggerType: sourceRun.triggerType ?? "manual",
      triggerPayload: rawBody.triggerPayload ?? {},
      workspaceId: sourceRun.workspaceId ?? STUDIO_PREVIEW_WORKSPACE,
      sourceRunId,
      fromNodeId,
      seededStepEvents: sourceStepEvents.map((ev) => ({
        ...ev,
        workspaceId: ev.workspaceId || sourceRun!.workspaceId,
      })),
      graph: {
        nodes: (workflow.nodes ?? []).map((n) => ({
          id: n.id,
          type: n.type,
          data: (n.data as Record<string, unknown> | undefined) ?? {},
        })),
        edges: (workflow.edges ?? []).map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
          ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
        })),
      },
    };

    // Story 1.17: signed with the project's derived control-plane secret, with a fresh one-time requestId. The rerun
    // keeps the stored run's workspace.
    const telemetrySecret = await requireProjectSecret(c.env, project, "control-plane");
    const workerReq = await signedExecutingRequest("/__px/runs/rerun", rerunPayload, telemetrySecret);

    const webhookUrl = `http://localhost/api/projects/${encodeURIComponent(
      project,
    )}/telemetry/webhook`;

    let runtimeExecutors: Executors;
    try {
      runtimeExecutors = studioExecutorsFor(appOptions.executors, c.env);
    } catch (error) {
      return c.json(executorsNotConfiguredBody(error), 503);
    }
    const workerRes = await handleWorkflowRerunRequest(workerReq, {
      registry: runtimeRegistry,
      executors: runtimeExecutors,
      db,
      telemetryProjectId: project,
      env: runEnv,
      pxEnv: targetEnv,
      telemetrySecret,
      telemetryWebhookUrl: webhookUrl,
        telemetryWebhookSecret: await requireProjectSecret(c.env, project, "telemetry-webhook"),
      telemetryWebhookFetcher: async (input, init) =>
        app.fetch(new Request(input, init), c.env),
      secretValues,
    });

    if (!workerRes) {
      return c.json(
        {
          error: {
            code: "WORKFLOW_RERUN_DISPATCH_FAILED",
            message: "Worker rerun handler did not match /__px/runs/rerun",
          },
        },
        500,
      );
    }

    const resultBody = (await workerRes.json()) as Record<string, unknown>;
    if (workerRes.status !== 200) {
      return c.json(resultBody, workerRes.status as 400 | 401 | 404 | 422);
    }

    return c.json(
      {
        ...resultBody,
        sourceRunId,
        fromNodeId,
        env: targetEnv,
      },
      200,
    );
  });

  const CreateCloudflareTokenBodySchema = z.object({
    accountId: z.string().regex(/^[a-fA-F0-9]{32}$/),
    accountName: z.string().min(1).max(120).optional(),
    token: z.string().min(8).max(512).optional(),
    apiToken: z.string().min(8).max(512).optional(),
    scopes: z.array(z.string().min(1)).optional(),
  });

  async function authorizeOrgTokenCustody(
    db: StudioApiEnv["STUDIO_DB"],
    caller: StudioCaller,
    orgId: string,
    mode: "read" | "connect",
    options: { allowMcpToken?: boolean } = {},
  ): Promise<
    | { ok: true; role: StudioOrgRole }
    | { ok: false; status: 403; error: { code: string; message: string } }
  > {
    // Story 16: org-level routes (cloudflare-tokens, onboarding, environments overview) are for signed-in people; an MCP
    // token is bound to one project.
    if (caller.kind === "mcp_token" && !options.allowMcpToken) {
      return { ok: false, status: 403, error: refuseMcpTokenOnOrgRoute(caller)! };
    }
    if (caller.kind === "mcp_token" && caller.orgId !== orgId) {
      return {
        ok: false,
        status: 403,
        error: {
          code: "FORBIDDEN_ORG",
          message: "Access denied: MCP token is scoped to another organization",
        },
      };
    }

    const memberRow = await db
      .prepare(
        "SELECT role FROM studio_org_members WHERE org_id = ? AND user_id = ? LIMIT 1",
      )
      .bind(orgId, caller.userId)
      .first<{ role: StudioOrgRole }>();

    const role =
      memberRow?.role ?? (caller.kind === "mcp_token" ? caller.orgRole : null);

    if (!role) {
      return {
        ok: false,
        status: 403,
        error: {
          code: "FORBIDDEN_ORG",
          message: "Caller is not a member of this organization",
        },
      };
    }

    if (mode === "read") {
      if (caller.kind === "mcp_token") {
        const hasReadOrConnect =
          caller.scopes.includes("read") ||
          caller.scopes.includes("connect");
        if (!hasReadOrConnect) {
          return {
            ok: false,
            status: 403,
            error: {
              code: "INSUFFICIENT_SCOPE",
              message: "MCP token requires 'read' or 'connect' scope",
            },
          };
        }
      }
      return { ok: true, role };
    }

    const isEditorOrHigher =
      role === "owner" || role === "admin" || role === "builder";
    if (!isEditorOrHigher) {
      return {
        ok: false,
        status: 403,
        error: {
          code: "FORBIDDEN_ROLE",
          message: "Requires role >= editor (owner, admin, or builder) to manage Cloudflare tokens",
        },
      };
    }

    if (caller.kind === "mcp_token") {
      const hasConnectScope =
        caller.scopes.includes("connect");
      if (!hasConnectScope) {
        return {
          ok: false,
          status: 403,
          error: {
            code: "INSUFFICIENT_SCOPE",
            message: "MCP token requires 'connect' scope to manage Cloudflare tokens",
          },
        };
      }
    }

    return { ok: true, role };
  }

  app.post("/api/orgs/:orgId/cloudflare-tokens", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "connect",
    );
    if (!authz.ok) {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "cloudflare_token.create",
        status: "forbidden",
        details: { code: authz.error.code },
      });
      return c.json({ error: authz.error }, authz.status);
    }

    const parsed = CreateCloudflareTokenBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_CLOUDFLARE_TOKEN_BODY",
            issues: parsed.error.issues,
          },
        },
        400,
      );
    }

    const plaintextToken = (parsed.data.token ?? parsed.data.apiToken ?? "").trim();
    if (!plaintextToken) {
      return c.json(
        {
          error: {
            code: "MISSING_TOKEN",
            message: "Provide a Cloudflare API token",
          },
        },
        400,
      );
    }

    const metadata = await sealDeployToken(
      db,
      {
        orgId,
        accountId: parsed.data.accountId,
        accountName: parsed.data.accountName,
        plaintextToken,
        scopes: parsed.data.scopes,
        createdBy: resolved.caller.author.id,
      },
      c.env,
    );

    await recordStudioAuditLog(db, {
      orgId,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "cloudflare_token.create",
      status: "succeeded",
      details: {
        tokenRef: metadata.tokenRef,
        accountId: metadata.accountId,
        tokenLast4: metadata.tokenLast4,
      },
    });

    return c.json(
      {
        ...metadata,
        token: metadata,
      },
      201,
    );
  });

  app.get("/api/orgs/:orgId/cloudflare-tokens", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "read",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const tokens = await listOrgDeployTokens(db, orgId);
    return c.json({ orgId, tokens }, 200);
  });

  app.get("/api/orgs/:orgId/cloudflare-tokens/:tokenRef/audit", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const tokenRef = c.req.param("tokenRef");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "read",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const entries = await listDeployTokenAuditLog(db, { orgId, tokenRef });
    return c.json({ orgId, tokenRef, entries }, 200);
  });

  app.delete("/api/orgs/:orgId/cloudflare-tokens/:tokenRef", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const tokenRef = c.req.param("tokenRef");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "connect",
    );
    if (!authz.ok) {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "cloudflare_token.revoke",
        status: "forbidden",
        details: { tokenRef, code: authz.error.code },
      });
      return c.json({ error: authz.error }, authz.status);
    }

    try {
      const revoked = await revokeDeployToken(db, tokenRef, {
        orgId,
        actor: resolved.caller.author.id,
        deployId: "revoke",
      });

      await db
        .prepare("UPDATE project_environments SET status = 'token_revoked', updated_at = ? WHERE org_id = ? AND token_ref = ?")
        .bind(revoked.revokedAt, orgId, tokenRef)
        .run();

      await recordOnboardingFunnelEvent(db, {
        orgId,
        actorId: resolved.caller.author.id,
        step: "token_disconnected",
        metadata: { tokenRef },
      });

      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "cloudflare_token.revoke",
        status: "succeeded",
        details: {
          tokenRef: revoked.tokenRef,
          revokedAt: revoked.revokedAt,
        },
      });

      return c.json(
        {
          ok: true,
          ...revoked,
          workersKeepRunningMessage:
            "Disconnected from ProjectX Studio. Your already-deployed Cloudflare Workers and D1 databases continue running in your Cloudflare account.",
        },
        200,
      );
    } catch (err) {
      if (err instanceof DeployTokenVaultError && err.code === "TOKEN_NOT_FOUND") {
        return c.json(
          {
            error: {
              code: "TOKEN_NOT_FOUND",
              message: err.message,
            },
          },
          404,
        );
      }
      throw err;
    }
  });

  app.get("/api/orgs/:orgId/cloudflare-tokens/template-url", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "read",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const template = buildCloudflareTokenTemplateUrl();
    return c.json({ orgId, ...template }, 200);
  });

  const FunnelEventBodySchema = z.object({
    step: z.enum([
      "wizard_opened",
      "template_link_clicked",
      "token_submitted",
      "verification_failed",
      "verification_succeeded",
      "token_disconnected",
    ]),
    projectId: z.string().min(1).max(128).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });

  app.post("/api/orgs/:orgId/cloudflare-tokens/funnel-event", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "read",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const parsed = FunnelEventBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_FUNNEL_EVENT",
            issues: parsed.error.issues,
          },
        },
        400,
      );
    }

    const event = await recordOnboardingFunnelEvent(db, {
      orgId,
      projectId: parsed.data.projectId ?? null,
      actorId: resolved.caller.author.id,
      step: parsed.data.step,
      metadata: parsed.data.metadata ?? null,
    });

    return c.json({ ok: true, event }, 201);
  });

  app.get("/api/orgs/:orgId/cloudflare-tokens/funnel-events", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "read",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const stepParam = c.req.query("step") as OnboardingFunnelStep | undefined;
    const projectIdParam = c.req.query("projectId") ?? undefined;
    const events = await listOnboardingFunnelEvents(db, {
      orgId,
      step: stepParam,
      projectId: projectIdParam,
    });

    return c.json({ orgId, events }, 200);
  });

  const StudioOnboardingEventBodySchema = z.object({
    step: z.enum(STUDIO_ONBOARDING_STEPS),
    projectId: z.string().min(1).max(128).optional(),
    project: z.string().min(1).max(128).optional(),
    orgId: z.string().min(1).max(128).optional(),
    templateId: z.string().min(1).max(128).optional(),
    source: z.string().min(1).max(128).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });

  app.post("/api/orgs/:orgId/onboarding-events", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "read",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const parsed = StudioOnboardingEventBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_ONBOARDING_EVENT",
            issues: parsed.error.issues,
          },
        },
        400,
      );
    }

    const event = await recordStudioOnboardingEvent(db, {
      orgId,
      projectId: parsed.data.projectId ?? parsed.data.project ?? null,
      actorId: resolved.caller.author.id,
      step: parsed.data.step,
      templateId: parsed.data.templateId ?? null,
      source: parsed.data.source ?? null,
      metadata: parsed.data.metadata ?? null,
    });

    return c.json({ ok: true, event }, 201);
  });

  app.get("/api/orgs/:orgId/onboarding-events", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "read",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const stepParam = c.req.query("step") as StudioOnboardingStep | undefined;
    const projectIdParam = c.req.query("projectId") ?? c.req.query("project") ?? undefined;
    const events = await listStudioOnboardingEvents(db, {
      orgId,
      step: stepParam,
      projectId: projectIdParam,
    });

    return c.json({ orgId, events }, 200);
  });

  app.post("/api/onboarding/events", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const parsed = StudioOnboardingEventBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_ONBOARDING_EVENT",
            issues: parsed.error.issues,
          },
        },
        400,
      );
    }

    // Story 16: an MCP token records only in its own org; a session's client-sent org only selects among its own orgs.
    let orgId: string;
    if (resolved.caller.kind === "mcp_token") {
      orgId = resolved.caller.orgId;
    } else {
      const chosen = await chooseSessionCreateOrg(
        db,
        resolved.caller.userId,
        parsed.data.orgId ?? c.req.query("orgId") ?? c.req.header("x-org-id") ?? undefined,
      );
      if (!chosen.ok) {
        return c.json({ error: chosen.error }, chosen.status);
      }
      orgId = chosen.orgId;
    }

    const authz = await authorizeOrgTokenCustody(db, resolved.caller, orgId, "read", {
      allowMcpToken: true,
    });
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    // A named project must belong to that org (or have no row yet); an event is never filed against another org's project.
    const eventProjectId = parsed.data.projectId ?? parsed.data.project ?? null;
    if (eventProjectId) {
      const projectRow = await db
        .prepare("SELECT org_id FROM projects WHERE project_id = ? LIMIT 1")
        .bind(eventProjectId)
        .first<{ org_id: string }>();
      if (
        (projectRow && projectRow.org_id !== orgId) ||
        (resolved.caller.kind === "mcp_token" && eventProjectId !== resolved.caller.projectId)
      ) {
        return c.json(
          { error: { code: "FORBIDDEN_PROJECT", message: "Project belongs to another organization or token" } },
          403,
        );
      }
    }

    const event = await recordStudioOnboardingEvent(db, {
      orgId,
      projectId: parsed.data.projectId ?? parsed.data.project ?? null,
      actorId: resolved.caller.author.id,
      step: parsed.data.step,
      templateId: parsed.data.templateId ?? null,
      source: parsed.data.source ?? null,
      metadata: parsed.data.metadata ?? null,
    });

    return c.json({ ok: true, event }, 201);
  });

  app.get("/api/admin/onboarding-funnel", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    // Story 16: platform operators only (PX_PLATFORM_OPERATORS); MCP tokens never.
    const operatorRefusal = refuseNonPlatformOperator(c.env, resolved.caller);
    if (operatorRefusal) {
      return c.json({ error: operatorRefusal }, 403);
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    // A platform operator may read one org's funnel (query `orgId`) or every org's.
    const requestedOrgId = c.req.query("orgId") ?? undefined;

    const report = await computeOnboardingFunnelAnalytics(db, {
      orgId: requestedOrgId,
    });

    return c.json(report, 200);
  });

  app.post("/api/admin/beta-cohort/provision", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    // Story 16: platform operators only (PX_PLATFORM_OPERATORS); MCP tokens never.
    const operatorRefusal = refuseNonPlatformOperator(c.env, resolved.caller);
    if (operatorRefusal) {
      return c.json({ error: operatorRefusal }, 403);
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = await c.req.json().catch(() => null);
    const parsed = CohortProvisionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_COHORT_PROVISION_REQUEST",
            message: parsed.error.issues.map((i) => i.message).join("; "),
            issues: parsed.error.issues,
          },
        },
        400,
      );
    }

    const outcome = await provisionBetaCohortPartners(db, parsed.data);
    if (!outcome.ok) {
      return c.json({ error: outcome.error }, outcome.status);
    }

    await recordStudioAuditLog(db, {
      orgId: outcome.partners[0]?.orgId ?? "org_default",
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "beta_cohort.provision",
      status: "succeeded",
      targetRef: outcome.cohortId,
      details: {
        cohortId: outcome.cohortId,
        partnerCount: outcome.partners.length,
        composition: outcome.metrics.composition,
      },
      request: c.req.raw,
    });

    return c.json(outcome, 201);
  });

  app.get("/api/admin/beta-metrics", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    // Story 16: platform operators only (PX_PLATFORM_OPERATORS); MCP tokens never.
    const operatorRefusal = refuseNonPlatformOperator(c.env, resolved.caller);
    if (operatorRefusal) {
      return c.json({ error: operatorRefusal }, 403);
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const cohortId = c.req.query("cohortId") ?? "cohort-1";
    const metrics = await computeCohortBetaMetrics(db, { cohortId });
    return c.json(metrics, 200);
  });

  const VerifyAndSaveBodySchema = z.object({
    token: z.string().min(1).max(512).optional(),
    apiToken: z.string().min(1).max(512).optional(),
    accountId: z.string().max(128).optional(),
    accountName: z.string().max(120).optional(),
    projectId: z.string().max(128).optional(),
    project: z.string().max(128).optional(),
    replaceTokenRef: z.string().max(128).optional(),
  });

  app.post("/api/orgs/:orgId/cloudflare-tokens/verify-and-save", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    // Architecture AD-S12: Reject MCP agent bearer tokens — interactive human consent required
    if (resolved.caller.kind === "mcp_token") {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "cloudflare_token.verify_and_save",
        status: "forbidden",
        details: { code: "HUMAN_CONSENT_REQUIRED" },
      });
      return c.json(
        {
          error: {
            code: "HUMAN_CONSENT_REQUIRED",
            message:
              "Connecting a Cloudflare deploy target requires interactive human consent in ProjectX Studio.",
            studioUrl: "/?nav=connections&wizard=connect-cloudflare",
          },
        },
        403,
      );
    }

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "connect",
    );
    if (!authz.ok) {
      await recordStudioAuditLog(db, {
        orgId,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "cloudflare_token.verify_and_save",
        status: "forbidden",
        details: { code: authz.error.code },
      });
      return c.json({ error: authz.error }, authz.status);
    }

    const parsed = VerifyAndSaveBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_VERIFY_BODY",
            issues: parsed.error.issues,
          },
        },
        400,
      );
    }

    const plaintextToken = (
      parsed.data.token ??
      parsed.data.apiToken ??
      ""
    ).trim();
    const requestedProject =
      parsed.data.projectId?.trim() || parsed.data.project?.trim() || null;

    await recordOnboardingFunnelEvent(db, {
      orgId,
      projectId: requestedProject,
      actorId: resolved.caller.author.id,
      step: "token_submitted",
      metadata: {
        hasRequestedAccountId: Boolean(parsed.data.accountId?.trim()),
      },
    });

    const verified = await verifyDeployTokenForRoute(
      c.env,
      plaintextToken,
      parsed.data.accountId,
    );
    if (!verified.ok) return verified.response;
    const verification = verified.report;

    if (!verification.ok || !verification.accountId) {
      await recordOnboardingFunnelEvent(db, {
        orgId,
        projectId: requestedProject,
        actorId: resolved.caller.author.id,
        step: "verification_failed",
        metadata: {
          status: verification.status,
          isGlobalApiKey: verification.isGlobalApiKey,
          missingPermissionIds: verification.missingPermissionIds,
          missingPermissionLabels: verification.missingPermissionLabels,
        },
      });

      const errorCode = verification.isGlobalApiKey
        ? "GLOBAL_API_KEY_REJECTED"
        : verification.status !== "active"
          ? "INVALID_OR_EXPIRED_TOKEN"
          : "MISSING_REQUIRED_PERMISSIONS";

      return c.json(
        {
          ...verification,
          ok: false,
          verification,
          error: {
            code: errorCode,
            message: verification.summaryMessage,
            missingPermissionIds: verification.missingPermissionIds,
            missingPermissionLabels: verification.missingPermissionLabels,
            remediationUrl: verification.remediationUrl,
            permissions: verification.permissions,
          },
        },
        422,
      );
    }

    if (parsed.data.replaceTokenRef) {
      await revokeDeployToken(db, parsed.data.replaceTokenRef, {
        orgId,
        actor: resolved.caller.author.id,
        deployId: "replace",
      }).catch(() => {});
    }

    const resolvedAccountName =
      parsed.data.accountName?.trim() ||
      verification.accountName ||
      "Cloudflare Account";

    const metadata = await sealDeployToken(
      db,
      {
        orgId,
        accountId: verification.accountId,
        accountName: resolvedAccountName,
        plaintextToken,
        scopes: verification.permissions
          .filter((p) => p.granted)
          .map((p) => p.label),
        createdBy: resolved.caller.author.id,
      },
      c.env,
    );

    const orgProjectRows = await db
      .prepare("SELECT project_id FROM projects WHERE org_id = ? ORDER BY project_id ASC")
      .bind(orgId)
      .all<{ project_id: string }>();

    const projectSet = new Set<string>();
    if (requestedProject) {
      projectSet.add(requestedProject);
    }
    for (const r of orgProjectRows.results ?? []) {
      projectSet.add(r.project_id);
    }
    if (projectSet.size === 0) {
      projectSet.add("default-project");
    }

    const environments = await upsertProjectDeployEnvironments(db, {
      orgId,
      projectIds: [...projectSet],
      accountId: metadata.accountId,
      accountName: metadata.accountName,
      tokenRef: metadata.tokenRef,
    });

    await recordOnboardingFunnelEvent(db, {
      orgId,
      projectId: requestedProject,
      actorId: resolved.caller.author.id,
      step: "verification_succeeded",
      metadata: {
        tokenRef: metadata.tokenRef,
        accountId: metadata.accountId,
        accountName: metadata.accountName,
        environments: ["preview", "production"],
      },
    });

    await recordStudioAuditLog(db, {
      orgId,
      projectId: requestedProject,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "cloudflare_token.verify_and_save",
      status: "succeeded",
      details: {
        tokenRef: metadata.tokenRef,
        accountId: metadata.accountId,
        accountName: metadata.accountName,
        tokenLast4: metadata.tokenLast4,
      },
    });

    return c.json(
      {
        ok: true,
        token: metadata,
        tokenRef: metadata.tokenRef,
        accountId: metadata.accountId,
        accountName: metadata.accountName,
        verification,
        environments,
      },
      201,
    );
  });

  app.post("/api/orgs/:orgId/cloudflare-tokens/:tokenRef/recheck", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const tokenRef = c.req.param("tokenRef");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "connect",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const existingMeta = await getDeployTokenMetadata(db, tokenRef, orgId);
    if (!existingMeta) {
      return c.json(
        {
          error: {
            code: "TOKEN_NOT_FOUND",
            message: `Deploy token "${tokenRef}" not found`,
          },
        },
        404,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      token?: string;
      simulatedStatus?: "active" | "expired" | "revoked" | "disabled";
    };

    if (existingMeta.status === "revoked" && !body.token) {
      // Revoked in Studio: nothing to ask Cloudflare. The report is made locally.
      const revokedReport = inactiveTokenReport("disabled");
      return c.json(
        {
          ok: false,
          token: existingMeta,
          verification: revokedReport,
        },
        200,
      );
    }

    // simulatedStatus is a test hook understood only by the fake client; the real client always checks the stored token.
    const simulatedStatus =
      studioDeployClientMode(c.env) === "fake" ? body.simulatedStatus : undefined;
    let tokenToVerify: string;
    if (simulatedStatus === "expired") {
      tokenToVerify = "cf_expired_token";
    } else if (
      simulatedStatus === "revoked" ||
      simulatedStatus === "disabled"
    ) {
      tokenToVerify = "cf_revoked_token";
    } else if (body.token && body.token.trim().length > 0) {
      tokenToVerify = body.token.trim();
    } else {
      tokenToVerify = await decryptToken(
        db,
        tokenRef,
        {
          actor: resolved.caller.author.id,
          deployId: "recheck",
          action: "recheck",
        },
        c.env,
      );
    }

    const recheckVerified = await verifyDeployTokenForRoute(
      c.env,
      tokenToVerify,
      existingMeta.accountId,
    );
    if (!recheckVerified.ok) return recheckVerified.response;
    const verification = recheckVerified.report;

    let nextStatus: DeployTokenStatus = "active";
    if (!verification.ok) {
      if (verification.status === "expired") {
        nextStatus = "expired";
      } else if (
        verification.status === "disabled" ||
        verification.status === "invalid"
      ) {
        nextStatus = "revoked";
      }
    }

    const updatedMeta = await markDeployTokenVerificationStatus(
      db,
      tokenRef,
      nextStatus,
    );

    return c.json(
      {
        ok: verification.ok,
        token: updatedMeta ?? existingMeta,
        verification,
      },
      200,
    );
  });

  app.get("/api/orgs/:orgId/environments", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const orgId = c.req.param("orgId");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeOrgTokenCustody(
      db,
      resolved.caller,
      orgId,
      "read",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const projectId = c.req.query("projectId") ?? c.req.query("project") ?? undefined;
    const environments = await listProjectDeployEnvironments(db, {
      orgId,
      projectId,
    });
    const tokens = await listOrgDeployTokens(db, orgId);
    const activeToken = tokens.find((t) => t.status === "active") ?? null;

    return c.json(
      {
        orgId,
        activeToken,
        tokens,
        environments,
      },
      200,
    );
  });

  async function computeCurrentBlueprintArtifactHashes(
    db: D1Like,
    project: string,
    current: ProjectStatePayload,
  ): Promise<CurrentBlueprintHashes> {
    if (current.revision === 0) {
      const codeHash = computeBlueprintCodeHash(current.state);
      const graphHash = computeBlueprintGraphHash(current.state);
      const buildHash = computeBlueprintBuildHash(
        current.state,
        current.state.metadata?.catalogVersion ?? DEFAULT_CATALOG_VERSION,
      );
      return {
        currentRev: 0,
        buildHash,
        codeHash,
        graphHash,
      };
    }

    const cachedRow = await db
      .prepare(
        `SELECT build_hash, code_hash, graph_hash
         FROM builds
         WHERE project_id = ? AND revision = ? AND semantic_hash = ?
         LIMIT 1`,
      )
      .bind(project, current.revision, current.semanticHash)
      .first<{
        build_hash: string;
        code_hash: string;
        graph_hash: string;
      }>();

    if (cachedRow) {
      return {
        currentRev: current.revision,
        buildHash: cachedRow.build_hash,
        codeHash: cachedRow.code_hash,
        graphHash: cachedRow.graph_hash,
      };
    }

    const assembled = assemble(toAssemblerBlueprint(current.state), catalog);
    if (assembled.ok) {
      const catalogVersion =
        current.state.metadata?.catalogVersion ?? DEFAULT_CATALOG_VERSION;
      const hashes = await computeArtifactHashes(assembled.files, {
        catalogVersion,
      });
      return {
        currentRev: current.revision,
        buildHash: hashes.buildHash,
        codeHash: hashes.codeHash,
        graphHash: hashes.graphHash,
      };
    }

    const codeHash = computeBlueprintCodeHash(current.state);
    const graphHash = computeBlueprintGraphHash(current.state);
    const buildHash = computeBlueprintBuildHash(
      current.state,
      current.state.metadata?.catalogVersion ?? DEFAULT_CATALOG_VERSION,
    );
    return {
      currentRev: current.revision,
      buildHash,
      codeHash,
      graphHash,
    };
  }

  async function loadEnvironmentDeploymentHistory(
    db: D1Like,
    project: string,
    envName: DeployEnvName,
  ) {
    const depRows = await db
      .prepare(
        `SELECT deploy_id, project_id, org_id, env_name, revision, build_hash, code_hash, graph_hash,
                action, status, reused_cached_build, live_without_redeploy, no_changes, rollback_from_deploy_id,
                worker_url, version_id, database_id, actor_id, state_json, created_at
         FROM deployments
         WHERE project_id = ? AND env_name = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .bind(project, envName)
      .all<{
        deploy_id: string;
        project_id: string;
        org_id: string;
        env_name: string;
        revision: number;
        build_hash: string;
        code_hash: string;
        graph_hash: string;
        action: string;
        status: string;
        reused_cached_build: number;
        live_without_redeploy: number;
        no_changes: number;
        rollback_from_deploy_id: string | null;
        worker_url: string;
        version_id: string;
        database_id: string;
        actor_id: string;
        state_json: string;
        created_at: string;
      }>();

    const rows = depRows.results ?? [];
    const totalCount = rows.length;
    const deployments = [];

    for (let idx = 0; idx < rows.length; idx += 1) {
      const d = rows[idx]!;
      const versionNumber = totalCount - idx;
      const versionLabel = `v${versionNumber}`;
      const stepRows = await db
        .prepare(
          `SELECT step_id, step_order, step_name, resource_kind, resource_name, action, status, summary, created_at
           FROM deployment_steps
           WHERE deploy_id = ? AND project_id = ?
           ORDER BY step_order ASC`,
        )
        .bind(d.deploy_id, project)
        .all<{
          step_id: string;
          step_order: number;
          step_name: string;
          resource_kind: string;
          resource_name: string;
          action: string;
          status: string;
          summary: string;
          created_at: string;
        }>();

      let parsedState: PersistedDeployedState = {};
      try {
        parsedState = JSON.parse(d.state_json) as PersistedDeployedState;
      } catch {
        // Ignore invalid state_json
      }

      const rollbackFromDeploymentId =
        d.rollback_from_deploy_id ??
        parsedState.rollbackFromDeploymentId ??
        null;

      deployments.push({
        deployId: d.deploy_id,
        versionNumber,
        versionLabel,
        projectId: d.project_id,
        orgId: d.org_id,
        envName: d.env_name,
        revision: Number(d.revision),
        buildHash: d.build_hash,
        codeHash: d.code_hash,
        graphHash: d.graph_hash,
        action: d.action,
        status: d.status,
        reusedCachedBuild: Boolean(d.reused_cached_build),
        liveWithoutRedeploy: Boolean(d.live_without_redeploy),
        noChanges: Boolean(d.no_changes),
        rollbackFromDeploymentId,
        workerUrl: d.worker_url,
        versionId: d.version_id,
        databaseId: d.database_id,
        actorId: d.actor_id,
        steps: stepRows.results ?? [],
        createdAt: d.created_at,
      });
    }

    return deployments;
  }

  /**
   * Verifies a deploy token for a route. The real client asks Cloudflare and needs the account id from the request (400
   * ACCOUNT_ID_REQUIRED without one); Cloudflare being unreachable is 502, never a pass.
   */
  async function verifyDeployTokenForRoute(
    env: StudioApiEnv,
    token: string,
    accountId: string | undefined,
  ): Promise<
    | { ok: true; report: Awaited<ReturnType<typeof verifyCloudflareToken>> }
    | { ok: false; response: Response }
  > {
    let client: CloudflareApiClient;
    try {
      client = getStudioVerificationClient(env, appOptions.deploy);
    } catch (error) {
      return {
        ok: false,
        response: Response.json(
          { error: { code: "DEPLOY_CLIENT_MISCONFIGURED", message: error instanceof Error ? error.message : String(error) } },
          { status: 500 },
        ),
      };
    }
    const account = accountId?.trim();
    if (!asFakeControlPlane(client) && !account) {
      return {
        ok: false,
        response: Response.json(
          {
            error: {
              code: "ACCOUNT_ID_REQUIRED",
              message: "accountId (your 32-character Cloudflare account id) is required: the token is verified against that account.",
            },
          },
          { status: 400 },
        ),
      };
    }
    try {
      return { ok: true, report: await verifyCloudflareToken(token, account || undefined, { client }) };
    } catch (error) {
      if (error instanceof RequestGuardError) {
        return { ok: false, response: Response.json({ error: { code: "GUARD_REFUSED", message: error.message } }, { status: 403 }) };
      }
      return {
        ok: false,
        response: Response.json(
          {
            error: {
              code: "CLOUDFLARE_UNREACHABLE",
              message: `Could not verify the token with Cloudflare: ${error instanceof Error ? error.message : String(error)}`,
            },
          },
          { status: 502 },
        ),
      };
    }
  }

  async function enrichEnvironmentWithDriftAndHistory(
    db: D1Like,
    project: string,
    envRecord: ProjectEnvironmentTargetRecord,
    currentHashes: CurrentBlueprintHashes,
    env: StudioApiEnv,
  ) {
    const deployedState: PersistedDeployedState =
      (envRecord.deployedState as PersistedDeployedState | null) ?? {};
    const deployments = await loadEnvironmentDeploymentHistory(
      db,
      project,
      envRecord.envName,
    );
    const latestDeployment = deployments[0] ?? null;
    const tokenMeta = await getDeployTokenMetadata(
      db,
      envRecord.target.tokenRef,
      envRecord.orgId,
    );
    const controlPlane =
      tokenMeta && tokenMeta.status === "active"
        ? getStudioControlPlane(envRecord.target.accountId, env, appOptions.deploy)
        : undefined;
    // The real client needs the decrypted token to read the account; the fake finds its own registered one.
    const driftTokenResolver =
      controlPlane && !asFakeControlPlane(controlPlane)
        ? createStudioTokenResolver(db, env)
        : undefined;

    const expectedDeployment = {
      project,
      deployedRev: envRecord.deployedRev,
      buildHash: envRecord.buildHash,
      codeHash: envRecord.codeHash,
      graphHash: envRecord.graphHash,
      appliedMigrations: deployedState.appliedMigrations ?? [],
      queues: deployedState.queues ?? [],
      cronTriggers: deployedState.cronTriggers ?? [],
      ...(deployedState.liveCodeHash ? { liveCodeHash: deployedState.liveCodeHash } : {}),
      ...(deployedState.studioVersionIds ? { trustedVersionIds: deployedState.studioVersionIds } : {}),
    };
    // Reading the account can fail (Cloudflare unreachable, a refused read). That never fails the request it is part of (a
    // deploy that has completed, the environments list): the drift is then "unknown", with the reason, and the blueprint
    // half of the report (Studio's own data) is still given.
    let drift: { status: "checked" } | { status: "unknown"; error: string } = { status: "checked" };
    let driftReport: Awaited<ReturnType<typeof checkEnvironmentDrift>>;
    try {
      driftReport = await checkEnvironmentDrift(
        envRecord.target,
        expectedDeployment,
        currentHashes,
        controlPlane,
        driftTokenResolver ? { resolveToken: driftTokenResolver } : undefined,
      );
    } catch (error) {
      drift = { status: "unknown", error: createRedactor([env.PX_TELEMETRY_SECRET ?? ""])(error instanceof Error ? error.message : String(error)) };
      driftReport = await checkEnvironmentDrift(envRecord.target, expectedDeployment, currentHashes, undefined);
    }

    return {
      ...envRecord,
      currentRev: currentHashes.currentRev,
      deployedAt:
        deployedState.deployedAt ?? latestDeployment?.createdAt ?? null,
      deployedBy:
        deployedState.deployedBy ?? latestDeployment?.actorId ?? null,
      rollbackFromDeploymentId:
        deployedState.rollbackFromDeploymentId ??
        latestDeployment?.rollbackFromDeploymentId ??
        null,
      driftReport,
      drift,
      deployments,
    };
  }

  app.get("/api/projects/:project/environments", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    let environments = await listProjectDeployEnvironments(db, {
      orgId: authz.orgId,
      projectId: project,
    });
    const tokens = await listOrgDeployTokens(db, authz.orgId);
    const activeToken = tokens.find((t) => t.status === "active") ?? null;

    if (environments.length === 0 && activeToken) {
      environments = await upsertProjectDeployEnvironments(db, {
        orgId: authz.orgId,
        projectIds: [project],
        accountId: activeToken.accountId,
        accountName: activeToken.accountName,
        tokenRef: activeToken.tokenRef,
      });
    }

    const stub = getBlueprintStub(c.env, project);
    const stateRes = await stub.fetch(
      `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
      { method: "GET" },
    );
    const current = (await stateRes.json()) as ProjectStatePayload;
    const currentHashes = await computeCurrentBlueprintArtifactHashes(
      db,
      project,
      current,
    );

    const enrichedEnvironments = [];
    for (const envRec of environments) {
      enrichedEnvironments.push(
        await enrichEnvironmentWithDriftAndHistory(
          db,
          project,
          envRec,
          currentHashes,
          c.env,
        ),
      );
    }

    const sandbox = await loadProjectSandboxSummary(db, project);

    return c.json(
      {
        project,
        orgId: authz.orgId,
        currentRevision: current.revision,
        activeToken,
        environments: enrichedEnvironments,
        sandbox,
      },
      200,
    );
  });

  const EnvironmentPlanBodySchema = z
    .object({
      rev: z.number().int().min(0).optional(),
      revision: z.number().int().min(0).optional(),
      orgId: z.string().min(1).max(128).optional(),
      migrations: z
        .array(
          z.object({
            name: z.string().min(1).max(200).optional(),
            migrationName: z.string().min(1).max(200).optional(),
            sql: z.string().min(1),
            sha256: z.string().optional(),
          }),
        )
        .optional(),
      pendingMigrations: z
        .array(
          z.object({
            name: z.string().min(1).max(200).optional(),
            migrationName: z.string().min(1).max(200).optional(),
            sql: z.string().min(1),
            sha256: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional();

  const EnvironmentDeployBodySchema = z
    .object({
      rev: z.number().int().min(0).optional(),
      revision: z.number().int().min(0).optional(),
      orgId: z.string().min(1).max(128).optional(),
      approvalId: z.string().min(1).max(128).optional(),
      confirmDestructive: z.boolean().optional(),
      confirmedMigrationNames: z.array(z.string()).optional(),
      migrations: z
        .array(
          z.object({
            name: z.string().min(1).max(200).optional(),
            migrationName: z.string().min(1).max(200).optional(),
            sql: z.string().min(1),
            sha256: z.string().optional(),
          }),
        )
        .optional(),
      pendingMigrations: z
        .array(
          z.object({
            name: z.string().min(1).max(200).optional(),
            migrationName: z.string().min(1).max(200).optional(),
            sql: z.string().min(1),
            sha256: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional();

  interface PersistedDeployedState {
    /** Real client: HMAC (keyed by the root secret) of each secret value bound to the Worker. Never the value. */
    secretHashes?: Record<string, string>;
    /** Real client: sha256 of the Worker bundle actually uploaded (the drift check compares the account against this). */
    liveCodeHash?: string;
    /** Real client: the Worker version ids Studio made itself (its uploads and secret puts), newest first, at most 50. */
    studioVersionIds?: string[];
    /** Real client: each brick secret's name and the vault ref the deploy resolved it from (ref ids only, never a value). */
    secretRefs?: Record<string, string>;
    appliedMigrations?: string[];
    appliedMigrationSql?: Record<string, string>;
    queues?: string[];
    cronTriggers?: string[];
    workflows?: Array<{ name: string; className: string }>;
    graphs?: Record<string, string>;
    entities?: Array<{
      name: string;
      fields: Array<{ name: string; type: string; required?: boolean }>;
    }>;
    pendingCustomMigrations?: Array<{
      name: string;
      sql: string;
      sha256: string;
    }>;
    workerUrl?: string;
    versionId?: string;
    databaseId?: string;
    deployedAt?: string;
    deployedBy?: string;
    rollbackFromDeploymentId?: string | null;
    lastAction?: DeployPlanAction | "rollback";
    liveWithoutRedeploy?: boolean;
    noChanges?: boolean;
    reusedCachedBuild?: boolean;
    /** The D1 Time Travel bookmark taken just before this deployment applied its first pending migration on an existing database. */
    preMigrationBookmark?: string;
  }

  async function buildEnvironmentPlanContext(params: {
    env: StudioApiEnv;
    project: string;
    orgId: string;
    envName: DeployEnvName;
    preferredBuildHash?: string;
    /** Story 1.19: a promotion from preview may use secrets Studio generated for preview; a direct production plan may not. */
    allowPreviewScopedSecrets?: boolean;
    customMigrationsInput?: Array<{
      name?: string;
      migrationName?: string;
      sql: string;
      sha256?: string;
    }>;
    persistCustomMigrations?: boolean;
  }): Promise<
    | {
        ok: true;
        plan: ProvisionerPlanResult;
        envRecord: ProjectEnvironmentTargetRecord;
        tokenMeta: DeployTokenMetadata;
        current: ProjectStatePayload;
        buildHash: string;
        codeHash: string;
        graphHash: string;
        bundleCode: string;
        reusedCachedBuild: boolean;
        assembleCount: number;
        allMigrations: ProvisionerMigrationItem[];
        queues: string[];
        cronTriggers: string[];
        workflows: Array<{ name: string; className: string }>;
        graphs: Record<string, string>;
        configuredSecretValues: Record<string, string>;
        deployedState: PersistedDeployedState;
        preflight: {
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
            items: DeployPlanSecretCheck[];
          };
        };
      }
    | {
        ok: false;
        status: 404 | 422;
        error: {
          code: string;
          message: string;
        };
      }
  > {
    const { env, project, orgId, envName } = params;
    const db = env.STUDIO_DB;

    let environments = await listProjectDeployEnvironments(db, {
      orgId,
      projectId: project,
    });
    const tokens = await listOrgDeployTokens(db, orgId);
    const activeToken = tokens.find((t) => t.status === "active") ?? null;

    if (environments.length === 0 && activeToken) {
      environments = await upsertProjectDeployEnvironments(db, {
        orgId,
        projectIds: [project],
        accountId: activeToken.accountId,
        accountName: activeToken.accountName,
        tokenRef: activeToken.tokenRef,
      });
    }

    const envRecord = environments.find((e) => e.envName === envName) ?? null;
    if (!envRecord) {
      return {
        ok: false,
        status: 422,
        error: {
          code: "DEPLOY_TARGET_NOT_CONNECTED",
          message: `No Cloudflare deploy target is connected for project "${project}" (${envName}). Connect Cloudflare first.`,
        },
      };
    }

    const tokenMeta = await getDeployTokenMetadata(
      db,
      envRecord.target.tokenRef,
      orgId,
    );
    if (!tokenMeta || tokenMeta.status !== "active") {
      return {
        ok: false,
        status: 422,
        error: {
          code: "TOKEN_REVOKED",
          message: `Cloudflare deploy token "${envRecord.target.tokenRef}" is ${tokenMeta?.status ?? "missing"} — Reconnect in Studio.`,
        },
      };
    }

    const stub = getBlueprintStub(env, project);
    const stateRes = await stub.fetch(
      `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
      { method: "GET" },
    );
    const current = (await stateRes.json()) as ProjectStatePayload;

    const deployedState: PersistedDeployedState =
      (envRecord.deployedState as PersistedDeployedState | null) ?? {};

    // Check content-addressed builds cache first so promoting or re-planning never re-runs assemble()
    const cachedRow = params.preferredBuildHash
      ? await db
          .prepare(
            `SELECT build_hash, code_hash, graph_hash, bundle_code, files_json, assemble_count
             FROM builds
             WHERE build_hash = ? AND project_id = ?
             LIMIT 1`,
          )
          .bind(params.preferredBuildHash, project)
          .first<{
            build_hash: string;
            code_hash: string;
            graph_hash: string;
            bundle_code: string;
            files_json: string;
            assemble_count: number;
          }>()
      : await db
          .prepare(
            `SELECT build_hash, code_hash, graph_hash, bundle_code, files_json, assemble_count
             FROM builds
             WHERE project_id = ? AND revision = ? AND semantic_hash = ?
             LIMIT 1`,
          )
          .bind(project, current.revision, current.semanticHash)
          .first<{
            build_hash: string;
            code_hash: string;
            graph_hash: string;
            bundle_code: string;
            files_json: string;
            assemble_count: number;
          }>();

    let buildHash: string;
    let codeHash: string;
    let graphHash: string;
    let bundleCode: string;
    let reusedCachedBuild = false;
    let assembleCount = getProjectAssembleCount(project, current.revision);
    const assembledMigrations: ProvisionerMigrationItem[] = [];

    if (cachedRow) {
      reusedCachedBuild = true;
      buildHash = cachedRow.build_hash;
      codeHash = cachedRow.code_hash;
      graphHash = cachedRow.graph_hash;
      bundleCode = cachedRow.bundle_code;
      assembleCount = Math.max(assembleCount, Number(cachedRow.assemble_count || 1));
      const cachedFiles = JSON.parse(cachedRow.files_json) as Record<string, string>;
      for (const [filePath, sqlText] of Object.entries(cachedFiles)) {
        if (filePath.startsWith("migrations/") && filePath.endsWith(".sql")) {
          const shortName = filePath.replace(/^migrations\//, "");
          assembledMigrations.push({
            name: shortName,
            sql: sqlText,
            sha256: await sha256Hex(sqlText),
          });
        }
      }
    } else {
      const assembled = assemble(toAssemblerBlueprint(current.state), catalog);
      if (assembled.ok) {
        const revKey = `${project}:r${current.revision}`;
        const nextRevCount = (studioProjectAssembleCounts.get(revKey) ?? 0) + 1;
        studioProjectAssembleCounts.set(revKey, nextRevCount);
        studioProjectAssembleCounts.set(
          project,
          (studioProjectAssembleCounts.get(project) ?? 0) + 1,
        );
        assembleCount = nextRevCount;

        const catalogVersion =
          current.state.metadata?.catalogVersion ?? DEFAULT_CATALOG_VERSION;
        const hashes = await computeArtifactHashes(assembled.files, {
          catalogVersion,
        });
        buildHash = hashes.buildHash;
        codeHash = hashes.codeHash;
        graphHash = hashes.graphHash;
        bundleCode =
          assembled.files["src/index.ts"] ??
          "export default { fetch() { return new Response('ok'); } };";

        const fileCount = Object.keys(assembled.files).length;
        const byteCount = Object.values(assembled.files).reduce(
          (sum, text) => sum + new TextEncoder().encode(text).length,
          0,
        );
        await db
          .prepare(
            `INSERT INTO studio_builds (project_id, revision, build_hash, semantic_hash, file_count, byte_count, files_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(project_id, revision) DO UPDATE SET
               build_hash = excluded.build_hash,
               semantic_hash = excluded.semantic_hash,
               file_count = excluded.file_count,
               byte_count = excluded.byte_count,
               files_json = excluded.files_json,
               created_at = excluded.created_at`,
          )
          .bind(
            project,
            current.revision,
            buildHash,
            current.semanticHash,
            fileCount,
            byteCount,
            JSON.stringify(assembled.files),
          )
          .run();

        await db
          .prepare(
            `INSERT INTO builds (
               build_hash, project_id, revision, semantic_hash, code_hash, graph_hash,
               catalog_version, bundle_code, bundle_sha256, files_json, assemble_count, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(build_hash) DO UPDATE SET
               revision = excluded.revision,
               semantic_hash = excluded.semantic_hash,
               files_json = excluded.files_json
             WHERE builds.project_id = excluded.project_id`,
          )
          .bind(
            buildHash,
            project,
            current.revision,
            current.semanticHash,
            codeHash,
            graphHash,
            catalogVersion,
            bundleCode,
            codeHash,
            JSON.stringify(assembled.files),
            assembleCount,
          )
          .run();

        for (const [filePath, sqlText] of Object.entries(assembled.files)) {
          if (filePath.startsWith("migrations/") && filePath.endsWith(".sql")) {
            const shortName = filePath.replace(/^migrations\//, "");
            assembledMigrations.push({
              name: shortName,
              sql: sqlText,
              sha256: await sha256Hex(sqlText),
            });
          }
        }
      } else {
        buildHash = current.semanticHash || `sha256_rev_${current.revision}`;
        codeHash = computeBlueprintCodeHash(current.state);
        graphHash = computeBlueprintGraphHash(current.state);
        bundleCode = "export default { fetch() { return new Response('ok'); } };";
      }
    }

    // Check for entity schema evolution against previously deployed entities
    const evolutionMigrations: ProvisionerMigrationItem[] = [];
    if (deployedState.entities && Array.isArray(deployedState.entities)) {
      const prevEntities = deployedState.entities;
      const currEntities = current.state.entities ?? [];
      const currMap = new Map(currEntities.map((e) => [e.name, e]));

      for (const prevEnt of prevEntities) {
        const currEnt = currMap.get(prevEnt.name);
        if (!currEnt) {
          const dropSql = `DROP TABLE ${prevEnt.name};`;
          const migName = `9001_drop_table__${prevEnt.name}.sql`;
          evolutionMigrations.push({
            name: migName,
            sql: dropSql,
            sha256: await sha256Hex(dropSql),
          });
          continue;
        }
        const currFieldMap = new Map(currEnt.fields.map((f) => [f.name, f]));
        const prevFieldMap = new Map(prevEnt.fields.map((f) => [f.name, f]));

        for (const prevField of prevEnt.fields) {
          const currField = currFieldMap.get(prevField.name);
          if (!currField) {
            const dropColSql = `ALTER TABLE ${currEnt.name} DROP COLUMN ${prevField.name};`;
            const migName = `9002_drop_column__${currEnt.name}_${prevField.name}.sql`;
            evolutionMigrations.push({
              name: migName,
              sql: dropColSql,
              sha256: await sha256Hex(dropColSql),
            });
          } else if (
            prevField.type === "text" &&
            (currField.type === "number" || currField.type === "boolean")
          ) {
            const targetSqlType =
              currField.type === "boolean" ? "BOOLEAN" : "INTEGER";
            const narrowSql = `ALTER TABLE ${currEnt.name} ALTER COLUMN ${currField.name} TYPE ${targetSqlType};`;
            const migName = `9003_narrow_column__${currEnt.name}_${currField.name}.sql`;
            evolutionMigrations.push({
              name: migName,
              sql: narrowSql,
              sha256: await sha256Hex(narrowSql),
            });
          }
        }

        for (const currField of currEnt.fields) {
          for (const { column, sql } of entityAddColumnStatements(currEnt.name, prevFieldMap.get(currField.name), currField)) {
            evolutionMigrations.push({
              name: `9004_add_column__${currEnt.name}_${column}.sql`,
              sql,
              sha256: await sha256Hex(sql),
            });
          }
        }
      }
    }

    // Custom migrations passed in request or previously persisted as pending
    let pendingCustomMigrations: Array<{
      name: string;
      sql: string;
      sha256: string;
    }> = [...(deployedState.pendingCustomMigrations ?? [])];
    if (params.customMigrationsInput && params.customMigrationsInput.length > 0) {
      const normalizedCustom: Array<{
        name: string;
        sql: string;
        sha256: string;
      }> = [];
      for (const cm of params.customMigrationsInput) {
        const name = cm.name ?? cm.migrationName ?? "9900_custom_migration.sql";
        normalizedCustom.push({
          name,
          sql: cm.sql,
          sha256: cm.sha256 ?? (await sha256Hex(cm.sql)),
        });
      }
      pendingCustomMigrations = normalizedCustom;
      if (params.persistCustomMigrations) {
        const nextDeployedState: PersistedDeployedState = {
          ...deployedState,
          pendingCustomMigrations,
        };
        await db
          .prepare(
            `UPDATE project_environments
             SET deployed_state_json = ?, updated_at = ?
             WHERE project_id = ? AND env_name = ?`,
          )
          .bind(
            JSON.stringify(nextDeployedState),
            new Date().toISOString(),
            project,
            envName,
          )
          .run();
      }
    }

    // Deduplicate all migrations by name while preserving order
    const migrationMap = new Map<string, ProvisionerMigrationItem>();
    for (const m of [
      ...assembledMigrations,
      ...evolutionMigrations,
      ...pendingCustomMigrations,
    ]) {
      migrationMap.set(m.name, m);
    }
    const allMigrations = [...migrationMap.values()];

    // Collect queues, cronTriggers, workflows from current blueprint state
    const queues: string[] = [];
    const cronTriggers: string[] = [];
    const secretRequirements: DeployPlanSecretRequirement[] = [];
    const seenSecrets = new Set<string>();

    for (const brickEntry of current.state.bricks ?? []) {
      const catEntry = catalog.bricks[brickEntry.id];
      if (!catEntry) continue;
      for (const q of catEntry.manifest.triggers?.queues ?? []) {
        queues.push(`px-${project}-${envName}-${q.id}`);
      }
      for (const sched of catEntry.manifest.triggers?.schedules ?? []) {
        if (!cronTriggers.includes(sched.cron)) {
          cronTriggers.push(sched.cron);
        }
      }
      for (const declared of secretDeclarations(catEntry.manifest)) {
        const secName = declared.name;
        if (!seenSecrets.has(secName)) {
          seenSecrets.add(secName);
          const boundRef = (current.state.secretRefs ?? []).find(
            (sr) =>
              sr.targetKind === "brick" &&
              sr.targetId === brickEntry.id &&
              sr.secretName === secName,
          );
          secretRequirements.push({
            name: secName,
            ...(boundRef ? { ref: boundRef.ref } : {}),
            requiredByBrick: brickEntry.id,
            // story 1.19: optional never blocks; generate is made by Studio on an approved preview deploy
            ...(declared.optional ? { optional: true } : {}),
            ...(declared.generate ? { generate: declared.generate } : {}),
          });
        }
      }
    }

    for (const sr of current.state.secretRefs ?? []) {
      if (!seenSecrets.has(sr.secretName)) {
        seenSecrets.add(sr.secretName);
        secretRequirements.push({
          name: sr.secretName,
          ref: sr.ref,
          requiredByBrick: sr.targetId,
        });
      }
    }

    const workflows: Array<{ name: string; className: string }> = [];
    const graphs: Record<string, string> = {};
    for (const wf of current.state.workflows ?? []) {
      workflows.push({
        name: wf.id,
        className: "GraphRunner",
      });
      graphs[wf.id] = JSON.stringify(wf);
      for (const node of wf.nodes ?? []) {
        const cronVal = node.data?.cron;
        if (typeof cronVal === "string" && cronVal.trim().length > 0) {
          const cronStr = cronVal.trim();
          if (!cronTriggers.includes(cronStr)) {
            cronTriggers.push(cronStr);
          }
        }
      }
    }

    // Inspect studio_secret_vault to determine which required secrets are present
    const vaultRows = await db
      .prepare(
        `SELECT ref, label, app_or_brick, status, env_scope, ciphertext_b64, iv_b64
         FROM studio_secret_vault
         WHERE project_id = ? AND status = 'valid'`,
      )
      .bind(project)
      .all<{
        ref: string;
        label: string;
        app_or_brick: string;
        status: string;
        env_scope: string;
        ciphertext_b64: string;
        iv_b64: string;
      }>();

    // Story 1.19: a secret Studio generated for preview (env_scope 'preview') never satisfies a direct production plan; only
    // a promotion from preview carries it over. The owner binds production's own value otherwise.
    const validVaultRows = (vaultRows.results ?? []).filter(
      (r) => envName !== "production" || r.env_scope !== "preview" || params.allowPreviewScopedSecrets === true,
    );
    const configuredSecretNames = new Set<string>();
    const configuredSecretValues: Record<string, string> = {};

    for (const req of secretRequirements) {
      const normalizedSuggestedRef = `sec_${req.name
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")}`;
      // The blueprint's explicit binding wins over any row that merely shares the name: only without one is a row matched by
      // label or by ref spelling.
      const matchedRow = req.ref
        ? validVaultRows.find((r) => r.ref === req.ref)
        : validVaultRows.find(
            (r) =>
              r.label.toUpperCase() === req.name.toUpperCase() ||
              r.ref.toLowerCase() === req.name.toLowerCase() ||
              r.ref.toLowerCase() === normalizedSuggestedRef,
          );
      if (matchedRow) {
        configuredSecretNames.add(req.name);
        configuredSecretValues[req.name] = `sealed:${matchedRow.ref}`;
      }
    }

    const readinessIssues = (current.readiness?.needs ?? []).filter(
      (n) => n.code !== "UNBOUND_BRICK_SECRET" && n.code !== "UNBOUND_CONNECTION",
    );

    const previouslyAppliedSql = Object.values(
      deployedState.appliedMigrationSql ?? {},
    );

    const envState: DeployPlanEnvironmentState = {
      deployedRev: envRecord.deployedRev,
      currentBuildHash: envRecord.buildHash,
      currentCodeHash: envRecord.codeHash,
      currentGraphHash: envRecord.graphHash,
      databaseExists:
        envRecord.deployedRev !== null && envRecord.deployedRev !== undefined,
      appliedMigrations: deployedState.appliedMigrations ?? [],
      existingQueues: deployedState.queues ?? [],
      currentCrons: deployedState.cronTriggers ?? [],
      existingWorkflows: (deployedState.workflows ?? []).map((w) => ({
        workflowName: w.name,
        className: w.className,
      })),
      configuredSecrets: [...configuredSecretNames],
      previousSchemaSql: previouslyAppliedSql,
    };

    const plan = computeDeployPlan(
      envRecord.target,
      {
        project,
        buildHash,
        codeHash,
        graphHash,
        bundle: {
          code: bundleCode,
          sha256: codeHash,
        },
        migrations: allMigrations,
        queues,
        cronTriggers,
        workflows: workflows.map((w) => ({
          workflowName: w.name,
          className: w.className,
        })),
        requiredSecrets: secretRequirements,
        configuredSecrets: [...configuredSecretNames],
        identity: current.state.identity,
        readinessIssues,
      },
      envState,
    );

    const preflight = {
      tokenPermissions: {
        ok: true,
        accountId: tokenMeta.accountId,
        accountName: tokenMeta.accountName,
        tokenRef: tokenMeta.tokenRef,
        scopes: tokenMeta.scopes,
      },
      readiness: {
        ok: readinessIssues.length === 0,
        ready: readinessIssues.length === 0,
        issues: readinessIssues,
      },
      secrets: {
        ok: plan.missingSecrets.length === 0,
        items: plan.secrets,
      },
    };

    return {
      ok: true,
      plan,
      envRecord,
      tokenMeta,
      current,
      buildHash,
      codeHash,
      graphHash,
      bundleCode,
      reusedCachedBuild,
      assembleCount,
      allMigrations,
      queues,
      cronTriggers,
      workflows,
      graphs,
      configuredSecretValues,
      deployedState,
      preflight,
    };
  }

  /**
   * What the real client uploads for one environment (story R53): the bundled Worker (gate, GraphRunner Workflow, signed
   * /__px routes around the assembled project), its non-secret bindings, the one GraphRunner Workflow its graphs run on, and
   * its secrets: the derived access key, the project's derived control-plane and webhook secrets (story 1.17; never the root),
   * and any brick secret from the vault. Refuses, before anything is written, when it cannot build a Worker that would work.
   */
  async function prepareRealWorkerUpload(params: {
    env: StudioApiEnv;
    project: string;
    envName: DeployEnvName;
    buildHash: string;
    target: DeployTarget;
    configuredSecretValues: Record<string, string>;
  }): Promise<{
    bundleCode: string;
    /** sha256 of the whole uploaded Worker (gate and runtime included): the code hash the account and drift compare. */
    bundleSha: string;
    accessKey: string;
    workflows: Array<{ name: string; className: string }>;
    workerBindings: Array<Record<string, unknown>>;
    /** ["nodejs_compat"] when the bundle imports `node:*` (the assembled wrangler.jsonc is not consulted); otherwise empty (story 1.19). */
    compatibilityFlags: string[];
    secrets: Record<string, string>;
  }> {
    const { env, project, envName } = params;
    const bundle = appOptions.deploy?.bundle;
    if (!bundle) {
      throw new StudioDeployRefusal(
        "DEPLOY_BUNDLER_NOT_CONFIGURED",
        "This Studio has no Worker bundler, so it cannot build a deployable Worker. Run the deploy from a Studio started with a bundler (see docs/live-deploy.md).",
        501,
      );
    }
    const root = env.PX_TELEMETRY_SECRET;
    if (typeof root !== "string" || root.trim().length < 16) {
      throw new StudioDeployRefusal(
        "NO_ROOT_SECRET",
        "PX_TELEMETRY_SECRET is not set: the deployed Worker's per-project secrets are derived from it.",
        500,
      );
    }
    const buildRow = await params.env.STUDIO_DB.prepare(
      "SELECT files_json FROM builds WHERE build_hash = ? AND project_id = ? LIMIT 1",
    )
      .bind(params.buildHash, project)
      .first<{ files_json: string }>();
    const files = buildRow ? (JSON.parse(buildRow.files_json) as Record<string, string>) : null;
    if (!files || typeof files["src/index.ts"] !== "string") {
      throw new StudioDeployRefusal(
        "BUILD_NOT_ASSEMBLED",
        `The blueprint of "${project}" did not assemble into a project, so there is nothing to deploy.`,
        422,
      );
    }
    const built = await bundle({ project, envName, files });
    const { scriptName } = deriveEnvironmentResourceNames(project, params.target);
    const workflowName = `${scriptName}-graphs`;
    const derived = await projectWorkerSecretBindings(env, project);
    const secrets: Record<string, string> = {
      POC_ACCESS_KEY: await deriveWorkerAccessKey(root, project, envName),
      PX_TELEMETRY_SECRET: derived.PX_TELEMETRY_SECRET!,
      PX_TELEMETRY_WEBHOOK_SECRET: derived.PX_TELEMETRY_WEBHOOK_SECRET!,
    };
    // Brick secrets: the vault's plaintext, decrypted here and sent only in the secret's own request body.
    const vaultKey = env.PX_VAULT_KEY ?? env.BETTER_AUTH_SECRET;
    for (const [name, value] of Object.entries(params.configuredSecretValues)) {
      if (!value.startsWith("sealed:")) continue;
      const row = await env.STUDIO_DB.prepare(
        "SELECT ciphertext_b64, iv_b64 FROM studio_secret_vault WHERE project_id = ? AND ref = ? AND status = 'valid' LIMIT 1",
      )
        .bind(project, value.slice("sealed:".length))
        .first<{ ciphertext_b64: string; iv_b64: string }>();
      if (!row) {
        throw new StudioDeployRefusal(
          "SECRET_NOT_IN_VAULT",
          `The secret ${name} is bound to ${value.slice("sealed:".length)}, which has no valid row in this project's vault: store it again before deploying.`,
          422,
        );
      }
      secrets[name] = await decryptSecretValue(row.ciphertext_b64, row.iv_b64, vaultKey);
    }
    return {
      bundleCode: built.code,
      bundleSha: built.sha256 ?? (await sha256Hex(built.code)),
      accessKey: secrets.POC_ACCESS_KEY!,
      workflows: [{ name: workflowName, className: WORKFLOW_CLASS }],
      compatibilityFlags: realUploadCompatibilityFlags(built),
      workerBindings: [
        { type: "plain_text", name: "PX_ENVIRONMENT", text: envName },
        { type: "plain_text", name: "PX_PROJECT_ID", text: project },
        { type: "workflow", name: WORKFLOW_BINDING, workflow_name: workflowName, class_name: WORKFLOW_CLASS },
      ],
      secrets,
    };
  }

  /** `sealed:<ref>` for each recorded name → ref whose ref still has a valid row in the project's vault; the rest left out. */
  async function stillValidVaultRefs(db: D1Like, project: string, refs: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, ref] of Object.entries(refs)) {
      const row = await db
        .prepare("SELECT ref FROM studio_secret_vault WHERE project_id = ? AND ref = ? AND status = 'valid' LIMIT 1")
        .bind(project, ref)
        .first<{ ref: string }>();
      if (row) out[name] = `sealed:${ref}`;
    }
    return out;
  }

  /** HMAC-SHA256 (keyed by the root secret) of each secret's name and value: what Studio keeps to know a secret changed. */
  async function secretValueHashes(rootSecret: string, project: string, envName: string, secrets: Record<string, string>): Promise<Record<string, string>> {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(rootSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(secrets)) {
      // project and environment are in the message, so one value in two environments never gives the same hash
      const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`px-worker-secret/v1\n${project}\n${envName}\n${name}\n${value}`));
      out[name] = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    return out;
  }

  /** The same keyed smoke check the CLI provisioner runs: /healthz with the gate's access key, a few tries. */
  async function smokeCheckRealWorker(url: string, accessKey: string, firstDeploy: boolean): Promise<{ status: number; attempts: number }> {
    const workerFetch = appOptions.deploy?.workerFetch ?? ((request: Request) => fetch(request));
    const sleep = appOptions.deploy?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // A new workers.dev address can take a while to answer: up to ~120 s for a first deploy, ~20 s for a redeploy, with
    // backoff (1 s, 2 s, 4 s, 8 s, then 10 s). The budget counts the waits themselves, so an injected sleep keeps it exact.
    const budgetMs = firstDeploy
      ? (appOptions.deploy?.smokeTimeoutMs?.firstDeploy ?? 120_000)
      : (appOptions.deploy?.smokeTimeoutMs?.redeploy ?? 20_000);
    // The budget bounds wall time as well: each attempt is cut off by AbortSignal.timeout, and what counts is the larger of
    // the time waited between attempts and the wall-clock time since the first one.
    const started = Date.now();
    let waited = 0;
    const spent = () => Math.max(waited, Date.now() - started);
    let last = "no answer";
    for (let attempt = 1; ; attempt += 1) {
      const attemptMs = Math.max(1_000, Math.min(10_000, budgetMs - spent()));
      try {
        const res = await workerFetch(new Request(`${url.replace(/\/+$/, "")}/healthz`, { headers: { [KEY_HEADER]: accessKey }, redirect: "manual", signal: AbortSignal.timeout(attemptMs) }));
        if (res.ok) return { status: res.status, attempts: attempt };
        last = `HTTP ${res.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      const wait = Math.min(1_000 * 2 ** (attempt - 1), 10_000, budgetMs - spent());
      if (wait <= 0) break;
      await sleep(wait);
      waited += wait;
    }
    waited = spent();
    throw new StudioDeployRefusal("SMOKE_CHECK_FAILED", `The deployed Worker did not answer ${url}/healthz with its access key within ${Math.round(waited / 1000)} s: ${last}`, 502);
  }

  /**
   * After the real upload: put the secrets whose value changed (or that the Worker lacks), delete the ones no longer bound,
   * give the result its real address, and smoke-check the Worker when its code or secrets changed.
   */
  async function completeRealDeploy(p: {
    env: StudioApiEnv;
    project: string;
    target: Extract<DeployTarget, { type: "byoc" }>;
    deployId: string;
    actorId: string;
    controlPlane: CloudflareApiClient;
    tokenResolver: ReturnType<typeof createStudioTokenResolver>;
    upload: Awaited<ReturnType<typeof prepareRealWorkerUpload>>;
    applied: Awaited<ReturnType<ReturnType<typeof createByocProvisioner>["apply"]>>;
    previous: PersistedDeployedState;
    /** A rollback never deletes a secret: what it did not put is left on the Worker and its hash carried forward. */
    mode?: "deploy" | "rollback";
  }) {
    const { target, controlPlane, upload, applied } = p;
    const mode = p.mode ?? "deploy";
    const token = await p.tokenResolver(target.tokenRef, { actor: p.actorId, deployId: p.deployId, action: "secrets" });
    const { scriptName } = deriveEnvironmentResourceNames(p.project, target);
    const hashes = await secretValueHashes(p.env.PX_TELEMETRY_SECRET!, p.project, target.envName, upload.secrets);
    const previousHashes = p.previous.secretHashes ?? {};
    const live = await controlPlane.getScript(target.accountId, token, scriptName);
    const liveSecrets = new Set(live?.secrets ?? []);
    const actions = [...applied.appliedActions];
    let secretsChanged = false;
    const putVersionIds: Array<string | undefined> = [];
    for (const [name, value] of Object.entries(upload.secrets)) {
      if (previousHashes[name] === hashes[name] && liveSecrets.has(name)) continue;
      const put = await controlPlane.putScriptSecret(target.accountId, token, scriptName, name, value);
      putVersionIds.push(put.versionId);
      secretsChanged = true;
      actions.push({ kind: "secret", name, action: previousHashes[name] || liveSecrets.has(name) ? "update" : "create", summary: `Bound secret ${name} on ${scriptName}` });
    }
    for (const name of Object.keys(previousHashes)) {
      if (mode === "rollback") break; // only a deploy, which knows every secret the blueprint binds, removes one
      if (name in upload.secrets || !liveSecrets.has(name)) continue;
      if (!controlPlane.deleteScriptSecret) continue;
      await controlPlane.deleteScriptSecret(target.accountId, token, scriptName, name);
      secretsChanged = true;
      actions.push({ kind: "secret", name, action: "delete", summary: `Removed secret ${name} from ${scriptName}` });
    }
    // The Worker's address always comes from the account's workers.dev name, never the provisioner's placeholder (its noop
    // path does not know the name, and a retry after a failed first deploy has no recorded address to fall back on).
    const subdomain = controlPlane.getWorkersSubdomain ? await controlPlane.getWorkersSubdomain(target.accountId, token) : null;
    if (controlPlane.getWorkersSubdomain && subdomain === null) throw new Error(NO_WORKERS_DEV_SUBDOMAIN_MESSAGE);
    const url = subdomain ? `https://${scriptName}.${subdomain}.workers.dev` : applied.url;
    // The versions Studio itself just made (its upload, then its secret puts) are recorded, so a later read can tell them from
    // an out-of-band change: every version newer than (and including) the one uploaded, or just the newest after a secret put.
    let studioVersionIds = p.previous.studioVersionIds ?? [];
    if ((applied.rebuiltWorker || secretsChanged) && controlPlane.listScriptVersionIds) {
      const ids = (await controlPlane.listScriptVersionIds(target.accountId, token, scriptName)) ?? [];
      const uploaded = applied.rebuiltWorker ? ids.indexOf(applied.versionId) : -1;
      // Secret puts: the ids their answers returned when every one returned one. Otherwise (no id in the answer, which is not
      // checked against the live API) the newest versions, one per write, as made by Studio just now.
      const returned = putVersionIds.length > 0 && putVersionIds.every((v) => typeof v === "string") ? (putVersionIds as string[]) : null;
      const secretMade = returned ?? ids.slice(0, secretsChanged ? Math.min(ids.length, actions.length - applied.appliedActions.length) : 0);
      const made = uploaded >= 0 ? [...ids.slice(0, uploaded + 1), ...(returned ?? [])] : secretMade;
      studioVersionIds = [...new Set([...made, ...studioVersionIds])].slice(0, 50);
    }
    let smoke: { status: number; attempts: number } | null = null;
    if (applied.rebuiltWorker || secretsChanged) smoke = await smokeCheckRealWorker(url, upload.accessKey, !p.previous.workerUrl);
    // A rollback keeps the hashes of the secrets it did not touch (they are still bound to the Worker).
    const keptHashes = mode === "rollback" ? Object.fromEntries(Object.entries(previousHashes).filter(([name]) => !(name in upload.secrets))) : {};
    return {
      secretHashes: { ...keptHashes, ...hashes },
      studioVersionIds,
      smoke,
      result: {
        ...applied,
        url,
        previewUrl: url,
        appliedActions: actions,
        changes: actions.length,
        noChanges: actions.length === 0 && applied.noChanges,
        action: applied.action === "noop" && secretsChanged ? ("update" as const) : applied.action,
        // each secret put or delete is one write call
        mutatingCallCount: applied.mutatingCallCount + (actions.length - applied.appliedActions.length),
      },
    };
  }

  /**
   * A real deploy that failed: the audit log records what was done before the failure (the steps and every write call), and
   * the caller gets Cloudflare's own code and message as a structured error, never a bare 500.
   */
  async function failRealDeploy(
    error: unknown,
    p: { db: D1Like; orgId: string; project: string; envName: string; deployId: string; caller: StudioCaller; controlPlane: CloudflareApiClient | null; steps: Array<{ stepName: string; action: string; resourceName: string }>; hideValues?: string[]; action?: string },
  ): Promise<never> {
    const httpCalls = (p.controlPlane as Partial<HttpCloudflareApiClient> | null)?.httpCalls ?? [];
    const hide = createRedactor((p.hideValues ?? []).filter((v) => typeof v === "string"));
    const writeCalls = httpCalls.filter(isHttpWriteCall).map((c) => ({ method: c.method, path: c.path, status: c.status }));
    const partial = { deployId: p.deployId, steps: p.steps, writeCalls };
    const message = hide(error instanceof Error ? error.message : String(error));
    let refusal: StudioDeployRefusal;
    if (error instanceof StudioDeployRefusal) refusal = new StudioDeployRefusal(error.code, error.message, error.status, { ...(error.detail ?? {}), partial });
    else if (message.startsWith("NO_WORKERS_DEV_SUBDOMAIN")) refusal = new StudioDeployRefusal("NO_WORKERS_DEV_SUBDOMAIN", message, 422, { partial });
    else if (error instanceof CloudflareApiError) refusal = new StudioDeployRefusal("CLOUDFLARE_ERROR", message, 502, { cloudflare: { status: error.status, codes: error.codes, details: error.details }, partial });
    else if (error instanceof CloudflareNetworkError) refusal = new StudioDeployRefusal("CLOUDFLARE_UNREACHABLE", message, 502, { partial });
    else if (error instanceof CloudflareMalformedError) refusal = new StudioDeployRefusal("CLOUDFLARE_ERROR", message, 502, { partial });
    else if (error instanceof RequestGuardError) refusal = new StudioDeployRefusal("GUARD_REFUSED", message, 403, { partial });
    else if (error instanceof StudioDeployClientConfigError) refusal = new StudioDeployRefusal(error.code, message, 500, { partial });
    // Anything else (an error from the client's own checks, a token that cannot be decrypted, a bundler failure) is still a
    // structured answer, never a bare 500; its message has every known secret hidden.
    else refusal = new StudioDeployRefusal("DEPLOY_FAILED", message, 502, { partial });
    await recordStudioAuditLog(p.db, {
      orgId: p.orgId,
      projectId: p.project,
      actorType: p.caller.author.type,
      actorId: p.caller.author.id,
      action: p.action ?? "environment.deploy",
      status: "failed",
      targetRef: `${p.project}:${p.envName}`,
      details: { code: refusal.code, message: refusal.message, ...partial },
    }).catch(() => {});
    throw refusal;
  }

  async function executeEnvironmentDeployment(params: {
    env: StudioApiEnv;
    project: string;
    orgId: string;
    envName: DeployEnvName;
    caller: StudioCaller;
    ctx: Extract<
      Awaited<ReturnType<typeof buildEnvironmentPlanContext>>,
      { ok: true }
    >;
    actionOverride?: "apply" | "promote";
    promotedFromEnv?: DeployEnvName;
    reusedCachedBuild?: boolean;
  }) {
    const { env, project, orgId, envName, caller, ctx } = params;
    const db = env.STUDIO_DB;
    const deployId = `dep_${generateUuidV7()}`;
    const controlPlane = getStudioControlPlane(ctx.envRecord.target.accountId, env, appOptions.deploy);
    const fakeControlPlane = asFakeControlPlane(controlPlane);
    const tokenResolver = createStudioTokenResolver(db, env);
    const stub = getBlueprintStub(env, project);
    // The real client uploads a real Worker; the fake keeps the test-only placeholder bundle.
    let realUpload: Awaited<ReturnType<typeof prepareRealWorkerUpload>> | null = null;
    if (!fakeControlPlane) {
      try {
        realUpload = await prepareRealWorkerUpload({
          env,
          project,
          envName,
          buildHash: ctx.buildHash,
          target: ctx.envRecord.target,
          configuredSecretValues: ctx.configuredSecretValues,
        });
      } catch (error) {
        return failRealDeploy(error, { db, orgId, project, envName, deployId, caller, controlPlane, steps: [], hideValues: [env.PX_TELEMETRY_SECRET ?? ""] });
      }
    }
    const deployWorkflows = realUpload?.workflows ?? ctx.workflows;

    const provisioner = createByocProvisioner({
      apiClient: controlPlane,
      resolveToken: async (tokenRef, context) => {
        // Always the vault's decrypted token (never a made-up one); the fake is only told which token is "real".
        const plainToken = await tokenResolver(tokenRef, context);
        fakeControlPlane?.registerToken({
          token: plainToken,
          accountId: ctx.envRecord.target.accountId,
          accountName: ctx.envRecord.accountName,
        });
        return plainToken;
      },
    });

    const existingDeployedRev = ctx.envRecord.deployedRev;
    // Real client: what is deployed is read from the account (the Worker's annotated code hash, the database's own state and
    // migrations, the queues and Workflows Cloudflare lists), so "no changes" holds in the account, not just in Studio's memory.
    const envState: DeployPlanEnvironmentState = realUpload ? { deployedRev: existingDeployedRev } : {
      deployedRev: existingDeployedRev,
      currentBuildHash: ctx.envRecord.buildHash,
      currentCodeHash: ctx.envRecord.codeHash,
      currentGraphHash: ctx.envRecord.graphHash,
      databaseExists:
        existingDeployedRev !== null && existingDeployedRev !== undefined,
      appliedMigrations: ctx.deployedState.appliedMigrations ?? [],
      existingQueues: ctx.deployedState.queues ?? [],
      currentCrons: ctx.deployedState.cronTriggers ?? [],
      existingWorkflows: (ctx.deployedState.workflows ?? []).map((w) => ({
        workflowName: w.name,
        className: w.className,
      })),
    };

    if (envName === "preview") {
      await recordStudioOnboardingEvent(db, {
        orgId,
        projectId: project,
        actorId: caller.author.id,
        step: "first_preview_deploy_started",
        metadata: {
          deployId,
          revision: ctx.current.revision,
          buildHash: ctx.buildHash,
        },
        onlyOncePerProject: true,
      });
    }

    const doneSteps: Array<{ stepName: string; action: string; resourceName: string }> = [];
    let realSecretHashes: Record<string, string> | undefined;
    let realStudioVersionIds: string[] | undefined;
    const runApply = () => provisioner.apply({
      target: ctx.envRecord.target,
      project,
      actor: caller.author.id,
      deployId,
      buildHash: ctx.buildHash,
      // Real client: the hash of the Worker actually uploaded, so a change in the gate or runtime layer redeploys.
      codeHash: realUpload?.bundleSha ?? ctx.codeHash,
      graphHash: ctx.graphHash,
      bundle: {
        code: realUpload?.bundleCode ?? ctx.bundleCode,
        sha256: realUpload?.bundleSha ?? ctx.codeHash,
      },
      migrations: ctx.allMigrations,
      queues: ctx.queues,
      cronTriggers: ctx.cronTriggers,
      workflows: deployWorkflows,
      graphs: ctx.graphs,
      schedules: ctx.cronTriggers,
      // Real client: secrets are synced after the upload by completeRealDeploy (changed values put, removed ones deleted).
      secrets: realUpload ? {} : ctx.configuredSecretValues,
      ...(realUpload ? { workerBindings: realUpload.workerBindings, trustedVersionIds: (ctx.deployedState as PersistedDeployedState).studioVersionIds ?? [] } : {}),
      ...(realUpload && realUpload.compatibilityFlags.length > 0 ? { compatibilityFlags: realUpload.compatibilityFlags } : {}),
      envState,
      _actionOverride: params.actionOverride ?? "apply",
      // The bookmark is kept before any migration runs, so a deploy that fails after migrating still leaves a restore point.
      onPreMigrationBookmark: async ({ databaseId, bookmark }) =>
        recordRestorePoint(db, { project, envName, deployId, databaseId, bookmark }),
      onStep: async (step) => {
        doneSteps.push({ stepName: step.stepName, action: step.action, resourceName: step.resourceName });
        const stepId = `dstep_${generateUuidV7()}`;
        await db
          .prepare(
            `INSERT INTO deployment_steps (
               step_id, deploy_id, project_id, env_name, step_order, step_name,
               resource_kind, resource_name, action, status, summary, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            stepId,
            deployId,
            project,
            envName,
            step.stepOrder,
            step.stepName,
            step.resourceKind,
            step.resourceName,
            step.action,
            step.status,
            step.summary,
            step.timestamp,
          )
          .run();

        await stub
          .fetch(
            `http://blueprint-do/deploy-broadcast?project=${encodeURIComponent(project)}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                event: "step",
                deployId,
                envName,
                revision: ctx.current.revision,
                buildHash: ctx.buildHash,
                codeHash: ctx.codeHash,
                graphHash: ctx.graphHash,
                action: ctx.plan.action,
                step,
              }),
            },
          )
          .catch(() => {});
      },
    } as Parameters<typeof provisioner.apply>[0]);

    let applyResult: Awaited<ReturnType<typeof runApply>>;
    if (!realUpload) {
      applyResult = await runApply();
    } else {
      try {
        const completed = await completeRealDeploy({
          env,
          project,
          target: ctx.envRecord.target,
          deployId,
          actorId: caller.author.id,
          controlPlane,
          tokenResolver,
          upload: realUpload,
          applied: await runApply(),
          previous: ctx.deployedState as PersistedDeployedState,
        });
        applyResult = completed.result;
        realSecretHashes = completed.secretHashes;
        realStudioVersionIds = completed.studioVersionIds;
      } catch (error) {
        return failRealDeploy(error, { db, orgId, project, envName, deployId, caller, controlPlane, steps: doneSteps, hideValues: [env.PX_TELEMETRY_SECRET ?? "", ...Object.values(realUpload.secrets)] });
      }
    }

    const mergedAppliedMigrations = Array.from(
      new Set([
        ...(ctx.deployedState.appliedMigrations ?? []),
        ...ctx.allMigrations.map((m) => m.name),
      ]),
    );
    const mergedAppliedMigrationSql: Record<string, string> = {
      ...(ctx.deployedState.appliedMigrationSql ?? {}),
    };
    for (const m of ctx.allMigrations) {
      mergedAppliedMigrationSql[m.name] = m.sql;
    }

    const reusedCachedBuild =
      params.reusedCachedBuild ?? ctx.reusedCachedBuild;
    const statusMessage =
      applyResult.action === "noop" || applyResult.noChanges
        ? "No changes"
        : applyResult.liveWithoutRedeploy ||
            applyResult.action === "hot_apply_graphs"
          ? "Live without redeploy"
          : params.promotedFromEnv
            ? `Promoted from ${params.promotedFromEnv}`
            : "Deployed";

    const nextDeployedState: PersistedDeployedState = {
      appliedMigrations: mergedAppliedMigrations,
      appliedMigrationSql: mergedAppliedMigrationSql,
      queues: ctx.queues,
      cronTriggers: ctx.cronTriggers,
      workflows: deployWorkflows,
      graphs: ctx.graphs,
      entities: (ctx.current.state.entities ?? []).map((e) => ({
        name: e.name,
        fields: e.fields.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required,
        })),
      })),
      pendingCustomMigrations: [],
      workerUrl: applyResult.url,
      versionId: applyResult.versionId,
      databaseId: applyResult.databaseId,
      deployedAt: applyResult.deployedAt,
      deployedBy: caller.author.id,
      ...(applyResult.preMigrationBookmark ? { preMigrationBookmark: applyResult.preMigrationBookmark } : {}),
      rollbackFromDeploymentId: null,
      lastAction: applyResult.action,
      liveWithoutRedeploy: applyResult.liveWithoutRedeploy,
      noChanges: applyResult.noChanges,
      reusedCachedBuild,
      ...(realSecretHashes ? { secretHashes: realSecretHashes } : {}),
      ...(realUpload ? { liveCodeHash: realUpload.bundleSha } : {}),
      ...(realStudioVersionIds ? { studioVersionIds: realStudioVersionIds } : {}),
      ...(realUpload
        ? {
            secretRefs: Object.fromEntries(
              Object.entries(ctx.configuredSecretValues)
                .filter(([, v]) => v.startsWith("sealed:"))
                .map(([name, v]) => [name, v.slice("sealed:".length)]),
            ),
          }
        : {}),
    };

    const resourceNames = deriveEnvironmentResourceNames(
      project,
      ctx.envRecord.target,
    );
    // The fake also remembers the applied migration names; the real account keeps them in the database's own table.
    fakeControlPlane?.recordEnvironmentMetadata(
      ctx.envRecord.target.accountId,
      resourceNames.scriptName,
      resourceNames.databaseName,
      {
        buildHash: ctx.buildHash,
        codeHash: ctx.codeHash,
        graphHash: ctx.graphHash,
        appliedMigrations: mergedAppliedMigrations,
      },
    );

    const nowIso = new Date().toISOString();
    await db
      .prepare(
        `UPDATE project_environments
         SET deployed_rev = ?,
             build_hash = ?,
             code_hash = ?,
             graph_hash = ?,
             deployed_state_json = ?,
             status = 'deployed',
             updated_at = ?
         WHERE project_id = ? AND env_name = ?`,
      )
      .bind(
        ctx.current.revision,
        ctx.buildHash,
        ctx.codeHash,
        ctx.graphHash,
        JSON.stringify(nextDeployedState),
        nowIso,
        project,
        envName,
      )
      .run();

    await db
      .prepare(
        `INSERT INTO project_deployments (
           deploy_id, project_id, org_id, env_name, revision, build_hash, code_hash, graph_hash,
           action, worker_url, version_id, database_id, actor_id, state_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        deployId,
        project,
        orgId,
        envName,
        ctx.current.revision,
        ctx.buildHash,
        ctx.codeHash,
        ctx.graphHash,
        applyResult.action,
        applyResult.url,
        applyResult.versionId,
        applyResult.databaseId,
        caller.author.id,
        JSON.stringify(nextDeployedState),
        nowIso,
      )
      .run();

    await db
      .prepare(
        `INSERT INTO deployments (
           deploy_id, project_id, org_id, env_name, revision, build_hash, code_hash, graph_hash,
           action, status, reused_cached_build, live_without_redeploy, no_changes,
           worker_url, version_id, database_id, actor_id, state_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        deployId,
        project,
        orgId,
        envName,
        ctx.current.revision,
        ctx.buildHash,
        ctx.codeHash,
        ctx.graphHash,
        applyResult.action,
        reusedCachedBuild ? 1 : 0,
        applyResult.liveWithoutRedeploy ? 1 : 0,
        applyResult.noChanges ? 1 : 0,
        applyResult.url,
        applyResult.versionId,
        applyResult.databaseId,
        caller.author.id,
        JSON.stringify(nextDeployedState),
        nowIso,
      )
      .run();

    await stub
      .fetch(
        `http://blueprint-do/deploy-broadcast?project=${encodeURIComponent(project)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "completed",
            deployId,
            envName,
            revision: ctx.current.revision,
            buildHash: ctx.buildHash,
            codeHash: ctx.codeHash,
            graphHash: ctx.graphHash,
            action: applyResult.action,
            status: "succeeded",
            statusMessage,
            reusedCachedBuild,
            liveWithoutRedeploy: applyResult.liveWithoutRedeploy,
            noChanges: applyResult.noChanges,
            steps: applyResult.steps,
          }),
        },
      )
      .catch(() => {});

    if (envName === "preview") {
      await recordStudioOnboardingEvent(db, {
        orgId,
        projectId: project,
        actorId: caller.author.id,
        step: "first_preview_deploy_succeeded",
        metadata: {
          deployId,
          revision: ctx.current.revision,
          buildHash: ctx.buildHash,
          workerUrl: applyResult.url,
        },
        onlyOncePerProject: true,
      });
    } else if (envName === "production") {
      await recordStudioOnboardingEvent(db, {
        orgId,
        projectId: project,
        actorId: caller.author.id,
        step: "first_production_deploy_succeeded",
        metadata: {
          deployId,
          revision: ctx.current.revision,
          buildHash: ctx.buildHash,
          workerUrl: applyResult.url,
          action: params.actionOverride ?? "apply",
        },
        onlyOncePerProject: true,
      });
    }

    await recordStudioAuditLog(db, {
      orgId,
      projectId: project,
      actorType: caller.author.type,
      actorId: caller.author.id,
      action: "cloudflare_token.use",
      status: "succeeded",
      targetRef: ctx.envRecord.target.tokenRef,
      details: {
        deployId,
        envName,
        tokenRef: ctx.envRecord.target.tokenRef,
        accountId: ctx.envRecord.target.accountId,
      },
    });

    await recordStudioAuditLog(db, {
      orgId,
      projectId: project,
      actorType: caller.author.type,
      actorId: caller.author.id,
      action:
        params.actionOverride === "promote"
          ? "environment.promote"
          : "environment.deploy",
      status: "succeeded",
      targetRef: `${project}:${envName}`,
      details: {
        deployId,
        envName,
        revision: ctx.current.revision,
        buildHash: ctx.buildHash,
        codeHash: ctx.codeHash,
        graphHash: ctx.graphHash,
        planAction: applyResult.action,
        reusedCachedBuild,
        liveWithoutRedeploy: applyResult.liveWithoutRedeploy,
        noChanges: applyResult.noChanges,
      },
    });

    const updatedEnvs = await listProjectDeployEnvironments(db, {
      orgId,
      projectId: project,
    });
    const updatedEnvRecord =
      updatedEnvs.find((e) => e.envName === envName) ?? ctx.envRecord;
    const enrichedEnvRecord = await enrichEnvironmentWithDriftAndHistory(
      db,
      project,
      updatedEnvRecord,
      {
        currentRev: ctx.current.revision,
        buildHash: ctx.buildHash,
        codeHash: ctx.codeHash,
        graphHash: ctx.graphHash,
      },
      env,
    );

    return {
      ok: true as const,
      deployId,
      project,
      orgId,
      envName,
      revision: ctx.current.revision,
      buildHash: ctx.buildHash,
      codeHash: ctx.codeHash,
      graphHash: ctx.graphHash,
      action: applyResult.action,
      statusMessage,
      reusedCachedBuild,
      assembleCount: ctx.assembleCount,
      liveWithoutRedeploy: applyResult.liveWithoutRedeploy,
      noChanges: applyResult.noChanges,
      mutatingCallCount: applyResult.mutatingCallCount,
      scriptUploadCount: controlPlane.scriptUploadCount ?? 0,
      appliedActions: applyResult.appliedActions,
      steps: applyResult.steps,
      ...(params.promotedFromEnv
        ? { promotedFromEnv: params.promotedFromEnv }
        : {}),
      deployment: {
        ...applyResult,
        statusMessage,
        reusedCachedBuild,
        assembleCount: ctx.assembleCount,
      },
      plan: ctx.plan,
      environment: enrichedEnvRecord,
    };
  }

  app.post("/api/projects/:project/environments/:envName/plan", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const envNameParam = c.req.param("envName");
    const parsedEnvName = DeployEnvNameSchema.safeParse(envNameParam);
    if (!parsedEnvName.success) {
      return c.json(
        {
          error: {
            code: "INVALID_ENVIRONMENT_NAME",
            message: `Environment "${envNameParam}" must be "preview" or "production"`,
          },
        },
        400,
      );
    }
    const envName = parsedEnvName.data;

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = await c.req.json().catch(() => undefined);
    const parsedBody = EnvironmentPlanBodySchema.safeParse(rawBody);
    const bodyData = parsedBody.success ? parsedBody.data : undefined;

    const customMigs = bodyData?.migrations ?? bodyData?.pendingMigrations;
    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      // Story 16 (C1): planning a deploy is a builder-or-higher action (a viewer gets 403). A plan with custom migrations
      // needs the edit scope; a plain plan accepts any valid token scope, as before.
      "mutate",
      bodyData?.orgId ?? c.req.query("orgId") ?? c.req.header("x-org-id"),
      customMigs && customMigs.length > 0 ? "edit" : "any",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }
    const ctx = await buildEnvironmentPlanContext({
      env: c.env,
      project,
      orgId: authz.orgId,
      envName,
      customMigrationsInput: customMigs,
      persistCustomMigrations: Boolean(customMigs && customMigs.length > 0),
    });

    if (!ctx.ok) {
      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "environment.deploy",
        status: "validation_failed",
        details: {
          envName,
          code: ctx.error.code,
          ...(resolved.caller.author.client
            ? { client: resolved.caller.author.client }
            : {}),
        },
      });
      return c.json({ error: ctx.error }, ctx.status);
    }

    return c.json(
      {
        ...ctx.plan,
        project,
        orgId: authz.orgId,
        envName,
        revision: ctx.current.revision,
        deployedRev: ctx.envRecord.deployedRev,
        codeHash: ctx.codeHash,
        graphHash: ctx.graphHash,
        reusedCachedBuild: ctx.reusedCachedBuild,
        assembleCount: ctx.assembleCount,
        liveWithoutRedeploy: ctx.plan.action === "hot_apply_graphs",
        identity: ctx.current.state.identity,
        preflight: ctx.preflight,
        environment: ctx.envRecord,
      },
      200,
    );
  });

  app.post("/api/projects/:project/environments/:envName/deploy", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const envNameParam = c.req.param("envName");
    const parsedEnvName = DeployEnvNameSchema.safeParse(envNameParam);
    if (!parsedEnvName.success) {
      return c.json(
        {
          error: {
            code: "INVALID_ENVIRONMENT_NAME",
            message: `Environment "${envNameParam}" must be "preview" or "production"`,
          },
        },
        400,
      );
    }
    const envName = parsedEnvName.data;

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = await c.req.json().catch(() => undefined);
    const parsedBody = EnvironmentDeployBodySchema.safeParse(rawBody);
    const bodyData = parsedBody.success ? parsedBody.data : undefined;

    const customMigs = bodyData?.migrations ?? bodyData?.pendingMigrations;
    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      bodyData?.orgId ?? c.req.query("orgId") ?? c.req.header("x-org-id"),
      "deploy",
    );
    if (!authz.ok) {
      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "environment.deploy",
        status: "forbidden",
        targetRef: `${project}:${envName}`,
        details: { envName, code: authz.error.code, role: authz.role },
        request: c.req.raw,
      });
      return c.json({ error: authz.error }, authz.status);
    }
    const ctx = await buildEnvironmentPlanContext({
      env: c.env,
      project,
      orgId: authz.orgId,
      envName,
      customMigrationsInput: customMigs,
      persistCustomMigrations: false,
    });

    if (!ctx.ok) {
      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "environment.deploy",
        status: "validation_failed",
        details: {
          envName,
          code: ctx.error.code,
          ...(resolved.caller.author.client
            ? { client: resolved.caller.author.client }
            : {}),
        },
      });
      return c.json({ error: ctx.error }, ctx.status);
    }

    if (ctx.plan.blockers.length > 0) {
      const primaryBlocker = ctx.plan.blockers[0]!;
      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "environment.deploy",
        status: "validation_failed",
        details: {
          envName,
          code: primaryBlocker.code,
          blockers: ctx.plan.blockers,
        },
      });
      return c.json(
        {
          ok: false,
          error: {
            code: primaryBlocker.code,
            message: primaryBlocker.message,
            remediation: primaryBlocker.remediation,
            blockers: ctx.plan.blockers,
          },
          plan: ctx.plan,
        },
        422,
      );
    }

    if (ctx.plan.d1.destructiveWarnings.length > 0) {
      const requiredMigrationNames = Array.from(
        new Set(ctx.plan.d1.destructiveWarnings.map((w) => w.migrationName)),
      );
      const confirmedSet = new Set(bodyData?.confirmedMigrationNames ?? []);
      const allConfirmed =
        bodyData?.confirmDestructive === true &&
        requiredMigrationNames.every((name) => confirmedSet.has(name));

      if (!allConfirmed) {
        await recordStudioAuditLog(db, {
          orgId: authz.orgId,
          projectId: project,
          actorType: resolved.caller.author.type,
          actorId: resolved.caller.author.id,
          action: "environment.deploy",
          status: "validation_failed",
          details: {
            envName,
            code: "DESTRUCTIVE_MIGRATION_CONFIRMATION_REQUIRED",
            requiredMigrationNames,
          },
        });
        return c.json(
          {
            ok: false,
            error: {
              code: "DESTRUCTIVE_MIGRATION_CONFIRMATION_REQUIRED",
              message:
                "This deployment contains destructive SQL migrations that permanently drop data. Set confirmDestructive: true and include all destructive migration names in confirmedMigrationNames.",
              destructiveWarnings: ctx.plan.d1.destructiveWarnings,
              requiredMigrationNames,
            },
            plan: ctx.plan,
          },
          422,
        );
      }
    }

    // AD-V8: an MCP token's deploy needs a Studio approval bound to this environment, revision and plan (including each
    // migration's SQL, since custom migration SQL comes from the request body, and the destructive confirmations).
    const deployMigrations = await summarizePlanMigrations({
      pendingMigrations: ctx.plan.d1.pendingMigrations,
      pendingMigrationSql: ctx.plan.d1.pendingMigrationSql,
      ...(customMigs ? { customMigrations: customMigs } : {}),
      destructiveNames: ctx.plan.d1.destructiveWarnings.map((w) => w.migrationName),
    });
    // Story 1.19: platform-made secrets this preview deploy would generate (names only) are part of what is approved.
    const generateSecrets = ctx.plan.secrets.filter((s) => s.status === "will_generate").map((s) => s.name).sort();
    const deployGate = await gateDestructiveAction(
      c,
      resolved.caller,
      {
        orgId: authz.orgId,
        projectId: project,
        action: "deploy",
        env: envName,
        blueprintRev: ctx.current.revision,
        planFingerprint: await computePlanFingerprint({
          envName,
          action: ctx.plan.action,
          buildHash: ctx.buildHash,
          codeHash: ctx.codeHash,
          graphHash: ctx.graphHash,
          revision: ctx.current.revision,
          pendingMigrations: ctx.plan.d1.pendingMigrations,
          migrations: deployMigrations,
          ...(bodyData?.confirmDestructive !== undefined ? { confirmDestructive: bodyData.confirmDestructive } : {}),
          ...(bodyData?.confirmedMigrationNames ? { confirmedMigrationNames: bodyData.confirmedMigrationNames } : {}),
          ...(generateSecrets.length > 0 ? { extra: { generateSecrets } } : {}),
        }),
        summary: {
          planAction: ctx.plan.action,
          revision: ctx.current.revision,
          deployedRev: ctx.envRecord.deployedRev,
          buildHash: ctx.buildHash,
          pendingMigrations: ctx.plan.d1.pendingMigrations,
          migrations: deployMigrations,
          destructiveWarnings: ctx.plan.d1.destructiveWarnings.length,
          confirmDestructive: bodyData?.confirmDestructive === true,
          ...(generateSecrets.length > 0 ? { generateSecrets, generate: generateSecrets.map((n) => `generate ${n}`) } : {}),
        },
      },
      bodyData?.approvalId,
    );
    if (deployGate) return deployGate;
    // Story 1.19: approved (or a Studio session): generate, seal and bind the platform-made secrets, then plan again so the
    // deploy runs on the bound refs. Nothing below returns or logs a value.
    let deployCtx = ctx;
    if (generateSecrets.length > 0) {
      const generated = await generateApprovedDeploySecrets({
        env: c.env,
        project,
        orgId: authz.orgId,
        envName,
        role: authz.role,
        caller: resolved.caller,
        secrets: ctx.plan.secrets.filter((s) => s.status === "will_generate"),
        customMigs,
        approved: { revision: ctx.current.revision, state: ctx.current.state },
      });
      if (!generated.ok) return c.json({ ok: false, error: generated.error }, generated.status);
      deployCtx = generated.ctx;
    }
    // Recorded only once the deploy really starts (after the approval gate), so a refused agent deploy is not a start.
    if (envName === "preview") {
      await recordStudioOnboardingEvent(db, {
        orgId: authz.orgId,
        projectId: project,
        actorId: resolved.caller.author.id,
        step: "first_preview_deploy_started",
        metadata: {
          envName: "preview",
        },
        onlyOncePerProject: true,
      });
    }

    const result = await executeEnvironmentDeployment({
      env: c.env,
      project,
      orgId: authz.orgId,
      envName,
      caller: resolved.caller,
      ctx: deployCtx,
      actionOverride: "apply",
    });

    return c.json(result, 200);
  });

  /**
   * Story 1.19: after the deploy's approval gate, the platform-made secrets of a preview deploy are generated (32 random
   * bytes, sealed in the vault; an existing row is reused), bound to their brick in the blueprint, and the plan is built
   * again on the bound refs. Returns names and refs only; the audit row holds the same.
   */
  async function generateApprovedDeploySecrets(p: {
    env: StudioApiEnv;
    project: string;
    orgId: string;
    envName: DeployEnvName;
    role: string;
    caller: StudioCaller;
    secrets: ReadonlyArray<{ name: string; requiredByBrick: string }>;
    customMigs: Parameters<typeof buildEnvironmentPlanContext>[0]["customMigrationsInput"];
    /** What the approval (or the session's request) covered: the bind may move the revision by one, and nothing else. */
    approved: { revision: number; state: ProjectStatePayload["state"] };
  }): Promise<
    | { ok: true; ctx: Extract<Awaited<ReturnType<typeof buildEnvironmentPlanContext>>, { ok: true }> }
    | { ok: false; status: 409 | 422 | 500; error: { code: string; message: string; remediation?: string } }
  > {
    const db = p.env.STUDIO_DB;
    if (p.envName !== "preview") {
      return { ok: false, status: 422, error: { code: "MISSING_REQUIRED_SECRETS", message: `Production never generates secrets: ${p.secrets.map((s) => s.name).join(", ")}`, remediation: "Bind a value in Studio (Connections/secrets) or promote from preview." } };
    }
    await appOptions.deploy?.beforeGeneratedSecretBind?.({ project: p.project, envName: p.envName });
    const stored = await storeGeneratedSecrets({
      db,
      vaultKey: p.env.PX_VAULT_KEY ?? p.env.BETTER_AUTH_SECRET,
      orgId: p.orgId,
      project: p.project,
      actorId: p.caller.author.id,
      secrets: p.secrets,
    });
    const doRes = await getBlueprintStub(p.env, p.project).fetch("http://blueprint-do/ops", {
      method: "POST",
      headers: { "content-type": "application/json", "x-studio-caller-role": p.role },
      body: JSON.stringify({
        project: p.project,
        orgId: p.orgId,
        callerRole: p.role,
        author: p.caller.author,
        summary: `Studio: bind generated secret${stored.length > 1 ? "s" : ""} ${stored.map((s) => s.name).join(", ")} (approved preview deploy)`,
        ops: stored.map((s, i) => ({ opId: `bind-generated-${s.ref}-${Date.now()}-${i}`, type: "bind_secret_ref", targetKind: "brick", targetId: s.brick, secretName: s.name, ref: s.ref })),
      }),
    });
    await recordStudioAuditLog(db, {
      orgId: p.orgId,
      projectId: p.project,
      actorType: p.caller.author.type,
      actorId: p.caller.author.id,
      action: "secret.generate",
      status: doRes.status === 200 ? "succeeded" : "failed",
      targetRef: `${p.project}:${p.envName}`,
      details: { envName: p.envName, secrets: stored.map((s) => ({ name: s.name, ref: s.ref, brick: s.brick, created: s.created })) },
    });
    if (doRes.status !== 200) {
      return { ok: false, status: 500, error: { code: "GENERATED_SECRET_BIND_FAILED", message: `The generated secret${stored.length > 1 ? "s" : ""} ${stored.map((s) => s.name).join(", ")} could not be bound (HTTP ${doRes.status}); nothing was deployed. Retry the deploy.` } };
    }
    const ctx = await buildEnvironmentPlanContext({ env: p.env, project: p.project, orgId: p.orgId, envName: p.envName, customMigrationsInput: p.customMigs, persistCustomMigrations: false });
    if (!ctx.ok) return { ok: false, status: 422, error: ctx.error };
    // Only the bind may have changed the blueprint: any other op that landed after the approval is not deployed under it. The
    // blueprint, less the refs just bound, must hash as the approved one did (the assembled code carries the refs, so the
    // build and code hashes themselves move with the bind).
    const bound = new Set(stored.map((b) => `${b.brick}|${b.name}|${b.ref}`));
    const withoutBound = { ...ctx.current.state, secretRefs: (ctx.current.state.secretRefs ?? []).filter((r) => !(r.targetKind === "brick" && bound.has(`${r.targetId}|${r.secretName}|${r.ref}`))) };
    if (
      ctx.current.revision !== p.approved.revision + 1 ||
      computeBlueprintCodeHash(withoutBound) !== computeBlueprintCodeHash(p.approved.state) ||
      computeBlueprintGraphHash(withoutBound) !== computeBlueprintGraphHash(p.approved.state)
    ) {
      return {
        ok: false,
        status: 409,
        error: {
          code: "APPROVAL_STALE",
          message: `The blueprint changed after this deploy was approved (approved revision ${p.approved.revision}, now ${ctx.current.revision}); nothing was deployed. The generated secrets are stored and bound and will be reused.`,
          remediation: "Plan again and request a new approval for the current revision, then retry the deploy.",
        },
      };
    }
    if (ctx.plan.blockers.length > 0) {
      const b = ctx.plan.blockers[0]!;
      return { ok: false, status: 422, error: { code: b.code, message: b.message, remediation: b.remediation } };
    }
    return { ok: true, ctx };
  }

  app.post("/api/projects/:project/environments/:envName/promote", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const envNameParam = c.req.param("envName");
    const parsedEnvName = DeployEnvNameSchema.safeParse(envNameParam);
    if (!parsedEnvName.success) {
      return c.json(
        {
          error: {
            code: "INVALID_ENVIRONMENT_NAME",
            message: `Environment "${envNameParam}" must be "preview" or "production"`,
          },
        },
        400,
      );
    }
    const envName = parsedEnvName.data;

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = await c.req.json().catch(() => undefined);
    const parsedBody = EnvironmentDeployBodySchema.safeParse(rawBody);
    const bodyData = parsedBody.success ? parsedBody.data : undefined;

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      bodyData?.orgId ?? c.req.query("orgId") ?? c.req.header("x-org-id"),
      "deploy",
    );
    if (!authz.ok) {
      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "environment.promote",
        status: "forbidden",
        targetRef: `${project}:${envName}`,
        details: { envName, code: authz.error.code, role: authz.role },
        request: c.req.raw,
      });
      return c.json({ error: authz.error }, authz.status);
    }

    const environments = await listProjectDeployEnvironments(db, {
      orgId: authz.orgId,
      projectId: project,
    });
    const previewEnv = environments.find((e) => e.envName === "preview") ?? null;
    const preferredBuildHash = previewEnv?.buildHash ?? undefined;

    const assembleCountBefore = getProjectAssembleCount(project);
    const customMigs = bodyData?.migrations ?? bodyData?.pendingMigrations;

    const ctx = await buildEnvironmentPlanContext({
      env: c.env,
      project,
      orgId: authz.orgId,
      envName,
      preferredBuildHash,
      allowPreviewScopedSecrets: true,
      customMigrationsInput: customMigs,
      persistCustomMigrations: false,
    });

    if (!ctx.ok) {
      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "environment.deploy",
        status: "validation_failed",
        details: {
          envName,
          code: ctx.error.code,
          ...(resolved.caller.author.client
            ? { client: resolved.caller.author.client }
            : {}),
        },
      });
      return c.json({ error: ctx.error }, ctx.status);
    }

    const assembleCountAfter = getProjectAssembleCount(project);
    const reusedCachedBuild =
      ctx.reusedCachedBuild || assembleCountAfter === assembleCountBefore;

    if (ctx.plan.blockers.length > 0) {
      const primaryBlocker = ctx.plan.blockers[0]!;
      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "environment.promote",
        status: "validation_failed",
        details: {
          envName,
          code: primaryBlocker.code,
          blockers: ctx.plan.blockers,
        },
      });
      return c.json(
        {
          ok: false,
          error: {
            code: primaryBlocker.code,
            message: primaryBlocker.message,
            remediation: primaryBlocker.remediation,
            blockers: ctx.plan.blockers,
          },
          plan: ctx.plan,
        },
        422,
      );
    }

    if (ctx.plan.d1.destructiveWarnings.length > 0) {
      const requiredMigrationNames = Array.from(
        new Set(ctx.plan.d1.destructiveWarnings.map((w) => w.migrationName)),
      );
      const confirmedSet = new Set(bodyData?.confirmedMigrationNames ?? []);
      const allConfirmed =
        bodyData?.confirmDestructive === true &&
        requiredMigrationNames.every((name) => confirmedSet.has(name));

      if (!allConfirmed) {
        return c.json(
          {
            ok: false,
            error: {
              code: "DESTRUCTIVE_MIGRATION_CONFIRMATION_REQUIRED",
              message:
                "This promotion contains destructive SQL migrations that permanently drop data. Set confirmDestructive: true and include all destructive migration names in confirmedMigrationNames.",
              destructiveWarnings: ctx.plan.d1.destructiveWarnings,
              requiredMigrationNames,
            },
            plan: ctx.plan,
          },
          422,
        );
      }
    }

    // AD-V8: an MCP token's promotion needs a Studio approval bound to this environment, revision and plan (including
    // each migration's SQL and the destructive confirmations).
    const promoteMigrations = await summarizePlanMigrations({
      pendingMigrations: ctx.plan.d1.pendingMigrations,
      pendingMigrationSql: ctx.plan.d1.pendingMigrationSql,
      ...(customMigs ? { customMigrations: customMigs } : {}),
      destructiveNames: ctx.plan.d1.destructiveWarnings.map((w) => w.migrationName),
    });
    const promoteGate = await gateDestructiveAction(
      c,
      resolved.caller,
      {
        orgId: authz.orgId,
        projectId: project,
        action: "promote",
        env: envName,
        blueprintRev: ctx.current.revision,
        planFingerprint: await computePlanFingerprint({
          envName,
          action: ctx.plan.action,
          buildHash: ctx.buildHash,
          codeHash: ctx.codeHash,
          graphHash: ctx.graphHash,
          revision: ctx.current.revision,
          pendingMigrations: ctx.plan.d1.pendingMigrations,
          migrations: promoteMigrations,
          ...(bodyData?.confirmDestructive !== undefined ? { confirmDestructive: bodyData.confirmDestructive } : {}),
          ...(bodyData?.confirmedMigrationNames ? { confirmedMigrationNames: bodyData.confirmedMigrationNames } : {}),
        }),
        summary: {
          planAction: ctx.plan.action,
          promotedFromEnv: "preview",
          revision: ctx.current.revision,
          deployedRev: ctx.envRecord.deployedRev,
          buildHash: ctx.buildHash,
          pendingMigrations: ctx.plan.d1.pendingMigrations,
          migrations: promoteMigrations,
          destructiveWarnings: ctx.plan.d1.destructiveWarnings.length,
          confirmDestructive: bodyData?.confirmDestructive === true,
        },
      },
      bodyData?.approvalId,
    );
    if (promoteGate) return promoteGate;

    const result = await executeEnvironmentDeployment({
      env: c.env,
      project,
      orgId: authz.orgId,
      envName,
      caller: resolved.caller,
      ctx,
      actionOverride: "promote",
      promotedFromEnv: "preview",
      reusedCachedBuild,
    });

    return c.json(result, 200);
  });

  app.get(
    "/api/projects/:project/environments/:envName/deployments",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project");
      const envNameParam = c.req.param("envName");
      const parsedEnvName = DeployEnvNameSchema.safeParse(envNameParam);
      if (!parsedEnvName.success) {
        return c.json(
          {
            error: {
              code: "INVALID_ENVIRONMENT_NAME",
              message: `Environment "${envNameParam}" must be "preview" or "production"`,
            },
          },
          400,
        );
      }
      const envName = parsedEnvName.data;

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "read",
        c.req.query("orgId") ?? c.req.header("x-org-id"),
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      const deployments = await loadEnvironmentDeploymentHistory(
        db,
        project,
        envName,
      );

      return c.json(
        {
          project,
          envName,
          deployments,
        },
        200,
      );
    },
  );

  // --- Epic 9 (CP9): Hosted Sandbox Target, 7-Day TTL Reaper, and Move to BYOC Promotion ---

  app.post("/api/admin/sandboxes/prune", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    // Story 16: platform operators only (PX_PLATFORM_OPERATORS); MCP tokens never.
    const operatorRefusal = refuseNonPlatformOperator(c.env, resolved.caller);
    if (operatorRefusal) {
      return c.json({ error: operatorRefusal }, 403);
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = (await c.req.json().catch(() => ({}))) as {
      now?: string | number;
    };
    const nowInput =
      rawBody.now !== undefined
        ? rawBody.now
        : (c.req.query("now") ?? undefined);

    const result = await pruneExpiredSandboxes(db, {
      ...(nowInput !== undefined ? { now: nowInput } : {}),
    });

    return c.json(result, 200);
  });

  app.get("/api/projects/:project/sandbox", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const nowQuery = c.req.query("now");
    const nowMs =
      nowQuery && Number.isFinite(Date.parse(nowQuery))
        ? Date.parse(nowQuery)
        : Date.now();
    const sandbox = await loadProjectSandboxSummary(db, project, nowMs);

    return c.json(
      {
        ok: true,
        project,
        orgId: authz.orgId,
        sandbox,
      },
      200,
    );
  });

  const DeploySandboxBodySchema = z
    .object({
      orgId: z.string().min(1).max(128).optional(),
      sandboxId: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-_]{2,62}$/)
        .optional(),
      dispatchNamespace: z.string().min(1).max(64).optional(),
      expiresAt: z.string().datetime({ offset: true }).optional(),
      now: z.union([z.string(), z.number()]).optional(),
      secrets: z.record(z.string(), z.string()).optional(),
      approvalId: z.string().min(1).max(128).optional(),
    })
    .optional();

  app.post("/api/projects/:project/sandbox/deploy", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = await c.req.json().catch(() => undefined);
    const parsedBody = DeploySandboxBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: parsedBody.error.issues.map((i) => i.message).join("; "),
            issues: parsedBody.error.issues,
          },
        },
        422,
      );
    }
    const bodyData = parsedBody.data;

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      bodyData?.orgId ?? c.req.query("orgId") ?? c.req.header("x-org-id"),
      "deploy",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const nowMs =
      typeof bodyData?.now === "number"
        ? bodyData.now
        : typeof bodyData?.now === "string" &&
            Number.isFinite(Date.parse(bodyData.now))
          ? Date.parse(bodyData.now)
          : Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // Check existing secrets in studio_secret_vault for live payment credentials
    const vaultRows = await db
      .prepare(
        `SELECT ref, label, app_or_brick, ciphertext_b64, iv_b64
         FROM studio_secret_vault
         WHERE project_id = ? AND status = 'valid'`,
      )
      .bind(project)
      .all<{
        ref: string;
        label: string;
        app_or_brick: string;
        ciphertext_b64: string;
        iv_b64: string;
      }>();

    const vaultKeySecret = c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
    const configuredSecretValues: Record<string, string> = {
      ...(bodyData?.secrets ?? {}),
    };

    for (const [secName, secVal] of Object.entries(configuredSecretValues)) {
      const check = isLivePaymentCredential(secName, secVal);
      if (check.blocked) {
        return c.json(
          {
            error: {
              code: "SANDBOX_LIVE_PAYMENTS_BLOCKED",
              message:
                check.reason ??
                "Live payment credentials (sk_live_*, Cashfree production keys) are blocked in hosted sandboxes.",
            },
          },
          403,
        );
      }
    }

    for (const row of vaultRows.results ?? []) {
      try {
        const plain = await decryptSecretValue(
          row.ciphertext_b64,
          row.iv_b64,
          vaultKeySecret,
        );
        const check = isLivePaymentCredential(
          `${row.ref}:${row.label}:${row.app_or_brick}`,
          plain,
        );
        if (check.blocked) {
          return c.json(
            {
              error: {
                code: "SANDBOX_LIVE_PAYMENTS_BLOCKED",
                message:
                  check.reason ??
                  "Live payment credentials (sk_live_*, Cashfree production keys) are blocked in hosted sandboxes.",
              },
            },
            403,
          );
        }
        configuredSecretValues[row.ref] = `sealed:${row.ref}`;
      } catch {
        // Ignore unseal errors
      }
    }

    const stub = getBlueprintStub(c.env, project);
    const stateRes = await stub.fetch(
      `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
      { method: "GET" },
    );
    const current = (await stateRes.json()) as ProjectStatePayload;

    // Check content-addressed builds cache first
    const cachedRow = await db
      .prepare(
        `SELECT build_hash, code_hash, graph_hash, bundle_code, files_json, assemble_count
         FROM builds
         WHERE project_id = ? AND revision = ? AND semantic_hash = ?
         LIMIT 1`,
      )
      .bind(project, current.revision, current.semanticHash)
      .first<{
        build_hash: string;
        code_hash: string;
        graph_hash: string;
        bundle_code: string;
        files_json: string;
        assemble_count: number;
      }>();

    let buildHash: string;
    let codeHash: string;
    let graphHash: string;
    let bundleCode: string;
    let reusedCachedBuild = false;
    let assembleCount = getProjectAssembleCount(project, current.revision);
    const allMigrations: ProvisionerMigrationItem[] = [];

    if (cachedRow) {
      reusedCachedBuild = true;
      buildHash = cachedRow.build_hash;
      codeHash = cachedRow.code_hash;
      graphHash = cachedRow.graph_hash;
      bundleCode = cachedRow.bundle_code;
      assembleCount = Math.max(assembleCount, Number(cachedRow.assemble_count || 1));
      const cachedFiles = JSON.parse(cachedRow.files_json) as Record<string, string>;
      for (const [filePath, sqlText] of Object.entries(cachedFiles)) {
        if (filePath.startsWith("migrations/") && filePath.endsWith(".sql")) {
          const shortName = filePath.replace(/^migrations\//, "");
          allMigrations.push({
            name: shortName,
            sql: sqlText,
            sha256: await sha256Hex(sqlText),
          });
        }
      }
    } else {
      const assembled = assemble(toAssemblerBlueprint(current.state), catalog);
      if (assembled.ok) {
        const revKey = `${project}:r${current.revision}`;
        const nextRevCount = (studioProjectAssembleCounts.get(revKey) ?? 0) + 1;
        studioProjectAssembleCounts.set(revKey, nextRevCount);
        studioProjectAssembleCounts.set(
          project,
          (studioProjectAssembleCounts.get(project) ?? 0) + 1,
        );
        assembleCount = nextRevCount;

        const catalogVersion =
          current.state.metadata?.catalogVersion ?? DEFAULT_CATALOG_VERSION;
        const hashes = await computeArtifactHashes(assembled.files, {
          catalogVersion,
        });
        buildHash = hashes.buildHash;
        codeHash = hashes.codeHash;
        graphHash = hashes.graphHash;
        bundleCode =
          assembled.files["src/index.ts"] ??
          "export default { fetch() { return new Response('ok'); } };";

        const fileCount = Object.keys(assembled.files).length;
        const byteCount = Object.values(assembled.files).reduce(
          (sum, text) => sum + new TextEncoder().encode(text).length,
          0,
        );
        await db
          .prepare(
            `INSERT INTO studio_builds (project_id, revision, build_hash, semantic_hash, file_count, byte_count, files_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(project_id, revision) DO UPDATE SET
               build_hash = excluded.build_hash,
               semantic_hash = excluded.semantic_hash,
               file_count = excluded.file_count,
               byte_count = excluded.byte_count,
               files_json = excluded.files_json,
               created_at = excluded.created_at`,
          )
          .bind(
            project,
            current.revision,
            buildHash,
            current.semanticHash,
            fileCount,
            byteCount,
            JSON.stringify(assembled.files),
          )
          .run();

        await db
          .prepare(
            `INSERT INTO builds (
               build_hash, project_id, revision, semantic_hash, code_hash, graph_hash,
               catalog_version, bundle_code, bundle_sha256, files_json, assemble_count, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(build_hash) DO UPDATE SET
               revision = excluded.revision,
               semantic_hash = excluded.semantic_hash,
               files_json = excluded.files_json
             WHERE builds.project_id = excluded.project_id`,
          )
          .bind(
            buildHash,
            project,
            current.revision,
            current.semanticHash,
            codeHash,
            graphHash,
            catalogVersion,
            bundleCode,
            codeHash,
            JSON.stringify(assembled.files),
            assembleCount,
          )
          .run();

        for (const [filePath, sqlText] of Object.entries(assembled.files)) {
          if (filePath.startsWith("migrations/") && filePath.endsWith(".sql")) {
            const shortName = filePath.replace(/^migrations\//, "");
            allMigrations.push({
              name: shortName,
              sql: sqlText,
              sha256: await sha256Hex(sqlText),
            });
          }
        }
      } else {
        buildHash = current.semanticHash || `sha256_rev_${current.revision}`;
        codeHash = computeBlueprintCodeHash(current.state);
        graphHash = computeBlueprintGraphHash(current.state);
        bundleCode = "export default { fetch() { return new Response('ok'); } };";
      }
    }

    const existingActiveSandbox = await db
      .prepare(
        `SELECT sandbox_id, dispatch_namespace, created_at, expires_at
         FROM studio_sandboxes
         WHERE project_id = ? AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .bind(project)
      .first<{
        sandbox_id: string;
        dispatch_namespace: string;
        created_at: string;
        expires_at: string;
      }>();

    const sanitizedProjectSlug = project
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28);
    const sandboxId =
      bodyData?.sandboxId ??
      existingActiveSandbox?.sandbox_id ??
      `sbx-${sanitizedProjectSlug || "project"}`;
    // Story 16: a sandbox id held by another project is never reused (or overwritten) for this one.
    const sandboxOwner = await db
      .prepare("SELECT project_id FROM studio_sandboxes WHERE sandbox_id = ? LIMIT 1")
      .bind(sandboxId)
      .first<{ project_id: string }>();
    if (sandboxOwner && sandboxOwner.project_id !== project) {
      return c.json(
        {
          error: {
            code: "SANDBOX_ID_IN_USE",
            message: `Sandbox "${sandboxId}" belongs to another project; choose a different sandbox id`,
          },
        },
        409,
      );
    }
    const dispatchNamespace =
      bodyData?.dispatchNamespace ??
      existingActiveSandbox?.dispatch_namespace ??
      "px-sandboxes";
    const createdAt = existingActiveSandbox?.created_at ?? nowIso;
    const expiresAt =
      bodyData?.expiresAt ??
      new Date(nowMs + SANDBOX_TTL_MS).toISOString();

    const workflows: Array<{ name: string; className: string }> = [];
    const graphs: Record<string, string> = {};
    const cronTriggers: string[] = [];
    for (const wf of current.state.workflows ?? []) {
      workflows.push({ name: wf.id, className: "GraphRunner" });
      graphs[wf.id] = JSON.stringify(wf);
      for (const node of wf.nodes ?? []) {
        const cronVal = node.data?.cron;
        if (typeof cronVal === "string" && cronVal.trim().length > 0) {
          const cronStr = cronVal.trim();
          if (!cronTriggers.includes(cronStr)) {
            cronTriggers.push(cronStr);
          }
        }
      }
    }

    const sandboxTarget: PlatformSandboxDeployTarget = {
      type: "platform-sandbox",
      sandboxId,
      dispatchNamespace,
      expiresAt,
    };

    const sandboxDriver = new HostedSandboxTarget({
      platform: studioSandboxPlatform,
      now: () => nowMs,
    });

    // AD-V8: an MCP token's sandbox deploy needs a Studio approval bound to the revision and the build it would
    // deploy. It runs after every validation, right before the deploy, so a request that fails validation spends nothing.
    const sandboxSecretsDigest = await sha256Hex(
      JSON.stringify(
        await Promise.all(
          Object.entries(bodyData?.secrets ?? {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(async ([name, value]) => [name, await sha256Hex(value)]),
        ),
      ),
    );
    const sandboxGate = await gateDestructiveAction(
      c,
      resolved.caller,
      {
        orgId: authz.orgId,
        projectId: project,
        action: "sandbox_deploy",
        env: "preview",
        target: sandboxId,
        blueprintRev: current.revision,
        // The body's secrets (by name and value hash, never the value), expiry and clock are part of what is approved.
        planFingerprint: await sha256Hex(
          JSON.stringify({
            buildHash,
            codeHash,
            graphHash,
            sandboxId,
            dispatchNamespace,
            secrets: sandboxSecretsDigest,
            // The caller's own expiry and clock (a default expiry is derived from the time of each request, so only an
            // explicit one is bound).
            expiresAt: bodyData?.expiresAt ?? null,
            now: bodyData?.now ?? null,
          }),
        ),
        summary: {
          revision: current.revision,
          buildHash,
          sandboxId,
          secretNames: Object.keys(bodyData?.secrets ?? {}).sort(),
          expiresAt: bodyData?.expiresAt ?? `default (${Math.round(SANDBOX_TTL_MS / 3_600_000)} h after the deploy)`,
          ...(bodyData?.now !== undefined ? { clock: String(bodyData.now) } : {}),
        },
      },
      bodyData?.approvalId,
    );
    if (sandboxGate) return sandboxGate;
    // Recorded after the approval gate, so a refused agent deploy is not a start.
    await recordStudioOnboardingEvent(db, {
      orgId: authz.orgId,
      projectId: project,
      actorId: resolved.caller.author.id,
      step: "first_preview_deploy_started",
      metadata: {
        envName: "preview",
        targetType: "platform-sandbox",
      },
      createdAt: nowIso,
      onlyOncePerProject: true,
    });


    const deployId = `sbxdep_${generateUuidV7(nowMs)}`;
    const applyResult = await sandboxDriver.apply(
      {
        project,
        actor: resolved.caller.author.id,
        deployId,
        buildHash,
        codeHash,
        graphHash,
        bundle: {
          code: bundleCode,
          sha256: codeHash,
        },
        migrations: allMigrations,
        cronTriggers,
        workflows,
        graphs,
        schedules: cronTriggers,
        secrets: configuredSecretValues,
      },
      sandboxTarget,
    );

    // Story 17: the project's schema is applied to the sandbox D1 only, never to STUDIO_DB.
    const liveProvisionedSandbox = studioSandboxPlatform.getSandbox(sandboxId);
    if (liveProvisionedSandbox?.d1) {
      await applyProjectEnvironmentDataSchema(
        liveProvisionedSandbox.d1.rawD1,
        await describeProjectEnvironmentData(c.env, project),
      );
    }

    await db
      .prepare(
        `INSERT INTO studio_sandboxes (
           sandbox_id, project_id, org_id, dispatch_namespace, build_hash, code_hash, graph_hash,
           deployed_rev, preview_url, status, daily_requests_used, d1_rows_used, d1_bytes_used,
           created_at, expires_at, destroyed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, 0, ?, ?, NULL)
         ON CONFLICT(sandbox_id) DO UPDATE SET
           org_id = excluded.org_id,
           dispatch_namespace = excluded.dispatch_namespace,
           build_hash = excluded.build_hash,
           code_hash = excluded.code_hash,
           graph_hash = excluded.graph_hash,
           deployed_rev = excluded.deployed_rev,
           preview_url = excluded.preview_url,
           status = 'active',
           expires_at = excluded.expires_at,
           destroyed_at = NULL
         WHERE studio_sandboxes.project_id = excluded.project_id`,
      )
      .bind(
        sandboxId,
        project,
        authz.orgId,
        dispatchNamespace,
        buildHash,
        codeHash,
        graphHash,
        current.revision,
        applyResult.url,
        createdAt,
        expiresAt,
      )
      .run();

    await recordStudioOnboardingEvent(db, {
      orgId: authz.orgId,
      projectId: project,
      actorId: resolved.caller.author.id,
      step: "first_preview_deploy_succeeded",
      metadata: {
        deployId,
        sandboxId,
        revision: current.revision,
        buildHash,
        workerUrl: applyResult.url,
        targetType: "platform-sandbox",
      },
      createdAt: nowIso,
      onlyOncePerProject: true,
    });

    await recordStudioAuditLog(db, {
      orgId: authz.orgId,
      projectId: project,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "sandbox.deploy",
      status: "succeeded",
      targetRef: sandboxId,
      details: {
        deployId,
        sandboxId,
        dispatchNamespace,
        revision: current.revision,
        buildHash,
        codeHash,
        graphHash,
        previewUrl: applyResult.url,
        expiresAt,
        reusedCachedBuild,
      },
      request: c.req.raw,
    });

    const summary = await loadProjectSandboxSummary(db, project, nowMs);

    return c.json(
      {
        ok: true,
        deployId,
        project,
        orgId: authz.orgId,
        sandboxId,
        dispatchNamespace,
        target: sandboxTarget,
        revision: current.revision,
        buildHash,
        codeHash,
        graphHash,
        reusedCachedBuild,
        assembleCount,
        previewUrl: applyResult.url,
        url: applyResult.url,
        versionId: applyResult.versionId,
        databaseId: applyResult.databaseId,
        createdAt,
        expiresAt,
        remainingDays: summary?.remainingDays ?? SANDBOX_TTL_DAYS,
        quotas: summary?.quotas ?? {
          dailyRequestLimit: SANDBOX_DAILY_REQUEST_LIMIT,
          dailyRequestsUsed: 0,
          d1MaxRows: SANDBOX_D1_MAX_ROWS,
          d1RowsUsed: 0,
          d1MaxBytes: SANDBOX_D1_MAX_BYTES,
          d1BytesUsed: 0,
        },
        steps: applyResult.steps,
        deployment: applyResult,
        sandbox: summary,
      },
      200,
    );
  });

  const PromoteSandboxToByocBodySchema = z
    .object({
      orgId: z.string().min(1).max(128).optional(),
      token: z.string().min(1).max(512).optional(),
      apiToken: z.string().min(1).max(512).optional(),
      tokenRef: z.string().min(1).max(128).optional(),
      accountId: z.string().max(128).optional(),
      accountName: z.string().max(120).optional(),
      deployProduction: z.boolean().optional(),
      confirmDestructive: z.boolean().optional(),
      confirmedMigrationNames: z.array(z.string()).optional(),
      approvalId: z.string().min(1).max(128).optional(),
    })
    .optional();

  app.post("/api/projects/:project/sandbox/promote-to-byoc", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = await c.req.json().catch(() => undefined);
    const parsedBody = PromoteSandboxToByocBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: parsedBody.error.issues.map((i) => i.message).join("; "),
            issues: parsedBody.error.issues,
          },
        },
        422,
      );
    }
    const bodyData = parsedBody.data;

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      bodyData?.orgId ?? c.req.query("orgId") ?? c.req.header("x-org-id"),
      "deploy",
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    // Story 17: copying sample rows read unfiltered rows into STUDIO_DB; the option is gone, and asking for it fails
    // loudly rather than being silently ignored.
    if (
      rawBody !== null &&
      typeof rawBody === "object" &&
      Object.prototype.hasOwnProperty.call(rawBody, "copySampleData")
    ) {
      return c.json(
        {
          error: {
            code: "COPY_SAMPLE_DATA_REMOVED",
            message:
              "copySampleData is no longer supported: sandbox rows are not copied when promoting to your Cloudflare account.",
          },
        },
        400,
      );
    }

    // Find the active (or latest) sandbox for this project
    const sandboxSummary = await loadProjectSandboxSummary(db, project);
    if (!sandboxSummary) {
      return c.json(
        {
          error: {
            code: "SANDBOX_NOT_FOUND",
            message: `No hosted sandbox deployment found for project "${project}".`,
          },
        },
        404,
      );
    }

    // Step 1: If a plaintext Cloudflare API token was supplied inline, verify it (sealed after the approval gate below)
    const inlineToken = (bodyData?.token ?? bodyData?.apiToken ?? "").trim();
    let inlineVerification: Extract<Awaited<ReturnType<typeof verifyDeployTokenForRoute>>, { ok: true }>["report"] | null =
      null;
    if (inlineToken) {
      const inlineVerified = await verifyDeployTokenForRoute(
        c.env,
        inlineToken,
        bodyData?.accountId,
      );
      if (!inlineVerified.ok) return inlineVerified.response;
      const verification = inlineVerified.report;
      inlineVerification = verification;
      if (!verification.ok || !verification.accountId) {
        const errorCode = verification.isGlobalApiKey
          ? "GLOBAL_API_KEY_REJECTED"
          : verification.status !== "active"
            ? "INVALID_OR_EXPIRED_TOKEN"
            : "MISSING_REQUIRED_PERMISSIONS";
        return c.json(
          {
            ok: false,
            verification,
            error: {
              code: errorCode,
              message: verification.summaryMessage,
              missingPermissionIds: verification.missingPermissionIds,
              missingPermissionLabels: verification.missingPermissionLabels,
              remediationUrl: verification.remediationUrl,
            },
          },
          422,
        );
      }
    }
    const existingByocToken =
      !inlineToken && bodyData?.tokenRef
        ? await getDeployTokenMetadata(db, bodyData.tokenRef, authz.orgId)
        : null;

    // AD-V8: an MCP token's promotion to a Cloudflare account needs a Studio approval bound to the revision, the
    // destination account, the token that would be used (its ref, or a sha256 of an inline token, never the token), the
    // sandbox build and whether production is deployed too. It runs after the validations above and right before the
    // token is sealed and the deploy starts; a later failure gives the approval back.
    const currentPreviewTarget = (
      await listProjectDeployEnvironments(db, { orgId: authz.orgId, projectId: project })
    ).find((e) => e.envName === "preview")?.target;
    const byocDestination = inlineVerification
      ? { accountId: inlineVerification.accountId ?? "", token: `inline-sha256:${await sha256Hex(inlineToken)}` }
      : existingByocToken && existingByocToken.status === "active"
        ? { accountId: existingByocToken.accountId, token: `ref:${existingByocToken.tokenRef}` }
        : { accountId: currentPreviewTarget?.accountId ?? "", token: `ref:${currentPreviewTarget?.tokenRef ?? ""}` };
    const byocGate = await gateDestructiveAction(
      c,
      resolved.caller,
      {
        orgId: authz.orgId,
        projectId: project,
        action: "promote_to_byoc",
        env: bodyData?.deployProduction ? "production" : "preview",
        target: byocDestination.accountId,
        blueprintRev: await currentBlueprintRevision(c.env, project),
        planFingerprint: await sha256Hex(
          JSON.stringify({
            accountId: byocDestination.accountId,
            token: byocDestination.token,
            buildHash: sandboxSummary.buildHash,
            deployProduction: bodyData?.deployProduction === true,
            confirmDestructive: bodyData?.confirmDestructive === true,
            confirmedMigrationNames: [...(bodyData?.confirmedMigrationNames ?? [])].sort(),
          }),
        ),
        summary: {
          accountId: byocDestination.accountId,
          accountName: inlineVerification?.accountName ?? existingByocToken?.accountName ?? null,
          token: byocDestination.token.startsWith("ref:") ? byocDestination.token : "inline token (sha256 bound)",
          buildHash: sandboxSummary.buildHash,
          deployProduction: bodyData?.deployProduction === true,
        },
      },
      bodyData?.approvalId,
    );
    if (byocGate) return byocGate;

    if (inlineToken && inlineVerification && inlineVerification.accountId) {
      const verification = inlineVerification;
      const resolvedAccountName =
        bodyData?.accountName?.trim() ||
        verification.accountName ||
        "Cloudflare Account";

      const sealedMeta = await sealDeployToken(
        db,
        {
          orgId: authz.orgId,
          accountId: inlineVerification.accountId,
          accountName: resolvedAccountName,
          plaintextToken: inlineToken,
          scopes: verification.permissions
            .filter((p) => p.granted)
            .map((p) => p.label),
          createdBy: resolved.caller.author.id,
        },
        c.env,
      );

      await upsertProjectDeployEnvironments(db, {
        orgId: authz.orgId,
        projectIds: [project],
        accountId: sealedMeta.accountId,
        accountName: sealedMeta.accountName,
        tokenRef: sealedMeta.tokenRef,
      });
    } else if (bodyData?.tokenRef) {
      const existingToken = existingByocToken;
      if (existingToken && existingToken.status === "active") {
        await upsertProjectDeployEnvironments(db, {
          orgId: authz.orgId,
          projectIds: [project],
          accountId: existingToken.accountId,
          accountName: existingToken.accountName,
          tokenRef: existingToken.tokenRef,
        });
      }
    }

    // Step 2: Retrieve the existing content-addressed build artifact for the sandbox's deployed rev WITHOUT calling assemble() again
    const assembleCountBefore = getProjectAssembleCount(project);

    const ctx = await buildEnvironmentPlanContext({
      env: c.env,
      project,
      orgId: authz.orgId,
      envName: "preview",
      preferredBuildHash: sandboxSummary.buildHash,
      persistCustomMigrations: false,
    });

    if (!ctx.ok) {
      return c.json({ error: ctx.error }, ctx.status);
    }

    const assembleCountAfter = getProjectAssembleCount(project);
    const assembleCalledDuringPromote = assembleCountAfter > assembleCountBefore;
    const reusedCachedBuild =
      ctx.reusedCachedBuild || !assembleCalledDuringPromote;

    // Step 3: Deploy the exact same build artifact to ByocCloudflareTarget (preview, and optionally production)
    const byocPreviewResult = await executeEnvironmentDeployment({
      env: c.env,
      project,
      orgId: authz.orgId,
      envName: "preview",
      caller: resolved.caller,
      ctx,
      actionOverride: "apply",
      reusedCachedBuild,
    });

    let byocProductionResult: Awaited<
      ReturnType<typeof executeEnvironmentDeployment>
    > | null = null;
    if (bodyData?.deployProduction) {
      const prodCtx = await buildEnvironmentPlanContext({
        env: c.env,
        project,
        orgId: authz.orgId,
        envName: "production",
        preferredBuildHash: sandboxSummary.buildHash,
        persistCustomMigrations: false,
      });
      if (prodCtx.ok) {
        byocProductionResult = await executeEnvironmentDeployment({
          env: c.env,
          project,
          orgId: authz.orgId,
          envName: "production",
          caller: resolved.caller,
          ctx: prodCtx,
          actionOverride: "promote",
          promotedFromEnv: "preview",
          reusedCachedBuild: true,
        });
      }
    }

    // Step 5: Retire and destroy the ephemeral HostedSandboxTarget resources
    const nowIso = new Date().toISOString();
    const sandboxDriver = new HostedSandboxTarget({
      platform: studioSandboxPlatform,
    });
    await sandboxDriver.destroy({
      type: "platform-sandbox",
      sandboxId: sandboxSummary.sandboxId,
      dispatchNamespace: sandboxSummary.dispatchNamespace,
      expiresAt: sandboxSummary.expiresAt,
    });

    await db
      .prepare(
        `UPDATE studio_sandboxes
         SET status = 'promoted', destroyed_at = ?
         WHERE sandbox_id = ? AND project_id = ?`,
      )
      .bind(nowIso, sandboxSummary.sandboxId, project)
      .run();

    await recordStudioAuditLog(db, {
      orgId: authz.orgId,
      projectId: project,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "sandbox.promote_to_byoc",
      status: "succeeded",
      targetRef: sandboxSummary.sandboxId,
      details: {
        sandboxId: sandboxSummary.sandboxId,
        sandboxBuildHash: sandboxSummary.buildHash,
        byocBuildHash: byocPreviewResult.buildHash,
        buildHashMatched:
          byocPreviewResult.buildHash === sandboxSummary.buildHash,
        reusedCachedBuild,
        assembleCalledDuringPromote,
        sandboxDestroyed: true,
      },
      request: c.req.raw,
    });

    const updatedEnvironments = await listProjectDeployEnvironments(db, {
      orgId: authz.orgId,
      projectId: project,
    });

    return c.json(
      {
        ok: true,
        project,
        orgId: authz.orgId,
        sandboxId: sandboxSummary.sandboxId,
        sandboxBuildHash: sandboxSummary.buildHash,
        byocBuildHash: byocPreviewResult.buildHash,
        buildHash: byocPreviewResult.buildHash,
        codeHash: byocPreviewResult.codeHash,
        graphHash: byocPreviewResult.graphHash,
        buildHashMatched:
          byocPreviewResult.buildHash === sandboxSummary.buildHash,
        reusedCachedBuild,
        assembleCalledDuringPromote,
        sandboxDestroyed: true,
        oldSandboxDestroyed: true,
        byocDeployment: byocPreviewResult,
        byocDeploy: byocPreviewResult.deployment,
        ...(byocProductionResult
          ? { byocProductionDeployment: byocProductionResult }
          : {}),
        previewEnvironment: byocPreviewResult.environment,
        environment: byocPreviewResult.environment,
        environments: updatedEnvironments,
      },
      200,
    );
  });

  const CheckDriftBodySchema = z
    .object({
      orgId: z.string().min(1).max(128).optional(),
      simulateOutOfBand: z
        .object({
          workerHash: z.string().min(1).optional(),
          deleteWorker: z.boolean().optional(),
          appliedMigrations: z.array(z.string()).optional(),
          deleteQueue: z.string().min(1).optional(),
          cronTriggers: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional();

  app.post(
    "/api/projects/:project/environments/:envName/check-drift",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project");
      const envNameParam = c.req.param("envName");
      const parsedEnvName = DeployEnvNameSchema.safeParse(envNameParam);
      if (!parsedEnvName.success) {
        return c.json(
          {
            error: {
              code: "INVALID_ENVIRONMENT_NAME",
              message: `Environment "${envNameParam}" must be "preview" or "production"`,
            },
          },
          400,
        );
      }
      const envName = parsedEnvName.data;

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      const rawBody = await c.req.json().catch(() => undefined);
      const parsedBody = CheckDriftBodySchema.safeParse(rawBody);
      const bodyData = parsedBody.success ? parsedBody.data : undefined;

      // Story 16: a drift check reads, but one that simulates an out-of-band change writes to the target, so it needs
      // a builder-or-higher role (a viewer gets 403).
      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        bodyData?.simulateOutOfBand ? "mutate" : "read",
        bodyData?.orgId ?? c.req.query("orgId") ?? c.req.header("x-org-id"),
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      const environments = await listProjectDeployEnvironments(db, {
        orgId: authz.orgId,
        projectId: project,
      });
      const envRecord =
        environments.find((e) => e.envName === envName) ?? null;
      if (!envRecord) {
        return c.json(
          {
            error: {
              code: "DEPLOY_TARGET_NOT_CONNECTED",
              message: `No Cloudflare deploy target is connected for project "${project}" (${envName}).`,
            },
          },
          422,
        );
      }

      const tokenMeta = await getDeployTokenMetadata(
        db,
        envRecord.target.tokenRef,
        authz.orgId,
      );
      if (!tokenMeta || tokenMeta.status !== "active") {
        return c.json(
          {
            error: {
              code: "TOKEN_REVOKED",
              message: `Cloudflare deploy token "${envRecord.target.tokenRef}" is ${tokenMeta?.status ?? "missing"} — Reconnect in Studio.`,
            },
          },
          422,
        );
      }

      const controlPlane = asFakeControlPlane(
        getStudioControlPlane(envRecord.target.accountId, c.env, appOptions.deploy),
      );
      const resourceNames = deriveEnvironmentResourceNames(
        project,
        envRecord.target,
      );

      // simulateOutOfBand is a test hook of the fake; against a real account it is ignored (drift is read, never made).
      if (bodyData?.simulateOutOfBand && controlPlane) {
        const sim = bodyData.simulateOutOfBand;
        if (sim.workerHash || sim.deleteWorker) {
          controlPlane.mutateWorkerOutOfBand(
            envRecord.target.accountId,
            resourceNames.scriptName,
            {
              sha256: sim.workerHash,
              deleteScript: sim.deleteWorker,
            },
          );
        }
        if (sim.appliedMigrations !== undefined) {
          controlPlane.mutateDatabaseOutOfBand(
            envRecord.target.accountId,
            resourceNames.databaseName,
            {
              appliedMigrations: sim.appliedMigrations,
            },
          );
        }
        if (sim.deleteQueue) {
          controlPlane.deleteQueueOutOfBand(
            envRecord.target.accountId,
            sim.deleteQueue,
          );
        }
        if (sim.cronTriggers !== undefined) {
          controlPlane.mutateCronTriggersOutOfBand(
            envRecord.target.accountId,
            resourceNames.scriptName,
            sim.cronTriggers,
          );
        }
      }

      const stub = getBlueprintStub(c.env, project);
      const stateRes = await stub.fetch(
        `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
        { method: "GET" },
      );
      const current = (await stateRes.json()) as ProjectStatePayload;
      const currentHashes = await computeCurrentBlueprintArtifactHashes(
        db,
        project,
        current,
      );

      const enriched = await enrichEnvironmentWithDriftAndHistory(
        db,
        project,
        envRecord,
        currentHashes,
        c.env,
      );

      return c.json(
        {
          ok: true,
          project,
          orgId: authz.orgId,
          envName,
          driftReport: enriched.driftReport,
          environment: enriched,
        },
        200,
      );
    },
  );

  const RollbackEnvironmentBodySchema = z.object({
    targetDeploymentId: z.string().min(1),
    confirmDestructive: z.boolean().optional(),
    confirmedMigrationNames: z.array(z.string()).optional(),
    dryRun: z.boolean().optional(),
    /** Opt-in: also restore the environment's D1 to the bookmark taken before the first migration after the target deployment. */
    restoreData: z.boolean().optional(),
    orgId: z.string().min(1).max(128).optional(),
    approvalId: z.string().min(1).max(128).optional(),
  });

  /** D1 restore points: one row per pre-migration bookmark, written as soon as it is taken (before any migration runs). */
  async function ensureRestorePointTable(db: D1Like): Promise<void> {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS deploy_restore_points (
           project_id TEXT NOT NULL,
           env_name TEXT NOT NULL,
           deploy_id TEXT NOT NULL,
           database_id TEXT NOT NULL,
           bookmark TEXT NOT NULL,
           created_at TEXT NOT NULL
         )`,
      )
      .run();
  }

  async function recordRestorePoint(
    db: D1Like,
    p: { project: string; envName: string; deployId: string; databaseId: string; bookmark: string },
  ): Promise<void> {
    await ensureRestorePointTable(db);
    await db
      .prepare(
        `INSERT INTO deploy_restore_points (project_id, env_name, deploy_id, database_id, bookmark, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(p.project, p.envName, p.deployId, p.databaseId, p.bookmark, new Date().toISOString())
      .run();
  }

  /**
   * The restore point for a data rollback to `target`: the first bookmark this environment took, after the target
   * deployment, before applying a migration (from any deploy, including one that failed after migrating). Null when none.
   */
  async function findRestorePoint(
    db: D1Like,
    project: string,
    envName: string,
    target: { deploy_id: string; created_at: string },
  ): Promise<{ deploymentId: string; createdAt: string; bookmark: string; databaseId: string } | null> {
    await ensureRestorePointTable(db);
    const row = await db
      .prepare(
        `SELECT deploy_id, database_id, bookmark, created_at
         FROM deploy_restore_points
         WHERE project_id = ? AND env_name = ? AND deploy_id != ? AND created_at >= ?
         ORDER BY created_at ASC, rowid ASC
         LIMIT 1`,
      )
      .bind(project, envName, target.deploy_id, target.created_at)
      .first<{ deploy_id: string; database_id: string; bookmark: string; created_at: string }>();
    return row ? { deploymentId: row.deploy_id, createdAt: row.created_at, bookmark: row.bookmark, databaseId: row.database_id } : null;
  }

  app.post(
    "/api/projects/:project/environments/:envName/rollback",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project");
      const envNameParam = c.req.param("envName");
      const parsedEnvName = DeployEnvNameSchema.safeParse(envNameParam);
      if (!parsedEnvName.success) {
        return c.json(
          {
            error: {
              code: "INVALID_ENVIRONMENT_NAME",
              message: `Environment "${envNameParam}" must be "preview" or "production"`,
            },
          },
          400,
        );
      }
      const envName = parsedEnvName.data;

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      const rawBody = await c.req.json().catch(() => null);
      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "mutate",
        (rawBody && typeof rawBody === "object" && typeof (rawBody as { orgId?: unknown }).orgId === "string"
          ? (rawBody as { orgId: string }).orgId
          : undefined) ?? c.req.query("orgId") ?? c.req.header("x-org-id"),
        "deploy",
      );
      if (!authz.ok) {
        await recordStudioAuditLog(db, {
          orgId: authz.orgId,
          projectId: project,
          actorType: resolved.caller.author.type,
          actorId: resolved.caller.author.id,
          action: "environment.rollback",
          status: "forbidden",
          targetRef: `${project}:${envName}`,
          details: { envName, code: authz.error.code, role: authz.role },
          request: c.req.raw,
        });
        return c.json({ error: authz.error }, authz.status);
      }

      const parsedBody = RollbackEnvironmentBodySchema.safeParse(rawBody);
      if (!parsedBody.success) {
        return c.json(
          {
            error: {
              code: "INVALID_ROLLBACK_BODY",
              message: "targetDeploymentId is required",
              issues: parsedBody.error.issues,
            },
          },
          400,
        );
      }
      const bodyData = parsedBody.data;

      const environments = await listProjectDeployEnvironments(db, {
        orgId: authz.orgId,
        projectId: project,
      });
      const envRecord =
        environments.find((e) => e.envName === envName) ?? null;
      if (!envRecord) {
        return c.json(
          {
            error: {
              code: "DEPLOY_TARGET_NOT_CONNECTED",
              message: `No Cloudflare deploy target is connected for project "${project}" (${envName}).`,
            },
          },
          422,
        );
      }

      const tokenMeta = await getDeployTokenMetadata(
        db,
        envRecord.target.tokenRef,
        authz.orgId,
      );
      if (!tokenMeta || tokenMeta.status !== "active") {
        return c.json(
          {
            error: {
              code: "TOKEN_REVOKED",
              message: `Cloudflare deploy token "${envRecord.target.tokenRef}" is ${tokenMeta?.status ?? "missing"} — Reconnect in Studio.`,
            },
          },
          422,
        );
      }

      const targetRow = await db
        .prepare(
          `SELECT deploy_id, project_id, org_id, env_name, revision, build_hash, code_hash, graph_hash,
                  action, status, worker_url, version_id, database_id, actor_id, state_json, created_at
           FROM deployments
           WHERE deploy_id = ? AND project_id = ?
           LIMIT 1`,
        )
        .bind(bodyData.targetDeploymentId, project)
        .first<{
          deploy_id: string;
          project_id: string;
          org_id: string;
          env_name: string;
          revision: number;
          build_hash: string;
          code_hash: string;
          graph_hash: string;
          action: string;
          status: string;
          worker_url: string;
          version_id: string;
          database_id: string;
          actor_id: string;
          state_json: string;
          created_at: string;
        }>();

      if (!targetRow) {
        return c.json(
          {
            error: {
              code: "DEPLOYMENT_NOT_FOUND",
              message: `Historical deployment "${bodyData.targetDeploymentId}" was not found for project "${project}"`,
            },
          },
          404,
        );
      }

      const currentDeployRow = await db
        .prepare(
          `SELECT deploy_id, revision, build_hash, code_hash, graph_hash, state_json, created_at
           FROM deployments
           WHERE project_id = ? AND env_name = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`,
        )
        .bind(project, envName)
        .first<{
          deploy_id: string;
          revision: number;
          build_hash: string;
          code_hash: string;
          graph_hash: string;
          state_json: string;
          created_at: string;
        }>();

      const currentDeployedState: PersistedDeployedState =
        (envRecord.deployedState as PersistedDeployedState | null) ?? {};
      let targetState: PersistedDeployedState = {};
      try {
        targetState = JSON.parse(targetRow.state_json) as PersistedDeployedState;
      } catch {
        targetState = {};
      }

      // Resolve cached build artifact by build_hash without ever running assemble()
      const cachedBuild = await db
        .prepare(
          `SELECT build_hash, code_hash, graph_hash, bundle_code, files_json, assemble_count
           FROM builds
           WHERE build_hash = ? AND project_id = ?
           LIMIT 1`,
        )
        .bind(targetRow.build_hash, project)
        .first<{
          build_hash: string;
          code_hash: string;
          graph_hash: string;
          bundle_code: string;
          files_json: string;
          assemble_count: number;
        }>();

      // Story 16: never deploy a placeholder bundle in place of the target build. If this project holds no cached build
      // for the target hash, the rollback is refused rather than reported as a success.
      if (!cachedBuild) {
        return c.json(
          {
            error: {
              code: "BUILD_NOT_FOUND",
              message: `The build ${targetRow.build_hash} of deployment ${targetRow.deploy_id} is not cached for project "${project}"; rebuild and deploy instead of rolling back.`,
            },
          },
          409,
        );
      }
      const bundleCode = cachedBuild.bundle_code;

      const currentSnapshot: RollbackPlanSnapshot = {
        deployId: currentDeployRow?.deploy_id ?? "current",
        revision: envRecord.deployedRev ?? Number(currentDeployRow?.revision ?? 0),
        buildHash: envRecord.buildHash ?? currentDeployRow?.build_hash ?? "",
        codeHash: envRecord.codeHash ?? currentDeployRow?.code_hash ?? "",
        graphHash: envRecord.graphHash ?? currentDeployRow?.graph_hash ?? "",
        appliedMigrations: currentDeployedState.appliedMigrations ?? [],
        appliedMigrationSql: currentDeployedState.appliedMigrationSql ?? {},
        entities: currentDeployedState.entities ?? [],
        queues: currentDeployedState.queues ?? [],
        cronTriggers: currentDeployedState.cronTriggers ?? [],
        workflows: (currentDeployedState.workflows ?? []).map((w) => ({
          workflowName: w.name,
          className: w.className,
        })),
        graphs: currentDeployedState.graphs ?? {},
      };

      const targetSnapshot: RollbackPlanSnapshot = {
        deployId: targetRow.deploy_id,
        revision: Number(targetRow.revision),
        buildHash: targetRow.build_hash,
        codeHash: targetRow.code_hash,
        graphHash: targetRow.graph_hash,
        appliedMigrations: targetState.appliedMigrations ?? [],
        appliedMigrationSql: targetState.appliedMigrationSql ?? {},
        entities: targetState.entities ?? [],
        queues: targetState.queues ?? [],
        cronTriggers: targetState.cronTriggers ?? [],
        workflows: (targetState.workflows ?? []).map((w) => ({
          workflowName: w.name,
          className: w.className,
        })),
        graphs: targetState.graphs ?? {},
      };

      const rollbackPlan = computeRollbackPlan(
        envRecord.target,
        currentSnapshot,
        targetSnapshot,
      );

      const rollbackFromDeploymentId = currentDeployRow?.deploy_id ?? null;

      // Data restore is opt-in. Without a bookmark taken after the target deployment there is nothing to restore to, and
      // nothing is changed.
      const restoreData = bodyData.restoreData === true;
      const restorePoint = restoreData
        ? await findRestorePoint(db, project, envName, targetRow)
        : null;
      if (restoreData && !restorePoint) {
        await recordStudioAuditLog(db, {
          orgId: authz.orgId,
          projectId: project,
          actorType: resolved.caller.author.type,
          actorId: resolved.caller.author.id,
          action: "environment.rollback",
          status: "validation_failed",
          targetRef: `${project}:${envName}`,
          details: { envName, targetDeploymentId: targetRow.deploy_id, restoreData: true, code: "NO_RESTORE_POINT" },
        });
        return c.json(
          {
            ok: false,
            error: {
              code: "NO_RESTORE_POINT",
              message: `No D1 restore point exists after deployment ${targetRow.deploy_id}: no later deployment of ${envName} applied a migration to an existing database. Nothing was changed; roll back without restoreData to revert the code only.`,
            },
          },
          409,
        );
      }

      if (bodyData.dryRun === true) {
        return c.json(
          {
            ok: true,
            dryRun: true,
            project,
            orgId: authz.orgId,
            envName,
            targetDeploymentId: targetRow.deploy_id,
            rollbackFromDeploymentId,
            currentRevision: currentSnapshot.revision,
            targetRevision: targetSnapshot.revision,
            reusedCachedBuild: true,
            assembleCount: getProjectAssembleCount(project),
            plan: rollbackPlan,
            ...(restorePoint
              ? { restoreData: { fromDeploymentId: restorePoint.deploymentId, takenAt: restorePoint.createdAt } }
              : {}),
          },
          200,
        );
      }

      if (rollbackPlan.d1.destructiveWarnings.length > 0) {
        const requiredMigrationNames = Array.from(
          new Set(
            rollbackPlan.d1.destructiveWarnings.map((w) => w.migrationName),
          ),
        );
        const confirmedList = bodyData.confirmedMigrationNames;
        const confirmedSet = new Set(confirmedList ?? []);
        const namesConfirmed =
          !confirmedList ||
          confirmedList.length === 0 ||
          requiredMigrationNames.every((name) => confirmedSet.has(name));
        const allConfirmed =
          bodyData.confirmDestructive === true && namesConfirmed;

        if (!allConfirmed) {
          await recordStudioAuditLog(db, {
            orgId: authz.orgId,
            projectId: project,
            actorType: resolved.caller.author.type,
            actorId: resolved.caller.author.id,
            action: "environment.rollback",
            status: "validation_failed",
            details: {
              envName,
              targetDeploymentId: targetRow.deploy_id,
              code: "DESTRUCTIVE_MIGRATION_CONFIRMATION_REQUIRED",
              requiredMigrationNames,
            },
          });
          return c.json(
            {
              ok: false,
              error: {
                code: "DESTRUCTIVE_MIGRATION_CONFIRMATION_REQUIRED",
                message:
                  "Rolling back to this deployment requires destructive schema downgrade or rolling past applied D1 migrations. Pass confirmDestructive: true to proceed.",
                destructiveWarnings: rollbackPlan.d1.destructiveWarnings,
                requiredMigrationNames,
              },
              plan: rollbackPlan,
            },
            422,
          );
        }
      }

      // AD-V8: an MCP token's rollback needs a Studio approval bound to this environment, the target deployment and
      // the deployment live now (a newer deploy since approval makes it stale).
      const rollbackGate = await gateDestructiveAction(
        c,
        resolved.caller,
        {
          orgId: authz.orgId,
          projectId: project,
          action: "rollback",
          env: envName,
          target: targetRow.deploy_id,
          blueprintRev: Number(currentSnapshot.revision ?? 0),
          // The deployment live now, the destructive downgrade warnings and the agent's confirmations are what is
          // approved: a newer deploy, other warnings or other confirmations make the approval stale.
          planFingerprint: await sha256Hex(
            JSON.stringify({
              from: rollbackFromDeploymentId ?? "none",
              destructiveWarnings: rollbackPlan.d1.destructiveWarnings,
              confirmDestructive: bodyData.confirmDestructive === true,
              confirmedMigrationNames: [...(bodyData.confirmedMigrationNames ?? [])].sort(),
              // A data restore is another plan: an approval for the code rollback alone does not cover it.
              ...(restorePoint ? { restoreData: true, restorePointDeploymentId: restorePoint.deploymentId } : {}),
            }),
          ),
          summary: {
            ...(restorePoint ? { restoreData: true, restorePointDeploymentId: restorePoint.deploymentId } : {}),
            destructiveWarnings: rollbackPlan.d1.destructiveWarnings,
            confirmDestructive: bodyData.confirmDestructive === true,
            confirmedMigrationNames: bodyData.confirmedMigrationNames ?? [],
            targetDeploymentId: targetRow.deploy_id,
            rollbackFromDeploymentId,
            currentRevision: currentSnapshot.revision,
            targetRevision: targetSnapshot.revision,
            from: currentDeployRow
              ? { deploymentId: currentDeployRow.deploy_id, codeHash: currentDeployRow.code_hash, buildHash: currentDeployRow.build_hash }
              : null,
            to: { deploymentId: targetRow.deploy_id, codeHash: targetRow.code_hash, buildHash: targetRow.build_hash },
          },
        },
        bodyData.approvalId,
      );
      if (rollbackGate) return rollbackGate;

      const deployId = `dep_${generateUuidV7()}`;
      const controlPlane = getStudioControlPlane(envRecord.target.accountId, c.env, appOptions.deploy);
      const fakeControlPlane = asFakeControlPlane(controlPlane);
      const tokenResolver = createStudioTokenResolver(db, c.env);
      const stub = getBlueprintStub(c.env, project);
      const resourceNames = deriveEnvironmentResourceNames(
        project,
        envRecord.target,
      );

      const provisioner = createByocProvisioner({
        apiClient: controlPlane,
        resolveToken: async (tokenRef, context) => {
          const plainToken = await tokenResolver(tokenRef, context);
          fakeControlPlane?.registerToken({
            token: plainToken,
            accountId: envRecord.target.accountId,
            accountName: envRecord.accountName,
          });
          return plainToken;
        },
      });

      // Real path: every failure (bundling, reading, uploading, the secret sync, the smoke check) is a structured answer
      // with the audit row, through failRealDeploy, as for a deploy.
      const rollbackSteps: Array<{ stepName: string; action: string; resourceName: string }> = [];
      let rollbackUpload: Awaited<ReturnType<typeof prepareRealWorkerUpload>> | null = null;
      let applyResult!: Awaited<ReturnType<typeof provisioner.apply>>;
      let rollbackSecretHashes: Record<string, string> | undefined;
      let rollbackStudioVersionIds: string[] | undefined;
      // restoreData: the code is rolled back first; D1 is restored only after that succeeded.
      let dataRestore: { bookmark: string; previousBookmark: string; databaseId: string; fromDeploymentId: string } | null = null;
      const rollbackToken = async (action: string) => {
        const plainToken = await tokenResolver(envRecord.target.tokenRef, { actor: resolved.caller.author.id, deployId, action });
        fakeControlPlane?.registerToken({ token: plainToken, accountId: envRecord.target.accountId, accountName: envRecord.accountName });
        return plainToken;
      };
      try {
      const liveWorker = fakeControlPlane
        ? await fakeControlPlane.getWorkerScript(
            envRecord.target.accountId,
            "",
            resourceNames.scriptName,
          )
        : await controlPlane.getScript(
            envRecord.target.accountId,
            await tokenResolver(envRecord.target.tokenRef, {
              actor: resolved.caller.author.id,
              deployId,
              action: "rollback",
            }),
            resourceNames.scriptName,
          );
      // The real client re-uploads the target build as a real Worker (bundled again from its stored files), under the hash
      // of that bundle; the account's annotated hash is what it is compared with.
      rollbackUpload = fakeControlPlane
        ? null
        : await prepareRealWorkerUpload({
            env: c.env,
            project,
            envName,
            buildHash: targetRow.build_hash,
            target: envRecord.target,
            // Exactly the vault refs the last deploy resolved each brick secret from (recorded as secretRefs), never a guess by
            // name; a ref no longer in the vault leaves that secret on the Worker untouched (a rollback never deletes a secret).
            configuredSecretValues: await stillValidVaultRefs(db, project, currentDeployedState.secretRefs ?? {}),
          });
      const targetCodeHash = rollbackUpload?.bundleSha ?? targetRow.code_hash;
      const effectiveCurrentCodeHash =
        liveWorker?.sha256 || (fakeControlPlane ? envRecord.codeHash : null) || null;

      const appliedRollback = await provisioner.apply({
        target: envRecord.target,
        project,
        actor: resolved.caller.author.id,
        deployId,
        buildHash: targetRow.build_hash,
        codeHash: targetCodeHash,
        graphHash: targetRow.graph_hash,
        bundle: {
          code: rollbackUpload?.bundleCode ?? bundleCode,
          sha256: targetCodeHash,
        },
        migrations: [],
        queues: targetState.queues ?? [],
        cronTriggers: targetState.cronTriggers ?? [],
        workflows: rollbackUpload?.workflows ?? targetState.workflows ?? [],
        graphs: targetState.graphs ?? {},
        schedules: targetState.cronTriggers ?? [],
        // Real path: secrets are synced after the upload by completeRealDeploy, as for a deploy.
        secrets: {},
        ...(rollbackUpload ? { workerBindings: rollbackUpload.workerBindings, trustedVersionIds: currentDeployedState.studioVersionIds ?? [] } : {}),
        ...(rollbackUpload && rollbackUpload.compatibilityFlags.length > 0 ? { compatibilityFlags: rollbackUpload.compatibilityFlags } : {}),
        // Real path: what is deployed is read from the account, as for a deploy.
        envState: rollbackUpload ? { deployedRev: envRecord.deployedRev } : {
          deployedRev: envRecord.deployedRev,
          currentBuildHash:
            effectiveCurrentCodeHash === targetCodeHash &&
            envRecord.graphHash === targetRow.graph_hash
              ? "force_restore_rollback"
              : envRecord.buildHash,
          currentCodeHash: effectiveCurrentCodeHash,
          currentGraphHash:
            effectiveCurrentCodeHash === targetCodeHash
              ? "force_graph_restore"
              : envRecord.graphHash,
          databaseExists: true,
          appliedMigrations: targetState.appliedMigrations ?? [],
          existingQueues: currentDeployedState.queues ?? [],
          currentCrons: currentDeployedState.cronTriggers ?? [],
          existingWorkflows: (currentDeployedState.workflows ?? []).map((w) => ({
            workflowName: w.name,
            className: w.className,
          })),
        },
        onStep: async (step) => {
          rollbackSteps.push({ stepName: step.stepName, action: step.action, resourceName: step.resourceName });
          const stepId = `dstep_${generateUuidV7()}`;
          await db
            .prepare(
              `INSERT INTO deployment_steps (
                 step_id, deploy_id, project_id, env_name, step_order, step_name,
                 resource_kind, resource_name, action, status, summary, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              stepId,
              deployId,
              project,
              envName,
              step.stepOrder,
              step.stepName,
              step.resourceKind,
              step.resourceName,
              step.action,
              step.status,
              step.summary,
              step.timestamp,
            )
            .run();
        },
      });
      if (rollbackUpload) {
        // the same secret sync and keyed smoke check as a deploy, and the bookkeeping carried forward
        const completed = await completeRealDeploy({
          env: c.env,
          project,
          target: envRecord.target,
          deployId,
          actorId: resolved.caller.author.id,
          controlPlane,
          tokenResolver,
          upload: rollbackUpload,
          applied: appliedRollback,
          previous: currentDeployedState,
          mode: "rollback",
        });
        applyResult = completed.result;
        rollbackSecretHashes = completed.secretHashes;
        rollbackStudioVersionIds = completed.studioVersionIds;
      } else {
        applyResult = appliedRollback;
      }
      } catch (error) {
        if (fakeControlPlane) throw error;
        return failRealDeploy(error, {
          db,
          orgId: authz.orgId,
          project,
          envName,
          deployId,
          caller: resolved.caller,
          controlPlane,
          steps: rollbackSteps,
          hideValues: [c.env.PX_TELEMETRY_SECRET ?? "", ...Object.values(rollbackUpload?.secrets ?? {})],
          action: "environment.rollback",
        });
      }

      // The code is rolled back; now the data. A failed restore leaves D1 as it was and is reported as such below.
      let restoreFailure: string | null = null;
      if (restorePoint) {
        try {
          const restored = await controlPlane.restoreD1(
            envRecord.target.accountId,
            await rollbackToken("restore_d1"),
            restorePoint.databaseId,
            restorePoint.bookmark,
          );
          dataRestore = { bookmark: restorePoint.bookmark, previousBookmark: restored.previous_bookmark, databaseId: restorePoint.databaseId, fromDeploymentId: restorePoint.deploymentId };
        } catch (error) {
          restoreFailure = createRedactor([c.env.PX_TELEMETRY_SECRET ?? ""].filter((v) => v.length > 0))(error instanceof Error ? error.message : String(error));
        }
      }

      // Ensure the fake's metadata matches the restored target revision state (the real account was written by apply)
      fakeControlPlane?.recordEnvironmentMetadata(
        envRecord.target.accountId,
        resourceNames.scriptName,
        resourceNames.databaseName,
        {
          buildHash: targetRow.build_hash,
          codeHash: targetRow.code_hash,
          graphHash: targetRow.graph_hash,
          graphs: targetState.graphs ?? {},
          schedules: targetState.cronTriggers ?? [],
          appliedMigrations: targetState.appliedMigrations ?? [],
        },
      );
      fakeControlPlane?.mutateCronTriggersOutOfBand(
        envRecord.target.accountId,
        resourceNames.scriptName,
        targetState.cronTriggers ?? [],
      );

      const nowIso = new Date().toISOString();
      const targetRevision = Number(targetRow.revision);
      const statusMessage = `Rolled back to r${targetRevision}`;

      const nextDeployedState: PersistedDeployedState = {
        appliedMigrations: targetState.appliedMigrations ?? [],
        appliedMigrationSql: targetState.appliedMigrationSql ?? {},
        queues: targetState.queues ?? [],
        cronTriggers: targetState.cronTriggers ?? [],
        workflows: targetState.workflows ?? [],
        graphs: targetState.graphs ?? {},
        entities: targetState.entities ?? [],
        pendingCustomMigrations: [],
        workerUrl: applyResult.url,
        versionId: applyResult.versionId,
        databaseId: applyResult.databaseId,
        deployedAt: nowIso,
        deployedBy: resolved.caller.author.id,
        rollbackFromDeploymentId,
        lastAction: "rollback",
        liveWithoutRedeploy: applyResult.liveWithoutRedeploy,
        // the real path's bookkeeping is carried through a rollback: the secrets it bound, and the bundle it uploaded
        ...(rollbackSecretHashes ? { secretHashes: rollbackSecretHashes } : {}),
        ...(rollbackStudioVersionIds ? { studioVersionIds: rollbackStudioVersionIds } : {}),
        // the bindings did not change: the refs the Worker's brick secrets come from are carried forward
        ...(currentDeployedState.secretRefs ? { secretRefs: currentDeployedState.secretRefs } : {}),
        ...(rollbackUpload ? { liveCodeHash: rollbackUpload.bundleSha } : {}),
        noChanges: false,
        reusedCachedBuild: true,
      };

      await db
        .prepare(
          `UPDATE project_environments
           SET deployed_rev = ?,
               build_hash = ?,
               code_hash = ?,
               graph_hash = ?,
               deployed_state_json = ?,
               status = 'deployed',
               updated_at = ?
           WHERE project_id = ? AND env_name = ?`,
        )
        .bind(
          targetRevision,
          targetRow.build_hash,
          targetRow.code_hash,
          targetRow.graph_hash,
          JSON.stringify(nextDeployedState),
          nowIso,
          project,
          envName,
        )
        .run();

      await db
        .prepare(
          `INSERT INTO project_deployments (
             deploy_id, project_id, org_id, env_name, revision, build_hash, code_hash, graph_hash,
             action, worker_url, version_id, database_id, actor_id, state_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rollback', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          deployId,
          project,
          authz.orgId,
          envName,
          targetRevision,
          targetRow.build_hash,
          targetRow.code_hash,
          targetRow.graph_hash,
          applyResult.url,
          applyResult.versionId,
          applyResult.databaseId,
          resolved.caller.author.id,
          JSON.stringify(nextDeployedState),
          nowIso,
        )
        .run();

      await db
        .prepare(
          `INSERT INTO deployments (
             deploy_id, project_id, org_id, env_name, revision, build_hash, code_hash, graph_hash,
             action, status, reused_cached_build, live_without_redeploy, no_changes, rollback_from_deploy_id,
             worker_url, version_id, database_id, actor_id, state_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rollback', 'succeeded', 1, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          deployId,
          project,
          authz.orgId,
          envName,
          targetRevision,
          targetRow.build_hash,
          targetRow.code_hash,
          targetRow.graph_hash,
          applyResult.liveWithoutRedeploy ? 1 : 0,
          rollbackFromDeploymentId,
          applyResult.url,
          applyResult.versionId,
          applyResult.databaseId,
          resolved.caller.author.id,
          JSON.stringify(nextDeployedState),
          nowIso,
        )
        .run();

      await stub
        .fetch(
          `http://blueprint-do/deploy-broadcast?project=${encodeURIComponent(project)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              event: "completed",
              deployId,
              rollbackFromDeploymentId,
              targetDeploymentId: targetRow.deploy_id,
              envName,
              revision: targetRevision,
              buildHash: targetRow.build_hash,
              codeHash: targetRow.code_hash,
              graphHash: targetRow.graph_hash,
              action: "rollback",
              status: "succeeded",
              statusMessage,
              reusedCachedBuild: true,
              liveWithoutRedeploy: applyResult.liveWithoutRedeploy,
              steps: applyResult.steps,
            }),
          },
        )
        .catch(() => {});

      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "environment.rollback",
        status: "succeeded",
        details: {
          deployId,
          rollbackFromDeploymentId,
          targetDeploymentId: targetRow.deploy_id,
          envName,
          revision: targetRevision,
          buildHash: targetRow.build_hash,
          reusedCachedBuild: true,
          ...(dataRestore
            ? {
                restoreData: true,
                restorePointDeploymentId: dataRestore.fromDeploymentId,
                bookmark: dataRestore.bookmark,
                previous_bookmark: dataRestore.previousBookmark,
              }
            : {}),
          ...(restoreFailure && restorePoint
            ? { restoreData: true, dataRestored: false, restorePointDeploymentId: restorePoint.deploymentId }
            : {}),
        },
      });

      if (restoreFailure && restorePoint) {
        await recordStudioAuditLog(db, {
          orgId: authz.orgId,
          projectId: project,
          actorType: resolved.caller.author.type,
          actorId: resolved.caller.author.id,
          action: "environment.rollback.restore_data",
          status: "failed",
          targetRef: `${project}:${envName}`,
          details: {
            deployId,
            targetDeploymentId: targetRow.deploy_id,
            restorePointDeploymentId: restorePoint.deploymentId,
            bookmark: restorePoint.bookmark,
            codeRolledBack: true,
            dataRestored: false,
            message: restoreFailure,
          },
        });
        return c.json(
          {
            ok: false,
            error: {
              code: "DATA_RESTORE_FAILED",
              message: `The code was rolled back to r${targetRevision} (deployment ${deployId}), but the data was not restored: ${restoreFailure}. D1 is as it was before the rollback; retry with restoreData to restore it.`,
              codeRolledBack: true,
              dataRestored: false,
              deployId,
              restorePointDeploymentId: restorePoint.deploymentId,
            },
          },
          502,
        );
      }

      const updatedEnvs = await listProjectDeployEnvironments(db, {
        orgId: authz.orgId,
        projectId: project,
      });
      const updatedEnvRecord =
        updatedEnvs.find((e) => e.envName === envName) ?? envRecord;

      const stateRes = await stub.fetch(
        `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
        { method: "GET" },
      );
      const current = (await stateRes.json()) as ProjectStatePayload;
      const currentHashes = await computeCurrentBlueprintArtifactHashes(
        db,
        project,
        current,
      );
      const enrichedEnv = await enrichEnvironmentWithDriftAndHistory(
        db,
        project,
        updatedEnvRecord,
        currentHashes,
        c.env,
      );

      return c.json(
        {
          ok: true,
          deployId,
          rollbackFromDeploymentId,
          targetDeploymentId: targetRow.deploy_id,
          project,
          orgId: authz.orgId,
          envName,
          revision: targetRevision,
          buildHash: targetRow.build_hash,
          codeHash: targetRow.code_hash,
          graphHash: targetRow.graph_hash,
          action: "rollback",
          statusMessage,
          reusedCachedBuild: true,
          assembleCount: getProjectAssembleCount(project),
          liveWithoutRedeploy: applyResult.liveWithoutRedeploy,
          steps: applyResult.steps,
          plan: rollbackPlan,
          // restoreData: D1 is back at the bookmark; previous_bookmark restores the data as it was just before (the undo token).
          ...(dataRestore
            ? {
                restoreData: {
                  restored: true,
                  fromDeploymentId: dataRestore.fromDeploymentId,
                  bookmark: dataRestore.bookmark,
                },
                previous_bookmark: dataRestore.previousBookmark,
              }
            : {}),
          deployment:
            enrichedEnv.deployments.find((d) => d.deployId === deployId) ?? {
              deployId,
              rollbackFromDeploymentId,
              revision: targetRevision,
              buildHash: targetRow.build_hash,
              codeHash: targetRow.code_hash,
              graphHash: targetRow.graph_hash,
              action: "rollback",
              status: "succeeded",
              reusedCachedBuild: true,
            },
          environment: enrichedEnv,
        },
        200,
      );
    },
  );

  // ============================================================================
  // CP6 Story 6.1 — Workspace-Scoped Data Browser & Preview Audited Writes
  // ============================================================================

  // Story 17: a generated app's entity and brick tables never live in STUDIO_DB. Describing the project's data
  // (declared entities, secret columns, entity table names, schema DDL) reads only the blueprint; applying the schema
  // runs only against the project's own data store (the active sandbox D1 for preview).
  interface ProjectEnvironmentDataDescription {
    declaredEntities: string[];
    secretColumns: string[];
    entityTables: Set<string>;
    schemaSql: string[];
  }

  async function describeProjectEnvironmentData(
    env: StudioApiEnv,
    project: string,
  ): Promise<ProjectEnvironmentDataDescription> {
    const declaredEntities: string[] = [];
    const entityTables = new Set<string>();
    const schemaSql: string[] = [];
    const secretColumns = new Set<string>([
      "password",
      "password_hash",
      "hashed_password",
      "secret",
      "secret_token",
      "access_token",
      "refresh_token",
      "api_key",
      "signing_secret",
      "webhook_secret",
      "ciphertext",
      "wrapped_dek",
    ]);

    try {
      const stub = getBlueprintStub(env, project);
      const stateRes = await stub.fetch(
        `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
        { method: "GET" },
      );
      if (stateRes.ok) {
        const current = (await stateRes.json()) as ProjectStatePayload;
        const bpEntities = current.state?.entities ?? [];
        for (const ent of bpEntities) {
          if (ent?.name) {
            declaredEntities.push(ent.name);
          }
        }

        const reserved = new Set(
          Object.values(catalog.bricks).flatMap((b) => b.manifest.routePrefixes),
        );
        // The blueprint's declarations go through toSdkEntity first, so blueprint-only types (string, integer, json,
        // datetime) and relations are read the way the assembler reads them. One that does not parse is left out on
        // its own instead of taking every other entity's table with it.
        const sdkEntities: SdkEntity[] = [];
        for (const ent of bpEntities) {
          const declared = EntityDefinitionSchema.safeParse(ent);
          if (!declared.success) continue;
          try {
            sdkEntities.push(toSdkEntity(declared.data));
          } catch {
            // Not representable as an SDK entity; its table is not shown.
          }
        }
        // Only the DDL is needed here, so a relation whose target is missing or was skipped above hides nothing.
        const parsedEnts = parseEntities(sdkEntities, reserved, "free", { skipRelationTargets: true });
        if (parsedEnts.ok) {
          for (const ent of parsedEnts.entities) {
            entityTables.add(entityTableName(ent));
            schemaSql.push(
              entityDdl(ent).replace(
                /CREATE TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi,
                "CREATE TABLE IF NOT EXISTS ",
              ),
            );
          }
        }

        for (const brickCfg of current.state?.bricks ?? []) {
          const brickEntry = catalog.bricks[brickCfg.id];
          if (!brickEntry) continue;
          const manifestConfig = (
            brickEntry.manifest as {
              config?: Record<string, { secret?: boolean }>;
            }
          ).config;
          for (const [cfgKey, cfgDef] of Object.entries(manifestConfig ?? {})) {
            if (cfgDef && typeof cfgDef === "object" && cfgDef.secret) {
              secretColumns.add(cfgKey);
            }
          }
          for (const node of brickEntry.manifest.nodes ?? []) {
            const maybeSecretFields = (
              node as { secretFields?: string[] }
            ).secretFields;
            for (const secField of maybeSecretFields ?? []) {
              secretColumns.add(secField);
            }
          }
          for (const migPath of brickEntry.manifest.migrations ?? []) {
            const sqlText = brickEntry.files[migPath];
            if (sqlText) {
              schemaSql.push(
                sqlText
                  .replace(/CREATE TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi, "CREATE TABLE IF NOT EXISTS ")
                  .replace(/CREATE INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi, "CREATE INDEX IF NOT EXISTS ")
                  .replace(
                    /CREATE UNIQUE INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi,
                    "CREATE UNIQUE INDEX IF NOT EXISTS ",
                  ),
              );
            }
          }
        }
      }
    } catch {
      // Ignore blueprint state lookup errors when project has no DO state yet
    }

    return {
      declaredEntities,
      secretColumns: [...secretColumns],
      entityTables,
      schemaSql,
    };
  }

  /** Runs the project's schema against the project's own data store. Never called with STUDIO_DB. */
  async function applyProjectEnvironmentDataSchema(
    targetDataDb: D1Like,
    description: ProjectEnvironmentDataDescription,
  ): Promise<void> {
    for (const sqlText of description.schemaSql) {
      await applyMigration(targetDataDb, sqlText).catch(() => {});
    }
  }

  /**
   * The project's own data store for an environment: the active sandbox D1 for preview. Production, or a preview with
   * no active sandbox, has no data store Studio can reach, so callers answer 503 NOT_CONFIGURED.
   */
  async function resolveProjectDataStore(
    db: D1Like,
    project: string,
    orgId: string,
    envName: DeployEnvName,
  ): Promise<{ sandboxId: string; d1: D1Like; rawD1: D1Like } | null> {
    if (envName !== "preview") return null;
    const activeSbx = await db
      .prepare(
        "SELECT sandbox_id FROM studio_sandboxes WHERE project_id = ? AND org_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      )
      .bind(project, orgId)
      .first<{ sandbox_id: string }>()
      .catch(() => null);
    if (!activeSbx) return null;
    const sbxRec = studioSandboxPlatform.getSandbox(activeSbx.sandbox_id);
    if (!sbxRec?.d1) return null;
    return {
      sandboxId: activeSbx.sandbox_id,
      d1: sbxRec.d1.d1Binding,
      rawD1: sbxRec.d1.rawD1,
    };
  }

  /**
   * The database a workflow run's brick executors write to: the bound app DB when the host provides one, otherwise the
   * project's own data store (with its schema applied). Never STUDIO_DB; null means answer 503 NOT_CONFIGURED.
   */
  async function resolveRunDataDb(
    env: StudioApiEnv,
    db: D1Like,
    project: string,
    orgId: string,
    envName: DeployEnvName,
  ): Promise<D1Like | null> {
    if (env.DB) return env.DB as D1Like;
    const store = await resolveProjectDataStore(db, project, orgId, envName);
    if (!store) return null;
    await applyProjectEnvironmentDataSchema(store.rawD1, await describeProjectEnvironmentData(env, project));
    return store.d1;
  }

  function projectDataStoreNotConfigured(project: string, envName: DeployEnvName): Response {
    return Response.json(
      {
        error: {
          code: "NOT_CONFIGURED",
          message:
            envName === "preview"
              ? `Project "${project}" has no active sandbox data store for preview; deploy a sandbox preview first.`
              : `Project "${project}" has no data store Studio can reach for ${envName}.`,
        },
      },
      { status: 503 },
    );
  }

  async function forwardToWorkerDataBrowser(params: {
    env: StudioApiEnv;
    db: D1Like;
    project: string;
    orgId: string;
    envName: DeployEnvName;
    actor: string;
    method: string;
    workerPathAndQuery: string;
    rawBody?: string;
  }): Promise<Response> {
    // Story 1.4: the data routes take only the control-plane signature made with PX_TELEMETRY_SECRET; without it
    // Studio cannot sign, and answers 503 rather than signing with another secret.
    const signingSecret = await studioProjectSecret(params.env, params.project, "control-plane");
    if (!signingSecret) {
      return signingSecretNotConfigured();
    }
    // Story 17: the data browser reads the project's own data store and never falls back to STUDIO_DB.
    const dataStore = await resolveProjectDataStore(
      params.db,
      params.project,
      params.orgId,
      params.envName,
    );
    if (!dataStore) {
      return projectDataStoreNotConfigured(params.project, params.envName);
    }
    const description = await describeProjectEnvironmentData(params.env, params.project);
    await applyProjectEnvironmentDataSchema(dataStore.rawD1, description);
    const targetDataDb: D1Like = dataStore.d1;
    const { declaredEntities, secretColumns } = description;

    const workerReq = await signedDataBrowserRequest({
      method: params.method,
      workerPathAndQuery: params.workerPathAndQuery,
      ...(params.rawBody !== undefined ? { rawBody: params.rawBody } : {}),
      signingSecret,
    });

    const workerRes = await handleDataBrowserRequest(workerReq, {
      db: targetDataDb,
      pxEnv: params.envName,
      telemetrySecret: signingSecret,
      declaredEntities,
      secretColumns,
    });

    if (!workerRes) {
      return Response.json(
        {
          error: {
            code: "DATA_BROWSER_ROUTE_NOT_FOUND",
            message: `No Data Browser handler matched ${params.workerPathAndQuery}`,
          },
        },
        { status: 404 },
      );
    }

    const isMutation =
      params.method === "POST" ||
      params.method === "PATCH" ||
      params.method === "DELETE";

    if (isMutation && (workerRes.status === 200 || workerRes.status === 201)) {
      const payload = (await workerRes.json()) as {
        ok: boolean;
        operation: "insert" | "update" | "delete";
        workspaceId: string;
        tableName: string;
        rowId: string;
        beforeSnapshot: Record<string, unknown> | null;
        afterSnapshot: Record<string, unknown> | null;
        [key: string]: unknown;
      };

      const auditId = `dba_${generateUuidV7()}`;
      const createdAt = new Date().toISOString();

      await params.db
        .prepare(
          `INSERT INTO data_browser_audit_log (
             audit_id, org_id, project_id, env_name, workspace_id,
             table_name, row_id, operation, actor,
             before_snapshot, after_snapshot, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        )
        .bind(
          auditId,
          params.orgId,
          params.project,
          params.envName,
          payload.workspaceId,
          payload.tableName,
          payload.rowId,
          payload.operation,
          params.actor,
          payload.beforeSnapshot ? JSON.stringify(payload.beforeSnapshot) : null,
          payload.afterSnapshot ? JSON.stringify(payload.afterSnapshot) : null,
          createdAt,
        )
        .run();

      await recordStudioAuditLog(params.db, {
        orgId: params.orgId,
        projectId: params.project,
        actorType: params.actor.startsWith("agent:") || params.actor.startsWith("mcp_") ? "agent" : "human",
        actorId: params.actor,
        action: `data_browser.${payload.operation}`,
        status: "succeeded",
        targetRef: `${payload.tableName}:${payload.rowId}`,
        details: {
          auditId,
          envName: params.envName,
          workspaceId: payload.workspaceId,
          tableName: payload.tableName,
          rowId: payload.rowId,
          operation: payload.operation,
        },
      });

      return Response.json(
        {
          ...payload,
          auditId,
          auditedAt: createdAt,
        },
        { status: workerRes.status },
      );
    }

    return workerRes;
  }

  app.get(
    "/api/projects/:project/environments/:envName/data/workspaces",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project");
      const parsedEnvName = DeployEnvNameSchema.safeParse(c.req.param("envName"));
      if (!parsedEnvName.success) {
        return c.json(
          {
            error: {
              code: "INVALID_ENVIRONMENT_NAME",
              message: "Environment must be 'preview' or 'production'.",
            },
          },
          400,
        );
      }
      const envName = parsedEnvName.data;

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "read",
        c.req.query("orgId") ?? c.req.header("x-org-id"),
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      return forwardToWorkerDataBrowser({
        env: c.env,
        db,
        project,
        orgId: authz.orgId,
        envName,
        actor: resolved.caller.author.id,
        method: "GET",
        workerPathAndQuery: "/__px/data/workspaces",
      });
    },
  );

  app.get(
    "/api/projects/:project/environments/:envName/data/tables",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project");
      const parsedEnvName = DeployEnvNameSchema.safeParse(c.req.param("envName"));
      if (!parsedEnvName.success) {
        return c.json(
          {
            error: {
              code: "INVALID_ENVIRONMENT_NAME",
              message: "Environment must be 'preview' or 'production'.",
            },
          },
          400,
        );
      }
      const envName = parsedEnvName.data;

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "read",
        c.req.query("orgId") ?? c.req.header("x-org-id"),
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      const reqUrl = new URL(c.req.url);
      return forwardToWorkerDataBrowser({
        env: c.env,
        db,
        project,
        orgId: authz.orgId,
        envName,
        actor: resolved.caller.author.id,
        method: "GET",
        workerPathAndQuery: `/__px/data/tables${reqUrl.search}`,
      });
    },
  );

  app.get(
    "/api/projects/:project/environments/:envName/data/tables/:tableName/rows",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project");
      const parsedEnvName = DeployEnvNameSchema.safeParse(c.req.param("envName"));
      if (!parsedEnvName.success) {
        return c.json(
          {
            error: {
              code: "INVALID_ENVIRONMENT_NAME",
              message: "Environment must be 'preview' or 'production'.",
            },
          },
          400,
        );
      }
      const envName = parsedEnvName.data;
      const tableName = c.req.param("tableName");

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "read",
        c.req.query("orgId") ?? c.req.header("x-org-id"),
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      const reqUrl = new URL(c.req.url);
      return forwardToWorkerDataBrowser({
        env: c.env,
        db,
        project,
        orgId: authz.orgId,
        envName,
        actor: resolved.caller.author.id,
        method: "GET",
        workerPathAndQuery: `/__px/data/tables/${encodeURIComponent(tableName)}/rows${reqUrl.search}`,
      });
    },
  );

  const handleStudioDataBrowserWrite = async (c: {
    env: StudioApiEnv;
    req: {
      raw: Request;
      url: string;
      method: string;
      param: (name: string) => string;
      query: (name: string) => string | undefined;
      header: (name: string) => string | undefined;
      text: () => Promise<string>;
    };
    json: (body: unknown, status?: number) => Response;
  }) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project");
    const parsedEnvName = DeployEnvNameSchema.safeParse(c.req.param("envName"));
    if (!parsedEnvName.success) {
      return c.json(
        {
          error: {
            code: "INVALID_ENVIRONMENT_NAME",
            message: "Environment must be 'preview' or 'production'.",
          },
        },
        400,
      );
    }
    const envName = parsedEnvName.data;
    const tableName = c.req.param("tableName");
    const rowIdParam = c.req.param("rowId");

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = await c.req.text();
    let parsedOrgId: string | undefined;
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (typeof parsed?.orgId === "string") {
        parsedOrgId = parsed.orgId;
      }
    } catch {
      // Ignore JSON parse errors here; Worker handler validates JSON body
    }

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      parsedOrgId ?? c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    // Wallet & usage ledger tables are immutable in BOTH preview and production
    if (isImmutableLedgerTable(tableName)) {
      return c.json(
        {
          error: {
            code: "LEDGER_IMMUTABLE_READ_ONLY",
            message:
              "Wallet and usage ledger tables are immutable and cannot be modified from the Data Browser in any environment.",
          },
        },
        403,
      );
    }

    // Enforce production read-only guardrail at studio-api layer as well as Worker shell
    if (envName === "production") {
      return c.json(
        {
          error: {
            code: "PRODUCTION_DATA_WRITE_FORBIDDEN",
            message:
              "Data Browser writes are strictly forbidden in the production environment.",
          },
        },
        403,
      );
    }

    const reqUrl = new URL(c.req.url);
    const rowPathSuffix = rowIdParam ? `/${encodeURIComponent(rowIdParam)}` : "";
    return forwardToWorkerDataBrowser({
      env: c.env,
      db,
      project,
      orgId: authz.orgId,
      envName,
      actor: resolved.caller.author.id,
      method: c.req.method,
      workerPathAndQuery: `/__px/data/tables/${encodeURIComponent(tableName)}/rows${rowPathSuffix}${reqUrl.search}`,
      rawBody,
    });
  };

  app.post(
    "/api/projects/:project/environments/:envName/data/tables/:tableName/rows",
    handleStudioDataBrowserWrite,
  );
  app.patch(
    "/api/projects/:project/environments/:envName/data/tables/:tableName/rows",
    handleStudioDataBrowserWrite,
  );
  app.patch(
    "/api/projects/:project/environments/:envName/data/tables/:tableName/rows/:rowId",
    handleStudioDataBrowserWrite,
  );
  app.put(
    "/api/projects/:project/environments/:envName/data/tables/:tableName/rows",
    handleStudioDataBrowserWrite,
  );
  app.put(
    "/api/projects/:project/environments/:envName/data/tables/:tableName/rows/:rowId",
    handleStudioDataBrowserWrite,
  );
  app.delete(
    "/api/projects/:project/environments/:envName/data/tables/:tableName/rows",
    handleStudioDataBrowserWrite,
  );
  app.delete(
    "/api/projects/:project/environments/:envName/data/tables/:tableName/rows/:rowId",
    handleStudioDataBrowserWrite,
  );

  const handleStudioLedgerRead = async (
    c: import("hono").Context<{ Bindings: StudioApiEnv }>,
  ) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project") ?? "";
    const parsedEnvName = DeployEnvNameSchema.safeParse(c.req.param("envName"));
    if (!parsedEnvName.success) {
      return c.json(
        {
          error: {
            code: "INVALID_ENVIRONMENT_NAME",
            message: "Environment must be 'preview' or 'production'.",
          },
        },
        400,
      );
    }
    const envName = parsedEnvName.data;

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const reqUrl = new URL(c.req.url);
    return forwardToWorkerDataBrowser({
      env: c.env,
      db,
      project,
      orgId: authz.orgId,
      envName,
      actor: resolved.caller.author.id,
      method: "GET",
      workerPathAndQuery: `/__px/data/ledger${reqUrl.search}`,
    });
  };

  const handleStudioLedgerWriteRefusal = async (
    c: import("hono").Context<{ Bindings: StudioApiEnv }>,
  ) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }
    return c.json(
      {
        error: {
          code: "LEDGER_IMMUTABLE_READ_ONLY",
          message:
            "Wallet and usage ledger tables are immutable and cannot be modified from the Data Browser in any environment.",
        },
      },
      403,
    );
  };

  for (const ledgerRoutePath of [
    "/api/projects/:project/environments/:envName/ledger",
    "/api/projects/:project/environments/:envName/data/ledger",
  ] as const) {
    app.get(ledgerRoutePath, handleStudioLedgerRead);
    app.post(ledgerRoutePath, handleStudioLedgerWriteRefusal);
    app.patch(ledgerRoutePath, handleStudioLedgerWriteRefusal);
    app.put(ledgerRoutePath, handleStudioLedgerWriteRefusal);
    app.delete(ledgerRoutePath, handleStudioLedgerWriteRefusal);
  }

  app.get(
    "/api/projects/:project/environments/:envName/data/audit-log",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project");
      const parsedEnvName = DeployEnvNameSchema.safeParse(c.req.param("envName"));
      if (!parsedEnvName.success) {
        return c.json(
          {
            error: {
              code: "INVALID_ENVIRONMENT_NAME",
              message: "Environment must be 'preview' or 'production'.",
            },
          },
          400,
        );
      }
      const envName = parsedEnvName.data;

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "read",
        c.req.query("orgId") ?? c.req.header("x-org-id"),
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      const workspaceId = c.req.query("workspaceId")?.trim();
      const tableName = c.req.query("tableName")?.trim();
      const limitRaw = Number(c.req.query("limit") ?? "100");
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(200, Math.trunc(limitRaw)))
        : 100;

      const whereClauses = ["project_id = ?1", "env_name = ?2"];
      const bindVals: unknown[] = [project, envName];

      if (workspaceId) {
        bindVals.push(workspaceId);
        whereClauses.push(`workspace_id = ?${bindVals.length}`);
      }
      if (tableName) {
        bindVals.push(tableName);
        whereClauses.push(`table_name = ?${bindVals.length}`);
      }
      bindVals.push(limit);

      const rowsRes = await db
        .prepare(
          `SELECT audit_id, org_id, project_id, env_name, workspace_id, table_name, row_id,
                  operation, actor, before_snapshot, after_snapshot, created_at
           FROM data_browser_audit_log
           WHERE ${whereClauses.join(" AND ")}
           ORDER BY created_at DESC, audit_id DESC
           LIMIT ?${bindVals.length}`,
        )
        .bind(...bindVals)
        .all<{
          audit_id: string;
          org_id: string;
          project_id: string;
          env_name: string;
          workspace_id: string;
          table_name: string;
          row_id: string;
          operation: "insert" | "update" | "delete";
          actor: string;
          before_snapshot: string | null;
          after_snapshot: string | null;
          created_at: string;
        }>();

      const entries = (rowsRes.results ?? []).map((r) => ({
        auditId: r.audit_id,
        orgId: r.org_id,
        projectId: r.project_id,
        envName: r.env_name,
        workspaceId: r.workspace_id,
        tableName: r.table_name,
        rowId: r.row_id,
        operation: r.operation,
        actor: r.actor,
        beforeSnapshot: r.before_snapshot
          ? (JSON.parse(r.before_snapshot) as Record<string, unknown>)
          : null,
        afterSnapshot: r.after_snapshot
          ? (JSON.parse(r.after_snapshot) as Record<string, unknown>)
          : null,
        createdAt: r.created_at,
      }));

      return c.json(
        {
          ok: true,
          project,
          orgId: authz.orgId,
          envName,
          entries,
        },
        200,
      );
    },
  );

  app.post(
    "/api/projects/:project/environments/:envName/data/seed",
    async (c) => {
      const resolved = await resolveStudioCaller(c.env, c.req.raw);
      if (!resolved.ok) {
        return c.json({ error: resolved.error }, 401);
      }

      const project = c.req.param("project");
      const parsedEnvName = DeployEnvNameSchema.safeParse(c.req.param("envName"));
      if (!parsedEnvName.success) {
        return c.json(
          {
            error: {
              code: "INVALID_ENVIRONMENT_NAME",
              message: "Environment must be 'preview' or 'production'.",
            },
          },
          400,
        );
      }

      const db = c.env.STUDIO_DB;
      await ensureStudioD1Schema(db);

      const body = (await c.req.json().catch(() => ({}))) as {
        orgId?: string;
        ddl?: string[];
        tables?: Record<string, Array<Record<string, unknown>>>;
        rows?: Array<{ table: string; values: Record<string, unknown> }>;
      };

      const authz = await authorizeProjectAccess(
        db,
        resolved.caller,
        project,
        "mutate",
        body.orgId ?? c.req.query("orgId") ?? c.req.header("x-org-id"),
      );
      if (!authz.ok) {
        return c.json({ error: authz.error }, authz.status);
      }

      // Story 16 guards stay: raw DDL is refused and rows may only go into this project's own blueprint entity tables.
      // Story 17: the rows are written to the project's own data store (the active sandbox D1 for preview), never
      // to STUDIO_DB; with no data store the seed answers 503 NOT_CONFIGURED and writes nothing.
      if (Array.isArray(body.ddl) && body.ddl.length > 0) {
        return c.json(
          {
            error: {
              code: "SEED_DDL_REFUSED",
              message: "Raw DDL is not accepted; declare entities in the blueprint and seed their tables",
            },
          },
          400,
        );
      }

      const description = await describeProjectEnvironmentData(c.env, project);
      const entityTables = description.entityTables;

      const mergedTables: Record<string, Array<Record<string, unknown>>> = {
        ...(body.tables ?? {}),
      };
      if (Array.isArray(body.rows)) {
        for (const item of body.rows) {
          if (item && typeof item.table === "string" && item.values && typeof item.values === "object") {
            const list = mergedTables[item.table] ?? [];
            list.push(item.values);
            mergedTables[item.table] = list;
          }
        }
      }

      const refusedTables = Object.keys(mergedTables).filter((t) => !entityTables.has(t));
      if (refusedTables.length > 0) {
        return c.json(
          {
            error: {
              code: "SEED_TABLE_FORBIDDEN",
              message: `Only this project's blueprint entity tables can be seeded; refused: ${refusedTables.join(", ")}`,
              refusedTables,
            },
          },
          403,
        );
      }

      const dataStore = await resolveProjectDataStore(db, project, authz.orgId, parsedEnvName.data);
      if (!dataStore) {
        return projectDataStoreNotConfigured(project, parsedEnvName.data);
      }
      await applyProjectEnvironmentDataSchema(dataStore.rawD1, description);

      let insertedCount = 0;
      for (const [tableName, rows] of Object.entries(mergedTables)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName) || !Array.isArray(rows)) {
          continue;
        }
        for (const rawRow of rows) {
          const row: Record<string, unknown> = rawRow;
          const cols = Object.keys(row).filter((k) =>
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(k),
          );
          if (cols.length === 0) continue;
          const quotedCols = cols.map((col) => `"${col}"`).join(", ");
          const placeholders = cols.map((_, idx) => `?${idx + 1}`).join(", ");
          const vals = cols.map((col) => {
            const v = row[col];
            if (typeof v === "boolean") return v ? 1 : 0;
            if (v !== null && typeof v === "object") return JSON.stringify(v);
            return v ?? null;
          });
          await dataStore.d1
            .prepare(
              `INSERT OR REPLACE INTO "${tableName}" (${quotedCols}) VALUES (${placeholders})`,
            )
            .bind(...vals)
            .run();
          insertedCount += 1;
        }
      }

      return c.json(
        { ok: true, project, insertedCount, dataStore: { kind: "sandbox", sandboxId: dataStore.sandboxId } },
        200,
      );
    },
  );

  // --- Story 6.3: Structured Logs & Errors Panel Routes ---

  const handleStudioLogsRead = async (
    c: import("hono").Context<{ Bindings: StudioApiEnv }>,
  ) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project") ?? "";
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const parsedEnvName = DeployEnvNameSchema.safeParse(c.req.param("envName"));
    if (!parsedEnvName.success) {
      return c.json(
        {
          error: {
            code: "INVALID_ENVIRONMENT_NAME",
            message: "Environment must be 'preview' or 'production'.",
          },
        },
        400,
      );
    }
    const envName = parsedEnvName.data;

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const telemetrySecret = await studioProjectSecret(c.env, project, "control-plane");
    if (!telemetrySecret) {
      return signingSecretNotConfigured();
    }

    // The read is confined to the authorised project (story 1.4).
    const workerRes = await readProjectLogs({
      db,
      project,
      envName,
      search: new URL(c.req.url).search,
      telemetrySecret,
    });

    if (!workerRes) {
      return c.json(
        {
          error: {
            code: "LOGS_ROUTE_NOT_FOUND",
            message: "Worker /__px/logs handler did not match",
          },
        },
        404,
      );
    }

    const body = (await workerRes.json()) as Record<string, unknown>;
    if (workerRes.status !== 200) {
      return c.json(body, workerRes.status as 400 | 401 | 403 | 500);
    }

    return c.json(
      {
        ...body,
        project,
        envName,
      },
      200,
    );
  };

  const handleStudioLogsIngest = async (
    c: import("hono").Context<{ Bindings: StudioApiEnv }>,
  ) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project") ?? "";
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const parsedEnvName = DeployEnvNameSchema.safeParse(c.req.param("envName"));
    if (!parsedEnvName.success) {
      return c.json(
        {
          error: {
            code: "INVALID_ENVIRONMENT_NAME",
            message: "Environment must be 'preview' or 'production'.",
          },
        },
        400,
      );
    }
    const envName = parsedEnvName.data;

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      (typeof rawBody.orgId === "string" ? rawBody.orgId : undefined) ??
        c.req.query("orgId") ??
        c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const secretValues = new Set<string>();
    if (Array.isArray(rawBody.secretValues)) {
      for (const sv of rawBody.secretValues) {
        if (typeof sv === "string" && sv.trim().length >= 3) {
          secretValues.add(sv);
        }
      }
    }

    const vaultRows = await db
      .prepare(
        "SELECT ref, ciphertext_b64, iv_b64 FROM studio_secret_vault WHERE project_id = ? AND status = 'valid'",
      )
      .bind(project)
      .all<{ ref: string; ciphertext_b64: string; iv_b64: string }>();
    const vaultKeySecret = c.env.PX_VAULT_KEY ?? c.env.BETTER_AUTH_SECRET;
    for (const row of vaultRows.results ?? []) {
      try {
        const plain = await decryptSecretValue(
          row.ciphertext_b64,
          row.iv_b64,
          vaultKeySecret,
        );
        if (plain.trim().length >= 3) {
          secretValues.add(plain);
        }
      } catch {
        // Ignore unseal errors
      }
    }

    const rawEntries: Array<Record<string, unknown>> = Array.isArray(rawBody.entries)
      ? (rawBody.entries as Array<Record<string, unknown>>)
      : Array.isArray(rawBody.logs)
        ? (rawBody.logs as Array<Record<string, unknown>>)
        : [rawBody];

    const insertedEntries: StructuredLogEntry[] = [];

    // Story 1.4: every log line names its workspace; a batch with a line that does not is refused whole.
    const unnamed = rawEntries.some(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.message === "string" &&
        item.message.trim() &&
        !(typeof item.workspaceId === "string" && item.workspaceId.trim()),
    );
    if (unnamed) {
      return c.json(
        { error: { code: "WORKSPACE_ID_REQUIRED", message: "Every log entry must name its workspaceId; nothing was written." } },
        400,
      );
    }

    for (const item of rawEntries) {
      if (!item || typeof item !== "object") continue;
      const parsedLevel = LogLevelSchema.safeParse(item.level ?? "info");
      const level: LogLevel = parsedLevel.success ? parsedLevel.data : "info";
      const message = typeof item.message === "string" ? item.message : "";
      if (!message.trim()) continue;

      const entryInput: RawStructuredLogInput = {
        ...(typeof item.logId === "string" ? { logId: item.logId } : {}),
        ...(typeof item.ts === "string" ? { ts: item.ts } : {}),
        level,
        message,
        runId: typeof item.runId === "string" ? item.runId : null,
        workflowId: typeof item.workflowId === "string" ? item.workflowId : null,
        revision: typeof item.revision === "number" ? item.revision : null,
        nodeId: typeof item.nodeId === "string" ? item.nodeId : null,
        brickId: typeof item.brickId === "string" ? item.brickId : null,
        workspaceId: typeof item.workspaceId === "string" ? item.workspaceId : null,
        requestId: typeof item.requestId === "string" ? item.requestId : null,
        fields:
          typeof item.fields === "object" &&
          item.fields !== null &&
          !Array.isArray(item.fields)
            ? (item.fields as Record<string, unknown>)
            : {},
        errorStack: typeof item.errorStack === "string" ? item.errorStack : null,
        envName,
      };

      const persisted = await insertStructuredLog(
        db,
        entryInput,
        { secretValues },
        { projectId: project },
      );
      insertedEntries.push(persisted);
    }

    let broadcastedCount = 0;
    if (insertedEntries.length > 0) {
      const stub = getBlueprintStub(c.env, project);
      const doRes = await stub.fetch(
        `http://blueprint-do/log-broadcast?project=${encodeURIComponent(project)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            envName,
            entries: insertedEntries,
          }),
        },
      );
      if (doRes.ok) {
        const doBody = (await doRes.json()) as { broadcastedCount?: number };
        broadcastedCount = doBody.broadcastedCount ?? 0;
      }
    }

    return c.json(
      {
        ok: true,
        project,
        envName,
        ingestedCount: insertedEntries.length,
        broadcastedCount,
        logs: insertedEntries,
      },
      201,
    );
  };

  for (const logsRoutePath of [
    "/api/projects/:project/environments/:envName/logs",
    "/api/projects/:project/environments/:envName/data/logs",
  ] as const) {
    app.get(logsRoutePath, handleStudioLogsRead);
    app.post(logsRoutePath, handleStudioLogsIngest);
  }

  const cloudflareAnalyticsSnapshotsByEnv = new Map<
    string,
    CloudflareAnalyticsSnapshot
  >();

  const handleStudioHealthRead = async (
    c: import("hono").Context<{ Bindings: StudioApiEnv }>,
  ) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project") ?? "";
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const parsedEnvName = DeployEnvNameSchema.safeParse(c.req.param("envName"));
    if (!parsedEnvName.success) {
      return c.json(
        {
          error: {
            code: "INVALID_ENVIRONMENT_NAME",
            message: "Environment must be 'preview' or 'production'.",
          },
        },
        400,
      );
    }
    const envName = parsedEnvName.data;

    const windowParam = c.req.query("window") ?? "1h";
    const parsedWindow = HealthWindowSchema.safeParse(windowParam);
    if (!parsedWindow.success) {
      return c.json(
        {
          error: {
            code: "INVALID_WINDOW",
            message: "window must be one of 1h, 24h, 7d",
          },
        },
        400,
      );
    }
    const window: HealthWindow = parsedWindow.data;

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const telemetrySecret = await studioProjectSecret(c.env, project, "control-plane");
    if (!telemetrySecret) {
      return signingSecretNotConfigured();
    }

    const nowQuery = c.req.query("now") ?? undefined;
    const workerUrl = new URL(
      `http://env.worker.internal/__px/metrics?window=${encodeURIComponent(window)}&env=${encodeURIComponent(envName)}`,
    );
    const healthWorkspace = c.req.query("workspaceId")?.trim();
    if (healthWorkspace && healthWorkspace !== "all") {
      workerUrl.searchParams.set("workspaceId", healthWorkspace);
    }

    const workerReq = new Request(workerUrl.toString(), {
      method: "GET",
      headers: await signControlPlaneRequest(telemetrySecret, "GET", workerUrl),
    });

    // Confined to the authorised project (story 1.4).
    const workerRes = await handleTelemetryMetricsRequest(workerReq, {
      db,
      telemetrySecret,
      projectId: project,
      pxEnv: envName,
      ...(nowQuery ? { now: nowQuery } : {}),
    });

    if (!workerRes) {
      return c.json(
        {
          error: {
            code: "METRICS_ROUTE_NOT_FOUND",
            message: "Worker /__px/metrics handler did not match",
          },
        },
        404,
      );
    }

    const d1Summary = (await workerRes.json()) as EnvironmentHealthSummary;
    if (workerRes.status !== 200) {
      return c.json(d1Summary, workerRes.status as 400 | 401 | 403 | 500);
    }

    const cfSnapshot =
      cloudflareAnalyticsSnapshotsByEnv.get(`${project}::${envName}::${window}`) ??
      cloudflareAnalyticsSnapshotsByEnv.get(`${project}::${envName}::all`) ??
      null;
    const reconciled = reconcileCloudflareAnalyticsWithD1Metrics(
      d1Summary,
      cfSnapshot,
    );

    return c.json(
      {
        ...reconciled,
        project,
        envName,
      },
      200,
    );
  };

  const handleStudioHealthSeed = async (
    c: import("hono").Context<{ Bindings: StudioApiEnv }>,
  ) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project") ?? "";
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const parsedEnvName = DeployEnvNameSchema.safeParse(c.req.param("envName"));
    if (!parsedEnvName.success) {
      return c.json(
        {
          error: {
            code: "INVALID_ENVIRONMENT_NAME",
            message: "Environment must be 'preview' or 'production'.",
          },
        },
        400,
      );
    }
    const envName = parsedEnvName.data;

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      (typeof rawBody.orgId === "string" ? rawBody.orgId : undefined) ??
        c.req.query("orgId") ??
        c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    // Story 1.4: seeded health data belongs to this project and to one of its own workspaces, which the caller must
    // name (body.workspaceId); every seeded row is written under it and stamped with the project.
    const seedWorkspace =
      typeof rawBody.workspaceId === "string" && rawBody.workspaceId.trim() ? rawBody.workspaceId.trim() : "";
    const stamp = { projectId: project };

    if (rawBody.reset === true) {
      // Story 16 kept this to platform operators while the tables had no project column. Since story 1.4 the reset
      // deletes only this project's rows, but stays operator-only.
      const resetRefusal = refuseNonPlatformOperator(c.env, resolved.caller);
      if (resetRefusal) {
        return c.json({ error: resetRefusal }, 403);
      }
      await ensureTelemetryTables(db);
      await db.batch([
        db
          .prepare("DELETE FROM px_http_rollups WHERE env_name = ?1 AND project_id = ?2")
          .bind(envName, project),
        db
          .prepare("DELETE FROM px_queue_metrics WHERE env_name = ?1 AND project_id = ?2")
          .bind(envName, project),
      ]);
      cloudflareAnalyticsSnapshotsByEnv.delete(`${project}::${envName}::1h`);
      cloudflareAnalyticsSnapshotsByEnv.delete(`${project}::${envName}::24h`);
      cloudflareAnalyticsSnapshotsByEnv.delete(`${project}::${envName}::7d`);
      cloudflareAnalyticsSnapshotsByEnv.delete(`${project}::${envName}::all`);
    }

    const seedsRows = ["samples", "rollups", "queues", "runs"].some((key) => Array.isArray(rawBody[key]));
    if (seedsRows && !(seedWorkspace && (await projectOwnsWorkspace(db, project, seedWorkspace)))) {
      return c.json(
        {
          error: {
            code: seedWorkspace ? "WORKSPACE_NOT_IN_PROJECT" : "WORKSPACE_ID_REQUIRED",
            message: "Health seed needs workspaceId: the project's preview workspace or one of its own workspaces.",
          },
        },
        400,
      );
    }

    if (Array.isArray(rawBody.runs)) {
      const seedCollision = await findTelemetryIdCollision(
        db,
        (rawBody.runs as Array<RunRecord>)
          .filter((run) => typeof run?.runId === "string")
          .map((run) => ({ table: "px_runs" as const, id: run.runId, workspaceId: seedWorkspace, projectId: project })),
      );
      if (seedCollision) return idCollisionResponse(seedCollision);
    }

    const seedRefused = await refusedWriteAs409(async () => {
    if (Array.isArray(rawBody.samples)) {
      const samples: HttpRequestSampleInput[] = (
        rawBody.samples as Array<Record<string, unknown>>
      ).map((s) => ({
        ts:
          typeof s.ts === "string" || typeof s.ts === "number"
            ? s.ts
            : new Date().toISOString(),
        routePrefix: typeof s.routePrefix === "string" ? s.routePrefix : "/",
        brickId: typeof s.brickId === "string" ? s.brickId : "runtime",
        status: typeof s.status === "number" ? s.status : 200,
        latencyMs: typeof s.latencyMs === "number" ? s.latencyMs : 10,
        d1Queries: typeof s.d1Queries === "number" ? s.d1Queries : 0,
        d1LatencyMs: typeof s.d1LatencyMs === "number" ? s.d1LatencyMs : undefined,
        d1Errors: typeof s.d1Errors === "number" ? s.d1Errors : 0,
        envName,
        workspaceId:
          seedWorkspace,
      }));
      await recordHttpRequestSamples(db, samples, stamp);
    }

    if (Array.isArray(rawBody.rollups)) {
      for (const r of rawBody.rollups as Array<HttpRollupInput>) {
        await upsertHttpRollup(
          db,
          {
            ...r,
            workspaceId:
              seedWorkspace,
            envName,
          },
          stamp,
        );
      }
    }

    if (Array.isArray(rawBody.queues)) {
      for (const q of rawBody.queues as Array<QueueMetricInput>) {
        await upsertQueueMetrics(
          db,
          {
            ...q,
            workspaceId:
              seedWorkspace,
            envName,
          },
          stamp,
        );
      }
    }

    if (Array.isArray(rawBody.runs)) {
      for (const run of rawBody.runs as Array<RunRecord>) {
        await upsertRunRecord(
          db,
          {
            ...run,
            workspaceId:
              seedWorkspace,
          },
          stamp,
        );
      }
    }
    });
    if (seedRefused) return seedRefused;

    if (
      typeof rawBody.cloudflareAnalytics === "object" &&
      rawBody.cloudflareAnalytics !== null
    ) {
      const targetWindow =
        typeof rawBody.window === "string" &&
        HealthWindowSchema.safeParse(rawBody.window).success
          ? rawBody.window
          : "all";
      cloudflareAnalyticsSnapshotsByEnv.set(
        `${project}::${envName}::${targetWindow}`,
        rawBody.cloudflareAnalytics as CloudflareAnalyticsSnapshot,
      );
    }

    const summary = await queryEnvironmentMetrics(db, { projectId: project }, {
      env: envName,
      window:
        typeof rawBody.window === "string" &&
        HealthWindowSchema.safeParse(rawBody.window).success
          ? (rawBody.window as HealthWindow)
          : "1h",
      ...(typeof rawBody.now === "string" || typeof rawBody.now === "number"
        ? { now: rawBody.now }
        : {}),
    });

    const cfSnapshot =
      cloudflareAnalyticsSnapshotsByEnv.get(
        `${project}::${envName}::${summary.window}`,
      ) ??
      cloudflareAnalyticsSnapshotsByEnv.get(`${project}::${envName}::all`) ??
      null;
    const reconciled = reconcileCloudflareAnalyticsWithD1Metrics(
      summary,
      cfSnapshot,
    );

    return c.json(
      {
        ...reconciled,
        project,
        envName,
      },
      200,
    );
  };

  for (const healthRoutePath of [
    "/api/projects/:project/environments/:envName/health",
    "/api/projects/:project/environments/:envName/health/seed",
    "/api/projects/:project/environments/:envName/metrics",
  ] as const) {
    app.get(healthRoutePath, handleStudioHealthRead);
    app.post(healthRoutePath, handleStudioHealthSeed);
  }

  app.get("/api/projects/:project/openapi.json", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project") ?? "";
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    await ensureStudioD1Schema(c.env.STUDIO_DB);
    const authz = await authorizeProjectAccess(
      c.env.STUDIO_DB,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const revParam = c.req.query("rev");
    const stub = getBlueprintStub(c.env, project);
    let targetState: ProjectStatePayload["state"] | undefined;

    if (revParam !== undefined && revParam.trim() !== "") {
      const parsedRev = Number(revParam);
      if (!Number.isSafeInteger(parsedRev) || parsedRev < 0) {
        return c.json(
          {
            error: {
              code: "INVALID_REVISION",
              message: `Invalid revision "${revParam}"`,
            },
          },
          400,
        );
      }
      const revRes = await stub.fetch(
        `http://blueprint-do/revisions/${parsedRev}?project=${encodeURIComponent(project)}`,
        { method: "GET" },
      );
      if (revRes.status !== 200) {
        const errBody = await revRes.json().catch(() => ({
          error: { code: "REVISION_NOT_FOUND", message: `Revision ${parsedRev} not found` },
        }));
        return c.json(errBody, revRes.status as 404);
      }
      const revData = (await revRes.json()) as { state?: ProjectStatePayload["state"] };
      targetState = revData.state;
    } else {
      const stateRes = await stub.fetch(
        `http://blueprint-do/state?project=${encodeURIComponent(project)}`,
        { method: "GET" },
      );
      const current = (await stateRes.json()) as ProjectStatePayload;
      targetState = current.state;
    }

    const blueprintInput = targetState
      ? toAssemblerBlueprint(targetState)
      : { project, identity: "stub", bricks: [], entities: [], workflows: [] };

    const assembled = assemble(blueprintInput, catalog);
    const specJson =
      assembled.ok && assembled.files["openapi.json"]
        ? assembled.files["openapi.json"]
        : JSON.stringify(
            generateOpenApiSpec(
              {
                project,
                identity: targetState?.identity ?? "stub",
                bricks: targetState?.bricks ?? [],
                entities: targetState?.entities ?? [],
                workflows: targetState?.workflows ?? [],
              },
              catalog,
            ),
            null,
            2,
          ) + "\n";

    return new Response(specJson, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${project}-openapi.json"`,
        "Cache-Control": "no-store",
      },
    });
  });

  // --- Project Audit Logs & Configurable Data/Log Retention + Redaction Settings (Story 8.2) ---

  const handleGetProjectAuditLogs = async (
    c: import("hono").Context<{ Bindings: StudioApiEnv }>,
  ) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project") ?? "";
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const actionFilter = c.req.query("action") ?? undefined;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;

    const entries = await queryStudioAuditLogs(db, {
      orgId: authz.orgId,
      projectId: project,
      ...(actionFilter ? { action: actionFilter } : {}),
      ...(limit && Number.isFinite(limit) ? { limit } : {}),
    });

    return c.json(
      {
        project,
        orgId: authz.orgId,
        entries,
        logs: entries,
        auditLogs: entries,
      },
      200,
    );
  };

  app.get("/api/projects/:project/audit-logs", handleGetProjectAuditLogs);
  app.get("/api/projects/:project/audit-log", handleGetProjectAuditLogs);

  const ProjectRetentionSettingsBodySchema = z.object({
    orgId: z.string().min(1).max(128).optional(),
    envName: z.enum(["default", "preview", "production"]).optional(),
    runRetentionDays: z.number().int().min(1).max(90).optional(),
    telemetryRetentionDays: z.number().int().min(1).max(30).optional(),
    captureStepIoInProd: z.boolean().optional(),
    additionalRedactKeys: z.array(z.string().min(1).max(128)).max(100).optional(),
  });

  interface RetentionSettingRow {
    project_id: string;
    org_id: string;
    env_name: string;
    run_retention_days: number;
    telemetry_retention_days: number;
    capture_step_io_in_prod: number;
    additional_redact_keys_json: string;
    updated_by: string;
    updated_at: string;
  }

  const loadProjectRetentionSettingsPayload = async (
    db: D1Like,
    project: string,
    orgId: string,
    requestedEnv?: "default" | "preview" | "production",
  ) => {
    const rowsRes = await db
      .prepare(
        `SELECT project_id, org_id, env_name, run_retention_days, telemetry_retention_days,
                capture_step_io_in_prod, additional_redact_keys_json, updated_by, updated_at
         FROM project_retention_settings
         WHERE project_id = ?`,
      )
      .bind(project)
      .all<RetentionSettingRow>();

    const byEnv = new Map<string, RetentionSettingRow>();
    for (const r of rowsRes.results ?? []) {
      byEnv.set(r.env_name, r);
    }

    const parseRow = (row: RetentionSettingRow | undefined, fallbackEnv: string) => {
      let keys: string[] = [];
      if (row?.additional_redact_keys_json) {
        try {
          const parsed = JSON.parse(row.additional_redact_keys_json);
          if (Array.isArray(parsed)) {
            keys = parsed.map((k) => String(k).trim()).filter(Boolean);
          }
        } catch {
          keys = [];
        }
      }
      return {
        project,
        orgId: row?.org_id ?? orgId,
        envName: row?.env_name ?? fallbackEnv,
        runRetentionDays: Number(row?.run_retention_days ?? 14),
        telemetryRetentionDays: Number(row?.telemetry_retention_days ?? 7),
        captureStepIoInProd: row ? Boolean(row.capture_step_io_in_prod) : true,
        additionalRedactKeys: keys,
        updatedBy: row?.updated_by ?? "system",
        updatedAt: row?.updated_at ?? null,
      };
    };

    const defaultCfg = parseRow(byEnv.get("default"), "default");
    const previewCfg = byEnv.has("preview")
      ? parseRow(byEnv.get("preview"), "preview")
      : { ...defaultCfg, envName: "preview" };
    const productionCfg = byEnv.has("production")
      ? parseRow(byEnv.get("production"), "production")
      : { ...defaultCfg, envName: "production" };

    const active =
      requestedEnv === "preview"
        ? previewCfg
        : requestedEnv === "production"
          ? productionCfg
          : defaultCfg;

    return {
      ok: true as const,
      ...active,
      settings: active,
      environments: {
        default: defaultCfg,
        preview: previewCfg,
        production: productionCfg,
      },
    };
  };

  app.get("/api/projects/:project/settings/retention", async (c) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project") ?? "";
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "read",
      c.req.query("orgId") ?? c.req.header("x-org-id"),
    );
    if (!authz.ok) {
      return c.json({ error: authz.error }, authz.status);
    }

    const envQuery = c.req.query("env") ?? c.req.query("envName");
    const requestedEnv =
      envQuery === "preview" || envQuery === "production" || envQuery === "default"
        ? envQuery
        : undefined;

    const payload = await loadProjectRetentionSettingsPayload(
      db,
      project,
      authz.orgId,
      requestedEnv,
    );
    return c.json(payload, 200);
  });

  const handleUpdateProjectRetentionSettings = async (
    c: import("hono").Context<{ Bindings: StudioApiEnv }>,
  ) => {
    const resolved = await resolveStudioCaller(c.env, c.req.raw);
    if (!resolved.ok) {
      return c.json({ error: resolved.error }, 401);
    }

    const project = c.req.param("project") ?? "";
    if (!PROJECT_SLUG_PATTERN.test(project)) {
      return c.json(
        {
          error: {
            code: "INVALID_PROJECT_SLUG",
            message: `Invalid project slug "${project}"`,
          },
        },
        400,
      );
    }

    const db = c.env.STUDIO_DB;
    await ensureStudioD1Schema(db);

    const rawBody = await c.req.json().catch(() => null);
    const parsedBody = ProjectRetentionSettingsBodySchema.safeParse(rawBody);

    const authz = await authorizeProjectAccess(
      db,
      resolved.caller,
      project,
      "mutate",
      (parsedBody.success ? parsedBody.data.orgId : undefined) ??
        c.req.query("orgId") ??
        c.req.header("x-org-id"),
      "edit",
    );
    if (!authz.ok) {
      await recordStudioAuditLog(db, {
        orgId: authz.orgId,
        projectId: project,
        actorType: resolved.caller.author.type,
        actorId: resolved.caller.author.id,
        action: "project.retention_settings.update",
        status: "forbidden",
        targetRef: project,
        details: { code: authz.error.code, role: authz.role },
        request: c.req.raw,
      });
      return c.json({ error: authz.error }, authz.status);
    }

    if (!parsedBody.success) {
      return c.json(
        {
          error: {
            code: "INVALID_RETENTION_SETTINGS",
            message: parsedBody.error.issues.map((i) => i.message).join("; "),
            issues: parsedBody.error.issues,
          },
        },
        400,
      );
    }

    const data = parsedBody.data;
    const envName = data.envName ?? "default";
    const currentPayload = await loadProjectRetentionSettingsPayload(
      db,
      project,
      authz.orgId,
      envName,
    );

    const runRetentionDays =
      data.runRetentionDays ?? currentPayload.runRetentionDays ?? 14;
    const telemetryRetentionDays =
      data.telemetryRetentionDays ?? currentPayload.telemetryRetentionDays ?? 7;
    const captureStepIoInProd =
      data.captureStepIoInProd ?? currentPayload.captureStepIoInProd ?? true;
    const additionalRedactKeys = Array.from(
      new Set(
        (data.additionalRedactKeys ?? currentPayload.additionalRedactKeys ?? [])
          .map((k) => k.trim())
          .filter(Boolean),
      ),
    );
    const nowIso = new Date().toISOString();

    await db
      .prepare(
        `INSERT INTO project_retention_settings (
           project_id, org_id, env_name, run_retention_days, telemetry_retention_days,
           capture_step_io_in_prod, additional_redact_keys_json, updated_by, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, env_name) DO UPDATE SET
           org_id = excluded.org_id,
           run_retention_days = excluded.run_retention_days,
           telemetry_retention_days = excluded.telemetry_retention_days,
           capture_step_io_in_prod = excluded.capture_step_io_in_prod,
           additional_redact_keys_json = excluded.additional_redact_keys_json,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .bind(
        project,
        authz.orgId,
        envName,
        runRetentionDays,
        telemetryRetentionDays,
        captureStepIoInProd ? 1 : 0,
        JSON.stringify(additionalRedactKeys),
        resolved.caller.author.id,
        nowIso,
      )
      .run();

    await recordStudioAuditLog(db, {
      orgId: authz.orgId,
      projectId: project,
      actorType: resolved.caller.author.type,
      actorId: resolved.caller.author.id,
      action: "project.retention_settings.update",
      status: "succeeded",
      targetRef: project,
      details: {
        envName,
        runRetentionDays,
        telemetryRetentionDays,
        captureStepIoInProd,
        additionalRedactKeys,
      },
      request: c.req.raw,
    });

    const updatedPayload = await loadProjectRetentionSettingsPayload(
      db,
      project,
      authz.orgId,
      envName,
    );
    return c.json(updatedPayload, 200);
  };

  app.put(
    "/api/projects/:project/settings/retention",
    handleUpdateProjectRetentionSettings,
  );
  app.patch(
    "/api/projects/:project/settings/retention",
    handleUpdateProjectRetentionSettings,
  );

  return app;
}

export const app = createStudioApiApp();
export default app;
