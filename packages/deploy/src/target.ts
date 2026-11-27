import { z } from "zod";
import { checkGraphBudget, splitStatements, toyRegistry } from "@poc/sdk";
import type { GraphEdge, GraphNode, Registry } from "@poc/sdk";
import { lintMigration, parseCreateTableColumns, type DestructiveMigrationKind, type DestructiveMigrationWarning } from "./migration-lint.ts";
import type { Catalog, ProjectLock } from "@poc/assembler";
import { planLockChanges, planMigrations } from "./provisioner/plan-core.ts";
import type { LockPlan, MigrationPlan } from "./provisioner/plan-core.ts";
import { APP_WORKSPACE, GRAPH_TABLE, LATENCY_TABLE } from "./worker/graph-run.ts";
import { synthesizeDeterministicTokenEntry } from "./fake-token-classifier.ts";
import {
  DEFAULT_SANDBOX_DISPATCH_NAMESPACE,
  SANDBOX_D1_BYTES_CAP,
  SANDBOX_D1_MAX_BYTES,
  SANDBOX_D1_MAX_ROWS,
  SANDBOX_D1_ROW_CAP,
  SANDBOX_DAILY_REQUEST_LIMIT,
  SANDBOX_DAILY_REQUEST_QUOTA,
  SANDBOX_OUTBOUND_RATE_LIMIT_PER_MIN,
  SANDBOX_OUTBOUND_RPM_LIMIT,
  SANDBOX_TTL_DAYS,
  SANDBOX_TTL_MS,
  SandboxDispatchPlatform,
  SandboxGuardrailError,
  assertNoLivePaymentCredential,
  createSandboxDispatcher,
  createSandboxOutboundFetch,
  defaultSandboxDispatchPlatform,
  extractSandboxIdFromRequest,
  inspectOutboundPaymentAndSsrf,
  isLivePaymentCredential,
  storedGraphKey,
  wrapSandboxD1WithStorageCap,
} from "./sandbox-dispatcher.ts";
import type {
  DispatchNamespaceBinding,
  DispatchWorkerStub,
  GuardedSandboxD1,
  SandboxDatabaseRecord,
  SandboxDispatcherEnv,
  SandboxErrorCode,
  SandboxGuardrailCode,
  SandboxStorageCapOptions,
  SandboxStorageStats,
  SandboxWorkerRecord,
} from "./sandbox-dispatcher.ts";

export {
  DEFAULT_SANDBOX_DISPATCH_NAMESPACE,
  SANDBOX_D1_BYTES_CAP,
  SANDBOX_D1_MAX_BYTES,
  SANDBOX_D1_MAX_ROWS,
  SANDBOX_D1_ROW_CAP,
  SANDBOX_DAILY_REQUEST_LIMIT,
  SANDBOX_DAILY_REQUEST_QUOTA,
  SANDBOX_OUTBOUND_RATE_LIMIT_PER_MIN,
  SANDBOX_OUTBOUND_RPM_LIMIT,
  SANDBOX_TTL_DAYS,
  SANDBOX_TTL_MS,
  SandboxDispatchPlatform,
  SandboxGuardrailError,
  assertNoLivePaymentCredential,
  createSandboxDispatcher,
  createSandboxOutboundFetch,
  defaultSandboxDispatchPlatform,
  extractSandboxIdFromRequest,
  inspectOutboundPaymentAndSsrf,
  isLivePaymentCredential,
  wrapSandboxD1WithStorageCap,
};
export type {
  DispatchNamespaceBinding,
  DispatchWorkerStub,
  GuardedSandboxD1,
  SandboxDatabaseRecord,
  SandboxDispatcherEnv,
  SandboxErrorCode,
  SandboxGuardrailCode,
  SandboxStorageCapOptions,
  SandboxStorageStats,
  SandboxWorkerRecord,
};

export const DeployEnvNameSchema = z.enum(["preview", "production"]);
export type DeployEnvName = z.infer<typeof DeployEnvNameSchema>;

export const ByocDeployTargetSchema = z.strictObject({
  type: z.literal("byoc"),
  accountId: z
    .string()
    .regex(/^[0-9a-fA-F]{32}$/, "accountId must be a 32-character hexadecimal Cloudflare account ID")
    .transform((val) => val.toLowerCase()),
  tokenRef: z.string().regex(/^tok_[A-Za-z0-9_-]{8,80}$/, "tokenRef must be an opaque tok_* handle"),
  envName: DeployEnvNameSchema,
  accountPlan: z.enum(["free", "paid"]).optional(),
});
export type ByocDeployTarget = z.infer<typeof ByocDeployTargetSchema>;

export const PlatformSandboxDeployTargetSchema = z.strictObject({
  type: z.literal("platform-sandbox"),
  sandboxId: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/, "sandboxId must be 3-64 lowercase alphanumeric, underscore, or hyphen characters"),
  dispatchNamespace: z.string().min(1).default(DEFAULT_SANDBOX_DISPATCH_NAMESPACE),
  projectId: z.string().min(1).optional(),
  envName: z.literal("preview").optional(),
  expiresAt: z.string().optional(),
  accountPlan: z.enum(["free", "paid"]).optional(),
});
export type PlatformSandboxDeployTarget = z.infer<typeof PlatformSandboxDeployTargetSchema>;

export const DeployTargetSchema = z.discriminatedUnion("type", [ByocDeployTargetSchema, PlatformSandboxDeployTargetSchema]);
export type DeployTarget = z.infer<typeof DeployTargetSchema>;

export const TokenResolverContextSchema = z.strictObject({
  actor: z.string().min(1),
  deployId: z.string().min(1),
  action: z.string().min(1),
});
export type TokenResolverContext = z.infer<typeof TokenResolverContextSchema>;

export type TokenResolver = (tokenRef: string, context: TokenResolverContext) => Promise<string>;

export type CloudflarePermissionScope = "Workers Scripts: Edit" | "D1: Edit" | "Queues: Edit" | "Account Settings: Read";

export type CloudflarePermissionId = "account_settings_read" | "workers_scripts_edit" | "d1_edit" | "queues_edit";

export const REQUIRED_CLOUDFLARE_PERMISSIONS: readonly CloudflarePermissionScope[] = [
  "Workers Scripts: Edit",
  "D1: Edit",
  "Queues: Edit",
  "Account Settings: Read",
] as const;

export const CLOUDFLARE_SCOPED_TOKEN_TEMPLATE_URL =
  "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22queues%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&name=ProjectX+Studio+Deploy";

export const CLOUDFLARE_API_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

export interface CloudflarePermissionReportItem {
  id: CloudflarePermissionId;
  label: CloudflarePermissionScope;
  required: true;
  granted: boolean;
  remediationUrl: string;
  plainError?: string;
  /** False when only Read was shown (read-probe path): the Edit permission is confirmed by the first deploy. */
  confirmed?: boolean;
  /** What is known about this permission, when it is not simply granted or missing. */
  note?: string;
}

export interface CloudflareAccountSummary {
  id: string;
  name: string;
  subdomain?: string | null;
}

export interface CloudflareTokenVerificationReport {
  verifiedBy?: "policies" | "read-probe";
  ok: boolean;
  status: "active" | "disabled" | "expired" | "invalid";
  isGlobalApiKey: boolean;
  accountId?: string;
  accountName?: string;
  accounts?: CloudflareAccountSummary[];
  permissions: CloudflarePermissionReportItem[];
  missingPermissionIds: CloudflarePermissionId[];
  missingPermissionLabels: CloudflarePermissionScope[];
  remediationUrl: string;
  summaryMessage: string;
}

export interface CloudflareTokenTemplateMetadata {
  templateUrl: string;
  dashboardUrl: string;
  tokenName: string;
  explanation: string;
  permissions: Array<{
    id: CloudflarePermissionId;
    label: CloudflarePermissionScope;
    key: string;
    access: "read" | "edit";
    description: string;
  }>;
}

export function buildCloudflareTokenTemplateUrl(): CloudflareTokenTemplateMetadata {
  return {
    templateUrl: CLOUDFLARE_SCOPED_TOKEN_TEMPLATE_URL,
    dashboardUrl: CLOUDFLARE_API_TOKENS_URL,
    tokenName: "ProjectX Studio Deploy",
    explanation: "Your backend runs in your own Cloudflare account. We never host it.",
    permissions: [
      {
        id: "account_settings_read",
        label: "Account Settings: Read",
        key: "account_settings",
        access: "read",
        description: "Confirm your Cloudflare account ID and account name.",
      },
      {
        id: "workers_scripts_edit",
        label: "Workers Scripts: Edit",
        key: "workers_scripts",
        access: "edit",
        description: "Upload and update your assembled Cloudflare Worker scripts, bindings, and Cron Triggers.",
      },
      {
        id: "d1_edit",
        label: "D1: Edit",
        key: "d1",
        access: "edit",
        description: "Provision your preview and production D1 SQLite databases and apply schema migrations.",
      },
      {
        id: "queues_edit",
        label: "Queues: Edit",
        key: "queues",
        access: "edit",
        description: "Create and bind Cloudflare Queues used by asynchronous workflows.",
      },
    ],
  };
}

export interface CloudflareApiCallRecord {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  accountId: string;
  action: string;
  timestamp: string;
  /** Whether the call could change the account (absent: anything but a GET); a read-only D1 query (a POST) is not a write. */
  write?: boolean;
}

/** Whether a recorded call could have changed the account. */
export const isMutatingApiCall = (call: CloudflareApiCallRecord): boolean => call.write ?? call.method !== "GET";

export interface CloudflareWorkerScriptState {
  scriptName: string;
  versionId: string;
  sha256: string;
  buildHash?: string;
  codeHash?: string;
  graphHash?: string;
  code: string;
  bindings: Array<Record<string, unknown>>;
  cronTriggers: string[];
  secrets: string[];
  updatedAt: string;
}

export interface CloudflareD1DatabaseState {
  uuid: string;
  name: string;
  appliedMigrations: Array<{
    name: string;
    sha256: string;
    appliedAt: string;
  }>;
  /** Keyed by graph id for app-wide graphs, by `<workspace>:<id>` for any other workspace. */
  graphs: Record<string, { graph: string; updatedAt: string; workspaceId?: string }>;
  schedules?: Array<Record<string, unknown>>;
  graphHash?: string;
  /** What the account records as last deployed (the real client reads these from the database's own state table). */
  buildHash?: string;
  codeHash?: string;
  tables: string[];
}

export interface CloudflareQueueState {
  queueId: string;
  queueName: string;
  createdAt: string;
}

export interface CloudflareWorkflowState {
  name: string;
  className: string;
  scriptName: string;
  updatedAt: string;
}

export interface CloudflareTokenCheckResult {
  /** How the permissions were established: the token's own policies, or one harmless read per capability (Read only; Edit is confirmed by the first deploy). */
  verifiedBy?: "policies" | "read-probe";
  valid: boolean;
  tokenId: string | null;
  status: "active" | "disabled" | "expired" | "invalid";
  expiresOn: string | null;
  isGlobalApiKey: boolean;
  account: {
    id: string;
    name: string;
    subdomain: string | null;
  } | null;
  permissions: Record<CloudflarePermissionScope, { granted: boolean; message?: string; confirmed?: boolean }>;
  missingPermissions: CloudflarePermissionScope[];
}

export interface GetScriptOptions {
  /** Version ids Studio made itself (uploads, secret puts); a newer unannotated version not listed here makes the code unknown. */
  trustedVersionIds?: readonly string[];
}

export interface CloudflareApiClient {
  readonly calls: ReadonlyArray<CloudflareApiCallRecord>;
  /** How many Worker uploads this client made. */
  readonly scriptUploadCount?: number;
  verifyTokenAndPermissions(accountId: string, token: string): Promise<CloudflareTokenCheckResult>;
  getScript(accountId: string, token: string, scriptName: string, options?: GetScriptOptions): Promise<CloudflareWorkerScriptState | null>;
  /** The account's workers.dev subdomain, or null if it has none (the real client; the address of every Worker). */
  getWorkersSubdomain?(accountId: string, token: string): Promise<string | null>;
  /** The Worker's version ids, newest first (the real client), or null if there is no such Worker. */
  listScriptVersionIds?(accountId: string, token: string, scriptName: string): Promise<string[] | null>;
  putScript(
    accountId: string,
    token: string,
    scriptName: string,
    input: {
      code: string;
      sha256: string;
      bindings?: Array<Record<string, unknown>>;
      cronTriggers?: string[];
      compatibilityDate?: string;
      compatibilityFlags?: string[];
      /** The environment's D1 database, bound as DB by a real upload. */
      databaseId?: string;
      /** Further bindings a real upload carries (PX_ENVIRONMENT, the GraphRunner Workflow). Never a secret: secrets go through putScriptSecret. */
      deployBindings?: Array<Record<string, unknown>>;
    },
  ): Promise<{
    scriptName: string;
    versionId: string;
    sha256: string;
    url: string;
  }>;
  /** Records the deployed build, code and graph hashes where the next plan reads them (fake: memory; HTTP: the env's D1). */
  recordDeployState?(
    accountId: string,
    token: string,
    scriptName: string,
    databaseName: string,
    meta: { buildHash?: string; codeHash?: string; graphHash?: string },
  ): Promise<void>;
  deleteScript(accountId: string, token: string, scriptName: string): Promise<void>;
  putScriptSecret(
    accountId: string,
    token: string,
    scriptName: string,
    secretName: string,
    secretValue: string,
  ): Promise<{ name: string; type: "secret_text"; versionId?: string }>;
  deleteScriptSecret?(accountId: string, token: string, scriptName: string, secretName: string): Promise<void>;
  putCronTriggers(accountId: string, token: string, scriptName: string, crons: string[]): Promise<string[]>;
  listDatabases(accountId: string, token: string): Promise<Array<{ uuid: string; name: string }>>;
  getDatabase?(accountId: string, token: string, nameOrId: string): Promise<CloudflareD1DatabaseState | null>;
  ensureDatabase(accountId: string, token: string, name: string): Promise<CloudflareD1DatabaseState>;
  deleteDatabase(accountId: string, token: string, databaseId: string): Promise<void>;
  applyDatabaseMigration(accountId: string, token: string, databaseId: string, migration: { name: string; sql: string; sha256: string }): Promise<void>;
  /** A D1 Time Travel bookmark for the database's current state (taken before a deploy applies pending migrations). */
  getD1Bookmark(accountId: string, token: string, databaseId: string): Promise<string>;
  /** Restores the database to a bookmark; the answer's previous_bookmark undoes the restore. */
  restoreD1(accountId: string, token: string, databaseId: string, bookmark: string): Promise<{ previous_bookmark: string }>;
  /** Stores a graph row for one workspace; the Studio deploy path writes app-wide graphs, under APP_WORKSPACE. */
  putStoredGraph(
    accountId: string,
    token: string,
    databaseId: string,
    workspaceId: string,
    graphId: string,
    graphJson: string,
  ): Promise<{ graphId: string; updatedAt: string }>;
  putScheduleRows?(
    accountId: string,
    token: string,
    databaseId: string,
    schedules: Array<Record<string, unknown>>,
  ): Promise<{ count: number; updatedAt: string }>;
  listQueues?(accountId: string, token: string): Promise<CloudflareQueueState[]>;
  ensureQueue(accountId: string, token: string, queueName: string): Promise<CloudflareQueueState>;
  deleteQueue(accountId: string, token: string, queueName: string): Promise<void>;
  listWorkflows?(accountId: string, token: string): Promise<CloudflareWorkflowState[]>;
  putWorkflow(accountId: string, token: string, workflowName: string, definition: { className: string; scriptName: string }): Promise<CloudflareWorkflowState>;
  deleteWorkflow(accountId: string, token: string, workflowName: string): Promise<void>;
}

export interface ProvisionerMigrationItem {
  name: string;
  sql: string;
  sha256?: string;
}

export type { DestructiveMigrationKind, DestructiveMigrationWarning };

export type DeployPlanAction = "create" | "update" | "hot_apply_graphs" | "noop";

export interface DeployPlanSecretCheck {
  name: string;
  ref?: string;
  requiredByBrick: string;
  /**
   * "will_generate": a platform-made secret (manifest `generate`) Studio creates on an approved preview deploy (story 1.19).
   * "optional_missing": an `optional` secret with no value; it never blocks (the brick runs without that feature).
   */
  status: "present" | "missing" | "will_generate" | "optional_missing";
  optional?: boolean;
  generate?: "random-32-bytes";
}

export interface DeployPlanBlocker {
  code: string;
  message: string;
  remediation: string;
}

