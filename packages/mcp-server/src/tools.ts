import { z } from "zod";
import {
  BRICK_CATEGORIES,
  BRICK_MATURITIES,
  assemble,
  checkBrickConfig,
  computeArtifactHashes,
  projectIntegrationToNodes,
  sha256Hex,
} from "@poc/assembler";
import type { Catalog, ManifestNodeDefinition } from "@poc/assembler";
import {
  OP_TYPES,
  buildCatalogNodeRegistry,
  buildConflictActionableIssues,
  buildDeployBlockerActionableIssue,
  buildRuntimeStepActionableIssue,
  collectBlueprintActionableIssues,
  computeBlueprintBuildHash,
  computeBlueprintCodeHash,
  computeBlueprintGraphHash,
  computeReadiness,
  createEmptyBlueprint,
  isValidSecretRefHandle,
  semanticHash,
  toActionableIssue,
  toAssemblerBlueprint,
} from "@poc/blueprint";
import type {
  ActionableIssue,
  BlueprintState,
  BlueprintValidationError,
  IssueEnrichmentContext,
  Op,
  OpType,
  SemanticDiff,
} from "@poc/blueprint";
import { entitySchema, parseEntities, relationKeyHint, validateGraph } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { storeBuild } from "./store.ts";
import type {
  BlueprintAuthor,
  BlueprintClient,
  BlueprintConflictError,
  SettingValue,
} from "./store.ts";

export const DEFAULT_MCP_AUTHOR: BlueprintAuthor = {
  type: "agent",
  id: "agent:mcp",
  client: "mcp",
};

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

