import { enabledSchedules } from "@poc/assembler/schedules";
import type { ScheduleSettingCondition } from "@poc/assembler/schedules";
import {
  ENTITY_NAME_PATTERN,
  ENTITY_RELATION_PATTERN,
  ENUM_VALUE_PATTERN,
  applyOp,
  applyOps,
  buildCatalogNodeRegistry,
  computeReadiness,
  createEmptyBlueprint,
  normalizeBlueprintState,
  semanticHash as canonicalSemanticHash,
} from "@poc/blueprint";
import { RESERVED_FIELD_NAMES } from "@poc/sdk";
import { extractStepExpressionPills, extractTemplatePlaceholders, validateStepExpression } from "@poc/runtime/expressions";
import type {
  BlueprintMetadata,
  BlueprintState as CanonicalBlueprintState,
  BrickEntry,
  EntityDefinition as CanonicalEntityDefinition,
  ProposalRecord,
  ProposalStatus,
  ReadinessNeed,
  ReadinessResult,
  SecretRef,
  SemanticDiff,
  SettingValue,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowTrigger,
} from "@poc/blueprint";
import catalogDataJson from "./catalog-data.json";
import presetsDataJson from "./presets-data.json";

export { extractStepExpressionPills, validateStepExpression };
export function semanticHash(state: BlueprintState): string {
  return canonicalSemanticHash(normalizeBlueprintState(state as CanonicalBlueprintState));
}

export type EntityFieldType = "text" | "string" | "number" | "integer" | "boolean" | "enum" | "json" | "datetime" | "relation" | "date" | "money" | "longtext";

interface EntityFieldBase {
  name: string;
  required?: boolean;
  unique?: boolean;
  indexed?: boolean;
  relation?: string;
  default?: string | number | boolean;
}

export type EntityField =
  | (EntityFieldBase & {
      type: "text" | "string" | "json" | "datetime" | "relation";
      maxLength?: number;
    })
  | (EntityFieldBase & {
      type: "number" | "integer";
      min?: number;
      max?: number;
    })
  | (EntityFieldBase & {
      type: "boolean";
    })
  | (EntityFieldBase & {
      type: "enum";
      values: string[];
    })
  | (EntityFieldBase & {
      type: "date";
    })
  | (EntityFieldBase & {
      type: "money";
      currencies: string[];
    })
  | (EntityFieldBase & {
      type: "longtext";
      maxLength?: number;
    });

export interface EntityDefinition extends Omit<CanonicalEntityDefinition, "fields" | "workspaceScoped"> {
  workspaceScoped?: true;
  fields: EntityField[];
}

export interface BlueprintState extends Omit<CanonicalBlueprintState, "metadata" | "entities"> {
  entities: EntityDefinition[];
  metadata?: BlueprintMetadata;
}

export type {
  ProposalRecord,
  ProposalStatus,
  ReadinessNeed,
  ReadinessResult,
  SemanticDiff,
  SettingValue,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowTrigger,
};

export type StudioOrgRole = "owner" | "admin" | "builder" | "viewer";

export type BrickMaturity = "production" | "beta" | "experimental";

export type BrickCategory = "identity" | "billing" | "data" | "automation" | "communication" | "ai" | "developer" | "governance";

export type CatalogSettingDefinition =
  | {
      type: "integer";
      min: number;
      max: number;
      default: number;
    }
  | {
      type: "number";
      min?: number;
      max?: number;
      default: number;
    }
  | {
      type: "string";
      minLength?: number;
      maxLength?: number;
      default: string;
    }
  | {
      type: "enum";
      values: string[];
      default: string;
    }
  | {
      type: "boolean";
      default: boolean;
    };

export interface CatalogNodePort {
  id: string;
  label?: string;
  dataType: "string" | "number" | "boolean" | "object" | "array" | "any";
  required?: boolean;
}

export interface CatalogNodeDefinition {
  type: string;
  label: string;
  summary?: string;
  role: "trigger" | "action" | "logic";
  inputs: CatalogNodePort[];
  outputs: CatalogNodePort[];
  config: Record<string, CatalogSettingDefinition>;
  executor: string;
  durable: boolean;
  sideEffects: "none" | "read" | "write";
}

interface CatalogBrickUiSettingMeta {
  widget?: "slider" | "select" | "toggle" | "text" | "secret";
  label?: string;
  helpText?: string;
  help?: string;
}

interface CatalogBrickRoute {
  factory: string;
  mountAt: string;
  options?: Record<string, unknown>;
  guardPaths?: string[];
  guardWith?: string;
}

interface CatalogBrickTriggers {
  /** Story 1.20: `enabledWhen` wires a schedule only while a condition on the brick's settings holds. */
  schedules?: Array<{ id: string; cron: string; handler: string; enabledWhen?: ScheduleSettingCondition }>;
  queues?: Array<{ id: string; handler: string; maxBatch?: number; dlq?: boolean }>;
}

export interface CatalogBrickManifest {
  manifestVersion: 2;
  kind: "brick";
  id: string;
  version: string;
  provides: string[];
  requires: string[];
  migrations: string[];
  routePrefixes: string[];
  npmDependencies: Record<string, string>;
  settings: Record<string, CatalogSettingDefinition>;
  nodes?: CatalogNodeDefinition[];
  ui?: {
    displayName: string;
    category: BrickCategory;
    summary: string;
    maturity?: BrickMaturity;
    maturityReason?: string;
    behaviourTest?: string;
    derivedTier?: BrickMaturity;
    blockers?: string[];
    evidence?: {
      gitSha?: string;
      runAt?: string;
      assertionCount?: number;
      liveVerifiedAt?: string | null;
      fidelity?: unknown;
    };
    settings?: Record<string, CatalogBrickUiSettingMeta>;
  };
  triggers?: CatalogBrickTriggers;
  conflicts?: Array<{ brick: string; reason: string }>;
  bindings?: string[] | Record<string, string>;
  /** A name, or { name, optional, generate } (story 1.19): see brickSecretNames. */
  secrets?: Array<string | { name: string; optional?: true; generate?: "random-32-bytes" }>;
  globalTables?: Array<{ table: string; reason: string }>;
  worker: {
    package: string;
    guard?: { export: string; capability: string };
    routes: CatalogBrickRoute[];
  };
}

interface CatalogNodePackManifest {
  manifestVersion: 2;
  kind: "node-pack";
  id: string;
  version: string;
  package: string;
  ui: {
    displayName: string;
    category: BrickCategory;
    summary: string;
    maturity: BrickMaturity;
    maturityReason?: string;
    behaviourTest?: string;
    derivedTier?: BrickMaturity;
    blockers?: string[];
    evidence?: {
      gitSha?: string;
      runAt?: string;
      assertionCount?: number;
      liveVerifiedAt?: string | null;
      fidelity?: unknown;
    };
  };
  nodes: CatalogNodeDefinition[];
}

export interface AuthorAttribution {
  type: "human" | "agent";
  id: string;
  client?: string;
  onBehalfOf?: string;
}

export interface RevisionSummary {
  revision: number;
  parentRevision: number | null;
  author: AuthorAttribution;
  summary: string | null;
  semanticHash: string;
  createdAt: string;
  ops?: Array<Record<string, unknown>>;
  inverseOps?: Array<Record<string, unknown>>;
}

export interface StudioUser {
  id: string;
  email: string;
  name: string;
}

export interface StudioOrg {
  id: string;
  slug: string;
  name: string;
  role: StudioOrgRole;
  createdAt?: string;
}

export interface StudioProjectSummary {
  project: string;
  orgId: string;
  revision: number;
  semanticHash: string;
  updatedAt: string;
}

export type StudioNavTab = "overview" | "bricks" | "data" | "workflows" | "connections" | "history";
export type StudioRightDockTab = "inspector" | "ledger";
export type SyncStatus = "Live" | "Connecting…" | "Offline";

export type StudioSecretKind = "api_key" | "webhook_secret" | "brick_secret" | "oauth2";
export type StudioSecretStatus = "valid" | "connected" | "expired" | "revoked" | "error" | "missing";

export interface StudioSecretUsedByTarget {
  targetKind: "brick" | "node" | "connection";
  targetId: string;
  secretName: string;
}

export interface StudioSecretMetadata {
  id: string;
  ref: string;
  kind: StudioSecretKind;
  label: string;
  appOrBrick: string;
  envScope: string;
  keyHint: string;
  status: StudioSecretStatus;
  usedBy: StudioSecretUsedByTarget[];
  authType?: string;
  scopes?: string[];
  expiresAt?: string | null;
  lastCheckedAt?: string | null;
  createdBy?: string;
  updatedAt: string;
}

export interface StudioConnectionRequest {
  requestId: string;
  projectId?: string;
  app: string;
  reason: string;
  scopes: string[];
  suggestedRef: string;
  connectUrl: string;
  status: "pending" | "completed" | "dismissed";
  requestedBy: string;
  createdAt: string;
}

export interface CatalogIntegrationManifest {
  manifestVersion: 2;
  kind: "integration";
  app: string;
  version: string;
  ui: {
    displayName?: string;
    title?: string;
    category?: string;
    summary?: string;
    description?: string;
    icon?: string;
    docsUrl?: string;
    maturity: BrickMaturity;
    maturityReason?: string;
    derivedTier?: BrickMaturity;
    blockers?: string[];
    evidence?: {
      gitSha?: string;
      runAt?: string;
      assertionCount?: number;
      liveVerifiedAt?: string | null;
      fidelity?: unknown;
    };
  };
  auth: {
    type: "oauth2" | "apiKey" | "api_key" | "basic" | "bearer" | "hmac_webhook_only" | "none";
    authorizeUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
    oauth2?: {
      authorizeUrl: string;
      tokenUrl: string;
      scopes: string[];
      pkce?: boolean;
      extraAuthorizeParams?: Record<string, string>;
    };
    apiKey?: {
      in: "header" | "query";
      name: string;
      prefix?: string;
    };
  };
  baseUrl: string;
  operations: Array<{
    operationId?: string;
    id?: string;
    label?: string;
    title?: string;
    category?: string;
    summary?: string;
    description?: string;
    method: string;
    path: string;
    inputs?: CatalogNodePort[];
    outputs?: CatalogNodePort[];
    config?: Record<string, CatalogSettingDefinition>;
    sideEffects?: "none" | "read" | "write";
    durable?: boolean;
  }>;
  triggers?: Array<{
    id: string;
    label?: string;
    title?: string;
    category?: string;
    summary?: string;
    description?: string;
    verifier?: string;
    verification?: {
      scheme: "hmac-sha256" | "stripe-signature" | "shared-secret";
      header: string;
      secretKey: string;
    };
    dedupIdPath?: string;
    outputs: CatalogNodePort[];
  }>;
}

export interface StudioSelection {
  kind: "brick" | "entity" | "workflow" | "node" | "revision";
  id: string;
  workflowId?: string;
}

export interface PresenceMember {
  id: string;
  label: string;
  kind: "human" | "agent";
  client?: string;
}

export interface AffectedObjectTarget {
  kind: "brick" | "entity" | "workflow" | "node";
  id: string;
  workflowId?: string;
  label: string;
}

export interface SemanticDiffPayload {
  project: string;
  fromRevision: number;
  toRevision: number;
  fromSemanticHash?: string;
  toSemanticHash?: string;
  diff: SemanticDiff;
}

/** The names of a brick's declared secrets, whether written as a name or as { name, optional, generate } (story 1.19). */
export function brickSecretNames(manifest: Pick<CatalogBrickManifest, "secrets"> | undefined | null): string[] {
  return (manifest?.secrets ?? []).map((s) => (typeof s === "string" ? s : s.name));
}

export const DEFAULT_CATALOG: Record<string, CatalogBrickManifest> = (catalogDataJson as unknown as { bricks: Record<string, CatalogBrickManifest> }).bricks;

const DEFAULT_NODE_PACKS: Record<string, { manifest: CatalogNodePackManifest }> =
  (
    catalogDataJson as unknown as {
      nodePacks?: Record<string, { manifest: CatalogNodePackManifest }>;
    }
  ).nodePacks ?? {};