export interface DeployPlan {
  action: DeployPlanAction;
  worker: {
    scriptName: string;
    currentBuildHash: string | null;
    nextBuildHash: string;
    changed: boolean;
  };
  d1: {
    databaseName: string;
    createDatabase: boolean;
    pendingMigrations: string[];
    pendingMigrationSql: Record<string, string>;
    destructiveWarnings: DestructiveMigrationWarning[];
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
  secrets: DeployPlanSecretCheck[];
  blockers: DeployPlanBlocker[];
}

export interface ProvisionerResourceAction {
  kind: "worker_script" | "d1_database" | "d1_migration" | "queue" | "cron_trigger" | "workflow" | "secret" | "graph";
  name: string;
  action: "create" | "update" | "unchanged" | "delete";
  summary: string;
}

export interface DeployPlanSecretRequirement {
  name: string;
  ref?: string;
  requiredByBrick: string;
  /** The manifest marks it optional: a missing value never blocks (story 1.19). */
  optional?: boolean;
  /** The platform can make the value itself (story 1.19): generated on an approved preview deploy, never on production. */
  generate?: "random-32-bytes";
}

export interface DeployPlanReadinessIssue {
  code: string;
  message: string;
  path?: string;
}

export interface DeployPlanEnvironmentState {
  deployedRev?: number | null;
  currentBuildHash?: string | null;
  buildHash?: string | null;
  currentCodeHash?: string | null;
  codeHash?: string | null;
  currentGraphHash?: string | null;
  graphHash?: string | null;
  databaseExists?: boolean;
  appliedMigrations?: string[];
  existingQueues?: string[];
  queues?: string[];
  currentCrons?: string[];
  cronTriggers?: string[];
  existingWorkflows?: Array<{
    name?: string;
    workflowName?: string;
    className: string;
  }>;
  workflows?: Array<{
    name?: string;
    workflowName?: string;
    className: string;
  }>;
  configuredSecrets?: string[];
  presentSecrets?: string[];
  previousSchemaSql?: string[];
  previousTableSchemas?: Record<string, Record<string, string>>;
  /** The project lock stored with the deploy that is live now; the shared planner diffs the new lock against it. */
  previousLock?: ProjectLock | null;
}

export interface DeployBuildArtifactInput {
  project?: string;
  actor?: string;
  deployId?: string;
  onStep?: (step: ProvisionerDeploymentStep) => void | Promise<void>;
  buildHash: string;
  codeHash?: string;
  graphHash?: string;
  bundle?: {
    code: string;
    sha256: string;
  };
  migrations?: Array<{ name?: string; migrationName?: string; sql: string; sha256?: string }> | Record<string, string>;
  queues?: string[];
  cronTriggers?: string[];
  workflows?: Array<{
    name?: string;
    workflowName?: string;
    className: string;
  }>;
  graphs?: Record<string, string>;
  graph?: { nodes: GraphNode[]; edges: GraphEdge[] };
  accountPlan?: "free" | "paid";
  registry?: Registry;
  schedules?: Array<Record<string, unknown> | string>;
  secrets?: Record<string, string>;
  vars?: Record<string, string>;
  envVars?: Record<string, string>;
  requiredSecrets?: Array<string | DeployPlanSecretRequirement>;
  configuredSecrets?: string[];
  identity?: string;
  blueprint?: {
    project?: string;
    identity?: string;
  };
  readiness?: {
    ready?: boolean;
    needs?: DeployPlanReadinessIssue[];
  };
  readinessIssues?: DeployPlanReadinessIssue[];
  lock?: ProjectLock;
  catalog?: Catalog;
  allowMajor?: boolean;
}

export interface ProvisionerPlanInput {
  target: DeployTarget;
  project: string;
  actor?: string;
  deployId?: string;
  buildHash: string;
  codeHash?: string;
  graphHash?: string;
  bundle: {
    code: string;
    sha256: string;
  };
  migrations?: ProvisionerMigrationItem[];
  queues?: string[];
  cronTriggers?: string[];
  workflows?: Array<{ name: string; className: string }>;
  requiredSecrets?: string[];
  secretRequirements?: DeployPlanSecretRequirement[];
  configuredSecrets?: string[];
  vars?: Record<string, string>;
  envVars?: Record<string, string>;
  identity?: string;
  blueprintIdentity?: string;
  readinessIssues?: DeployPlanReadinessIssue[];
  envState?: DeployPlanEnvironmentState;
  accountPlan?: "free" | "paid";
  graphs?: Record<string, string>;
  graph?: { nodes: GraphNode[]; edges: GraphEdge[] };
  registry?: Registry;
  /** The lock (project.json) about to be deployed. With envState.previousLock it adds `lockPlan` to the result. */
  lock?: ProjectLock;
  catalog?: Catalog;
  /** Acknowledges brick major-version bumps. */
  allowMajor?: boolean;
  /** Bindings the uploaded Worker gets besides its D1 database (see CloudflareApiClient.putScript deployBindings). */
  workerBindings?: Array<Record<string, unknown>>;
  /** Compatibility flags the uploaded Worker needs (["nodejs_compat"] when its bundle imports `node:*`); absent leaves the metadata as before. */
  compatibilityFlags?: string[];
  /** Version ids Studio made itself (see GetScriptOptions): newer versions with these ids are not out-of-band changes. */
  trustedVersionIds?: readonly string[];
}

export interface ProvisionerPlanResult extends DeployPlan {
  target: DeployTarget;
  scriptName: string;
  databaseName: string;
  buildHash: string;
  codeHash?: string;
  graphHash: string;
  noChanges: boolean;
  changes: number;
  actions: ProvisionerResourceAction[];
  missingSecrets: string[];
  /** Present when the input carried a lock: migrations classified, brick and setting changes, from the shared planner (provisioner/plan-core.ts). */
  lockPlan?: Pick<LockPlan, "bricks" | "settings" | "settingsUpgrade"> & Pick<MigrationPlan, "migrations">;
}

export interface ProvisionerDeploymentStep {
  stepOrder: number;
  stepName: string;
  resourceKind: ProvisionerResourceAction["kind"];
  resourceName: string;
  action: "create" | "update" | "unchanged" | "delete" | "hot_apply_graphs" | "noop";
  status: "succeeded" | "skipped";
  summary: string;
  timestamp: string;
}

export interface ProvisionerApplyInput extends ProvisionerPlanInput {
  graphs?: Record<string, string>;
  graph?: { nodes: GraphNode[]; edges: GraphEdge[] };
  accountPlan?: "free" | "paid";
  registry?: Registry;
  schedules?: Array<Record<string, unknown> | string>;
  secrets?: Record<string, string>;
  onStep?: (step: ProvisionerDeploymentStep) => void | Promise<void>;
  /**
   * Called with the pre-migration bookmark as soon as it is taken, before any migration runs, so the caller can keep it
   * durably even if the deploy fails later. If it throws, the deploy stops before any migration.
   */
  onPreMigrationBookmark?: (info: { databaseId: string; bookmark: string }) => void | Promise<void>;
}

export interface ProvisionerApplyResult {
  target: DeployTarget;
  deployId: string;
  scriptName: string;
  versionId: string;
  databaseId: string;
  databaseName: string;
  url: string;
  previewUrl: string;
  buildHash: string;
  codeHash?: string;
  graphHash: string;
  action: DeployPlanAction;
  noChanges: boolean;
  changes: number;
  liveWithoutRedeploy: boolean;
  rebuiltWorker: boolean;
  mutatingCallCount: number;
  appliedActions: ProvisionerResourceAction[];
  steps: ProvisionerDeploymentStep[];
  bindings?: Record<string, string>;
  /** The D1 Time Travel bookmark taken just before the first pending migration on an existing database (absent when none ran). */
  preMigrationBookmark?: string;
  deployedAt: string;
}

export interface ProvisionerPutGraphInput {
  target: DeployTarget;
  project?: string;
  actor?: string;
  deployId?: string;
  graphId?: string;
  graphJson?: string;
  graphs?: Record<string, string>;
  graph?: { nodes: GraphNode[]; edges: GraphEdge[] };
  accountPlan?: "free" | "paid";
  registry?: Registry;
  schedules?: Array<Record<string, unknown> | string>;
  graphHash?: string;
  cronTriggers?: string[];
}

export interface ProvisionerPutGraphResult {
  target: DeployTarget;
  deployId: string;
  scriptName: string;
  databaseId: string;
  graphId: string;
  graphIds: string[];
  graphHash: string;
  workerVersionId: string | null;
  rebuiltWorker: false;
  liveWithoutRedeploy: true;
  schedulesUpdatedCount: number;
  updatedAt: string;
}

export interface ProvisionerPutSecretInput {
  target: DeployTarget;
  project: string;
  actor: string;
  deployId: string;
  secretName: string;
  secretValue: string;
}

export interface ProvisionerPutSecretResult {
  target: DeployTarget;
  scriptName: string;
  secretName: string;
  updatedAt: string;
}

export interface ProvisionerPromoteInput {
  sourceTarget: DeployTarget;
  destinationTarget: DeployTarget;
  project: string;
  actor: string;
  deployId: string;
  buildHash: string;
  codeHash?: string;
  graphHash?: string;
  bundle: {
    code: string;
    sha256: string;
  };
  migrations?: ProvisionerMigrationItem[];
  queues?: string[];
  cronTriggers?: string[];
  workflows?: Array<{ name: string; className: string }>;
  graphs?: Record<string, string>;
  graph?: { nodes: GraphNode[]; edges: GraphEdge[] };
  accountPlan?: "free" | "paid";
  registry?: Registry;
  schedules?: Array<Record<string, unknown> | string>;
  secrets?: Record<string, string>;
  workerBindings?: Array<Record<string, unknown>>;
  compatibilityFlags?: string[];
}

export interface ProvisionerPromoteResult extends ProvisionerApplyResult {
  promotedFromEnv: DeployEnvName;
  reusedArtifactBuildHash: string;
}

export interface ProvisionerDestroyInput {
  target: DeployTarget;
  project: string;
  actor: string;
  deployId: string;
}

export interface ProvisionerDestroyResult {
  target: DeployTarget;
  scriptName: string;
  databaseName: string;
  removedResources: string[];
  destroyedAt: string;
}

export interface DeployProvisioner {
  plan(
    inputOrTargetOrArtifact: ProvisionerPlanInput | DeployTarget | DeployBuildArtifactInput,
    buildArtifactOrTarget?: DeployBuildArtifactInput | DeployTarget,
    envState?: DeployPlanEnvironmentState,
  ): Promise<ProvisionerPlanResult>;
  apply(
    inputOrTargetOrArtifact: ProvisionerApplyInput | DeployTarget | DeployBuildArtifactInput,
    planOrArtifactOrTarget?: DeployPlan | DeployBuildArtifactInput | DeployTarget,
    artifactArg?: DeployBuildArtifactInput,
    options?: {
      actor?: string;
      deployId?: string;
      onStep?: (step: ProvisionerDeploymentStep) => void | Promise<void>;
    },
  ): Promise<ProvisionerApplyResult>;
  putGraph(
    inputOrTargetOrGraphs: ProvisionerPutGraphInput | DeployTarget | Record<string, string> | Array<{ id: string; [key: string]: unknown }>,
    graphsOrTarget?: Record<string, string> | Array<{ id: string; [key: string]: unknown }> | DeployTarget,
    schedulesArg?: Array<Record<string, unknown> | string>,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
      graphHash?: string;
      cronTriggers?: string[];
    },
  ): Promise<ProvisionerPutGraphResult>;
  putSecret(
    inputOrTarget: ProvisionerPutSecretInput | DeployTarget,
    secretName?: string,
    secretValue?: string,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
    },
  ): Promise<ProvisionerPutSecretResult>;
  promote(input: ProvisionerPromoteInput): Promise<ProvisionerPromoteResult>;
  destroy(
    inputOrTarget: ProvisionerDestroyInput | DeployTarget,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
    },
  ): Promise<ProvisionerDestroyResult>;
}

export function deriveEnvironmentResourceNames(
  project: string,
  envNameOrTarget: DeployEnvName | DeployTarget,
): {
  scriptName: string;
  databaseName: string;
} {
  if (typeof envNameOrTarget === "object" && envNameOrTarget !== null && envNameOrTarget.type === "platform-sandbox") {
    return {
      scriptName: envNameOrTarget.sandboxId,
      databaseName: `px_sbx_${envNameOrTarget.sandboxId}`,
    };
  }
  const envName = typeof envNameOrTarget === "string" ? envNameOrTarget : envNameOrTarget.envName;
  const normalized = project
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return {
    scriptName: `px-${normalized}-${envName}`,
    databaseName: `px-${normalized}-${envName}-db`,
  };
}

export interface RegisteredMockToken {
  token: string;
  tokenId: string;
  accountId: string;
  accountName: string;
  accounts?: CloudflareAccountSummary[];
  subdomain: string | null;
  status: "active" | "disabled" | "expired";
  expiresOn?: string | null;
  isGlobalApiKey?: boolean;
  permissions: readonly CloudflarePermissionScope[];
}

export class MockCloudflareControlPlane implements CloudflareApiClient {
  private readonly tokens = new Map<string, RegisteredMockToken>();
  private readonly scripts = new Map<string, CloudflareWorkerScriptState>();
  private readonly databases = new Map<string, CloudflareD1DatabaseState>();
  private readonly queues = new Map<string, CloudflareQueueState>();
  private readonly workflows = new Map<string, CloudflareWorkflowState>();
  private readonly callLog: CloudflareApiCallRecord[] = [];
  private versionCounter = 1;
  private dbCounter = 1;
  private queueCounter = 1;
  private bookmarkCounter = 1;
  private readonly bookmarks = new Map<string, { key: string; state: CloudflareD1DatabaseState }>();

  get calls(): ReadonlyArray<CloudflareApiCallRecord> {
    return this.callLog;
  }

  get mutatingCalls(): ReadonlyArray<CloudflareApiCallRecord> {
    return this.callLog.filter((c) => c.method !== "GET");
  }

  get scriptUploadCount(): number {
    return this.callLog.filter((c) => c.action === "put_script").length;
  }

  clearCalls(): void {
    this.callLog.length = 0;
  }

  inspectDatabase(accountId: string, nameOrId: string): CloudflareD1DatabaseState | null {
    for (const [k, db] of this.databases.entries()) {
      if (k.startsWith(`${accountId}:`) && (db.name === nameOrId || db.name === `${nameOrId}-db` || db.uuid === nameOrId)) {
        return structuredClone(db);
      }
    }
    return null;
  }

  inspectScript(accountId: string, scriptName: string): CloudflareWorkerScriptState | null {
    const found = this.scripts.get(`${accountId}:${scriptName}`);
    return found ? structuredClone(found) : null;
  }

  registerToken(spec: Partial<RegisteredMockToken> & { token: string; accountId: string }): void {
    this.tokens.set(spec.token, {
      token: spec.token,
      tokenId: spec.tokenId ?? "cf_tok_mock_default",
      accountId: spec.accountId,
      accountName: spec.accountName ?? "Mock Cloudflare Account",
      accounts: spec.accounts,
      subdomain: spec.subdomain !== undefined ? spec.subdomain : "mock-workers",
      status: spec.status ?? "active",
      expiresOn: spec.expiresOn ?? null,
      isGlobalApiKey: spec.isGlobalApiKey ?? false,
      permissions: spec.permissions ? [...spec.permissions] : [...REQUIRED_CLOUDFLARE_PERMISSIONS],
    });
  }

  getRegisteredToken(token: string): RegisteredMockToken | undefined {
    return this.tokens.get(token);
  }

  hasRegisteredTokens(): boolean {
    return this.tokens.size > 0;
  }

  revokeAtCloudflare(token: string): void {
    const existing = this.tokens.get(token);
    if (existing) {
      this.tokens.set(token, { ...existing, status: "disabled" });
    }
  }

