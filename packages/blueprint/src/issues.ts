import { checkBrickConfig } from "@poc/assembler";
import type { Catalog } from "@poc/assembler";
import { checkGraphBudget, checkWire, parseEntities, toyRegistry, validateGraph } from "@poc/sdk";
import type { Registry } from "@poc/sdk";
import { z } from "zod";
import { buildCatalogNodeRegistry, relationSuggestedFix } from "./apply.ts";
import type { BlueprintValidationError } from "./apply.ts";
import { computeReadiness } from "./readiness.ts";
import type { ReadinessNeed } from "./readiness.ts";
import { toSdkEntity } from "./schema.ts";
import type { BlueprintState, Workflow, WorkflowEdge, WorkflowNode } from "./schema.ts";

export const RemediationOpSchema = z.object({
  kind: z.string().min(1),
  payloadExample: z.record(z.string(), z.unknown()),
});

export type RemediationOp = z.infer<typeof RemediationOpSchema>;

export const ActionableIssueSchema = z.object({
  code: z.string().min(1),
  path: z
    .string()
    .regex(/^(\/[^/]+)+$/, "path must be a non-empty RFC 6901 JSON pointer (e.g. /bricks/credit-wallet)"),
  message: z.string().min(1),
  suggestedFix: z.string().min(1),
  remediationOp: RemediationOpSchema.optional(),
});

export type ActionableIssue = z.infer<typeof ActionableIssueSchema>;

/**
 * Canonical documented error codes across graph validator, blueprint readiness/conflict/entity rules,
 * optimistic concurrency conflicts, runtime step failures, and deploy blockers.
 */
export const DOCUMENTED_ERROR_CODES = [
  "MISSING_CAPABILITY_PROVIDER",
  "BRICK_CONFLICT",
  "PORT_TYPE_MISMATCH",
  "GRAPH_CYCLE",
  "UNREACHABLE_NODE",
  "UNBOUND_CONNECTION",
  "INVALID_SETTING_VALUE",
  "STALE_BASE_REV",
  "RUN_STEP_MISSING_INPUT",
  "RUN_STEP_CONNECTION_EXPIRED",
  "RUN_STEP_RATE_LIMITED",
  "RUN_STEP_EXECUTION_FAILED",
  "DEPLOY_STUB_IDENTITY_REFUSED",
  "DEPLOY_VALIDATION_BLOCKED",
  "NO_TRIGGER_NODE",
  "MULTIPLE_TRIGGER_NODES",
  "DUPLICATE_NODE_ID",
  "UNKNOWN_NODE_TYPE",
  "BAD_EDGE_REFERENCE",
  "MISSING_SECRET",
  "UNKNOWN_BRICK",
  "UNKNOWN_WORKFLOW",
  "ENTITY_VALIDATION_ERROR",
  "MISSING_TRIGGER_CONFIG",
  "UPSTREAM_DEPENDENTS",
  "INVALID_OPERATION",
  "INTEGRATION_OPERATION_UNSUPPORTED",
  "BUDGET_STEPS_EXCEEDED",
  "BUDGET_SUBREQUESTS_EXCEEDED",
  "D1_BIND_PARAMS_EXCEEDED",
  "BUDGET_FANOUT_EXCEEDED",
  "BUDGET_PAYLOAD_UNBOUNDED_WARNING",
] as const;

export type DocumentedErrorCode = (typeof DOCUMENTED_ERROR_CODES)[number];

/**
 * Convert a dot-delimited path (e.g. "bricks.credit-wallet" or "workflows.wf_1.nodes.n_2.data.amount")
 * or existing slash path into a valid RFC 6901 JSON Pointer ("/bricks/credit-wallet").
 */
export function toJsonPointerPath(rawPath: string | undefined, fallback = "/blueprint"): string {
  if (!rawPath || rawPath.trim().length === 0) {
    return fallback;
  }
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("/")) {
    const segments = trimmed
      .split("/")
      .slice(1)
      .filter((s) => s.length > 0);
    return segments.length > 0 ? "/" + segments.join("/") : fallback;
  }
  const normalized = trimmed.replace(/\[(\d+)\]/g, ".$1");
  const segments = normalized
    .split(".")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1"));
  return segments.length > 0 ? "/" + segments.join("/") : fallback;
}

export interface IssueEnrichmentContext {
  state?: BlueprintState;
  catalog?: Catalog;
  nodeRegistry?: Registry;
  boundConnectionIds?: string[];
  availableConnectionIds?: string[];
}

function findCapabilityProviderBrick(capability: string, catalog?: Catalog, state?: BlueprintState): string {
  if (!catalog) {
    if (capability === "workspace" || capability === "workspace-context") return "multi-workspace";
    if (capability === "user-identity" || capability === "auth") return "core-auth";
    return capability;
  }
  const enabledIds = new Set((state?.bricks ?? []).map((b) => b.id));
  for (const [brickId, entry] of Object.entries(catalog.bricks).sort(([a], [b]) => a.localeCompare(b))) {
    if (!entry.manifest.provides.includes(capability)) continue;
    const conflictsWithEnabled = (entry.manifest.conflicts ?? []).some((c) => enabledIds.has(c.brick));
    if (!conflictsWithEnabled) return brickId;
  }
  for (const [brickId, entry] of Object.entries(catalog.bricks).sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.manifest.provides.includes(capability)) return brickId;
  }
  return capability;
}