export const DEFAULT_INTEGRATIONS: Record<string, { manifest: CatalogIntegrationManifest; nodes?: CatalogNodeDefinition[] }> =
  (
    catalogDataJson as unknown as {
      integrations?: Record<string, { manifest: CatalogIntegrationManifest; nodes?: CatalogNodeDefinition[] }>;
    }
  ).integrations ?? {};

const DEFAULT_CATALOG_VERSION: string = (catalogDataJson as unknown as { catalogVersion?: string }).catalogVersion ?? "";

type BlueprintCatalogInput = Parameters<typeof computeReadiness>[1];
type BlueprintNodeRegistryInput = NonNullable<Parameters<typeof computeReadiness>[2]>;

export function toBlueprintCatalog(catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG): BlueprintCatalogInput {
  return {
    ...(DEFAULT_CATALOG_VERSION ? { catalogVersion: DEFAULT_CATALOG_VERSION } : {}),
    bricks: Object.fromEntries(
      Object.entries(catalog).map(([id, manifest]) => [
        id,
        {
          manifest: {
            ...manifest,
            provides: manifest.provides ?? [],
            requires: manifest.requires ?? [],
            migrations: manifest.migrations ?? [],
            routePrefixes: manifest.routePrefixes ?? [],
            npmDependencies: manifest.npmDependencies ?? {},
            settings: manifest.settings ?? {},
            nodes: manifest.nodes ?? [],
            worker: {
              ...manifest.worker,
              routes: (manifest.worker?.routes ?? []).map((route) => ({
                ...route,
                options: route.options ?? {},
                guardPaths: route.guardPaths ?? [],
              })),
            },
          } as unknown as BlueprintCatalogInput["bricks"][string]["manifest"],
          files: Object.fromEntries((manifest.migrations ?? []).map((m) => [m, "-- migration\n"])),
        },
      ]),
    ),
    nodePacks: DEFAULT_NODE_PACKS as unknown as BlueprintCatalogInput["nodePacks"],
    integrations: DEFAULT_INTEGRATIONS as unknown as BlueprintCatalogInput["integrations"],
  } as BlueprintCatalogInput;
}

const permissiveConfigSchema = {
  safeParse: (data: unknown) => ({ success: true as const, data }),
};

const BASE_CATALOG_NODE_REGISTRY = buildCatalogNodeRegistry(toBlueprintCatalog(DEFAULT_CATALOG));

const STUDIO_NODE_REGISTRY: BlueprintNodeRegistryInput = {
  has: (type: string) => BASE_CATALOG_NODE_REGISTRY.has(type) || type.includes(".") || type === "trigger",
  get: (type: string) => {
    const catalogMatch = BASE_CATALOG_NODE_REGISTRY.get(type);
    if (catalogMatch) {
      return catalogMatch;
    }
    const isTrigger = type.startsWith("trigger.") || type.endsWith(".trigger") || type === "trigger";
    const isTransform = type.startsWith("transform.");
    return {
      type,
      category: isTrigger ? "trigger" : isTransform ? "transform" : "action",
      inputs: isTrigger ? [] : [{ id: "in", dataType: "any" }],
      outputs: [{ id: "out", dataType: "any" }],
      configSchema: permissiveConfigSchema,
      secrets: [],
    } as unknown as NonNullable<ReturnType<BlueprintNodeRegistryInput["get"]>>;
  },
  entries: () => BASE_CATALOG_NODE_REGISTRY.entries(),
  keys: () => BASE_CATALOG_NODE_REGISTRY.keys(),
  values: () => BASE_CATALOG_NODE_REGISTRY.values(),
  forEach: (cb, thisArg) => BASE_CATALOG_NODE_REGISTRY.forEach(cb, thisArg),
  size: BASE_CATALOG_NODE_REGISTRY.size,
  [Symbol.iterator]: () => BASE_CATALOG_NODE_REGISTRY[Symbol.iterator](),
};

export const createEmptyBlueprintState = createEmptyBlueprint;

export function computeStudioReadiness(state: BlueprintState, catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG): ReadinessResult {
  const canonical = normalizeBlueprintState(state as CanonicalBlueprintState);
  return computeReadiness(canonical, toBlueprintCatalog(catalog), STUDIO_NODE_REGISTRY);
}

export function applyStudioOps(
  baseState: BlueprintState,
  ops: ReadonlyArray<Record<string, unknown>>,
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
): BlueprintState {
  const bpCatalog = toBlueprintCatalog(catalog);
  const canonicalBase = normalizeBlueprintState(baseState as CanonicalBlueprintState);
  const normalizedOps: Array<Record<string, unknown> & { opId: string }> = ops.map((rawOp, idx) => ({
    ...rawOp,
    opId: typeof rawOp.opId === "string" && rawOp.opId.trim().length > 0 ? rawOp.opId : `studio-op-${idx + 1}`,
  }));

  const batchResult = applyOps(canonicalBase, normalizedOps, bpCatalog, STUDIO_NODE_REGISTRY);
  if (batchResult.ok) {
    return batchResult.state;
  }

  let current = canonicalBase;
  for (const op of normalizedOps) {
    if (op.type === "add_node" && typeof op.workflowId === "string" && op.workflowId.length > 0 && !current.workflows.some((w) => w.id === op.workflowId)) {
      const initWf = applyOp(
        current,
        {
          opId: `${op.opId}:init-wf`,
          type: "add_workflow",
          workflow: {
            id: op.workflowId,
            name: op.workflowId,
            nodes: [],
            edges: [],
          },
        },
        bpCatalog,
        STUDIO_NODE_REGISTRY,
      );
      if (initWf.ok) {
        current = initWf.state;
      }
    }
    const step = applyOp(current, op, bpCatalog, STUDIO_NODE_REGISTRY);
    if (step.ok) {
      current = step.state;
    }
  }
  return current;
}

interface RawPreset {
  project: string;
  identity?: string;
  bricks: Array<string | { id: string; config?: Record<string, SettingValue> }>;
  entities?: EntityDefinition[];
  workflows?: WorkflowDefinition[];
  secretRefs?: SecretRef[];
  metadata?: BlueprintMetadata;
}

function normalizePresetToBlueprint(raw: RawPreset): BlueprintState {
  const bricks: BrickEntry[] = raw.bricks.map((entry) =>
    typeof entry === "string" ? { id: entry, config: {} } : { id: entry.id, config: entry.config ?? {} },
  );
  const entities: EntityDefinition[] = (raw.entities ?? []).map((ent) => ({
    name: ent.name,
    workspaceScoped: true,
    fields: ent.fields.map((f) => {
      if (f.type === "text") {
        return {
          ...f,
          required: f.required ?? false,
          maxLength: f.maxLength ?? 500,
        };
      }
      return {
        ...f,
        required: f.required ?? false,
      };
    }),
  }));
  const layoutFromNodes: Record<string, { x: number; y: number }> = {};
  for (const wf of raw.workflows ?? []) {
    for (const node of wf.nodes ?? []) {
      if (node.position) {
        layoutFromNodes[node.id] = { x: node.position.x, y: node.position.y };
      }
    }
  }
  const mergedLayout = {
    ...layoutFromNodes,
    ...raw.metadata?.layout,
  };
  return {
    schemaVersion: 2,
    project: raw.project,
    identity: raw.identity ?? "stub",
    bricks,
    entities,
    workflows: raw.workflows ?? [],
    secretRefs: raw.secretRefs ?? [],
    ...(raw.metadata || Object.keys(mergedLayout).length > 0
      ? {
          metadata: {
            ...raw.metadata,
            ...(Object.keys(mergedLayout).length > 0 ? { layout: mergedLayout } : {}),
          },
        }
      : {}),
  };
}

export const PRESET_BLUEPRINTS: Record<string, BlueprintState> = Object.fromEntries(
  Object.entries(presetsDataJson as unknown as Record<string, RawPreset>).map(([name, raw]) => [name, normalizePresetToBlueprint(raw)]),
);

export function formatAuthorBadge(author: AuthorAttribution): {
  isAgent: boolean;
  agentTag: string | null;
  badgeText: string;
  displayName: string;
} {
  if (author.type === "agent") {
    const rawClient = (author.client ?? author.id).replace(/^agent:/, "");
    const agentTag = `agent:${rawClient}`;
    return {
      isAgent: true,
      agentTag,
      badgeText: `🤖 ${agentTag}`,
      displayName: agentTag,
    };
  }
  return {
    isAgent: false,
    agentTag: null,
    badgeText: `👤 human:${author.id}`,
    displayName: author.id,
  };
}

export function matchesAuthorFilter(rev: RevisionSummary, filter: string): boolean {
  if (!filter || filter === "all") return true;
  if (filter === "humans") return rev.author.type === "human";
  if (filter === "agents") return rev.author.type === "agent";
  if (filter.startsWith("agent:")) {
    if (rev.author.type !== "agent") return false;
    const { agentTag } = formatAuthorBadge(rev.author);
    return agentTag === filter || rev.author.id === filter || `agent:${rev.author.id}` === filter;
  }
  return true;
}

export function getDistinctAgentFilters(revisions: RevisionSummary[]): string[] {
  const seen = new Set<string>();
  for (const rev of revisions) {
    if (rev.author.type === "agent") {
      const { agentTag } = formatAuthorBadge(rev.author);
      if (agentTag) seen.add(agentTag);
    }
  }
  return [...seen].sort();
}

