/**
 * Story 7.1 — MCP Tool Surface & Dual-Surface Parity Gate (`pnpm mcp:parity`).
 *
 * Inspects:
 * 1. Every `Op` kind in `packages/blueprint` (`OP_TYPES` / `OpSchema`).
 * 2. Every HTTP mutation and query route exposed to `apps/studio-web` in `apps/studio-api`.
 * 3. Every registered tool in `packages/mcp-server` (`TOOLS`).
 *
 * Exits 0 when every UI capability has a mapped MCP tool and every MCP mutation maps to a
 * shared `Op` or `studio-api` command, and exits 1 naming any unmapped orphan UI mutation,
 * unmapped `Op` kind, or MCP-only mutation.
 */
import { pathToFileURL } from "node:url";
import { OP_TYPES } from "../packages/blueprint/src/ops.ts";
import {
  OP_SAFETY_METADATA,
  TOOLS,
  type OpSafetyMetadata,
  type ToolAnnotations,
} from "../packages/mcp-server/src/index.ts";
import { createStudioApiApp } from "../apps/studio-api/src/index.ts";

export interface StudioRouteDescriptor {
  method: string;
  path: string;
}

export interface McpToolDescriptor {
  name: string;
  readOnly: boolean;
  annotations?: ToolAnnotations;
}

export interface UIRouteParityRule {
  method: string;
  path: string;
  category: "mapped" | "human_only_custody_or_transport";
  mappedTools?: readonly string[];
  rationale: string;
}

export interface McpToolParityMapping {
  toolName: string;
  surfaceKind: "query" | "mutation" | "consent_handoff";
  sharedTargets: readonly string[];
}

/**
 * Canonical mapping from every `apps/studio-api` HTTP route to either:
 * - One or more MCP tools in `packages/mcp-server` (`category: "mapped"`), or
 * - Explicit human-only custody / session / transport infrastructure (`category: "human_only_custody_or_transport"`).
 */