export type StudioRequestFn = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ToolContext {
  db: D1Like;
  catalog: Catalog;
  blueprint: BlueprintClient;
  author?: BlueprintAuthor;
  studioRequest?: StudioRequestFn;
  baseUrl?: string;
  /** The project the verified token is bound to. Standalone telemetry (no Studio) is read and written for it only. */
  projectId?: string;
  /** The verified workspace standalone test_workflow runs record (story 1.4); without one it refuses to run. */
  workspaceId?: string;
  /**
   * AD-V8: whether this caller's edits need human review. Studio sets it from the verified caller kind (an MCP token
   * needs review, a Studio session user does not); a standalone MCP server only ever serves agents. Default true.
   */
  reviewRequired?: boolean;
  /** AD-V8 / AD-S10: whether the project has a live production deployment, so a direct edit would reach production. */
  hasLiveProduction?: (project: string) => Promise<boolean>;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface Tool {
  name: string;
  description: string;
  input: z.ZodType;
  /** Only reads: tells a client it can run without asking. */
  readOnly: boolean;
  annotations: ToolAnnotations;
  run(context: ToolContext, args: never): Promise<ToolResult>;
}

export const DESTRUCTIVE_OP_KINDS = [
  "remove_brick",
  "remove_entity",
  "remove_workflow",
  "remove_node",
] as const;

export const MONEY_AFFECTING_BRICKS = [
  "credit-wallet",
  "subscription-plans",
  "metered-usage",
  "checkout-gateway",
] as const;

export interface OpSafetyMetadata {
  destructiveHint: boolean;
  moneyAffectingHint: boolean;
  tool: "apply_ops";
}

export const OP_SAFETY_METADATA: Readonly<Record<OpType, OpSafetyMetadata>> = {
  enable_brick: {
    destructiveHint: false,
    moneyAffectingHint: true,
    tool: "apply_ops",
  },
  configure_brick: {
    destructiveHint: false,
    moneyAffectingHint: true,
    tool: "apply_ops",
  },
  remove_brick: {
    destructiveHint: true,
    moneyAffectingHint: true,
    tool: "apply_ops",
  },
  set_identity: {
    destructiveHint: false,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  add_entity: {
    destructiveHint: false,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  update_entity: {
    destructiveHint: false,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  remove_entity: {
    destructiveHint: true,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  add_workflow: {
    destructiveHint: false,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  remove_workflow: {
    destructiveHint: true,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  add_node: {
    destructiveHint: false,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  update_node: {
    destructiveHint: false,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  remove_node: {
    destructiveHint: true,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  connect_edges: {
    destructiveHint: false,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  disconnect_edge: {
    destructiveHint: false,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  bind_secret_ref: {
    destructiveHint: false,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  unbind_secret_ref: {
    destructiveHint: false,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
  set_metadata: {
    destructiveHint: false,
    moneyAffectingHint: false,
    tool: "apply_ops",
  },
};

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9_]{6,}\b/g,
  /\bpx_mcp_[A-Za-z0-9_]{8,}\b/g,
  /\bcf_(?:token|pat|api)_[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\bCANARY_[A-Za-z0-9_]{4,}\b/g,
  /\bSECRET_[A-Za-z0-9_]{6,}\b/g,
];

const SAFE_METADATA_KEY_SET = new Set([
  "ref",
  "secretref",
  "secretrefs",
  "secretname",
  "secrets",
  "missingsecrets",
  "tokenid",
  "tokenref",
  "keyhint",
  "hassecret",
  "status",
  "writeonly",
  "authtype",
  "connectionstatus",
]);

const SENSITIVE_KEY_REGEX =
  /(?:secret|token|password|api_?key|private_?key|authorization|cookie|ciphertext|encrypted_value|raw_?secret|client_?secret)/i;

export function scrubMcpSecrets<T>(
  value: T,
  extraCanaries: readonly string[] = [],
): T {
  const canaries = extraCanaries.filter((c) => typeof c === "string" && c.length >= 4);

  const scrubString = (str: string): string => {
    let out = str;
    for (const canary of canaries) {
      if (out.includes(canary)) {
        out = out.split(canary).join("[REDACTED]");
      }
    }
    for (const regex of SECRET_VALUE_PATTERNS) {
      out = out.replace(regex, "[REDACTED]");
    }
    return out;
  };

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return scrubString(node);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const lower = k.toLowerCase();
        if (
          !SAFE_METADATA_KEY_SET.has(lower) &&
          SENSITIVE_KEY_REGEX.test(k) &&
          typeof v === "string"
        ) {
          out[k] = "[REDACTED]";
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    return node;
  };

  return walk(value) as T;
}

const projectName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const brickId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const maturityFilter = z.enum([...BRICK_MATURITIES, "unrated"] as const);

const ok = (value: unknown): ToolResult => ({
  text: JSON.stringify(value),
  isError: false,
});
const refuse = (...reasons: string[]): ToolResult => ({
  text: reasons.join("; "),
  isError: true,
});

function formatValidationFailure(
  issues: BlueprintValidationError[],
  ctx: IssueEnrichmentContext = {},
): ToolResult {
  const actionableIssues: ActionableIssue[] = issues.map((issue) =>
    toActionableIssue(issue, ctx),
  );
  return {
    isError: true,
    text: JSON.stringify({
      error: {
        code: "VALIDATION_FAILED",
        issues: issues.map((issue, idx) => {
          const actionable = actionableIssues[idx]!;
          return {
            code: issue.code,
            path: issue.path,
            message: issue.message,
            suggestedFix: issue.suggestedFix ?? actionable.suggestedFix,
            ...(actionable.remediationOp
              ? { remediationOp: actionable.remediationOp }
              : {}),
          };
        }),
        actionableIssues,
      },
      issues: actionableIssues,
      actionableIssues,
      summary:
        issues
          .map((i, idx) => {
            const fix = i.suggestedFix ?? actionableIssues[idx]?.suggestedFix;
            return `[${i.code}] ${i.path}: ${i.message}${fix ? ` (fix: ${fix})` : ""}`;
          })
          .join("; ") + "; nothing was changed",
    }),
  };
}

function formatConflictFailure(
  error: BlueprintConflictError,
  failedOp?: Record<string, unknown>,
): ToolResult {
  const actionableIssues = buildConflictActionableIssues({
    baseRev: error.baseRevision,
    currentRev: error.currentRevision,
    conflictingOps: (error.conflicts ?? []).map((c) => ({
      opId: c.opId,
      type: typeof failedOp?.type === "string" ? failedOp.type : "apply_ops",
      targetKey: c.target,
    })),
    ...(failedOp ? { failedOp } : {}),
  });
  return {
    isError: true,
    text: JSON.stringify({
      error: {
        code: "CONFLICT",
        message: error.message,
        baseRevision: error.baseRevision,
        currentRevision: error.currentRevision,
        conflicts: error.conflicts,
        issues: actionableIssues,
        actionableIssues,
      },
      issues: actionableIssues,
      actionableIssues,
      summary: `[CONFLICT] ${error.message} (baseRevision=${error.baseRevision}, currentRevision=${error.currentRevision}); nothing was changed`,
    }),
  };
}

/** What the project still lacks before it can be built: the reasons the assembler would give right now. */
function stillNeeds(
  _project: string,
  state: BlueprintState,
  catalog: Catalog,
): string[] {
  if (state.bricks.length === 0) return ["no brick is enabled yet"];
  const result = assemble(toAssemblerBlueprint(state), catalog);
  return result.ok ? [] : result.errors;
}

const reservedRoutes = (catalog: Catalog) =>
  new Set(Object.values(catalog.bricks).flatMap((b) => b.manifest.routePrefixes));

const settingText = (
  definition: Catalog["bricks"][string]["manifest"]["settings"][string],
): string =>
  definition.type === "integer"
    ? `whole number ${definition.min} to ${definition.max}, default ${definition.default}`
    : definition.type === "enum"
      ? `one of ${definition.values.join("|")}, default ${definition.default}`
      : definition.type === "string"
        ? `text${definition.example ? `, e.g. ${definition.example}` : ""}, default ${JSON.stringify(definition.default)}`
        : `true or false, default ${definition.default}`;

async function catalogHash(catalog: Catalog): Promise<string> {
  const signature = Object.keys(catalog.bricks)
    .sort()
    .map((id) => {
      const m = catalog.bricks[id]!.manifest;
      return [
        m.id,
        m.version,
        m.ui?.category ?? "",
        m.ui?.maturity ?? "unrated",
        m.ui?.summary ?? "",
      ];
    });
  return (await sha256Hex(JSON.stringify(signature))).slice(0, 12);
}

async function nodesCatalogHash(catalog: Catalog): Promise<string> {
  const nodes = collectCatalogNodes(catalog).map((n) => [
    n.type,
    n.role,
    n.source,
    n.app,
  ]);
  return (await sha256Hex(JSON.stringify(nodes))).slice(0, 12);
}

function encodeCursor(offset: number, hash: string): string {
  return btoa(`${offset}:${hash}`);
}

function decodeCursor(
  cursor: string,
  expectedHash: string,
): { ok: true; offset: number } | { ok: false; error: string } {
  let decoded: string;
  try {
    decoded = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return { ok: false, error: "invalid cursor: malformed base64" };
  }
  const match = /^(\d+):([0-9a-f]{12})$/.exec(decoded);
  if (!match) return { ok: false, error: "invalid cursor: unexpected format" };
  const [, offsetStr, cursorHash] = match;
  if (cursorHash !== expectedHash) {
    return { ok: false, error: "invalid cursor: catalog changed" };
  }
  return { ok: true, offset: Number(offsetStr) };
}

interface CatalogNodeEntry {
  type: string;
  label: string;
  summary: string;
  role: "trigger" | "action" | "logic";
  source: "core" | "brick" | "integration";
  app: string;
  definition: ManifestNodeDefinition;
}

function collectCatalogNodes(catalog: Catalog): CatalogNodeEntry[] {
  const entries = new Map<string, CatalogNodeEntry>();

  for (const [packId, pack] of Object.entries(catalog.nodePacks ?? {})) {
    for (const node of pack.manifest.nodes ?? []) {
      const isInt = node.type.startsWith("int:");
      const app = isInt
        ? (node.type.slice(4).split(".")[0] ?? packId)
        : packId;
      entries.set(node.type, {
        type: node.type,
        label: node.label,
        summary: node.summary ?? node.label,
        role: node.role,
        source: isInt ? "integration" : "core",
        app,
        definition: node,
      });
    }
  }

  for (const [bId, brickEntry] of Object.entries(catalog.bricks ?? {})) {
    for (const node of brickEntry.manifest.nodes ?? []) {
      if (!entries.has(node.type)) {
        const isInt = node.type.startsWith("int:");
        entries.set(node.type, {
          type: node.type,
          label: node.label,
          summary: node.summary ?? node.label,
          role: node.role,
          source: isInt ? "integration" : "brick",
          app: bId,
          definition: node,
        });
      }
    }
  }

  for (const [appId, intEntry] of Object.entries(catalog.integrations ?? {})) {
    const nodes =
      intEntry.nodes ?? projectIntegrationToNodes(intEntry.manifest);
    for (const node of nodes) {
      if (!entries.has(node.type)) {
        entries.set(node.type, {
          type: node.type,
          label: node.label,
          summary: node.summary ?? node.label,
          role: node.role,
          source: "integration",
          app: appId,
          definition: node,
        });
      }
    }
  }

  return [...entries.values()].sort((a, b) =>
    a.type < b.type ? -1 : a.type > b.type ? 1 : 0,
  );
}

const searchBricksInputSchema = z.object({
  query: z.string().optional(),
  category: z.enum(BRICK_CATEGORIES).optional(),
  capability: z.string().optional(),
  maturity: maturityFilter.optional(),
  limit: z.number().int().min(1).max(10).optional(),
  cursor: z.string().optional(),
  project: projectName.optional(),
});

async function runSearchBricks(
  { catalog, blueprint }: ToolContext,
  args: {
    query?: string;
    category?: (typeof BRICK_CATEGORIES)[number];
    capability?: string;
    maturity?: z.infer<typeof maturityFilter>;
    limit?: number;
    cursor?: string;
    project?: string;
  },
): Promise<ToolResult> {
  const hash = await catalogHash(catalog);
  let offset = 0;
  if (args.cursor !== undefined) {
    const parsedCursor = decodeCursor(args.cursor, hash);
    if (!parsedCursor.ok) return refuse(parsedCursor.error);
    offset = parsedCursor.offset;
  }

  const q = args.query?.trim().toLowerCase();
  const filtered = Object.values(catalog.bricks)
    .map(({ manifest }) => ({
      id: manifest.id,
      summary: manifest.ui?.summary ?? "",
      category: manifest.ui?.category ?? ("data" as const),
      maturity: (manifest.ui?.maturity ?? "unrated") as z.infer<
        typeof maturityFilter
      >,
      displayName: manifest.ui?.displayName ?? manifest.id,
      provides: manifest.provides,
    }))
    .filter((b) => {
      if (args.maturity !== undefined) {
        if (b.maturity !== args.maturity) return false;
      } else if (b.maturity === "experimental") {
        return false;
      }
      if (args.category !== undefined && b.category !== args.category)
        return false;
      if (
        args.capability !== undefined &&
        !b.provides.includes(args.capability)
      )
        return false;
      if (q) {
        const haystack =
          `${b.id} ${b.displayName} ${b.summary} ${b.category} ${b.provides.join(" ")}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const limit = args.limit ?? 10;
  const items = filtered
    .slice(offset, offset + limit)
    .map(({ id, summary, category, maturity }) => ({
      id,
      summary: (summary.split(/[.,;—]/)[0] ?? summary).slice(0, 32).trim() || id,
      category,
      maturity,
    }));
  const nextCursor =
    offset + limit < filtered.length
      ? encodeCursor(offset + limit, hash)
      : null;

  if (args.project === undefined) return ok({ items, nextCursor });
  const stored = await blueprint.getProject(args.project);
  return ok({
    items,
    nextCursor,
    project: stored
      ? {
          revision: stored.revision,
          enabled: stored.state.bricks,
          entities: stored.state.entities.map((e) => e.name),
          needs: stillNeeds(args.project, stored.state, catalog),
        }
      : null,
  });
}

const searchBricks: Tool = {
  name: "search_bricks",
  description: "List the bricks you can enable, paged.",
  input: searchBricksInputSchema,
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  run: runSearchBricks,
};

const listBricks: Tool = {
  name: "list_bricks",
  description: "List the bricks you can enable, paged.",
  input: searchBricksInputSchema,
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  run: runSearchBricks,
};

const getBrick: Tool = {
  name: "get_brick",
  description: "Read brick manifest and settings.",
  input: z.object({ id: brickId }),
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run({ catalog }, args: { id: string }) {
    const entry = catalog.bricks[args.id];
    if (!entry)
      return refuse(
        `unknown brick "${args.id}" (available: ${Object.keys(catalog.bricks).sort().join(", ")})`,
      );
    const { manifest } = entry;
    const entryAny = entry as unknown as Record<string, unknown>;
    const manifestAny = manifest as unknown as Record<string, unknown>;
    const uiAny = manifest.ui as unknown as Record<string, unknown> | undefined;
    const derivedTier = entryAny.derivedTier ?? manifestAny.derivedTier ?? uiAny?.derivedTier;
    const evidenceObj =
      (entryAny.evidence as { gitSha?: string } | undefined) ??
      (manifestAny.evidence as { gitSha?: string } | undefined) ??
      (uiAny?.evidence as { gitSha?: string } | undefined);
    const evidenceGitSha = evidenceObj?.gitSha;
    return ok({
      id: manifest.id,
      summary: manifest.ui?.summary ?? "",
      category: manifest.ui?.category ?? "data",
      maturity: manifest.ui?.maturity ?? "unrated",
      ...(manifest.ui?.maturityReason
        ? { maturityReason: manifest.ui.maturityReason }
        : {}),
      ...(derivedTier ? { derivedTier } : {}),
      ...(evidenceGitSha ? { evidence: { gitSha: evidenceGitSha } } : {}),
      provides: manifest.provides,
      needs: manifest.requires,
      settings: Object.fromEntries(
        Object.entries(manifest.settings).map(([name, definition]) => [
          name,
          settingText(definition),
        ]),
      ),
      servesEntities:
        manifest.worker?.routes?.some((r) =>
          Object.values(r.options || {}).some(
            (v) => typeof v === "object" && v !== null && "$entities" in v,
          ),
        ) ?? false,
      routes: manifest.routePrefixes,
      conflicts: manifest.conflicts ?? [],
    });
  },
};

const searchNodes: Tool = {
  name: "search_nodes",
  description: "Search workflow nodes paged.",
  input: z.object({
    query: z.string().optional(),
    role: z.enum(["trigger", "action", "logic"]).optional(),
    source: z.enum(["core", "brick", "integration"]).optional(),
    app: z.string().optional(),
    includeUnsupported: z.boolean().optional(),
    limit: z.number().int().min(1).max(10).optional(),
    cursor: z.string().optional(),
  }),
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run(
    { catalog },
    args: {
      query?: string;
      role?: "trigger" | "action" | "logic";
      source?: "core" | "brick" | "integration";
      app?: string;
      includeUnsupported?: boolean;
      limit?: number;
      cursor?: string;
    },
  ) {
    const hash = await nodesCatalogHash(catalog);
    let offset = 0;
    if (args.cursor !== undefined) {
      const parsedCursor = decodeCursor(args.cursor, hash);
      if (!parsedCursor.ok) return refuse(parsedCursor.error);
      offset = parsedCursor.offset;
    }

    const q = args.query?.trim().toLowerCase();
    const allNodes = collectCatalogNodes(catalog);
    const filtered = allNodes.filter((n) => {
      if (!args.includeUnsupported && n.definition.availability === "unsupported") return false;
      if (args.role !== undefined && n.role !== args.role) return false;
      if (args.source !== undefined && n.source !== args.source) return false;
      if (args.app !== undefined && n.app !== args.app) return false;
      if (q) {
        const haystack = `${n.type} ${n.label} ${n.summary} ${n.app} ${n.role}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    const limit = args.limit ?? 10;
    const items = filtered.slice(offset, offset + limit).map((n) => ({
      type: n.type,
      label: n.label,
      role: n.role,
      source: n.source,
      app: n.app,
    }));
    const nextCursor =
      offset + limit < filtered.length
        ? encodeCursor(offset + limit, hash)
        : null;

    return ok({ items, nextCursor });
  },
};

const getNode: Tool = {
  name: "get_node",
  description: "Read workflow node schema.",
  input: z.object({
    type: z.string().min(1),
  }),
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run({ catalog }, args: { type: string }) {
    const allNodes = collectCatalogNodes(catalog);
    const entry = allNodes.find((n) => n.type === args.type);
    if (!entry) {
      return refuse(
        `unknown node "${args.type}" (use search_nodes to discover available node types)`,
      );
    }
    const { definition } = entry;
    return ok({
      type: entry.type,
      label: entry.label,
      summary: entry.summary,
      role: entry.role,
      source: entry.source,
      app: entry.app,
      availability: definition.availability ?? "available",
      inputs: definition.inputs,
      outputs: definition.outputs,
      config: Object.fromEntries(
        Object.entries(definition.config ?? {}).map(([name, def]) => [
          name,
          settingText(def),
        ]),
      ),
      secrets: definition.secrets ?? [],
      bindings: definition.bindings ?? [],
      durable: definition.durable ?? true,
      sideEffects: definition.sideEffects,
    });
  },
};

const getBlueprintSummary: Tool = {
  name: "get_blueprint_summary",
  description: "Read compact blueprint summary.",
  input: z.object({
    project: projectName,
    rev: z.number().int().min(0).optional(),
  }),
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run({ catalog, blueprint }, args: { project: string; rev?: number }) {
    const stored = await blueprint.getProject(args.project, args.rev);
    const state = stored?.state ?? createEmptyBlueprint(args.project);
    const rev = stored?.revision ?? 0;
    const readiness = stored?.readiness ?? computeReadiness(state, catalog);
    return ok({
      project: args.project,
      rev,
      revision: rev,
      semanticHash: stored?.semanticHash ?? semanticHash(state),
      identity: state.identity,
      bricks: state.bricks.map((b) => b.id),
      entities: state.entities.map((e) => e.name),
      workflows: state.workflows.map((w) => ({
        id: w.id,
        name: w.name,
        nodeCount: w.nodes.length,
        edgeCount: w.edges.length,
      })),
      ready: readiness.ready,
      needs: readiness.needs,
    });
  },
};

const getBlueprintSlice: Tool = {
  name: "get_blueprint_slice",
  description: "Read targeted blueprint slice.",
  input: z.object({
    project: projectName,
    rev: z.number().int().min(0).optional(),
    sections: z
      .array(
        z.enum([
          "identity",
          "bricks",
          "entities",
          "workflows",
          "secretRefs",
          "metadata",
          "readiness",
        ]),
      )
      .optional(),
    workflowId: z.string().optional(),
    entityName: z.string().optional(),
    brickId: z.string().optional(),
  }),
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run(
    { catalog, blueprint },
    args: {
      project: string;
      rev?: number;
      sections?: Array<
        | "identity"
        | "bricks"
        | "entities"
        | "workflows"
        | "secretRefs"
        | "metadata"
        | "readiness"
      >;
      workflowId?: string;
      entityName?: string;
      brickId?: string;
    },
  ) {
    const stored = await blueprint.getProject(args.project, args.rev);
    const state = stored?.state ?? createEmptyBlueprint(args.project);
    const rev = stored?.revision ?? 0;
    const readiness = stored?.readiness ?? computeReadiness(state, catalog);

    const slice: Record<string, unknown> = {};

    if (args.workflowId !== undefined) {
      const wf = state.workflows.find((w) => w.id === args.workflowId);
      if (!wf) {
        return refuse(
          `unknown workflow "${args.workflowId}" in project "${args.project}"`,
        );
      }
      slice.workflow = wf;
    }

    if (args.entityName !== undefined) {
      const entity = state.entities.find((e) => e.name === args.entityName);
      if (!entity) {
        return refuse(
          `unknown entity "${args.entityName}" in project "${args.project}"`,
        );
      }
      slice.entity = entity;
    }

    if (args.brickId !== undefined) {
      const brick = state.bricks.find((b) => b.id === args.brickId);
      if (!brick) {
        return refuse(
          `brick "${args.brickId}" is not enabled on project "${args.project}"`,
        );
      }
      slice.brick = brick;
    }

    const requestedSections =
      args.sections ??
      (args.workflowId === undefined &&
      args.entityName === undefined &&
      args.brickId === undefined
        ? (["identity", "bricks", "entities", "workflows", "secretRefs"] as const)
        : []);

    for (const sec of requestedSections) {
      if (sec === "readiness") {
        slice.readiness = readiness;
      } else {
        slice[sec] = state[sec];
      }
    }

    return ok({
      project: args.project,
      rev,
      revision: rev,
      slice,
    });
  },
};

async function loadBoundConnectionIds(
  db: D1Like,
  project: string,
  state: BlueprintState,
  studioRequest?: StudioRequestFn,
): Promise<string[]> {
  const refs = new Set<string>(state.secretRefs.map((sr) => sr.ref));
  if (studioRequest) {
    try {
      const res = await studioRequest(
        `/api/projects/${encodeURIComponent(project)}/secrets`,
        { method: "GET" },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          secrets?: Array<{ ref?: string; status?: string }>;
        };
        for (const s of body.secrets ?? []) {
          if (typeof s.ref === "string" && s.ref.length > 0 && s.status !== "missing") {
            refs.add(s.ref);
          }
        }
      }
    } catch {
      // ignore
    }
  }
  try {
    const rows = (
      await db
        .prepare(
          `SELECT ref, status FROM studio_secret_vault WHERE project_id = ? ORDER BY ref ASC`,
        )
        .bind(project)
        .all<{ ref: string; status: string }>()
    ).results;
    for (const r of rows ?? []) {
      if (r.ref && r.status !== "missing") {
        refs.add(r.ref);
      }
    }
  } catch {
    // studio_secret_vault table not present in standalone DB
  }
  try {
    const metaRows = (
      await db
        .prepare(
          `SELECT ref, status FROM studio_connections_metadata WHERE project_id = ? ORDER BY ref ASC`,
        )
        .bind(project)
        .all<{ ref: string; status: string }>()
    ).results;
    for (const r of metaRows ?? []) {
      if (r.ref && r.status !== "missing" && r.status !== "revoked") {
        refs.add(r.ref);
      }
    }
  } catch {
    // studio_connections_metadata table not present in standalone DB
  }
  try {
    const pxRows = (
      await db
        .prepare(
          `SELECT ref, status FROM px_connections WHERE (project_id = ? OR project_id = 'default') ORDER BY ref ASC`,
        )
        .bind(project)
        .all<{ ref: string; status: string }>()
    ).results;
    for (const r of pxRows ?? []) {
      if (r.ref && r.status !== "missing" && r.status !== "revoked") {
        refs.add(r.ref);
      }
    }
  } catch {
    // px_connections table not present in standalone DB
  }
  return [...refs].sort();
}

const validateBlueprint: Tool = {
  name: "validate_blueprint",
  description: "Validate blueprint readiness.",
  input: z.object({
    project: projectName,
    rev: z.number().int().min(0).optional(),
  }),
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run(
    { db, catalog, blueprint, studioRequest },
    args: { project: string; rev?: number },
  ) {
    const stored = await blueprint.getProject(args.project, args.rev);
    const state = stored?.state ?? createEmptyBlueprint(args.project);
    const rev = stored?.revision ?? 0;
    const readiness = computeReadiness(state, catalog);
    const registry = buildCatalogNodeRegistry(catalog);
    const boundConnectionIds = await loadBoundConnectionIds(
      db,
      args.project,
      state,
      studioRequest,
    );
    const actionableIssues = collectBlueprintActionableIssues(state, {
      catalog,
      nodeRegistry: registry,
      boundConnectionIds,
      availableConnectionIds: boundConnectionIds,
    });
    const unboundIssuePaths = new Set(
      actionableIssues
        .filter((i) => i.code === "UNBOUND_CONNECTION")
        .map((i) => i.path.replace(/^\//, "").replace(/\//g, ".")),
    );
    const filteredNeeds = readiness.needs.filter(
      (n) => n.code !== "UNBOUND_CONNECTION" || unboundIssuePaths.has(n.path),
    );
    const assemblerNeeds = stillNeeds(args.project, state, catalog);

    return ok({
      project: args.project,
      rev,
      revision: rev,
      ready:
        filteredNeeds.length === 0 &&
        actionableIssues.length === 0 &&
        assemblerNeeds.length === 0,
      needs: filteredNeeds,
      assemblerErrors: assemblerNeeds,
      issues: actionableIssues,
    });
  },
};

/** A brick to enable: its id, or its id with settings. The two spellings a blueprint uses. */
const brickItem = z.union([
  brickId,
  z.strictObject({
    id: brickId,
    config: z
      .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
      .optional(),
  }),
]);

/** The most items one call may carry. */
const MAX_PER_CALL = 20;

let macroCallCounter = 0;

const enableBrick: Tool = {
  name: "enable_brick",
  description: "Enable bricks or update their settings on a project.",
  input: z.object({
    project: projectName,
    bricks: z.array(brickItem).min(1).max(MAX_PER_CALL),
  }),
  readOnly: false,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run(
    { catalog, blueprint, author, reviewRequired, hasLiveProduction },
    args: {
      project: string;
      bricks: Array<
        string | { id: string; config?: Record<string, SettingValue> }
      >;
    },
  ) {
    const wanted = args.bricks.map((item) =>
      typeof item === "string"
        ? { id: item, config: {} as Record<string, SettingValue> }
        : { id: item.id, config: item.config ?? {} },
    );
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const { id, config } of wanted) {
      if (seen.has(id)) problems.push(`brick "${id}" is listed twice`);
      seen.add(id);
      problems.push(...checkBrickConfig(id, config, catalog));
    }
    if (problems.length > 0) return refuse(...problems, "nothing was changed");

    // AD-V8: the legacy macro applies directly, so it follows apply_ops' mode "apply" rules.
    const gated = await proposalRequiredRefusal(
      {
        ...(reviewRequired !== undefined ? { reviewRequired } : {}),
        ...(hasLiveProduction ? { hasLiveProduction } : {}),
      },
      args.project,
      wanted.map(({ id }) => ({ type: "enable_brick", brickId: id })),
    );
    if (gated) return gated;

    const callId = ++macroCallCounter;
    let current = await blueprint.getProject(args.project);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const enabledSet = new Set(current?.state.bricks.map((b) => b.id) ?? []);
      const baseRevision = current?.revision ?? 0;
      const ops: Op[] = wanted.map(({ id, config }, idx) =>
        enabledSet.has(id)
          ? {
              opId: `mcp:${callId}:${attempt}:configure:${id}:${idx}`,
              type: "configure_brick",
              brickId: id,
              config,
              replace: true,
            }
          : {
              opId: `mcp:${callId}:${attempt}:enable:${id}:${idx}`,
              type: "enable_brick",
              brickId: id,
              ...(Object.keys(config).length > 0 ? { config } : {}),
            },
      );

      const applied = await blueprint.applyOps({
        project: args.project,
        baseRevision,
        author: author ?? DEFAULT_MCP_AUTHOR,
        ops,
      });

      if (applied.ok) {
        const result = {
          revision: applied.data.revision,
          blueprint: applied.data.state,
        };
        return ok({ project: args.project, enabled: result.blueprint.bricks.map((b) => b.id), needs: stillNeeds(args.project, result.blueprint, catalog), revision: result.revision, entities: result.blueprint.entities.map((e) => e.name) });
      }

      if (applied.status === 409) {
        current = {
          project: args.project,
          revision: applied.error.currentRevision,
          state: applied.error.currentState,
          semanticHash: "",
          readiness: { ready: false, needs: [] },
        };
        continue;
      }

      return refuse(
        ...applied.error.issues.map((i) => i.message),
        "nothing was changed",
      );
    }

    return refuse(
      "the project is being changed by many calls at once; try again",
      "nothing was changed",
    );
  },
};

const defineEntity: Tool = {
  name: "define_entity",
  description:
    "Declare or replace entity tables and fields on a project. Field types: text, longtext (up to 100000 chars), number (integer), boolean, enum (values), date (YYYY-MM-DD), money (stored and returned as {amount, currency}: amount an integer in minor units, currency one of the field's declared ISO-4217 currencies, e.g. currencies [\"INR\"]), and relation. A relation field points at another declared entity with the relation key: {\"name\":\"customer_id\",\"type\":\"relation\",\"relation\":\"customer\"}; its value is the id of a row of that entity in the same workspace.",
  input: z.object({
    project: projectName,
    entities: z.array(entitySchema).min(1).max(MAX_PER_CALL),
  }),
  readOnly: false,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run(
    { catalog, blueprint, author, reviewRequired, hasLiveProduction },
    args: { project: string; entities: unknown[] },
  ) {
    const reserved = reservedRoutes(catalog);
    let current = await blueprint.getProject(args.project);
    // A relation may target an entity declared in this call or one the project already has.
    const alone = parseEntities(args.entities, reserved, "free", {
      knownEntities: new Set(current?.state.entities.map((e) => e.name) ?? []),
    });
    if (!alone.ok) return refuse(...alone.errors, "nothing was changed");
    const declared = alone.entities;

    // AD-V8: the legacy macro applies directly, so it follows apply_ops' mode "apply" rules.
    const gated = await proposalRequiredRefusal(
      {
        ...(reviewRequired !== undefined ? { reviewRequired } : {}),
        ...(hasLiveProduction ? { hasLiveProduction } : {}),
      },
      args.project,
      declared.map((ent) => ({ type: "update_entity", entity: ent })),
    );
    if (gated) return gated;

    const callId = ++macroCallCounter;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const existingNames = new Set(
        current?.state.entities.map((e) => e.name) ?? [],
      );
      const baseRevision = current?.revision ?? 0;
      const ops: Op[] = declared.map((ent, idx) =>
        existingNames.has(ent.name)
          ? {
              opId: `mcp:${callId}:${attempt}:update_entity:${ent.name}:${idx}`,
              type: "update_entity",
              entity: ent,
            }
          : {
              opId: `mcp:${callId}:${attempt}:add_entity:${ent.name}:${idx}`,
              type: "add_entity",
              entity: ent,
            },
      );

      const applied = await blueprint.applyOps({
        project: args.project,
        baseRevision,
        author: author ?? DEFAULT_MCP_AUTHOR,
        ops,
      });

      if (applied.ok) {
        return ok({
          project: args.project,
          revision: applied.data.revision,
          enabled: applied.data.state.bricks.map((b) => b.id),
          entities: applied.data.state.entities.map((e) => e.name),
          needs: stillNeeds(args.project, applied.data.state, catalog),
        });
      }

      if (applied.status === 409) {
        current = {
          project: args.project,
          revision: applied.error.currentRevision,
          state: applied.error.currentState,
          semanticHash: "",
          readiness: { ready: false, needs: [] },
        };
        continue;
      }

      return refuse(
        ...applied.error.issues.map((i) => i.message),
        "nothing was changed",
      );
    }

    return refuse(
      "the project is being changed by many calls at once; try again",
      "nothing was changed",
    );
  },
};

/** True for a node type that belongs to a money brick (`credit-wallet.debit`, `checkout-gateway.*`, ...). */
export function isMoneyNodeType(nodeType: unknown): boolean {
  if (typeof nodeType !== "string") return false;
  const brick = nodeType.split(".")[0] ?? "";
  return (MONEY_AFFECTING_BRICKS as readonly string[]).includes(brick);
}

const WORKFLOW_EDIT_OPS = new Set(["update_node", "remove_node", "connect_edges", "disconnect_edge"]);

function classifyOpsSafety(
  ops: ReadonlyArray<Record<string, unknown>>,
  currentState?: BlueprintState | null,
) {
  const destructiveOps: string[] = [];
  const moneyAffectingOps: string[] = [];
  const destructiveSet = new Set<string>(DESTRUCTIVE_OP_KINDS);
  const moneyBrickSet = new Set<string>(MONEY_AFFECTING_BRICKS);
  // Workflows that already hold a money node: any edit to their nodes or wiring changes how money moves.
  const moneyWorkflows = new Set(
    (currentState?.workflows ?? [])
      .filter((wf) => (wf.nodes ?? []).some((n) => isMoneyNodeType(n.type)))
      .map((wf) => wf.id),
  );
  const asRecord = (v: unknown) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

  for (const op of ops) {
    const t = typeof op.type === "string" ? op.type : "";
    const id = typeof op.opId === "string" ? op.opId : t;
    const targetBrick =
      typeof op.brickId === "string"
        ? op.brickId
        : typeof op.targetId === "string"
          ? op.targetId
          : "";
    if (destructiveSet.has(t)) {
      destructiveOps.push(targetBrick ? `${t}:${targetBrick}` : `${t}:${id}`);
    }
    if (moneyBrickSet.has(targetBrick)) {
      moneyAffectingOps.push(`${t}:${targetBrick}`);
      continue;
    }
    const workflowId = typeof op.workflowId === "string" ? op.workflowId : "";
    if (t === "add_node" && isMoneyNodeType(asRecord(op.node).type)) {
      moneyAffectingOps.push(`add_node:${String(asRecord(op.node).type)}`);
    } else if (
      t === "update_node" &&
      (isMoneyNodeType(op.nodeType) || isMoneyNodeType(asRecord(op.patch).type) || isMoneyNodeType(asRecord(op.node).type))
    ) {
      moneyAffectingOps.push(`update_node:${workflowId}`);
    } else if (t === "add_workflow" && ((asRecord(op.workflow).nodes as unknown[] | undefined) ?? []).some((n) => isMoneyNodeType(asRecord(n).type))) {
      moneyAffectingOps.push(`add_workflow:${String(asRecord(op.workflow).id)}`);
    } else if (WORKFLOW_EDIT_OPS.has(t) && moneyWorkflows.has(workflowId)) {
      moneyAffectingOps.push(`${t}:${workflowId} (holds a money node)`);
    }
  }

  return {
    destructiveHint: destructiveOps.length > 0,
    moneyAffectingHint: moneyAffectingOps.length > 0,
    destructiveOps,
    moneyAffectingOps,
  };
}

/** A semantic diff as names only (what was added, removed or changed), for an agent's proposal answer. */
export function summarizeSemanticDiff(diff: SemanticDiff) {
  const label = (item: unknown): string => {
    const o = (item ?? {}) as { id?: unknown; name?: unknown; ref?: unknown };
    return String(o.id ?? o.name ?? o.ref ?? "?");
  };
  const section = (part: { added: unknown[]; removed: unknown[]; updated: unknown[] }) => ({
    added: part.added.map(label),
    removed: part.removed.map(label),
    updated: part.updated.map(label),
  });
  return {
    identity: diff.identity,
    bricks: section(diff.bricks),
    entities: section(diff.entities),
    workflows: section(diff.workflows),
    secretRefs: section(diff.secretRefs),
    isEmpty: diff.isEmpty,
  };
}

/** The reasons a direct (non-proposal) edit by an agent is refused (AD-V8). Empty means the edit is preview-safe. */
export interface ApplyRisk {
  risky: boolean;
  reasons: string[];
}

/**
 * AD-V8: the one test for whether an agent may apply ops directly. An op on a money brick, a destructive op, a brick
 * upgrade (`set_metadata.catalogVersion`) or any edit to a project with a live production deployment (AD-S10 hot path)
 * must go through a proposal that an editor accepts in Studio.
 */
export function classifyApplyRisk(
  ops: ReadonlyArray<Record<string, unknown>>,
  options: {
    liveProduction?: boolean;
    /** The project's current `metadata.catalogVersion`: a `set_metadata` with `replace: true` would drop it. */
    currentCatalogVersion?: string | null;
    /** The current blueprint: an edit inside a workflow that holds a money node is a money change. */
    currentState?: BlueprintState | null;
  } = {},
): ApplyRisk {
  const safety = classifyOpsSafety(ops, options.currentState);
  const reasons: string[] = [];
  for (const op of safety.moneyAffectingOps) reasons.push(`money setting: ${op}`);
  for (const op of safety.destructiveOps) reasons.push(`destructive: ${op}`);
  for (const op of ops) {
    if (op.type !== "set_metadata") continue;
    const metadata = op.metadata;
    if (
      typeof metadata === "object" &&
      metadata !== null &&
      Object.prototype.hasOwnProperty.call(metadata, "catalogVersion")
    ) {
      reasons.push("brick upgrade: set_metadata.catalogVersion");
    } else if (op.replace === true && options.currentCatalogVersion) {
      // replace drops every metadata key it does not name, so it removes the pinned catalogVersion: a brick upgrade.
      reasons.push("brick upgrade: set_metadata replace drops catalogVersion");
    }
  }
  if (options.liveProduction) {
    reasons.push(
      "production: the project has a live production deployment, so a direct edit would reach it",
    );
  }
  return { risky: reasons.length > 0, reasons };
}

/** The error an agent gets for a risky direct edit (AD-V8): a code, the reasons and the next step. */
export function proposalRequiredError(project: string, reasons: readonly string[]) {
  return {
    error: {
      code: "PROPOSAL_REQUIRED",
      message: `These ops cannot be applied directly by an agent (${reasons.join("; ")}). Nothing was changed.`,
      reasons: [...reasons],
      remediation:
        'Send the ops with mode "propose" (the default for MCP), then ask an editor to review and accept the proposal in Studio.',
    },
    project,
  };
}

/** AD-V8: refuses a risky direct edit by an agent. Null when the edit may apply. */
async function proposalRequiredRefusal(
  context: Pick<ToolContext, "reviewRequired" | "hasLiveProduction"> & { blueprint?: BlueprintClient },
  project: string,
  ops: ReadonlyArray<Record<string, unknown>>,
): Promise<ToolResult | null> {
  if (context.reviewRequired === false) return null;
  const liveProduction = context.hasLiveProduction
    ? await context.hasLiveProduction(project)
    : false;
  const needsState = ops.some(
    (op) => (op.type === "set_metadata" && op.replace === true) || WORKFLOW_EDIT_OPS.has(String(op.type)),
  );
  const currentState =
    needsState && context.blueprint ? ((await context.blueprint.getProject(project))?.state ?? null) : null;
  const risk = classifyApplyRisk(ops, {
    liveProduction,
    currentCatalogVersion: currentState?.metadata?.catalogVersion ?? null,
    currentState,
  });
  if (!risk.risky) return null;
  return {
    isError: true,
    text: JSON.stringify(proposalRequiredError(project, risk.reasons)),
  };
}

const applyOpsTool: Tool = {
  name: "apply_ops",
  description:
    'Propose (default) or apply blueprint operations. add_entity/update_entity field types: text, longtext (<=100000 chars), number, boolean, enum, date (YYYY-MM-DD), money ({amount, currency}: integer minor units, currency one of the declared ISO-4217 currencies, e.g. ["INR"]) and relation, which points at a declared entity with the relation key: {"name":"customer_id","type":"relation","relation":"customer"}.',
  input: z.object({
    project: projectName,
    expectedRev: z.number().int().min(0).optional(),
    baseRev: z.number().int().min(0).optional(),
    baseRevision: z.number().int().min(0).optional(),
    summary: z.string().max(240).optional(),
    mode: z.enum(["apply", "propose"]).optional(),
    ops: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_PER_CALL),
  }),
  readOnly: false,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  async run(
    { catalog, blueprint, author, reviewRequired, hasLiveProduction },
    args: {
      project: string;
      expectedRev?: number;
      baseRev?: number;
      baseRevision?: number;
      summary?: string;
      mode?: "apply" | "propose";
      ops: Array<Record<string, unknown>>;
    },
  ) {
    // Reject any attempt to pass raw secret values inside ops
    for (const op of args.ops) {
      if (
        "secretValue" in op ||
        "rawSecret" in op ||
        "apiKey" in op ||
        "cloudflareToken" in op ||
        "password" in op
      ) {
        return refuse(
          "RAW_SECRET_FORBIDDEN: MCP tools never accept raw secret values; use request_connection to obtain a Studio consent link",
          "nothing was changed",
        );
      }
    }

    const effectiveBaseRevision =
      args.expectedRev ?? args.baseRev ?? args.baseRevision;
    // AD-V8: an agent's edit is a proposal unless it asks to apply, and it may apply only preview-safe ops.
    const effectiveMode = args.mode ?? "propose";
    if (effectiveMode === "apply") {
      const refusal = await proposalRequiredRefusal(
        {
          ...(reviewRequired !== undefined ? { reviewRequired } : {}),
          ...(hasLiveProduction ? { hasLiveProduction } : {}),
          blueprint,
        },
        args.project,
        args.ops,
      );
      if (refusal) return refusal;
    }
    const applied = await blueprint.applyOps({
      project: args.project,
      ...(effectiveBaseRevision !== undefined
        ? { baseRevision: effectiveBaseRevision }
        : {}),
      author: author ?? DEFAULT_MCP_AUTHOR,
      ...(args.summary !== undefined ? { summary: args.summary } : {}),
      ops: args.ops,
      mode: effectiveMode,
    });

    if (!applied.ok) {
      if (applied.status === 409) {
        return formatConflictFailure(applied.error, args.ops[0]);
      }
      const current = await blueprint.getProject(args.project);
      return formatValidationFailure(applied.error.issues, {
        catalog,
        ...(current?.state ? { state: current.state } : {}),
      });
    }

    const safety = classifyOpsSafety(args.ops);
    const targetState = applied.data.proposedState ?? applied.data.state;
    const targetReadiness =
      applied.data.proposedReadiness ?? applied.data.readiness;
    const buildHash =
      targetState.bricks.length > 0
        ? computeBlueprintBuildHash(targetState)
        : undefined;

    return ok({
      project: args.project,
      rev: applied.data.revision,
      revision: applied.data.revision,
      mode: effectiveMode,
      ...(applied.data.status ? { status: applied.data.status } : {}),
      ...(applied.data.proposalId
        ? { proposalId: applied.data.proposalId }
        : {}),
      // A compact record: the full one (proposed state, readiness) is in Studio, where the proposal is reviewed.
      ...(applied.data.proposal
        ? {
            proposal: {
              proposalId: applied.data.proposal.proposalId,
              status: applied.data.proposal.status,
              baseRev: applied.data.proposal.baseRev,
              actor: applied.data.proposal.actor,
              summary: applied.data.proposal.summary,
              createdAt: applied.data.proposal.createdAt,
              opIds: applied.data.proposal.ops.map((op) => op.opId),
            },
          }
        : {}),
      // AD-V8: the reviewer sees the full semantic diff in Studio; the agent gets what changes, by name.
      ...(applied.data.diff ? { diffSummary: summarizeSemanticDiff(applied.data.diff) } : {}),
      ...(applied.data.rebasedFrom !== undefined
        ? { rebasedFrom: applied.data.rebasedFrom }
        : {}),
      semanticHash: applied.data.semanticHash,
      ...(applied.data.proposedSemanticHash
        ? { proposedSemanticHash: applied.data.proposedSemanticHash }
        : {}),
      ...(buildHash ? { buildHash } : {}),
      enabled: targetState.bricks.map((b) => b.id),
      entities: targetState.entities.map((e) => e.name),
      workflows: targetState.workflows.map((w) => w.id),
      ready: targetReadiness.ready,
      needs: stillNeeds(args.project, targetState, catalog),
      safety,
    });
  },
};

const requestConnection: Tool = {
  name: "request_connection",
  description: "Request Studio consent link for secret.",
  input: z.strictObject({
    project: projectName,
    ref: z.string().min(2).max(64).optional(),
    suggestedRef: z.string().min(2).max(64).optional(),
    provider: z.string().max(64).optional(),
    app: z.string().max(64).optional(),
    kind: z.string().max(32).optional(),
    brickId: z.string().max(40).optional(),
    secretName: z.string().max(64).optional(),
    reason: z.string().max(240).optional(),
    scopes: z.array(z.string()).optional(),
  }),
  readOnly: false,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run(
    { db, baseUrl, studioRequest },
    args: {
      project: string;
      ref?: string;
      suggestedRef?: string;
      provider?: string;
      app?: string;
      kind?: string;
      brickId?: string;
      secretName?: string;
      reason?: string;
      scopes?: string[];
    },
  ) {
    const effectiveProvider = args.provider ?? args.app ?? "custom";
    const effectiveRef =
      args.ref ??
      args.suggestedRef ??
      `sec_${effectiveProvider.toLowerCase().replace(/[^a-z0-9_]/g, "_")}_key`;

    const handleCheck = isValidSecretRefHandle(effectiveRef);
    if (!handleCheck.ok) {
      return refuse(
        `RAW_SECRET_FORBIDDEN: invalid secret reference handle "${effectiveRef}" (${handleCheck.reason}); never pass raw credentials over MCP`,
      );
    }

    const origin = (baseUrl ?? "https://studio.projectx.local").replace(
      /\/$/,
      "",
    );
    const params = new URLSearchParams({
      ref: effectiveRef,
      provider: effectiveProvider,
    });
    if (args.kind) params.set("kind", args.kind);
    if (args.brickId) params.set("brickId", args.brickId);
    if (args.secretName) params.set("secretName", args.secretName);
    if (args.reason) params.set("reason", args.reason);
    if (args.scopes && args.scopes.length > 0) {
      params.set("scopes", args.scopes.join(","));
    }

    const consentUrl = `${origin}/projects/${encodeURIComponent(args.project)}/connections/consent?${params.toString()}`;
    const connectUrl = `${origin}/projects/${encodeURIComponent(args.project)}/connections/new?app=${encodeURIComponent(effectiveProvider)}&ref=${encodeURIComponent(effectiveRef)}`;

    if (studioRequest) {
      await studioRequest(
        `/api/projects/${encodeURIComponent(args.project)}/connections/requests`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            app: effectiveProvider,
            reason: args.reason ?? `Connect ${effectiveProvider} for workflow execution`,
            scopes: args.scopes ?? [],
            suggestedRef: effectiveRef,
          }),
        },
      ).catch(() => {});
    } else if (db) {
      try {
        await db
          .prepare(
            `INSERT INTO studio_connection_requests (
               request_id, org_id, project_id, app, reason, scopes_json, suggested_ref,
               connect_url, status, requested_by, created_at
             ) VALUES (?, 'org_default', ?, ?, ?, ?, ?, ?, 'pending_user_consent', 'agent:mcp', datetime('now'))`,
          )
          .bind(
            `connreq_${args.project}_${effectiveProvider}_${Date.now()}`,
            args.project,
            effectiveProvider,
            args.reason ?? `Connect ${effectiveProvider}`,
            JSON.stringify(args.scopes ?? []),
            effectiveRef,
            connectUrl,
          )
          .run();
      } catch {
        // Table not present in standalone DB
      }
    }

    return ok({
      project: args.project,
      ref: effectiveRef,
      provider: effectiveProvider,
      app: effectiveProvider,
      kind: args.kind ?? "api_key",
      scopes: args.scopes ?? [],
      status: "awaiting_human_consent",
      connectionStatus: "pending_user_consent",
      writeOnly: true,
      consentUrl,
      connectUrl,
    });
  },
};

const listConnections: Tool = {
  name: "list_connections",
  description: "List connection and secret metadata.",
  input: z.strictObject({
    project: projectName,
  }),
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run({ db, blueprint, studioRequest }, args: { project: string }) {
    if (studioRequest) {
      const res = await studioRequest(
        `/api/projects/${encodeURIComponent(args.project)}/secrets`,
        { method: "GET" },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          secrets?: Array<Record<string, unknown>>;
        };
        const connections = (body.secrets ?? []).map((s) => ({
          ref: String(s.ref ?? ""),
          app: String(s.appOrBrick ?? s.app ?? "custom"),
          authType: String(s.authType ?? s.kind ?? "api_key"),
          kind: String(s.kind ?? "secret"),
          label: String(s.label ?? s.ref ?? ""),
          scopes: Array.isArray(s.scopes) ? s.scopes.map(String) : [],
          status: String(s.status ?? "configured"),
          connectionStatus: String(
            s.connectionStatus ??
              (s.status === "valid" ? "connected" : (s.status ?? "connected")),
          ),
          expiresAt: s.expiresAt ? String(s.expiresAt) : null,
          lastCheckedAt: s.lastCheckedAt ? String(s.lastCheckedAt) : null,
          keyHint: s.keyHint ? String(s.keyHint) : null,
          usedBy: Array.isArray(s.usedBy) ? s.usedBy : [],
          updatedAt: s.updatedAt ? String(s.updatedAt) : null,
        }));
        return ok(
          scrubMcpSecrets({
            project: args.project,
            connections,
          }),
        );
      }
    }

    const stored = await blueprint.getProject(args.project);
    const secretRefs = stored?.state.secretRefs ?? [];

    const vaultByRef = new Map<
      string,
      {
        app: string;
        authType: string;
        kind: string;
        label: string;
        scopes: string[];
        status: string;
        expiresAt: string | null;
        lastCheckedAt: string | null;
        keyHint: string | null;
        updatedAt: string | null;
      }
    >();
    try {
      const rows = (
        await db
          .prepare(
            `SELECT ref, kind, app_or_brick, label, status, key_hint, updated_at
             FROM studio_secret_vault
             WHERE project_id = ?
             ORDER BY ref ASC`,
          )
          .bind(args.project)
          .all<{
            ref: string;
            kind: string;
            app_or_brick: string;
            label: string;
            status: string;
            key_hint: string | null;
            updated_at: string | null;
          }>()
      ).results;
      for (const r of rows ?? []) {
        vaultByRef.set(r.ref, {
          app: r.app_or_brick ?? "custom",
          authType: r.kind,
          kind: r.kind,
          label: r.label,
          scopes: [],
          status: r.status,
          expiresAt: null,
          lastCheckedAt: null,
          keyHint: r.key_hint,
          updatedAt: r.updated_at,
        });
      }
    } catch {
      // studio_secret_vault table not present in standalone DB
    }

    try {
      const pxRows = (
        await db
          .prepare(
            `SELECT ref, app, auth_type, label, scopes_json, key_hint, status, expires_at, last_checked_at, updated_at
             FROM px_connections
             WHERE project_id = ? OR project_id = 'default'
             ORDER BY ref ASC`,
          )
          .bind(args.project)
          .all<{
            ref: string;
            app: string;
            auth_type: string;
            label: string;
            scopes_json: string;
            key_hint: string | null;
            status: string;
            expires_at: string | null;
            last_checked_at: string | null;
            updated_at: string | null;
          }>()
      ).results;
      for (const r of pxRows ?? []) {
        let scopes: string[] = [];
        try {
          const parsed = JSON.parse(r.scopes_json);
          if (Array.isArray(parsed)) scopes = parsed.map(String);
        } catch {
          scopes = [];
        }
        vaultByRef.set(r.ref, {
          app: r.app,
          authType: r.auth_type,
          kind: r.auth_type === "webhook-secret" ? "webhook_secret" : "api_key",
          label: r.label || r.ref,
          scopes,
          status: r.status,
          expiresAt: r.expires_at,
          lastCheckedAt: r.last_checked_at,
          keyHint: r.key_hint,
          updatedAt: r.updated_at,
        });
      }
    } catch {
      // px_connections table not present in standalone DB
    }

    const allRefs = new Set<string>([
      ...secretRefs.map((sr) => sr.ref),
      ...vaultByRef.keys(),
    ]);

    const connections = [...allRefs].sort().map((ref) => {
      const v = vaultByRef.get(ref);
      const usedBy = secretRefs
        .filter((sr) => sr.ref === ref)
        .map((sr) => ({
          targetKind: sr.targetKind,
          targetId: sr.targetId,
          secretName: sr.secretName,
        }));
      return {
        ref,
        app: v?.app ?? "custom",
        authType: v?.authType ?? "api_key",
        kind: v?.kind ?? "secret",
        label: v?.label ?? ref,
        scopes: v?.scopes ?? [],
        status: v?.status ?? "missing",
        expiresAt: v?.expiresAt ?? null,
        lastCheckedAt: v?.lastCheckedAt ?? null,
        keyHint: v?.keyHint ?? null,
        usedBy,
        updatedAt: v?.updatedAt ?? null,
      };
    });

    return ok(
      scrubMcpSecrets({
        project: args.project,
        connections,
      }),
    );
  },
};

/** The answer for a Studio error: the error itself, never a fallback to the local standalone tables (story 1.4). */
async function studioErrorResult(res: Response): Promise<ToolResult> {
  const body = await res.json().catch(() => ({ error: { code: `STUDIO_HTTP_${res.status}` } }));
  return { isError: true, text: JSON.stringify(scrubMcpSecrets(body)) };
}

/** The project whose standalone telemetry a call may read or write: the verified token's project. */
const standaloneProject = (ctx: ToolContext, args: { project: string }) => ctx.projectId ?? args.project;

async function addStandaloneColumn(db: D1Like, table: string, column: string): Promise<void> {
  const cols = ((await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results ?? []).map((c) => c.name);
  if (cols.includes(column)) return;
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).run();
  } catch (error) {
    if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
}

async function ensureStandaloneTelemetryTables(db: D1Like): Promise<void> {
  await ensureStandaloneTelemetryBaseTables(db);
  // Story 1.4: every standalone row carries its project; rows from before have none and no read returns them.
  for (const table of ["px_runs", "px_step_events", "px_logs"]) await addStandaloneColumn(db, table, "project_id");
}

async function ensureStandaloneTelemetryBaseTables(db: D1Like): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS px_runs (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        blueprint_rev INTEGER NOT NULL DEFAULT 1,
        trigger_type TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        input_json TEXT,
        output_json TEXT,
        error_json TEXT
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS px_step_events (
        step_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        blueprint_rev INTEGER NOT NULL DEFAULT 1,
        node_id TEXT NOT NULL,
        node_type TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        input_json TEXT,
        output_json TEXT,
        error_json TEXT,
        error_stack TEXT
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS px_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        brick_id TEXT,
        workflow_id TEXT,
        run_id TEXT,
        node_id TEXT,
        workspace_id TEXT,
        px_env TEXT NOT NULL DEFAULT 'preview',
        data_json TEXT
      )`,
    )
    .run();
}

const testWorkflow: Tool = {
  name: "test_workflow",
  description: "Run workflow rehearsal in preview.",
  input: z.strictObject({
    project: projectName,
    workflowId: z.string().min(1).max(64),
    nodeId: z.string().min(1).max(64).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    usePinnedOutputs: z.boolean().optional(),
  }),
  readOnly: false,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  async run(
    ctx,
    args: {
      project: string;
      workflowId: string;
      nodeId?: string;
      input?: Record<string, unknown>;
      usePinnedOutputs?: boolean;
    },
  ) {
    const { db, catalog, blueprint, studioRequest } = ctx;
    if (studioRequest) {
      const endpoint = args.nodeId
        ? `/api/projects/${encodeURIComponent(args.project)}/workflows/${encodeURIComponent(args.workflowId)}/nodes/${encodeURIComponent(args.nodeId)}/test-step`
        : `/api/projects/${encodeURIComponent(args.project)}/workflows/${encodeURIComponent(args.workflowId)}/runs`;
      const res = await studioRequest(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: args.input ?? {},
          triggerPayload: args.input ?? {},
          usePinnedOutputs: args.usePinnedOutputs ?? false,
          env: "preview",
        }),
      });
      const payload = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return {
          isError: true,
          text: JSON.stringify(scrubMcpSecrets(payload)),
        };
      }
      const resolvedStatus =
        payload.runStatus ??
        payload.finalStatus ??
        (payload.status === "queued" && Array.isArray(payload.steps)
          ? (payload.steps as Array<{ status?: string }>).some(
              (s) => s.status === "failed",
            )
            ? "failed"
            : "succeeded"
          : payload.status) ??
        "succeeded";
      const storedForWf = await blueprint.getProject(args.project);
      const wfDef = storedForWf?.state.workflows.find(
        (w) => w.id === args.workflowId,
      );
      const rawSteps = (
        Array.isArray(payload.steps)
          ? payload.steps
          : Array.isArray(payload.stepEvents)
            ? payload.stepEvents
            : []
      ) as Array<Record<string, unknown>>;
      const stepIssues: ActionableIssue[] = [];
      for (const st of rawSteps) {
        if (st.status === "failed") {
          const stNodeId = String(st.nodeId ?? st.node_id ?? "n_unknown");
          const stErr = String(
            st.error ?? st.errorStack ?? st.error_stack ?? "Step execution failed",
          );
          const nodeDef = wfDef?.nodes.find((n) => n.id === stNodeId);
          const actionable = buildRuntimeStepActionableIssue({
            workflowId: args.workflowId,
            nodeId: stNodeId,
            errorMessage: stErr,
            ...(nodeDef?.data ? { nodeData: nodeDef.data } : {}),
          });
          st.actionableIssue = actionable;
          stepIssues.push(actionable);
        }
      }
      return ok(
        scrubMcpSecrets({
          ...payload,
          status: resolvedStatus,
          issues: stepIssues,
        }),
      );
    }

    const stored = await blueprint.getProject(args.project);
    if (!stored) {
      return refuse(`unknown project "${args.project}"`);
    }
    const wf = stored.state.workflows.find((w) => w.id === args.workflowId);
    if (!wf) {
      return refuse(
        `unknown workflow "${args.workflowId}" in project "${args.project}"`,
      );
    }
    const registry = buildCatalogNodeRegistry(catalog);
    const { order } = validateGraph(wf.nodes, wf.edges, registry);
    const orderIndex = new Map(order.map((id, idx) => [id, idx]));
    const orderedNodes = [...wf.nodes].sort(
      (a, b) => (orderIndex.get(a.id) ?? 9999) - (orderIndex.get(b.id) ?? 9999),
    );
    const targetNodes = args.nodeId
      ? orderedNodes.filter((n) => n.id === args.nodeId)
      : orderedNodes;
    if (args.nodeId && targetNodes.length === 0) {
      return refuse(
        `unknown node "${args.nodeId}" in workflow "${args.workflowId}"`,
      );
    }

    // Story 1.4: a standalone run records the verified workspace and the token's project; never a default workspace.
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) {
      return refuse("NO_WORKSPACE: this server has no verified workspace for standalone runs; nothing was run");
    }
    const runProject = standaloneProject(ctx, args);
    await ensureStandaloneTelemetryTables(db);
    const now = new Date().toISOString();
    // A random id (crypto.randomUUID), shortened to keep tool pages small; written with INSERT, so a collision fails
    // instead of replacing another run.
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const safeInput = scrubMcpSecrets(args.input ?? {});

    const steps: Array<{
      stepId: string;
      nodeId: string;
      nodeType: string;
      status: "succeeded" | "failed";
      attempt: number;
      durationMs: number;
      input: unknown;
      output: unknown;
      error?: string;
      actionableIssue?: ActionableIssue;
    }> = [];
    const runIssues: ActionableIssue[] = [];
    const stepOutputs: Record<string, Record<string, unknown>> = {};
    let runStatus: "succeeded" | "failed" = "succeeded";
    let runError: string | null = null;

    const pillRe =
      /\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output\.([a-zA-Z0-9_.-]+)\s*\}\}/g;

    for (const node of targetNodes) {
      const stepId = `step_${runId}_${node.id}`;
      let missingInputError: string | null = null;
      let missingFieldInfo: {
        dataKey: string;
        srcNode: string;
        fieldPath: string;
        availableKeys: string[];
      } | null = null;

      for (const [dataKey, rawVal] of Object.entries(node.data ?? {})) {
        if (typeof rawVal !== "string") continue;
        pillRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pillRe.exec(rawVal)) !== null) {
          const srcNode = m[1]!;
          const fieldPath = m[2]!;
          const rootField = fieldPath.split(".")[0]!;
          const srcOut = stepOutputs[srcNode];
          if (!srcOut) continue;
          const availableKeys = Object.keys(srcOut).filter(
            (k) =>
              k !== "rehearsed" &&
              k !== "nodeId" &&
              k !== "nodeType" &&
              k !== "received",
          );
          if (availableKeys.length > 0 && !(rootField in srcOut)) {
            missingInputError = `RUN_STEP_MISSING_INPUT: Step "${node.id}" field "${dataKey}" mapped to "{{steps.${srcNode}.output.${fieldPath}}}", but field "${fieldPath}" does not exist on upstream node "${srcNode}" output (available fields: ${availableKeys.join(", ")})`;
            missingFieldInfo = {
              dataKey,
              srcNode,
              fieldPath,
              availableKeys,
            };
            break;
          }
        }
        if (missingInputError) break;
      }

      if (missingInputError && missingFieldInfo) {
        runStatus = "failed";
        runError = missingInputError;
        const actionable = buildRuntimeStepActionableIssue({
          workflowId: wf.id,
          nodeId: node.id,
          errorMessage: missingInputError,
          nodeData: node.data,
        });
        runIssues.push(actionable);
        steps.push({
          stepId,
          nodeId: node.id,
          nodeType: node.type,
          status: "failed",
          attempt: 1,
          durationMs: 2,
          input: safeInput,
          output: null,
          error: missingInputError,
          actionableIssue: actionable,
        });
        await db
          .prepare(
            `INSERT INTO px_step_events (
              step_id, run_id, workflow_id, blueprint_rev, node_id, node_type, attempt, status, started_at, finished_at, duration_ms, input_json, output_json, error_json, error_stack, project_id
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 'failed', ?, ?, 2, ?, NULL, ?, ?, ?)`,
          )
          .bind(
            stepId,
            runId,
            wf.id,
            stored.revision,
            node.id,
            node.type,
            now,
            now,
            JSON.stringify(safeInput),
            JSON.stringify({
              code: "RUN_STEP_MISSING_INPUT",
              message: missingInputError,
              actionableIssue: actionable,
            }),
            missingInputError,
            runProject,
          )
          .run();
        await db
          .prepare(
            `INSERT INTO px_logs (
              id, timestamp, level, message, brick_id, workflow_id, run_id, node_id, workspace_id, px_env, data_json, project_id
            ) VALUES (?, ?, 'error', ?, ?, ?, ?, ?, ?, 'preview', ?, ?)`,
          )
          .bind(
            `log_${stepId}`,
            now,
            missingInputError,
            node.type.includes(".") ? node.type.split(".")[0]! : null,
            wf.id,
            runId,
            node.id,
            workspaceId,
            JSON.stringify({
              errorCode: "RUN_STEP_MISSING_INPUT",
              failingField: missingFieldInfo.dataKey,
              upstreamNodeId: missingFieldInfo.srcNode,
              missingField: missingFieldInfo.fieldPath,
              availableFields: missingFieldInfo.availableKeys,
              actionableIssue: actionable,
            }),
            runProject,
          )
          .run();
        break;
      }

      const stepOut = scrubMcpSecrets({
        ...(typeof safeInput === "object" && safeInput !== null
          ? (safeInput as Record<string, unknown>)
          : {}),
        nodeId: node.id,
        nodeType: node.type,
        rehearsed: true,
        received: safeInput,
      });
      stepOutputs[node.id] = stepOut as Record<string, unknown>;
      steps.push({
        stepId,
        nodeId: node.id,
        nodeType: node.type,
        status: "succeeded",
        attempt: 1,
        durationMs: 2,
        input: safeInput,
        output: stepOut,
      });
      await db
        .prepare(
          `INSERT INTO px_step_events (
            step_id, run_id, workflow_id, blueprint_rev, node_id, node_type, attempt, status, started_at, finished_at, duration_ms, input_json, output_json, project_id
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 'succeeded', ?, ?, 2, ?, ?, ?)`,
        )
        .bind(
          stepId,
          runId,
          wf.id,
          stored.revision,
          node.id,
          node.type,
          now,
          now,
          JSON.stringify(safeInput),
          JSON.stringify(stepOut),
          runProject,
        )
        .run();
    }

    if (runStatus === "succeeded" && steps.length > 0) {
      const lastStep = steps.at(-1)!;
      await db
        .prepare(
          `INSERT INTO px_logs (
            id, timestamp, level, message, brick_id, workflow_id, run_id, node_id, workspace_id, px_env, data_json, project_id
          ) VALUES (?, ?, 'info', ?, ?, ?, ?, ?, ?, 'preview', NULL, ?)`,
        )
        .bind(
          `log_${runId}`,
          now,
          `Executed workflow ${wf.id} (${steps.length} steps)`,
          lastStep.nodeType.includes(".")
            ? lastStep.nodeType.split(".")[0]!
            : null,
          wf.id,
          runId,
          lastStep.nodeId,
          workspaceId,
          runProject,
        )
        .run();
    }

    const finalOutput = steps.at(-1)?.output ?? safeInput;
    await db
      .prepare(
        `INSERT INTO px_runs (
          run_id, workflow_id, blueprint_rev, trigger_type, status, started_at, finished_at, duration_ms, input_json, output_json, error_json, project_id
        ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        runId,
        wf.id,
        stored.revision,
        runStatus,
        now,
        now,
        steps.length * 2,
        JSON.stringify(safeInput),
        JSON.stringify(finalOutput),
        runError ? JSON.stringify({ message: runError, issues: runIssues }) : null,
        runProject,
      )
      .run();

    return ok({
      project: args.project,
      workflowId: wf.id,
      env: "preview",
      runId,
      blueprintRev: stored.revision,
      status: runStatus,
      durationMs: steps.length * 2,
      steps,
      issues: runIssues,
      output: finalOutput,
    });
  },
};

const listRuns: Tool = {
  name: "list_runs",
  description: "List workflow runs for project.",
  input: z.strictObject({
    project: projectName,
    env: z.enum(["preview", "production"]).optional(),
    workflowId: z.string().optional(),
    status: z
      .enum(["queued", "running", "succeeded", "failed", "cancelled"])
      .optional(),
    since: z.string().optional(),
    limit: z.number().int().min(1).max(10).optional(),
    cursor: z.string().optional(),
  }),
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run(
    ctx,
    args: {
      project: string;
      env?: "preview" | "production";
      workflowId?: string;
      status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
      since?: string;
      limit?: number;
      cursor?: string;
    },
  ) {
    const { db, studioRequest } = ctx;
    const limit = Math.min(10, Math.max(1, args.limit ?? 10));
    const env = args.env ?? "preview";

    if (studioRequest) {
      const qs = new URLSearchParams({
        env,
        limit: String(limit),
      });
      if (args.workflowId) qs.set("workflowId", args.workflowId);
      if (args.status) qs.set("status", args.status);
      if (args.since) qs.set("from", args.since);
      if (args.cursor) qs.set("cursor", args.cursor);

      const res = await studioRequest(
        `/api/projects/${encodeURIComponent(args.project)}/runs?${qs.toString()}`,
        { method: "GET" },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          runs?: Array<Record<string, unknown>>;
          nextCursor?: string | null;
        };
        const items = (body.runs ?? []).slice(0, limit).map((r) => ({
          runId: String(r.runId ?? r.run_id ?? ""),
          workflowId: String(r.workflowId ?? r.workflow_id ?? ""),
          blueprintRev: Number(r.blueprintRev ?? r.blueprint_rev ?? 1),
          status: String(r.status ?? ""),
          durationMs:
            r.durationMs !== undefined && r.durationMs !== null
              ? Number(r.durationMs)
              : null,
        }));
        return ok({
          project: args.project,
          env,
          items,
          nextCursor: body.nextCursor ?? null,
        });
      }
      return studioErrorResult(res);
    }

    await ensureStandaloneTelemetryTables(db);
    const clauses: string[] = ["project_id = ?"];
    const binds: unknown[] = [standaloneProject(ctx, args)];
    if (args.workflowId) {
      clauses.push("workflow_id = ?");
      binds.push(args.workflowId);
    }
    if (args.status) {
      clauses.push("status = ?");
      binds.push(args.status);
    }
    if (args.since) {
      clauses.push("started_at >= ?");
      binds.push(args.since);
    }
    const whereSql = `WHERE ${clauses.join(" AND ")}`;
    const offset = args.cursor ? Number.parseInt(args.cursor, 10) || 0 : 0;

    const rows = (
      await db
        .prepare(
          `SELECT run_id, workflow_id, blueprint_rev, trigger_type, status, started_at, duration_ms
           FROM px_runs
           ${whereSql}
           ORDER BY started_at DESC, run_id DESC
           LIMIT ? OFFSET ?`,
        )
        .bind(...binds, limit + 1, offset)
        .all<{
          run_id: string;
          workflow_id: string;
          blueprint_rev: number;
          trigger_type: string;
          status: string;
          started_at: string;
          duration_ms: number | null;
        }>()
    ).results;

    const slice = (rows ?? []).slice(0, limit);
    const nextCursor =
      (rows ?? []).length > limit ? String(offset + limit) : null;

    return ok({
      project: args.project,
      env,
      items: slice.map((r) => ({
        runId: r.run_id,
        workflowId: r.workflow_id,
        blueprintRev: Number(r.blueprint_rev),
        status: r.status,
        durationMs: r.duration_ms !== null ? Number(r.duration_ms) : null,
      })),
      nextCursor,
    });
  },
};

const getRunTrace: Tool = {
  name: "get_run_trace",
  description: "Read step trace for workflow runId.",
  input: z.strictObject({
    project: projectName,
    runId: z.string().min(1).max(128),
    env: z.enum(["preview", "production"]).optional(),
  }),
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run(
    ctx,
    args: {
      project: string;
      runId: string;
      env?: "preview" | "production";
    },
  ) {
    const { db, blueprint, studioRequest } = ctx;
    const env = args.env ?? "preview";
    const storedForTrace = await blueprint.getProject(args.project);

    if (studioRequest) {
      const res = await studioRequest(
        `/api/projects/${encodeURIComponent(args.project)}/runs/${encodeURIComponent(args.runId)}?env=${encodeURIComponent(env)}`,
        { method: "GET" },
      );
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        const runObj = (body.run as Record<string, unknown> | undefined) ?? {};
        const wfId = String(runObj.workflowId ?? runObj.workflow_id ?? "wf_1");
        const wfDef = storedForTrace?.state.workflows.find(
          (w) => w.id === wfId,
        );
        const rawSteps = (
          Array.isArray(body.stepEvents)
            ? body.stepEvents
            : Array.isArray(body.steps)
              ? body.steps
              : []
        ) as Array<Record<string, unknown>>;
        const traceIssues: ActionableIssue[] = [];
        for (const st of rawSteps) {
          if (st.status === "failed") {
            const stNodeId = String(st.nodeId ?? st.node_id ?? "n_unknown");
            const stErr = String(
              st.errorStack ??
                st.error_stack ??
                st.error ??
                runObj.errorStack ??
                "Step execution failed",
            );
            const nodeDef = wfDef?.nodes.find((n) => n.id === stNodeId);
            const actionable = buildRuntimeStepActionableIssue({
              workflowId: wfId,
              nodeId: stNodeId,
              errorMessage: stErr,
              ...(nodeDef?.data ? { nodeData: nodeDef.data } : {}),
            });
            st.actionableIssue = actionable;
            traceIssues.push(actionable);
          }
        }
        return ok(
          scrubMcpSecrets({
            ...body,
            issues: traceIssues,
          }),
        );
      }
      if (res.status === 404) {
        return refuse(
          `run "${args.runId}" not found in project "${args.project}"`,
        );
      }
      return studioErrorResult(res);
    }

    await ensureStandaloneTelemetryTables(db);
    const traceProject = standaloneProject(ctx, args);
    const runRow = await db
      .prepare(
        `SELECT run_id, workflow_id, blueprint_rev, trigger_type, status, started_at, finished_at, duration_ms, input_json, output_json, error_json
         FROM px_runs
         WHERE run_id = ? AND project_id = ?
         LIMIT 1`,
      )
      .bind(args.runId, traceProject)
      .first<{
        run_id: string;
        workflow_id: string;
        blueprint_rev: number;
        trigger_type: string;
        status: string;
        started_at: string;
        finished_at: string | null;
        duration_ms: number | null;
        input_json: string | null;
        output_json: string | null;
        error_json: string | null;
      }>();

    if (!runRow) {
      return refuse(
        `run "${args.runId}" not found in project "${args.project}"`,
      );
    }

    const stepRows = (
      await db
        .prepare(
          `SELECT step_id, node_id, node_type, attempt, status, started_at, finished_at, duration_ms, input_json, output_json, error_json, error_stack
           FROM px_step_events
           WHERE run_id = ? AND project_id = ?
           ORDER BY started_at ASC, attempt ASC`,
        )
        .bind(args.runId, traceProject)
        .all<{
          step_id: string;
          node_id: string;
          node_type: string;
          attempt: number;
          status: string;
          started_at: string;
          finished_at: string | null;
          duration_ms: number | null;
          input_json: string | null;
          output_json: string | null;
          error_json: string | null;
          error_stack: string | null;
        }>()
    ).results;

    const parseSafe = (raw: string | null) => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    };

    const wfDef = storedForTrace?.state.workflows.find(
      (w) => w.id === runRow.workflow_id,
    );
    const traceIssues: ActionableIssue[] = [];
    const formattedSteps = (stepRows ?? []).map((s) => {
      const parsedError = parseSafe(s.error_json);
      let actionableIssue: ActionableIssue | undefined;
      if (s.status === "failed") {
        const errMsg =
          s.error_stack ??
          (typeof parsedError === "object" &&
          parsedError !== null &&
          "message" in parsedError
            ? String((parsedError as { message?: unknown }).message)
            : String(parsedError ?? "Step execution failed"));
        const nodeDef = wfDef?.nodes.find((n) => n.id === s.node_id);
        actionableIssue = buildRuntimeStepActionableIssue({
          workflowId: runRow.workflow_id,
          nodeId: s.node_id,
          errorMessage: errMsg,
          ...(nodeDef?.data ? { nodeData: nodeDef.data } : {}),
        });
        traceIssues.push(actionableIssue);
      }
      return {
        stepId: s.step_id,
        nodeId: s.node_id,
        nodeType: s.node_type,
        attempt: Number(s.attempt),
        status: s.status,
        startedAt: s.started_at,
        finishedAt: s.finished_at,
        durationMs: s.duration_ms !== null ? Number(s.duration_ms) : null,
        input: parseSafe(s.input_json),
        output: parseSafe(s.output_json),
        error: parsedError,
        ...(actionableIssue ? { actionableIssue } : {}),
      };
    });

    const trace = scrubMcpSecrets({
      project: args.project,
      env,
      run: {
        runId: runRow.run_id,
        workflowId: runRow.workflow_id,
        blueprintRev: Number(runRow.blueprint_rev),
        triggerType: runRow.trigger_type,
        status: runRow.status,
        startedAt: runRow.started_at,
        finishedAt: runRow.finished_at,
        durationMs:
          runRow.duration_ms !== null ? Number(runRow.duration_ms) : null,
        input: parseSafe(runRow.input_json),
        output: parseSafe(runRow.output_json),
        error: parseSafe(runRow.error_json),
      },
      steps: formattedSteps,
      issues: traceIssues,
    });

    return ok(trace);
  },
};

const queryLogs: Tool = {
  name: "query_logs",
  description: "Query correlated structured logs.",
  input: z.strictObject({
    project: projectName,
    env: z.enum(["preview", "production"]).optional(),
    runId: z.string().optional(),
    nodeId: z.string().optional(),
    brickId: z.string().optional(),
    workspaceId: z.string().optional(),
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
    q: z.string().optional(),
    limit: z.number().int().min(1).max(10).optional(),
    cursor: z.string().optional(),
  }),
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run(
    ctx,
    args: {
      project: string;
      env?: "preview" | "production";
      runId?: string;
      nodeId?: string;
      brickId?: string;
      workspaceId?: string;
      level?: "debug" | "info" | "warn" | "error";
      q?: string;
      limit?: number;
      cursor?: string;
    },
  ) {
    const { db, studioRequest } = ctx;
    const env = args.env ?? "preview";
    const limit = Math.min(10, Math.max(1, args.limit ?? 10));

    if (studioRequest) {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (args.runId) qs.set("runId", args.runId);
      if (args.nodeId) qs.set("nodeId", args.nodeId);
      if (args.brickId) qs.set("brickId", args.brickId);
      if (args.workspaceId) qs.set("workspaceId", args.workspaceId);
      if (args.level) qs.set("level", args.level);
      if (args.q) qs.set("q", args.q);
      if (args.cursor) qs.set("cursor", args.cursor);

      const res = await studioRequest(
        `/api/projects/${encodeURIComponent(args.project)}/environments/${encodeURIComponent(env)}/logs?${qs.toString()}`,
        { method: "GET" },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          logs?: Array<Record<string, unknown>>;
          items?: Array<Record<string, unknown>>;
          nextCursor?: string | null;
        };
        const rawLogs = body.logs ?? body.items ?? [];
        const items = rawLogs.slice(0, limit).map((l) =>
          scrubMcpSecrets({
            level: String(l.level ?? "info"),
            message: String(l.message ?? ""),
            ...(l.runId ? { runId: String(l.runId) } : {}),
            ...(args.brickId && l.brickId ? { brickId: String(l.brickId) } : {}),
          }),
        );
        return ok({
          project: args.project,
          env,
          items,
          nextCursor: body.nextCursor ?? null,
        });
      }
      return studioErrorResult(res);
    }

    await ensureStandaloneTelemetryTables(db);
    const clauses: string[] = ["px_env = ?", "project_id = ?"];
    const binds: unknown[] = [env, standaloneProject(ctx, args)];

    if (args.runId) {
      clauses.push("run_id = ?");
      binds.push(args.runId);
    }
    if (args.nodeId) {
      clauses.push("node_id = ?");
      binds.push(args.nodeId);
    }
    if (args.brickId) {
      clauses.push("brick_id = ?");
      binds.push(args.brickId);
    }
    if (args.workspaceId) {
      clauses.push("workspace_id = ?");
      binds.push(args.workspaceId);
    }
    if (args.level) {
      clauses.push("level = ?");
      binds.push(args.level);
    }
    if (args.q) {
      clauses.push("(message LIKE ? OR data_json LIKE ?)");
      binds.push(`%${args.q}%`, `%${args.q}%`);
    }

    const offset = args.cursor ? Number.parseInt(args.cursor, 10) || 0 : 0;
    const rows = (
      await db
        .prepare(
          `SELECT id, timestamp, level, message, brick_id, workflow_id, run_id, node_id, workspace_id, data_json
           FROM px_logs
           WHERE ${clauses.join(" AND ")}
           ORDER BY timestamp DESC, id DESC
           LIMIT ? OFFSET ?`,
        )
        .bind(...binds, limit + 1, offset)
        .all<{
          id: string;
          timestamp: string;
          level: string;
          message: string;
          brick_id: string | null;
          workflow_id: string | null;
          run_id: string | null;
          node_id: string | null;
          workspace_id: string | null;
          data_json: string | null;
        }>()
    ).results;

    const slice = (rows ?? []).slice(0, limit);
    const nextCursor =
      (rows ?? []).length > limit ? String(offset + limit) : null;

    const items = slice.map((r) =>
      scrubMcpSecrets({
        level: r.level,
        message: r.message,
        ...(r.run_id ? { runId: r.run_id } : {}),
        ...(args.brickId && r.brick_id ? { brickId: r.brick_id } : {}),
      }),
    );

    return ok({
      project: args.project,
      env,
      items,
      nextCursor,
    });
  },
};

/**
 * Story 0.9 (R-F): the explicit result for a tool that needs a deploy target
 * when none is connected. It carries a remediation line instead of a
 * fabricated status or URL.
 */
export const NO_DEPLOY_TARGET_REMEDIATION =
  "Connect a Cloudflare target first: in Studio, connect a Cloudflare account (verify and save an API token) for this project's org, then retry deploy_apply.";

export function noDeployTargetIssue(
  project: string,
  env: string,
): ActionableIssue {
  return {
    code: "NO_TARGET",
    path: "/deploy/target",
    message: `No deploy target is connected for project "${project}" (${env}); nothing was deployed.`,
    suggestedFix: NO_DEPLOY_TARGET_REMEDIATION,
  };
}

function noDeployTargetResult(project: string, env: string): ToolResult {
  const issue = noDeployTargetIssue(project, env);
  return {
    isError: true,
    text: JSON.stringify({
      error: {
        code: "NO_TARGET",
        message: issue.message,
        remediation: NO_DEPLOY_TARGET_REMEDIATION,
        issues: [issue],
      },
      project,
      env,
      issues: [issue],
      blockers: [issue],
      summary: `${issue.message} (fix: ${NO_DEPLOY_TARGET_REMEDIATION})`,
    }),
  };
}

/** Story 1.19: where the owner provides a missing secret in Studio (Connections/secrets). */
function studioConnectionsUrl(baseUrl: string | undefined, project: string): string {
  // studio-web routes on ?project= and ?nav= (App.tsx), not on a path
  return `${(baseUrl ?? "https://studio.projectx.local").replace(/\/$/, "")}/?${new URLSearchParams({ project, nav: "connections" }).toString()}`;
}

const deployPlan: Tool = {
  name: "deploy_plan",
  description:
    "Generate deployment diff plan. Generated secrets are created on approval (preview only); optional secrets never block.",
  input: z.strictObject({
    project: projectName,
    env: z.enum(["preview", "production"]).optional(),
    target: z.enum(["preview", "production"]).optional(),
    rev: z.number().int().min(0).optional(),
  }),
  readOnly: true,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run(
    { catalog, blueprint, studioRequest, baseUrl },
    args: {
      project: string;
      env?: "preview" | "production";
      target?: "preview" | "production";
      rev?: number;
    },
  ) {
    const targetEnv = args.env ?? args.target ?? "preview";
    const connectionsUrl = studioConnectionsUrl(baseUrl, args.project);
    if (studioRequest) {
      const res = await studioRequest(
        `/api/projects/${encodeURIComponent(args.project)}/environments/${encodeURIComponent(targetEnv)}/plan`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            args.rev !== undefined ? { rev: args.rev } : {},
          ),
        },
      );
      const body = (await res.json()) as Record<string, unknown>;
      const errCode = (body.error as { code?: string } | undefined)?.code;
      if (res.ok) {
        const planId =
          typeof body.planId === "string"
            ? body.planId
            : `plan_${args.project}_${targetEnv}_r${String(body.revision ?? args.rev ?? 1)}`;
        const rawBlockers = Array.isArray(body.blockers) ? body.blockers : [];
        const actionableBlockers = rawBlockers.map((b) => {
          const msg =
            typeof b === "string"
              ? b
              : typeof b === "object" && b !== null && "message" in b
                ? String((b as { message?: unknown }).message)
                : String(b);
          return buildDeployBlockerActionableIssue(msg, { connectionsUrl });
        });
        // Story 1.19: names only, never a value: which secrets the approved deploy generates and which are optional.
        const planSecrets = Array.isArray(body.secrets) ? (body.secrets as Array<{ name?: unknown; status?: unknown }>) : [];
        const secretNamesWith = (status: string) => planSecrets.filter((s) => s.status === status).map((s) => String(s.name));
        return ok({
          project: args.project,
          env: targetEnv,
          planId,
          rev: Number(body.revision ?? body.targetRev ?? args.rev ?? 0),
          revision: Number(body.revision ?? body.targetRev ?? args.rev ?? 0),
          action: body.action ?? "apply",
          buildHash: body.buildHash ?? body.targetBuildHash ?? null,
          codeHash: body.codeHash ?? null,
          graphHash: body.graphHash ?? null,
          liveWithoutRedeploy: Boolean(body.liveWithoutRedeploy),
          blockers: actionableBlockers,
          issues: actionableBlockers,
          ...(secretNamesWith("will_generate").length > 0 ? { willGenerateSecrets: secretNamesWith("will_generate") } : {}),
          ...(secretNamesWith("optional_missing").length > 0 ? { optionalSecretsNotConfigured: secretNamesWith("optional_missing") } : {}),
          destructiveWarnings:
            typeof body.d1 === "object" &&
            body.d1 !== null &&
            Array.isArray((body.d1 as { destructiveWarnings?: unknown[] }).destructiveWarnings)
              ? (body.d1 as { destructiveWarnings: unknown[] }).destructiveWarnings
              : [],
        });
      }
      if (errCode !== "DEPLOY_TARGET_NOT_CONNECTED") {
        const errMsg =
          typeof (body.error as { message?: unknown } | undefined)?.message ===
          "string"
            ? String((body.error as { message: string }).message)
            : "Deploy plan blocked";
        const actionable = buildDeployBlockerActionableIssue(errMsg, { connectionsUrl });
        return {
          isError: true,
          text: JSON.stringify(
            scrubMcpSecrets({
              ...body,
              issues: [actionable],
              blockers: [actionable],
            }),
          ),
        };
      }
    }

    const stored = await blueprint.getProject(args.project, args.rev);
    if (!stored || stored.state.bricks.length === 0) {
      return refuse(
        `project "${args.project}" has no enabled bricks to plan deployment`,
      );
    }
    const assembled = assemble(toAssemblerBlueprint(stored.state), catalog);
    if (!assembled.ok) {
      return refuse(...assembled.errors, "nothing was planned");
    }
    const hashes = await computeArtifactHashes(
      assembled.files,
      stored.state.metadata?.catalogVersion
        ? { catalogVersion: stored.state.metadata.catalogVersion }
        : undefined,
    );
    const blockers: ActionableIssue[] =
      targetEnv === "production" && stored.state.identity === "stub"
        ? [
            buildDeployBlockerActionableIssue(
              "Production deployments cannot use stub identity; enable core-auth and set identity to core-auth.",
            ),
          ]
        : [];
    const planId = `plan_${args.project}_${targetEnv}_r${stored.revision}_${hashes.buildHash.slice(0, 8)}`;

    return ok({
      project: args.project,
      env: targetEnv,
      planId,
      rev: stored.revision,
      revision: stored.revision,
      action: blockers.length > 0 ? "blocked" : "apply",
      buildHash: hashes.buildHash,
      codeHash: hashes.codeHash,
      graphHash: hashes.graphHash,
      liveWithoutRedeploy: false,
      blockers,
      issues: blockers,
      destructiveWarnings: [],
    });
  },
};

const deployApply: Tool = {
  name: "deploy_apply",
  description:
    "Execute planned deployment to target. Generated secrets are created on approval (preview only, never shown); a missing required secret is provided by the owner in Studio.",
  input: z.strictObject({
    project: projectName,
    env: z.enum(["preview", "production"]).optional(),
    target: z.enum(["preview", "production"]).optional(),
    rev: z.number().int().min(0).optional(),
    planId: z.string().min(1).max(128).optional(),
    confirmDestructive: z.boolean().optional(),
    confirmedMigrationNames: z.array(z.string()).optional(),
    approvalId: z.string().min(1).max(128).optional(),
  }),
  readOnly: false,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  async run(
    { db, catalog, blueprint, studioRequest, baseUrl },
    args: {
      project: string;
      env?: "preview" | "production";
      target?: "preview" | "production";
      rev?: number;
      planId?: string;
      confirmDestructive?: boolean;
      confirmedMigrationNames?: string[];
      approvalId?: string;
    },
  ) {
    const targetEnv = args.env ?? args.target ?? "preview";
    const effectivePlanId =
      args.planId ?? `plan_${args.project}_${targetEnv}`;
    if (studioRequest) {
      const res = await studioRequest(
        `/api/projects/${encodeURIComponent(args.project)}/environments/${encodeURIComponent(targetEnv)}/deploy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            planId: effectivePlanId,
            ...(args.rev !== undefined ? { rev: args.rev } : {}),
            ...(args.confirmDestructive !== undefined
              ? { confirmDestructive: args.confirmDestructive }
              : {}),
            ...(args.confirmedMigrationNames !== undefined
              ? { confirmedMigrationNames: args.confirmedMigrationNames }
              : {}),
            ...(args.approvalId !== undefined ? { approvalId: args.approvalId } : {}),
          }),
        },
      );
      const body = (await res.json()) as Record<string, unknown>;
      const errCode = (body.error as { code?: string } | undefined)?.code;
      if (res.ok) {
        const envObj =
          typeof body.environment === "object" && body.environment !== null
            ? (body.environment as Record<string, unknown>)
            : {};
        // Story 0.9 (R-F): report only what studio returned. A missing status or deployment id is an
        // error, never a default "deployed" or an invented id.
        const deploymentId =
          body.deployId ?? body.deploymentId ?? envObj.lastDeploymentId;
        const status = body.status ?? envObj.status;
        if (
          typeof deploymentId !== "string" ||
          deploymentId.length === 0 ||
          typeof status !== "string" ||
          status.length === 0
        ) {
          return {
            isError: true,
            text: JSON.stringify({
              error: {
                code: "PROVIDER_ERROR",
                message: `Studio answered the deploy without a ${typeof status !== "string" || status.length === 0 ? "status" : "deployment id"}; the deploy state is unknown, so nothing is reported as deployed.`,
              },
              project: args.project,
              env: targetEnv,
            }),
          };
        }
        const revision = body.revision ?? body.deployedRev ?? envObj.deployedRev;
        return ok({
          project: args.project,
          env: targetEnv,
          planId: effectivePlanId,
          deploymentId,
          rev: revision === undefined || revision === null ? null : Number(revision),
          revision: revision === undefined || revision === null ? null : Number(revision),
          status,
          action: String(body.action ?? "apply"),
          buildHash: body.buildHash ?? envObj.buildHash ?? null,
          codeHash: body.codeHash ?? envObj.codeHash ?? null,
          graphHash: body.graphHash ?? envObj.graphHash ?? null,
          // Story R55: Studio answers the address under deployment.url (executeEnvironmentDeployment); the environment
          // record carries it only in its deployed state.
          workerUrl:
            body.workerUrl ??
            (typeof body.deployment === "object" && body.deployment !== null ? (body.deployment as { url?: unknown }).url : undefined) ??
            envObj.workerUrl ??
            (typeof envObj.deployedState === "object" && envObj.deployedState !== null ? (envObj.deployedState as { workerUrl?: unknown }).workerUrl : undefined) ??
            null,
        });
      }
      if (errCode === "MISSING_REQUIRED_SECRETS") {
        // Story 1.19: name the secret and the owner's Studio step; an agent cannot bind a value.
        const errMsg = String((body.error as { message?: unknown }).message ?? "Missing required secrets");
        const actionable = buildDeployBlockerActionableIssue(errMsg, { connectionsUrl: studioConnectionsUrl(baseUrl, args.project) });
        const error = body.error as Record<string, unknown>;
        return {
          isError: true,
          text: JSON.stringify(
            scrubMcpSecrets({ ...body, error: { ...error, remediation: actionable.suggestedFix }, issues: [actionable], blockers: [actionable] }),
          ),
        };
      }
      if (errCode !== "DEPLOY_TARGET_NOT_CONNECTED") {
        return {
          isError: true,
          text: JSON.stringify(scrubMcpSecrets(body)),
        };
      }
    }

    const stored = await blueprint.getProject(args.project, args.rev);
    if (!stored || stored.state.bricks.length === 0) {
      return refuse(
        `project "${args.project}" has no enabled bricks to deploy`,
      );
    }
    if (targetEnv === "production" && stored.state.identity === "stub") {
      const actionable = buildDeployBlockerActionableIssue(
        "PRODUCTION_STUB_IDENTITY_FORBIDDEN: Production deployments cannot use stub identity; enable core-auth and set identity to core-auth.",
      );
      return {
        isError: true,
        text: JSON.stringify({
          error: {
            code: "DEPLOY_STUB_IDENTITY_REFUSED",
            message: actionable.message,
            issues: [actionable],
          },
          issues: [actionable],
          blockers: [actionable],
          summary: `${actionable.message} (fix: ${actionable.suggestedFix})`,
        }),
      };
    }
    // Story 0.9 (R-F): with no deploy target connected nothing can be
    // deployed. Never fabricate a "deployed" status or a workers.dev URL.
    return noDeployTargetResult(args.project, targetEnv);
  },
};

export const revertToRevisionTool: Tool = {
  name: "revert_to_revision",
  description:
    "Revert a project to an earlier revision by applying stored inverse operations.",
  input: z.object({
    project: projectName,
    targetRevision: z.number().int().min(0),
    baseRevision: z.number().int().min(0).optional(),
    // AD-V8: the Studio approval an editor granted for this revert (an MCP token's revert needs one).
    approvalId: z.string().min(1).max(128).optional(),
  }),
  readOnly: false,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  async run(
    { catalog, blueprint, author },
    args: {
      project: string;
      targetRevision: number;
      baseRevision?: number;
    },
  ) {
    const reverted = await blueprint.revertToRevision({
      project: args.project,
      targetRevision: args.targetRevision,
      ...(args.baseRevision !== undefined
        ? { baseRevision: args.baseRevision }
        : {}),
      author: author ?? DEFAULT_MCP_AUTHOR,
    });

    if (!reverted.ok) {
      if (reverted.status === 409) {
        return formatConflictFailure(reverted.error);
      }
      return formatValidationFailure(reverted.error.issues);
    }

    return ok({
      project: args.project,
      revision: reverted.data.revision,
      revertedToRevision: args.targetRevision,
      enabled: reverted.data.state.bricks.map((b) => b.id),
      entities: reverted.data.state.entities.map((e) => e.name),
      needs: stillNeeds(args.project, reverted.data.state, catalog),
    });
  },
};

const buildProject: Tool = {
  name: "build_project",
  description:
    "Assemble and store project files; returns count, bytes and hash.",
  input: z.object({ project: projectName }),
  readOnly: false,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  async run({ db, catalog, blueprint }, args: { project: string }) {
    const stored = await blueprint.getProject(args.project);
    if (!stored)
      return refuse(`unknown project "${args.project}": enable a brick first`);
    if (stored.state.bricks.length === 0)
      return refuse("no brick is enabled yet", "nothing was built");
    const assembled = assemble(toAssemblerBlueprint(stored.state), catalog);
    if (!assembled.ok) return refuse(...assembled.errors, "nothing was built");
    const summary = await storeBuild(db, args.project, assembled.files);
    return ok({ project: args.project, ...summary, bricks: assembled.order, entities: stored.state.entities.map((e) => (e as { name: string }).name), revision: stored.revision });
  },
};

/**
 * The evolved AD-S13 MCP tool surface (13 core tools + get_node, request_connection, list_connections).
 */
export const TOOLS: ReadonlyArray<Tool> = [
  searchBricks,
  getBrick,
  searchNodes,
  getNode,
  getBlueprintSummary,
  getBlueprintSlice,
  validateBlueprint,
  applyOpsTool,
  requestConnection,
  listConnections,
  testWorkflow,
  listRuns,
  getRunTrace,
  queryLogs,
  deployPlan,
  deployApply,
];

/**
 * Backward-compatible legacy macro tools preserved for CP0/CP1 harnesses (e.g. poc:h9).
 */
export const LEGACY_TOOLS: ReadonlyArray<Tool> = [
  listBricks,
  enableBrick,
  defineEntity,
  buildProject,
  revertToRevisionTool,
];

export const ALL_TOOLS: ReadonlyArray<Tool> = [...TOOLS, ...LEGACY_TOOLS];

/**
 * The tool list as `tools/list` returns it: name, description, trimmed JSON Schema of the input, and safety annotations.
 */
export function toolDescriptions(toolRegistry: ReadonlyArray<Tool> = TOOLS) {
  return toolRegistry.map((tool) => {
    const schema = z.toJSONSchema(tool.input, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>;
    return { name: tool.name, description: tool.description, inputSchema: trim(schema), annotations: tool.annotations };
  });
}

const ALIAS_SCHEMA_PROPS = new Set([
  "workspaceScoped",
  "expectedRev",
  "baseRevision",
  "suggestedRef",
  "target",
  "confirmedMigrationNames",
  "cursor",
  "limit",
  "maturity",
  "capability",
  "source",
  "app",
  "workspaceId",
  "q",
  "since",
  "usePinnedOutputs",
  "secretName",
  "reason",
  "scopes",
  "summary",
  "confirmDestructive",
]);

function trim(node: unknown): Record<string, unknown> {
  if (Array.isArray(node))
    return node.map(trim) as unknown as Record<string, unknown>;
  if (typeof node !== "object" || node === null)
    return node as Record<string, unknown>;
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (
      key === "$schema" ||
      key === "default" ||
      key === "additionalProperties" ||
      key === "propertyNames" ||
      key === "pattern" ||
      key === "minLength" ||
      key === "maxLength" ||
      key === "minimum" ||
      key === "maximum" ||
      key === "minItems" ||
      key === "maxItems" ||
      key === "enum"
    )
      continue;
    if (key === "type" && "const" in obj) continue;
    if (key === "properties" && typeof value === "object" && value !== null) {
      const props: Record<string, unknown> = {};
      for (const [pKey, pVal] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (ALIAS_SCHEMA_PROPS.has(pKey)) continue;
        props[pKey] = trim(pVal);
      }
      out[key] = props;
      continue;
    }
    out[key] = trim(value);
  }
  return out;
}

/** Checks the arguments against the tool's schema. A failure is a tool error the model can read and correct, not a protocol error. */
export function checkArguments(
  tool: Tool,
  args: unknown,
): { ok: true; value: never } | { ok: false; message: string } {
  const parsed = tool.input.safeParse(args ?? {});
  if (parsed.success) return { ok: true, value: parsed.data as never };
  return {
    ok: false,
    message: parsed.error.issues
      .flatMap((issue) => readableIssue(issue, []))
      .join("; "),
  };
}

interface Issue {
  code: string;
  path: PropertyKey[];
  message: string;
  errors?: Issue[][];
  keys?: readonly unknown[];
}

function readableIssue(issue: Issue, base: PropertyKey[]): string[] {
  const path = [...base, ...issue.path];
  if (issue.code === "invalid_union" && issue.errors) {
    const closest = issue.errors.find(
      (branch) =>
        branch.length > 0 &&
        !branch.every((i) => i.code === "invalid_type" && i.path.length === 0),
    );
    if (closest) return closest.flatMap((inner) => readableIssue(inner, path));
    return [
      `${path.join(".")}: is not one of the allowed forms (see the tool's schema)`,
    ];
  }
  const hint = issue.code === "unrecognized_keys" ? relationKeyHint(issue.keys) : null;
  return [`${path.length > 0 ? path.join(".") + ": " : ""}${issue.message}${hint ? ` (${hint})` : ""}`];
}

export { OP_TYPES };