export function formatRelativeTimestamp(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

export function extractAffectedTargets(rev: RevisionSummary): AffectedObjectTarget[] {
  const targets: AffectedObjectTarget[] = [];
  const seen = new Set<string>();

  const pushTarget = (target: AffectedObjectTarget) => {
    const key = `${target.kind}:${target.workflowId ?? ""}:${target.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  };

  for (const rawOp of rev.ops ?? []) {
    const type = String(rawOp.type ?? "");
    switch (type) {
      case "enable_brick":
      case "configure_brick":
      case "remove_brick": {
        const brickId = typeof rawOp.brickId === "string" ? rawOp.brickId : "";
        if (brickId) {
          pushTarget({ kind: "brick", id: brickId, label: brickId });
        }
        break;
      }
      case "set_identity": {
        const identity = typeof rawOp.identity === "string" ? rawOp.identity : "";
        if (identity && identity !== "stub") {
          pushTarget({ kind: "brick", id: identity, label: identity });
        }
        break;
      }
      case "add_entity":
      case "update_entity": {
        const ent = rawOp.entity as { name?: string } | undefined;
        if (ent?.name) {
          pushTarget({ kind: "entity", id: ent.name, label: ent.name });
        }
        break;
      }
      case "remove_entity": {
        const name = typeof rawOp.name === "string" ? rawOp.name : "";
        if (name) {
          pushTarget({ kind: "entity", id: name, label: name });
        }
        break;
      }
      case "add_workflow": {
        const wf = rawOp.workflow as { id?: string; nodes?: Array<{ id?: string; label?: string }> } | undefined;
        if (wf?.id) {
          pushTarget({ kind: "workflow", id: wf.id, label: wf.id });
          for (const node of wf.nodes ?? []) {
            if (node.id) {
              pushTarget({
                kind: "node",
                id: node.id,
                workflowId: wf.id,
                label: node.id,
              });
            }
          }
        }
        break;
      }
      case "remove_workflow": {
        const workflowId = typeof rawOp.workflowId === "string" ? rawOp.workflowId : "";
        if (workflowId) {
          pushTarget({ kind: "workflow", id: workflowId, label: workflowId });
        }
        break;
      }
      case "add_node": {
        const workflowId = typeof rawOp.workflowId === "string" ? rawOp.workflowId : undefined;
        const node = rawOp.node as { id?: string; label?: string } | undefined;
        if (node?.id) {
          pushTarget({
            kind: "node",
            id: node.id,
            workflowId,
            label: node.id,
          });
        }
        break;
      }
      case "update_node":
      case "remove_node": {
        const workflowId = typeof rawOp.workflowId === "string" ? rawOp.workflowId : undefined;
        const nodeId = typeof rawOp.nodeId === "string" ? rawOp.nodeId : "";
        if (nodeId) {
          pushTarget({
            kind: "node",
            id: nodeId,
            workflowId,
            label: nodeId,
          });
        }
        break;
      }
      case "connect_edges": {
        const workflowId = typeof rawOp.workflowId === "string" ? rawOp.workflowId : undefined;
        const edges = Array.isArray(rawOp.edges) ? (rawOp.edges as Array<{ source?: string; target?: string }>) : [];
        for (const edge of edges) {
          if (edge.source) {
            pushTarget({
              kind: "node",
              id: edge.source,
              workflowId,
              label: edge.source,
            });
          }
          if (edge.target) {
            pushTarget({
              kind: "node",
              id: edge.target,
              workflowId,
              label: edge.target,
            });
          }
        }
        break;
      }
      case "disconnect_edge": {
        const workflowId = typeof rawOp.workflowId === "string" ? rawOp.workflowId : "";
        if (workflowId) {
          pushTarget({ kind: "workflow", id: workflowId, label: workflowId });
        }
        break;
      }
      case "bind_secret_ref": {
        if (rawOp.targetKind === "brick" && typeof rawOp.targetId === "string") {
          pushTarget({
            kind: "brick",
            id: rawOp.targetId,
            label: rawOp.targetId,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return targets;
}

export function formatRoleLabel(role: StudioOrgRole): "Owner" | "Admin" | "Builder" | "Viewer" {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "builder":
      return "Builder";
    case "viewer":
      return "Viewer";
  }
}

export type DisplayMaturity = BrickMaturity | "unverified";

export function formatMaturityBadge(tier?: DisplayMaturity): {
  tier: DisplayMaturity;
  label: "Production" | "Beta" | "Experimental" | "Unverified";
  icon: "✓" | "◆" | "⚠";
  textWithIcon: string;
} {
  switch (tier) {
    case "production":
      return {
        tier: "production",
        label: "Production",
        icon: "✓",
        textWithIcon: "Production ✓",
      };
    case "beta":
      return {
        tier: "beta",
        label: "Beta",
        icon: "◆",
        textWithIcon: "Beta ◆",
      };
    case "experimental":
      return {
        tier: "experimental",
        label: "Experimental",
        icon: "⚠",
        textWithIcon: "Experimental ⚠",
      };
    case "unverified":
    default:
      return {
        tier: "unverified",
        label: "Unverified",
        icon: "⚠",
        textWithIcon: "Unverified ⚠",
      };
  }
}

/** `config` is the brick's config in the blueprint; a schedule counts only if the assembler would wire it (story 1.20). */
export function hasSchedulingOrQueueTriggers(manifest: CatalogBrickManifest, config: Readonly<Record<string, unknown>> = {}): boolean {
  const hasSchedules = enabledSchedules(manifest, config).length > 0;
  const hasQueues = (manifest.triggers?.queues?.length ?? 0) > 0;
  if (hasSchedules || hasQueues) {
    return true;
  }
  return manifest.id === "cron-alarms" || manifest.id === "queue-jobs" || manifest.id === "workflow-dag";
}

export function takesEntitiesInManifest(manifest: CatalogBrickManifest): boolean {
  return manifest.worker.routes.some((route) =>
    Object.values(route.options ?? {}).some((val) => typeof val === "object" && val !== null && "$entities" in val),
  );
}

const quoteSqlIdentifier = (id: string): string => `"${id}"`;

function formatFieldColumnSql(field: EntityField): string {
  const notNull = field.required ? " NOT NULL" : "";
  const uniqueSql = field.unique ? " UNIQUE" : "";
  const defaultSql =
    field.default !== undefined && String(field.default) !== ""
      ? typeof field.default === "boolean"
        ? ` DEFAULT ${field.default ? 1 : 0}`
        : typeof field.default === "number"
          ? ` DEFAULT ${field.default}`
          : ` DEFAULT '${String(field.default).replace(/'/g, "''")}'`
      : "";
  const name = quoteSqlIdentifier(field.name);
  switch (field.type) {
    case "text":
    case "string":
    case "json":
    case "datetime": {
      const maxLen = field.maxLength ?? (field.type === "json" ? 5000 : field.type === "datetime" ? 64 : 500);
      return `${name} TEXT${notNull}${uniqueSql}${defaultSql} CHECK (length(${name}) <= ${maxLen})`;
    }
    // A relation holds the id (a UUID) of a row of its target entity, as the SDK stores it.
    case "relation":
      return `${name} TEXT${notNull}${uniqueSql}${defaultSql} CHECK (length(${name}) = 36)`;
    case "number":
    case "integer": {
      const bounds = [field.min !== undefined ? `${name} >= ${field.min}` : null, field.max !== undefined ? `${name} <= ${field.max}` : null].filter(Boolean);
      return `${name} INTEGER${notNull}${uniqueSql}${defaultSql}${bounds.length > 0 ? ` CHECK (${bounds.join(" AND ")})` : ""}`;
    }
    case "boolean":
      return `${name} INTEGER${notNull}${uniqueSql}${defaultSql} CHECK (${name} IN (0, 1))`;
    case "enum":
      return `${name} TEXT${notNull}${uniqueSql}${defaultSql} CHECK (${name} IN (${field.values.map((v) => `'${v}'`).join(", ")}))`;
    case "date":
      return `${name} TEXT${notNull}${uniqueSql}${defaultSql} CHECK (${name} IS date(${name}))`;
    case "longtext":
      return `${name} TEXT${notNull}${uniqueSql}${defaultSql} CHECK (length(${name}) <= ${field.maxLength ?? 20000})`;
    case "money": {
      // Two columns, as the SDK stores it: the amount in minor units and <name>__currency.
      const currency = quoteSqlIdentifier(`${field.name}__currency`);
      const codes = (field.currencies ?? []).map((c) => `'${c}'`).join(", ");
      return (
        `${name} INTEGER${notNull}${uniqueSql} CHECK (typeof(${name}) IN ('integer', 'null')),\n  ` +
        `${currency} TEXT${notNull} CHECK (${currency} IN (${codes}) AND ((${name} IS NULL) = (${currency} IS NULL)))`
      );
    }
  }
}

export function formatEntityDdl(entity: EntityDefinition, previousEntity?: EntityDefinition | null): string {
  const safeName = entity.name || "unnamed";
  const table = `ent_${safeName}`;
  const uniqueConstraints = entity.fields
    .filter((f) => f.unique && f.name)
    .map((f) => `UNIQUE(${quoteSqlIdentifier("workspace_id")}, ${quoteSqlIdentifier(f.name)})`);
  const columns = [
    `${quoteSqlIdentifier("id")} TEXT PRIMARY KEY`,
    `${quoteSqlIdentifier("workspace_id")} TEXT NOT NULL`,
    ...entity.fields.filter((f) => f.name).map(formatFieldColumnSql),
    `${quoteSqlIdentifier("created_at")} TEXT NOT NULL DEFAULT (datetime('now'))`,
    `${quoteSqlIdentifier("updated_at")} TEXT NOT NULL DEFAULT (datetime('now'))`,
    ...uniqueConstraints,
  ];
  const indexLines = [
    `CREATE INDEX IF NOT EXISTS ${quoteSqlIdentifier(`${table}_workspace_idx`)} ON ${quoteSqlIdentifier(table)}(${quoteSqlIdentifier("workspace_id")}, ${quoteSqlIdentifier("created_at")});`,
  ];
  for (const field of entity.fields) {
    if (!field.name) continue;
    if (field.indexed || field.unique || field.type === "relation" || field.relation) {
      indexLines.push(
        `CREATE INDEX IF NOT EXISTS ${quoteSqlIdentifier(`idx_${table}_workspace_${field.name}`)} ON ${quoteSqlIdentifier(table)}(${quoteSqlIdentifier("workspace_id")}, ${quoteSqlIdentifier(field.name)});`,
      );
    }
  }

  let ddl =
    `-- Generated from the blueprint's declaration of ${safeName}. Do not edit.\n` +
    `CREATE TABLE IF NOT EXISTS ${quoteSqlIdentifier(table)} (\n  ${columns.join(",\n  ")}\n);\n\n` +
    `${indexLines.join("\n")}\n`;

  if (previousEntity && previousEntity.name === entity.name) {
    const prevByName = new Map(previousEntity.fields.map((f) => [f.name, f]));
    const nextByName = new Map(entity.fields.filter((f) => f.name).map((f) => [f.name, f]));
    const alterLines: string[] = [];

    for (const [fName, nextField] of nextByName) {
      const prevField = prevByName.get(fName);
      if (!prevField) {
        alterLines.push(`ALTER TABLE ${quoteSqlIdentifier(table)} ADD COLUMN ${formatFieldColumnSql(nextField)};`);
      } else if (prevField.type !== nextField.type) {
        alterLines.push(
          `-- Type change on ${quoteSqlIdentifier(fName)} (${prevField.type} -> ${nextField.type}):\n` +
            `ALTER TABLE ${quoteSqlIdentifier(table)} DROP COLUMN ${quoteSqlIdentifier(fName)};\n` +
            `ALTER TABLE ${quoteSqlIdentifier(table)} ADD COLUMN ${formatFieldColumnSql(nextField)};`,
        );
      }
    }

    for (const [fName] of prevByName) {
      if (!nextByName.has(fName)) {
        alterLines.push(`ALTER TABLE ${quoteSqlIdentifier(table)} DROP COLUMN ${quoteSqlIdentifier(fName)};`);
      }
    }

    if (alterLines.length > 0) {
      ddl += `\n-- Incremental Migration Preview (ALTER TABLE diff vs committed ${table})\n${alterLines.join("\n")}\n`;
    }
  }

  return ddl;
}

function getReservedEntityRoutePrefixes(catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG): Set<string> {
  const reserved = new Set<string>();
  for (const manifest of Object.values(catalog)) {
    for (const prefix of manifest.routePrefixes ?? []) {
      reserved.add(prefix);
    }
  }
  return reserved;
}

export interface EntityDraftValidationResult {
  ok: boolean;
  nameError?: string;
  fieldErrors: Record<number, string>;
  generalErrors: string[];
}

