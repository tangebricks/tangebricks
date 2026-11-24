import type { DurableObject as CfDurableObject } from "cloudflare:workers";
import { catalog } from "@poc/assembler/catalog";

const DurableObjectBase = (await import("cloudflare:workers")
  .then((m) => m.DurableObject)
  .catch(
    () =>
      class {
        ctx: DurableObjectState;
        env: unknown;
        constructor(ctx: DurableObjectState, env: unknown) {
          this.ctx = ctx;
          this.env = env;
        }
      },
  )) as typeof CfDurableObject;

function createWebSocketUpgradeResponse(client: WebSocket): Response {
  try {
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as unknown as ResponseInit);
  } catch {
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, "status", { value: 101 });
    Object.defineProperty(res, "webSocket", { value: client });
    return res;
  }
}
import {
  BlueprintExportError,
  OpSchema,
  applyOps,
  buildCatalogNodeRegistry,
  buildImportOps,
  collectOpTargets,
  computeReadiness,
  computeSemanticDiff,
  createEmptyBlueprint,
  evaluateProposalSelection,
  exportBlueprintBundle,
  parseBlueprintBundle,
  semanticHash,
} from "@poc/blueprint";

const catalogNodeRegistry = buildCatalogNodeRegistry(catalog);
import type {
  BlueprintBundle,
  BlueprintState,
  BlueprintValidationError,
  Op,
  ProposalRecord,
  ProposalStatus,
  ReadinessResult,
  SemanticDiff,
} from "@poc/blueprint";
import { PX_RATE_LIMITS_DDL, applyMigration, hashLegacySessionTokensOnce } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import {
  PX_TELEMETRY_MIGRATION_SQL,
  ensureTelemetryTables,
} from "@poc/telemetry";
import type {
  RunRecord,
  StepEvent,
  TelemetryWebhookPayload,
  TelemetryWsFrame,
} from "@poc/telemetry";

export interface StudioApiEnv {
  BLUEPRINT_DO: DurableObjectNamespace;
  STUDIO_DB: D1Like;
  DB?: D1Like;
  /** Deploy environment switch; "production" refuses placeholder executors (story 0.9). */
  PX_ENVIRONMENT?: string;
  /** Comma-separated user ids of platform operators; only they may use `/api/admin/*` (story 16). */
  PX_PLATFORM_OPERATORS?: string;
  /** Comma-separated origins allowed to call with credentials (CORS, CSRF, WebSocket); unset = same origin only. */
  PX_ALLOWED_ORIGINS?: string;
  BETTER_AUTH_SECRET?: string;
  PX_VAULT_KEY?: string;
  PX_CONN_KEY?: string;
  PX_TOKEN_KEK?: string;
  PX_TOKEN_KEK_VERSION?: string;
  PX_TOKEN_KEK_MAP?: Record<number, string>;
  PX_TELEMETRY_SECRET?: string;
  /** Story 0.21: per-bucket rate-limit overrides, JSON `{ "<bucket>": { "limit": n, "windowSeconds": n } }` (see @poc/sdk rateLimit). */
  PX_RATE_LIMITS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  __OAUTH_FETCHER?: typeof fetch;
}

export interface AuthorAttribution {
  type: "human" | "agent";
  id: string;
  client?: string;
  onBehalfOf?: string;
}

export interface ApplyOpsInput {
  project: string;
  orgId?: string;
  callerRole?: string;
  baseRevision?: number;
  author: AuthorAttribution;
  summary?: string;
  ops: unknown[];
  mode?: "apply" | "propose";
  proposalId?: string;
}

export interface AcceptProposalInput {
  project: string;
  orgId?: string;
  callerRole?: string;
  proposalId: string;
  opIds?: string[];
  reviewer: AuthorAttribution;
}

export interface RejectProposalInput {
  project: string;
  orgId?: string;
  callerRole?: string;
  proposalId: string;
  reason?: string;
  reviewer: AuthorAttribution;
}

export interface RevertInput {
  project: string;
  orgId?: string;
  callerRole?: string;
  targetRevision: number;
  baseRevision?: number;
  author: AuthorAttribution;
}

export interface ImportBundleInput {
  project: string;
  orgId?: string;
  callerRole?: string;
  bundle: unknown;
  author: AuthorAttribution;
  mode?: "create" | "replace";
}

export interface RevisionSummary {
  revision: number;
  parentRevision: number;
  rebasedFrom?: number;
  author: AuthorAttribution;
  summary: string;
  semanticHash: string;
  createdAt: string;
  opCount: number;
  ops?: Op[];
}

export interface RevisionHistoryPayload {
  project: string;
  revisions: RevisionSummary[];
  hasMore: boolean;
  nextBeforeRevision: number | null;
}

export interface SemanticDiffPayload {
  project: string;
  fromRevision: number;
  toRevision: number;
  fromSemanticHash: string;
  toSemanticHash: string;
  diff: SemanticDiff;
}

export interface PinnedNodeOutput {
  output: unknown;
  sourceRunId?: string | null;
  pinnedAt: string;
}

export interface ProjectStatePayload {
  project: string;
  orgId?: string;
  exists?: boolean;
  revision: number;
  parentRevision?: number;
  rebasedFrom?: number;
  revertedToRevision?: number;
  author?: AuthorAttribution;
  summary?: string;
  opCount?: number;
  state: BlueprintState;
  semanticHash: string;
  readiness: ReadinessResult;
  createdAt?: string;
  pinnedOutputs?: Record<string, Record<string, PinnedNodeOutput>>;
}

export interface SnapshotRecord {
  revision: number;
  state: BlueprintState;
  semanticHash: string;
  createdAt: string;
}

export interface ConflictDetail {
  opId: string;
  target: string;
  conflictingRevision: number;
  conflictingAuthor: AuthorAttribution;
}

export type InterveningOpRecord = Op & {
  revision: number;
  author: AuthorAttribution;
};

export interface ConflictErrorPayload {
  code: "CONFLICT";
  message: string;
  baseRevision: number;
  currentRevision: number;
  conflicts: ConflictDetail[];
  currentState: BlueprintState;
  interveningOps: InterveningOpRecord[];
  issues?: BlueprintValidationError[];
}

export type ApplyBatchOutcome =
  | {
      ok: true;
      status: 200;
      idempotent?: boolean;
      data: {
        project: string;
        revision: number;
        parentRevision: number;
        rebasedFrom?: number;
        author: AuthorAttribution;
        summary: string;
        state: BlueprintState;
        semanticHash: string;
        readiness: ReadinessResult;
        mode?: "apply" | "propose";
        status?: ProposalStatus;
        proposalId?: string;
        proposal?: ProposalRecord;
        diff?: SemanticDiff;
        proposedState?: BlueprintState;
        proposedReadiness?: ReadinessResult;
      };
    }
  | {
      ok: false;
      status: 409;
      error: ConflictErrorPayload;
    }
  | {
      ok: false;
      status: 422;
      error: {
        code: "VALIDATION_FAILED";
        message?: string;
        issues: BlueprintValidationError[];
      };
    };

export const STUDIO_API_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS "user" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" integer NOT NULL DEFAULT 0,
  "image" text,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text NOT NULL PRIMARY KEY,
  "expiresAt" date NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" text NOT NULL PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text NOT NULL PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" date NOT NULL,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE IF NOT EXISTS studio_orgs (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_org_members (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'builder', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS studio_mcp_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  scopes TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  project_id TEXT
);

CREATE TABLE IF NOT EXISTS studio_audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'org_default',
  current_revision INTEGER NOT NULL DEFAULT 0,
  semantic_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS studio_builds (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  build_hash TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  byte_count INTEGER NOT NULL,
  files_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, revision)
);

CREATE INDEX IF NOT EXISTS studio_builds_hash_idx ON studio_builds(project_id, build_hash);
CREATE INDEX IF NOT EXISTS studio_projects_org_idx ON projects(org_id);
CREATE INDEX IF NOT EXISTS studio_audit_log_org_idx ON studio_audit_log(org_id, created_at);

CREATE TABLE IF NOT EXISTS studio_secret_vault (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('api_key', 'webhook_secret', 'brick_secret')),
  label TEXT NOT NULL,
  app_or_brick TEXT NOT NULL,
  env_scope TEXT NOT NULL DEFAULT 'all',
  ciphertext_b64 TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid',
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, ref)
);
CREATE INDEX IF NOT EXISTS studio_secret_vault_project_idx ON studio_secret_vault(project_id, org_id);