  mutateScriptOutOfBand(accountId: string, scriptName: string, patch: Partial<CloudflareWorkerScriptState>): void {
    const key = `${accountId}:${scriptName}`;
    const current = this.scripts.get(key);
    if (current) {
      this.scripts.set(key, {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private recordCall(method: CloudflareApiCallRecord["method"], path: string, accountId: string, action: string): void {
    this.callLog.push({
      method,
      path,
      accountId,
      action,
      timestamp: new Date().toISOString(),
    });
  }

  private assertAuthorized(
    accountId: string,
    token: string,
    requiredScope: CloudflarePermissionScope,
    method: CloudflareApiCallRecord["method"],
    path: string,
    action: string,
  ): RegisteredMockToken {
    this.recordCall(method, path, accountId, action);
    const entry = this.tokens.get(token);
    if (!entry || entry.status !== "active") {
      throw new Error(`Cloudflare API 401 Unauthorized: invalid or inactive API token for ${method} ${path}`);
    }
    if (entry.accountId !== accountId) {
      throw new Error(`Cloudflare API 403 Forbidden: token does not grant access to account ${accountId}`);
    }
    if (!entry.permissions.includes(requiredScope)) {
      throw new Error(`Cloudflare API 403 Forbidden: missing required permission "${requiredScope}"`);
    }
    return entry;
  }

  async verifyTokenAndPermissions(accountId: string, token: string): Promise<CloudflareTokenCheckResult> {
    this.recordCall("GET", `/accounts/${accountId}/tokens/verify`, accountId, "verify_token");
    const entry = this.tokens.get(token);
    if (!entry) {
      const permissions = Object.fromEntries(
        REQUIRED_CLOUDFLARE_PERMISSIONS.map((scope) => [
          scope,
          {
            granted: false,
            message: "Token could not be authenticated by Cloudflare.",
          },
        ]),
      ) as CloudflareTokenCheckResult["permissions"];
      return {
        valid: false,
        tokenId: null,
        status: "invalid",
        expiresOn: null,
        isGlobalApiKey: false,
        account: null,
        permissions,
        missingPermissions: [...REQUIRED_CLOUDFLARE_PERMISSIONS],
      };
    }

    const wrongAccount = entry.accountId !== accountId;
    const isActive = entry.status === "active" && !wrongAccount;
    const missingPermissions: CloudflarePermissionScope[] = [];
    const permissions = {} as CloudflareTokenCheckResult["permissions"];

    for (const scope of REQUIRED_CLOUDFLARE_PERMISSIONS) {
      const granted = isActive && !entry.isGlobalApiKey && entry.permissions.includes(scope);
      if (!granted) {
        missingPermissions.push(scope);
      }
      permissions[scope] = {
        granted,
        ...(granted
          ? {}
          : {
              message: wrongAccount
                ? `Token is scoped to account ${entry.accountId}, not ${accountId}.`
                : entry.isGlobalApiKey
                  ? "Over-broad Global API Key rejected; create a scoped API token instead."
                  : `Missing "${scope}" permission on this token.`,
            }),
      };
    }

    return {
      valid: isActive && !entry.isGlobalApiKey && missingPermissions.length === 0,
      tokenId: entry.tokenId,
      status: wrongAccount ? "invalid" : entry.status,
      expiresOn: entry.expiresOn ?? null,
      isGlobalApiKey: Boolean(entry.isGlobalApiKey),
      account: wrongAccount
        ? null
        : {
            id: entry.accountId,
            name: entry.accountName,
            subdomain: entry.subdomain,
          },
      permissions,
      missingPermissions,
    };
  }

  async getScript(accountId: string, token: string, scriptName: string): Promise<CloudflareWorkerScriptState | null> {
    this.assertAuthorized(accountId, token, "Workers Scripts: Edit", "GET", `/accounts/${accountId}/workers/scripts/${scriptName}`, "get_script");
    const found = this.scripts.get(`${accountId}:${scriptName}`);
    return found ? structuredClone(found) : null;
  }

  async putScript(
    accountId: string,
    token: string,
    scriptName: string,
    input: {
      code: string;
      sha256: string;
      bindings?: Array<Record<string, unknown>>;
      cronTriggers?: string[];
      compatibilityDate?: string;
      compatibilityFlags?: string[];
    },
  ): Promise<{
    scriptName: string;
    versionId: string;
    sha256: string;
    url: string;
  }> {
    const entry = this.assertAuthorized(accountId, token, "Workers Scripts: Edit", "PUT", `/accounts/${accountId}/workers/scripts/${scriptName}`, "put_script");
    const key = `${accountId}:${scriptName}`;
    const existing = this.scripts.get(key);
    const versionId = `ver_${this.versionCounter++}_${input.sha256.slice(0, 8)}`;
    const nextState: CloudflareWorkerScriptState = {
      scriptName,
      versionId,
      sha256: input.sha256,
      code: input.code,
      bindings: input.bindings ?? existing?.bindings ?? [],
      cronTriggers: input.cronTriggers ?? existing?.cronTriggers ?? [],
      secrets: existing?.secrets ?? [],
      updatedAt: new Date().toISOString(),
    };
    this.scripts.set(key, nextState);
    const sub = entry.subdomain ?? "workers";
    return {
      scriptName,
      versionId,
      sha256: input.sha256,
      url: `https://${scriptName}.${sub}.workers.dev`,
    };
  }

  async deleteScript(accountId: string, token: string, scriptName: string): Promise<void> {
    this.assertAuthorized(accountId, token, "Workers Scripts: Edit", "DELETE", `/accounts/${accountId}/workers/scripts/${scriptName}`, "delete_script");
    this.scripts.delete(`${accountId}:${scriptName}`);
  }

  async putScriptSecret(
    accountId: string,
    token: string,
    scriptName: string,
    secretName: string,
    _secretValue: string,
  ): Promise<{ name: string; type: "secret_text" }> {
    this.assertAuthorized(
      accountId,
      token,
      "Workers Scripts: Edit",
      "PUT",
      `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`,
      "put_script_secret",
    );
    const key = `${accountId}:${scriptName}`;
    const existing = this.scripts.get(key);
    if (existing && !existing.secrets.includes(secretName)) {
      existing.secrets.push(secretName);
    }
    return { name: secretName, type: "secret_text" };
  }

  async putCronTriggers(accountId: string, token: string, scriptName: string, crons: string[]): Promise<string[]> {
    this.assertAuthorized(
      accountId,
      token,
      "Workers Scripts: Edit",
      "PUT",
      `/accounts/${accountId}/workers/scripts/${scriptName}/schedules`,
      "put_cron_triggers",
    );
    const key = `${accountId}:${scriptName}`;
    const existing = this.scripts.get(key);
    if (existing) {
      existing.cronTriggers = [...crons];
      existing.updatedAt = new Date().toISOString();
    }
    return [...crons];
  }

  async listDatabases(accountId: string, token: string): Promise<Array<{ uuid: string; name: string }>> {
    this.assertAuthorized(accountId, token, "D1: Edit", "GET", `/accounts/${accountId}/d1/database`, "list_databases");
    const out: Array<{ uuid: string; name: string }> = [];
    for (const [k, db] of this.databases.entries()) {
      if (k.startsWith(`${accountId}:`)) {
        out.push({ uuid: db.uuid, name: db.name });
      }
    }
    return out;
  }

  async getDatabase(accountId: string, token: string, nameOrId: string): Promise<CloudflareD1DatabaseState | null> {
    this.assertAuthorized(accountId, token, "D1: Edit", "GET", `/accounts/${accountId}/d1/database/${nameOrId}`, "get_database");
    for (const [k, db] of this.databases.entries()) {
      if (k.startsWith(`${accountId}:`) && (db.name === nameOrId || db.uuid === nameOrId)) {
        return structuredClone(db);
      }
    }
    return null;
  }

  async ensureDatabase(accountId: string, token: string, name: string): Promise<CloudflareD1DatabaseState> {
    this.assertAuthorized(accountId, token, "D1: Edit", "POST", `/accounts/${accountId}/d1/database`, "ensure_database");
    const key = `${accountId}:${name}`;
    let existing = this.databases.get(key);
    if (!existing) {
      existing = {
        uuid: `d1_${this.dbCounter++}_${name}`,
        name,
        appliedMigrations: [],
        graphs: {},
        schedules: [],
        tables: [GRAPH_TABLE, LATENCY_TABLE],
      };
      this.databases.set(key, existing);
    }
    return structuredClone(existing);
  }

  async deleteDatabase(accountId: string, token: string, databaseId: string): Promise<void> {
    this.assertAuthorized(accountId, token, "D1: Edit", "DELETE", `/accounts/${accountId}/d1/database/${databaseId}`, "delete_database");
    for (const [k, v] of this.databases.entries()) {
      if (k.startsWith(`${accountId}:`) && (v.uuid === databaseId || v.name === databaseId)) {
        this.databases.delete(k);
      }
    }
  }

  async applyDatabaseMigration(accountId: string, token: string, databaseId: string, migration: { name: string; sql: string; sha256: string }): Promise<void> {
    this.assertAuthorized(accountId, token, "D1: Edit", "POST", `/accounts/${accountId}/d1/database/${databaseId}/query`, "apply_database_migration");
    for (const [k, v] of this.databases.entries()) {
      if (k.startsWith(`${accountId}:`) && (v.uuid === databaseId || v.name === databaseId)) {
        if (!v.appliedMigrations.some((m) => m.name === migration.name)) {
          v.appliedMigrations.push({
            name: migration.name,
            sha256: migration.sha256,
            appliedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  async getD1Bookmark(accountId: string, token: string, databaseId: string): Promise<string> {
    this.assertAuthorized(accountId, token, "D1: Edit", "GET", `/accounts/${accountId}/d1/database/${databaseId}/time_travel/bookmark`, "get_d1_bookmark");
    const key = this.databaseKey(accountId, databaseId);
    if (!key) throw new Error(`D1 database ${databaseId} not found`);
    const bookmark = `bm_mock_${this.bookmarkCounter++}`;
    this.bookmarks.set(bookmark, { key, state: structuredClone(this.databases.get(key)!) });
    return bookmark;
  }

  async restoreD1(accountId: string, token: string, databaseId: string, bookmark: string): Promise<{ previous_bookmark: string }> {
    this.assertAuthorized(accountId, token, "D1: Edit", "POST", `/accounts/${accountId}/d1/database/${databaseId}/time_travel/restore`, "restore_d1");
    const key = this.databaseKey(accountId, databaseId);
    if (!key) throw new Error(`D1 database ${databaseId} not found`);
    const snap = this.bookmarks.get(bookmark);
    if (!snap || snap.key !== key) throw new Error(`bookmark ${bookmark} not found for D1 database ${databaseId}`);
    const previous = `bm_mock_${this.bookmarkCounter++}`;
    this.bookmarks.set(previous, { key, state: structuredClone(this.databases.get(key)!) });
    this.databases.set(key, structuredClone(snap.state));
    return { previous_bookmark: previous };
  }

  private databaseKey(accountId: string, databaseId: string): string | null {
    for (const [k, v] of this.databases.entries()) {
      if (k.startsWith(`${accountId}:`) && (v.uuid === databaseId || v.name === databaseId)) return k;
    }
    return null;
  }

  async putStoredGraph(
    accountId: string,
    token: string,
    databaseId: string,
    workspaceId: string,
    graphId: string,
    graphJson: string,
  ): Promise<{ graphId: string; updatedAt: string }> {
    this.assertAuthorized(accountId, token, "D1: Edit", "POST", `/accounts/${accountId}/d1/database/${databaseId}/query`, "put_stored_graph");
    const updatedAt = new Date().toISOString();
    for (const [k, v] of this.databases.entries()) {
      if (k.startsWith(`${accountId}:`) && (v.uuid === databaseId || v.name === databaseId)) {
        v.graphs[storedGraphKey(workspaceId, graphId)] = { graph: graphJson, updatedAt, workspaceId };
      }
    }
    return { graphId, updatedAt };
  }

  async putScheduleRows(
    accountId: string,
    token: string,
    databaseId: string,
    schedules: Array<Record<string, unknown>>,
  ): Promise<{ count: number; updatedAt: string }> {
    this.assertAuthorized(accountId, token, "D1: Edit", "POST", `/accounts/${accountId}/d1/database/${databaseId}/query`, "put_schedule_rows");
    const updatedAt = new Date().toISOString();
    for (const [k, v] of this.databases.entries()) {
      if (k.startsWith(`${accountId}:`) && (v.uuid === databaseId || v.name === databaseId)) {
        v.schedules = schedules.map((s) => structuredClone(s));
      }
    }
    return { count: schedules.length, updatedAt };
  }

  async listQueues(accountId: string, token: string): Promise<CloudflareQueueState[]> {
    this.assertAuthorized(accountId, token, "Queues: Edit", "GET", `/accounts/${accountId}/queues`, "list_queues");
    const out: CloudflareQueueState[] = [];
    for (const [k, q] of this.queues.entries()) {
      if (k.startsWith(`${accountId}:`)) {
        out.push(structuredClone(q));
      }
    }
    return out;
  }

  async ensureQueue(accountId: string, token: string, queueName: string): Promise<CloudflareQueueState> {
    this.assertAuthorized(accountId, token, "Queues: Edit", "POST", `/accounts/${accountId}/queues`, "ensure_queue");
    const key = `${accountId}:${queueName}`;
    let existing = this.queues.get(key);
    if (!existing) {
      existing = {
        queueId: `q_${this.queueCounter++}_${queueName}`,
        queueName,
        createdAt: new Date().toISOString(),
      };
      this.queues.set(key, existing);
    }
    return structuredClone(existing);
  }

  async deleteQueue(accountId: string, token: string, queueName: string): Promise<void> {
    this.assertAuthorized(accountId, token, "Queues: Edit", "DELETE", `/accounts/${accountId}/queues/${queueName}`, "delete_queue");
    this.queues.delete(`${accountId}:${queueName}`);
  }

  async listWorkflows(accountId: string, token: string): Promise<CloudflareWorkflowState[]> {
    this.assertAuthorized(accountId, token, "Workers Scripts: Edit", "GET", `/accounts/${accountId}/workflows`, "list_workflows");
    const out: CloudflareWorkflowState[] = [];
    for (const [k, wf] of this.workflows.entries()) {
      if (k.startsWith(`${accountId}:`)) {
        out.push(structuredClone(wf));
      }
    }
    return out;
  }

  async putWorkflow(
    accountId: string,
    token: string,
    workflowName: string,
    definition: { className: string; scriptName: string },
  ): Promise<CloudflareWorkflowState> {
    this.assertAuthorized(accountId, token, "Workers Scripts: Edit", "PUT", `/accounts/${accountId}/workflows/${workflowName}`, "put_workflow");
    const key = `${accountId}:${workflowName}`;
    const state: CloudflareWorkflowState = {
      name: workflowName,
      className: definition.className,
      scriptName: definition.scriptName,
      updatedAt: new Date().toISOString(),
    };
    this.workflows.set(key, state);
    return structuredClone(state);
  }

  async deleteWorkflow(accountId: string, token: string, workflowName: string): Promise<void> {
    this.assertAuthorized(accountId, token, "Workers Scripts: Edit", "DELETE", `/accounts/${accountId}/workflows/${workflowName}`, "delete_workflow");
    this.workflows.delete(`${accountId}:${workflowName}`);
  }

  async recordDeployState(
    accountId: string,
    _token: string,
    scriptName: string,
    databaseName: string,
    meta: { buildHash?: string; codeHash?: string; graphHash?: string },
  ): Promise<void> {
    this.recordEnvironmentMetadata(accountId, scriptName, databaseName, meta);
  }

  recordEnvironmentMetadata(
    accountId: string,
    scriptName: string,
    databaseName: string,
    meta: {
      buildHash?: string;
      codeHash?: string;
      graphHash?: string;
      graphs?: Record<string, string>;
      schedules?: string[];
      appliedMigrations?: Array<
        | string
        | {
            name: string;
            sha256: string;
            appliedAt: string;
          }
      >;
    },
  ): void {
    const scriptKey = `${accountId}:${scriptName}`;
    const existingScript = this.scripts.get(scriptKey);
    if (existingScript) {
      if (meta.buildHash !== undefined) existingScript.buildHash = meta.buildHash;
      if (meta.codeHash !== undefined) existingScript.codeHash = meta.codeHash;
      if (meta.graphHash !== undefined) existingScript.graphHash = meta.graphHash;
    }
    const dbKey = `${accountId}:${databaseName}`;
    const existingDb = this.databases.get(dbKey);
    if (existingDb) {
      if (meta.graphHash !== undefined) {
        existingDb.graphHash = meta.graphHash;
      }
      if (meta.graphs !== undefined) {
        const now = new Date().toISOString();
        // meta.graphs are the app-wide graphs; a workspace's own rows are kept as they are
        const nextGraphs: Record<string, { graph: string; updatedAt: string; workspaceId?: string }> = Object.fromEntries(
          Object.entries(existingDb.graphs).filter(([, g]) => g.workspaceId !== undefined && g.workspaceId !== APP_WORKSPACE),
        );
        for (const [gid, gval] of Object.entries(meta.graphs)) {
          nextGraphs[gid] = { graph: gval, updatedAt: now, workspaceId: APP_WORKSPACE };
        }
        existingDb.graphs = nextGraphs;
      }
      if (meta.schedules !== undefined) {
        existingDb.schedules = meta.schedules.map((s) => ({ cron: s }));
      }
      if (meta.appliedMigrations !== undefined) {
        const now = new Date().toISOString();
        existingDb.appliedMigrations = meta.appliedMigrations.map((m) =>
          typeof m === "string" ? { name: m, sha256: `sha256_${m}`, appliedAt: now } : structuredClone(m),
        );
      }
    }
  }

  async getWorkerScript(accountId: string, _token: string, scriptName: string): Promise<CloudflareWorkerScriptState | null> {
    const found = this.scripts.get(`${accountId}:${scriptName}`);
    return found ? structuredClone(found) : null;
  }

  async getCronTriggers(accountId: string, _token: string, scriptName: string): Promise<string[]> {
    const found = this.scripts.get(`${accountId}:${scriptName}`);
    return found ? [...found.cronTriggers] : [];
  }

  mutateWorkerOutOfBand(accountId: string, scriptName: string, patch: { sha256?: string; deleteScript?: boolean }): void {
    const key = `${accountId}:${scriptName}`;
    if (patch.deleteScript) {
      this.scripts.delete(key);
      return;
    }
    const current = this.scripts.get(key);
    if (current && patch.sha256) {
      this.scripts.set(key, {
        ...current,
        sha256: patch.sha256,
        codeHash: patch.sha256,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  mutateDatabaseOutOfBand(
    accountId: string,
    databaseName: string,
    patch: {
      appliedMigrations?: Array<
        | string
        | {
            name: string;
            sha256: string;
            appliedAt: string;
          }
      >;
      graphs?: Record<string, { graph: string; updatedAt: string }>;
      schedules?: Array<Record<string, unknown>>;
    },
  ): void {
    const dbKey = `${accountId}:${databaseName}`;
    const current = this.databases.get(dbKey);
    if (current) {
      const now = new Date().toISOString();
      this.databases.set(dbKey, {
        ...current,
        ...(patch.graphs !== undefined ? { graphs: patch.graphs } : {}),
        ...(patch.schedules !== undefined ? { schedules: patch.schedules } : {}),
        ...(patch.appliedMigrations !== undefined
          ? {
              appliedMigrations: patch.appliedMigrations.map((m) =>
                typeof m === "string" ? { name: m, sha256: `sha256_${m}`, appliedAt: now } : structuredClone(m),
              ),
            }
          : {}),
      });
    }
  }

  inspectWorker(accountId: string, scriptName: string): CloudflareWorkerScriptState | null {
    const found = this.scripts.get(`${accountId}:${scriptName}`);
    return found ? structuredClone(found) : null;
  }

  deleteQueueOutOfBand(accountId: string, queueName: string): void {
    this.queues.delete(`${accountId}:${queueName}`);
  }

  mutateCronTriggersOutOfBand(accountId: string, scriptName: string, cronTriggers: string[]): void {
    const key = `${accountId}:${scriptName}`;
    const current = this.scripts.get(key);
    if (current) {
      this.scripts.set(key, {
        ...current,
        cronTriggers: [...cronTriggers],
        updatedAt: new Date().toISOString(),
      });
    }
  }

  findActiveTokenForAccount(accountId: string): string | null {
    for (const [token, entry] of this.tokens.entries()) {
      if (entry.accountId === accountId && entry.status === "active") {
        return token;
      }
    }
    return null;
  }
}

function isDeployTargetLike(value: unknown): value is DeployTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    ((value as { type?: unknown }).type === "byoc" || (value as { type?: unknown }).type === "platform-sandbox")
  );
}

function normalizeArtifactToPlanInput(
  rawTarget: DeployTarget,
  artifact: DeployBuildArtifactInput,
  envStateArg?: DeployPlanEnvironmentState,
  actor = "studio_plan",
  deployId = "dep_plan",
): ProvisionerPlanInput {
  const defaultProject = rawTarget.type === "platform-sandbox" ? (rawTarget.projectId ?? "project") : "project";
  const project = artifact.project ?? artifact.blueprint?.project ?? defaultProject;
  const normalizedMigrations: ProvisionerMigrationItem[] = [];
  if (Array.isArray(artifact.migrations)) {
    for (const m of artifact.migrations) {
      const name = m.name ?? m.migrationName ?? "0001_migration.sql";
      normalizedMigrations.push({
        name,
        sql: m.sql,
        sha256: m.sha256 ?? `sha256_${name}`,
      });
    }
  } else if (artifact.migrations && typeof artifact.migrations === "object") {
    for (const [name, sql] of Object.entries(artifact.migrations)) {
      normalizedMigrations.push({
        name,
        sql,
        sha256: `sha256_${name}`,
      });
    }
  }
  const secretRequirements: DeployPlanSecretRequirement[] = [];
  const requiredSecretNames: string[] = [];
  for (const req of artifact.requiredSecrets ?? []) {
    if (typeof req === "string") {
      requiredSecretNames.push(req);
      secretRequirements.push({
        name: req,
        requiredByBrick: "blueprint",
      });
    } else {
      requiredSecretNames.push(req.name);
      secretRequirements.push(req);
    }
  }
  return {
    target: rawTarget,
    project,
    actor,
    deployId,
    buildHash: artifact.buildHash,
    codeHash: artifact.codeHash,
    graphHash: artifact.graphHash,
    bundle: {
      code: artifact.bundle?.code ?? "export default {};",
      sha256: artifact.bundle?.sha256 ?? artifact.codeHash ?? artifact.buildHash,
    },
    migrations: normalizedMigrations,
    queues: artifact.queues ?? [],
    cronTriggers: artifact.cronTriggers ?? [],
    workflows: (artifact.workflows ?? []).map((wf) => ({
      name: wf.workflowName ?? wf.name ?? "workflow",
      className: wf.className,
    })),
    requiredSecrets: requiredSecretNames,
    secretRequirements,
    configuredSecrets: envStateArg?.configuredSecrets ?? envStateArg?.presentSecrets ?? artifact.configuredSecrets ?? [],
    identity: artifact.identity ?? artifact.blueprint?.identity,
    blueprintIdentity: artifact.blueprint?.identity ?? artifact.identity,
    readinessIssues: artifact.readinessIssues ?? artifact.readiness?.needs ?? [],
    envState: envStateArg,
    ...(artifact.vars ? { vars: artifact.vars } : {}),
    ...(artifact.envVars ? { envVars: artifact.envVars } : {}),
    ...(artifact.graphs ? { graphs: artifact.graphs } : {}),
    ...(artifact.graph ? { graph: artifact.graph } : {}),
    ...(artifact.accountPlan ? { accountPlan: artifact.accountPlan } : {}),
    ...(artifact.registry ? { registry: artifact.registry } : {}),
    ...(artifact.lock ? { lock: artifact.lock } : {}),
    ...(artifact.catalog ? { catalog: artifact.catalog } : {}),
    ...(artifact.allowMajor !== undefined ? { allowMajor: artifact.allowMajor } : {}),
  };
}

function normalizePlanCallArguments(
  inputOrTargetOrArtifact: ProvisionerPlanInput | DeployTarget | DeployBuildArtifactInput,
  buildArtifactOrTarget?: DeployBuildArtifactInput | DeployTarget,
  envStateArg?: DeployPlanEnvironmentState,
): ProvisionerPlanInput {
  if (
    typeof inputOrTargetOrArtifact === "object" &&
    inputOrTargetOrArtifact !== null &&
    "target" in inputOrTargetOrArtifact &&
    ("bundle" in inputOrTargetOrArtifact || "buildHash" in inputOrTargetOrArtifact)
  ) {
    const planIn = inputOrTargetOrArtifact as ProvisionerPlanInput;
    return {
      ...planIn,
      bundle: planIn.bundle ?? {
        code: "export default {};",
        sha256: planIn.codeHash ?? planIn.buildHash,
      },
    };
  }
  if (isDeployTargetLike(inputOrTargetOrArtifact)) {
    const artifact = buildArtifactOrTarget && !isDeployTargetLike(buildArtifactOrTarget) ? buildArtifactOrTarget : { buildHash: "sha256_empty" };
    return normalizeArtifactToPlanInput(inputOrTargetOrArtifact, artifact, envStateArg);
  }
  if (isDeployTargetLike(buildArtifactOrTarget)) {
    const artifact = inputOrTargetOrArtifact as DeployBuildArtifactInput;
    return normalizeArtifactToPlanInput(buildArtifactOrTarget, artifact, envStateArg);
  }
  throw new Error("Invalid arguments passed to DeployProvisioner.plan()");
}

function normalizeApplyCallArguments(
  inputOrTargetOrArtifact: ProvisionerApplyInput | DeployTarget | DeployBuildArtifactInput,
  planOrArtifactOrTarget?: DeployPlan | DeployBuildArtifactInput | DeployTarget,
  artifactArg?: DeployBuildArtifactInput,
  options?: {
    actor?: string;
    deployId?: string;
    onStep?: (step: ProvisionerDeploymentStep) => void | Promise<void>;
  },
): ProvisionerApplyInput {
  if (
    typeof inputOrTargetOrArtifact === "object" &&
    inputOrTargetOrArtifact !== null &&
    "target" in inputOrTargetOrArtifact &&
    ("bundle" in inputOrTargetOrArtifact || "buildHash" in inputOrTargetOrArtifact)
  ) {
    const applyIn = inputOrTargetOrArtifact as ProvisionerApplyInput;
    return {
      ...applyIn,
      bundle: applyIn.bundle ?? {
        code: "export default {};",
        sha256: applyIn.codeHash ?? applyIn.buildHash,
      },
    };
  }

  let rawTarget: DeployTarget;
  let artifact: DeployBuildArtifactInput;
  if (isDeployTargetLike(inputOrTargetOrArtifact)) {
    rawTarget = inputOrTargetOrArtifact;
    artifact =
      artifactArg ??
      (planOrArtifactOrTarget && !isDeployTargetLike(planOrArtifactOrTarget) && "buildHash" in planOrArtifactOrTarget
        ? (planOrArtifactOrTarget as DeployBuildArtifactInput)
        : { buildHash: "sha256_empty" });
  } else if (isDeployTargetLike(planOrArtifactOrTarget)) {
    rawTarget = planOrArtifactOrTarget;
    artifact = inputOrTargetOrArtifact as DeployBuildArtifactInput;
  } else {
    throw new Error("Invalid arguments passed to DeployProvisioner.apply()");
  }

  const artifactWithMeta = artifact as DeployBuildArtifactInput & {
    actor?: string;
    deployId?: string;
    onStep?: (step: ProvisionerDeploymentStep) => void | Promise<void>;
  };
  const base = normalizeArtifactToPlanInput(
    rawTarget,
    artifact,
    undefined,
    options?.actor ?? artifactWithMeta.actor ?? "studio_apply",
    options?.deployId ?? artifactWithMeta.deployId ?? "dep_apply",
  );
  return {
    ...base,
    graphs: artifact.graphs,
    schedules: artifact.schedules,
    secrets: artifact.secrets,
    onStep: options?.onStep ?? artifactWithMeta.onStep,
  };
}

function normalizePutGraphCallArguments(
  inputOrTargetOrGraphs: ProvisionerPutGraphInput | DeployTarget | Record<string, string> | Array<{ id: string; [key: string]: unknown }>,
  graphsOrTarget?: Record<string, string> | Array<{ id: string; [key: string]: unknown }> | DeployTarget,
  schedulesArg?: Array<Record<string, unknown> | string>,
  options?: {
    project?: string;
    actor?: string;
    deployId?: string;
    graphHash?: string;
    cronTriggers?: string[];
  },
): ProvisionerPutGraphInput {
  if (
    typeof inputOrTargetOrGraphs === "object" &&
    inputOrTargetOrGraphs !== null &&
    !Array.isArray(inputOrTargetOrGraphs) &&
    "target" in inputOrTargetOrGraphs &&
    isDeployTargetLike((inputOrTargetOrGraphs as { target?: unknown }).target)
  ) {
    return inputOrTargetOrGraphs as ProvisionerPutGraphInput;
  }

  let rawTarget: DeployTarget;
  let graphsSource: Record<string, string> | Array<{ id: string; [key: string]: unknown }> | undefined;
  if (isDeployTargetLike(inputOrTargetOrGraphs)) {
    rawTarget = inputOrTargetOrGraphs;
    graphsSource = !isDeployTargetLike(graphsOrTarget) ? graphsOrTarget : undefined;
  } else if (isDeployTargetLike(graphsOrTarget)) {
    rawTarget = graphsOrTarget;
    graphsSource = inputOrTargetOrGraphs as Record<string, string> | Array<{ id: string; [key: string]: unknown }>;
  } else {
    throw new Error("Invalid arguments passed to DeployProvisioner.putGraph()");
  }

  const graphsRecord: Record<string, string> = {};
  if (Array.isArray(graphsSource)) {
    for (const wf of graphsSource) {
      graphsRecord[wf.id] = JSON.stringify(wf);
    }
  } else if (graphsSource && typeof graphsSource === "object") {
    if (
      "id" in graphsSource &&
      typeof (graphsSource as { id?: unknown }).id === "string" &&
      ("nodes" in graphsSource || "edges" in graphsSource || "trigger" in graphsSource)
    ) {
      const singleWf = graphsSource as { id: string; [key: string]: unknown };
      graphsRecord[singleWf.id] = JSON.stringify(singleWf);
    } else {
      for (const [k, v] of Object.entries(graphsSource)) {
        graphsRecord[k] = typeof v === "string" ? v : JSON.stringify(v);
      }
    }
  }
  const firstGraphId = Object.keys(graphsRecord)[0] ?? "wf_default";
  const defaultProject = rawTarget.type === "platform-sandbox" ? (rawTarget.projectId ?? "project") : "project";
  return {
    target: rawTarget,
    project: options?.project ?? defaultProject,
    actor: options?.actor ?? "studio_hot_apply",
    deployId: options?.deployId ?? "dep_hot_apply",
    graphId: firstGraphId,
    graphJson: graphsRecord[firstGraphId] ?? "{}",
    graphs: graphsRecord,
    schedules: schedulesArg,
    graphHash: options?.graphHash ?? `sha256_graph_${Object.keys(graphsRecord).join("_")}_${(graphsRecord[firstGraphId] ?? "").length}`,
    cronTriggers: options?.cronTriggers,
  };
}

function normalizePutSecretCallArguments(
  inputOrTarget: ProvisionerPutSecretInput | DeployTarget,
  secretName?: string,
  secretValue?: string,
  options?: {
    project?: string;
    actor?: string;
    deployId?: string;
  },
): ProvisionerPutSecretInput {
  if ("target" in inputOrTarget) {
    return inputOrTarget;
  }
  const defaultProject = inputOrTarget.type === "platform-sandbox" ? (inputOrTarget.projectId ?? "project") : "project";
  return {
    target: inputOrTarget,
    project: options?.project ?? defaultProject,
    actor: options?.actor ?? "studio_secret",
    deployId: options?.deployId ?? "dep_secret",
    secretName: secretName ?? "SECRET",
    secretValue: secretValue ?? "",
  };
}

function normalizeDestroyCallArguments(
  inputOrTarget: ProvisionerDestroyInput | DeployTarget,
  options?: {
    project?: string;
    actor?: string;
    deployId?: string;
  },
): ProvisionerDestroyInput {
  if ("target" in inputOrTarget) {
    return inputOrTarget;
  }
  const defaultProject = inputOrTarget.type === "platform-sandbox" ? (inputOrTarget.projectId ?? "project") : "project";
  return {
    target: inputOrTarget,
    project: options?.project ?? defaultProject,
    actor: options?.actor ?? "studio_destroy",
    deployId: options?.deployId ?? "dep_destroy",
  };
}

export function createByocProvisioner(options: { apiClient: CloudflareApiClient; resolveToken: TokenResolver }): DeployProvisioner {
  const { apiClient, resolveToken } = options;

  async function resolveTargetToken(rawTarget: DeployTarget, context: TokenResolverContext): Promise<{ target: ByocDeployTarget; token: string }> {
    const target = ByocDeployTargetSchema.parse(rawTarget);
    const parsedContext = TokenResolverContextSchema.parse(context);
    const token = await resolveToken(target.tokenRef, parsedContext);
    return { target, token };
  }

  return {
    async plan(
      inputOrTargetOrArtifact: ProvisionerPlanInput | DeployTarget | DeployBuildArtifactInput,
      buildArtifactOrTarget?: DeployBuildArtifactInput | DeployTarget,
      envStateArg?: DeployPlanEnvironmentState,
    ): Promise<ProvisionerPlanResult> {
      const normalizedInput = normalizePlanCallArguments(inputOrTargetOrArtifact, buildArtifactOrTarget, envStateArg);

      const { target, token } = await resolveTargetToken(normalizedInput.target, {
        actor: normalizedInput.actor ?? "studio_planner",
        deployId: normalizedInput.deployId ?? "plan_check",
        action: "plan",
      });
      const { scriptName, databaseName } = deriveEnvironmentResourceNames(normalizedInput.project, target.envName);

      const existingScript = await apiClient.getScript(
        target.accountId,
        token,
        scriptName,
        normalizedInput.trustedVersionIds ? { trustedVersionIds: normalizedInput.trustedVersionIds } : undefined,
      );
      const existingDbs = await apiClient.listDatabases(target.accountId, token);
      const apiDbExists = existingDbs.some((d) => d.name === databaseName);
      const existingDbState = apiDbExists
        ? apiClient.getDatabase
          ? await apiClient.getDatabase(target.accountId, token, databaseName)
          : await apiClient.ensureDatabase(target.accountId, token, databaseName)
        : null;

      const existingQueuesFromApi = apiClient.listQueues ? (await apiClient.listQueues(target.accountId, token)).map((q) => q.queueName) : undefined;
      const existingWorkflowsFromApi = apiClient.listWorkflows
        ? (await apiClient.listWorkflows(target.accountId, token))
            .filter((wf) => wf.scriptName === scriptName)
            .map((wf) => ({ workflowName: wf.name, className: wf.className }))
        : undefined;

      const envState = normalizedInput.envState;
      const dbExists = envState?.databaseExists !== undefined ? envState.databaseExists : apiDbExists || Boolean(envState?.deployedRev);

      const appliedMigrationNames = new Set<string>([...(existingDbState?.appliedMigrations.map((m) => m.name) ?? []), ...(envState?.appliedMigrations ?? [])]);

      return computeDeployPlanFromResolvedState({
        target,
        scriptName,
        databaseName,
        input: {
          ...normalizedInput,
          envState: {
            ...envState,
            // what the account itself records as deployed, when the caller does not say (the real client reads it back)
            ...(envState?.currentBuildHash === undefined && existingDbState?.buildHash ? { currentBuildHash: existingDbState.buildHash } : {}),
            currentGraphHash: envState?.currentGraphHash ?? envState?.graphHash ?? existingDbState?.graphHash ?? existingScript?.graphHash ?? null,
            existingQueues: envState?.existingQueues ?? envState?.queues ?? existingQueuesFromApi,
            existingWorkflows: envState?.existingWorkflows ?? envState?.workflows ?? existingWorkflowsFromApi,
          },
        },
        existingScript,
        dbExists,
        appliedMigrationNames,
      });
    },

    async apply(
      inputOrTargetOrArtifact: ProvisionerApplyInput | DeployTarget | DeployBuildArtifactInput,
      planOrArtifactOrTarget?: DeployPlan | DeployBuildArtifactInput | DeployTarget,
      artifactArg?: DeployBuildArtifactInput,
      optionsArg?: {
        actor?: string;
        deployId?: string;
        onStep?: (step: ProvisionerDeploymentStep) => void | Promise<void>;
      },
    ): Promise<ProvisionerApplyResult> {
      const input = normalizeApplyCallArguments(inputOrTargetOrArtifact, planOrArtifactOrTarget, artifactArg, optionsArg);

      const actionName = (input as ProvisionerApplyInput & { _actionOverride?: string })._actionOverride ?? "apply";
      const { target, token } = await resolveTargetToken(input.target, {
        actor: input.actor ?? "studio_apply",
        deployId: input.deployId ?? "dep_apply",
        action: actionName,
      });
      const { scriptName, databaseName } = deriveEnvironmentResourceNames(input.project, target.envName);

      const callsBefore = apiClient.calls.length;

      const existingScript = await apiClient.getScript(
        target.accountId,
        token,
        scriptName,
        input.trustedVersionIds ? { trustedVersionIds: input.trustedVersionIds } : undefined,
      );
      const existingDbs = await apiClient.listDatabases(target.accountId, token);
      const apiDbExists = existingDbs.some((d) => d.name === databaseName);
      const existingDbState = apiDbExists
        ? apiClient.getDatabase
          ? await apiClient.getDatabase(target.accountId, token, databaseName)
          : await apiClient.ensureDatabase(target.accountId, token, databaseName)
        : null;

      const existingQueuesFromApi = apiClient.listQueues ? (await apiClient.listQueues(target.accountId, token)).map((q) => q.queueName) : undefined;
      const existingWorkflowsFromApi = apiClient.listWorkflows
        ? (await apiClient.listWorkflows(target.accountId, token))
            .filter((wf) => wf.scriptName === scriptName)
            .map((wf) => ({ workflowName: wf.name, className: wf.className }))
        : undefined;

      const appliedMigrationNames = new Set<string>([
        ...(existingDbState?.appliedMigrations.map((m) => m.name) ?? []),
        ...(input.envState?.appliedMigrations ?? []),
      ]);

      const resolvedPlan = computeDeployPlanFromResolvedState({
        target,
        scriptName,
        databaseName,
        input: {
          ...input,
          envState: {
            ...input.envState,
            ...(input.envState?.currentBuildHash === undefined && existingDbState?.buildHash ? { currentBuildHash: existingDbState.buildHash } : {}),
            currentGraphHash: input.envState?.currentGraphHash ?? input.envState?.graphHash ?? existingDbState?.graphHash ?? existingScript?.graphHash ?? null,
            existingQueues: input.envState?.existingQueues ?? input.envState?.queues ?? existingQueuesFromApi,
            existingWorkflows: input.envState?.existingWorkflows ?? input.envState?.workflows ?? existingWorkflowsFromApi,
          },
        },
        existingScript,
        dbExists: apiDbExists || Boolean(input.envState?.databaseExists),
        appliedMigrationNames,
      });

      const appliedActions: ProvisionerResourceAction[] = [];
      const steps: ProvisionerDeploymentStep[] = [];
      let stepOrder = 1;
      const emitStep = async (
        stepName: string,
        resourceKind: ProvisionerResourceAction["kind"],
        resourceName: string,
        action: ProvisionerDeploymentStep["action"],
        status: "succeeded" | "skipped",
        summary: string,
      ) => {
        const step: ProvisionerDeploymentStep = {
          stepOrder: stepOrder++,
          stepName,
          resourceKind,
          resourceName,
          action,
          status,
          summary,
          timestamp: new Date().toISOString(),
        };
        steps.push(step);
        if (input.onStep) {
          await input.onStep(step);
        }
      };

      const nextCodeHash = input.codeHash ?? input.bundle.sha256;
      const nextGraphHash = input.graphHash ?? input.bundle.sha256.slice(0, 12);
      const defaultUrl = `https://${scriptName}.workers.dev`;

      // Fast idempotent no-op path: zero mutating calls to the Cloudflare API
      // "No changes" must hold in the account: a missing Worker, or one whose code hash is unknown or not the one to upload, is redeployed.
      const accountCodeMatches = Boolean(existingScript?.codeHash) && existingScript!.codeHash === (input.codeHash ?? input.bundle.sha256);
      if (resolvedPlan.action === "noop" && existingScript && accountCodeMatches) {
        await emitStep(
          "d1_database",
          "d1_database",
          databaseName,
          "noop",
          "skipped",
          `No changes — environment ${target.envName} already at build ${input.buildHash.slice(0, 12)}`,
        );
        const newCalls = apiClient.calls.slice(callsBefore);
        const mutatingCallCount = newCalls.filter(isMutatingApiCall).length;
        return {
          target,
          deployId: input.deployId ?? "dep_apply",
          scriptName,
          versionId: existingScript?.versionId ?? `ver_${input.buildHash.slice(0, 8)}`,
          databaseId: existingDbState?.uuid ?? `d1_${databaseName}`,
          databaseName,
          url: defaultUrl,
          previewUrl: defaultUrl,
          buildHash: input.buildHash,
          codeHash: nextCodeHash,
          graphHash: nextGraphHash,
          action: "noop",
          noChanges: true,
          changes: 0,
          liveWithoutRedeploy: false,
          rebuiltWorker: false,
          mutatingCallCount,
          appliedActions: [],
          steps,
          deployedAt: new Date().toISOString(),
        };
      }

      // Graph-only hot-apply path: update D1 stored graphs & schedules directly without uploading Worker script
      if (resolvedPlan.action === "hot_apply_graphs" && existingScript && accountCodeMatches) {
        const dbState = existingDbState ?? (await apiClient.ensureDatabase(target.accountId, token, databaseName));

        const graphEntries = Object.entries(input.graphs ?? {});
        if (graphEntries.length > 0) {
          for (const [graphId, graphJson] of graphEntries) {
            await apiClient.putStoredGraph(target.accountId, token, dbState.uuid, APP_WORKSPACE, graphId, graphJson);
            appliedActions.push({
              kind: "graph",
              name: graphId,
              action: "update",
              summary: `Hot-applied workflow graph ${graphId} to D1 ${databaseName} (Live without redeploy)`,
            });
          }
        } else {
          await apiClient.putStoredGraph(target.accountId, token, dbState.uuid, APP_WORKSPACE, "__workflows__", JSON.stringify({ graphHash: nextGraphHash }));
          appliedActions.push({
            kind: "graph",
            name: databaseName,
            action: "update",
            summary: `Hot-applied workflow graphs (${nextGraphHash.slice(0, 8)}) to D1 ${databaseName} (Live without redeploy)`,
          });
        }

        if (input.schedules && input.schedules.length > 0 && apiClient.putScheduleRows) {
          const scheduleObjs = input.schedules.map((s, idx) => (typeof s === "string" ? { id: `sched_${idx + 1}`, cron_expression: s, active: 1 } : s));
          await apiClient.putScheduleRows(target.accountId, token, dbState.uuid, scheduleObjs);
        }

        if (resolvedPlan.cronTriggers.changed && input.cronTriggers) {
          await apiClient.putCronTriggers(target.accountId, token, scriptName, input.cronTriggers);
        }

        await emitStep(
          "workflow_graphs",
          "graph",
          databaseName,
          "hot_apply_graphs",
          "succeeded",
          `Live without redeploy — updated workflow graphs (${nextGraphHash.slice(0, 8)}) in ${databaseName}`,
        );

        if (apiClient.recordDeployState) {
          await apiClient.recordDeployState(target.accountId, token, scriptName, databaseName, {
            buildHash: input.buildHash,
            codeHash: nextCodeHash,
            graphHash: nextGraphHash,
          });
        }

        const newCalls = apiClient.calls.slice(callsBefore);
        const mutatingCallCount = newCalls.filter(isMutatingApiCall).length;

        return {
          target,
          deployId: input.deployId ?? "dep_apply",
          scriptName,
          versionId: existingScript?.versionId ?? `ver_${nextCodeHash.slice(0, 8)}`,
          databaseId: dbState.uuid,
          databaseName,
          url: defaultUrl,
          previewUrl: defaultUrl,
          buildHash: input.buildHash,
          codeHash: nextCodeHash,
          graphHash: nextGraphHash,
          action: "hot_apply_graphs",
          noChanges: false,
          changes: appliedActions.length,
          liveWithoutRedeploy: true,
          rebuiltWorker: false,
          mutatingCallCount,
          appliedActions,
          steps,
          deployedAt: new Date().toISOString(),
        };
      }

      // Full create / update path
      const dbState = existingDbState ?? (await apiClient.ensureDatabase(target.accountId, token, databaseName));
      if (!existingDbState) {
        appliedActions.push({
          kind: "d1_database",
          name: databaseName,
          action: "create",
          summary: `Created D1 database ${databaseName}`,
        });
        await emitStep("d1_database", "d1_database", databaseName, "create", "succeeded", `Created D1 database ${databaseName}`);
      } else {
        await emitStep("d1_database", "d1_database", databaseName, "unchanged", "skipped", `Reused existing D1 database ${databaseName}`);
      }

      // An existing database gets a Time Travel bookmark before its first pending migration, kept with the deployment so a
      // rollback can restore the data. If the bookmark cannot be taken, the deploy stops here, before any migration runs.
      let preMigrationBookmark: string | undefined;
      if (existingDbState && (input.migrations ?? []).some((mig) => !appliedMigrationNames.has(mig.name))) {
        preMigrationBookmark = await apiClient.getD1Bookmark(target.accountId, token, dbState.uuid);
        await input.onPreMigrationBookmark?.({ databaseId: dbState.uuid, bookmark: preMigrationBookmark });
      }
      for (const mig of input.migrations ?? []) {
        if (!appliedMigrationNames.has(mig.name)) {
          await apiClient.applyDatabaseMigration(target.accountId, token, dbState.uuid, {
            name: mig.name,
            sql: mig.sql,
            sha256: mig.sha256 ?? `sha256_${mig.name}`,
          });
          appliedActions.push({
            kind: "d1_migration",
            name: mig.name,
            action: "create",
            summary: `Applied D1 migration ${mig.name}`,
          });
          await emitStep("d1_migrations", "d1_migration", mig.name, "create", "succeeded", `Applied D1 migration ${mig.name}`);
        }
      }

      const existingQueueSet = new Set(existingQueuesFromApi ?? []);
      for (const q of input.queues ?? []) {
        if (!existingQueueSet.has(q)) {
          await apiClient.ensureQueue(target.accountId, token, q);
          appliedActions.push({
            kind: "queue",
            name: q,
            action: "create",
            summary: `Ensured Queue ${q}`,
          });
          await emitStep("queues", "queue", q, "create", "succeeded", `Ensured Queue ${q}`);
        }
      }

      let versionId = existingScript?.versionId ?? "";
      let url = defaultUrl;
      const scriptChanged = !existingScript || (existingScript.codeHash ?? existingScript.sha256) !== nextCodeHash;

      if (scriptChanged) {
        const uploaded = await apiClient.putScript(target.accountId, token, scriptName, {
          code: input.bundle.code,
          sha256: nextCodeHash,
          cronTriggers: input.cronTriggers,
          databaseId: dbState.uuid,
          ...(input.workerBindings ? { deployBindings: input.workerBindings } : {}),
          ...(input.compatibilityFlags && input.compatibilityFlags.length > 0 ? { compatibilityFlags: input.compatibilityFlags } : {}),
        });
        versionId = uploaded.versionId;
        url = uploaded.url;
        const scriptAction = existingScript ? "update" : "create";
        appliedActions.push({
          kind: "worker_script",
          name: scriptName,
          action: scriptAction,
          summary: `Uploaded Worker ${scriptName} (${versionId})`,
        });
        await emitStep("worker_bundle", "worker_script", scriptName, scriptAction, "succeeded", `Uploaded Worker ${scriptName} (${versionId})`);
      } else {
        await emitStep("worker_bundle", "worker_script", scriptName, "unchanged", "skipped", `Worker script ${scriptName} unchanged (${versionId})`);
      }

      if (input.cronTriggers && input.cronTriggers.length > 0 && (resolvedPlan.cronTriggers.changed || !existingScript)) {
        await apiClient.putCronTriggers(target.accountId, token, scriptName, input.cronTriggers);
        await emitStep(
          "cron_triggers",
          "cron_trigger",
          scriptName,
          "update",
          "succeeded",
          `Configured ${input.cronTriggers.length} Cron Trigger(s) on ${scriptName}`,
        );
      }

      const existingWfMap = new Map((existingWorkflowsFromApi ?? []).map((w) => [w.workflowName, w.className]));
      for (const wf of input.workflows ?? []) {
        if (existingWfMap.get(wf.name) !== wf.className || scriptChanged) {
          await apiClient.putWorkflow(target.accountId, token, wf.name, {
            className: wf.className,
            scriptName,
          });
        }
      }

      const graphChanged = (existingDbState?.graphHash ?? existingScript?.graphHash ?? null) !== nextGraphHash;
      const graphEntries = Object.entries(input.graphs ?? {});
      if (graphEntries.length > 0 && (graphChanged || !existingDbState)) {
        for (const [graphId, graphJson] of graphEntries) {
          await apiClient.putStoredGraph(target.accountId, token, dbState.uuid, APP_WORKSPACE, graphId, graphJson);
          appliedActions.push({
            kind: "graph",
            name: graphId,
            action: existingDbState ? "update" : "create",
            summary: `Stored workflow graph ${graphId} in D1 ${databaseName}`,
          });
        }
        await emitStep(
          "workflow_graphs",
          "graph",
          databaseName,
          existingDbState ? "update" : "create",
          "succeeded",
          `Stored ${graphEntries.length} workflow graph(s) in D1 ${databaseName}`,
        );
      }

      if (input.schedules && input.schedules.length > 0 && apiClient.putScheduleRows && (graphChanged || !existingDbState)) {
        const scheduleObjs = input.schedules.map((s, idx) => (typeof s === "string" ? { id: `sched_${idx + 1}`, cron_expression: s, active: 1 } : s));
        await apiClient.putScheduleRows(target.accountId, token, dbState.uuid, scheduleObjs);
      }

      const existingSecrets = new Set(existingScript?.secrets ?? []);
      for (const [secName, secVal] of Object.entries(input.secrets ?? {})) {
        if (!existingSecrets.has(secName)) {
          await apiClient.putScriptSecret(target.accountId, token, scriptName, secName, secVal);
          appliedActions.push({
            kind: "secret",
            name: secName,
            action: "update",
            summary: `Bound secret ${secName} on ${scriptName}`,
          });
        }
      }

      if (apiClient.recordDeployState) {
        await apiClient.recordDeployState(target.accountId, token, scriptName, databaseName, {
          buildHash: input.buildHash,
          codeHash: nextCodeHash,
          graphHash: nextGraphHash,
        });
      }

      const newCalls = apiClient.calls.slice(callsBefore);
      const mutatingCallCount = newCalls.filter(isMutatingApiCall).length;

      return {
        target,
        deployId: input.deployId ?? "dep_apply",
        scriptName,
        versionId,
        databaseId: dbState.uuid,
        databaseName,
        url,
        previewUrl: url,
        buildHash: input.buildHash,
        codeHash: nextCodeHash,
        graphHash: nextGraphHash,
        // a plan that said noop or graph-only while the Worker is missing in the account was carried out in full
        action:
          (!existingScript || !accountCodeMatches) && (resolvedPlan.action === "noop" || resolvedPlan.action === "hot_apply_graphs")
            ? existingScript || existingDbState
              ? "update"
              : "create"
            : resolvedPlan.action,
        noChanges: appliedActions.length === 0,
        changes: appliedActions.length,
        liveWithoutRedeploy: false,
        rebuiltWorker: scriptChanged,
        mutatingCallCount,
        appliedActions,
        steps,
        ...(preMigrationBookmark ? { preMigrationBookmark } : {}),
        deployedAt: new Date().toISOString(),
      };
    },

    async putGraph(
      inputOrTargetOrGraphs: ProvisionerPutGraphInput | DeployTarget | Record<string, string> | Array<{ id: string; [key: string]: unknown }>,
      graphsOrTarget?: Record<string, string> | Array<{ id: string; [key: string]: unknown }> | DeployTarget,
      schedulesArg?: Array<Record<string, unknown> | string>,
      optionsArg?: {
        project?: string;
        actor?: string;
        deployId?: string;
        graphHash?: string;
        cronTriggers?: string[];
      },
    ): Promise<ProvisionerPutGraphResult> {
      const normalized = normalizePutGraphCallArguments(inputOrTargetOrGraphs, graphsOrTarget, schedulesArg, optionsArg);

      const { target, token } = await resolveTargetToken(normalized.target, {
        actor: normalized.actor ?? "studio_hot_apply",
        deployId: normalized.deployId ?? "dep_hot_apply",
        action: "putGraph",
      });
      const { scriptName, databaseName } = deriveEnvironmentResourceNames(normalized.project ?? "project", target.envName);
      const existingDb = apiClient.getDatabase ? await apiClient.getDatabase(target.accountId, token, databaseName) : null;
      const dbState = existingDb ?? (await apiClient.ensureDatabase(target.accountId, token, databaseName));

      const graphMap: Record<string, string> =
        normalized.graphs && Object.keys(normalized.graphs).length > 0
          ? normalized.graphs
          : {
              [normalized.graphId ?? "wf_default"]: normalized.graphJson ?? "{}",
            };

      let updatedAt = new Date().toISOString();
      const graphIds: string[] = [];
      for (const [gId, gJson] of Object.entries(graphMap)) {
        const stored = await apiClient.putStoredGraph(target.accountId, token, dbState.uuid, APP_WORKSPACE, gId, gJson);
        updatedAt = stored.updatedAt;
        graphIds.push(gId);
      }

      let schedulesUpdatedCount = 0;
      if (normalized.schedules && normalized.schedules.length > 0 && apiClient.putScheduleRows) {
        const scheduleObjs = normalized.schedules.map((s, idx) => (typeof s === "string" ? { id: `sched_${idx + 1}`, cron_expression: s, active: 1 } : s));
        const schedRes = await apiClient.putScheduleRows(target.accountId, token, dbState.uuid, scheduleObjs);
        schedulesUpdatedCount = schedRes.count;
      }

      if (normalized.cronTriggers) {
        await apiClient.putCronTriggers(target.accountId, token, scriptName, normalized.cronTriggers);
      }

      const existingScript = await apiClient.getScript(target.accountId, token, scriptName);

      if (apiClient.recordDeployState && normalized.graphHash) {
        await apiClient.recordDeployState(target.accountId, token, scriptName, databaseName, {
          graphHash: normalized.graphHash,
        });
      }

      return {
        target,
        deployId: normalized.deployId ?? "dep_hot_apply",
        scriptName,
        databaseId: dbState.uuid,
        graphId: graphIds[0] ?? normalized.graphId ?? "wf_default",
        graphIds,
        graphHash: normalized.graphHash ?? "sha256_graph",
        workerVersionId: existingScript?.versionId ?? null,
        rebuiltWorker: false,
        liveWithoutRedeploy: true,
        schedulesUpdatedCount,
        updatedAt,
      };
    },

    async putSecret(
      inputOrTarget: ProvisionerPutSecretInput | DeployTarget,
      secretNameArg?: string,
      secretValueArg?: string,
      optionsArg?: {
        project?: string;
        actor?: string;
        deployId?: string;
      },
    ): Promise<ProvisionerPutSecretResult> {
      const input = normalizePutSecretCallArguments(inputOrTarget, secretNameArg, secretValueArg, optionsArg);
      const { target, token } = await resolveTargetToken(input.target, {
        actor: input.actor,
        deployId: input.deployId,
        action: "putSecret",
      });
      const { scriptName } = deriveEnvironmentResourceNames(input.project, target.envName);
      await apiClient.putScriptSecret(target.accountId, token, scriptName, input.secretName, input.secretValue);
      return {
        target,
        scriptName,
        secretName: input.secretName,
        updatedAt: new Date().toISOString(),
      };
    },

    async promote(input: ProvisionerPromoteInput): Promise<ProvisionerPromoteResult> {
      const sourceTarget = DeployTargetSchema.parse(input.sourceTarget);
      const destinationTarget = DeployTargetSchema.parse(input.destinationTarget);
      const applied = await this.apply({
        target: destinationTarget,
        project: input.project,
        actor: input.actor,
        deployId: input.deployId,
        buildHash: input.buildHash,
        graphHash: input.graphHash,
        bundle: input.bundle,
        migrations: input.migrations,
        queues: input.queues,
        cronTriggers: input.cronTriggers,
        workflows: input.workflows,
        graphs: input.graphs,
        ...(input.workerBindings ? { workerBindings: input.workerBindings } : {}),
        ...(input.compatibilityFlags ? { compatibilityFlags: input.compatibilityFlags } : {}),
        _actionOverride: "promote",
      } as ProvisionerApplyInput);
      return {
        ...applied,
        promotedFromEnv: sourceTarget.envName ?? "preview",
        reusedArtifactBuildHash: input.buildHash,
      };
    },

    async destroy(
      inputOrTarget: ProvisionerDestroyInput | DeployTarget,
      optionsArg?: {
        project?: string;
        actor?: string;
        deployId?: string;
      },
    ): Promise<ProvisionerDestroyResult> {
      const input = normalizeDestroyCallArguments(inputOrTarget, optionsArg);
      const { target, token } = await resolveTargetToken(input.target, {
        actor: input.actor,
        deployId: input.deployId,
        action: "destroy",
      });
      const { scriptName, databaseName } = deriveEnvironmentResourceNames(input.project, target.envName);
      await apiClient.deleteScript(target.accountId, token, scriptName);
      await apiClient.deleteDatabase(target.accountId, token, databaseName);
      return {
        target,
        scriptName,
        databaseName,
        removedResources: [scriptName, databaseName],
        destroyedAt: new Date().toISOString(),
      };
    },
  };
}

export interface HostedSandboxProvisionerOptions {
  platform?: SandboxDispatchPlatform;
  byocProvisioner?: DeployProvisioner;
  now?: () => number;
}

export type HostedSandboxProvisioner = DeployProvisioner;

export function createHostedSandboxProvisioner(options?: HostedSandboxProvisionerOptions): DeployProvisioner {
  const platform = options?.platform ?? defaultSandboxDispatchPlatform;
  if (options?.now) {
    platform.setNow(options.now);
  }

  function toExistingScriptState(record: SandboxWorkerRecord | null): CloudflareWorkerScriptState | null {
    if (!record || !record.buildHash) {
      return null;
    }
    return {
      scriptName: record.sandboxId,
      versionId: record.versionId,
      sha256: record.codeHash,
      buildHash: record.buildHash,
      codeHash: record.codeHash,
      graphHash: record.graphHash,
      code: record.code,
      bindings: [
        { type: "d1", name: "DB", databaseName: record.databaseName },
        { type: "secret_text", name: "PX_CONN_KEY" },
        { type: "secret_text", name: "PX_EVENTS_HMAC_KEY" },
      ],
      cronTriggers: [...record.cronTriggers],
      secrets: Object.keys(record.secrets),
      updatedAt: record.updatedAt,
    };
  }

  return {
    async plan(
      inputOrTargetOrArtifact: ProvisionerPlanInput | DeployTarget | DeployBuildArtifactInput,
      buildArtifactOrTarget?: DeployBuildArtifactInput | DeployTarget,
      envStateArg?: DeployPlanEnvironmentState,
    ): Promise<ProvisionerPlanResult> {
      const normalizedInput = normalizePlanCallArguments(inputOrTargetOrArtifact, buildArtifactOrTarget, envStateArg);
      const target = PlatformSandboxDeployTargetSchema.parse(normalizedInput.target);
      const { scriptName, databaseName } = deriveEnvironmentResourceNames(normalizedInput.project || target.projectId || "project", target);

      const existingRecord = platform.getWorker(target.dispatchNamespace, target.sandboxId);
      const existingDb = platform.getDatabase(target.sandboxId);
      const existingScript = toExistingScriptState(existingRecord);
      const envState = normalizedInput.envState;
      const dbExists = envState?.databaseExists !== undefined ? envState.databaseExists : Boolean(existingDb) || Boolean(existingRecord?.buildHash);

      const appliedMigrationNames = new Set<string>([...(existingDb?.appliedMigrations.map((m) => m.name) ?? []), ...(envState?.appliedMigrations ?? [])]);

      return computeDeployPlanFromResolvedState({
        target,
        scriptName,
        databaseName,
        input: {
          ...normalizedInput,
          target,
          project: normalizedInput.project || target.projectId || "project",
          envState: {
            ...envState,
            currentGraphHash: envState?.currentGraphHash ?? envState?.graphHash ?? existingDb?.graphHash ?? existingRecord?.graphHash ?? null,
            existingQueues: envState?.existingQueues ?? envState?.queues ?? existingRecord?.queues,
            existingWorkflows:
              envState?.existingWorkflows ??
              envState?.workflows ??
              existingRecord?.workflows.map((wf) => ({
                workflowName: wf.name,
                className: wf.className,
              })),
          },
        },
        existingScript,
        dbExists,
        appliedMigrationNames,
      });
    },

    async apply(
      inputOrTargetOrArtifact: ProvisionerApplyInput | DeployTarget | DeployBuildArtifactInput,
      planOrArtifactOrTarget?: DeployPlan | DeployBuildArtifactInput | DeployTarget,
      artifactArg?: DeployBuildArtifactInput,
      optionsArg?: {
        actor?: string;
        deployId?: string;
        onStep?: (step: ProvisionerDeploymentStep) => void | Promise<void>;
      },
    ): Promise<ProvisionerApplyResult> {
      const input = normalizeApplyCallArguments(inputOrTargetOrArtifact, planOrArtifactOrTarget, artifactArg, optionsArg);
      const target = PlatformSandboxDeployTargetSchema.parse(input.target);
      const { scriptName, databaseName } = deriveEnvironmentResourceNames(input.project || target.projectId || "project", target);

      // Guardrail: reject live payment credentials in sandbox secrets
      for (const [secName, secVal] of Object.entries(input.secrets ?? {})) {
        assertNoLivePaymentCredential(secName, secVal);
      }

      const existingRecord = platform.getWorker(target.dispatchNamespace, target.sandboxId);
      const existingDb = platform.getDatabase(target.sandboxId);
      const existingScript = toExistingScriptState(existingRecord);
      const hadExistingDatabase = Boolean(existingDb);
      const appliedMigrationNames = new Set<string>([
        ...(existingDb?.appliedMigrations.map((m) => m.name) ?? []),
        ...(input.envState?.appliedMigrations ?? []),
      ]);

      const resolvedPlan = computeDeployPlanFromResolvedState({
        target,
        scriptName,
        databaseName,
        input: {
          ...input,
          target,
          project: input.project || target.projectId || "project",
          envState: {
            ...input.envState,
            currentGraphHash: input.envState?.currentGraphHash ?? input.envState?.graphHash ?? existingDb?.graphHash ?? existingRecord?.graphHash ?? null,
            existingQueues: input.envState?.existingQueues ?? input.envState?.queues ?? existingRecord?.queues,
            existingWorkflows:
              input.envState?.existingWorkflows ??
              input.envState?.workflows ??
              existingRecord?.workflows.map((wf) => ({
                workflowName: wf.name,
                className: wf.className,
              })),
          },
        },
        existingScript,
        dbExists: hadExistingDatabase || Boolean(input.envState?.databaseExists),
        appliedMigrationNames,
      });

      const appliedActions: ProvisionerResourceAction[] = [];
      const steps: ProvisionerDeploymentStep[] = [];
      let stepOrder = 1;
      const emitStep = async (
        stepName: string,
        resourceKind: ProvisionerResourceAction["kind"],
        resourceName: string,
        action: ProvisionerDeploymentStep["action"],
        status: "succeeded" | "skipped",
        summary: string,
      ) => {
        const step: ProvisionerDeploymentStep = {
          stepOrder: stepOrder++,
          stepName,
          resourceKind,
          resourceName,
          action,
          status,
          summary,
          timestamp: new Date().toISOString(),
        };
        steps.push(step);
        if (input.onStep) {
          await input.onStep(step);
        }
      };

      const nextCodeHash = input.codeHash ?? input.bundle.sha256;
      const nextGraphHash = input.graphHash ?? input.bundle.sha256.slice(0, 12);
      const previewUrl = `https://${target.sandboxId}.sandbox.projectx.dev`;

      if (resolvedPlan.action === "noop" && existingRecord) {
        await emitStep(
          "d1_database",
          "d1_database",
          databaseName,
          "noop",
          "skipped",
          `No changes — sandbox ${target.sandboxId} already at build ${input.buildHash.slice(0, 12)}`,
        );
        return {
          target,
          deployId: input.deployId ?? "dep_sandbox_apply",
          scriptName,
          versionId: existingRecord.versionId,
          databaseId: existingRecord.databaseId,
          databaseName,
          url: previewUrl,
          previewUrl,
          buildHash: input.buildHash,
          codeHash: nextCodeHash,
          graphHash: nextGraphHash,
          action: "noop",
          noChanges: true,
          changes: 0,
          liveWithoutRedeploy: false,
          rebuiltWorker: false,
          mutatingCallCount: 0,
          appliedActions: [],
          steps,
          bindings: {
            DB: databaseName,
            PX_CONN_KEY: existingRecord.pxConnKey,
            PX_EVENTS_HMAC_KEY: existingRecord.telemetryHmacKey,
            DISPATCH_NAMESPACE: target.dispatchNamespace,
          },
          deployedAt: new Date().toISOString(),
        };
      }

      if (resolvedPlan.action === "hot_apply_graphs" && existingRecord) {
        const graphEntries = Object.entries(input.graphs ?? {});
        if (graphEntries.length > 0) {
          for (const [graphId, graphJson] of graphEntries) {
            await platform.putStoredGraph(target.sandboxId, APP_WORKSPACE, graphId, graphJson, nextGraphHash);
            appliedActions.push({
              kind: "graph",
              name: graphId,
              action: "update",
              summary: `Hot-applied workflow graph ${graphId} to sandbox D1 ${databaseName}`,
            });
          }
        } else {
          await platform.putStoredGraph(target.sandboxId, APP_WORKSPACE, "__workflows__", JSON.stringify({ graphHash: nextGraphHash }), nextGraphHash);
          appliedActions.push({
            kind: "graph",
            name: databaseName,
            action: "update",
            summary: `Hot-applied workflow graphs (${nextGraphHash.slice(0, 8)}) to sandbox D1 ${databaseName}`,
          });
        }

        if (input.schedules && input.schedules.length > 0) {
          const scheduleObjs = input.schedules.map((s, idx) => (typeof s === "string" ? { id: `sched_${idx + 1}`, cron_expression: s, active: 1 } : s));
          await platform.putScheduleRows(target.sandboxId, scheduleObjs);
        }

        existingRecord.buildHash = input.buildHash;
        existingRecord.graphHash = nextGraphHash;

        await emitStep(
          "workflow_graphs",
          "graph",
          databaseName,
          "hot_apply_graphs",
          "succeeded",
          `Live without redeploy — updated workflow graphs (${nextGraphHash.slice(0, 8)}) in ${databaseName}`,
        );

        return {
          target,
          deployId: input.deployId ?? "dep_sandbox_apply",
          scriptName,
          versionId: existingRecord.versionId,
          databaseId: existingRecord.databaseId,
          databaseName,
          url: previewUrl,
          previewUrl,
          buildHash: input.buildHash,
          codeHash: nextCodeHash,
          graphHash: nextGraphHash,
          action: "hot_apply_graphs",
          noChanges: false,
          changes: appliedActions.length,
          liveWithoutRedeploy: true,
          rebuiltWorker: false,
          mutatingCallCount: appliedActions.length,
          appliedActions,
          steps,
          bindings: {
            DB: databaseName,
            PX_CONN_KEY: existingRecord.pxConnKey,
            PX_EVENTS_HMAC_KEY: existingRecord.telemetryHmacKey,
            DISPATCH_NAMESPACE: target.dispatchNamespace,
          },
          deployedAt: new Date().toISOString(),
        };
      }

      const dbRecord = await platform.ensureDatabase(target.sandboxId);

      if (!hadExistingDatabase) {
        appliedActions.push({
          kind: "d1_database",
          name: databaseName,
          action: "create",
          summary: `Created isolated sandbox D1 database ${databaseName}`,
        });
        await emitStep("d1_database", "d1_database", databaseName, "create", "succeeded", `Created isolated sandbox D1 database ${databaseName}`);
      } else {
        await emitStep("d1_database", "d1_database", databaseName, "unchanged", "skipped", `Reused isolated sandbox D1 database ${databaseName}`);
      }

      for (const mig of input.migrations ?? []) {
        if (!appliedMigrationNames.has(mig.name)) {
          await platform.applyMigration(target.sandboxId, {
            name: mig.name,
            sql: mig.sql,
            sha256: mig.sha256 ?? `sha256_${mig.name}`,
          });
          appliedActions.push({
            kind: "d1_migration",
            name: mig.name,
            action: "create",
            summary: `Applied D1 migration ${mig.name} on ${databaseName}`,
          });
          await emitStep("d1_migrations", "d1_migration", mig.name, "create", "succeeded", `Applied D1 migration ${mig.name} on ${databaseName}`);
        }
      }

      const existingQueueSet = new Set(existingRecord?.queues ?? []);
      for (const q of input.queues ?? []) {
        if (!existingQueueSet.has(q)) {
          appliedActions.push({
            kind: "queue",
            name: q,
            action: "create",
            summary: `Ensured sandbox Queue ${q}`,
          });
          await emitStep("queues", "queue", q, "create", "succeeded", `Ensured sandbox Queue ${q}`);
        }
      }

      const scriptChanged = !existingScript || (existingScript.codeHash ?? existingScript.sha256) !== nextCodeHash;

      let record: SandboxWorkerRecord;
      if (scriptChanged || !existingRecord) {
        record = await platform.putWorker({
          sandboxId: target.sandboxId,
          dispatchNamespace: target.dispatchNamespace,
          projectId: target.projectId ?? input.project ?? "project",
          code: input.bundle.code,
          buildHash: input.buildHash,
          codeHash: nextCodeHash,
          graphHash: nextGraphHash,
          cronTriggers: input.cronTriggers,
          queues: input.queues,
          workflows: input.workflows,
        });
        const scriptAction = existingScript ? "update" : "create";
        appliedActions.push({
          kind: "worker_script",
          name: scriptName,
          action: scriptAction,
          summary: `Uploaded sandbox Worker ${scriptName} to dispatch namespace ${target.dispatchNamespace} (${record.versionId})`,
        });
        await emitStep(
          "worker_bundle",
          "worker_script",
          scriptName,
          scriptAction,
          "succeeded",
          `Uploaded sandbox Worker ${scriptName} to dispatch namespace ${target.dispatchNamespace} (${record.versionId})`,
        );
      } else {
        record = existingRecord;
        record.buildHash = input.buildHash;
        record.codeHash = nextCodeHash;
        record.graphHash = nextGraphHash;
        await emitStep("worker_bundle", "worker_script", scriptName, "unchanged", "skipped", `Sandbox Worker ${scriptName} unchanged (${record.versionId})`);
      }

      const graphChanged = (existingDb?.graphHash ?? existingRecord?.graphHash ?? null) !== nextGraphHash;
      const graphEntries = Object.entries(input.graphs ?? {});
      if (graphEntries.length > 0 && (graphChanged || !hadExistingDatabase)) {
        for (const [graphId, graphJson] of graphEntries) {
          await platform.putStoredGraph(target.sandboxId, APP_WORKSPACE, graphId, graphJson, nextGraphHash);
          appliedActions.push({
            kind: "graph",
            name: graphId,
            action: hadExistingDatabase ? "update" : "create",
            summary: `Stored workflow graph ${graphId} in sandbox D1 ${databaseName}`,
          });
        }
        await emitStep(
          "workflow_graphs",
          "graph",
          databaseName,
          hadExistingDatabase ? "update" : "create",
          "succeeded",
          `Stored ${graphEntries.length} workflow graph(s) in sandbox D1 ${databaseName}`,
        );
      } else if (graphChanged && graphEntries.length === 0) {
        dbRecord.graphHash = nextGraphHash;
      }

      if (input.schedules && input.schedules.length > 0 && (graphChanged || !hadExistingDatabase)) {
        const scheduleObjs = input.schedules.map((s, idx) => (typeof s === "string" ? { id: `sched_${idx + 1}`, cron_expression: s, active: 1 } : s));
        await platform.putScheduleRows(target.sandboxId, scheduleObjs);
      }

      const existingSecrets = new Set(Object.keys(existingRecord?.secrets ?? {}));
      for (const [secName, secVal] of Object.entries(input.secrets ?? {})) {
        if (!existingSecrets.has(secName)) {
          platform.putSecret(target.dispatchNamespace, target.sandboxId, secName, secVal);
          appliedActions.push({
            kind: "secret",
            name: secName,
            action: "update",
            summary: `Bound secret ${secName} on sandbox ${scriptName}`,
          });
        }
      }

      return {
        target,
        deployId: input.deployId ?? "dep_sandbox_apply",
        scriptName,
        versionId: record.versionId,
        databaseId: dbRecord.uuid,
        databaseName: dbRecord.name,
        url: previewUrl,
        previewUrl,
        buildHash: input.buildHash,
        codeHash: nextCodeHash,
        graphHash: nextGraphHash,
        action: resolvedPlan.action,
        noChanges: appliedActions.length === 0,
        changes: appliedActions.length,
        liveWithoutRedeploy: false,
        rebuiltWorker: scriptChanged,
        mutatingCallCount: appliedActions.length,
        appliedActions,
        steps,
        bindings: {
          DB: dbRecord.name,
          PX_CONN_KEY: record.pxConnKey,
          PX_EVENTS_HMAC_KEY: record.telemetryHmacKey,
          DISPATCH_NAMESPACE: target.dispatchNamespace,
        },
        deployedAt: new Date().toISOString(),
      };
    },

    async putGraph(
      inputOrTargetOrGraphs: ProvisionerPutGraphInput | DeployTarget | Record<string, string> | Array<{ id: string; [key: string]: unknown }>,
      graphsOrTarget?: Record<string, string> | Array<{ id: string; [key: string]: unknown }> | DeployTarget,
      schedulesArg?: Array<Record<string, unknown> | string>,
      optionsArg?: {
        project?: string;
        actor?: string;
        deployId?: string;
        graphHash?: string;
        cronTriggers?: string[];
      },
    ): Promise<ProvisionerPutGraphResult> {
      const normalized = normalizePutGraphCallArguments(inputOrTargetOrGraphs, graphsOrTarget, schedulesArg, optionsArg);
      const target = PlatformSandboxDeployTargetSchema.parse(normalized.target);
      const dbRecord = await platform.ensureDatabase(target.sandboxId);
      const existingWorker = platform.getWorker(target.dispatchNamespace, target.sandboxId);

      const graphMap: Record<string, string> =
        normalized.graphs && Object.keys(normalized.graphs).length > 0
          ? normalized.graphs
          : {
              [normalized.graphId ?? "wf_default"]: normalized.graphJson ?? "{}",
            };

      let updatedAt = new Date().toISOString();
      const graphIds: string[] = [];
      for (const [gId, gJson] of Object.entries(graphMap)) {
        const stored = await platform.putStoredGraph(target.sandboxId, APP_WORKSPACE, gId, gJson, normalized.graphHash);
        updatedAt = stored.updatedAt;
        graphIds.push(gId);
      }

      if (existingWorker && normalized.graphHash) {
        existingWorker.graphHash = normalized.graphHash;
      }

      let schedulesUpdatedCount = 0;
      if (normalized.schedules && normalized.schedules.length > 0) {
        const scheduleObjs = normalized.schedules.map((s, idx) => (typeof s === "string" ? { id: `sched_${idx + 1}`, cron_expression: s, active: 1 } : s));
        const schedRes = await platform.putScheduleRows(target.sandboxId, scheduleObjs);
        schedulesUpdatedCount = schedRes.count;
      }

      return {
        target,
        deployId: normalized.deployId ?? "dep_sandbox_hot_apply",
        scriptName: target.sandboxId,
        databaseId: dbRecord.uuid,
        graphId: graphIds[0] ?? normalized.graphId ?? "wf_default",
        graphIds,
        graphHash: normalized.graphHash ?? dbRecord.graphHash ?? existingWorker?.graphHash ?? "sha256_graph",
        workerVersionId: existingWorker?.versionId ?? null,
        rebuiltWorker: false,
        liveWithoutRedeploy: true,
        schedulesUpdatedCount,
        updatedAt,
      };
    },

    async putSecret(
      inputOrTarget: ProvisionerPutSecretInput | DeployTarget,
      secretNameArg?: string,
      secretValueArg?: string,
      optionsArg?: {
        project?: string;
        actor?: string;
        deployId?: string;
      },
    ): Promise<ProvisionerPutSecretResult> {
      const input = normalizePutSecretCallArguments(inputOrTarget, secretNameArg, secretValueArg, optionsArg);
      const target = PlatformSandboxDeployTargetSchema.parse(input.target);
      const res = platform.putSecret(target.dispatchNamespace, target.sandboxId, input.secretName, input.secretValue);
      return {
        target,
        scriptName: target.sandboxId,
        secretName: input.secretName,
        updatedAt: res.updatedAt,
      };
    },

    async promote(input: ProvisionerPromoteInput): Promise<ProvisionerPromoteResult> {
      const sourceTarget = DeployTargetSchema.parse(input.sourceTarget);
      const destinationTarget = DeployTargetSchema.parse(input.destinationTarget);
      const delegate = destinationTarget.type === "byoc" && options?.byocProvisioner ? options.byocProvisioner : this;
      const applied = await delegate.apply({
        target: destinationTarget,
        project: input.project,
        actor: input.actor,
        deployId: input.deployId,
        buildHash: input.buildHash,
        codeHash: input.codeHash,
        graphHash: input.graphHash,
        bundle: input.bundle,
        migrations: input.migrations,
        queues: input.queues,
        cronTriggers: input.cronTriggers,
        workflows: input.workflows,
        graphs: input.graphs,
        schedules: input.schedules,
        secrets: input.secrets,
      });
      return {
        ...applied,
        promotedFromEnv: sourceTarget.envName ?? "preview",
        reusedArtifactBuildHash: input.buildHash,
      };
    },

    async destroy(
      inputOrTarget: ProvisionerDestroyInput | DeployTarget,
      optionsArg?: {
        project?: string;
        actor?: string;
        deployId?: string;
      },
    ): Promise<ProvisionerDestroyResult> {
      const input = normalizeDestroyCallArguments(inputOrTarget, optionsArg);
      const target = PlatformSandboxDeployTargetSchema.parse(input.target);
      const { scriptName, databaseName } = deriveEnvironmentResourceNames(input.project || target.projectId || "project", target);
      platform.destroySandbox(target.dispatchNamespace, target.sandboxId);
      return {
        target,
        scriptName,
        databaseName,
        removedResources: [scriptName, databaseName],
        destroyedAt: new Date().toISOString(),
      };
    },
  };
}

export class HostedSandboxTarget implements DeployProvisioner {
  readonly platform: SandboxDispatchPlatform;
  private readonly provisioner: DeployProvisioner;

  constructor(options?: HostedSandboxProvisionerOptions) {
    this.platform = options?.platform ?? defaultSandboxDispatchPlatform;
    this.provisioner = createHostedSandboxProvisioner({
      ...options,
      platform: this.platform,
    });
  }

  static create(options?: HostedSandboxProvisionerOptions): HostedSandboxTarget {
    return new HostedSandboxTarget(options);
  }

  plan(
    inputOrTargetOrArtifact: ProvisionerPlanInput | DeployTarget | DeployBuildArtifactInput,
    buildArtifactOrTarget?: DeployBuildArtifactInput | DeployTarget,
    envState?: DeployPlanEnvironmentState,
  ): Promise<ProvisionerPlanResult> {
    return this.provisioner.plan(inputOrTargetOrArtifact, buildArtifactOrTarget, envState);
  }

  apply(
    inputOrTargetOrArtifact: ProvisionerApplyInput | DeployTarget | DeployBuildArtifactInput,
    planOrArtifactOrTarget?: DeployPlan | DeployBuildArtifactInput | DeployTarget,
    artifactArg?: DeployBuildArtifactInput,
    options?: {
      actor?: string;
      deployId?: string;
      onStep?: (step: ProvisionerDeploymentStep) => void | Promise<void>;
    },
  ): Promise<ProvisionerApplyResult> {
    return this.provisioner.apply(inputOrTargetOrArtifact, planOrArtifactOrTarget, artifactArg, options);
  }

  putGraph(
    inputOrTargetOrGraphs: ProvisionerPutGraphInput | DeployTarget | Record<string, string> | Array<{ id: string; [key: string]: unknown }>,
    graphsOrTarget?: Record<string, string> | Array<{ id: string; [key: string]: unknown }> | DeployTarget,
    schedulesArg?: Array<Record<string, unknown> | string>,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
      graphHash?: string;
      cronTriggers?: string[];
    },
  ): Promise<ProvisionerPutGraphResult> {
    return this.provisioner.putGraph(inputOrTargetOrGraphs, graphsOrTarget, schedulesArg, options);
  }

  putSecret(
    inputOrTarget: ProvisionerPutSecretInput | DeployTarget,
    secretName?: string,
    secretValue?: string,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
    },
  ): Promise<ProvisionerPutSecretResult> {
    return this.provisioner.putSecret(inputOrTarget, secretName, secretValue, options);
  }

  promote(input: ProvisionerPromoteInput): Promise<ProvisionerPromoteResult> {
    return this.provisioner.promote(input);
  }

  destroy(
    inputOrTarget: ProvisionerDestroyInput | DeployTarget,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
    },
  ): Promise<ProvisionerDestroyResult> {
    return this.provisioner.destroy(inputOrTarget, options);
  }

  private static readonly defaultInstance = new HostedSandboxTarget();

  static plan(
    inputOrTargetOrArtifact: ProvisionerPlanInput | DeployTarget | DeployBuildArtifactInput,
    buildArtifactOrTarget?: DeployBuildArtifactInput | DeployTarget,
    envState?: DeployPlanEnvironmentState,
  ): Promise<ProvisionerPlanResult> {
    return HostedSandboxTarget.defaultInstance.plan(inputOrTargetOrArtifact, buildArtifactOrTarget, envState);
  }

  static apply(
    inputOrTargetOrArtifact: ProvisionerApplyInput | DeployTarget | DeployBuildArtifactInput,
    planOrArtifactOrTarget?: DeployPlan | DeployBuildArtifactInput | DeployTarget,
    artifactArg?: DeployBuildArtifactInput,
    options?: {
      actor?: string;
      deployId?: string;
      onStep?: (step: ProvisionerDeploymentStep) => void | Promise<void>;
    },
  ): Promise<ProvisionerApplyResult> {
    return HostedSandboxTarget.defaultInstance.apply(inputOrTargetOrArtifact, planOrArtifactOrTarget, artifactArg, options);
  }

  static putGraph(
    inputOrTargetOrGraphs: ProvisionerPutGraphInput | DeployTarget | Record<string, string> | Array<{ id: string; [key: string]: unknown }>,
    graphsOrTarget?: Record<string, string> | Array<{ id: string; [key: string]: unknown }> | DeployTarget,
    schedulesArg?: Array<Record<string, unknown> | string>,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
      graphHash?: string;
      cronTriggers?: string[];
    },
  ): Promise<ProvisionerPutGraphResult> {
    return HostedSandboxTarget.defaultInstance.putGraph(inputOrTargetOrGraphs, graphsOrTarget, schedulesArg, options);
  }

  static putSecret(
    inputOrTarget: ProvisionerPutSecretInput | DeployTarget,
    secretName?: string,
    secretValue?: string,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
    },
  ): Promise<ProvisionerPutSecretResult> {
    return HostedSandboxTarget.defaultInstance.putSecret(inputOrTarget, secretName, secretValue, options);
  }

  static promote(input: ProvisionerPromoteInput): Promise<ProvisionerPromoteResult> {
    return HostedSandboxTarget.defaultInstance.promote(input);
  }

  static destroy(
    inputOrTarget: ProvisionerDestroyInput | DeployTarget,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
    },
  ): Promise<ProvisionerDestroyResult> {
    return HostedSandboxTarget.defaultInstance.destroy(inputOrTarget, options);
  }
}

export class ByocCloudflareTarget implements DeployProvisioner {
  readonly apiClient: CloudflareApiClient;
  private readonly provisioner: DeployProvisioner;

  constructor(options?: { apiClient?: CloudflareApiClient; resolveToken?: TokenResolver }) {
    const mock = new MockCloudflareControlPlane();
    this.apiClient = options?.apiClient ?? mock;
    const defaultResolver: TokenResolver = async (tokenRef) => {
      return `cf_scoped_token_for_${tokenRef}`;
    };
    this.provisioner = createByocProvisioner({
      apiClient: this.apiClient,
      resolveToken: options?.resolveToken ?? defaultResolver,
    });
  }

  static create(options?: { apiClient?: CloudflareApiClient; resolveToken?: TokenResolver }): ByocCloudflareTarget {
    return new ByocCloudflareTarget(options);
  }

  plan(
    inputOrTargetOrArtifact: ProvisionerPlanInput | DeployTarget | DeployBuildArtifactInput,
    buildArtifactOrTarget?: DeployBuildArtifactInput | DeployTarget,
    envState?: DeployPlanEnvironmentState,
  ): Promise<ProvisionerPlanResult> {
    return this.provisioner.plan(inputOrTargetOrArtifact, buildArtifactOrTarget, envState);
  }

  apply(
    inputOrTargetOrArtifact: ProvisionerApplyInput | DeployTarget | DeployBuildArtifactInput,
    planOrArtifactOrTarget?: DeployPlan | DeployBuildArtifactInput | DeployTarget,
    artifactArg?: DeployBuildArtifactInput,
    options?: {
      actor?: string;
      deployId?: string;
      onStep?: (step: ProvisionerDeploymentStep) => void | Promise<void>;
    },
  ): Promise<ProvisionerApplyResult> {
    return this.provisioner.apply(inputOrTargetOrArtifact, planOrArtifactOrTarget, artifactArg, options);
  }

  putGraph(
    inputOrTargetOrGraphs: ProvisionerPutGraphInput | DeployTarget | Record<string, string> | Array<{ id: string; [key: string]: unknown }>,
    graphsOrTarget?: Record<string, string> | Array<{ id: string; [key: string]: unknown }> | DeployTarget,
    schedulesArg?: Array<Record<string, unknown> | string>,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
      graphHash?: string;
      cronTriggers?: string[];
    },
  ): Promise<ProvisionerPutGraphResult> {
    return this.provisioner.putGraph(inputOrTargetOrGraphs, graphsOrTarget, schedulesArg, options);
  }

  putSecret(
    inputOrTarget: ProvisionerPutSecretInput | DeployTarget,
    secretName?: string,
    secretValue?: string,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
    },
  ): Promise<ProvisionerPutSecretResult> {
    return this.provisioner.putSecret(inputOrTarget, secretName, secretValue, options);
  }

  promote(input: ProvisionerPromoteInput): Promise<ProvisionerPromoteResult> {
    return this.provisioner.promote(input);
  }

  destroy(
    inputOrTarget: ProvisionerDestroyInput | DeployTarget,
    options?: {
      project?: string;
      actor?: string;
      deployId?: string;
    },
  ): Promise<ProvisionerDestroyResult> {
    return this.provisioner.destroy(inputOrTarget, options);
  }
}

const PERMISSION_META: ReadonlyArray<{
  id: CloudflarePermissionId;
  label: CloudflarePermissionScope;
  missingDiagnostic: string;
}> = [
  {
    id: "account_settings_read",
    label: "Account Settings: Read",
    missingDiagnostic: "Account Settings: Read missing ✕ — required to confirm your Cloudflare account ID and name.",
  },
  {
    id: "workers_scripts_edit",
    label: "Workers Scripts: Edit",
    missingDiagnostic: "Workers Scripts: Edit missing ✕ — required to upload and update your Worker scripts and bindings.",
  },
  {
    id: "d1_edit",
    label: "D1: Edit",
    missingDiagnostic: "D1: Edit missing ✕ — required to provision your D1 databases and apply SQL migrations.",
  },
  {
    id: "queues_edit",
    label: "Queues: Edit",
    missingDiagnostic: "Queues: Edit missing ✕ — required to create and bind Cloudflare Queues for workflows.",
  },
];

/**
 * The report for a token Studio already knows is not usable (revoked in Studio, or refused by Cloudflare), made without
 * sending anything anywhere.
 */
export function inactiveTokenReport(
  status: "disabled" | "expired" | "invalid",
  summaryMessage = "Token is invalid or expired — Reconnect",
): CloudflareTokenVerificationReport {
  const remediationUrl = CLOUDFLARE_SCOPED_TOKEN_TEMPLATE_URL;
  const permissions: CloudflarePermissionReportItem[] = PERMISSION_META.map((meta) => ({
    id: meta.id,
    label: meta.label,
    required: true,
    granted: false,
    remediationUrl,
    plainError: summaryMessage,
  }));
  return {
    ok: false,
    status,
    isGlobalApiKey: false,
    permissions,
    missingPermissionIds: permissions.map((p) => p.id),
    missingPermissionLabels: permissions.map((p) => p.label),
    remediationUrl,
    summaryMessage,
  };
}

/**
 * Verifies a deploy token. With the HTTP client (createHttpCloudflareApiClient) this asks Cloudflare: GET
 * /accounts/{id}/tokens/verify, then the token's permission groups, or a harmless read per capability when the token may not
 * read its own policies. With the fake (MockCloudflareControlPlane) it answers from the fake's registry, or, for a fake with no
 * registered token, from the token's spelling (tests only). A client is required: there is no verification without one.
 */
export async function verifyCloudflareToken(
  token: string,
  requestedAccountId?: string,
  clientOrOptions?: CloudflareApiClient | { client?: CloudflareApiClient },
): Promise<CloudflareTokenVerificationReport> {
  const apiClient: CloudflareApiClient | undefined =
    clientOrOptions && "verifyTokenAndPermissions" in clientOrOptions
      ? clientOrOptions
      : (clientOrOptions as { client?: CloudflareApiClient } | undefined)?.client;
  if (!apiClient) {
    throw new Error(
      "verifyCloudflareToken needs a Cloudflare client: the HTTP client in production, the fake in tests. A token is never judged by its spelling outside the fake.",
    );
  }
  const trimmedToken = token.trim();
  const remediationUrl = CLOUDFLARE_SCOPED_TOKEN_TEMPLATE_URL;

  const normalizedRequestedAccount = requestedAccountId && requestedAccountId.trim().length > 0 ? requestedAccountId.trim().toLowerCase() : undefined;

  let resolvedEntry: RegisteredMockToken | undefined;

  if (apiClient instanceof MockCloudflareControlPlane) {
    resolvedEntry = apiClient.getRegisteredToken(trimmedToken);
    if (!resolvedEntry && !apiClient.hasRegisteredTokens()) {
      const synth = synthesizeDeterministicTokenEntry(trimmedToken, normalizedRequestedAccount);
      if (synth) {
        resolvedEntry = synth;
      }
    }
    const targetAcct = normalizedRequestedAccount ?? resolvedEntry?.accountId ?? "00000000000000000000000000000000";
    await apiClient.verifyTokenAndPermissions(targetAcct, trimmedToken);
  } else {
    if (!normalizedRequestedAccount) {
      return inactiveTokenReport("invalid", "A Cloudflare account id is required: the token is verified against that account.");
    }
    const targetAcct = normalizedRequestedAccount;
    const check = await apiClient.verifyTokenAndPermissions(targetAcct, trimmedToken);
    const permissions: CloudflarePermissionReportItem[] = PERMISSION_META.map((meta) => {
      const permState = check.permissions[meta.label];
      const granted = Boolean(permState?.granted);
      return {
        id: meta.id,
        label: meta.label,
        required: true,
        granted,
        remediationUrl,
        ...(granted
          ? {
              ...(permState?.confirmed !== undefined ? { confirmed: permState.confirmed } : {}),
              ...(permState?.confirmed === false && permState.message ? { note: permState.message } : {}),
            }
          : {
              plainError: permState?.message ?? meta.missingDiagnostic,
            }),
      };
    });
    const unconfirmedLabels = permissions.filter((p) => p.granted && p.confirmed === false).map((p) => p.label);
    const missingPermissionIds = permissions.filter((p) => !p.granted).map((p) => p.id);
    const missingPermissionLabels = permissions.filter((p) => !p.granted).map((p) => p.label);
    return {
      ...(check.verifiedBy ? { verifiedBy: check.verifiedBy } : {}),
      ok: check.valid,
      status: check.status,
      isGlobalApiKey: check.isGlobalApiKey,
      accountId: check.account?.id,
      accountName: check.account?.name,
      accounts: check.account
        ? [
            {
              id: check.account.id,
              name: check.account.name,
              subdomain: check.account.subdomain,
            },
          ]
        : [],
      permissions,
      missingPermissionIds,
      missingPermissionLabels,
      remediationUrl,
      summaryMessage: check.valid
        ? unconfirmedLabels.length > 0
          ? `Connected to ${check.account?.name ?? "Cloudflare"} (${check.account?.id ?? targetAcct}) — read access shown for all 4 permissions; ${unconfirmedLabels.join(", ")} will be confirmed by the first deploy (this token cannot read its own policies).`
          : `Connected to ${check.account?.name ?? "Cloudflare"} (${check.account?.id ?? targetAcct}) — all 4 required permissions verified.`
        : check.isGlobalApiKey
          ? "Legacy Global API Key rejected — create a least-privilege scoped API token instead."
          : check.status !== "active"
            ? "Token is invalid or expired — Reconnect"
            : `Missing required permissions: ${missingPermissionLabels.join(", ")}`,
    };
  }

  if (!resolvedEntry) {
    const permissions: CloudflarePermissionReportItem[] = PERMISSION_META.map((meta) => ({
      id: meta.id,
      label: meta.label,
      required: true,
      granted: false,
      remediationUrl,
      plainError: "Token is invalid or expired — Reconnect",
    }));
    return {
      ok: false,
      status: "invalid",
      isGlobalApiKey: false,
      permissions,
      missingPermissionIds: permissions.map((p) => p.id),
      missingPermissionLabels: permissions.map((p) => p.label),
      remediationUrl,
      summaryMessage: "Token is invalid or expired — Reconnect",
    };
  }

  if (resolvedEntry.isGlobalApiKey) {
    const permissions: CloudflarePermissionReportItem[] = PERMISSION_META.map((meta) => ({
      id: meta.id,
      label: meta.label,
      required: true,
      granted: false,
      remediationUrl,
      plainError: "Over-broad Global API Key rejected; create a scoped API token instead.",
    }));
    return {
      ok: false,
      status: "invalid",
      isGlobalApiKey: true,
      permissions,
      missingPermissionIds: permissions.map((p) => p.id),
      missingPermissionLabels: permissions.map((p) => p.label),
      remediationUrl,
      summaryMessage: "Over-broad Global API Key rejected; create a scoped API token instead.",
    };
  }

  if (resolvedEntry.status !== "active") {
    const permissions: CloudflarePermissionReportItem[] = PERMISSION_META.map((meta) => ({
      id: meta.id,
      label: meta.label,
      required: true,
      granted: false,
      remediationUrl,
      plainError: "Token is invalid or expired — Reconnect",
    }));
    return {
      ok: false,
      status: resolvedEntry.status,
      isGlobalApiKey: false,
      permissions,
      missingPermissionIds: permissions.map((p) => p.id),
      missingPermissionLabels: permissions.map((p) => p.label),
      remediationUrl,
      summaryMessage: "Token is invalid or expired — Reconnect",
    };
  }

  const availableAccounts: CloudflareAccountSummary[] =
    resolvedEntry.accounts && resolvedEntry.accounts.length > 0
      ? resolvedEntry.accounts
      : [
          {
            id: resolvedEntry.accountId,
            name: resolvedEntry.accountName,
            subdomain: resolvedEntry.subdomain,
          },
        ];

  const wrongAccount = Boolean(normalizedRequestedAccount) && !availableAccounts.some((a) => a.id === normalizedRequestedAccount);

  if (wrongAccount) {
    const permissions: CloudflarePermissionReportItem[] = PERMISSION_META.map((meta) => ({
      id: meta.id,
      label: meta.label,
      required: true,
      granted: false,
      remediationUrl,
      plainError: `Token does not grant access to account ${normalizedRequestedAccount}.`,
    }));
    return {
      ok: false,
      status: "invalid",
      isGlobalApiKey: false,
      accounts: availableAccounts,
      permissions,
      missingPermissionIds: permissions.map((p) => p.id),
      missingPermissionLabels: permissions.map((p) => p.label),
      remediationUrl,
      summaryMessage: `Token is not authorized for Cloudflare account ${normalizedRequestedAccount}.`,
    };
  }

  const selectedAccount =
    (normalizedRequestedAccount ? availableAccounts.find((a) => a.id === normalizedRequestedAccount) : undefined) ?? availableAccounts[0]!;

  const permissions: CloudflarePermissionReportItem[] = PERMISSION_META.map((meta) => {
    const granted = resolvedEntry.permissions.includes(meta.label);
    return {
      id: meta.id,
      label: meta.label,
      required: true,
      granted,
      remediationUrl,
      ...(granted ? {} : { plainError: meta.missingDiagnostic }),
    };
  });

  const missingPermissionIds = permissions.filter((p) => !p.granted).map((p) => p.id);
  const missingPermissionLabels = permissions.filter((p) => !p.granted).map((p) => p.label);
  const ok = missingPermissionIds.length === 0;

  return {
    ok,
    status: "active",
    isGlobalApiKey: false,
    accountId: selectedAccount.id,
    accountName: selectedAccount.name,
    accounts: availableAccounts,
    permissions,
    missingPermissionIds,
    missingPermissionLabels,
    remediationUrl,
    summaryMessage: ok
      ? `Account found (${selectedAccount.name}) — all 4 required permissions verified.`
      : `Missing required permissions: ${missingPermissionLabels.map((l) => `${l} missing ✕`).join(", ")}`,
  };
}

export type AnalyzeMigrationsInput =
  | ReadonlyArray<{
      name?: string;
      migrationName?: string;
      sql: string;
      sha256?: string;
    }>
  | Record<string, string>;

export interface AnalyzeMigrationsOptions {
  previousSchemas?: Record<string, Record<string, string>>;
  previousSql?: string[];
}

export function analyzeSqlMigrations(migrations: AnalyzeMigrationsInput, options?: AnalyzeMigrationsOptions): DestructiveMigrationWarning[] {
  const normalizedList: Array<{ migrationName: string; sql: string }> = [];
  if (Array.isArray(migrations)) {
    for (const item of migrations) {
      normalizedList.push({
        migrationName: item.migrationName ?? item.name ?? "0001_migration.sql",
        sql: item.sql,
      });
    }
  } else if (migrations && typeof migrations === "object") {
    for (const [migrationName, sql] of Object.entries(migrations)) {
      normalizedList.push({ migrationName, sql });
    }
  }

  const knownTables: Record<string, Record<string, string>> = {};
  if (options?.previousSchemas) {
    for (const [tbl, cols] of Object.entries(options.previousSchemas)) {
      knownTables[tbl] = { ...cols };
    }
  }
  if (options?.previousSql) {
    for (const prevSql of options.previousSql) {
      for (const stmt of splitStatements(prevSql)) {
        const parsedTbl = parseCreateTableColumns(stmt);
        if (parsedTbl) {
          knownTables[parsedTbl.tableName] = {
            ...knownTables[parsedTbl.tableName],
            ...parsedTbl.columns,
          };
        }
      }
    }
  }

  const warnings: DestructiveMigrationWarning[] = [];
  for (const { migrationName, sql } of normalizedList) {
    const res = lintMigration(migrationName, sql, knownTables);
    warnings.push(...res.findings);
  }
  return warnings;
}

function computeDeployPlanFromResolvedState(params: {
  target: DeployTarget;
  scriptName: string;
  databaseName: string;
  input: ProvisionerPlanInput;
  existingScript: CloudflareWorkerScriptState | null;
  dbExists: boolean;
  appliedMigrationNames: Set<string>;
}): ProvisionerPlanResult {
  const { target, scriptName, databaseName, input, existingScript, dbExists, appliedMigrationNames } = params;

  const envState = input.envState;
  const actions: ProvisionerResourceAction[] = [];

  const createDatabase = !dbExists;
  if (createDatabase) {
    actions.push({
      kind: "d1_database",
      name: databaseName,
      action: "create",
      summary: `Create D1 database ${databaseName}`,
    });
  } else {
    actions.push({
      kind: "d1_database",
      name: databaseName,
      action: "unchanged",
      summary: `D1 database ${databaseName} already provisioned`,
    });
  }

  const pendingMigrations: string[] = [];
  const pendingMigrationSql: Record<string, string> = {};
  const pendingMigrationItems: ProvisionerMigrationItem[] = [];
  const previouslyAppliedSql: string[] = [...(envState?.previousSchemaSql ?? [])];

  for (const mig of input.migrations ?? []) {
    const alreadyApplied = appliedMigrationNames.has(mig.name);
    if (alreadyApplied) {
      previouslyAppliedSql.push(mig.sql);
    } else {
      pendingMigrations.push(mig.name);
      pendingMigrationSql[mig.name] = mig.sql;
      pendingMigrationItems.push(mig);
    }
    actions.push({
      kind: "d1_migration",
      name: mig.name,
      action: alreadyApplied ? "unchanged" : "create",
      summary: alreadyApplied ? `D1 migration ${mig.name} already applied` : `Apply D1 migration ${mig.name}`,
    });
  }

  const destructiveWarnings = analyzeSqlMigrations(pendingMigrationItems, {
    previousSchemas: envState?.previousTableSchemas,
    previousSql: previouslyAppliedSql,
  });

  const currentBuildHash =
    envState?.currentBuildHash !== undefined
      ? envState.currentBuildHash
      : envState?.buildHash !== undefined
        ? envState.buildHash
        : (existingScript?.buildHash ?? existingScript?.sha256 ?? null);

  const nextBuildHash = input.buildHash;
  const currentCodeHash = envState?.currentCodeHash ?? envState?.codeHash ?? existingScript?.codeHash ?? existingScript?.sha256 ?? null;
  const nextCodeHash = input.codeHash ?? input.bundle.sha256;
  const currentGraphHash = envState?.currentGraphHash ?? envState?.graphHash ?? existingScript?.graphHash ?? null;
  const nextGraphHash = input.graphHash ?? input.bundle.sha256.slice(0, 12);

  const isFirstDeploy = !existingScript && currentBuildHash === null && createDatabase;

  const codeOnlyUnchanged = Boolean(existingScript || currentBuildHash !== null) && currentCodeHash !== null && currentCodeHash === nextCodeHash;

  const graphOnlyChanged =
    !isFirstDeploy && codeOnlyUnchanged && currentGraphHash !== null && currentGraphHash !== nextGraphHash && pendingMigrations.length === 0;

  const fullBuildUnchanged =
    Boolean(existingScript || currentBuildHash !== null) &&
    !graphOnlyChanged &&
    (currentBuildHash === nextBuildHash || (existingScript !== null && (existingScript.codeHash ?? existingScript.sha256) === nextCodeHash));

  const workerChanged = !isFirstDeploy ? !fullBuildUnchanged && !graphOnlyChanged : true;

  if (!existingScript && currentBuildHash === null) {
    actions.push({
      kind: "worker_script",
      name: scriptName,
      action: "create",
      summary: `Create Worker script ${scriptName} (${input.bundle.sha256.slice(0, 12)})`,
    });
  } else if (workerChanged) {
    actions.push({
      kind: "worker_script",
      name: scriptName,
      action: "update",
      summary: `Update Worker script ${scriptName} (${(currentBuildHash ?? existingScript?.sha256 ?? "none").slice(0, 8)} -> ${nextBuildHash.slice(0, 8)})`,
    });
  } else {
    actions.push({
      kind: "worker_script",
      name: scriptName,
      action: "unchanged",
      summary: `Worker script ${scriptName} unchanged (${nextBuildHash.slice(0, 12)})`,
    });
  }

  if (graphOnlyChanged) {
    actions.push({
      kind: "graph",
      name: databaseName,
      action: "update",
      summary: `Hot-apply workflow graphs & schedules to D1 ${databaseName} (${(currentGraphHash ?? "none").slice(0, 8)} -> ${nextGraphHash.slice(0, 8)}) — Live without redeploy`,
    });
  }

  const existingQueueSet = new Set<string>(envState?.existingQueues ?? envState?.queues ?? (fullBuildUnchanged ? (input.queues ?? []) : []));
  const queueDiffs: DeployPlan["queues"] = [];
  for (const q of input.queues ?? []) {
    const qAction: "create" | "update" | "unchanged" = existingQueueSet.has(q) ? "unchanged" : "create";
    queueDiffs.push({
      queueName: q,
      action: qAction,
    });
    actions.push({
      kind: "queue",
      name: q,
      action: qAction,
      summary: qAction === "unchanged" ? `Cloudflare Queue ${q} unchanged` : `Ensure Cloudflare Queue ${q}`,
    });
  }

  const currentCrons = [...(envState?.currentCrons ?? envState?.cronTriggers ?? existingScript?.cronTriggers ?? [])];
  const nextCrons = [...(input.cronTriggers ?? [])];
  const existingCronSet = new Set(currentCrons);
  const cronsChanged = currentCrons.length !== nextCrons.length || nextCrons.some((c) => !existingCronSet.has(c));

  for (const cron of nextCrons) {
    const cronUnchanged = existingCronSet.has(cron);
    actions.push({
      kind: "cron_trigger",
      name: cron,
      action: cronUnchanged ? "unchanged" : "update",
      summary: cronUnchanged ? `Cron Trigger "${cron}" unchanged on ${scriptName}` : `Configure Cron Trigger "${cron}" on ${scriptName}`,
    });
  }

  const existingWorkflowMap = new Map<string, string>();
  for (const wf of envState?.existingWorkflows ?? envState?.workflows ?? []) {
    const wfName = wf.workflowName ?? wf.name ?? "";
    if (wfName) {
      existingWorkflowMap.set(wfName, wf.className);
    }
  }
  if (fullBuildUnchanged && existingWorkflowMap.size === 0) {
    for (const wf of input.workflows ?? []) {
      existingWorkflowMap.set(wf.name, wf.className);
    }
  }

  const workflowDiffs: DeployPlan["workflows"] = [];
  for (const wf of input.workflows ?? []) {
    const prevClass = existingWorkflowMap.get(wf.name);
    const wfAction: "create" | "update" | "unchanged" =
      prevClass === undefined ? "create" : prevClass === wf.className && !workerChanged ? "unchanged" : "update";
    workflowDiffs.push({
      workflowName: wf.name,
      className: wf.className,
      action: wfAction,
    });
    actions.push({
      kind: "workflow",
      name: wf.name,
      action: wfAction,
      summary: wfAction === "unchanged" ? `Workflow ${wf.name} (${wf.className}) unchanged` : `Register Workflow ${wf.name} (${wf.className})`,
    });
  }

  const configuredSet = new Set([
    ...(input.configuredSecrets ?? []),
    ...(envState?.configuredSecrets ?? []),
    ...(envState?.presentSecrets ?? []),
    ...(existingScript?.secrets ?? []),
  ]);

  const secretReqs: DeployPlanSecretRequirement[] =
    input.secretRequirements && input.secretRequirements.length > 0
      ? input.secretRequirements
      : (input.requiredSecrets ?? []).map((name) => ({
          name,
          requiredByBrick: "blueprint",
        }));

  // Story 1.19: an optional secret never blocks; a `generate` secret is made by Studio on an approved preview deploy, while
  // production never generates one (the owner binds a value or promotes from preview).
  const secrets: DeployPlanSecretCheck[] = secretReqs.map((req) => ({
    name: req.name,
    ...(req.ref ? { ref: req.ref } : {}),
    requiredByBrick: req.requiredByBrick,
    ...(req.optional ? { optional: true } : {}),
    ...(req.generate ? { generate: req.generate } : {}),
    status: configuredSet.has(req.name)
      ? "present"
      : req.optional
        ? "optional_missing"
        : req.generate && target.envName === "preview"
          ? "will_generate"
          : "missing",
  }));

  const missingSecrets = secrets.filter((s) => s.status === "missing").map((s) => s.name);

  const blockers: DeployPlanBlocker[] = [];
  const effectiveIdentity = input.blueprintIdentity ?? input.identity;

  if (target.envName === "production" && effectiveIdentity === "stub") {
    blockers.push({
      code: "PRODUCTION_IDENTITY_STUB_FORBIDDEN",
      message:
        'Production deployments cannot use stub identity (identity: "stub"). Enable Better Auth (core-auth) or another user-identity provider before deploying to production.',
      remediation: 'Switch blueprint identity from "stub" to "core-auth" (Better Auth).',
    });
  }

  const allowUnsigned =
    input.vars?.PX_WEBHOOK_ALLOW_UNSIGNED ??
    input.envVars?.PX_WEBHOOK_ALLOW_UNSIGNED ??
    (input as { bindings?: Record<string, string> }).bindings?.PX_WEBHOOK_ALLOW_UNSIGNED ??
    (input as { env?: Record<string, string> }).env?.PX_WEBHOOK_ALLOW_UNSIGNED ??
    (input as { PX_WEBHOOK_ALLOW_UNSIGNED?: string }).PX_WEBHOOK_ALLOW_UNSIGNED;

  if (target.envName === "production" && allowUnsigned === "dev") {
    blockers.push({
      code: "DEPLOY_UNSIGNED_WEBHOOKS_IN_PRODUCTION",
      message:
        'Production deployments cannot allow unsigned webhooks (PX_WEBHOOK_ALLOW_UNSIGNED="dev"). Unsigned ingress is only permitted in development environments.',
      remediation: "Remove PX_WEBHOOK_ALLOW_UNSIGNED or unset dev mode before deploying to production.",
    });
  }

  const readinessIssues = (input.readinessIssues ?? []).filter((issue) => issue.code !== "UNBOUND_BRICK_SECRET");
  if (readinessIssues.length > 0) {
    blockers.push({
      code: "READINESS_NOT_READY",
      message: readinessIssues.map((i) => i.message).join("; "),
      remediation: "Resolve all blueprint readiness errors in Studio before deploying.",
    });
  }

  if (missingSecrets.length > 0) {
    blockers.push({
      code: "MISSING_REQUIRED_SECRETS",
      message: `Missing required secrets: ${missingSecrets.join(", ")}`,
      remediation: secrets.some((s) => s.status === "missing" && s.generate)
        ? "Production never generates a secret: bind a value in Studio (Connections/secrets) or promote from preview, where Studio generates it on an approved deploy."
        : "Provide values for all missing required secrets in the preflight checklist or Connections view.",
    });
  }

  // The lock, migration classes and brick moves come from the shared planner, the same one the provisioner's planDeploy uses.
  let lockPlan: ProvisionerPlanResult["lockPlan"];
  if (input.lock) {
    const applied = new Map<string, string | null>([...appliedMigrationNames].map((name) => [name, null]));
    const migrationPlan = planMigrations(input.migrations ?? [], applied, { allowDestructive: true }); // destructive migrations are Studio's own warning and confirmation, not a second blocker here
    const changes = planLockChanges(envState?.previousLock, input.lock, {
      ...(input.allowMajor !== undefined ? { allowMajor: input.allowMajor } : {}),
      ...(input.catalog ? { catalog: input.catalog } : {}),
    });
    lockPlan = {
      migrations: migrationPlan.migrations,
      bricks: changes.bricks,
      settings: changes.settings,
      ...(changes.settingsUpgrade ? { settingsUpgrade: changes.settingsUpgrade } : {}),
    };
    for (const block of changes.blocks) {
      blockers.push({
        code: block.code,
        message: block.message,
        remediation:
          block.code === "BRICK_MAJOR_UNACKNOWLEDGED"
            ? "Review the brick's migration notes, then plan again with allowMajor set."
            : "Fix the saved setting named in the message, then plan again.",
      });
    }
  }

  // Graph static budget check (UC7.4)
  const accountPlan: "free" | "paid" = (target as { accountPlan?: "free" | "paid" }).accountPlan ?? input.accountPlan ?? "free";

  const targetRegistry = input.registry ?? toyRegistry;
  const graphsToCheck: Array<{ nodes: GraphNode[]; edges: GraphEdge[] }> = [];

  if (input.graph) {
    graphsToCheck.push(input.graph);
  }
  if (input.graphs) {
    for (const g of Object.values(input.graphs)) {
      if (typeof g === "string") {
        try {
          const parsed = JSON.parse(g);
          if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
            graphsToCheck.push(parsed);
          }
        } catch {
          // ignore unparseable here; graph-run will reject
        }
      }
    }
  }

  for (const g of graphsToCheck) {
    const budgetIssues = checkGraphBudget(g, targetRegistry, accountPlan);
    for (const issue of budgetIssues) {
      if (issue.severity === "error") {
        blockers.push({
          code: issue.code,
          message: `Graph budget exceeded [${issue.code}]: ${issue.message}`,
          remediation: issue.fix,
        });
      }
    }
  }

  const changes = actions.filter((a) => a.action !== "unchanged").length;
  const noChanges = !graphOnlyChanged && changes === 0;

  let planAction: DeployPlanAction;
  if (isFirstDeploy) {
    planAction = "create";
  } else if (graphOnlyChanged) {
    planAction = "hot_apply_graphs";
  } else if (noChanges) {
    planAction = "noop";
  } else {
    planAction = "update";
  }

  return {
    target,
    scriptName,
    databaseName,
    buildHash: nextBuildHash,
    ...(input.codeHash ? { codeHash: input.codeHash } : {}),
    graphHash: nextGraphHash,
    noChanges,
    changes,
    actions,
    missingSecrets,
    action: planAction,
    worker: {
      scriptName,
      currentBuildHash,
      nextBuildHash,
      changed: workerChanged,
    },
    d1: {
      databaseName,
      createDatabase,
      pendingMigrations,
      pendingMigrationSql,
      destructiveWarnings,
    },
    queues: queueDiffs,
    cronTriggers: {
      currentCrons,
      nextCrons,
      schedulesCount: nextCrons.length,
      changed: cronsChanged,
    },
    workflows: workflowDiffs,
    secrets,
    blockers,
    ...(lockPlan ? { lockPlan } : {}),
  };
}

export function computeDeployPlan(
  rawTarget: DeployTarget,
  buildArtifact: DeployBuildArtifactInput,
  envState?: DeployPlanEnvironmentState,
): ProvisionerPlanResult {
  const target = DeployTargetSchema.parse(rawTarget);
  const input = normalizeArtifactToPlanInput(target, buildArtifact, envState);
  const { scriptName, databaseName } = deriveEnvironmentResourceNames(input.project, target);

  const dbExists =
    envState?.databaseExists !== undefined
      ? envState.databaseExists
      : Boolean(
          envState?.deployedRev || envState?.currentBuildHash || envState?.buildHash || (envState?.appliedMigrations && envState.appliedMigrations.length > 0),
        );

  const existingBuildHash = envState?.currentBuildHash ?? envState?.buildHash ?? null;
  const existingCodeHash = envState?.currentCodeHash ?? envState?.codeHash ?? existingBuildHash;

  const syntheticExistingScript: CloudflareWorkerScriptState | null = existingBuildHash
    ? {
        scriptName,
        versionId: `ver_${existingBuildHash.slice(0, 8)}`,
        sha256: existingCodeHash ?? existingBuildHash,
        code: "export default {};",
        bindings: [],
        cronTriggers: envState?.currentCrons ?? envState?.cronTriggers ?? [],
        secrets: envState?.configuredSecrets ?? envState?.presentSecrets ?? [],
        updatedAt: new Date(0).toISOString(),
      }
    : null;

  return computeDeployPlanFromResolvedState({
    target,
    scriptName,
    databaseName,
    input,
    existingScript: syntheticExistingScript,
    dbExists,
    appliedMigrationNames: new Set(envState?.appliedMigrations ?? []),
  });
}

export function validateDeployPlan(plan: DeployPlan): {
  valid: boolean;
  blockers: DeployPlanBlocker[];
} {
  const unsignedBlocker = plan.blockers?.find((b) => b.code === "DEPLOY_UNSIGNED_WEBHOOKS_IN_PRODUCTION");
  if (unsignedBlocker) {
    const error = new Error(`Deployment plan blocked [DEPLOY_UNSIGNED_WEBHOOKS_IN_PRODUCTION]: ${unsignedBlocker.message}`);
    (error as any).code = "DEPLOY_UNSIGNED_WEBHOOKS_IN_PRODUCTION";
    throw error;
  }
  if (plan.blockers && plan.blockers.length > 0) {
    const error = new Error(`Deployment plan blocked [${plan.blockers[0]!.code}]: ${plan.blockers.map((b) => b.message).join("; ")}`);
    (error as any).code = plan.blockers[0]!.code;
    throw error;
  }
  return { valid: true, blockers: [] };
}

export { checkEnvironmentDrift } from "./drift.ts";
export type { OutOfBandDriftItem, BlueprintDriftReport, DriftReport, ExpectedDeploymentState, CurrentBlueprintHashes } from "./drift.ts";

export interface RollbackPlanSnapshot {
  deployId?: string;
  revision: number;
  buildHash: string;
  codeHash: string;
  graphHash: string;
  appliedMigrations: string[];
  appliedMigrationSql?: Record<string, string>;
  queues?: string[];
  cronTriggers?: string[];
  workflows?: Array<{ name?: string; workflowName?: string; className: string }>;
  graphs?: Record<string, string>;
  entities?: Array<{
    name: string;
    fields: Array<{ name: string; type: string; required?: boolean }>;
  }>;
  identity?: string;
}

export function computeRollbackPlan(
  paramsOrTarget:
    | {
        target: DeployTarget;
        project: string;
        currentDeployment: RollbackPlanSnapshot;
        targetDeployment: RollbackPlanSnapshot;
        configuredSecrets?: string[];
      }
    | DeployTarget,
  maybeCurrentDeployment?: RollbackPlanSnapshot,
  maybeTargetDeployment?: RollbackPlanSnapshot,
  maybeProject?: string,
): ProvisionerPlanResult & {
  downgradeMigrations: string[];
} {
  const params =
    "target" in paramsOrTarget
      ? paramsOrTarget
      : {
          target: paramsOrTarget,
          project: maybeProject ?? "project",
          currentDeployment: maybeCurrentDeployment!,
          targetDeployment: maybeTargetDeployment!,
        };
  const { target, project, currentDeployment, targetDeployment } = params;
  const targetMigSet = new Set(targetDeployment.appliedMigrations);
  const downgradeMigrations = currentDeployment.appliedMigrations.filter((m) => !targetMigSet.has(m));

  // Synthesize downgrade SQL statements for schema evolution between currentDeployment and targetDeployment
  const downgradeMigrationItems: ProvisionerMigrationItem[] = [];
  if (currentDeployment.entities && targetDeployment.entities) {
    const targetEntMap = new Map(targetDeployment.entities.map((e) => [e.name, e]));
    for (const currEnt of currentDeployment.entities) {
      const targetEnt = targetEntMap.get(currEnt.name);
      if (!targetEnt) {
        const migName = `rollback_drop_table__${currEnt.name}.sql`;
        downgradeMigrationItems.push({ name: migName, sql: `DROP TABLE ${currEnt.name};`, sha256: `sha256_${migName}` });
        if (!downgradeMigrations.includes(migName)) downgradeMigrations.push(migName);
        continue;
      }
      const targetFieldMap = new Map(targetEnt.fields.map((f) => [f.name, f]));
      for (const currField of currEnt.fields) {
        if (!targetFieldMap.has(currField.name)) {
          const migName = `rollback_drop_column__${currEnt.name}_${currField.name}.sql`;
          downgradeMigrationItems.push({ name: migName, sql: `ALTER TABLE ${currEnt.name} DROP COLUMN ${currField.name};`, sha256: `sha256_${migName}` });
          if (!downgradeMigrations.includes(migName)) downgradeMigrations.push(migName);
        }
      }
    }
  }

  for (const extraMig of currentDeployment.appliedMigrations) {
    if (!targetMigSet.has(extraMig) && !downgradeMigrationItems.some((d) => d.name === extraMig)) {
      const rawSql = currentDeployment.appliedMigrationSql?.[extraMig] ?? "";
      const tableMatch = rawSql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z0-9_]+)["`\]]?/i);
      const addColMatch = rawSql.match(/ALTER\s+TABLE\s+["`[]?([A-Za-z0-9_]+)["`\]]?\s+ADD\s+(?:COLUMN\s+)?["`[]?([A-Za-z0-9_]+)["`\]]?/i);
      const reverseSql = tableMatch
        ? `DROP TABLE ${tableMatch[1]};`
        : addColMatch
          ? `ALTER TABLE ${addColMatch[1]} DROP COLUMN ${addColMatch[2]};`
          : `DROP TABLE IF EXISTS _rollback_${extraMig.replace(/[^A-Za-z0-9_]/g, "_")};`;
      downgradeMigrationItems.push({ name: extraMig, sql: reverseSql, sha256: `sha256_rollback_${extraMig}` });
    }
  }

  const targetMigrationItems: ProvisionerMigrationItem[] = targetDeployment.appliedMigrations.map((name) => ({
    name,
    sql: targetDeployment.appliedMigrationSql?.[name] ?? `-- migration ${name}`,
    sha256: `sha256_${name}`,
  }));

  const allRollbackMigrations = [...targetMigrationItems, ...downgradeMigrationItems];

  // Filter out downgradeMigrations from appliedMigrations so computeDeployPlan analyzes them as pending destructive migrations
  const effectiveApplied = currentDeployment.appliedMigrations.filter((m) => !downgradeMigrations.includes(m));

  const plan = computeDeployPlan(
    target,
    {
      project,
      buildHash: targetDeployment.buildHash,
      codeHash: targetDeployment.codeHash,
      graphHash: targetDeployment.graphHash,
      bundle: {
        code: "export default {};",
        sha256: targetDeployment.codeHash,
      },
      migrations: allRollbackMigrations,
      queues: targetDeployment.queues ?? [],
      cronTriggers: targetDeployment.cronTriggers ?? [],
      workflows: (targetDeployment.workflows ?? []).map((w) => ({
        workflowName: w.workflowName ?? w.name ?? "workflow",
        className: w.className,
      })),
      identity: targetDeployment.identity ?? "core-auth",
      configuredSecrets: params.configuredSecrets ?? [],
    },
    {
      deployedRev: currentDeployment.revision,
      currentBuildHash: currentDeployment.buildHash,
      currentCodeHash: currentDeployment.codeHash,
      currentGraphHash: currentDeployment.graphHash,
      databaseExists: true,
      appliedMigrations: effectiveApplied,
      existingQueues: currentDeployment.queues ?? [],
      currentCrons: currentDeployment.cronTriggers ?? [],
      existingWorkflows: (currentDeployment.workflows ?? []).map((w) => ({
        workflowName: w.workflowName ?? w.name ?? "workflow",
        className: w.className,
      })),
    },
  );

  return {
    ...plan,
    downgradeMigrations,
  };
}