export function validateEntityDraft(
  draft: EntityDefinition,
  existingEntities: ReadonlyArray<EntityDefinition>,
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
  editingOriginalName: string | null = null,
): EntityDraftValidationResult {
  const fieldErrors: Record<number, string> = {};
  const generalErrors: string[] = [];
  let nameError: string | undefined;

  const trimmedName = draft.name.trim();
  if (!trimmedName) {
    nameError = "Entity name is required.";
  } else if (!ENTITY_NAME_PATTERN.test(trimmedName)) {
    nameError = "Entity name must start with a lowercase letter and use only lowercase letters, digits, or underscores (max 40 chars).";
  } else {
    const reserved = getReservedEntityRoutePrefixes(catalog);
    if (reserved.has(trimmedName)) {
      nameError = `Entity "${trimmedName}" collides with a reserved brick route prefix (/api/${trimmedName}).`;
    } else if (existingEntities.some((e) => e.name === trimmedName && e.name !== editingOriginalName)) {
      nameError = `Entity "${trimmedName}" is already declared in this project.`;
    }
  }

  if (draft.fields.length === 0) {
    generalErrors.push("Entity must declare at least 1 field.");
  } else if (draft.fields.length > 30) {
    generalErrors.push("Entity cannot declare more than 30 fields.");
  }

  const seenNames = new Set<string>();
  draft.fields.forEach((field, idx) => {
    const fName = field.name.trim();
    if (!fName) {
      fieldErrors[idx] = "Field name is required.";
      return;
    }
    if (RESERVED_FIELD_NAMES.has(fName)) {
      fieldErrors[idx] = `Field name "${fName}" is reserved by the system (id, workspace_id, created_at, updated_at, rowid).`;
      return;
    }
    if (!ENTITY_NAME_PATTERN.test(fName)) {
      fieldErrors[idx] = "Field name must be snake_case (lowercase letters, digits, underscores, starting with a letter).";
      return;
    }
    if (seenNames.has(fName)) {
      fieldErrors[idx] = `Field "${fName}" is declared twice.`;
      return;
    }
    seenNames.add(fName);

    if (field.type === "enum") {
      if (!field.values || field.values.length === 0) {
        fieldErrors[idx] = "Enum field must specify at least 1 allowed value.";
        return;
      }
      if (field.values.length > 20) {
        fieldErrors[idx] = "Enum field cannot exceed 20 values.";
        return;
      }
      const badVal = field.values.find((v) => !ENUM_VALUE_PATTERN.test(v));
      if (badVal !== undefined) {
        fieldErrors[idx] = `Enum value "${badVal}" must use lowercase letters, digits, or underscores.`;
        return;
      }
      if (new Set(field.values).size !== field.values.length) {
        fieldErrors[idx] = "Enum values must be unique.";
        return;
      }
    }

    if (field.type === "number" || field.type === "integer") {
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        fieldErrors[idx] = `Field "${fName}" has min (${field.min}) > max (${field.max}).`;
        return;
      }
    }

    if (field.type === "money") {
      const currencies = field.currencies ?? [];
      if (currencies.length === 0 || currencies.length > 20) {
        fieldErrors[idx] = "Money field must list 1 to 20 currencies.";
        return;
      }
      const badCode = currencies.find((c) => !/^[A-Z]{3}$/.test(c));
      if (badCode !== undefined) {
        fieldErrors[idx] = `Currency "${badCode}" must be a 3-letter upper-case ISO-4217 code such as INR.`;
        return;
      }
      if (new Set(currencies).size !== currencies.length) {
        fieldErrors[idx] = "Currencies must be unique.";
        return;
      }
    }

    if (field.type === "longtext" && field.maxLength !== undefined && (field.maxLength < 1 || field.maxLength > 100000)) {
      fieldErrors[idx] = "Long text max length must be between 1 and 100000.";
      return;
    }

    if (field.type === "relation" || field.relation) {
      const rel = (field.relation ?? "").trim();
      if (field.type === "relation" && !rel) {
        fieldErrors[idx] = "Relation field must select a target entity.";
        return;
      }
      if (rel && !ENTITY_RELATION_PATTERN.test(rel)) {
        fieldErrors[idx] = `Invalid relation target "${rel}".`;
        return;
      }
    }
  });

  const ok = !nameError && Object.keys(fieldErrors).length === 0 && generalErrors.length === 0;

  return { ok, nameError, fieldErrors, generalErrors };
}

export function formatEntityCrudPreview(entity: EntityDefinition): {
  baseRoute: string;
  endpoints: Array<{ method: string; path: string; description: string }>;
  requestBodySchema: Record<string, string>;
  responseItemSchema: Record<string, string>;
} {
  const safeName = entity.name || "unnamed";
  const baseRoute = `/api/entities/${safeName}`;
  const requestBodySchema: Record<string, string> = {};
  const responseItemSchema: Record<string, string> = {
    id: "string (UUID)",
  };

  for (const f of entity.fields) {
    if (!f.name) continue;
    const reqTag = f.required ? "required" : "optional";
    let typeDesc: string = f.type;
    if (f.type === "enum") {
      typeDesc = `enum(${f.values.join(" | ")})`;
    } else if (f.type === "date") {
      typeDesc = "string (YYYY-MM-DD)";
    } else if (f.type === "money") {
      typeDesc = `{amount: integer (minor units), currency: ${(f.currencies ?? []).join(" | ")}}`;
    } else if (f.type === "longtext") {
      typeDesc = `string (max ${f.maxLength ?? 20000})`;
    } else if (f.type === "relation" || f.relation) {
      typeDesc = `string (FK -> ${f.relation ?? "entity.id"})`;
    }
    requestBodySchema[f.name] = `${typeDesc} (${reqTag})`;
    responseItemSchema[f.name] = typeDesc;
  }

  responseItemSchema.created_at = "string (ISO-8601)";
  responseItemSchema.updated_at = "string (ISO-8601)";

  return {
    baseRoute,
    endpoints: [
      {
        method: "GET",
        path: `${baseRoute}?limit=50&offset=0`,
        description: `List workspace ${safeName} rows (newest first)`,
      },
      {
        method: "POST",
        path: baseRoute,
        description: `Create a new ${safeName} row bound to ctx.workspace.id`,
      },
      {
        method: "GET",
        path: `${baseRoute}/:id`,
        description: `Read a single ${safeName} row by id + workspace_id`,
      },
      {
        method: "PATCH",
        path: `${baseRoute}/:id`,
        description: `Update declared fields on ${safeName} row in ctx.workspace.id`,
      },
      {
        method: "DELETE",
        path: `${baseRoute}/:id`,
        description: `Delete ${safeName} row in ctx.workspace.id`,
      },
    ],
    requestBodySchema,
    responseItemSchema,
  };
}

export function formatEntityIsolationPreview(entity: EntityDefinition): string {
  const safeName = entity.name || "unnamed";
  const table = `"ent_${safeName}"`;
  const cols = entity.fields
    .filter((f) => f.name)
    .map((f) => `"${f.name}"`)
    .join(", ");
  const selectCols = ['"id"', ...(cols ? [cols] : []), '"created_at"', '"updated_at"'].join(", ");
  return [
    `-- Mandatory Tenant Isolation Contract (AD-7 / C1):`,
    `-- Every query binds ctx.workspace.id from the verified session guard; body/query workspace_id is ignored.`,
    `SELECT ${selectCols} FROM ${table} WHERE "workspace_id" = :ctx.workspaceId ORDER BY "created_at" DESC LIMIT ? OFFSET ?;`,
    `SELECT ${selectCols} FROM ${table} WHERE "id" = ? AND "workspace_id" = :ctx.workspaceId;`,
    `INSERT INTO ${table} ("id", "workspace_id"${cols ? `, ${cols}` : ""}) VALUES (:uuid, :ctx.workspaceId${entity.fields
      .filter((f) => f.name)
      .map(() => ", ?")
      .join("")});`,
    `UPDATE ${table} SET ... WHERE "id" = ? AND "workspace_id" = :ctx.workspaceId;`,
    `DELETE FROM ${table} WHERE "id" = ? AND "workspace_id" = :ctx.workspaceId;`,
  ].join("\n");
}

export interface DestructiveEntityImpact {
  isDestructive: boolean;
  action: "remove_entity" | "update_entity";
  entityName: string;
  reasons: string[];
  droppedFields: string[];
  retypedFields: Array<{ name: string; fromType: string; toType: string }>;
  affectedWorkflows: Array<{
    workflowId: string;
    workflowName: string;
    nodeIds: string[];
  }>;
}

export function computeDestructiveEntityImpact(
  action: "remove_entity" | "update_entity",
  entityName: string,
  beforeEntity: EntityDefinition | null | undefined,
  afterEntity: EntityDefinition | null | undefined,
  workflows: ReadonlyArray<WorkflowDefinition>,
): DestructiveEntityImpact {
  const reasons: string[] = [];
  const droppedFields: string[] = [];
  const retypedFields: Array<{ name: string; fromType: string; toType: string }> = [];

  if (action === "remove_entity") {
    reasons.push(`Drops table "ent_${entityName}" and permanently deletes all tenant rows in every workspace.`);
    if (beforeEntity) {
      for (const f of beforeEntity.fields) {
        droppedFields.push(f.name);
      }
    }
  } else if (action === "update_entity" && beforeEntity && afterEntity) {
    const afterMap = new Map(afterEntity.fields.map((f) => [f.name, f]));
    for (const prevField of beforeEntity.fields) {
      const nextField = afterMap.get(prevField.name);
      if (!nextField) {
        droppedFields.push(prevField.name);
        reasons.push(`Drops column "${prevField.name}" (${prevField.type}) from "ent_${entityName}", losing stored values in that column.`);
      } else if (prevField.type !== nextField.type) {
        retypedFields.push({
          name: prevField.name,
          fromType: prevField.type,
          toType: nextField.type,
        });
        reasons.push(`Changes column "${prevField.name}" type from ${prevField.type} to ${nextField.type} on "ent_${entityName}".`);
      }
    }
  }

  const affectedWorkflows: Array<{
    workflowId: string;
    workflowName: string;
    nodeIds: string[];
  }> = [];

  for (const wf of workflows) {
    const matchingNodes: string[] = [];
    for (const node of wf.nodes) {
      const dataStr = JSON.stringify(node.data ?? {});
      const touchesEntity =
        node.data?.entity === entityName ||
        (node.type.startsWith("dynamic-entities.") && dataStr.includes(entityName)) ||
        dataStr.includes(`"${entityName}"`) ||
        dataStr.includes(`${entityName}.`);
      const touchesField = droppedFields.some(
        (f) => dataStr.includes(f) || wf.edges.some((e) => e.sourceHandle === `col-${f}` || e.targetHandle === `col-${f}`),
      );
      if (touchesEntity || touchesField) {
        matchingNodes.push(node.id);
      }
    }
    if (matchingNodes.length > 0) {
      affectedWorkflows.push({
        workflowId: wf.id,
        workflowName: wf.name,
        nodeIds: matchingNodes,
      });
    }
  }

  return {
    isDestructive: action === "remove_entity" || droppedFields.length > 0 || retypedFields.length > 0,
    action,
    entityName,
    reasons,
    droppedFields,
    retypedFields,
    affectedWorkflows,
  };
}

interface BrickEnableConflict {
  brickA: string;
  brickB: string;
  reason: string;
}

export interface BrickEnablePreview {
  brickId: string;
  manifest: CatalogBrickManifest;
  alreadyEnabled: boolean;
  missingProviders: Array<{
    brickId: string;
    displayName: string;
    providesCapability: string;
  }>;
  conflicts: BrickEnableConflict[];
  adds: {
    migrations: string[];
    routes: string[];
    nodes: Array<{ type: string; label: string; role: "trigger" | "action" | "logic" }>;
  };
  isExperimental: boolean;
  maturityReason?: string;
}

const PREFERRED_CAPABILITY_PROVIDER: Record<string, string> = {
  "workspace-context": "multi-workspace",
  "user-identity": "core-auth",
  "dynamic-entities": "dynamic-entities",
};