export const STUDIO_ROUTE_PARITY_RULES: ReadonlyArray<UIRouteParityRule> = [
  // Catalog discovery
  {
    method: "GET",
    path: "/api/catalog",
    category: "mapped",
    mappedTools: ["search_bricks", "get_brick", "search_nodes", "get_node"],
    rationale: "Catalog bricks and node packs are browsed via paged MCP discovery tools",
  },
  {
    method: "GET",
    path: "/api/templates",
    category: "mapped",
    mappedTools: ["search_bricks", "get_brick", "search_nodes", "get_node", "get_blueprint_summary"],
    rationale: "Starter templates are composed of catalog bricks and workflow node packs",
  },
  // Blueprint read, slice, history & validation
  {
    method: "GET",
    path: "/api/projects",
    category: "mapped",
    mappedTools: ["get_blueprint_summary"],
    rationale: "Project blueprint summary inspection",
  },
  {
    method: "POST",
    path: "/api/projects",
    category: "mapped",
    mappedTools: ["apply_ops"],
    rationale: "Project creation and starter template seeding into BlueprintDO",
  },
  {
    method: "GET",
    path: "/api/projects/:project",
    category: "mapped",
    mappedTools: ["get_blueprint_summary", "get_blueprint_slice", "validate_blueprint"],
    rationale: "Project state, slice, and readiness inspection",
  },
  {
    method: "GET",
    path: "/api/projects/:project/revisions",
    category: "mapped",
    mappedTools: ["get_blueprint_summary", "get_blueprint_slice"],
    rationale: "Blueprint revision history inspection",
  },
  {
    method: "GET",
    path: "/api/projects/:project/revisions/:revision",
    category: "mapped",
    mappedTools: ["get_blueprint_summary", "get_blueprint_slice"],
    rationale: "Historical blueprint revision state inspection",
  },
  {
    method: "GET",
    path: "/api/projects/:project/diff",
    category: "mapped",
    mappedTools: ["get_blueprint_slice", "validate_blueprint"],
    rationale: "Blueprint revision diff and validation",
  },
  {
    method: "GET",
    path: "/api/projects/:project/export",
    category: "mapped",
    mappedTools: ["get_blueprint_summary", "get_blueprint_slice"],
    rationale: "Blueprint export projection",
  },
  {
    method: "GET",
    path: "/api/projects/:project/openapi.json",
    category: "mapped",
    mappedTools: ["get_blueprint_summary", "get_blueprint_slice"],
    rationale: "Outbound OpenAPI 3.1.0 specification generated from blueprint state",
  },
  {
    method: "GET",
    path: "/api/projects/:project/snapshots",
    category: "mapped",
    mappedTools: ["get_blueprint_summary"],
    rationale: "Blueprint snapshot inspection",
  },
  // Blueprint mutations (all route through BlueprintDO Op log)
  {
    method: "POST",
    path: "/api/projects/:project/ops",
    category: "mapped",
    mappedTools: ["apply_ops"],
    rationale: "Atomic batch Op mutation with optimistic concurrency",
  },
  {
    method: "GET",
    path: "/api/projects/:project/proposals",
    category: "mapped",
    mappedTools: ["get_blueprint_summary", "get_blueprint_slice"],
    rationale: "Draft proposal queue inspection for visual diff review",
  },
  {
    method: "POST",
    path: "/api/projects/:project/proposals",
    category: "mapped",
    mappedTools: ["apply_ops"],
    rationale: "Draft proposal creation via apply_ops with mode: propose",
  },
  {
    method: "POST",
    path: "/api/projects/:project/proposals/:proposalId/accept",
    category: "mapped",
    mappedTools: ["apply_ops"],
    rationale: "Accept all or selected proposal ops through BlueprintDO.applyBatch",
  },
  {
    method: "POST",
    path: "/api/projects/:project/proposals/:proposalId/reject",
    category: "human_only_custody_or_transport",
    rationale: "Human-in-the-loop rejection of draft proposals in Studio Review Bar",
  },
  {
    method: "GET",
    path: "/api/projects/:project/activity",
    category: "mapped",
    mappedTools: ["get_blueprint_summary", "list_runs", "query_logs"],
    rationale: "Unified project activity feed across revisions, proposals, builds, deploys, connections, and runs",
  },
  {
    method: "POST",
    path: "/api/projects/:project/revert",
    category: "mapped",
    mappedTools: ["apply_ops"],
    rationale: "Revision revert via inverse Op log in BlueprintDO",
  },
  {
    method: "POST",
    path: "/api/projects/:project/import",
    category: "mapped",
    mappedTools: ["apply_ops"],
    rationale: "Blueprint state import via apply_ops",
  },
  // Build & Deploy
  {
    method: "POST",
    path: "/api/projects/:project/build",
    category: "mapped",
    mappedTools: ["deploy_plan", "deploy_apply"],
    rationale: "Deterministic assembly and buildHash computation",
  },
  {
    method: "GET",
    path: "/api/projects/:project/build",
    category: "mapped",
    mappedTools: ["deploy_plan"],
    rationale: "Inspect latest build hash and artifact metadata",
  },
  {
    method: "GET",
    path: "/api/projects/:project/environments",
    category: "mapped",
    mappedTools: ["deploy_plan"],
    rationale: "Inspect environment deployment state and drift",
  },
  {
    method: "POST",
    path: "/api/projects/:project/environments/:envName/plan",
    category: "mapped",
    mappedTools: ["deploy_plan"],
    rationale: "Generate deployment diff plan for preview or production",
  },
  {
    method: "POST",
    path: "/api/projects/:project/environments/:envName/deploy",
    category: "mapped",
    mappedTools: ["deploy_apply"],
    rationale: "Execute planned deployment to preview or production",
  },
  {
    method: "POST",
    path: "/api/projects/:project/environments/:envName/promote",
    category: "mapped",
    mappedTools: ["deploy_apply"],
    rationale: "Promote preview build to production via deploy_apply",
  },
  {
    method: "POST",
    path: "/api/projects/:project/environments/:envName/rollback",
    category: "mapped",
    mappedTools: ["deploy_apply"],
    rationale: "Restore target revision deployment via deploy_apply",
  },
  {
    method: "GET",
    path: "/api/projects/:project/environments/:envName/deployments",
    category: "mapped",
    mappedTools: ["deploy_plan"],
    rationale: "Inspect environment deployment history",
  },
  {
    method: "POST",
    path: "/api/projects/:project/environments/:envName/check-drift",
    category: "mapped",
    mappedTools: ["deploy_plan"],
    rationale: "Check live environment drift before deployment",
  },
  {
    method: "GET",
    path: "/api/projects/:project/sandbox",
    category: "mapped",
    mappedTools: ["deploy_plan"],
    rationale: "Inspect hosted sandbox preview deployment status, quota, row count, and TTL",
  },
  {
    method: "POST",
    path: "/api/projects/:project/sandbox/deploy",
    category: "mapped",
    mappedTools: ["deploy_apply"],
    rationale: "Deploy project to zero-credential hosted sandbox preview via deploy_apply",
  },
  {
    method: "POST",
    path: "/api/projects/:project/sandbox/promote-to-byoc",
    category: "mapped",
    mappedTools: ["deploy_apply"],
    rationale: "Promote hosted sandbox build artifact to BYOC Cloudflare account preserving buildHash",
  },
  {
    method: "POST",
    path: "/api/admin/sandboxes/prune",
    category: "human_only_custody_or_transport",
    rationale: "Internal 7-day sandbox TTL reaper job endpoint",
  },
  // Connections & Secret Metadata (AD-S12 / AD-S17: agent reads metadata and requests consent URL, never raw values)
  {
    method: "GET",
    path: "/api/projects/:project/secrets",
    category: "mapped",
    mappedTools: ["list_connections", "request_connection"],
    rationale: "List secret/connection metadata handles without raw secret values",
  },
  {
    method: "GET",
    path: "/api/projects/:project/connections",
    category: "mapped",
    mappedTools: ["list_connections"],
    rationale: "List Case A connection metadata (ref, app, authType, scopes, status, expiresAt, lastCheckedAt, usedBy) without raw secrets",
  },
  {
    method: "POST",
    path: "/api/projects/:project/connections/requests",
    category: "mapped",
    mappedTools: ["request_connection"],
    rationale: "Record agent request_connection consent request for user authorization in Studio Connections Center",
  },
  // Workflow rehearsal, runs & traces
  {
    method: "GET",
    path: "/api/projects/:project/workflows/:workflowId/pins",
    category: "mapped",
    mappedTools: ["test_workflow"],
    rationale: "Pinned step outputs used during workflow rehearsal",
  },
  {
    method: "PUT",
    path: "/api/projects/:project/workflows/:workflowId/nodes/:nodeId/pin",
    category: "mapped",
    mappedTools: ["test_workflow"],
    rationale: "Workflow rehearsal with pinned upstream outputs",
  },
  {
    method: "DELETE",
    path: "/api/projects/:project/workflows/:workflowId/nodes/:nodeId/pin",
    category: "mapped",
    mappedTools: ["test_workflow"],
    rationale: "Workflow rehearsal without pinned upstream outputs",
  },
  {
    method: "POST",
    path: "/api/projects/:project/workflows/:workflowId/nodes/:nodeId/test-step",
    category: "mapped",
    mappedTools: ["test_workflow"],
    rationale: "Single-node rehearsal in preview environment via test_workflow",
  },
  {
    method: "POST",
    path: "/api/projects/:project/workflows/:workflowId/runs",
    category: "mapped",
    mappedTools: ["test_workflow"],
    rationale: "Workflow test execution in preview environment via test_workflow",
  },
  {
    method: "POST",
    path: "/api/projects/:project/workflows/:workflowId/run",
    category: "mapped",
    mappedTools: ["test_workflow"],
    rationale: "Workflow test execution alias via test_workflow",
  },
  {
    method: "POST",
    path: "/api/projects/:project/runs/:runId/rerun",
    category: "mapped",
    mappedTools: ["test_workflow"],
    rationale: "Partial workflow re-run from nodeId via test_workflow",
  },
  {
    method: "GET",
    path: "/api/projects/:project/runs",
    category: "mapped",
    mappedTools: ["list_runs"],
    rationale: "List workflow execution runs with status and timing",
  },
  {
    method: "GET",
    path: "/api/projects/:project/runs/:runId",
    category: "mapped",
    mappedTools: ["get_run_trace"],
    rationale: "Read per-step execution trace and redacted I/O for a runId",
  },
  // Structured logs & metrics
  {
    method: "GET",
    path: "/api/projects/:project/environments/:envName/logs",
    category: "mapped",
    mappedTools: ["query_logs"],
    rationale: "Query structured logs correlated by runId, nodeId, brickId, and level",
  },
  {
    method: "GET",
    path: "/api/projects/:project/environments/:envName/data/logs",
    category: "mapped",
    mappedTools: ["query_logs"],
    rationale: "Query structured logs alias",
  },
  {
    method: "GET",
    path: "/api/projects/:project/environments/:envName/health",
    category: "mapped",
    mappedTools: ["list_runs", "query_logs"],
    rationale: "Backend health and error inspection",
  },
  {
    method: "GET",
    path: "/api/projects/:project/environments/:envName/health/seed",
    category: "mapped",
    mappedTools: ["list_runs", "query_logs"],
    rationale: "Backend health read alias",
  },
  {
    method: "GET",
    path: "/api/projects/:project/environments/:envName/metrics",
    category: "mapped",
    mappedTools: ["list_runs", "query_logs"],
    rationale: "Backend metrics inspection",
  },
  // Human-only secret custody, org/auth management, Data Browser UI, and transport endpoints (AD-S12 / AD-S17)
  {
    method: "POST",
    path: "/api/projects/:project/secrets",
    category: "human_only_custody_or_transport",
    rationale: "AD-S12: Raw secret value sealing is human-only; MCP agents use request_connection consent URL",
  },
  {
    method: "DELETE",
    path: "/api/projects/:project/secrets/:ref",
    category: "human_only_custody_or_transport",
    rationale: "AD-S12: Secret deletion is human-only in Studio Connections Center",
  },
  {
    method: "GET",
    path: "/api/connections/oauth/:app/start",
    category: "human_only_custody_or_transport",
    rationale: "AD-S12/AD-S17: OAuth2 PKCE S256 redirect start is human-only in Studio Connections Center",
  },
  {
    method: "POST",
    path: "/api/projects/:project/connections/oauth/:app/start",
    category: "human_only_custody_or_transport",
    rationale: "AD-S12/AD-S17: OAuth2 PKCE S256 flow initiation is human-only in Studio Connections Center",
  },
  {
    method: "GET",
    path: "/api/connections/oauth/:app/callback",
    category: "human_only_custody_or_transport",
    rationale: "AD-S12/AD-S17: OAuth2 callback token exchange and px_connections sealing is human-only",
  },
  {
    method: "POST",
    path: "/api/connections/oauth/:app/callback",
    category: "human_only_custody_or_transport",
    rationale: "AD-S12/AD-S17: OAuth2 callback token exchange and px_connections sealing is human-only",
  },
  {
    method: "POST",
    path: "/api/projects/:project/connections",
    category: "human_only_custody_or_transport",
    rationale: "AD-S12/AD-S17: Raw connection credential sealing into px_connections is human-only",
  },
  {
    method: "POST",
    path: "/api/projects/:project/connections/:ref/test",
    category: "human_only_custody_or_transport",
    rationale: "AD-S12/AD-S17: Connection credential verification test is human-only in Studio Connections Center",
  },
  {
    method: "POST",
    path: "/api/projects/:project/connections/:ref/reauthorize",
    category: "human_only_custody_or_transport",
    rationale: "AD-S12/AD-S17: Connection credential re-authorization/rotation is human-only in Studio Connections Center",
  },
  {
    method: "DELETE",
    path: "/api/projects/:project/connections/:ref",
    category: "human_only_custody_or_transport",
    rationale: "AD-S12/AD-S17: Connection deletion is human-only in Studio Connections Center",
  },
  {
    method: "POST",
    path: "/api/projects/:project/telemetry/webhook",
    category: "human_only_custody_or_transport",
    rationale: "Internal HMAC-signed Worker-to-Studio telemetry ingestion webhook",
  },
  {
    method: "GET",
    path: "/api/projects/:project/telemetry/events",
    category: "human_only_custody_or_transport",
    rationale: "Internal Studio UI live telemetry cursor feed (agents use list_runs/get_run_trace)",
  },
  {
    method: "POST",
    path: "/api/projects/:project/telemetry/reconcile",
    category: "human_only_custody_or_transport",
    rationale: "Internal Worker /__px/events pull reconciliation helper",
  },
  {
    method: "POST",
    path: "/api/projects/:project/runs/prune",
    category: "human_only_custody_or_transport",
    rationale: "Internal 7-day telemetry retention pruning job",
  },
  {
    method: "GET",
    path: "/api/projects/:project/ws",
    category: "human_only_custody_or_transport",
    rationale: "WebSocket upgrade endpoint for browser canvas synchronization",
  },
  {
    method: "POST",
    path: "/mcp",
    category: "human_only_custody_or_transport",
    rationale: "MCP JSON-RPC transport endpoint",
  },
  {
    method: "POST",
    path: "/api/mcp",
    category: "human_only_custody_or_transport",
    rationale: "MCP JSON-RPC transport endpoint alias",
  },
  {
    method: "POST",
    path: "/api/projects/:project/environments/:envName/logs",
    category: "human_only_custody_or_transport",
    rationale: "Internal log ingestion endpoint",
  },
  {
    method: "POST",
    path: "/api/projects/:project/environments/:envName/data/logs",
    category: "human_only_custody_or_transport",
    rationale: "Internal log ingestion endpoint alias",
  },
  {
    method: "POST",
    path: "/api/projects/:project/environments/:envName/health",
    category: "human_only_custody_or_transport",
    rationale: "Internal health metrics seed endpoint",
  },
  {
    method: "POST",
    path: "/api/projects/:project/environments/:envName/health/seed",
    category: "human_only_custody_or_transport",
    rationale: "Internal health metrics seed endpoint",
  },
  {
    method: "POST",
    path: "/api/projects/:project/environments/:envName/metrics",
    category: "human_only_custody_or_transport",
    rationale: "Internal metrics seed endpoint",
  },
  {
    method: "POST",
    path: "/api/onboarding/events",
    category: "human_only_custody_or_transport",
    rationale: "Studio onboarding funnel telemetry ingestion endpoint",
  },
  {
    method: "GET",
    path: "/api/admin/onboarding-funnel",
    category: "human_only_custody_or_transport",
    rationale: "Operator onboarding TTFD and drop-off funnel analytics endpoint",
  },
  {
    method: "POST",
    path: "/api/admin/beta-cohort/provision",
    category: "human_only_custody_or_transport",
    rationale: "Operator Cohort-1 design partner provisioning endpoint",
  },
  {
    method: "GET",
    path: "/api/admin/beta-metrics",
    category: "human_only_custody_or_transport",
    rationale: "Operator Cohort-1 beta readiness and PRD section 8 metrics endpoint",
  },
  {
    method: "DELETE",
    path: "/api/orgs/:orgId",
    category: "human_only_custody_or_transport",
    rationale: "Owner-only organization deletion control-plane endpoint",
  },
  {
    method: "GET",
    path: "/api/orgs/:orgId/audit-logs",
    category: "human_only_custody_or_transport",
    rationale: "Organization immutable audit log query endpoint",
  },
  {
    method: "GET",
    path: "/api/projects/:project/audit-logs",
    category: "mapped",
    mappedTools: ["get_blueprint_summary", "list_runs", "query_logs"],
    rationale: "Project immutable audit log query endpoint",
  },
  {
    method: "GET",
    path: "/api/projects/:project/audit-log",
    category: "mapped",
    mappedTools: ["get_blueprint_summary", "list_runs", "query_logs"],
    rationale: "Project immutable audit log alias endpoint",
  },
  {
    method: "GET",
    path: "/api/projects/:project/settings/retention",
    category: "human_only_custody_or_transport",
    rationale: "Project retention and privacy redaction settings query endpoint",
  },
  {
    method: "PUT",
    path: "/api/projects/:project/settings/retention",
    category: "human_only_custody_or_transport",
    rationale: "Project retention and privacy redaction settings update endpoint",
  },
  {
    method: "PATCH",
    path: "/api/projects/:project/settings/retention",
    category: "human_only_custody_or_transport",
    rationale: "Project retention and privacy redaction settings patch endpoint",
  },
];