CREATE TABLE IF NOT EXISTS deploy_tokens (
  token_ref TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  token_last4 TEXT NOT NULL,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')) DEFAULT 'active',
  ciphertext TEXT,
  iv TEXT,
  wrapped_dek TEXT,
  dek_iv TEXT,
  kek_version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_verified_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS deploy_tokens_org_idx ON deploy_tokens(org_id, status);

CREATE TABLE IF NOT EXISTS deploy_token_audit_log (
  audit_id TEXT PRIMARY KEY,
  token_ref TEXT NOT NULL,
  org_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  deploy_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deploy_token_audit_log_token_idx ON deploy_token_audit_log(token_ref, created_at);
CREATE INDEX IF NOT EXISTS deploy_token_audit_log_org_idx ON deploy_token_audit_log(org_id, created_at);

CREATE TABLE IF NOT EXISTS project_environments (
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')),
  target_type TEXT NOT NULL DEFAULT 'byoc',
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  token_ref TEXT NOT NULL,
  deployed_rev INTEGER,
  build_hash TEXT,
  code_hash TEXT,
  graph_hash TEXT,
  deployed_state_json TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, env_name)
);
CREATE INDEX IF NOT EXISTS project_environments_org_idx ON project_environments(org_id, token_ref);

CREATE TABLE IF NOT EXISTS project_deployments (
  deploy_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')),
  revision INTEGER NOT NULL,
  build_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  worker_url TEXT NOT NULL,
  version_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_deployments_project_env_idx ON project_deployments(project_id, env_name, created_at);

CREATE TABLE IF NOT EXISTS builds (
  build_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  semantic_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  catalog_version TEXT NOT NULL DEFAULT '1.0.0',
  bundle_code TEXT NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  files_json TEXT NOT NULL,
  assemble_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS builds_project_rev_idx ON builds(project_id, revision);

CREATE TABLE IF NOT EXISTS deployments (
  deploy_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')),
  revision INTEGER NOT NULL,
  build_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'succeeded',
  reused_cached_build INTEGER NOT NULL DEFAULT 0,
  live_without_redeploy INTEGER NOT NULL DEFAULT 0,
  no_changes INTEGER NOT NULL DEFAULT 0,
  rollback_from_deploy_id TEXT,
  worker_url TEXT NOT NULL,
  version_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployments_project_env_idx ON deployments(project_id, env_name, created_at);

CREATE TABLE IF NOT EXISTS deployment_steps (
  step_id TEXT PRIMARY KEY,
  deploy_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  env_name TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deployment_steps_deploy_idx ON deployment_steps(deploy_id, step_order);

CREATE TABLE IF NOT EXISTS onboarding_funnel_events (
  event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  actor_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('wizard_opened', 'template_link_clicked', 'token_submitted', 'verification_failed', 'verification_succeeded', 'token_disconnected')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS onboarding_funnel_events_org_step_idx ON onboarding_funnel_events(org_id, step, created_at);

CREATE TABLE IF NOT EXISTS studio_onboarding_events (
  event_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  actor_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN (
    'signup_completed',
    'project_created',
    'first_blueprint_edit',
    'first_test_step_run',
    'connect_cf_wizard_opened',
    'connect_cf_token_link_clicked',
    'connect_cf_token_submitted',
    'connect_cf_permission_check_failed',
    'connect_cf_verified',
    'first_preview_deploy_started',
    'first_preview_deploy_succeeded',
    'first_production_deploy_succeeded'
  )),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_onboarding_events_org_step_idx ON studio_onboarding_events(org_id, step, created_at);
CREATE INDEX IF NOT EXISTS studio_onboarding_events_actor_idx ON studio_onboarding_events(actor_id, step, created_at);

CREATE TABLE IF NOT EXISTS data_browser_audit_log (
  audit_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')),
  workspace_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  actor TEXT NOT NULL,
  before_snapshot TEXT,
  after_snapshot TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS data_browser_audit_log_project_env_idx ON data_browser_audit_log(project_id, env_name, workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS studio_connections_metadata (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  app TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  label TEXT NOT NULL,
  env_scope TEXT NOT NULL DEFAULT 'all',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'connected',
  expires_at TEXT,
  last_checked_at TEXT,
  key_hint TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, ref)
);
CREATE INDEX IF NOT EXISTS studio_connections_metadata_project_idx ON studio_connections_metadata(project_id, org_id);

CREATE TABLE IF NOT EXISTS studio_oauth_states (
  state TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  app TEXT NOT NULL,
  ref TEXT NOT NULL,
  label TEXT NOT NULL,
  env_scope TEXT NOT NULL DEFAULT 'preview',
  workspace_id TEXT NOT NULL DEFAULT 'default',
  code_verifier TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  redirect_uri TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_connection_requests (
  request_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  app TEXT NOT NULL,
  reason TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  suggested_ref TEXT NOT NULL,
  connect_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_user_consent',
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS studio_connection_requests_project_idx ON studio_connection_requests(project_id, status);

CREATE TABLE IF NOT EXISTS px_connections (
  ref TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'default',
  env_name TEXT NOT NULL DEFAULT 'preview',
  workspace_id TEXT NOT NULL DEFAULT 'default',
  app TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  ciphertext_b64 TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  key_hint TEXT NOT NULL DEFAULT '••••',
  status TEXT NOT NULL DEFAULT 'connected',
  expires_at TEXT,
  refresh_lock_until TEXT,
  last_checked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_px_connections_project_app ON px_connections(project_id, app, status);

CREATE TABLE IF NOT EXISTS studio_audit_logs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  org_id TEXT NOT NULL,
  project_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'succeeded',
  target_ref TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  details_json TEXT,
  ip_hash TEXT NOT NULL DEFAULT 'sha256:local',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_audit_logs_org_idx ON studio_audit_logs(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS studio_audit_logs_project_idx ON studio_audit_logs(project_id, ts DESC);

CREATE TABLE IF NOT EXISTS project_retention_settings (
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  env_name TEXT NOT NULL DEFAULT 'default' CHECK (env_name IN ('default', 'preview', 'production')),
  run_retention_days INTEGER NOT NULL DEFAULT 14 CHECK (run_retention_days >= 1 AND run_retention_days <= 90),
  telemetry_retention_days INTEGER NOT NULL DEFAULT 7 CHECK (telemetry_retention_days >= 1 AND telemetry_retention_days <= 30),
  capture_step_io_in_prod INTEGER NOT NULL DEFAULT 1,
  additional_redact_keys_json TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, env_name)
);
CREATE INDEX IF NOT EXISTS project_retention_settings_org_idx ON project_retention_settings(org_id, project_id);

CREATE TABLE IF NOT EXISTS studio_beta_cohort_partners (
  org_id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL DEFAULT 'cohort-1',
  org_name TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  partner_type TEXT NOT NULL CHECK (partner_type IN ('agency', 'mcp-first-dev', 'solo-founder')),
  owner_email TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  invite_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioned',
  deployed_integration_workflows INTEGER NOT NULL DEFAULT 0,
  mean_time_to_locate_failing_node_sec REAL,
  weekly_active_sessions_w4 INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_beta_cohort_partners_cohort_idx ON studio_beta_cohort_partners(cohort_id, partner_type);

CREATE TABLE IF NOT EXISTS studio_sandboxes (
  sandbox_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL DEFAULT 'org_default',
  dispatch_namespace TEXT NOT NULL DEFAULT 'px-sandboxes',
  build_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  deployed_rev INTEGER NOT NULL DEFAULT 0,
  preview_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'promoted', 'destroyed')),
  daily_requests_used INTEGER NOT NULL DEFAULT 0,
  d1_rows_used INTEGER NOT NULL DEFAULT 0,
  d1_bytes_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  destroyed_at TEXT
);
CREATE INDEX IF NOT EXISTS studio_sandboxes_project_idx ON studio_sandboxes(project_id, status);
CREATE INDEX IF NOT EXISTS studio_sandboxes_expires_idx ON studio_sandboxes(status, expires_at);
${PX_TELEMETRY_MIGRATION_SQL}
`;

export async function ensureStudioD1Schema(db: D1Like): Promise<void> {
  await db.batch([
    db.prepare(
      'CREATE TABLE IF NOT EXISTS "user" ("id" text NOT NULL PRIMARY KEY, "name" text NOT NULL, "email" text NOT NULL UNIQUE, "emailVerified" integer NOT NULL DEFAULT 0, "image" text, "createdAt" date NOT NULL, "updatedAt" date NOT NULL)',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS "session" ("id" text NOT NULL PRIMARY KEY, "expiresAt" date NOT NULL, "token" text NOT NULL UNIQUE, "createdAt" date NOT NULL, "updatedAt" date NOT NULL, "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE)',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS "account" ("id" text NOT NULL PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL, "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date NOT NULL, "updatedAt" date NOT NULL)',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS "verification" ("id" text NOT NULL PRIMARY KEY, "identifier" text NOT NULL, "value" text NOT NULL, "expiresAt" date NOT NULL, "createdAt" date NOT NULL, "updatedAt" date NOT NULL)',
    ),
    db.prepare('CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId")'),
    db.prepare('CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId")'),
    db.prepare(
      'CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier")',
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_orgs (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_org_members (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'builder', 'viewer')), created_at TEXT NOT NULL, PRIMARY KEY (org_id, user_id))",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_mcp_tokens (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, client_name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, scopes TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL, project_id TEXT)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_audit_log (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, details_json TEXT, created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY, org_id TEXT NOT NULL DEFAULT 'org_default', current_revision INTEGER NOT NULL DEFAULT 0, semantic_hash TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_builds (project_id TEXT NOT NULL, revision INTEGER NOT NULL, build_hash TEXT NOT NULL, semantic_hash TEXT NOT NULL, file_count INTEGER NOT NULL, byte_count INTEGER NOT NULL, files_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (project_id, revision))",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_builds_hash_idx ON studio_builds(project_id, build_hash)",
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS studio_projects_org_idx ON projects(org_id)"),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_audit_log_org_idx ON studio_audit_log(org_id, created_at)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_secret_vault (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL, ref TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('api_key', 'webhook_secret', 'brick_secret')), label TEXT NOT NULL, app_or_brick TEXT NOT NULL, env_scope TEXT NOT NULL DEFAULT 'all', ciphertext_b64 TEXT NOT NULL, iv_b64 TEXT NOT NULL, key_hint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'valid', created_by TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, ref))",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_secret_vault_project_idx ON studio_secret_vault(project_id, org_id)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS deploy_tokens (token_ref TEXT PRIMARY KEY, org_id TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT NOT NULL, token_last4 TEXT NOT NULL, scopes TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')) DEFAULT 'active', ciphertext TEXT, iv TEXT, wrapped_dek TEXT, dek_iv TEXT, kek_version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL, last_verified_at TEXT, revoked_at TEXT)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS deploy_tokens_org_idx ON deploy_tokens(org_id, status)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS deploy_token_audit_log (audit_id TEXT PRIMARY KEY, token_ref TEXT NOT NULL, org_id TEXT NOT NULL, actor TEXT NOT NULL, deploy_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS deploy_token_audit_log_token_idx ON deploy_token_audit_log(token_ref, created_at)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS deploy_token_audit_log_org_idx ON deploy_token_audit_log(org_id, created_at)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS project_environments (project_id TEXT NOT NULL, org_id TEXT NOT NULL, env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')), target_type TEXT NOT NULL DEFAULT 'byoc', account_id TEXT NOT NULL, account_name TEXT NOT NULL, token_ref TEXT NOT NULL, deployed_rev INTEGER, build_hash TEXT, code_hash TEXT, graph_hash TEXT, deployed_state_json TEXT, status TEXT NOT NULL DEFAULT 'connected', updated_at TEXT NOT NULL, PRIMARY KEY (project_id, env_name))",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS project_environments_org_idx ON project_environments(org_id, token_ref)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS project_deployments (deploy_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, org_id TEXT NOT NULL, env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')), revision INTEGER NOT NULL, build_hash TEXT NOT NULL, code_hash TEXT NOT NULL, graph_hash TEXT NOT NULL, action TEXT NOT NULL, worker_url TEXT NOT NULL, version_id TEXT NOT NULL, database_id TEXT NOT NULL, actor_id TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS project_deployments_project_env_idx ON project_deployments(project_id, env_name, created_at)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS builds (build_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL, semantic_hash TEXT NOT NULL, code_hash TEXT NOT NULL, graph_hash TEXT NOT NULL, catalog_version TEXT NOT NULL DEFAULT '1.0.0', bundle_code TEXT NOT NULL, bundle_sha256 TEXT NOT NULL, files_json TEXT NOT NULL, assemble_count INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS builds_project_rev_idx ON builds(project_id, revision)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS deployments (deploy_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, org_id TEXT NOT NULL, env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')), revision INTEGER NOT NULL, build_hash TEXT NOT NULL, code_hash TEXT NOT NULL, graph_hash TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'succeeded', reused_cached_build INTEGER NOT NULL DEFAULT 0, live_without_redeploy INTEGER NOT NULL DEFAULT 0, no_changes INTEGER NOT NULL DEFAULT 0, rollback_from_deploy_id TEXT, worker_url TEXT NOT NULL, version_id TEXT NOT NULL, database_id TEXT NOT NULL, actor_id TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS deployments_project_env_idx ON deployments(project_id, env_name, created_at)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS deployment_steps (step_id TEXT PRIMARY KEY, deploy_id TEXT NOT NULL, project_id TEXT NOT NULL, env_name TEXT NOT NULL, step_order INTEGER NOT NULL, step_name TEXT NOT NULL, resource_kind TEXT NOT NULL, resource_name TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS deployment_steps_deploy_idx ON deployment_steps(deploy_id, step_order)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS onboarding_funnel_events (event_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT, actor_id TEXT NOT NULL, step TEXT NOT NULL CHECK (step IN ('wizard_opened', 'template_link_clicked', 'token_submitted', 'verification_failed', 'verification_succeeded', 'token_disconnected')), metadata_json TEXT, created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS onboarding_funnel_events_org_step_idx ON onboarding_funnel_events(org_id, step, created_at)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_onboarding_events (event_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT, actor_id TEXT NOT NULL, step TEXT NOT NULL CHECK (step IN ('signup_completed', 'project_created', 'first_blueprint_edit', 'first_test_step_run', 'connect_cf_wizard_opened', 'connect_cf_token_link_clicked', 'connect_cf_token_submitted', 'connect_cf_permission_check_failed', 'connect_cf_verified', 'first_preview_deploy_started', 'first_preview_deploy_succeeded', 'first_production_deploy_succeeded')), metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_onboarding_events_org_step_idx ON studio_onboarding_events(org_id, step, created_at)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_onboarding_events_project_step_idx ON studio_onboarding_events(project_id, step, created_at)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS data_browser_audit_log (audit_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL, env_name TEXT NOT NULL CHECK (env_name IN ('preview', 'production')), workspace_id TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL, operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')), actor TEXT NOT NULL, before_snapshot TEXT, after_snapshot TEXT, created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS data_browser_audit_log_project_env_idx ON data_browser_audit_log(project_id, env_name, workspace_id, created_at DESC)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS mcp_files (project TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (project, path))",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS mcp_builds (project TEXT PRIMARY KEY, project_hash TEXT NOT NULL, file_count INTEGER NOT NULL, byte_count INTEGER NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')))",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_connections_metadata (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL, ref TEXT NOT NULL, app TEXT NOT NULL, auth_type TEXT NOT NULL, label TEXT NOT NULL, env_scope TEXT NOT NULL DEFAULT 'all', scopes_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'connected', expires_at TEXT, last_checked_at TEXT, key_hint TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, ref))",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_connections_metadata_project_idx ON studio_connections_metadata(project_id, org_id)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_oauth_states (state TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL, app TEXT NOT NULL, ref TEXT NOT NULL, label TEXT NOT NULL, env_scope TEXT NOT NULL DEFAULT 'preview', workspace_id TEXT NOT NULL DEFAULT 'default', code_verifier TEXT NOT NULL, code_challenge TEXT NOT NULL, scopes_json TEXT NOT NULL DEFAULT '[]', redirect_uri TEXT NOT NULL, created_by TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_connection_requests (request_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL, app TEXT NOT NULL, reason TEXT NOT NULL, scopes_json TEXT NOT NULL DEFAULT '[]', suggested_ref TEXT NOT NULL, connect_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending_user_consent', requested_by TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_connection_requests_project_idx ON studio_connection_requests(project_id, status)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS px_connections (ref TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default', env_name TEXT NOT NULL DEFAULT 'preview', workspace_id TEXT NOT NULL DEFAULT 'default', app TEXT NOT NULL, auth_type TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', scopes_json TEXT NOT NULL DEFAULT '[]', ciphertext_b64 TEXT NOT NULL, iv_b64 TEXT NOT NULL, key_hint TEXT NOT NULL DEFAULT '••••', status TEXT NOT NULL DEFAULT 'connected', expires_at TEXT, refresh_lock_until TEXT, last_checked_at TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_px_connections_project_app ON px_connections(project_id, app, status)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_audit_logs (id TEXT PRIMARY KEY, ts TEXT NOT NULL, org_id TEXT NOT NULL, project_id TEXT, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'succeeded', target_ref TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}', details_json TEXT, ip_hash TEXT NOT NULL DEFAULT 'sha256:local', created_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_audit_logs_org_idx ON studio_audit_logs(org_id, ts DESC)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_audit_logs_project_idx ON studio_audit_logs(project_id, ts DESC)",
    ),
    db.prepare(
      "CREATE TRIGGER IF NOT EXISTS trg_studio_audit_logs_no_update BEFORE UPDATE ON studio_audit_logs BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_IMMUTABLE: UPDATE and DELETE are forbidden on studio_audit_logs'); END",
    ),
    db.prepare(
      "CREATE TRIGGER IF NOT EXISTS trg_studio_audit_logs_no_delete BEFORE DELETE ON studio_audit_logs BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_IMMUTABLE: UPDATE and DELETE are forbidden on studio_audit_logs'); END",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS project_retention_settings (project_id TEXT NOT NULL, org_id TEXT NOT NULL, env_name TEXT NOT NULL DEFAULT 'default' CHECK (env_name IN ('default', 'preview', 'production')), run_retention_days INTEGER NOT NULL DEFAULT 14 CHECK (run_retention_days >= 1 AND run_retention_days <= 90), telemetry_retention_days INTEGER NOT NULL DEFAULT 7 CHECK (telemetry_retention_days >= 1 AND telemetry_retention_days <= 30), capture_step_io_in_prod INTEGER NOT NULL DEFAULT 1, additional_redact_keys_json TEXT NOT NULL DEFAULT '[]', updated_by TEXT NOT NULL DEFAULT 'system', updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (project_id, env_name))",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS project_retention_settings_org_idx ON project_retention_settings(org_id, project_id)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_beta_cohort_partners (org_id TEXT PRIMARY KEY, cohort_id TEXT NOT NULL DEFAULT 'cohort-1', org_name TEXT NOT NULL, org_slug TEXT NOT NULL, partner_type TEXT NOT NULL CHECK (partner_type IN ('agency', 'mcp-first-dev', 'solo-founder')), owner_email TEXT NOT NULL, owner_user_id TEXT NOT NULL, invite_token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'provisioned', deployed_integration_workflows INTEGER NOT NULL DEFAULT 0, mean_time_to_locate_failing_node_sec REAL, weekly_active_sessions_w4 INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_beta_cohort_partners_cohort_idx ON studio_beta_cohort_partners(cohort_id, partner_type)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS studio_sandboxes (sandbox_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, org_id TEXT NOT NULL DEFAULT 'org_default', dispatch_namespace TEXT NOT NULL DEFAULT 'px-sandboxes', build_hash TEXT NOT NULL, code_hash TEXT NOT NULL, graph_hash TEXT NOT NULL, deployed_rev INTEGER NOT NULL DEFAULT 0, preview_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'promoted', 'destroyed')), daily_requests_used INTEGER NOT NULL DEFAULT 0, d1_rows_used INTEGER NOT NULL DEFAULT 0, d1_bytes_used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, destroyed_at TEXT)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_sandboxes_project_idx ON studio_sandboxes(project_id, status)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS studio_sandboxes_expires_idx ON studio_sandboxes(status, expires_at)",
    ),
  ]);
  await db
    .prepare("ALTER TABLE projects ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_default'")
    .run()
    .catch(() => {});
  await db
    .prepare("ALTER TABLE deployments ADD COLUMN rollback_from_deploy_id TEXT")
    .run()
    .catch(() => {});
  // Story 0.15: every MCP token is bound to one project. Older databases get the column here; rows
  // without a project are refused by resolveStudioCaller.
  await db
    .prepare("ALTER TABLE studio_mcp_tokens ADD COLUMN project_id TEXT")
    .run()
    .catch(() => {});
  // Story 0.21: the shared rate limiter's counters for the custom login and signup (hashed keys only, no workspace).
  // A failure is logged, not thrown: the limiter then fails closed with 503 RATE_LIMIT_UNAVAILABLE on auth routes.
  await applyMigration(db, PX_RATE_LIMITS_DDL).catch((error: unknown) => {
    console.error("px_rate_limits schema step failed:", error instanceof Error ? error.message : error);
  });
  // Story 0.14: session tokens are stored as sha256 digests. Rows written before that still hold the raw token; this
  // guarded step rewrites them to their digest once per isolate (a full scan, so not on every call); a legacy row that
  // appears later is rewritten on first use by the hashed-session adapter. Either way its holder stays signed in.
  await hashLegacySessionTokensOnce(db);
  await db
    .prepare(
      "CREATE INDEX IF NOT EXISTS studio_mcp_tokens_org_project_idx ON studio_mcp_tokens(org_id, project_id)",
    )
    .run();
  await ensureTelemetryTables(db);
}

function summarizeOp(op: Op): string {
  switch (op.type) {
    case "enable_brick":
      return `enable brick ${op.brickId}`;
    case "configure_brick":
      return `configure brick ${op.brickId}`;
    case "remove_brick":
      return `remove brick ${op.brickId}`;
    case "set_identity":
      return `set identity to ${op.identity}`;
    case "add_entity":
      return `add entity ${op.entity.name}`;
    case "update_entity":
      return `update entity ${op.entity.name}`;
    case "remove_entity":
      return `remove entity ${op.name}`;
    case "add_workflow":
      return `add workflow ${op.workflow.id}`;
    case "remove_workflow":
      return `remove workflow ${op.workflowId}`;
    case "add_node":
      return `add node ${op.node.id} in ${op.workflowId}`;
    case "update_node":
      return `update node ${op.nodeId} in ${op.workflowId}`;
    case "remove_node":
      return `remove node ${op.nodeId} in ${op.workflowId}`;
    case "connect_edges":
      return `connect ${op.edges.length} edge(s) in ${op.workflowId}`;
    case "disconnect_edge":
      return `disconnect edge ${op.edgeId} in ${op.workflowId}`;
    case "bind_secret_ref":
      return `bind secret ${op.secretName} on ${op.targetKind}:${op.targetId}`;
    case "unbind_secret_ref":
      return `unbind secret ${op.secretName} on ${op.targetKind}:${op.targetId}`;
    case "set_metadata":
      return "update blueprint metadata";
  }
}

export function generateBatchSummary(ops: Op[]): string {
  if (ops.length === 0) return "empty operation batch";
  if (ops.length === 1) return summarizeOp(ops[0]!);
  return `${summarizeOp(ops[0]!)} (+${ops.length - 1} more)`;
}

export class BlueprintDO extends DurableObjectBase<StudioApiEnv> {
  private tablesInitialized = false;

  constructor(ctx: DurableObjectState, env: StudioApiEnv) {
    super(ctx, env);
    this.ensureTables();
  }

  public ensureTables(): void {
    if (this.tablesInitialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_meta (
        project_id TEXT PRIMARY KEY,
        org_id TEXT,
        current_revision INTEGER NOT NULL,
        current_state TEXT NOT NULL,
        semantic_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS revisions (
        revision INTEGER PRIMARY KEY,
        parent_revision INTEGER NOT NULL,
        rebased_from INTEGER,
        author_type TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_client TEXT,
        author_on_behalf_of TEXT,
        summary TEXT NOT NULL,
        ops_json TEXT NOT NULL,
        inverse_ops_json TEXT NOT NULL,
        semantic_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        revision INTEGER PRIMARY KEY,
        state_json TEXT NOT NULL,
        semantic_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS committed_ops (
        op_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry_runs (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        trigger_type TEXT NOT NULL DEFAULT 'manual',
        workspace_id TEXT NOT NULL DEFAULT 'ws_default',
        status TEXT NOT NULL,
        duration_ms REAL NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        retry_of_run_id TEXT,
        error_stack TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE TABLE IF NOT EXISTS telemetry_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms REAL NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        input_preview TEXT NOT NULL DEFAULT '{}',
        output_preview TEXT NOT NULL DEFAULT '{}',
        error_stack TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pinned_outputs (
        workflow_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        output_json TEXT NOT NULL,
        source_run_id TEXT,
        pinned_at TEXT NOT NULL,
        PRIMARY KEY (workflow_id, node_id)
      );

      CREATE TABLE IF NOT EXISTS proposals (
        proposal_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        base_rev INTEGER NOT NULL,
        actor_json TEXT NOT NULL,
        ops_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        diff_json TEXT NOT NULL,
        proposed_state_json TEXT NOT NULL,
        proposed_readiness_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT,
        rejection_reason TEXT,
        accepted_rev INTEGER,
        accepted_op_ids_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_proposals_project_created
        ON proposals(project, created_at DESC);
    `);
    try {
      this.ctx.storage.sql.exec("ALTER TABLE revisions ADD COLUMN author_on_behalf_of TEXT");
    } catch {
      // Column already exists
    }
    try {
      this.ctx.storage.sql.exec("ALTER TABLE project_meta ADD COLUMN org_id TEXT");
    } catch {
      // Column already exists
    }
    this.tablesInitialized = true;
  }

  public initProject(project: string, orgId?: string): ProjectStatePayload {
    this.ensureTables();
    const empty = createEmptyBlueprint(project);
    const initialHash = semanticHash(empty);
    const nowIso = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO project_meta (project_id, org_id, current_revision, current_state, semantic_hash, updated_at)
       VALUES (?, ?, 0, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         org_id = COALESCE(excluded.org_id, project_meta.org_id)`,
      project,
      orgId ?? null,
      JSON.stringify(empty),
      initialHash,
      nowIso,
    );
    return this.getProjectState(project);
  }

  public getProjectState(project: string): ProjectStatePayload {
    this.ensureTables();
    const rows = this.ctx.storage.sql
      .exec<{
        project_id: string;
        org_id: string | null;
        current_revision: number;
        current_state: string;
        semantic_hash: string;
        updated_at: string;
      }>("SELECT project_id, org_id, current_revision, current_state, semantic_hash, updated_at FROM project_meta LIMIT 1")
      .toArray();

    const row = rows[0];
    if (!row) {
      const empty = createEmptyBlueprint(project);
      return {
        project,
        exists: false,
        revision: 0,
        state: empty,
        semanticHash: semanticHash(empty),
        readiness: computeReadiness(empty, catalog, catalogNodeRegistry),
      };
    }

    const state = JSON.parse(row.current_state) as BlueprintState;
    const pinnedOutputs = this.getAllPinnedOutputs();
    return {
      project: row.project_id,
      ...(row.org_id ? { orgId: row.org_id } : {}),
      exists: true,
      revision: Number(row.current_revision),
      state,
      semanticHash: row.semantic_hash,
      readiness: computeReadiness(state, catalog, catalogNodeRegistry),
      ...(Object.keys(pinnedOutputs).length > 0 ? { pinnedOutputs } : {}),
    };
  }

  public getSummary(project = "default-project"): ProjectStatePayload & {
    revisions: RevisionSummary[];
    brickCount: number;
    entityCount: number;
    workflowCount: number;
  } {
    const statePayload = this.getProjectState(project);
    const revHistory = this.listRevisions(statePayload.project, { limit: 50 });
    return {
      ...statePayload,
      revisions: revHistory.revisions,
      brickCount: statePayload.state.bricks?.length ?? 0,
      entityCount: statePayload.state.entities?.length ?? 0,
      workflowCount: statePayload.state.workflows?.length ?? 0,
    };
  }

  public getAllPinnedOutputs(): Record<string, Record<string, PinnedNodeOutput>> {
    this.ensureTables();
    const rows = this.ctx.storage.sql
      .exec<{
        workflow_id: string;
        node_id: string;
        output_json: string;
        source_run_id: string | null;
        pinned_at: string;
      }>("SELECT workflow_id, node_id, output_json, source_run_id, pinned_at FROM pinned_outputs ORDER BY workflow_id ASC, node_id ASC")
      .toArray();

    const byWorkflow: Record<string, Record<string, PinnedNodeOutput>> = {};
    for (const r of rows) {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(r.output_json);
      } catch {
        parsed = r.output_json;
      }
      const wfMap = (byWorkflow[r.workflow_id] ??= {});
      wfMap[r.node_id] = {
        output: parsed,
        ...(r.source_run_id ? { sourceRunId: r.source_run_id } : {}),
        pinnedAt: r.pinned_at,
      };
    }
    return byWorkflow;
  }

  public getWorkflowPinnedOutputs(
    workflowId: string,
  ): Record<string, PinnedNodeOutput> {
    this.ensureTables();
    const rows = this.ctx.storage.sql
      .exec<{
        node_id: string;
        output_json: string;
        source_run_id: string | null;
        pinned_at: string;
      }>(
        "SELECT node_id, output_json, source_run_id, pinned_at FROM pinned_outputs WHERE workflow_id = ? ORDER BY node_id ASC",
        workflowId,
      )
      .toArray();

    const pins: Record<string, PinnedNodeOutput> = {};
    for (const r of rows) {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(r.output_json);
      } catch {
        parsed = r.output_json;
      }
      pins[r.node_id] = {
        output: parsed,
        ...(r.source_run_id ? { sourceRunId: r.source_run_id } : {}),
        pinnedAt: r.pinned_at,
      };
    }
    return pins;
  }

  public setPinnedOutput(
    workflowId: string,
    nodeId: string,
    input: {
      output: unknown;
      sourceRunId?: string | null;
      pinnedAt?: string;
    },
  ): PinnedNodeOutput {
    this.ensureTables();
    const pinnedAt = input.pinnedAt ?? new Date().toISOString();
    const sourceRunId = input.sourceRunId ?? null;
    const outputJson = JSON.stringify(input.output ?? {});
    this.ctx.storage.sql.exec(
      `INSERT INTO pinned_outputs (workflow_id, node_id, output_json, source_run_id, pinned_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workflow_id, node_id) DO UPDATE SET
         output_json = excluded.output_json,
         source_run_id = excluded.source_run_id,
         pinned_at = excluded.pinned_at`,
      workflowId,
      nodeId,
      outputJson,
      sourceRunId,
      pinnedAt,
    );
    return {
      output: input.output ?? {},
      ...(sourceRunId ? { sourceRunId } : {}),
      pinnedAt,
    };
  }

  public deletePinnedOutput(workflowId: string, nodeId: string): boolean {
    this.ensureTables();
    this.ctx.storage.sql.exec(
      "DELETE FROM pinned_outputs WHERE workflow_id = ? AND node_id = ?",
      workflowId,
      nodeId,
    );
    return true;
  }

  public getStateAtRevision(project: string, targetRevision: number): ProjectStatePayload | null {
    this.ensureTables();
    if (targetRevision === 0) {
      const empty = createEmptyBlueprint(project);
      return {
        project,
        revision: 0,
        parentRevision: 0,
        state: empty,
        semanticHash: semanticHash(empty),
        readiness: computeReadiness(empty, catalog, catalogNodeRegistry),
      };
    }

    const revRows = this.ctx.storage.sql
      .exec<{
        revision: number;
        parent_revision: number;
        rebased_from: number | null;
        author_type: "human" | "agent";
        author_id: string;
        author_client: string | null;
        author_on_behalf_of: string | null;
        summary: string;
        ops_json: string;
        semantic_hash: string;
        created_at: string;
      }>(
        "SELECT revision, parent_revision, rebased_from, author_type, author_id, author_client, author_on_behalf_of, summary, ops_json, semantic_hash, created_at FROM revisions WHERE revision = ?",
        targetRevision,
      )
      .toArray();

    const revRow = revRows[0];
    if (!revRow) {
      return null;
    }

    const snapRows = this.ctx.storage.sql
      .exec<{
        revision: number;
        state_json: string;
      }>(
        "SELECT revision, state_json FROM snapshots WHERE revision <= ? ORDER BY revision DESC LIMIT 1",
        targetRevision,
      )
      .toArray();

    let state: BlueprintState;
    let startRevision: number;
    if (snapRows[0]) {
      state = JSON.parse(snapRows[0].state_json) as BlueprintState;
      startRevision = Number(snapRows[0].revision) + 1;
    } else {
      state = createEmptyBlueprint(project);
      startRevision = 1;
    }

    if (startRevision <= targetRevision) {
      const stepRows = this.ctx.storage.sql
        .exec<{
          revision: number;
          ops_json: string;
        }>(
          "SELECT revision, ops_json FROM revisions WHERE revision >= ? AND revision <= ? ORDER BY revision ASC",
          startRevision,
          targetRevision,
        )
        .toArray();

      for (const step of stepRows) {
        const ops = JSON.parse(step.ops_json) as unknown[];
        const res = applyOps(state, ops, catalog);
        if (!res.ok) {
          throw new Error(
            `Failed to replay revision ${step.revision} for project "${project}": ${JSON.stringify(res.errors)}`,
          );
        }
        state = res.state;
      }
    }

    const computedHash = semanticHash(state);
    const author: AuthorAttribution = {
      type: revRow.author_type,
      id: revRow.author_id,
      ...(revRow.author_client ? { client: revRow.author_client } : {}),
      ...(revRow.author_on_behalf_of ? { onBehalfOf: revRow.author_on_behalf_of } : {}),
    };
    const opCount = (JSON.parse(revRow.ops_json) as unknown[]).length;

    return {
      project,
      revision: Number(revRow.revision),
      parentRevision: Number(revRow.parent_revision),
      ...(revRow.rebased_from !== null && revRow.rebased_from !== undefined
        ? { rebasedFrom: Number(revRow.rebased_from) }
        : {}),
      author,
      summary: revRow.summary,
      opCount,
      state,
      semanticHash: computedHash,
      readiness: computeReadiness(state, catalog, catalogNodeRegistry),
      createdAt: revRow.created_at,
    };
  }

  public listRevisions(
    project: string,
    options?: { limit?: number; beforeRevision?: number },
  ): RevisionHistoryPayload {
    this.ensureTables();
    const limit = Math.max(1, Math.min(100, options?.limit ?? 20));
    const beforeRevision = options?.beforeRevision;

    type RevisionQueryRow = {
      revision: number;
      parent_revision: number;
      rebased_from: number | null;
      author_type: "human" | "agent";
      author_id: string;
      author_client: string | null;
      author_on_behalf_of: string | null;
      summary: string;
      ops_json: string;
      semantic_hash: string;
      created_at: string;
    };

    const rows =
      beforeRevision !== undefined
        ? this.ctx.storage.sql
            .exec<RevisionQueryRow>(
              `SELECT revision, parent_revision, rebased_from, author_type, author_id, author_client, author_on_behalf_of, summary, ops_json, semantic_hash, created_at
               FROM revisions
               WHERE revision < ?
               ORDER BY revision DESC
               LIMIT ?`,
              beforeRevision,
              limit + 1,
            )
            .toArray()
        : this.ctx.storage.sql
            .exec<RevisionQueryRow>(
              `SELECT revision, parent_revision, rebased_from, author_type, author_id, author_client, author_on_behalf_of, summary, ops_json, semantic_hash, created_at
               FROM revisions
               ORDER BY revision DESC
               LIMIT ?`,
              limit + 1,
            )
            .toArray();

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const revisions: RevisionSummary[] = pageRows.map((row) => {
      const parsedOps = JSON.parse(row.ops_json) as Op[];
      return {
        revision: Number(row.revision),
        parentRevision: Number(row.parent_revision),
        ...(row.rebased_from !== null && row.rebased_from !== undefined
          ? { rebasedFrom: Number(row.rebased_from) }
          : {}),
        author: {
          type: row.author_type,
          id: row.author_id,
          ...(row.author_client ? { client: row.author_client } : {}),
          ...(row.author_on_behalf_of ? { onBehalfOf: row.author_on_behalf_of } : {}),
        },
        summary: row.summary,
        semanticHash: row.semantic_hash,
        createdAt: row.created_at,
        opCount: parsedOps.length,
        ops: parsedOps,
      };
    });

    const nextBeforeRevision =
      hasMore && revisions.length > 0 ? revisions[revisions.length - 1]!.revision : null;

    return {
      project,
      revisions,
      hasMore,
      nextBeforeRevision,
    };
  }

  public getDiff(
    project: string,
    fromRevision: number,
    toRevision: number,
  ):
    | { ok: true; status: 200; data: SemanticDiffPayload }
    | { ok: false; status: 404; error: { code: string; message: string } } {
    this.ensureTables();
    const stateA = this.getStateAtRevision(project, fromRevision);
    if (!stateA) {
      return {
        ok: false,
        status: 404,
        error: {
          code: "REVISION_NOT_FOUND",
          message: `revision ${fromRevision} not found`,
        },
      };
    }

    const stateB = this.getStateAtRevision(project, toRevision);
    if (!stateB) {
      return {
        ok: false,
        status: 404,
        error: {
          code: "REVISION_NOT_FOUND",
          message: `revision ${toRevision} not found`,
        },
      };
    }

    return {
      ok: true,
      status: 200,
      data: {
        project,
        fromRevision,
        toRevision,
        fromSemanticHash: stateA.semanticHash,
        toSemanticHash: stateB.semanticHash,
        diff: computeSemanticDiff(stateA.state, stateB.state),
      },
    };
  }

  public async revertToRevision(input: RevertInput): Promise<ApplyBatchOutcome> {
    this.ensureTables();

    const metaRows = this.ctx.storage.sql
      .exec<{
        project_id: string;
        current_revision: number;
        current_state: string;
      }>("SELECT project_id, current_revision, current_state FROM project_meta LIMIT 1")
      .toArray();

    const meta = metaRows[0];
    const currentRevision = meta ? Number(meta.current_revision) : 0;
    const currentState = meta
      ? (JSON.parse(meta.current_state) as BlueprintState)
      : createEmptyBlueprint(input.project);

    if (input.baseRevision !== undefined && input.baseRevision !== currentRevision) {
      return {
        ok: false,
        status: 409,
        error: {
          code: "CONFLICT",
          message: `Base revision ${input.baseRevision} does not match current revision ${currentRevision}`,
          baseRevision: input.baseRevision,
          currentRevision,
          conflicts: [],
          currentState,
          interveningOps: [],
        },
      };
    }

    if (
      !Number.isInteger(input.targetRevision) ||
      input.targetRevision < 0 ||
      input.targetRevision >= currentRevision
    ) {
      return {
        ok: false,
        status: 422,
        error: {
          code: "VALIDATION_FAILED",
          issues: [
            {
              code: "INVALID_TARGET_REVISION",
              path: "targetRevision",
              message: `targetRevision ${input.targetRevision} must be an integer between 0 and ${Math.max(0, currentRevision - 1)} (currentRevision is ${currentRevision})`,
              suggestedFix: `Provide a targetRevision < ${currentRevision}`,
            },
          ],
        },
      };
    }

    if (input.targetRevision > 0) {
      const targetExists = this.ctx.storage.sql
        .exec<{ revision: number }>(
          "SELECT revision FROM revisions WHERE revision = ? LIMIT 1",
          input.targetRevision,
        )
        .toArray();
      if (!targetExists[0]) {
        return {
          ok: false,
          status: 422,
          error: {
            code: "VALIDATION_FAILED",
            issues: [
              {
                code: "REVISION_NOT_FOUND",
                path: "targetRevision",
                message: `targetRevision ${input.targetRevision} does not exist`,
                suggestedFix: "Choose an existing revision from GET /revisions",
              },
            ],
          },
        };
      }
    }

    const revRows = this.ctx.storage.sql
      .exec<{
        revision: number;
        inverse_ops_json: string;
      }>(
        `SELECT revision, inverse_ops_json
         FROM revisions
         WHERE revision > ? AND revision <= ?
         ORDER BY revision DESC`,
        input.targetRevision,
        currentRevision,
      )
      .toArray();

    const nextRevision = currentRevision + 1;
    const revertOps: Op[] = [];
    let idx = 0;
    for (const row of revRows) {
      const rowInverseOps = JSON.parse(row.inverse_ops_json) as Op[];
      for (const invOp of rowInverseOps) {
        idx += 1;
        revertOps.push({
          ...invOp,
          opId: `revert-r${nextRevision}-to-r${input.targetRevision}-${idx}`,
        });
      }
    }

    return this.applyBatch({
      project: input.project,
      ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
      ...(input.callerRole !== undefined ? { callerRole: input.callerRole } : {}),
      baseRevision: currentRevision,
      author: input.author,
      summary: `Revert to revision ${input.targetRevision}`,
      ops: revertOps,
    });
  }

  public getSnapshots(): SnapshotRecord[] {
    this.ensureTables();
    const rows = this.ctx.storage.sql
      .exec<{
        revision: number;
        state_json: string;
        semantic_hash: string;
        created_at: string;
      }>("SELECT revision, state_json, semantic_hash, created_at FROM snapshots ORDER BY revision ASC")
      .toArray();

    return rows.map((row) => ({
      revision: Number(row.revision),
      state: JSON.parse(row.state_json) as BlueprintState,
      semanticHash: row.semantic_hash,
      createdAt: row.created_at,
    }));
  }

  public async applyBatch(input: ApplyOpsInput): Promise<ApplyBatchOutcome> {
    this.ensureTables();

    if (!Array.isArray(input.ops) || input.ops.length === 0) {
      return {
        ok: false,
        status: 422,
        error: {
          code: "VALIDATION_FAILED",
          issues: [
            {
              code: "EMPTY_OPS",
              path: "ops",
              message: "ops array must contain at least one operation",
              suggestedFix: "Provide at least one operation in ops",
            },
          ],
        },
      };
    }

    const txResult = this.ctx.storage.transactionSync(
      (): ApplyBatchOutcome & { updatedAt?: string; committedOps?: Op[] } => {
      // 1. Check idempotent retry: if every op in the batch has an opId already recorded in committed_ops
      const incomingOpIds = input.ops.map((raw) =>
        raw && typeof raw === "object" && typeof (raw as { opId?: unknown }).opId === "string"
          ? (raw as { opId: string }).opId.trim()
          : "",
      );

      if (incomingOpIds.every((id) => id.length > 0)) {
        const committedRevisions: number[] = [];
        let allAlreadyCommitted = true;
        for (const opId of incomingOpIds) {
          const rows = this.ctx.storage.sql
            .exec<{ revision: number }>(
              "SELECT revision FROM committed_ops WHERE op_id = ? LIMIT 1",
              opId,
            )
            .toArray();
          if (rows[0]) {
            committedRevisions.push(Number(rows[0].revision));
          } else {
            allAlreadyCommitted = false;
            break;
          }
        }

        if (allAlreadyCommitted && committedRevisions.length > 0) {
          const committedRev = Math.max(...committedRevisions);
          const existing = this.getStateAtRevision(input.project, committedRev);
          if (existing) {
            return {
              ok: true,
              status: 200,
              idempotent: true,
              data: {
                project: existing.project,
                revision: existing.revision,
                parentRevision: existing.parentRevision ?? Math.max(0, existing.revision - 1),
                ...(existing.rebasedFrom !== undefined ? { rebasedFrom: existing.rebasedFrom } : {}),
                author: existing.author ?? input.author,
                summary: existing.summary ?? generateBatchSummary(input.ops as Op[]),
                state: existing.state,
                semanticHash: existing.semanticHash,
                readiness: existing.readiness,
              },
            };
          }
        }
      }

      const metaRows = this.ctx.storage.sql
        .exec<{
          project_id: string;
          org_id: string | null;
          current_revision: number;
          current_state: string;
        }>("SELECT project_id, org_id, current_revision, current_state FROM project_meta LIMIT 1")
        .toArray();

      const meta = metaRows[0];
      const currentRevision = meta ? Number(meta.current_revision) : 0;
      const currentState = meta
        ? (JSON.parse(meta.current_state) as BlueprintState)
        : createEmptyBlueprint(input.project);

      // 2. Reject if baseRevision is ahead of currentRevision
      if (input.baseRevision !== undefined && input.baseRevision > currentRevision) {
        return {
          ok: false,
          status: 409,
          error: {
            code: "CONFLICT",
            message: "Base revision is ahead of current committed revision",
            baseRevision: input.baseRevision,
            currentRevision,
            conflicts: [],
            currentState,
            interveningOps: [],
          },
        };
      }

      // 3. Parse incoming ops with OpSchema so invalid op shapes fail with 422 before rebase analysis
      const parsedIncomingOps: Op[] = [];
      for (const rawOp of input.ops) {
        const parsed = OpSchema.safeParse(rawOp);
        if (!parsed.success) {
          const appliedErr = applyOps(currentState, input.ops, catalog);
          return {
            ok: false,
            status: 422,
            error: {
              code: "VALIDATION_FAILED",
              issues: appliedErr.ok
                ? [
                    {
                      code: "INVALID_OP",
                      path: "ops",
                      message: "Invalid operation payload",
                    },
                  ]
                : appliedErr.errors,
            },
          };
        }
        parsedIncomingOps.push(parsed.data as Op);
      }

      // 4. Stale baseRevision: check target overlap and auto-rebase if disjoint
      let rebasedFrom: number | undefined;
      if (input.baseRevision !== undefined && input.baseRevision < currentRevision) {
        const baseState =
          this.getStateAtRevision(input.project, input.baseRevision)?.state ??
          createEmptyBlueprint(input.project);

        const interveningRows = this.ctx.storage.sql
          .exec<{
            revision: number;
            author_type: "human" | "agent";
            author_id: string;
            author_client: string | null;
            ops_json: string;
          }>(
            `SELECT revision, author_type, author_id, author_client, ops_json
             FROM revisions
             WHERE revision > ? AND revision <= ?
             ORDER BY revision ASC`,
            input.baseRevision,
            currentRevision,
          )
          .toArray();

        const touchedTargets = new Map<
          string,
          { revision: number; author: AuthorAttribution; opId: string }
        >();
        const interveningOps: InterveningOpRecord[] = [];

        for (const row of interveningRows) {
          const revNum = Number(row.revision);
          const rowAuthor: AuthorAttribution = {
            type: row.author_type,
            id: row.author_id,
            ...(row.author_client ? { client: row.author_client } : {}),
          };
          const rowOps = JSON.parse(row.ops_json) as Op[];
          for (const committedOp of rowOps) {
            interveningOps.push({
              ...committedOp,
              revision: revNum,
              author: rowAuthor,
            });
            const keys = collectOpTargets(committedOp, baseState, currentState);
            for (const key of keys) {
              touchedTargets.set(key, {
                revision: revNum,
                author: rowAuthor,
                opId: committedOp.opId,
              });
            }
          }
        }

        const conflicts: ConflictDetail[] = [];
        for (const incomingOp of parsedIncomingOps) {
          const keys = collectOpTargets(incomingOp, baseState, currentState);
          for (const key of keys) {
            const hit = touchedTargets.get(key);
            if (hit) {
              conflicts.push({
                opId: incomingOp.opId,
                target: key,
                conflictingRevision: hit.revision,
                conflictingAuthor: hit.author,
              });
              break;
            }
          }
        }

        if (conflicts.length > 0) {
          return {
            ok: false,
            status: 409,
            error: {
              code: "CONFLICT",
              message: "Base revision is stale and changes overlap with committed revisions",
              baseRevision: input.baseRevision,
              currentRevision,
              conflicts,
              currentState,
              interveningOps,
            },
          };
        }

        const rebasedApplied = applyOps(currentState, input.ops, catalog);
        if (!rebasedApplied.ok) {
          const lastIntervening = interveningRows[interveningRows.length - 1];
          const fallbackRevision = lastIntervening
            ? Number(lastIntervening.revision)
            : currentRevision;
          const fallbackAuthor: AuthorAttribution = lastIntervening
            ? {
                type: lastIntervening.author_type,
                id: lastIntervening.author_id,
                ...(lastIntervening.author_client
                  ? { client: lastIntervening.author_client }
                  : {}),
              }
            : { type: "human", id: "unknown" };

          const semanticConflicts: ConflictDetail[] = parsedIncomingOps.map((op) => {
            const keys = collectOpTargets(op, baseState, currentState);
            return {
              opId: op.opId,
              target: keys[0] ?? op.type,
              conflictingRevision: fallbackRevision,
              conflictingAuthor: fallbackAuthor,
            };
          });

          return {
            ok: false,
            status: 409,
            error: {
              code: "CONFLICT",
              message: "Base revision is stale and rebased operations failed validation against current state",
              baseRevision: input.baseRevision,
              currentRevision,
              conflicts: semanticConflicts,
              currentState,
              interveningOps,
              issues: rebasedApplied.errors,
            },
          };
        }

        rebasedFrom = input.baseRevision;
      }

      const applied = applyOps(currentState, input.ops, catalog);
      if (!applied.ok) {
        return {
          ok: false,
          status: 422,
          error: {
            code: "VALIDATION_FAILED",
            issues: applied.errors,
          },
        };
      }

      const nowIso = new Date().toISOString();
      const summary =
        input.summary && input.summary.trim().length > 0
          ? input.summary.trim()
          : generateBatchSummary(parsedIncomingOps);
      const resolvedOrgId =
        (input.orgId && input.orgId !== "org_default" ? input.orgId : meta?.org_id) ??
        input.orgId ??
        null;

      if (input.mode === "propose") {
        const proposedState = applied.state;
        const proposedReadiness = computeReadiness(
          proposedState,
          catalog,
          catalogNodeRegistry,
        );
        const diff = computeSemanticDiff(currentState, proposedState);
        const proposalId =
          input.proposalId && input.proposalId.trim().length > 0
            ? input.proposalId.trim()
            : `prop_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

        if (!meta) {
          const initialHash = semanticHash(currentState);
          this.ctx.storage.sql.exec(
            `INSERT INTO project_meta (project_id, org_id, current_revision, current_state, semantic_hash, updated_at)
             VALUES (?, ?, 0, ?, ?, ?)
             ON CONFLICT(project_id) DO NOTHING`,
            input.project,
            resolvedOrgId,
            JSON.stringify(currentState),
            initialHash,
            nowIso,
          );
        }

        this.ctx.storage.sql.exec(
          `INSERT INTO proposals (
            proposal_id, project, base_rev, actor_json, ops_json, summary, status,
            diff_json, proposed_state_json, proposed_readiness_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          proposalId,
          input.project,
          currentRevision,
          JSON.stringify(input.author),
          JSON.stringify(parsedIncomingOps),
          summary,
          JSON.stringify(diff),
          JSON.stringify(proposedState),
          JSON.stringify(proposedReadiness),
          nowIso,
        );

        const proposalRecord: ProposalRecord = {
          proposalId,
          project: input.project,
          baseRev: currentRevision,
          actor: input.author,
          ops: parsedIncomingOps,
          summary,
          status: "pending",
          diff,
          proposedState,
          proposedReadiness,
          createdAt: nowIso,
          reviewedAt: null,
          reviewedBy: null,
          rejectionReason: null,
          acceptedRev: null,
          acceptedOpIds: null,
        };

        const currentSemanticHash = semanticHash(currentState);
        const currentReadiness = computeReadiness(
          currentState,
          catalog,
          catalogNodeRegistry,
        );

        return {
          ok: true,
          status: 200,
          updatedAt: nowIso,
          committedOps: parsedIncomingOps,
          data: {
            project: input.project,
            ...(resolvedOrgId ? { orgId: resolvedOrgId } : {}),
            revision: currentRevision,
            parentRevision: currentRevision,
            ...(rebasedFrom !== undefined ? { rebasedFrom } : {}),
            author: input.author,
            summary,
            state: currentState,
            semanticHash: currentSemanticHash,
            readiness: currentReadiness,
            mode: "propose",
            status: "pending",
            proposalId,
            proposal: proposalRecord,
            diff,
            proposedState,
            proposedReadiness,
          },
        };
      }

      const parentRevision = currentRevision;
      const nextRevision = currentRevision + 1;
      const nextState = applied.state;
      const nextStateJson = JSON.stringify(nextState);
      const nextSemanticHash = semanticHash(nextState);

      this.ctx.storage.sql.exec(
        `INSERT INTO revisions (
          revision, parent_revision, rebased_from, author_type, author_id, author_client,
          author_on_behalf_of, summary, ops_json, inverse_ops_json, semantic_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nextRevision,
        parentRevision,
        rebasedFrom ?? null,
        input.author.type,
        input.author.id,
        input.author.client ?? null,
        input.author.onBehalfOf ?? null,
        summary,
        JSON.stringify(input.ops),
        JSON.stringify(applied.inverseOps),
        nextSemanticHash,
        nowIso,
      );

      for (const op of parsedIncomingOps) {
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO committed_ops (op_id, revision) VALUES (?, ?)`,
          op.opId,
          nextRevision,
        );
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO project_meta (project_id, org_id, current_revision, current_state, semantic_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           org_id = COALESCE(excluded.org_id, project_meta.org_id),
           current_revision = excluded.current_revision,
           current_state = excluded.current_state,
           semantic_hash = excluded.semantic_hash,
           updated_at = excluded.updated_at`,
        input.project,
        resolvedOrgId,
        nextRevision,
        nextStateJson,
        nextSemanticHash,
        nowIso,
      );

      if (nextRevision % 50 === 0) {
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO snapshots (revision, state_json, semantic_hash, created_at)
           VALUES (?, ?, ?, ?)`,
          nextRevision,
          nextStateJson,
          nextSemanticHash,
          nowIso,
        );
      }

      const readiness = computeReadiness(nextState, catalog, catalogNodeRegistry);
      return {
        ok: true,
        status: 200,
        updatedAt: nowIso,
        committedOps: parsedIncomingOps,
        data: {
          project: input.project,
          ...(resolvedOrgId ? { orgId: resolvedOrgId } : {}),
          revision: nextRevision,
          parentRevision,
          ...(rebasedFrom !== undefined ? { rebasedFrom } : {}),
          author: input.author,
          summary,
          state: nextState,
          semanticHash: nextSemanticHash,
          readiness,
          mode: "apply",
        },
      };
    });

    if (!txResult.ok) {
      return txResult;
    }

    if (txResult.data.mode === "propose" && txResult.data.proposal) {
      this.broadcastProposalEvent("created", txResult.data.proposal);
      return {
        ok: true,
        status: 200,
        data: txResult.data,
      };
    }

    if (!txResult.idempotent) {
      const timestamp = txResult.updatedAt ?? new Date().toISOString();
      const db = this.env.STUDIO_DB;
      if (db) {
        await ensureStudioD1Schema(db);
        const orgId =
          (txResult.data as { orgId?: string }).orgId ?? input.orgId ?? "org_default";
        await db
          .prepare(
            `INSERT INTO projects (project_id, org_id, current_revision, semantic_hash, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET
               current_revision = excluded.current_revision,
               semantic_hash = excluded.semantic_hash,
               updated_at = excluded.updated_at`,
          )
          .bind(
            txResult.data.project,
            orgId,
            txResult.data.revision,
            txResult.data.semanticHash,
            timestamp,
          )
          .run();
      }

      this.broadcastRevision({
        type: "revision",
        project: txResult.data.project,
        revision: txResult.data.revision,
        parentRevision: txResult.data.parentRevision,
        ops: txResult.committedOps ?? (input.ops as Op[]),
        author: txResult.data.author,
        summary: txResult.data.summary,
        semanticHash: txResult.data.semanticHash,
        readiness: txResult.data.readiness,
        timestamp,
      });
    }

    return {
      ok: true,
      status: 200,
      ...(txResult.idempotent ? { idempotent: true } : {}),
      data: txResult.data,
    };
  }

  private broadcastRevision(envelope: {
    type: "revision";
    project: string;
    revision: number;
    parentRevision: number;
    ops: Op[];
    author: AuthorAttribution;
    summary: string;
    semanticHash: string;
    readiness: ReadinessResult;
    timestamp: string;
  }): void {
    const payload = JSON.stringify(envelope);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Ignore send errors on closed/closing WebSockets
      }
    }
  }

  private broadcastProposalEvent(
    action: "created" | "accepted" | "partially_accepted" | "rejected",
    proposal: ProposalRecord,
    revision?: number,
  ): void {
    const payload = JSON.stringify({
      type: "proposal",
      action,
      project: proposal.project,
      proposal,
      ...(revision !== undefined ? { revision } : {}),
      timestamp: proposal.reviewedAt ?? proposal.createdAt,
    });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Ignore send errors on closed/closing WebSockets
      }
    }
  }

  private rowToProposalRecord(row: {
    proposal_id: string;
    project: string;
    base_rev: number;
    actor_json: string;
    ops_json: string;
    summary: string;
    status: string;
    diff_json: string;
    proposed_state_json: string;
    proposed_readiness_json: string;
    created_at: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
    rejection_reason: string | null;
    accepted_rev: number | null;
    accepted_op_ids_json: string | null;
  }): ProposalRecord {
    return {
      proposalId: row.proposal_id,
      project: row.project,
      baseRev: Number(row.base_rev),
      actor: JSON.parse(row.actor_json) as AuthorAttribution,
      ops: JSON.parse(row.ops_json) as Op[],
      summary: row.summary,
      status: row.status as ProposalStatus,
      diff: JSON.parse(row.diff_json) as SemanticDiff,
      proposedState: JSON.parse(row.proposed_state_json) as BlueprintState,
      proposedReadiness: JSON.parse(row.proposed_readiness_json) as ReadinessResult,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at ?? null,
      reviewedBy: row.reviewed_by
        ? (JSON.parse(row.reviewed_by) as AuthorAttribution)
        : null,
      rejectionReason: row.rejection_reason ?? null,
      acceptedRev:
        row.accepted_rev !== null && row.accepted_rev !== undefined
          ? Number(row.accepted_rev)
          : null,
      acceptedOpIds: row.accepted_op_ids_json
        ? (JSON.parse(row.accepted_op_ids_json) as string[])
        : null,
    };
  }

  public listProposals(project: string, statusFilter?: string): ProposalRecord[] {
    this.ensureTables();
    type ProposalSqlRow = Parameters<BlueprintDO["rowToProposalRecord"]>[0];
    const rows = statusFilter
      ? this.ctx.storage.sql
          .exec<ProposalSqlRow>(
            `SELECT proposal_id, project, base_rev, actor_json, ops_json, summary, status,
                    diff_json, proposed_state_json, proposed_readiness_json, created_at,
                    reviewed_at, reviewed_by, rejection_reason, accepted_rev, accepted_op_ids_json
             FROM proposals
             WHERE project = ? AND status = ?
             ORDER BY created_at DESC, rowid DESC`,
            project,
            statusFilter,
          )
          .toArray()
      : this.ctx.storage.sql
          .exec<ProposalSqlRow>(
            `SELECT proposal_id, project, base_rev, actor_json, ops_json, summary, status,
                    diff_json, proposed_state_json, proposed_readiness_json, created_at,
                    reviewed_at, reviewed_by, rejection_reason, accepted_rev, accepted_op_ids_json
             FROM proposals
             WHERE project = ?
             ORDER BY created_at DESC, rowid DESC`,
            project,
          )
          .toArray();
    return rows.map((r) => this.rowToProposalRecord(r));
  }

  public getProposal(project: string, proposalId: string): ProposalRecord | null {
    this.ensureTables();
    type ProposalSqlRow = Parameters<BlueprintDO["rowToProposalRecord"]>[0];
    const rows = this.ctx.storage.sql
      .exec<ProposalSqlRow>(
        `SELECT proposal_id, project, base_rev, actor_json, ops_json, summary, status,
                diff_json, proposed_state_json, proposed_readiness_json, created_at,
                reviewed_at, reviewed_by, rejection_reason, accepted_rev, accepted_op_ids_json
         FROM proposals
         WHERE project = ? AND proposal_id = ?
         LIMIT 1`,
        project,
        proposalId,
      )
      .toArray();
    return rows[0] ? this.rowToProposalRecord(rows[0]) : null;
  }

  public async acceptProposal(
    input: AcceptProposalInput,
  ): Promise<
    | ApplyBatchOutcome
    | { ok: false; status: 404 | 409; error: { code: string; message: string } }
  > {
    this.ensureTables();
    const proposal = this.getProposal(input.project, input.proposalId);
    if (!proposal) {
      return {
        ok: false,
        status: 404,
        error: {
          code: "PROPOSAL_NOT_FOUND",
          message: `Proposal "${input.proposalId}" not found for project "${input.project}"`,
        },
      };
    }

    if (proposal.status !== "pending") {
      return {
        ok: false,
        status: 409,
        error: {
          code: "PROPOSAL_ALREADY_REVIEWED",
          message: `Proposal "${input.proposalId}" has already been reviewed (status: ${proposal.status})`,
        },
      };
    }

    const current = this.getProjectState(input.project);
    const evaluated = evaluateProposalSelection(
      current.state,
      proposal.ops,
      input.opIds,
      catalog,
      catalogNodeRegistry,
    );
    if (!evaluated.ok) {
      return {
        ok: false,
        status: 422,
        error: evaluated.error,
      };
    }

    const commitAuthor: AuthorAttribution = {
      ...proposal.actor,
      ...(input.reviewer.id ? { onBehalfOf: input.reviewer.id } : {}),
    };
    const commitSummary = evaluated.isPartial
      ? `${proposal.summary} (${evaluated.selectedOps.length}/${proposal.ops.length} ops accepted)`
      : proposal.summary;

    const batchOutcome = await this.applyBatch({
      project: input.project,
      ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
      ...(input.callerRole !== undefined ? { callerRole: input.callerRole } : {}),
      baseRevision: current.revision,
      author: commitAuthor,
      summary: commitSummary,
      ops: evaluated.selectedOps,
      mode: "apply",
    });

    if (!batchOutcome.ok) {
      return batchOutcome;
    }

    const nextStatus: ProposalStatus = evaluated.isPartial
      ? "partially_accepted"
      : "accepted";
    const reviewedAt = new Date().toISOString();

    this.ctx.storage.sql.exec(
      `UPDATE proposals
       SET status = ?,
           reviewed_at = ?,
           reviewed_by = ?,
           accepted_rev = ?,
           accepted_op_ids_json = ?
       WHERE project = ? AND proposal_id = ?`,
      nextStatus,
      reviewedAt,
      JSON.stringify(input.reviewer),
      batchOutcome.data.revision,
      JSON.stringify(evaluated.selectedOpIds),
      input.project,
      input.proposalId,
    );

    const updatedProposal =
      this.getProposal(input.project, input.proposalId) ?? {
        ...proposal,
        status: nextStatus,
        reviewedAt,
        reviewedBy: input.reviewer,
        acceptedRev: batchOutcome.data.revision,
        acceptedOpIds: evaluated.selectedOpIds,
      };

    this.broadcastProposalEvent(
      nextStatus,
      updatedProposal,
      batchOutcome.data.revision,
    );

    return {
      ok: true,
      status: 200,
      data: {
        ...batchOutcome.data,
        status: nextStatus,
        proposalId: updatedProposal.proposalId,
        proposal: updatedProposal,
      },
    };
  }

  public async rejectProposal(
    input: RejectProposalInput,
  ): Promise<
    | {
        ok: true;
        status: 200;
        data: {
          project: string;
          revision: number;
          status: ProposalStatus;
          proposalId: string;
          proposal: ProposalRecord;
        };
      }
    | { ok: false; status: 404 | 409; error: { code: string; message: string } }
  > {
    this.ensureTables();
    const proposal = this.getProposal(input.project, input.proposalId);
    if (!proposal) {
      return {
        ok: false,
        status: 404,
        error: {
          code: "PROPOSAL_NOT_FOUND",
          message: `Proposal "${input.proposalId}" not found for project "${input.project}"`,
        },
      };
    }

    if (proposal.status !== "pending") {
      return {
        ok: false,
        status: 409,
        error: {
          code: "PROPOSAL_ALREADY_REVIEWED",
          message: `Proposal "${input.proposalId}" has already been reviewed (status: ${proposal.status})`,
        },
      };
    }

    const reviewedAt = new Date().toISOString();
    const reason =
      input.reason && input.reason.trim().length > 0 ? input.reason.trim() : null;

    this.ctx.storage.sql.exec(
      `UPDATE proposals
       SET status = 'rejected',
           reviewed_at = ?,
           reviewed_by = ?,
           rejection_reason = ?
       WHERE project = ? AND proposal_id = ?`,
      reviewedAt,
      JSON.stringify(input.reviewer),
      reason,
      input.project,
      input.proposalId,
    );

    const current = this.getProjectState(input.project);
    const updatedProposal =
      this.getProposal(input.project, input.proposalId) ?? {
        ...proposal,
        status: "rejected" as const,
        reviewedAt,
        reviewedBy: input.reviewer,
        rejectionReason: reason,
      };

    this.broadcastProposalEvent("rejected", updatedProposal, current.revision);

    return {
      ok: true,
      status: 200,
      data: {
        project: input.project,
        revision: current.revision,
        status: "rejected",
        proposalId: updatedProposal.proposalId,
        proposal: updatedProposal,
      },
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const project = url.searchParams.get("project") ?? "default-project";
    const callerOrgHeader = request.headers.get("x-studio-org-id")?.trim();

    if (callerOrgHeader && url.pathname !== "/init" && url.pathname !== "/seed") {
      const existingMeta = this.getProjectState(project);
      if (existingMeta.orgId && existingMeta.orgId !== callerOrgHeader) {
        return Response.json(
          {
            error: {
              code: "FORBIDDEN_ORG",
              message: "Access denied: project belongs to another organization",
            },
          },
          { status: 403 },
        );
      }
    }

    if (request.method === "POST" && url.pathname === "/init") {
      const body = (await request.json().catch(() => ({}))) as {
        project?: string;
        orgId?: string;
      };
      const targetProject = body.project ?? project;
      const initialized = this.initProject(targetProject, body.orgId);
      return Response.json(initialized, { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const revParam = url.searchParams.get("revision");
      if (revParam !== null) {
        const revNum = Number(revParam);
        if (!Number.isInteger(revNum) || revNum < 0) {
          return Response.json(
            { error: { code: "INVALID_REVISION", message: "revision must be a non-negative integer" } },
            { status: 400 },
          );
        }
        const historical = this.getStateAtRevision(project, revNum);
        if (!historical) {
          return Response.json(
            { error: { code: "REVISION_NOT_FOUND", message: `revision ${revNum} not found` } },
            { status: 404 },
          );
        }
        return Response.json(historical, { status: 200 });
      }
      return Response.json(this.getProjectState(project), { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/summary") {
      return Response.json(this.getSummary(project), { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/revisions") {
      const limitParam = url.searchParams.get("limit");
      const beforeParam = url.searchParams.get("beforeRevision");

      let limit: number | undefined;
      if (limitParam !== null) {
        const parsedLimit = Number(limitParam);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
          return Response.json(
            { error: { code: "INVALID_LIMIT", message: "limit must be a positive integer" } },
            { status: 400 },
          );
        }
        limit = parsedLimit;
      }

      let beforeRevision: number | undefined;
      if (beforeParam !== null) {
        const parsedBefore = Number(beforeParam);
        if (!Number.isInteger(parsedBefore) || parsedBefore < 1) {
          return Response.json(
            {
              error: {
                code: "INVALID_BEFORE_REVISION",
                message: "beforeRevision must be a positive integer",
              },
            },
            { status: 400 },
          );
        }
        beforeRevision = parsedBefore;
      }

      return Response.json(
        this.listRevisions(project, {
          ...(limit !== undefined ? { limit } : {}),
          ...(beforeRevision !== undefined ? { beforeRevision } : {}),
        }),
        { status: 200 },
      );
    }

    if (request.method === "GET" && url.pathname === "/diff") {
      const fromParam = url.searchParams.get("from");
      const toParam = url.searchParams.get("to");
      if (fromParam === null || toParam === null) {
        return Response.json(
          {
            error: {
              code: "INVALID_DIFF_PARAMS",
              message: "from and to query parameters are required",
            },
          },
          { status: 400 },
        );
      }

      const fromRev = Number(fromParam);
      const toRev = Number(toParam);
      if (!Number.isInteger(fromRev) || fromRev < 0 || !Number.isInteger(toRev) || toRev < 0) {
        return Response.json(
          {
            error: {
              code: "INVALID_DIFF_PARAMS",
              message: "from and to must be non-negative integers",
            },
          },
          { status: 400 },
        );
      }

      const diffResult = this.getDiff(project, fromRev, toRev);
      if (!diffResult.ok) {
        return Response.json({ error: diffResult.error }, { status: diffResult.status });
      }
      return Response.json(diffResult.data, { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/snapshots") {
      return Response.json({ snapshots: this.getSnapshots() }, { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/proposals") {
      const proposalId = url.searchParams.get("proposalId");
      if (proposalId) {
        const proposal = this.getProposal(project, proposalId);
        if (!proposal) {
          return Response.json(
            {
              error: {
                code: "PROPOSAL_NOT_FOUND",
                message: `Proposal "${proposalId}" not found`,
              },
            },
            { status: 404 },
          );
        }
        return Response.json({ project, proposal }, { status: 200 });
      }
      const statusFilter = url.searchParams.get("status") ?? undefined;
      return Response.json(
        { project, proposals: this.listProposals(project, statusFilter) },
        { status: 200 },
      );
    }

    if (request.method === "POST" && url.pathname === "/proposals") {
      const body = (await request.json()) as ApplyOpsInput;
      const role = request.headers.get("x-studio-caller-role") ?? body.callerRole;
      if (role === "viewer") {
        return Response.json(
          { error: { code: "FORBIDDEN_ROLE", message: "Viewer role cannot mutate project" } },
          { status: 403 },
        );
      }
      const result = await this.applyBatch({ ...body, mode: "propose" });
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: result.status });
      }
      return Response.json(result.data, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/proposals/accept") {
      const body = (await request.json()) as AcceptProposalInput;
      const role = request.headers.get("x-studio-caller-role") ?? body.callerRole;
      if (role === "viewer") {
        return Response.json(
          { error: { code: "FORBIDDEN_ROLE", message: "Viewer role cannot mutate project" } },
          { status: 403 },
        );
      }
      const result = await this.acceptProposal(body);
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: result.status });
      }
      return Response.json(result.data, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/proposals/reject") {
      const body = (await request.json()) as RejectProposalInput;
      const role = request.headers.get("x-studio-caller-role") ?? body.callerRole;
      if (role === "viewer") {
        return Response.json(
          { error: { code: "FORBIDDEN_ROLE", message: "Viewer role cannot mutate project" } },
          { status: 403 },
        );
      }
      const result = await this.rejectProposal(body);
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: result.status });
      }
      return Response.json(result.data, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/ops") {
      const body = (await request.json()) as ApplyOpsInput;
      const role = request.headers.get("x-studio-caller-role") ?? body.callerRole;
      if (role === "viewer") {
        return Response.json(
          { error: { code: "FORBIDDEN_ROLE", message: "Viewer role cannot mutate project" } },
          { status: 403 },
        );
      }
      const result = await this.applyBatch(body);
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: result.status });
      }
      return Response.json(result.data, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/revert") {
      const body = (await request.json()) as RevertInput;
      const role = request.headers.get("x-studio-caller-role") ?? body.callerRole;
      if (role === "viewer") {
        return Response.json(
          { error: { code: "FORBIDDEN_ROLE", message: "Viewer role cannot mutate project" } },
          { status: 403 },
        );
      }
      const result = await this.revertToRevision(body);
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: result.status });
      }
      return Response.json(
        {
          ...result.data,
          revertedToRevision: body.targetRevision,
        },
        { status: 200 },
      );
    }

    if (request.method === "GET" && url.pathname === "/export") {
      const revParam = url.searchParams.get("revision");
      let revision: number | undefined;
      if (revParam !== null) {
        const parsedRev = Number(revParam);
        if (!Number.isInteger(parsedRev) || parsedRev < 0) {
          return Response.json(
            {
              error: {
                code: "INVALID_REVISION",
                message: "revision must be a non-negative integer",
              },
            },
            { status: 400 },
          );
        }
        revision = parsedRev;
      }

      const exportRes = this.exportBundle(project, revision);
      if (!exportRes.ok) {
        return Response.json({ error: exportRes.error }, { status: exportRes.status });
      }
      return Response.json(exportRes.data, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/import") {
      const body = (await request.json()) as ImportBundleInput;
      const role = request.headers.get("x-studio-caller-role") ?? body.callerRole;
      if (role === "viewer") {
        return Response.json(
          { error: { code: "FORBIDDEN_ROLE", message: "Viewer role cannot mutate project" } },
          { status: 403 },
        );
      }
      const result = await this.importBundle(body);
      if (!result.ok) {
        return Response.json({ error: result.error }, { status: result.status });
      }
      return Response.json(result.data, { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/seed") {
      this.ensureTables();
      const body = (await request.json()) as {
        project: string;
        state: BlueprintState;
        revision?: number;
      };
      const seedRev = body.revision ?? 1;
      const seedHash = semanticHash(body.state);
      const nowIso = new Date().toISOString();
      const stateJson = JSON.stringify(body.state);
      this.ctx.storage.sql.exec("DELETE FROM revisions");
      this.ctx.storage.sql.exec("DELETE FROM snapshots");
      this.ctx.storage.sql.exec("DELETE FROM committed_ops");
      this.ctx.storage.sql.exec(
        `INSERT INTO project_meta (project_id, org_id, current_revision, current_state, semantic_hash, updated_at)
         VALUES (?, 'org_default', ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           current_revision = excluded.current_revision,
           current_state = excluded.current_state,
           semantic_hash = excluded.semantic_hash,
           updated_at = excluded.updated_at`,
        body.project,
        seedRev,
        stateJson,
        seedHash,
        nowIso,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO revisions (
          revision, parent_revision, author_type, author_id, summary, ops_json, inverse_ops_json, semantic_hash, created_at
        ) VALUES (?, ?, 'human', 'eval:seed', 'Seed evaluation blueprint', '[]', '[]', ?, ?)`,
        seedRev,
        Math.max(0, seedRev - 1),
        seedHash,
        nowIso,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO snapshots (revision, state_json, semantic_hash, created_at) VALUES (?, ?, ?, ?)`,
        seedRev,
        stateJson,
        seedHash,
        nowIso,
      );
      return Response.json({ revision: seedRev, semanticHash: seedHash }, { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/ws") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return Response.json(
          {
            error: {
              code: "UPGRADE_REQUIRED",
              message: "Expected Upgrade: websocket header",
            },
          },
          { status: 426 },
        );
      }

      const sinceParam = url.searchParams.get("sinceRevision");
      let sinceRevision: number | undefined;
      if (sinceParam !== null) {
        const parsedSince = Number(sinceParam);
        if (!Number.isInteger(parsedSince) || parsedSince < 0) {
          return Response.json(
            {
              error: {
                code: "INVALID_REVISION",
                message: "sinceRevision must be a non-negative integer",
              },
            },
            { status: 400 },
          );
        }
        sinceRevision = parsedSince;
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server, [project]);
      server.serializeAttachment({ project });

      const current = this.getProjectState(project);
      server.send(
        JSON.stringify({
          type: "connected",
          project,
          currentRevision: current.revision,
          semanticHash: current.semanticHash,
          readiness: current.readiness,
        }),
      );

      if (sinceRevision !== undefined && sinceRevision < current.revision) {
        const missedRows = this.ctx.storage.sql
          .exec<{
            revision: number;
            parent_revision: number;
            author_type: "human" | "agent";
            author_id: string;
            author_client: string | null;
            author_on_behalf_of: string | null;
            summary: string;
            ops_json: string;
            semantic_hash: string;
            created_at: string;
          }>(
            `SELECT revision, parent_revision, author_type, author_id, author_client, author_on_behalf_of, summary, ops_json, semantic_hash, created_at
             FROM revisions
             WHERE revision > ? AND revision <= ?
             ORDER BY revision ASC`,
            sinceRevision,
            current.revision,
          )
          .toArray();

        const revisions = missedRows.map((row) => ({
          revision: Number(row.revision),
          parentRevision: Number(row.parent_revision),
          ops: JSON.parse(row.ops_json) as Op[],
          author: {
            type: row.author_type,
            id: row.author_id,
            ...(row.author_client ? { client: row.author_client } : {}),
            ...(row.author_on_behalf_of ? { onBehalfOf: row.author_on_behalf_of } : {}),
          },
          summary: row.summary,
          semanticHash: row.semantic_hash,
          timestamp: row.created_at,
        }));

        server.send(
          JSON.stringify({
            type: "catchup",
            fromRevision: sinceRevision,
            toRevision: current.revision,
            revisions,
          }),
        );
      }

      return createWebSocketUpgradeResponse(client);
    }

    if (request.method === "POST" && url.pathname === "/telemetry") {
      const body = (await request.json()) as TelemetryWebhookPayload & { project?: string };
      const targetProject = body.project ?? project;
      const result = this.ingestTelemetry(targetProject, body);
      return Response.json(result, { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/telemetry") {
      const runIdParam = url.searchParams.get("runId") ?? undefined;
      return Response.json(this.listTelemetry(project, runIdParam), { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/pins") {
      const workflowId = url.searchParams.get("workflowId") ?? undefined;
      if (workflowId) {
        return Response.json(
          {
            project,
            workflowId,
            pinnedOutputs: this.getWorkflowPinnedOutputs(workflowId),
          },
          { status: 200 },
        );
      }
      return Response.json(
        {
          project,
          pinnedOutputsByWorkflow: this.getAllPinnedOutputs(),
        },
        { status: 200 },
      );
    }

    if (request.method === "PUT" && url.pathname === "/pins") {
      const body = (await request.json()) as {
        project?: string;
        workflowId: string;
        nodeId: string;
        output: unknown;
        sourceRunId?: string | null;
        pinnedAt?: string;
      };
      const pin = this.setPinnedOutput(body.workflowId, body.nodeId, {
        output: body.output,
        sourceRunId: body.sourceRunId ?? null,
        ...(body.pinnedAt ? { pinnedAt: body.pinnedAt } : {}),
      });
      return Response.json(
        {
          ok: true,
          project: body.project ?? project,
          workflowId: body.workflowId,
          nodeId: body.nodeId,
          pin,
          pinnedOutputs: this.getWorkflowPinnedOutputs(body.workflowId),
        },
        { status: 200 },
      );
    }

    if (request.method === "DELETE" && url.pathname === "/pins") {
      const workflowId = url.searchParams.get("workflowId") ?? "";
      const nodeId = url.searchParams.get("nodeId") ?? "";
      if (workflowId && nodeId) {
        this.deletePinnedOutput(workflowId, nodeId);
      }
      return Response.json(
        {
          ok: true,
          project,
          workflowId,
          nodeId,
          pinnedOutputs: workflowId
            ? this.getWorkflowPinnedOutputs(workflowId)
            : {},
        },
        { status: 200 },
      );
    }

    if (request.method === "POST" && url.pathname === "/deploy-broadcast") {
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const frame = {
        type: "deploy" as const,
        project,
        ...body,
        timestamp:
          typeof body.timestamp === "string"
            ? body.timestamp
            : new Date().toISOString(),
      };
      const serialized = JSON.stringify(frame);
      const sockets = this.ctx.getWebSockets(project);
      const allSockets =
        sockets.length > 0 ? sockets : this.ctx.getWebSockets();
      let broadcastedCount = 0;
      for (const ws of allSockets) {
        try {
          ws.send(serialized);
          broadcastedCount += 1;
        } catch {
          // Ignore closed socket errors
        }
      }
      return Response.json(
        { ok: true, project, broadcastedCount, frame },
        { status: 200 },
      );
    }

    if (request.method === "POST" && url.pathname === "/log-broadcast") {
      const body = (await request.json().catch(() => ({}))) as {
        envName?: string;
        entry?: unknown;
        entries?: unknown[];
      };
      const entries = Array.isArray(body.entries)
        ? body.entries
        : body.entry
          ? [body.entry]
          : [];
      const envName = typeof body.envName === "string" ? body.envName : "preview";
      const sockets = this.ctx.getWebSockets(project);
      const allSockets =
        sockets.length > 0 ? sockets : this.ctx.getWebSockets();
      let broadcastedCount = 0;
      const frames: Array<Record<string, unknown>> = [];
      for (const entry of entries) {
        const frame = {
          type: "log" as const,
          project,
          envName,
          entry,
        };
        frames.push(frame);
        const serialized = JSON.stringify(frame);
        for (const ws of allSockets) {
          try {
            ws.send(serialized);
            broadcastedCount += 1;
          } catch {
            // Ignore closed socket errors
          }
        }
      }
      return Response.json(
        { ok: true, project, envName, broadcastedCount, frames },
        { status: 200 },
      );
    }

    if (request.method === "GET" && url.pathname === "/sqlite-dump") {
      this.ensureTables();
      return Response.json(
        {
          project,
          project_meta: this.ctx.storage.sql
            .exec<Record<string, unknown>>("SELECT * FROM project_meta")
            .toArray(),
          revisions: this.ctx.storage.sql
            .exec<Record<string, unknown>>("SELECT * FROM revisions ORDER BY revision ASC")
            .toArray(),
          snapshots: this.ctx.storage.sql
            .exec<Record<string, unknown>>("SELECT * FROM snapshots ORDER BY revision ASC")
            .toArray(),
          committed_ops: this.ctx.storage.sql
            .exec<Record<string, unknown>>("SELECT * FROM committed_ops")
            .toArray(),
          telemetry_runs: this.ctx.storage.sql
            .exec<Record<string, unknown>>("SELECT * FROM telemetry_runs")
            .toArray(),
          telemetry_events: this.ctx.storage.sql
            .exec<Record<string, unknown>>("SELECT * FROM telemetry_events ORDER BY seq ASC")
            .toArray(),
          pinned_outputs: this.ctx.storage.sql
            .exec<Record<string, unknown>>("SELECT * FROM pinned_outputs")
            .toArray(),
        },
        { status: 200 },
      );
    }

    return Response.json({ error: { code: "NOT_FOUND", message: "Unknown DO route" } }, { status: 404 });
  }

  public ingestTelemetry(
    project: string,
    payload: TelemetryWebhookPayload,
  ): {
    ok: true;
    project: string;
    ingestedEvents: number;
    broadcastedCount: number;
    frames: TelemetryWsFrame[];
  } {
    this.ensureTables();
    const run = payload.run;
    if (run) {
      this.ctx.storage.sql.exec(
        `INSERT INTO telemetry_runs (
          run_id, workflow_id, revision, trigger_type, workspace_id, status, duration_ms, retries, retry_of_run_id, error_stack, started_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          duration_ms = excluded.duration_ms,
          retries = excluded.retries,
          error_stack = excluded.error_stack,
          ended_at = excluded.ended_at`,
        run.runId,
        run.workflowId,
        run.revision,
        run.triggerType ?? "manual",
        run.workspaceId ?? "ws_default",
        run.status,
        run.durationMs,
        run.retries ?? 0,
        run.retryOfRunId ?? null,
        run.errorStack ?? null,
        run.startedAt,
        run.endedAt ?? null,
      );
    }

    const events = payload.events ?? [];
    const frames: TelemetryWsFrame[] = [];
    const sockets = this.ctx.getWebSockets(project);
    const allSockets = sockets.length > 0 ? sockets : this.ctx.getWebSockets();
    let broadcastedCount = 0;

    for (const ev of events) {
      this.ctx.storage.sql.exec(
        `INSERT INTO telemetry_events (
          event_id, run_id, workflow_id, revision, node_id, status, duration_ms, retries, input_preview, output_preview, error_stack, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          status = excluded.status,
          duration_ms = excluded.duration_ms,
          retries = excluded.retries,
          input_preview = excluded.input_preview,
          output_preview = excluded.output_preview,
          error_stack = excluded.error_stack`,
        ev.eventId,
        ev.runId,
        ev.workflowId,
        ev.revision,
        ev.nodeId,
        ev.status,
        ev.durationMs,
        ev.retries ?? 0,
        ev.inputPreview,
        ev.outputPreview,
        ev.errorStack ?? null,
        ev.createdAt,
      );

      const frame: TelemetryWsFrame = {
        type: "telemetry",
        project,
        rev: ev.revision,
        runId: ev.runId,
        workflowId: ev.workflowId,
        nodeId: ev.nodeId,
        status: ev.status,
        durationMs: ev.durationMs,
        retries: ev.retries ?? 0,
        inputPreview: ev.inputPreview,
        outputPreview: ev.outputPreview,
        errorStack: ev.errorStack ?? null,
        ...(run?.status ? { runStatus: run.status } : {}),
        timestamp: ev.createdAt,
      };
      frames.push(frame);
      const serialized = JSON.stringify(frame);
      for (const ws of allSockets) {
        try {
          ws.send(serialized);
          broadcastedCount += 1;
        } catch {
          // Ignore closed socket errors
        }
      }
    }

    const logs = payload.logs ?? [];
    for (const logEntry of logs) {
      const logFrame = {
        type: "log" as const,
        project,
        envName: logEntry.envName ?? "preview",
        entry: logEntry,
      };
      const serialized = JSON.stringify(logFrame);
      for (const ws of allSockets) {
        try {
          ws.send(serialized);
          broadcastedCount += 1;
        } catch {
          // Ignore closed socket errors
        }
      }
    }

    return {
      ok: true,
      project,
      ingestedEvents: events.length,
      broadcastedCount,
      frames,
    };
  }

  public listTelemetry(
    project: string,
    runId?: string,
  ): {
    project: string;
    runs: RunRecord[];
    events: StepEvent[];
  } {
    this.ensureTables();
    const runRows = this.ctx.storage.sql
      .exec<{
        run_id: string;
        workflow_id: string;
        revision: number;
        trigger_type: string;
        workspace_id: string;
        status: RunRecord["status"];
        duration_ms: number;
        retries: number;
        retry_of_run_id: string | null;
        error_stack: string | null;
        started_at: string;
        ended_at: string | null;
      }>("SELECT * FROM telemetry_runs ORDER BY started_at DESC LIMIT 100")
      .toArray();

    const runs: RunRecord[] = runRows.map((r) => ({
      runId: r.run_id,
      workflowId: r.workflow_id,
      revision: Number(r.revision),
      triggerType: r.trigger_type,
      workspaceId: r.workspace_id,
      status: r.status,
      durationMs: Number(r.duration_ms),
      retries: Number(r.retries ?? 0),
      retryOfRunId: r.retry_of_run_id,
      errorStack: r.error_stack,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));

    const eventRows = runId
      ? this.ctx.storage.sql
          .exec<{
            seq: number;
            event_id: string;
            run_id: string;
            workflow_id: string;
            revision: number;
            node_id: string;
            status: StepEvent["status"];
            duration_ms: number;
            retries: number;
            input_preview: string;
            output_preview: string;
            error_stack: string | null;
            created_at: string;
          }>("SELECT * FROM telemetry_events WHERE run_id = ? ORDER BY seq ASC", runId)
          .toArray()
      : this.ctx.storage.sql
          .exec<{
            seq: number;
            event_id: string;
            run_id: string;
            workflow_id: string;
            revision: number;
            node_id: string;
            status: StepEvent["status"];
            duration_ms: number;
            retries: number;
            input_preview: string;
            output_preview: string;
            error_stack: string | null;
            created_at: string;
          }>("SELECT * FROM telemetry_events ORDER BY seq ASC LIMIT 500")
          .toArray();

    const events: StepEvent[] = eventRows.map((e) => ({
      eventId: e.event_id,
      runId: e.run_id,
      workflowId: e.workflow_id,
      revision: Number(e.revision),
      nodeId: e.node_id,
      status: e.status,
      durationMs: Number(e.duration_ms),
      retries: Number(e.retries ?? 0),
      inputPreview: e.input_preview,
      outputPreview: e.output_preview,
      errorStack: e.error_stack,
      createdAt: e.created_at,
      cursor: Number(e.seq),
    }));

    return { project, runs, events };
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(message);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      try {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "BAD_MESSAGE",
            message: "WebSocket frame must be valid JSON",
          }),
        );
      } catch {
        // Ignore send errors on closed sockets
      }
      return;
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { type?: unknown }).type === "ping"
    ) {
      try {
        ws.send(JSON.stringify({ type: "pong" }));
      } catch {
        // Ignore send errors on closed sockets
      }
      return;
    }

    try {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "BAD_MESSAGE",
          message: "Unsupported WebSocket message type; expected { type: \"ping\" }",
        }),
      );
    } catch {
      // Ignore send errors on closed sockets
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      try {
        ws.close(1000, "closed");
      } catch {
        // Ignore if already closed
      }
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      // Ignore if already closed
    }
  }

  public exportBundle(
    project: string,
    revision?: number,
  ):
    | { ok: true; status: 200; data: BlueprintBundle }
    | { ok: false; status: 404; error: { code: string; message: string } }
    | {
        ok: false;
        status: 422;
        error: { code: "VALIDATION_FAILED"; issues: BlueprintValidationError[] };
      } {
    this.ensureTables();
    const snapshot =
      revision !== undefined
        ? this.getStateAtRevision(project, revision)
        : this.getProjectState(project);

    if (!snapshot) {
      return {
        ok: false,
        status: 404,
        error: {
          code: "REVISION_NOT_FOUND",
          message: `revision ${revision} not found`,
        },
      };
    }

    try {
      const bundle = exportBlueprintBundle(snapshot.state, {
        revision: snapshot.revision,
        semanticHash: snapshot.semanticHash,
      });
      return {
        ok: true,
        status: 200,
        data: bundle,
      };
    } catch (err) {
      if (err instanceof BlueprintExportError) {
        return {
          ok: false,
          status: 422,
          error: {
            code: "VALIDATION_FAILED",
            issues: err.issues,
          },
        };
      }
      throw err;
    }
  }

  public async importBundle(input: ImportBundleInput): Promise<ApplyBatchOutcome> {
    this.ensureTables();
    const parsed = parseBlueprintBundle(input.bundle, {
      targetProject: input.project,
      catalog,
    });

    if (!parsed.ok) {
      return {
        ok: false,
        status: 422,
        error: {
          code: "VALIDATION_FAILED",
          issues: parsed.errors,
        },
      };
    }

    const current = this.getProjectState(input.project);
    if (input.mode === "create" && current.revision > 0) {
      return {
        ok: false,
        status: 409,
        error: {
          code: "CONFLICT",
          message: `Project "${input.project}" already exists at revision ${current.revision}; use mode="replace" to overwrite`,
          baseRevision: 0,
          currentRevision: current.revision,
          conflicts: [],
          currentState: current.state,
          interveningOps: [],
        },
      };
    }

    const nextRevision = current.revision + 1;
    const ops = buildImportOps(
      parsed.state,
      current.revision > 0 ? current.state : undefined,
      `import-r${nextRevision}`,
    );

    return this.applyBatch({
      project: input.project,
      ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
      ...(input.callerRole !== undefined ? { callerRole: input.callerRole } : {}),
      baseRevision: current.revision,
      author: input.author,
      summary: "Import blueprint bundle",
      ops,
    });
  }
}