export function computeBrickEnablePreview(
  brickId: string,
  state: BlueprintState | null,
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
): BrickEnablePreview | null {
  const manifest = catalog[brickId];
  if (!manifest) return null;

  const enabledIds = new Set((state?.bricks ?? []).map((b) => b.id));
  const alreadyEnabled = enabledIds.has(brickId);

  const providedCapabilities = new Map<string, string>();
  for (const enabledId of enabledIds) {
    const m = catalog[enabledId];
    if (!m) continue;
    for (const cap of m.provides ?? []) {
      if (!providedCapabilities.has(cap)) {
        providedCapabilities.set(cap, enabledId);
      }
    }
  }
  for (const cap of manifest.provides ?? []) {
    if (!providedCapabilities.has(cap)) {
      providedCapabilities.set(cap, brickId);
    }
  }

  const missingProviders: Array<{
    brickId: string;
    displayName: string;
    providesCapability: string;
  }> = [];
  const plannedIds = new Set<string>([...enabledIds, brickId]);

  const resolveRequirementsFor = (targetManifest: CatalogBrickManifest) => {
    for (const reqCap of targetManifest.requires ?? []) {
      if (providedCapabilities.has(reqCap)) continue;

      const preferredId = PREFERRED_CAPABILITY_PROVIDER[reqCap];
      let chosenProvider: CatalogBrickManifest | undefined = preferredId && catalog[preferredId]?.provides.includes(reqCap) ? catalog[preferredId] : undefined;

      if (!chosenProvider) {
        const candidates = Object.values(catalog)
          .filter((c) => c.provides.includes(reqCap))
          .sort((a, b) => a.id.localeCompare(b.id));
        chosenProvider = candidates.find((c) => (c.ui?.maturity ?? "production") === "production") ?? candidates[0];
      }

      if (chosenProvider && !plannedIds.has(chosenProvider.id)) {
        plannedIds.add(chosenProvider.id);
        for (const cap of chosenProvider.provides) {
          if (!providedCapabilities.has(cap)) {
            providedCapabilities.set(cap, chosenProvider.id);
          }
        }
        resolveRequirementsFor(chosenProvider);
        missingProviders.push({
          brickId: chosenProvider.id,
          displayName: chosenProvider.ui?.displayName ?? chosenProvider.id,
          providesCapability: reqCap,
        });
      }
    }
  };

  resolveRequirementsFor(manifest);

  const conflicts: BrickEnableConflict[] = [];
  const seenPairs = new Set<string>();
  const recordConflict = (a: string, b: string, reason: string) => {
    const [first, second] = [a, b].sort() as [string, string];
    const key = `${first}\0${second}`;
    if (!seenPairs.has(key)) {
      seenPairs.add(key);
      conflicts.push({ brickA: first, brickB: second, reason });
    }
  };

  const candidateBatchIds = [...missingProviders.map((p) => p.brickId), brickId];
  const allActiveAfterEnable = new Set<string>([...enabledIds, ...candidateBatchIds]);

  for (const candidateId of candidateBatchIds) {
    const candidateManifest = catalog[candidateId];
    if (!candidateManifest) continue;
    for (const c of candidateManifest.conflicts ?? []) {
      if (c.brick !== candidateId && allActiveAfterEnable.has(c.brick)) {
        recordConflict(candidateId, c.brick, c.reason);
      }
    }
    for (const otherId of allActiveAfterEnable) {
      if (otherId === candidateId) continue;
      const otherManifest = catalog[otherId];
      for (const c of otherManifest?.conflicts ?? []) {
        if (c.brick === candidateId) {
          recordConflict(candidateId, otherId, c.reason);
        }
      }
      // Also check duplicate capability providers (which readiness flags as DUPLICATE_CAPABILITY_PROVIDER)
      for (const cap of candidateManifest.provides ?? []) {
        if (otherManifest?.provides.includes(cap)) {
          recordConflict(candidateId, otherId, `Both bricks provide capability "${cap}" (enable only one)`);
        }
      }
    }
  }

  return {
    brickId,
    manifest,
    alreadyEnabled,
    missingProviders,
    conflicts,
    adds: {
      migrations: [...(manifest.migrations ?? [])],
      routes: (manifest.routePrefixes ?? []).map((p) => `/api/${p}`),
      nodes: (manifest.nodes ?? []).map((n) => ({
        type: n.type,
        label: n.label,
        role: n.role,
      })),
    },
    isExperimental: (manifest.ui?.maturity ?? "production") === "experimental",
    maturityReason: manifest.ui?.maturityReason,
  };
}

export interface BrickDisableImpact {
  brickId: string;
  manifest: CatalogBrickManifest;
  dependentBricks: Array<{
    brickId: string;
    displayName: string;
    requiredCapability: string;
  }>;
  dependentWorkflows: Array<{
    workflowId: string;
    workflowName: string;
    nodeIds: string[];
  }>;
}

export function computeBrickDisableImpact(
  brickId: string,
  state: BlueprintState | null,
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
): BrickDisableImpact | null {
  const manifest = catalog[brickId];
  if (!manifest) return null;

  const remainingEnabledIds = (state?.bricks ?? []).map((b) => b.id).filter((id) => id !== brickId);

  const remainingCapabilities = new Set<string>();
  for (const id of remainingEnabledIds) {
    const m = catalog[id];
    for (const cap of m?.provides ?? []) {
      remainingCapabilities.add(cap);
    }
  }

  const dependentBricks: Array<{
    brickId: string;
    displayName: string;
    requiredCapability: string;
  }> = [];

  for (const id of remainingEnabledIds) {
    const m = catalog[id];
    if (!m) continue;
    for (const req of m.requires ?? []) {
      if (manifest.provides.includes(req) && !remainingCapabilities.has(req)) {
        dependentBricks.push({
          brickId: id,
          displayName: m.ui?.displayName ?? id,
          requiredCapability: req,
        });
      }
    }
  }

  const declaredNodeTypes = new Set((manifest.nodes ?? []).map((n) => n.type));
  const dependentWorkflows: Array<{
    workflowId: string;
    workflowName: string;
    nodeIds: string[];
  }> = [];

  for (const wf of state?.workflows ?? []) {
    const matchingNodes = wf.nodes.filter((n) => n.type.startsWith(`${brickId}.`) || declaredNodeTypes.has(n.type));
    if (matchingNodes.length > 0) {
      dependentWorkflows.push({
        workflowId: wf.id,
        workflowName: wf.name,
        nodeIds: matchingNodes.map((n) => n.id),
      });
    }
  }

  return {
    brickId,
    manifest,
    dependentBricks,
    dependentWorkflows,
  };
}

export function validateBrickSettingValue(
  key: string,
  rawValue: unknown,
  def: CatalogSettingDefinition,
): { ok: true; value: SettingValue } | { ok: false; error: string } {
  switch (def.type) {
    case "integer": {
      if (rawValue === "" || rawValue === null || rawValue === undefined) {
        return { ok: false, error: `${key} is required (integer ${def.min}..${def.max})` };
      }
      const num = typeof rawValue === "number" ? rawValue : Number(rawValue);
      if (!Number.isFinite(num) || !Number.isInteger(num)) {
        return { ok: false, error: `${key} must be a whole integer` };
      }
      if (num < def.min || num > def.max) {
        return {
          ok: false,
          error: `${key} must be between ${def.min} and ${def.max} (got ${num})`,
        };
      }
      return { ok: true, value: num };
    }
    case "number": {
      if (rawValue === "" || rawValue === null || rawValue === undefined) {
        return { ok: false, error: `${key} is required` };
      }
      const num = typeof rawValue === "number" ? rawValue : Number(rawValue);
      if (!Number.isFinite(num)) {
        return { ok: false, error: `${key} must be a valid number` };
      }
      if (def.min !== undefined && num < def.min) {
        return { ok: false, error: `${key} must be >= ${def.min}` };
      }
      if (def.max !== undefined && num > def.max) {
        return { ok: false, error: `${key} must be <= ${def.max}` };
      }
      return { ok: true, value: num };
    }
    case "enum": {
      const str = String(rawValue ?? "");
      if (!def.values.includes(str)) {
        return {
          ok: false,
          error: `${key} must be one of [${def.values.join(", ")}]`,
        };
      }
      return { ok: true, value: str };
    }
    case "boolean": {
      if (typeof rawValue !== "boolean") {
        return { ok: false, error: `${key} must be true or false` };
      }
      return { ok: true, value: rawValue };
    }
    case "string": {
      const str = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
      if (def.minLength !== undefined && str.length < def.minLength) {
        return { ok: false, error: `${key} must be at least ${def.minLength} characters` };
      }
      if (def.maxLength !== undefined && str.length > def.maxLength) {
        return { ok: false, error: `${key} must be at most ${def.maxLength} characters` };
      }
      return { ok: true, value: str };
    }
  }
}

export type PaletteCategory = "triggers" | "brick-actions" | "integrations" | "logic" | "data" | "http";

export interface PaletteNodeItem {
  type: string;
  label: string;
  summary: string;
  role: "trigger" | "logic" | "action";
  category: PaletteCategory;
  sourceKind: "core" | "brick" | "integration";
  brickId?: string;
  brickDisplayName?: string;
  app?: string;
  authType?: string;
  isBrickEnabled: boolean;
  maturity: BrickMaturity;
  maturityReason?: string;
  inputs: CatalogNodePort[];
  outputs: CatalogNodePort[];
  config: Record<string, CatalogSettingDefinition>;
  defaultData: Record<string, SettingValue>;
}

const DATA_CORE_NODE_TYPES = new Set(["core.field_map", "core.rename_keys", "core.format_template", "core.json_transform", "core.math", "core.date_time"]);

function extractDefaultNodeData(config: Record<string, CatalogSettingDefinition> | undefined): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const [k, def] of Object.entries(config ?? {})) {
    if (def.default !== undefined) {
      out[k] = def.default;
    }
  }
  return out;
}

export function getCatalogNodeDefinition(nodeType: string, catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG): CatalogNodeDefinition {
  for (const pack of Object.values(DEFAULT_NODE_PACKS)) {
    const found = pack.manifest.nodes.find((n) => n.type === nodeType);
    if (found) return found;
  }
  for (const manifest of Object.values(catalog)) {
    const found = (manifest.nodes ?? []).find((n) => n.type === nodeType);
    if (found) return found;
  }
  for (const entry of Object.values(DEFAULT_INTEGRATIONS)) {
    const projectedFound = (entry.nodes ?? []).find((n) => n.type === nodeType);
    if (projectedFound) return projectedFound;
    const intManifest = entry.manifest;
    for (const op of intManifest.operations ?? []) {
      const opId = op.operationId ?? op.id ?? "";
      const fullType = `int:${intManifest.app}.${opId}`;
      if (fullType === nodeType) {
        return {
          type: fullType,
          label: op.label ?? op.title ?? opId,
          summary: op.summary ?? op.description ?? "",
          role: "action",
          inputs: op.inputs ?? [],
          outputs: op.outputs ?? [],
          config: op.config ?? {},
          executor: "integration.operation",
          durable: op.durable ?? true,
          sideEffects: op.sideEffects ?? "write",
        };
      }
    }
    for (const trig of intManifest.triggers ?? []) {
      const fullType = `int:${intManifest.app}.trigger.${trig.id}`;
      if (fullType === nodeType) {
        return {
          type: fullType,
          label: trig.label ?? trig.title ?? trig.id,
          summary: trig.summary ?? trig.description ?? "",
          role: "trigger",
          inputs: [],
          outputs: trig.outputs ?? [],
          config: {},
          executor: "webhook-gateway.inbound_webhook",
          durable: false,
          sideEffects: "none",
        };
      }
    }
  }

  const isTrigger = nodeType.startsWith("trigger.") || nodeType.includes(".trigger.") || nodeType.endsWith(".trigger") || nodeType === "trigger";
  const isLogic = nodeType.startsWith("logic.") || nodeType.startsWith("transform.") || nodeType.startsWith("util.") || nodeType.startsWith("core.");

  return {
    type: nodeType,
    label: nodeType,
    summary: isTrigger ? "Workflow trigger node" : isLogic ? "Workflow logic / transform node" : "Workflow action node",
    role: isTrigger ? "trigger" : isLogic ? "logic" : "action",
    inputs: isTrigger ? [] : [{ id: "in", label: "Input", dataType: "any" }],
    outputs: [{ id: "out", label: "Output", dataType: "any" }],
    config: {},
    executor: nodeType,
    durable: false,
    sideEffects: isTrigger || isLogic ? "none" : "write",
  };
}

export function isTriggerNodeType(nodeType: string, catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG): boolean {
  return getCatalogNodeDefinition(nodeType, catalog).role === "trigger";
}