function findCycleBackEdge(workflow: Workflow): WorkflowEdge | undefined {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const adj = new Map<string, WorkflowEdge[]>();
  for (const edge of workflow.edges) {
    const list = adj.get(edge.source) ?? [];
    list.push(edge);
    adj.set(edge.source, list);
  }
  let cycleEdge: WorkflowEdge | undefined;
  const dfs = (u: string): boolean => {
    visited.add(u);
    inStack.add(u);
    for (const edge of adj.get(u) ?? []) {
      if (inStack.has(edge.target)) {
        cycleEdge = edge;
        return true;
      }
      if (!visited.has(edge.target) && dfs(edge.target)) {
        return true;
      }
    }
    inStack.delete(u);
    return false;
  };
  for (const node of workflow.nodes) {
    if (!visited.has(node.id) && dfs(node.id)) break;
  }
  return cycleEdge ?? workflow.edges[workflow.edges.length - 1];
}

function inferValidSettingReplacement(
  brickId: string | undefined,
  nodeType: string | undefined,
  fieldKey: string,
  catalog?: Catalog,
): unknown {
  if (brickId && catalog?.bricks[brickId]) {
    const def = catalog.bricks[brickId].manifest.settings[fieldKey] as
      | { default?: unknown; type?: string; values?: unknown[]; min?: number }
      | undefined;
    if (def) {
      if (def.default !== undefined) return def.default;
      if (def.type === "enum") return def.values?.[0] ?? "default";
      if (def.type === "boolean") return true;
      if (def.type === "integer" || def.type === "number") {
        if (def.min !== undefined) return Math.max(1, def.min);
        return 10;
      }
      return "default";
    }
  }
  if (nodeType && catalog) {
    for (const pack of Object.values(catalog.nodePacks ?? {})) {
      const nodeDesc = pack.manifest.nodes.find((n) => n.type === nodeType);
      const def = nodeDesc?.config?.[fieldKey] as
        | { default?: unknown; type?: string; values?: unknown[]; min?: number }
        | undefined;
      if (def) {
        if (def.default !== undefined) return def.default;
        if (def.type === "enum") return def.values?.[0] ?? "default";
        if (def.type === "boolean") return true;
        if (def.type === "integer" || def.type === "number") {
          if (def.min !== undefined) return Math.max(1, def.min);
          return 1;
        }
        return "value";
      }
    }
    for (const brick of Object.values(catalog.bricks ?? {})) {
      const nodeDesc = (brick.manifest.nodes ?? []).find((n) => n.type === nodeType);
      const def = nodeDesc?.config?.[fieldKey] as
        | { default?: unknown; type?: string; values?: unknown[]; min?: number }
        | undefined;
      if (def) {
        if (def.default !== undefined) return def.default;
        if (def.type === "enum") return def.values?.[0] ?? "default";
        if (def.type === "boolean") return true;
        if (def.type === "integer" || def.type === "number") {
          if (def.min !== undefined) return Math.max(1, def.min);
          return 1;
        }
        return "value";
      }
    }
  }
  if (fieldKey === "creditsPerUnit" || fieldKey === "limit" || fieldKey === "maxRetries" || fieldKey === "timeoutMs") {
    return 10;
  }
  if (fieldKey === "method") return "GET";
  if (fieldKey === "operation") return "add";
  return 1;
}

/**
 * Convert a BlueprintValidationError or ReadinessNeed into a canonical ActionableIssue.
 */
