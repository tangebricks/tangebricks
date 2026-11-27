import type { GraphEdge, GraphNode } from "@poc/sdk";
import type { Graph } from "../src/index.ts";

const wire = (source: string, target: string, sourceHandle = "out", targetHandle = "in"): GraphEdge => ({
  id: `${source}.${sourceHandle}-${target}.${targetHandle}`,
  source,
  target,
  sourceHandle,
  targetHandle,
});
const node = (id: string, type: string, data: Record<string, unknown> = {}): GraphNode => ({ id, type, data });

export const BRANCH_MS = 200;

/** trigger -> pick "a" -> pick "b": digs {a:{b:5}} down to 5. */
export const chainGraph: Graph = {
  nodes: [node("t", "trigger.manual"), node("p1", "transform.pick", { path: "a" }), node("p2", "transform.pick", { path: "b" })],
  edges: [wire("t", "p1"), wire("p1", "p2")],
};
export const chainPayload = { a: { b: 5 } };

/** trigger fans out to two slow branches that a join waits for. */
export const diamondGraph: Graph = {
  nodes: [node("t", "trigger.manual"), node("a", "util.delay", { ms: BRANCH_MS }), node("b", "util.delay", { ms: BRANCH_MS }), node("j", "util.join")],
  edges: [wire("t", "a"), wire("t", "b"), wire("a", "j", "out", "a"), wire("b", "j", "out", "b")],
};

/** One branch of the diamond on its own, to time what running the branches one after the other costs. */
export const branchOnly = (id: "a" | "b"): Graph => ({
  nodes: [node("t", "trigger.manual"), node(id, "util.delay", { ms: BRANCH_MS })],
  edges: [wire("t", id)],
});

export { node, wire };