/**
 * Canonical mapping from every registered MCP tool in `TOOLS` to its shared
 * `BlueprintDO` / `Op` / `studio-api` command targets.
 */
export const MCP_TOOL_PARITY_MAPPINGS: ReadonlyArray<McpToolParityMapping> = [
  {
    toolName: "search_bricks",
    surfaceKind: "query",
    sharedTargets: ["GET /api/catalog"],
  },
  {
    toolName: "get_brick",
    surfaceKind: "query",
    sharedTargets: ["GET /api/catalog"],
  },
  {
    toolName: "search_nodes",
    surfaceKind: "query",
    sharedTargets: ["GET /api/catalog"],
  },
  {
    toolName: "get_node",
    surfaceKind: "query",
    sharedTargets: ["GET /api/catalog"],
  },
  {
    toolName: "get_blueprint_summary",
    surfaceKind: "query",
    sharedTargets: ["GET /api/projects/:project", "BlueprintDO.getState"],
  },
  {
    toolName: "get_blueprint_slice",
    surfaceKind: "query",
    sharedTargets: ["GET /api/projects/:project", "BlueprintDO.getState"],
  },
  {
    toolName: "validate_blueprint",
    surfaceKind: "query",
    sharedTargets: ["GET /api/projects/:project", "BlueprintDO.computeReadiness"],
  },
  {
    toolName: "apply_ops",
    surfaceKind: "mutation",
    sharedTargets: [
      "POST /api/projects/:project/ops",
      "POST /api/projects/:project/revert",
      ...OP_TYPES.map((op) => `Op:${op}`),
    ],
  },
  {
    toolName: "request_connection",
    surfaceKind: "consent_handoff",
    sharedTargets: ["GET /api/projects/:project/secrets", "StudioConnectionsConsentUrl"],
  },
  {
    toolName: "list_connections",
    surfaceKind: "query",
    sharedTargets: ["GET /api/projects/:project/secrets"],
  },
  {
    toolName: "test_workflow",
    surfaceKind: "mutation",
    sharedTargets: [
      "POST /api/projects/:project/workflows/:workflowId/runs",
      "POST /api/projects/:project/workflows/:workflowId/nodes/:nodeId/test-step",
    ],
  },
  {
    toolName: "list_runs",
    surfaceKind: "query",
    sharedTargets: ["GET /api/projects/:project/runs"],
  },
  {
    toolName: "get_run_trace",
    surfaceKind: "query",
    sharedTargets: ["GET /api/projects/:project/runs/:runId"],
  },
  {
    toolName: "query_logs",
    surfaceKind: "query",
    sharedTargets: ["GET /api/projects/:project/environments/:envName/logs"],
  },
  {
    toolName: "deploy_plan",
    surfaceKind: "query",
    sharedTargets: ["POST /api/projects/:project/environments/:envName/plan"],
  },
  {
    toolName: "deploy_apply",
    surfaceKind: "mutation",
    sharedTargets: ["POST /api/projects/:project/environments/:envName/deploy"],
  },
];

