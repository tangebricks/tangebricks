import type { Registry } from "./manifest.ts";
import { DEFAULT_FANOUT_LIMIT, getPlatformLimits } from "./platform-limits.ts";
import type { GraphEdge, GraphNode, ValidationIssue } from "./validate.ts";

export { DEFAULT_FANOUT_LIMIT } from "./platform-limits.ts";

export interface BudgetIssue extends ValidationIssue {
  measured: number;
  limit: number;
  plan: "free" | "paid";
  fix: string;
}

/**
 * Assembly-time static budget check for graphs.
 * Evaluates:
 * - Workflow step budget: nodes reachable from trigger + load step <= limits[plan].steps.limit (1,024 free / 4,096 paid)
 * - Fan-out limit: output port connections <= 256
 * - Subrequests budget: sum over integration nodes (or individual node) of (pagination ? maxPages : 1) * (retries + 1) <= limits[plan].subrequests.limit (50 free / 1,000 paid)
 * - Payload size estimate: flags output dataType rows/json lacking maxOutputBytes with BUDGET_PAYLOAD_UNBOUNDED_WARNING
 */
export function checkGraphBudget(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  registry: Registry,
  plan: "free" | "paid" = "free",
): BudgetIssue[] {
  const limits = getPlatformLimits(plan);
  const issues: BudgetIssue[] = [];
  const { nodes, edges } = graph;

  if (nodes.length === 0) {
    return issues;
  }

  // 1. Build adjacency list and find trigger nodes
  const triggers = nodes.filter((n) => {
    const brick = registry.get(n.type);
    return brick?.category === "trigger" || n.type.startsWith("trigger.");
  });

  const next = new Map<string, string[]>();
  for (const n of nodes) {
    next.set(n.id, []);
  }
  for (const e of edges) {
    const list = next.get(e.source);
    if (list) {
      list.push(e.target);
    }
  }

  // Determine reachable nodes from triggers (or all nodes if no triggers defined)
  const reached = new Set<string>();
  const queue: string[] = [];
  const startNodes = triggers.length > 0 ? triggers.map((t) => t.id) : nodes.map((n) => n.id);
  for (const id of startNodes) {
    reached.add(id);
    queue.push(id);
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const target of next.get(curr) || []) {
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }

  // 2. Step budget check: reachable nodes + 1 (the load step)
  const measuredSteps = reached.size + 1;
  const stepLimit = limits.steps.limit;
  if (measuredSteps > stepLimit) {
    issues.push({
      code: "BUDGET_STEPS_EXCEEDED",
      nodeId: triggers[0]?.id ?? nodes[0]?.id ?? "",
      message: `Graph contains ${measuredSteps} steps (including load step), which exceeds the ${plan} plan limit of ${stepLimit} steps`,
      severity: "error",
      measured: measuredSteps,
      limit: stepLimit,
      plan,
      fix: "Reduce the number of steps in the graph, decompose the workflow into sub-workflows, or upgrade to a paid plan",
    });
  }

  // 3. Max fan-out per output port check: <= 256
  const fanoutCounts = new Map<string, { nodeId: string; handle: string; count: number }>();
  for (const e of edges) {
    const handle = e.sourceHandle ?? "out";
    const key = `${e.source}:${handle}`;
    const cur = fanoutCounts.get(key) ?? { nodeId: e.source, handle, count: 0 };
    cur.count++;
    fanoutCounts.set(key, cur);
  }

  for (const entry of fanoutCounts.values()) {
    if (entry.count > DEFAULT_FANOUT_LIMIT) {
      issues.push({
        code: "BUDGET_FANOUT_EXCEEDED",
        nodeId: entry.nodeId,
        message: `Output port "${entry.handle}" of node "${entry.nodeId}" feeds ${entry.count} target connections, which exceeds the fan-out limit of ${DEFAULT_FANOUT_LIMIT}`,
        severity: "error",
        measured: entry.count,
        limit: DEFAULT_FANOUT_LIMIT,
        plan,
        fix: "Reduce the number of connected target nodes to 256 or fewer, or distribute fan-out across intermediate batch stages",
      });
    }
  }

  // 4. Subrequests budget check: integration nodes & core.batch
  const subreqLimit = limits.subrequests.limit;
  let totalSubrequests = 0;
  let individualNodeExceeded = false;

  for (const node of nodes) {
    if (!reached.has(node.id)) {
      continue;
    }
    const manifest = registry.get(node.type);
    const isBatch = node.type === "core.batch";
    const isIntegration =
      node.type.startsWith("integration.") ||
      node.type.startsWith("int:") ||
      manifest?.executor === "integration" ||
      (manifest as { category?: string } | undefined)?.category === "integration" ||
      (node.data as { pagination?: unknown } | undefined)?.pagination !== undefined;

    if (isBatch) {
      // core.batch counts subrequests as 1 per chunk enqueue instead of per item
      totalSubrequests += 1;
    } else if (isIntegration) {
      const nodeData = node.data as Record<string, unknown> | undefined;
      const pagination = (nodeData?.pagination ?? (manifest as { pagination?: unknown } | undefined)?.pagination) as
        | { maxPages?: number }
        | undefined;
      const maxPages =
        typeof pagination?.maxPages === "number"
          ? pagination.maxPages
          : typeof nodeData?.maxPages === "number"
            ? (nodeData.maxPages as number)
            : 1;

      const retryPolicy = nodeData?.retryPolicy as { limit?: number } | undefined;
      const retryLimit =
        typeof retryPolicy?.limit === "number"
          ? retryPolicy.limit
          : typeof nodeData?.retries === "number"
            ? (nodeData.retries as number)
            : 0;

      const nodeSubreqs = Math.max(1, maxPages) * (retryLimit + 1);
      totalSubrequests += nodeSubreqs;

      if (nodeSubreqs > subreqLimit) {
        individualNodeExceeded = true;
        issues.push({
          code: "BUDGET_SUBREQUESTS_EXCEEDED",
          nodeId: node.id,
          message: `Node "${node.id}" estimated subrequests (${nodeSubreqs}) exceeds the ${plan} plan limit of ${subreqLimit} subrequests`,
          severity: "error",
          measured: nodeSubreqs,
          limit: subreqLimit,
          plan,
          fix: "Move the bulk send to a Batch node (UC7.5), reduce pagination.maxPages, or upgrade to a paid plan",
        });
      }
    }
  }

  if (!individualNodeExceeded && totalSubrequests > subreqLimit) {
    const firstIntegrationNode = nodes.find(
      (n) =>
        reached.has(n.id) &&
        (n.type.startsWith("integration.") || n.type.startsWith("int:")),
    );
    issues.push({
      code: "BUDGET_SUBREQUESTS_EXCEEDED",
      nodeId: firstIntegrationNode?.id ?? nodes[0]?.id ?? "",
      message: `Total estimated subrequests (${totalSubrequests}) across integration nodes exceeds the ${plan} plan limit of ${subreqLimit} subrequests`,
      severity: "error",
      measured: totalSubrequests,
      limit: subreqLimit,
      plan,
      fix: "Move the bulk send to a Batch node (UC7.5), reduce pages/concurrency, or upgrade to a paid plan",
    });
  }

  // 5. Payload estimate warning: dataType rows or json without maxOutputBytes
  for (const node of nodes) {
    if (!reached.has(node.id)) {
      continue;
    }
    const manifest = registry.get(node.type);
    if (!manifest || manifest.category === "trigger") {
      continue;
    }

    const nodeData = (node.data ?? {}) as Record<string, unknown>;
    const hasMaxOutputBytes =
      typeof nodeData.maxOutputBytes === "number" && nodeData.maxOutputBytes > 0;

    for (const output of manifest.outputs) {
      const isUnboundedType =
        output.dataType === "rows" ||
        (output.dataType === "json" &&
          (manifest.executor === "integration" ||
            node.type.startsWith("integration.") ||
            node.type.startsWith("int:")));

      if (isUnboundedType && !hasMaxOutputBytes) {
        issues.push({
          code: "BUDGET_PAYLOAD_UNBOUNDED_WARNING",
          nodeId: node.id,
          message: `Node "${node.id}" outputs unbounded "${output.dataType}" payload without declaring maxOutputBytes`,
          severity: "warning",
          measured: 0,
          limit: limits.stepReturnBytes.limit,
          plan,
          fix: "Declare maxOutputBytes in node configuration to bound step output size",
        });
        break; // one payload warning per node is sufficient
      }
    }
  }

  return issues;
}
