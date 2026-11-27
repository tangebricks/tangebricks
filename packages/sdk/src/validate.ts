import type { Registry } from "./manifest.ts";

export interface GraphNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export type IssueCode =
  | "no_trigger"
  | "multi_trigger"
  | "cycle"
  | "orphan_node"
  | "unknown_brick"
  | "invalid_config"
  | "bad_ref"
  | "incompatible_wire"
  | "duplicate_node"
  | "BUDGET_STEPS_EXCEEDED"
  | "BUDGET_SUBREQUESTS_EXCEEDED"
  | "D1_BIND_PARAMS_EXCEEDED"
  | "BUDGET_FANOUT_EXCEEDED"
  | "BUDGET_PAYLOAD_UNBOUNDED_WARNING";

export interface ValidationIssue {
  nodeId: string;
  code: IssueCode;
  message: string;
  severity: "error" | "warning";
}

/** Why a wire is not allowed, or null when it is. Also usable live while a wire is being dragged. */
export function checkWire(edge: GraphEdge, nodes: GraphNode[], registry: Registry): string | null {
  if (edge.source === edge.target) return "a node cannot connect to itself";
  const portOf = (id: string, side: "inputs" | "outputs", handle?: string) =>
    registry.get(nodes.find((n) => n.id === id)?.type ?? "")?.[side].find((p) => p.id === (handle ?? (side === "outputs" ? "out" : "in")));
  const from = portOf(edge.source, "outputs", edge.sourceHandle);
  const to = portOf(edge.target, "inputs", edge.targetHandle);
  if (!from || !to) return "unknown port";
  const open = from.dataType === "any" || to.dataType === "any";
  return open || from.dataType === to.dataType ? null : `${from.dataType} cannot feed ${to.dataType}`;
}

/** Checks a { nodes, edges } graph against the registry. `order` is a run order for the nodes that are not in a loop. */
export function validateGraph(nodes: GraphNode[], edges: GraphEdge[], registry: Registry) {
  const issues: ValidationIssue[] = [];
  const add = (nodeId: string, code: IssueCode, message: string, severity: "error" | "warning" = "error") => issues.push({ nodeId, code, message, severity });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seenIds = new Set<string>();
  for (const n of nodes) {
    if (seenIds.has(n.id)) add(n.id, "duplicate_node", "another node has this id");
    seenIds.add(n.id);
  }

  const triggers = nodes.filter((n) => registry.get(n.type)?.category === "trigger");
  if (triggers.length === 0) add("", "no_trigger", "add a trigger brick to start the graph");
  if (triggers.length > 1) triggers.forEach((t) => add(t.id, "multi_trigger", "only one trigger is allowed"));

  // Kahn's algorithm: a run order, and every node it cannot place is in or behind a loop.
  const next = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const waiting = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    next.get(e.source)!.push(e.target);
    waiting.set(e.target, waiting.get(e.target)! + 1);
  }
  const order: string[] = [];
  const ready = nodes.filter((n) => waiting.get(n.id) === 0).map((n) => n.id);
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const to of next.get(id)!) {
      waiting.set(to, waiting.get(to)! - 1);
      if (waiting.get(to) === 0) ready.push(to);
    }
  }
  nodes.filter((n) => !order.includes(n.id)).forEach((n) => add(n.id, "cycle", "node is in or behind a loop"));

  // Everything the trigger can reach.
  const reached = new Set(triggers.map((t) => t.id));
  const pending = [...reached];
  while (pending.length > 0) {
    for (const to of next.get(pending.pop()!)!) {
      if (reached.has(to)) continue;
      reached.add(to);
      pending.push(to);
    }
  }

  for (const e of edges) {
    const known = [e.source, e.target].every((id) => registry.has(byId.get(id)?.type ?? ""));
    const problem = known ? checkWire(e, nodes, registry) : null;
    if (problem) add(e.target, "incompatible_wire", problem);
  }

  for (const node of nodes) {
    const brick = registry.get(node.type);
    if (!brick) {
      add(node.id, "unknown_brick", `unknown brick: ${node.type}`);
      continue;
    }
    if (triggers.length > 0 && !reached.has(node.id)) {
      add(node.id, "orphan_node", "not connected to the trigger", "warning");
    }
    const parsed = brick.configSchema.safeParse(node.data);
    if (!parsed.success) {
      parsed.error.issues.forEach((i) => add(node.id, "invalid_config", `${i.path.join(".")}: ${i.message}`));
    }
    const at = order.indexOf(node.id);
    for (const match of JSON.stringify(node.data).matchAll(/\{\{\$node\.([\w-]+)\./g)) {
      const ref = match[1]!;
      if (at >= 0 && (!byId.has(ref) || order.indexOf(ref) >= at)) {
        add(node.id, "bad_ref", `${ref} does not run before this node`);
      }
    }
  }
  return { issues, order };
}