function isHumanCustodyPrefixRoute(_method: string, path: string): boolean {
  if (
    path === "/api/auth" ||
    path.startsWith("/api/auth/") ||
    path === "/api/orgs" ||
    path.startsWith("/api/orgs/")
  ) {
    return true;
  }
  if (
    /^\/api\/projects\/:project\/environments\/:envName\/(data|ledger)(\/|$)/.test(
      path,
    ) &&
    path !== "/api/projects/:project/environments/:envName/data/logs"
  ) {
    return true;
  }
  return false;
}

export interface VerifyMcpParityOptions {
  opTypes?: readonly string[];
  opSafetyMetadata?: Readonly<Record<string, OpSafetyMetadata>>;
  studioRoutes?: ReadonlyArray<StudioRouteDescriptor>;
  tools?: ReadonlyArray<McpToolDescriptor>;
  routeRules?: ReadonlyArray<UIRouteParityRule>;
  toolMappings?: ReadonlyArray<McpToolParityMapping>;
}

export interface VerifyMcpParityResult {
  ok: boolean;
  opCount: number;
  studioRouteCount: number;
  mcpToolCount: number;
  orphanOps: string[];
  orphanStudioRoutes: string[];
  orphanMcpTools: string[];
  missingAnnotationTools: string[];
  errors: string[];
}