export function getPaletteCatalogItems(
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
  enabledBrickIds: ReadonlyArray<string> = [],
): PaletteNodeItem[] {
  const enabledSet = new Set(enabledBrickIds);
  const items: PaletteNodeItem[] = [];

  for (const pack of Object.values(DEFAULT_NODE_PACKS)) {
    const packMaturity = pack.manifest.ui?.maturity ?? "production";
    const packReason = pack.manifest.ui?.maturityReason;
    for (const node of pack.manifest.nodes ?? []) {
      let category: PaletteCategory = "logic";
      if (node.role === "trigger") {
        category = "triggers";
      } else if (node.type === "core.http_request") {
        category = "http";
      } else if (DATA_CORE_NODE_TYPES.has(node.type)) {
        category = "data";
      } else {
        category = "logic";
      }

      items.push({
        type: node.type,
        label: node.label,
        summary: node.summary ?? "",
        role: node.role,
        category,
        sourceKind: "core",
        isBrickEnabled: true,
        maturity: packMaturity,
        maturityReason: packReason,
        inputs: node.inputs ?? [],
        outputs: node.outputs ?? [],
        config: node.config ?? {},
        defaultData: extractDefaultNodeData(node.config),
      });
    }
  }

  for (const manifest of Object.values(catalog)) {
    const isEnabled = enabledSet.has(manifest.id);
    const maturity = manifest.ui?.maturity ?? "production";
    const maturityReason = manifest.ui?.maturityReason;
    const brickDisplayName = manifest.ui?.displayName ?? manifest.id;

    for (const node of manifest.nodes ?? []) {
      const category: PaletteCategory = node.role === "trigger" ? "triggers" : "brick-actions";
      items.push({
        type: node.type,
        label: node.label,
        summary: node.summary ?? manifest.ui?.summary ?? "",
        role: node.role,
        category,
        sourceKind: "brick",
        brickId: manifest.id,
        brickDisplayName,
        isBrickEnabled: isEnabled,
        maturity,
        maturityReason,
        inputs: node.inputs ?? [],
        outputs: node.outputs ?? [],
        config: node.config ?? {},
        defaultData: extractDefaultNodeData(node.config),
      });
    }
  }

  for (const entry of Object.values(DEFAULT_INTEGRATIONS)) {
    const intManifest = entry.manifest;
    const maturity = intManifest.ui?.maturity ?? "production";
    const maturityReason = intManifest.ui?.maturityReason;
    const appTitle = intManifest.ui?.displayName ?? intManifest.ui?.title ?? intManifest.app;
    const projectedByType = new Map((entry.nodes ?? []).map((n) => [n.type, n]));

    for (const op of intManifest.operations ?? []) {
      const opId = op.operationId ?? op.id ?? "";
      if (!opId) continue;
      const fullType = `int:${intManifest.app}.${opId}`;
      const projected = projectedByType.get(fullType);
      const opLabel = op.label ?? op.title ?? projected?.label ?? opId;
      const opSummary = op.summary ?? op.description ?? projected?.summary ?? intManifest.ui?.summary ?? intManifest.ui?.description ?? "";
      const opConfig = op.config ?? projected?.config ?? {};
      items.push({
        type: fullType,
        label: `${appTitle}: ${opLabel}`,
        summary: opSummary,
        role: "action",
        category: "integrations",
        sourceKind: "integration",
        app: intManifest.app,
        authType: intManifest.auth?.type ?? "api_key",
        brickDisplayName: appTitle,
        isBrickEnabled: true,
        maturity,
        maturityReason,
        inputs: op.inputs ?? projected?.inputs ?? [],
        outputs: op.outputs ?? projected?.outputs ?? [],
        config: opConfig,
        defaultData: extractDefaultNodeData(opConfig),
      });
    }

    for (const trig of intManifest.triggers ?? []) {
      const fullType = `int:${intManifest.app}.trigger.${trig.id}`;
      const trigLabel = trig.label ?? trig.title ?? trig.id;
      const trigSummary = trig.summary ?? trig.description ?? intManifest.ui?.summary ?? intManifest.ui?.description ?? "";
      items.push({
        type: fullType,
        label: `${appTitle}: ${trigLabel}`,
        summary: trigSummary,
        role: "trigger",
        category: "triggers",
        sourceKind: "integration",
        app: intManifest.app,
        authType: intManifest.auth?.type ?? "hmac_webhook_only",
        brickDisplayName: appTitle,
        isBrickEnabled: true,
        maturity,
        maturityReason,
        inputs: [],
        outputs: trig.outputs ?? [],
        config: {},
        defaultData: {},
      });
    }
  }

  return items;
}

function entityFieldTypeToPortDataType(fieldType: EntityFieldType | string): CatalogNodePort["dataType"] {
  switch (fieldType) {
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "json":
    case "money":
      return "object";
    case "text":
    case "string":
    case "longtext":
    case "enum":
    case "datetime":
    case "date":
    case "relation":
      return "string";
    default:
      return "any";
  }
}

export type EntityLookupInput = ReadonlyArray<EntityDefinition> | Readonly<Record<string, EntityDefinition>>;

function toEntityMap(entities: EntityLookupInput = []): Record<string, EntityDefinition> {
  if (Array.isArray(entities)) {
    const map: Record<string, EntityDefinition> = {};
    for (const ent of entities) {
      if (ent && typeof ent.name === "string") {
        map[ent.name] = ent;
      }
    }
    return map;
  }
  return { ...(entities as Record<string, EntityDefinition>) };
}

function resolveNodeBoundEntity(node: WorkflowNode, entities: EntityLookupInput = []): EntityDefinition | null {
  const entityMap = toEntityMap(entities);
  const rawData = (node.data as Record<string, unknown> | undefined) ?? {};
  const explicitEntity = typeof rawData.entity === "string" && rawData.entity.trim() ? rawData.entity.trim() : "";
  if (explicitEntity && Object.hasOwn(entityMap, explicitEntity)) {
    return entityMap[explicitEntity] ?? null;
  }

  const eventVal = typeof rawData.event === "string" && rawData.event.trim() ? rawData.event.trim() : "";
  if (eventVal.includes(".")) {
    const prefix = eventVal.split(".")[0]!;
    if (prefix && Object.hasOwn(entityMap, prefix)) {
      return entityMap[prefix] ?? null;
    }
  }

  if (node.type.startsWith("dynamic-entities.") || node.type === "core.brick_event") {
    const entityKeys = Object.keys(entityMap);
    if (entityKeys.length === 1) {
      return entityMap[entityKeys[0]!] ?? null;
    }
  }

  return null;
}

export interface EffectiveNodePortsResult {
  inputs: CatalogNodePort[];
  outputs: CatalogNodePort[];
  boundEntity: EntityDefinition | null;
  placeholders: string[];
}

export function getEffectiveNodePorts(
  node: WorkflowNode,
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
  entities: EntityLookupInput = [],
): EffectiveNodePortsResult {
  const baseDef = getCatalogNodeDefinition(node.type, catalog);
  const inputs: CatalogNodePort[] = [...baseDef.inputs];
  const outputs: CatalogNodePort[] = [...baseDef.outputs];

  const boundEntity = resolveNodeBoundEntity(node, entities);
  if (boundEntity) {
    const isEntityInputAction =
      node.type === "dynamic-entities.create_record" ||
      node.type === "dynamic-entities.update_record" ||
      (baseDef.role === "action" && node.type.startsWith("dynamic-entities."));

    // Entity columns as dynamic outputs (`col-<fieldName>`) on triggers & record-producing nodes
    if (!outputs.some((p) => p.id === "col-id")) {
      outputs.push({ id: "col-id", label: "id", dataType: "string" });
    }
    for (const field of boundEntity.fields) {
      const portId = `col-${field.name}`;
      const portType = entityFieldTypeToPortDataType(field.type);
      if (!outputs.some((p) => p.id === portId)) {
        outputs.push({
          id: portId,
          label: field.name,
          dataType: portType,
        });
      }
      if (isEntityInputAction && !inputs.some((p) => p.id === portId)) {
        inputs.push({
          id: portId,
          label: field.name,
          dataType: portType,
        });
      }
    }
  }

  // Template placeholders (`ph-<placeholder>`) from template/body/subject/message strings
  const rawData = (node.data as Record<string, unknown> | undefined) ?? {};
  const templateCandidates = [rawData.template, rawData.body, rawData.subject, rawData.message, rawData.text].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );

  const placeholderSet = new Set<string>();
  for (const str of templateCandidates) {
    for (const ph of extractTemplatePlaceholders(str)) {
      placeholderSet.add(ph);
    }
  }
  const placeholders = [...placeholderSet];
  for (const ph of placeholders) {
    const portId = `ph-${ph}`;
    if (!inputs.some((p) => p.id === portId)) {
      inputs.push({
        id: portId,
        label: ph,
        dataType: "string",
      });
    }
  }

  return {
    inputs,
    outputs,
    boundEntity,
    placeholders,
  };
}

interface DataPillFieldOption {
  nodeId: string;
  nodeLabel: string;
  nodeType: string;
  fieldName: string;
  label: string;
  dataType: CatalogNodePort["dataType"];
  expression: string;
  sourceKind: "entity-column" | "node-output";
}

export interface UpstreamAncestorNodeInfo {
  node: WorkflowNode;
  label: string;
  type: string;
  role: CatalogNodeDefinition["role"];
  boundEntityName: string | null;
  fields: DataPillFieldOption[];
}

export function getUpstreamAncestorNodes(
  workflow: WorkflowDefinition,
  targetNodeId: string,
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
  entities: EntityLookupInput = [],
): UpstreamAncestorNodeInfo[] {
  const reverseAdj = new Map<string, string[]>();
  for (const n of workflow.nodes) {
    reverseAdj.set(n.id, []);
  }
  for (const e of workflow.edges) {
    if (reverseAdj.has(e.target) && reverseAdj.has(e.source)) {
      reverseAdj.get(e.target)!.push(e.source);
    }
  }

  const visited = new Set<string>();
  const queue = [...(reverseAdj.get(targetNodeId) ?? [])];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === targetNodeId || visited.has(curr)) continue;
    visited.add(curr);
    for (const parentId of reverseAdj.get(curr) ?? []) {
      if (!visited.has(parentId)) {
        queue.push(parentId);
      }
    }
  }

  const ancestors = workflow.nodes.filter((n) => visited.has(n.id));
  return ancestors.map((ancNode) => {
    const baseDef = getCatalogNodeDefinition(ancNode.type, catalog);
    const nodeLabel = ancNode.label ?? baseDef.label ?? ancNode.id;
    const boundEntity = resolveNodeBoundEntity(ancNode, entities);
    const fields: DataPillFieldOption[] = [];
    const seenFields = new Set<string>();

    const addField = (fieldName: string, label: string, dataType: CatalogNodePort["dataType"], sourceKind: "entity-column" | "node-output") => {
      if (seenFields.has(fieldName)) return;
      seenFields.add(fieldName);
      fields.push({
        nodeId: ancNode.id,
        nodeLabel,
        nodeType: ancNode.type,
        fieldName,
        label,
        dataType,
        expression: `{{steps.${ancNode.id}.output.${fieldName}}}`,
        sourceKind,
      });
    };

    if (boundEntity) {
      addField("id", "id", "string", "entity-column");
      for (const f of boundEntity.fields) {
        addField(f.name, f.name, entityFieldTypeToPortDataType(f.type), "entity-column");
      }
    }

    for (const outPort of baseDef.outputs) {
      addField(outPort.id, outPort.label ?? outPort.id, outPort.dataType, "node-output");
    }

    if (ancNode.type === "core.if") {
      addField("matched", "matched", "boolean", "node-output");
      addField("branch", "branch", "string", "node-output");
      addField("value", "value", "any", "node-output");
    } else if (ancNode.type === "core.format_template") {
      addField("text", "text", "string", "node-output");
    }

    return {
      node: ancNode,
      label: nodeLabel,
      type: ancNode.type,
      role: baseDef.role,
      boundEntityName: boundEntity?.name ?? null,
      fields,
    };
  });
}

export interface WorkflowConnectionCheckResult {
  ok: boolean;
  reason?: string;
  sourcePort?: CatalogNodePort;
  targetPort?: CatalogNodePort;
}