export function toActionableIssue(
  raw: BlueprintValidationError | ReadinessNeed,
  ctx: IssueEnrichmentContext = {},
): ActionableIssue {
  const rawPath = "path" in raw && typeof raw.path === "string" ? raw.path : "/blueprint";
  const pointer = toJsonPointerPath(rawPath);
  const segments = pointer.split("/").slice(1);
  const rawCode = raw.code;

  // 1. Missing capability provider
  if (rawCode === "MISSING_CAPABILITY" || rawCode === "MISSING_CAPABILITY_PROVIDER") {
    const capMatch = /capability\s+"([^"]+)"/i.exec(raw.message);
    const capability = capMatch?.[1] ?? "workspace-context";
    const providerBrickId = findCapabilityProviderBrick(capability, ctx.catalog, ctx.state);
    return {
      code: "MISSING_CAPABILITY_PROVIDER",
      path: `/bricks/${segments[1] ?? "unknown"}`,
      message: raw.message,
      suggestedFix: `Call apply_ops with enable_brick to enable "${providerBrickId}" (which provides capability "${capability}").`,
      remediationOp: {
        kind: "enable_brick",
        payloadExample: {
          brickId: providerBrickId,
        },
      },
    };
  }

  // 2. Brick conflict
  if (rawCode === "BRICK_CONFLICT") {
    const conflictMatch = /conflict:\s*([a-z0-9-]+)\s*×\s*([a-z0-9-]+)/i.exec(raw.message);
    const brickIdFromPath = segments[0] === "bricks" ? segments[1] : undefined;
    const conflictingBrick =
      conflictMatch
        ? conflictMatch[1] === brickIdFromPath
          ? conflictMatch[2]!
          : conflictMatch[1]!
        : brickIdFromPath ?? "conflicting-brick";
    return {
      code: "BRICK_CONFLICT",
      path: pointer.startsWith("/bricks/") ? pointer : `/bricks/${conflictingBrick}`,
      message: raw.message,
      suggestedFix: `Call apply_ops with remove_brick to disable conflicting brick "${conflictingBrick}".`,
      remediationOp: {
        kind: "remove_brick",
        payloadExample: {
          brickId: conflictingBrick,
        },
      },
    };
  }

  // 3. Port type mismatch (incompatible_wire)
  if (rawCode === "incompatible_wire" || rawCode === "PORT_TYPE_MISMATCH") {
    const wfId = segments[0] === "workflows" ? (segments[1] ?? "wf_1") : "wf_1";
    const workflow = ctx.state?.workflows.find((w) => w.id === wfId);
    const edgeIdFromPath = segments[2] === "edges" ? segments[3] : undefined;
    const nodeIdFromPath = segments[2] === "nodes" ? segments[3] : undefined;
    const badEdge =
      workflow?.edges.find((e) => e.id === edgeIdFromPath) ??
      workflow?.edges.find((e) => e.target === nodeIdFromPath || e.source === nodeIdFromPath) ??
      workflow?.edges[workflow.edges.length - 1];
    const targetEdgeId = badEdge?.id ?? edgeIdFromPath ?? "e_bad";
    return {
      code: "PORT_TYPE_MISMATCH",
      path: `/workflows/${wfId}/edges/${targetEdgeId}`,
      message: raw.message,
      suggestedFix: `Call apply_ops with disconnect_edge on workflow "${wfId}" to remove incompatible edge "${targetEdgeId}" (${raw.message}).`,
      remediationOp: {
        kind: "disconnect_edge",
        payloadExample: {
          workflowId: wfId,
          edgeId: targetEdgeId,
        },
      },
    };
  }

  // 4. Graph cycle
  if (rawCode === "cycle" || rawCode === "GRAPH_CYCLE") {
    const wfId = segments[0] === "workflows" ? (segments[1] ?? "wf_1") : "wf_1";
    const workflow = ctx.state?.workflows.find((w) => w.id === wfId);
    const backEdge = workflow ? findCycleBackEdge(workflow) : undefined;
    const edgeId = backEdge?.id ?? (segments[2] === "edges" ? segments[3] : undefined) ?? "e_cycle";
    return {
      code: "GRAPH_CYCLE",
      path: `/workflows/${wfId}/edges/${edgeId}`,
      message: raw.message,
      suggestedFix: `Call apply_ops with disconnect_edge on workflow "${wfId}" to remove cycle-forming edge "${edgeId}".`,
      remediationOp: {
        kind: "disconnect_edge",
        payloadExample: {
          workflowId: wfId,
          edgeId,
        },
      },
    };
  }

  // 5. Unreachable / orphan node
  if (rawCode === "orphan_node" || rawCode === "UNREACHABLE_NODE") {
    const wfId = segments[0] === "workflows" ? (segments[1] ?? "wf_1") : "wf_1";
    const nodeMatch = /node\s+"([^"]+)"/i.exec(raw.message);
    const nodeId = (segments[2] === "nodes" ? segments[3] : undefined) ?? nodeMatch?.[1] ?? "n_orphan";
    const workflow = ctx.state?.workflows.find((w) => w.id === wfId);
    const triggerNode =
      workflow?.nodes.find(
        (n) =>
          ctx.nodeRegistry?.get(n.type)?.category === "trigger" ||
          n.type.startsWith("trigger.") ||
          n.type.startsWith("core.trigger_") ||
          n.type === "core.webhook" ||
          n.type === "core.schedule" ||
          n.type === "core.brick_event",
      ) ?? workflow?.nodes[0];
    if (triggerNode && triggerNode.id !== nodeId) {
      const edgeId = `e-${triggerNode.id}-${nodeId}`;
      return {
        code: "UNREACHABLE_NODE",
        path: `/workflows/${wfId}/nodes/${nodeId}`,
        message: raw.message,
        suggestedFix: `Call apply_ops with connect_edges on workflow "${wfId}" to wire upstream node "${triggerNode.id}" to unreachable node "${nodeId}", or remove_node "${nodeId}".`,
        remediationOp: {
          kind: "connect_edges",
          payloadExample: {
            workflowId: wfId,
            edges: [
              {
                id: edgeId,
                source: triggerNode.id,
                target: nodeId,
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        },
      };
    }
    return {
      code: "UNREACHABLE_NODE",
      path: `/workflows/${wfId}/nodes/${nodeId}`,
      message: raw.message,
      suggestedFix: `Call apply_ops with remove_node on workflow "${wfId}" to remove unreachable node "${nodeId}" or connect it from the trigger node.`,
      remediationOp: {
        kind: "remove_node",
        payloadExample: {
          workflowId: wfId,
          nodeId,
        },
      },
    };
  }

  // 6. Unbound connection
  if (rawCode === "UNBOUND_CONNECTION") {
    const wfId = segments[0] === "workflows" ? (segments[1] ?? "wf_1") : "wf_1";
    const nodeId = segments[2] === "nodes" ? (segments[3] ?? "n_1") : "n_1";
    const workflow = ctx.state?.workflows.find((w) => w.id === wfId);
    const node = workflow?.nodes.find((n) => n.id === nodeId);
    const validConn = ctx.availableConnectionIds?.[0] ?? ctx.boundConnectionIds?.[0] ?? "conn_default";
    return {
      code: "UNBOUND_CONNECTION",
      path: `/workflows/${wfId}/nodes/${nodeId}/data/connectionRef`,
      message: raw.message,
      suggestedFix: `Inspect bound connections via list_connections and call apply_ops with update_node on workflow "${wfId}" node "${nodeId}" to set data.connectionRef to a valid connection (e.g. "${validConn}").`,
      remediationOp: {
        kind: "update_node",
        payloadExample: {
          workflowId: wfId,
          nodeId,
          patch: {
            data: {
              ...(node?.data ?? {}),
              connectionRef: validConn,
            },
          },
        },
      },
    };
  }

  // 7. Invalid setting value (brick config or node config)
  if (
    rawCode === "INVALID_BRICK_CONFIG" ||
    rawCode === "invalid_config" ||
    rawCode === "INVALID_SETTING_VALUE"
  ) {
    if (segments[0] === "bricks") {
      const brickId = segments[1] ?? "credit-wallet";
      const settingMatch = /setting\s+"([^"]+)"/i.exec(raw.message);
      const fieldKey = settingMatch?.[1] ?? segments[3] ?? "creditsPerUnit";
      const validVal = inferValidSettingReplacement(brickId, undefined, fieldKey, ctx.catalog);
      const isUnknownKey = /unknown setting/i.test(raw.message);
      const existingBrick = ctx.state?.bricks.find((b) => b.id === brickId);
      const nextConfig: Record<string, unknown> = { ...(existingBrick?.config ?? {}) };
      if (isUnknownKey) {
        delete nextConfig[fieldKey];
      } else {
        nextConfig[fieldKey] = validVal;
      }
      return {
        code: "INVALID_SETTING_VALUE",
        path: `/bricks/${brickId}/config/${fieldKey}`,
        message: raw.message,
        suggestedFix: isUnknownKey
          ? `Remove unknown setting "${fieldKey}" on brick "${brickId}" via apply_ops with configure_brick.`
          : `Call apply_ops with configure_brick on brick "${brickId}" to set "${fieldKey}" to a valid value (e.g. ${JSON.stringify(validVal)}).`,
        remediationOp: {
          kind: "configure_brick",
          payloadExample: {
            brickId,
            config: nextConfig,
          },
        },
      };
    }

    const wfId = segments[0] === "workflows" ? (segments[1] ?? "wf_1") : "wf_1";
    const nodeId = segments[2] === "nodes" ? (segments[3] ?? "n_1") : "n_1";
    const workflow = ctx.state?.workflows.find((w) => w.id === wfId);
    const node = workflow?.nodes.find((n) => n.id === nodeId);
    const fieldKey = segments[5] ?? "value";
    const validVal = inferValidSettingReplacement(undefined, node?.type, fieldKey, ctx.catalog);
    return {
      code: "INVALID_SETTING_VALUE",
      path: `/workflows/${wfId}/nodes/${nodeId}/data/${fieldKey}`,
      message: raw.message,
      suggestedFix: `Call apply_ops with update_node on workflow "${wfId}" node "${nodeId}" to set "data.${fieldKey}" to a valid value (e.g. ${JSON.stringify(validVal)}).`,
      remediationOp: {
        kind: "update_node",
        payloadExample: {
          workflowId: wfId,
          nodeId,
          patch: {
            data: {
              ...(node?.data ?? {}),
              [fieldKey]: validVal,
            },
          },
        },
      },
    };
  }

  // 8. Other graph validator codes
  if (rawCode === "no_trigger" || rawCode === "NO_TRIGGER_NODE") {
    const wfId = segments[0] === "workflows" ? (segments[1] ?? "wf_1") : "wf_1";
    return {
      code: "NO_TRIGGER_NODE",
      path: `/workflows/${wfId}/nodes`,
      message: raw.message,
      suggestedFix: `Call apply_ops with add_node on workflow "${wfId}" to add a trigger node (e.g. type "trigger.manual").`,
      remediationOp: {
        kind: "add_node",
        payloadExample: {
          workflowId: wfId,
          node: { id: "t_start", type: "trigger.manual", label: "Start", data: {} },
        },
      },
    };
  }

  if (rawCode === "multi_trigger" || rawCode === "MULTIPLE_TRIGGER_NODES") {
    const wfId = segments[0] === "workflows" ? (segments[1] ?? "wf_1") : "wf_1";
    const nodeId = segments[2] === "nodes" ? (segments[3] ?? "t_extra") : "t_extra";
    return {
      code: "MULTIPLE_TRIGGER_NODES",
      path: `/workflows/${wfId}/nodes/${nodeId}`,
      message: raw.message,
      suggestedFix: `Call apply_ops with remove_node on workflow "${wfId}" to remove extra trigger node "${nodeId}".`,
      remediationOp: {
        kind: "remove_node",
        payloadExample: {
          workflowId: wfId,
          nodeId,
        },
      },
    };
  }

  if (rawCode === "duplicate_node" || rawCode === "DUPLICATE_NODE_ID") {
    const wfId = segments[0] === "workflows" ? (segments[1] ?? "wf_1") : "wf_1";
    const nodeId = segments[2] === "nodes" ? (segments[3] ?? "n_dup") : "n_dup";
    return {
      code: "DUPLICATE_NODE_ID",
      path: `/workflows/${wfId}/nodes/${nodeId}`,
      message: raw.message,
      suggestedFix: `Give each node in workflow "${wfId}" a unique id when calling apply_ops with add_node.`,
      remediationOp: {
        kind: "add_node",
        payloadExample: {
          workflowId: wfId,
          node: { id: `${nodeId}_2`, type: "core.noop", data: {} },
        },
      },
    };
  }

  if (rawCode === "unknown_brick" || rawCode === "UNKNOWN_NODE_TYPE") {
    const wfId = segments[0] === "workflows" ? (segments[1] ?? "wf_1") : "wf_1";
    const nodeId = segments[2] === "nodes" ? (segments[3] ?? "n_1") : "n_1";
    return {
      code: "UNKNOWN_NODE_TYPE",
      path: `/workflows/${wfId}/nodes/${nodeId}`,
      message: raw.message,
      suggestedFix: `Use search_nodes to find a valid node type and call apply_ops with remove_node or add_node on workflow "${wfId}".`,
      remediationOp: {
        kind: "remove_node",
        payloadExample: {
          workflowId: wfId,
          nodeId,
        },
      },
    };
  }

  if (
    rawCode === "bad_ref" ||
    rawCode === "DANGLING_EDGE_SOURCE" ||
    rawCode === "DANGLING_EDGE_TARGET" ||
    rawCode === "SELF_LOOP_EDGE" ||
    rawCode === "BAD_EDGE_REFERENCE"
  ) {
    const wfId = segments[0] === "workflows" ? (segments[1] ?? "wf_1") : "wf_1";
    const itemId = segments[3] ?? "e_1";
    return {
      code: "BAD_EDGE_REFERENCE",
      path: pointer.startsWith("/workflows/") ? pointer : `/workflows/${wfId}/edges/${itemId}`,
      message: raw.message,
      suggestedFix: `Ensure edges and expressions in workflow "${wfId}" only reference existing upstream nodes.`,
      remediationOp: {
        kind: "disconnect_edge",
        payloadExample: {
          workflowId: wfId,
          edgeId: itemId,
        },
      },
    };
  }

  if (rawCode === "MISSING_SECRET") {
    const targetKind = segments[0] === "workflows" ? "workflow" : "brick";
    const targetId = segments[1] ?? "core-auth";
    const secretMatch = /secret\s+"([^"]+)"/i.exec(raw.message);
    const secretName = secretMatch?.[1] ?? "API_SECRET";
    return {
      code: "MISSING_SECRET",
      path: pointer,
      message: raw.message,
      suggestedFix: `Call apply_ops with bind_secret_ref to bind secret "${secretName}" for ${targetKind} "${targetId}".`,
      remediationOp: {
        kind: "bind_secret_ref",
        payloadExample: {
          ref: {
            targetKind,
            targetId,
            secretName,
            handle: `secret://${secretName.toLowerCase()}`,
          },
        },
      },
    };
  }

  if (rawCode === "UNKNOWN_BRICK") {
    const firstBrick = Object.keys(ctx.catalog?.bricks ?? {}).sort()[0] ?? "core-auth";
    return {
      code: "UNKNOWN_BRICK",
      path: pointer,
      message: raw.message,
      suggestedFix: `Use search_bricks to discover valid brick IDs and call apply_ops with enable_brick (e.g. "${firstBrick}").`,
      remediationOp: {
        kind: "enable_brick",
        payloadExample: {
          brickId: firstBrick,
        },
      },
    };
  }

  if (rawCode === "INVALID_IDENTITY_BRICK") {
    return {
      code: "INVALID_SETTING_VALUE",
      path: "/identity",
      message: raw.message,
      suggestedFix: `Call apply_ops with set_identity using "core-auth" or "stub".`,
      remediationOp: {
        kind: "set_identity",
        payloadExample: {
          identity: "core-auth",
        },
      },
    };
  }

  if (
    rawCode === "DUPLICATE_ENTITY" ||
    rawCode === "INVALID_ENTITY" ||
    rawCode === "ENTITY_VALIDATION_FAILED" ||
    rawCode === "UNKNOWN_ENTITY" ||
    rawCode === "ENTITY_VALIDATION_ERROR"
  ) {
    const entityName = segments[1] ?? "items";
    return {
      code: "ENTITY_VALIDATION_ERROR",
      path: pointer.startsWith("/entities") ? pointer : `/entities/${entityName}`,
      message: raw.message,
      suggestedFix:
        "suggestedFix" in raw && raw.suggestedFix
          ? raw.suggestedFix
          : `Call apply_ops with update_entity or add_entity for "${entityName}" using valid field names and constraints.`,
      remediationOp: {
        kind: "update_entity",
        payloadExample: {
          name: entityName,
          entity: {
            name: entityName,
            workspaceScoped: true,
            fields: [{ name: "title", type: "text", required: true, maxLength: 120 }],
          },
        },
      },
    };
  }

  return {
    code: rawCode,
    path: pointer,
    message: raw.message,
    suggestedFix:
      ("suggestedFix" in raw && raw.suggestedFix) ||
      `Resolve issue "${rawCode}" at ${pointer} and retry apply_ops.`,
  };
}