export function extractStudioApiRoutes(): StudioRouteDescriptor[] {
  const app = createStudioApiApp();
  const seen = new Set<string>();
  const descriptors: StudioRouteDescriptor[] = [];
  for (const r of app.routes) {
    const method = r.method.toUpperCase();
    if (method === "ALL" || method === "OPTIONS" || method === "HEAD") continue;
    const key = `${method} ${r.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      descriptors.push({ method, path: r.path });
    }
  }
  return descriptors;
}

export function verifyMcpParity(
  options: VerifyMcpParityOptions = {},
): VerifyMcpParityResult {
  const opTypes = options.opTypes ?? OP_TYPES;
  const opSafety =
    options.opSafetyMetadata ??
    (OP_SAFETY_METADATA as Readonly<Record<string, OpSafetyMetadata>>);
  const studioRoutes = options.studioRoutes ?? extractStudioApiRoutes();
  const tools: ReadonlyArray<McpToolDescriptor> =
    options.tools ??
    TOOLS.map((t) => ({
      name: t.name,
      readOnly: t.readOnly,
      annotations: t.annotations,
    }));
  const routeRules = options.routeRules ?? STUDIO_ROUTE_PARITY_RULES;
  const toolMappings = options.toolMappings ?? MCP_TOOL_PARITY_MAPPINGS;

  const registeredToolNames = new Set(tools.map((t) => t.name));
  const toolMappingByName = new Map(toolMappings.map((m) => [m.toolName, m]));
  const routeRuleByKey = new Map(
    routeRules.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r]),
  );

  const orphanOps: string[] = [];
  const orphanStudioRoutes: string[] = [];
  const orphanMcpTools: string[] = [];
  const missingAnnotationTools: string[] = [];
  const errors: string[] = [];

  // 1. Check every Op kind in packages/blueprint has safety metadata and is mapped to apply_ops
  const applyOpsMapping = toolMappingByName.get("apply_ops");
  const applyOpsTargets = new Set(applyOpsMapping?.sharedTargets ?? []);
  for (const opKind of opTypes) {
    const safety = opSafety[opKind];
    if (
      !safety ||
      safety.tool !== "apply_ops" ||
      !registeredToolNames.has("apply_ops") ||
      !applyOpsTargets.has(`Op:${opKind}`)
    ) {
      orphanOps.push(opKind);
      errors.push(
        `Orphan Op kind "${opKind}": not mapped to an MCP tool with safety metadata in packages/mcp-server`,
      );
    }
  }

  // 2. Check every studio-api route is either mapped to a registered MCP tool or explicitly human-only
  for (const route of studioRoutes) {
    const method = route.method.toUpperCase();
    const key = `${method} ${route.path}`;
    const rule = routeRuleByKey.get(key);

    if (!rule) {
      if (isHumanCustodyPrefixRoute(method, route.path)) {
        continue;
      }
      orphanStudioRoutes.push(key);
      errors.push(
        `Orphan UI route "${key}": exposed in apps/studio-api with no mapped MCP tool in packages/mcp-server`,
      );
      continue;
    }

    if (rule.category === "mapped") {
      const mapped = rule.mappedTools ?? [];
      if (
        mapped.length === 0 ||
        mapped.some((toolName) => !registeredToolNames.has(toolName))
      ) {
        orphanStudioRoutes.push(key);
        errors.push(
          `Orphan UI route "${key}": mapped MCP tool (${mapped.join(", ") || "none"}) is not registered in packages/mcp-server`,
        );
      }
    }
  }

  // 3. Check every registered MCP tool has safety annotations and maps to a shared Op or studio-api capability
  for (const tool of tools) {
    if (
      !tool.annotations ||
      typeof tool.annotations.readOnlyHint !== "boolean" ||
      typeof tool.annotations.destructiveHint !== "boolean" ||
      typeof tool.annotations.idempotentHint !== "boolean"
    ) {
      missingAnnotationTools.push(tool.name);
      errors.push(
        `MCP tool "${tool.name}" is missing required MCP safety annotations (readOnlyHint, destructiveHint, idempotentHint)`,
      );
    }

    const mapping = toolMappingByName.get(tool.name);
    if (!mapping || mapping.sharedTargets.length === 0) {
      orphanMcpTools.push(tool.name);
      errors.push(
        `Orphan MCP tool "${tool.name}": registered in packages/mcp-server without a mapped Op or studio-api command`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    opCount: opTypes.length,
    studioRouteCount: studioRoutes.length,
    mcpToolCount: tools.length,
    orphanOps,
    orphanStudioRoutes,
    orphanMcpTools,
    missingAnnotationTools,
    errors,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const args = process.argv.slice(2);
  const customOpTypes = [...OP_TYPES];
  const customRoutes = extractStudioApiRoutes();
  const customTools: McpToolDescriptor[] = TOOLS.map((t) => ({
    name: t.name,
    readOnly: t.readOnly,
    annotations: t.annotations,
  }));

  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const next = args[i + 1];
    if (flag === "--inject-orphan-op" && next) {
      customOpTypes.push(next as never);
      i += 1;
    } else if (flag === "--inject-orphan-ui" && next) {
      const [m, ...rest] = next.split(":");
      const p = rest.join(":") || next;
      customRoutes.push({
        method: rest.length > 0 ? m! : "POST",
        path: p,
      });
      i += 1;
    } else if (flag === "--inject-orphan-mcp" && next) {
      customTools.push({
        name: next,
        readOnly: false,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        },
      });
      i += 1;
    }
  }

  const result = verifyMcpParity({
    opTypes: customOpTypes,
    studioRoutes: customRoutes,
    tools: customTools,
  });

  if (!result.ok) {
    console.error("MCP Parity Gate FAILED:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(
    `MCP Parity Gate PASSED: ${result.opCount} Op kinds, ${result.studioRouteCount} studio-api routes, ${result.mcpToolCount} MCP tools verified in lockstep.`,
  );
}