export function validateWorkflowConnection(
  workflow: WorkflowDefinition,
  sourceNodeId: string,
  sourceHandle: string | null | undefined,
  targetNodeId: string,
  targetHandle: string | null | undefined,
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
  entities: EntityLookupInput = [],
): WorkflowConnectionCheckResult {
  if (!sourceNodeId || !targetNodeId) {
    return { ok: false, reason: "Select both source and target nodes." };
  }
  if (sourceNodeId === targetNodeId) {
    return { ok: false, reason: "Cannot connect a node to itself." };
  }

  const sourceNode = workflow.nodes.find((n) => n.id === sourceNodeId);
  const targetNode = workflow.nodes.find((n) => n.id === targetNodeId);
  if (!sourceNode) {
    return { ok: false, reason: `Source node "${sourceNodeId}" not found.` };
  }
  if (!targetNode) {
    return { ok: false, reason: `Target node "${targetNodeId}" not found.` };
  }

  const targetDef = getCatalogNodeDefinition(targetNode.type, catalog);
  const sourceEffective = getEffectiveNodePorts(sourceNode, catalog, entities);
  const targetEffective = getEffectiveNodePorts(targetNode, catalog, entities);

  if (targetDef.role === "trigger" || targetEffective.inputs.length === 0) {
    return {
      ok: false,
      reason: `Cannot connect to trigger node "${targetNode.label ?? targetNode.id}" (no input ports).`,
    };
  }

  const resolvedSourceHandle = sourceHandle ?? sourceEffective.outputs[0]?.id ?? "out";
  const resolvedTargetHandle = targetHandle ?? targetEffective.inputs[0]?.id ?? "in";

  const sourcePort = sourceEffective.outputs.find((p) => p.id === resolvedSourceHandle) ?? sourceEffective.outputs[0];
  const targetPort = targetEffective.inputs.find((p) => p.id === resolvedTargetHandle) ?? targetEffective.inputs[0];

  if (!sourcePort) {
    return {
      ok: false,
      reason: `Source node "${sourceNodeId}" has no output port "${resolvedSourceHandle}".`,
    };
  }
  if (!targetPort) {
    return {
      ok: false,
      reason: `Target node "${targetNodeId}" has no input port "${resolvedTargetHandle}".`,
    };
  }

  // Port dataType compatibility check
  const compatible = sourcePort.dataType === "any" || targetPort.dataType === "any" || sourcePort.dataType === targetPort.dataType;

  if (!compatible) {
    return {
      ok: false,
      reason: `Cannot connect ${sourcePort.dataType} output to ${targetPort.dataType} input`,
      sourcePort,
      targetPort,
    };
  }

  // Duplicate edge check
  const alreadyConnected = workflow.edges.some(
    (e) => e.source === sourceNodeId && e.target === targetNodeId && (e.sourceHandle ?? "out") === sourcePort.id && (e.targetHandle ?? "in") === targetPort.id,
  );
  if (alreadyConnected) {
    return {
      ok: false,
      reason: `Port ${sourceNodeId}.${sourcePort.id} is already connected to ${targetNodeId}.${targetPort.id}.`,
      sourcePort,
      targetPort,
    };
  }

  // Cycle detection: check if targetNodeId can already reach sourceNodeId
  const adj = new Map<string, string[]>();
  for (const n of workflow.nodes) {
    adj.set(n.id, []);
  }
  for (const e of workflow.edges) {
    adj.get(e.source)?.push(e.target);
  }
  const visited = new Set<string>();
  const stack = [targetNodeId];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    if (curr === sourceNodeId) {
      return {
        ok: false,
        reason: `Cannot connect ${sourceNodeId} → ${targetNodeId}: creates a cycle in the workflow DAG.`,
        sourcePort,
        targetPort,
      };
    }
    if (visited.has(curr)) continue;
    visited.add(curr);
    for (const next of adj.get(curr) ?? []) {
      if (!visited.has(next)) {
        stack.push(next);
      }
    }
  }

  return {
    ok: true,
    sourcePort,
    targetPort,
  };
}

export function computeStudioInverseOps(
  baseState: BlueprintState,
  ops: ReadonlyArray<Record<string, unknown>>,
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
): Array<Record<string, unknown>> {
  const bpCatalog = toBlueprintCatalog(catalog);
  const canonicalBase = normalizeBlueprintState(baseState as CanonicalBlueprintState);
  const normalizedOps: Array<Record<string, unknown> & { opId: string }> = ops.map((rawOp, idx) => ({
    ...rawOp,
    opId: typeof rawOp.opId === "string" && rawOp.opId.trim().length > 0 ? rawOp.opId : `studio-op-${idx + 1}`,
  }));

  const batchResult = applyOps(canonicalBase, normalizedOps, bpCatalog, STUDIO_NODE_REGISTRY);
  if (batchResult.ok) {
    return batchResult.inverseOps as unknown as Array<Record<string, unknown>>;
  }

  let current = canonicalBase;
  const stepInverses: Array<Array<Record<string, unknown>>> = [];
  for (const op of normalizedOps) {
    const step = applyOp(current, op, bpCatalog, STUDIO_NODE_REGISTRY);
    if (step.ok) {
      current = step.state;
      stepInverses.push(step.inverseOps as unknown as Array<Record<string, unknown>>);
    }
  }
  return stepInverses.reverse().flat();
}

export function reconstructBlueprintStateAtRevision(
  project: string,
  revisions: ReadonlyArray<RevisionSummary>,
  targetRev: number,
  currentState: BlueprintState | null,
  currentRev: number,
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
): BlueprintState {
  if (targetRev === currentRev && currentState) {
    return currentState;
  }
  if (targetRev <= 0) {
    return createEmptyBlueprint(project);
  }
  const ascending = [...revisions].sort((a, b) => a.revision - b.revision);
  const minRev = ascending[0]?.revision ?? 1;

  if (minRev === 1) {
    let state: BlueprintState = createEmptyBlueprint(project);
    for (const rev of ascending) {
      if (rev.revision > targetRev) break;
      if (rev.ops && rev.ops.length > 0) {
        state = applyStudioOps(state, rev.ops, catalog);
      }
    }
    return state;
  }

  if (currentState && targetRev < currentRev) {
    const descending = [...revisions].sort((a, b) => b.revision - a.revision);
    let state: BlueprintState = currentState;
    for (const rev of descending) {
      if (rev.revision <= targetRev) break;
      if (rev.revision <= currentRev && rev.inverseOps && rev.inverseOps.length > 0) {
        state = applyStudioOps(state, rev.inverseOps, catalog);
      }
    }
    return state;
  }

  return currentState ?? createEmptyBlueprint(project);
}

export function reconstructRevisionInverseOps(
  project: string,
  revisions: ReadonlyArray<RevisionSummary>,
  targetRev: number,
  currentState: BlueprintState | null,
  currentRev: number,
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
): Array<Record<string, unknown>> {
  const rev = revisions.find((r) => r.revision === targetRev);
  if (!rev) return [];
  if (rev.inverseOps && rev.inverseOps.length > 0) {
    return rev.inverseOps;
  }
  if (!rev.ops || rev.ops.length === 0) {
    return [];
  }
  const parentRev = rev.parentRevision ?? Math.max(0, targetRev - 1);
  const parentState = reconstructBlueprintStateAtRevision(project, revisions, parentRev, currentState, currentRev, catalog);
  return computeStudioInverseOps(parentState, rev.ops, catalog);
}

export interface StudioValidationIssue {
  id: string;
  code: string;
  severity: "error" | "warning";
  category: "capability" | "secret" | "expression" | "graph" | "entity" | "brick";
  message: string;
  suggestedFix?: string;
  nav: StudioNavTab;
  selection: StudioSelection | null;
  fieldKey?: string;
  nodeId?: string;
  edgeId?: string;
  brickId?: string;
  entityName?: string;
  workflowId?: string;
}