/**
 * Inspect an entire BlueprintState and return all ActionableIssues across readiness,
 * brick conflicts, brick configs, entity definitions, workflow graphs, and connection bindings.
 */
export function collectBlueprintActionableIssues(
  state: BlueprintState,
  ctx: IssueEnrichmentContext = {},
): ActionableIssue[] {
  const issues: ActionableIssue[] = [];
  const seenKeys = new Set<string>();
  const pushUnique = (issue: ActionableIssue) => {
    const key = `${issue.code}|${issue.path}|${issue.message}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      issues.push(issue);
    }
  };

  const catalog = ctx.catalog;
  const nodeRegistry =
    ctx.nodeRegistry ?? (catalog ? buildCatalogNodeRegistry(catalog, toyRegistry) : toyRegistry);
  const fullCtx: IssueEnrichmentContext = {
    ...ctx,
    state,
    catalog,
    nodeRegistry,
  };

  // 1. Readiness needs (missing capabilities, missing secrets, missing trigger config)
  if (catalog) {
    const readiness = computeReadiness(state, catalog, nodeRegistry);
    for (const need of readiness.needs) {
      if (need.code === "UNBOUND_CONNECTION" && ctx.boundConnectionIds) {
        continue;
      }
      pushUnique(toActionableIssue(need, fullCtx));
    }

    // 2. Brick conflicts across enabled bricks
    const enabledIds = new Set(state.bricks.map((b) => b.id));
    const reportedConflictPairs = new Set<string>();
    for (const brick of state.bricks) {
      const manifest = catalog.bricks[brick.id]?.manifest;
      if (!manifest) {
        pushUnique(
          toActionableIssue(
            {
              code: "UNKNOWN_BRICK",
              path: `bricks.${brick.id}`,
              message: `unknown brick "${brick.id}"`,
            },
            fullCtx,
          ),
        );
        continue;
      }

      for (const conflict of manifest.conflicts ?? []) {
        if (conflict.brick !== brick.id && enabledIds.has(conflict.brick)) {
          const pair = [brick.id, conflict.brick].sort();
          const pairKey = pair.join("\0");
          if (!reportedConflictPairs.has(pairKey)) {
            reportedConflictPairs.add(pairKey);
            const brickToRemove = pair[1]!;
            pushUnique({
              code: "BRICK_CONFLICT",
              path: `/bricks/${brickToRemove}`,
              message: `conflict: ${pair[0]} × ${pair[1]}: ${conflict.reason}`,
              suggestedFix: `Call apply_ops with remove_brick to disable conflicting brick "${brickToRemove}" (conflicts with "${pair[0]}").`,
              remediationOp: {
                kind: "remove_brick",
                payloadExample: {
                  brickId: brickToRemove,
                },
              },
            });
          }
        }
      }

      // 3. Brick settings validation
      const cfgErrors = checkBrickConfig(brick.id, brick.config, catalog);
      for (const message of cfgErrors) {
        pushUnique(
          toActionableIssue(
            {
              code: "INVALID_BRICK_CONFIG",
              path: `bricks.${brick.id}.config`,
              message,
            },
            fullCtx,
          ),
        );
      }
    }

    // 4. Entity definitions validation
    if (state.entities.length > 0) {
      const reserved = new Set<string>();
      for (const entry of Object.values(catalog.bricks)) {
        for (const prefix of entry.manifest.routePrefixes) reserved.add(prefix);
      }
      const parsedEnt = parseEntities(state.entities.map(toSdkEntity), reserved);
      if (!parsedEnt.ok) {
        for (const message of parsedEnt.errors) {
          pushUnique(
            toActionableIssue(
              {
                code: "ENTITY_VALIDATION_FAILED",
                path: "entities",
                message,
                ...(relationSuggestedFix(message) ? { suggestedFix: relationSuggestedFix(message)! } : {}),
              },
              fullCtx,
            ),
          );
        }
      }
    }
  }

  // 5. Workflow graph validation (ports, cycles, orphans, node config schemas, unbound connections)
  for (const wf of state.workflows) {
    const byId = new Map<string, WorkflowNode>();
    for (const node of wf.nodes) {
      byId.set(node.id, node);
    }

    // Check edges for port compatibility explicitly so we know the exact edge ID
    for (const edge of wf.edges) {
      const srcNode = byId.get(edge.source);
      const dstNode = byId.get(edge.target);
      if (!srcNode || !dstNode) {
        pushUnique({
          code: "BAD_EDGE_REFERENCE",
          path: `/workflows/${wf.id}/edges/${edge.id}`,
          message: `Edge "${edge.id}" in workflow "${wf.id}" references missing node "${!srcNode ? edge.source : edge.target}".`,
          suggestedFix: `Call apply_ops with disconnect_edge on workflow "${wf.id}" to remove dangling edge "${edge.id}".`,
          remediationOp: {
            kind: "disconnect_edge",
            payloadExample: {
              workflowId: wf.id,
              edgeId: edge.id,
            },
          },
        });
        continue;
      }
      const wireErr = checkWire(edge, wf.nodes, nodeRegistry);
      if (wireErr) {
        pushUnique({
          code: "PORT_TYPE_MISMATCH",
          path: `/workflows/${wf.id}/edges/${edge.id}`,
          message: `Incompatible wire on edge "${edge.id}" (${edge.source}.${edge.sourceHandle ?? "out"} -> ${edge.target}.${edge.targetHandle ?? "in"}): ${wireErr}`,
          suggestedFix: `Call apply_ops with disconnect_edge on workflow "${wf.id}" to remove incompatible edge "${edge.id}" (${wireErr}).`,
          remediationOp: {
            kind: "disconnect_edge",
            payloadExample: {
              workflowId: wf.id,
              edgeId: edge.id,
            },
          },
        });
      }
    }

    // Check node configSchema with detailed field path
    for (const node of wf.nodes) {
      const manifest = nodeRegistry.get(node.type);
      if (manifest) {
        const parsed = manifest.configSchema.safeParse(node.data);
        if (!parsed.success) {
          const firstIssue = parsed.error.issues[0];
          const fieldKey = String(firstIssue?.path?.[0] ?? "value");
          const validVal = inferValidSettingReplacement(undefined, node.type, fieldKey, catalog);
          pushUnique({
            code: "INVALID_SETTING_VALUE",
            path: `/workflows/${wf.id}/nodes/${node.id}/data/${fieldKey}`,
            message: `Node "${node.id}" (${node.type}) has invalid setting "${fieldKey}": ${firstIssue?.message ?? "validation failed"}`,
            suggestedFix: `Call apply_ops with update_node on workflow "${wf.id}" node "${node.id}" to set "data.${fieldKey}" to a valid value (e.g. ${JSON.stringify(validVal)}).`,
            remediationOp: {
              kind: "update_node",
              payloadExample: {
                workflowId: wf.id,
                nodeId: node.id,
                patch: {
                  data: {
                    ...node.data,
                    [fieldKey]: validVal,
                  },
                },
              },
            },
          });
        }
      }

      // Check connectionRef on node data if boundConnectionIds is provided
      const connRef = node.data?.connectionRef;
      if (typeof connRef === "string" && connRef.trim().length > 0 && ctx.boundConnectionIds) {
        if (!ctx.boundConnectionIds.includes(connRef)) {
          const validConn =
            ctx.availableConnectionIds?.[0] ?? ctx.boundConnectionIds[0] ?? "conn_default";
          pushUnique({
            code: "UNBOUND_CONNECTION",
            path: `/workflows/${wf.id}/nodes/${node.id}/data/connectionRef`,
            message: `Node "${node.id}" in workflow "${wf.id}" references connectionRef "${connRef}" which is not bound in this project.`,
            suggestedFix: `Inspect bound connections via list_connections and call apply_ops with update_node on workflow "${wf.id}" node "${node.id}" to set data.connectionRef to "${validConn}".`,
            remediationOp: {
              kind: "update_node",
              payloadExample: {
                workflowId: wf.id,
                nodeId: node.id,
                patch: {
                  data: {
                    ...node.data,
                    connectionRef: validConn,
                  },
                },
              },
            },
          });
        }
      }
    }

    // Run full SDK validateGraph for cycle, orphan_node, no_trigger, multi_trigger, unknown_brick, bad_ref
    const { issues: graphIssues } = validateGraph(wf.nodes, wf.edges, nodeRegistry);

    for (const gIssue of graphIssues) {
      // Skip incompatible_wire and invalid_config if already emitted above with exact edge/field paths
      if (gIssue.code === "incompatible_wire" || gIssue.code === "invalid_config") {
        continue;
      }
      pushUnique(
        toActionableIssue(
          {
            code: gIssue.code,
            path: gIssue.nodeId
              ? `workflows.${wf.id}.nodes.${gIssue.nodeId}`
              : `workflows.${wf.id}`,
            message: gIssue.message,
          },
          fullCtx,
        ),
      );
    }

    // Static budget check for workflows (UC7.4)
    const budgetIssues = checkGraphBudget(
      { nodes: wf.nodes, edges: wf.edges },
      nodeRegistry,
      "free",
    );
    for (const bIssue of budgetIssues) {
      pushUnique(
        toActionableIssue(
          {
            code: bIssue.code,
            path: bIssue.nodeId
              ? `workflows.${wf.id}.nodes.${bIssue.nodeId}`
              : `workflows.${wf.id}`,
            message: bIssue.message,
            suggestedFix: bIssue.fix,
          },
          fullCtx,
        ),
      );
    }
  }

  return issues;
}

/**
 * Build ActionableIssue entries for a 409 optimistic-concurrency (STALE_BASE_REV) conflict.
 */
export function buildConflictActionableIssues(params: {
  baseRev: number;
  currentRev: number;
  conflictingOps: Array<{ opId: string; type: string; targetKey: string }>;
  failedOp?: Record<string, unknown>;
}): ActionableIssue[] {
  const firstConflict = params.conflictingOps[0];
  const rawTarget = firstConflict?.targetKey ?? "blueprint";
  const path = toJsonPointerPath(rawTarget.replace(/:/g, "."), "/blueprint");
  const payloadExample: Record<string, unknown> = params.failedOp
    ? { ...params.failedOp, baseRev: params.currentRev }
    : { baseRev: params.currentRev };

  return [
    {
      code: "STALE_BASE_REV",
      path,
      message: `Stale baseRev ${params.baseRev} conflicts with concurrent modification on "${rawTarget}" at current rev ${params.currentRev}.`,
      suggestedFix: `Call get_blueprint_slice (or get_blueprint_summary) to read the latest state at rev ${params.currentRev}, then retry apply_ops with baseRev: ${params.currentRev}.`,
      remediationOp: {
        kind: typeof params.failedOp?.type === "string" ? params.failedOp.type : "apply_ops",
        payloadExample,
      },
    },
  ];
}

/**
 * Build an ActionableIssue for a failed workflow runtime step (e.g. RUN_STEP_MISSING_INPUT,
 * RUN_STEP_CONNECTION_EXPIRED, RUN_STEP_RATE_LIMITED).
 */
export function buildRuntimeStepActionableIssue(params: {
  workflowId: string;
  nodeId: string;
  errorMessage: string;
  nodeData?: Record<string, unknown>;
  upstreamOutputs?: Record<string, unknown>;
}): ActionableIssue {
  const { workflowId, nodeId, errorMessage, nodeData } = params;
  const missingInputMatch =
    /RUN_STEP_MISSING_INPUT:\s*Step\s+"([^"]+)"\s+field\s+"([^"]+)"\s+mapped\s+to\s+"\{\{steps\.([^.]+)\.output\.([^}]+)\}\}".*?\(available fields:\s*([^)]+)\)/i.exec(
      errorMessage,
    );

  if (missingInputMatch) {
    const failingField = missingInputMatch[2]!;
    const upstreamNodeId = missingInputMatch[3]!;
    const missingField = missingInputMatch[4]!;
    const availableFields = missingInputMatch[5]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const bestReplacementField = availableFields[0] ?? "id";
    const replacementExpr = `{{steps.${upstreamNodeId}.output.${bestReplacementField}}}`;

    return {
      code: "RUN_STEP_MISSING_INPUT",
      path: `/workflows/${workflowId}/nodes/${nodeId}/data/${failingField}`,
      message: errorMessage,
      suggestedFix: `Inspect get_run_trace and query_logs for step "${nodeId}": upstream node "${upstreamNodeId}" does not output "${missingField}" (available fields: ${availableFields.join(", ")}). Call apply_ops with update_node on workflow "${workflowId}" node "${nodeId}" to set "data.${failingField}" to "${replacementExpr}".`,
      remediationOp: {
        kind: "update_node",
        payloadExample: {
          workflowId,
          nodeId,
          patch: {
            data: {
              ...(nodeData ?? {}),
              [failingField]: replacementExpr,
            },
          },
        },
      },
    };
  }

  if (/CONNECTION_EXPIRED|401|expired token/i.test(errorMessage)) {
    return {
      code: "RUN_STEP_CONNECTION_EXPIRED",
      path: `/workflows/${workflowId}/nodes/${nodeId}/data/connectionRef`,
      message: errorMessage,
      suggestedFix: `Inspect active connections with list_connections and update node "${nodeId}" in workflow "${workflowId}" via apply_ops (update_node) to use an active connectionRef.`,
      remediationOp: {
        kind: "update_node",
        payloadExample: {
          workflowId,
          nodeId,
          patch: {
            data: {
              ...(nodeData ?? {}),
              connectionRef: "conn_active",
            },
          },
        },
      },
    };
  }

  if (/RATE_LIMITED|429/i.test(errorMessage)) {
    return {
      code: "RUN_STEP_RATE_LIMITED",
      path: `/workflows/${workflowId}/nodes/${nodeId}`,
      message: errorMessage,
      suggestedFix: `Configure retry/backoff on node "${nodeId}" in workflow "${workflowId}" via apply_ops (update_node) or reduce request concurrency.`,
      remediationOp: {
        kind: "update_node",
        payloadExample: {
          workflowId,
          nodeId,
          patch: {
            data: {
              ...(nodeData ?? {}),
              maxRetries: 3,
            },
          },
        },
      },
    };
  }

  return {
    code: "RUN_STEP_EXECUTION_FAILED",
    path: `/workflows/${workflowId}/nodes/${nodeId}`,
    message: errorMessage,
    suggestedFix: `Inspect get_run_trace and query_logs for workflow "${workflowId}" node "${nodeId}", then call apply_ops with update_node to fix the step configuration.`,
    remediationOp: {
      kind: "update_node",
      payloadExample: {
        workflowId,
        nodeId,
        patch: {
          data: { ...(nodeData ?? {}) },
        },
      },
    },
  };
}

/**
 * Build an ActionableIssue for a deployment blocker (e.g. DEPLOY_STUB_IDENTITY_REFUSED).
 */
export function buildDeployBlockerActionableIssue(blockerMessage: string): ActionableIssue {
  if (/stub/i.test(blockerMessage) && /identity/i.test(blockerMessage)) {
    return {
      code: "DEPLOY_STUB_IDENTITY_REFUSED",
      path: "/identity",
      message: blockerMessage,
      suggestedFix: `Production deploys cannot use stub identity. Call apply_ops with enable_brick ({ brickId: "core-auth" }), bind_secret_ref for BETTER_AUTH_SECRET, and set_identity ({ identity: "core-auth" }) before running deploy_plan({ env: "production" }).`,
      remediationOp: {
        kind: "set_identity",
        payloadExample: {
          identity: "core-auth",
        },
      },
    };
  }

  return {
    code: "DEPLOY_VALIDATION_BLOCKED",
    path: "/blueprint",
    message: blockerMessage,
    suggestedFix: `Run validate_blueprint to inspect blueprint issues, resolve them with apply_ops, and retry deploy_plan.`,
  };
}