export function computeStudioValidationIssues(
  state: BlueprintState | null,
  catalog: Record<string, CatalogBrickManifest> = DEFAULT_CATALOG,
  secrets: ReadonlyArray<StudioSecretMetadata> = [],
  readiness?: ReadinessResult,
): StudioValidationIssue[] {
  if (!state) return [];
  const effectiveReadiness = readiness ?? computeStudioReadiness(state, catalog);
  const issues: StudioValidationIssue[] = [];
  const seenIds = new Set<string>();

  const pushIssue = (issue: StudioValidationIssue) => {
    if (!seenIds.has(issue.id)) {
      seenIds.add(issue.id);
      issues.push(issue);
    }
  };

  // 1. Convert @poc/blueprint readiness.needs into navigable StudioValidationIssues
  for (const need of effectiveReadiness.needs) {
    const pathParts = (need.path ?? "").split(".");
    const parsedBrickId = pathParts[0] === "bricks" ? pathParts[1] : undefined;
    const parsedSecretName = pathParts[0] === "bricks" && pathParts[2] === "secrets" ? pathParts[3] : undefined;
    const parsedCapability = pathParts[0] === "bricks" && pathParts[2] === "requires" ? pathParts[3] : undefined;
    const parsedWorkflowId = pathParts[0] === "workflows" ? pathParts[1] : undefined;
    const parsedNodeId = pathParts[0] === "workflows" && pathParts[2] === "nodes" ? pathParts[3] : undefined;

    if (need.code === "MISSING_CAPABILITY_PROVIDER") {
      const id = `need:cap:${parsedBrickId ?? "unknown"}:${parsedCapability ?? need.path}`;
      pushIssue({
        id,
        code: need.code,
        severity: "error",
        category: "capability",
        message: need.message,
        suggestedFix: need.suggestedFix,
        nav: "bricks",
        selection: parsedBrickId ? { kind: "brick", id: parsedBrickId } : null,
        fieldKey: "requires",
        brickId: parsedBrickId,
      });
    } else if (need.code === "UNBOUND_BRICK_SECRET") {
      const id = `need:secret:brick:${parsedBrickId ?? "unknown"}:${parsedSecretName ?? need.path}`;
      pushIssue({
        id,
        code: need.code,
        severity: "error",
        category: "secret",
        message: need.message,
        suggestedFix: need.suggestedFix,
        nav: "bricks",
        selection: parsedBrickId ? { kind: "brick", id: parsedBrickId } : null,
        fieldKey: parsedSecretName ?? "secrets",
        brickId: parsedBrickId,
      });
    } else if (
      need.code === "BRICK_CONFLICT" ||
      need.code === "DUPLICATE_CAPABILITY_PROVIDER" ||
      need.code === "UNKNOWN_BRICK" ||
      need.code === "INVALID_BRICK_CONFIG"
    ) {
      const id = `need:brick:${need.code}:${parsedBrickId ?? "unknown"}:${need.path}`;
      pushIssue({
        id,
        code: need.code,
        severity: "error",
        category: "brick",
        message: need.message,
        suggestedFix: need.suggestedFix,
        nav: "bricks",
        selection: parsedBrickId ? { kind: "brick", id: parsedBrickId } : null,
        fieldKey: need.code === "INVALID_BRICK_CONFIG" ? "config" : "conflicts",
        brickId: parsedBrickId,
      });
    } else if (parsedWorkflowId || need.code.startsWith("WORKFLOW_")) {
      const wf = state.workflows.find((w) => w.id === parsedWorkflowId);
      let matchedNodeId = parsedNodeId;
      if (!matchedNodeId && wf) {
        const foundNode = wf.nodes.find(
          (n) => need.message.includes(`"${n.id}"`) || need.message.includes(`node ${n.id}`) || need.message.includes(`(${n.id})`),
        );
        matchedNodeId = foundNode?.id;
      }
      const id = `need:wf:${need.code}:${parsedWorkflowId ?? "wf"}:${matchedNodeId ?? "graph"}`;
      pushIssue({
        id,
        code: need.code,
        severity: "error",
        category: "graph",
        message: need.message,
        suggestedFix: need.suggestedFix,
        nav: "workflows",
        workflowId: parsedWorkflowId,
        nodeId: matchedNodeId,
        selection: matchedNodeId
          ? { kind: "node", id: matchedNodeId, workflowId: parsedWorkflowId }
          : parsedWorkflowId
            ? { kind: "workflow", id: parsedWorkflowId }
            : null,
      });
    } else {
      const id = `need:${need.code}:${need.message}`;
      pushIssue({
        id,
        code: need.code,
        severity: "error",
        category: "brick",
        message: need.message,
        suggestedFix: need.suggestedFix,
        nav: "overview",
        selection: null,
      });
    }
  }

  // 2. Check bound SecretRefs for missing / revoked / expired status in Secrets Vault
  const secretByRef = new Map(secrets.map((s) => [s.ref, s]));
  const hasLoadedVaultSecrets = secrets.some((s) => !s.id.startsWith("missing:"));
  for (const sr of state.secretRefs ?? []) {
    const meta = secretByRef.get(sr.ref);
    const isInvalidVaultStatus =
      meta &&
      (meta.status === "revoked" || meta.status === "expired" || (meta.status === "missing" && (!meta.id.startsWith("missing:") || hasLoadedVaultSecrets)));
    if (isInvalidVaultStatus) {
      if (sr.targetKind === "brick") {
        pushIssue({
          id: `secret:status:brick:${sr.targetId}:${sr.secretName}`,
          code: `SECRET_${meta.status.toUpperCase()}`,
          severity: "error",
          category: "secret",
          message: `Brick "${sr.targetId}" secret "${sr.secretName}" (${sr.ref}) is ${meta.status} in the project vault.`,
          suggestedFix: `Open Connections & Secrets or the Brick Inspector to rotate "${sr.secretName}".`,
          nav: "bricks",
          selection: { kind: "brick", id: sr.targetId },
          fieldKey: sr.secretName,
          brickId: sr.targetId,
        });
      } else {
        const wf = state.workflows.find((w) => w.nodes.some((n) => n.id === sr.targetId));
        pushIssue({
          id: `secret:status:node:${sr.targetId}:${sr.secretName}`,
          code: `SECRET_${meta.status.toUpperCase()}`,
          severity: "error",
          category: "secret",
          message: `Node "${sr.targetId}" secret "${sr.secretName}" (${sr.ref}) is ${meta.status} in the project vault.`,
          suggestedFix: `Select node "${sr.targetId}" and bind or rotate "${sr.secretName}".`,
          nav: "workflows",
          workflowId: wf?.id,
          nodeId: sr.targetId,
          selection: { kind: "node", id: sr.targetId, workflowId: wf?.id },
          fieldKey: sr.secretName,
        });
      }
    }
  }

  // 3. Workflow node & graph validation:
  //    - Broken data-pill expressions ({{steps.<deletedOrNonAncestorNodeId>.output.<field>}})
  //    - Unbound or missing secret on HTTP / external action nodes
  //    - Invalid node config values
  //    - Port type mismatches on existing edges
  //    - Unreachable non-trigger nodes
  for (const wf of state.workflows ?? []) {
    const nodeById = new Map(wf.nodes.map((n) => [n.id, n]));

    // Edge port compatibility checks
    for (const edge of wf.edges ?? []) {
      const sourceNode = nodeById.get(edge.source);
      const targetNode = nodeById.get(edge.target);
      if (!sourceNode || !targetNode) {
        pushIssue({
          id: `graph:dangling-edge:${wf.id}:${edge.id}`,
          code: "DANGLING_WORKFLOW_EDGE",
          severity: "error",
          category: "graph",
          message: `Edge "${edge.id}" connects missing node "${!sourceNode ? edge.source : edge.target}".`,
          suggestedFix: `Disconnect dangling edge "${edge.id}".`,
          nav: "workflows",
          workflowId: wf.id,
          edgeId: edge.id,
          nodeId: targetNode?.id ?? sourceNode?.id,
          selection: { kind: "workflow", id: wf.id },
        });
        continue;
      }

      const sourceEffective = getEffectiveNodePorts(sourceNode, catalog, state.entities);
      const targetEffective = getEffectiveNodePorts(targetNode, catalog, state.entities);
      const resolvedSourceHandle = edge.sourceHandle ?? sourceEffective.outputs[0]?.id ?? "out";
      const resolvedTargetHandle = edge.targetHandle ?? targetEffective.inputs[0]?.id ?? "in";

      const sourcePort = sourceEffective.outputs.find((p) => p.id === resolvedSourceHandle) ?? sourceEffective.outputs[0];
      const targetPort = targetEffective.inputs.find((p) => p.id === resolvedTargetHandle) ?? targetEffective.inputs[0];

      if (sourcePort && targetPort) {
        const compatible = sourcePort.dataType === "any" || targetPort.dataType === "any" || sourcePort.dataType === targetPort.dataType;
        if (!compatible) {
          pushIssue({
            id: `graph:port-mismatch:${wf.id}:${edge.id}`,
            code: "PORT_TYPE_MISMATCH",
            severity: "error",
            category: "graph",
            message: `Cannot connect ${sourcePort.dataType} output (${sourceNode.id}.${sourcePort.id}) to ${targetPort.dataType} input (${targetNode.id}.${targetPort.id}).`,
            suggestedFix: `Disconnect edge "${edge.id}" or insert a transform node.`,
            nav: "workflows",
            workflowId: wf.id,
            edgeId: edge.id,
            nodeId: targetNode.id,
            selection: { kind: "node", id: targetNode.id, workflowId: wf.id },
          });
        }
      }
    }

    // Node-level validation
    for (const node of wf.nodes ?? []) {
      const nodeDef = getCatalogNodeDefinition(node.type, catalog);
      const rawData = (node.data as Record<string, unknown> | undefined) ?? {};

      // Check unreachable non-trigger node
      if (nodeDef.role !== "trigger" && wf.nodes.length > 1) {
        const hasIncoming = wf.edges.some((e) => e.target === node.id);
        if (!hasIncoming) {
          const alreadyHasUnreachable = issues.some(
            (iss) =>
              iss.workflowId === wf.id && iss.nodeId === node.id && (iss.code.includes("UNREACHABLE") || iss.message.toLowerCase().includes("unreachable")),
          );
          if (!alreadyHasUnreachable) {
            pushIssue({
              id: `graph:unreachable:${wf.id}:${node.id}`,
              code: "WORKFLOW_UNREACHABLE_NODE",
              severity: "error",
              category: "graph",
              message: `Node "${node.label ?? node.id}" (${node.id}) is unreachable (no incoming wire from a trigger).`,
              suggestedFix: `Connect an upstream output port to "${node.id}".`,
              nav: "workflows",
              workflowId: wf.id,
              nodeId: node.id,
              selection: { kind: "node", id: node.id, workflowId: wf.id },
            });
          }
        }
      }

      // Check unbound or missing secret on HTTP / secret-using node
      const explicitSecretRef = typeof rawData.secretRef === "string" ? rawData.secretRef.trim() : "";
      const requiresNodeSecret =
        rawData.requireSecret === true || rawData.authType === "secret" || rawData.authType === "bearer" || explicitSecretRef.length > 0;
      const boundNodeRefs = (state.secretRefs ?? []).filter(
        (sr) => (sr.targetKind === "connection" || (sr.targetKind as string) === "node") && sr.targetId === node.id,
      );
      if (requiresNodeSecret && boundNodeRefs.length === 0 && !explicitSecretRef) {
        pushIssue({
          id: `secret:unbound-node:${wf.id}:${node.id}`,
          code: "UNBOUND_NODE_SECRET",
          severity: "error",
          category: "secret",
          message: `Node "${node.label ?? node.id}" (${node.id}) requires an API key or secret binding, but none is bound.`,
          suggestedFix: `Select "${node.id}" and bind a secret in the Inspector.`,
          nav: "workflows",
          workflowId: wf.id,
          nodeId: node.id,
          fieldKey: "secretRef",
          selection: { kind: "node", id: node.id, workflowId: wf.id },
        });
      } else if (explicitSecretRef) {
        const isBoundInBlueprint = boundNodeRefs.some((sr) => sr.ref === explicitSecretRef);
        const vaultEntry = secretByRef.get(explicitSecretRef);
        if ((!isBoundInBlueprint && !vaultEntry) || (vaultEntry && vaultEntry.status !== "valid")) {
          pushIssue({
            id: `secret:missing-node-ref:${wf.id}:${node.id}:${explicitSecretRef}`,
            code: "UNBOUND_NODE_SECRET",
            severity: "error",
            category: "secret",
            message: `Node "${node.label ?? node.id}" (${node.id}) references secret "${explicitSecretRef}" which is ${vaultEntry?.status ?? "not bound"}.`,
            suggestedFix: `Bind a valid secret to "${node.id}" in the Inspector.`,
            nav: "workflows",
            workflowId: wf.id,
            nodeId: node.id,
            fieldKey: "secretRef",
            selection: { kind: "node", id: node.id, workflowId: wf.id },
          });
        }
      }

      // Check step expression pills ({{steps.<nodeId>.output.<field>}})
      const ancestors = getUpstreamAncestorNodes(wf, node.id, catalog, state.entities);
      const ancestorById = new Map(ancestors.map((a) => [a.node.id, a]));
      const ancestorNodeOutputs: Record<string, string[]> = {};
      for (const anc of ancestors) {
        ancestorNodeOutputs[anc.node.id] = anc.fields.map((f) => f.fieldName);
      }

      for (const [fieldKey, rawVal] of Object.entries(rawData)) {
        if (typeof rawVal === "string" && rawVal.includes("{{")) {
          const pills = extractStepExpressionPills(rawVal);
          for (const pill of pills) {
            const check = validateStepExpression(pill.raw, ancestorNodeOutputs);
            const refNodeId = pill.nodeId ?? "";
            if (!check.ok) {
              const targetExistsInWf = refNodeId ? nodeById.has(refNodeId) : false;
              const reasonMsg = !refNodeId
                ? (check.reason ?? `Invalid step expression ${pill.raw}.`)
                : !targetExistsInWf
                  ? `Broken reference ${pill.raw} in "${fieldKey}": step "${refNodeId}" was deleted or does not exist in workflow "${wf.name}".`
                  : `Broken reference ${pill.raw} in "${fieldKey}": step "${refNodeId}" is not an upstream ancestor of "${node.label ?? node.id}".`;
              pushIssue({
                id: `expr:${wf.id}:${node.id}:${fieldKey}:${pill.raw}`,
                code: "BROKEN_DATA_PILL",
                severity: "error",
                category: "expression",
                message: reasonMsg,
                suggestedFix: `Update "${fieldKey}" on "${node.id}" to reference an upstream step output.`,
                nav: "workflows",
                workflowId: wf.id,
                nodeId: node.id,
                fieldKey,
                selection: { kind: "node", id: node.id, workflowId: wf.id },
              });
              continue;
            }

            // Also verify top-level output field exists on upstream ancestor if known
            const ancInfo = refNodeId ? ancestorById.get(refNodeId) : undefined;
            const outputField = pill.fieldPath.split(".")[0];
            if (ancInfo && outputField && ancInfo.fields.length > 0 && !ancInfo.fields.some((f) => f.fieldName === outputField)) {
              pushIssue({
                id: `expr:field:${wf.id}:${node.id}:${fieldKey}:${pill.raw}`,
                code: "BROKEN_DATA_PILL_FIELD",
                severity: "error",
                category: "expression",
                message: `Broken reference ${pill.raw} in "${fieldKey}": upstream step "${refNodeId}" has no output field "${outputField}".`,
                suggestedFix: `Pick one of the available output fields from "${refNodeId}" (${ancInfo.fields.map((f) => f.fieldName).join(", ")}).`,
                nav: "workflows",
                workflowId: wf.id,
                nodeId: node.id,
                fieldKey,
                selection: { kind: "node", id: node.id, workflowId: wf.id },
              });
            }
          }
        }
      }

      // Check node config settings against CatalogSettingDefinition (when not a template expression)
      for (const [settingKey, settingDef] of Object.entries(nodeDef.config ?? {})) {
        if (!(settingKey in rawData)) continue;
        const val = rawData[settingKey];
        if (typeof val === "string" && val.includes("{{")) continue;
        const vCheck = validateBrickSettingValue(settingKey, val, settingDef);
        if (!vCheck.ok) {
          pushIssue({
            id: `node:config:${wf.id}:${node.id}:${settingKey}`,
            code: "INVALID_NODE_CONFIG",
            severity: "error",
            category: "expression",
            message: `Node "${node.label ?? node.id}" (${node.id}): ${vCheck.error}`,
            suggestedFix: `Fix "${settingKey}" in the Node Inspector.`,
            nav: "workflows",
            workflowId: wf.id,
            nodeId: node.id,
            fieldKey: settingKey,
            selection: { kind: "node", id: node.id, workflowId: wf.id },
          });
        }
      }
    }
  }

  // 4. Entity relation integrity check
  const entityNames = new Set((state.entities ?? []).map((e) => e.name));
  for (const ent of state.entities ?? []) {
    for (const field of ent.fields ?? []) {
      if (field.type === "relation" || field.relation) {
        const relTarget = (field.relation ?? "").split(".")[0]?.trim();
        if (relTarget && !entityNames.has(relTarget)) {
          pushIssue({
            id: `entity:relation:${ent.name}:${field.name}`,
            code: "BROKEN_ENTITY_RELATION",
            severity: "error",
            category: "entity",
            message: `Entity "${ent.name}" field "${field.name}" references missing entity "${relTarget}".`,
            suggestedFix: `Update "${ent.name}.${field.name}" or create entity "${relTarget}".`,
            nav: "data",
            entityName: ent.name,
            fieldKey: field.name,
            selection: { kind: "entity", id: ent.name },
          });
        }
      }
    }
  }

  return issues;
}
