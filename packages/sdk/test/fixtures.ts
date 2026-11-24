import type { GraphEdge, GraphNode, IssueCode } from "../src/index.ts";

export interface Fixture {
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The exact set of issue codes the validator must report. Empty means the graph is valid. */
  expect: IssueCode[];
}

const trigger = (id: string): GraphNode => ({ id, type: "trigger.manual", data: {} });
const pick = (id: string, path = "a"): GraphNode => ({ id, type: "transform.pick", data: { path } });
const wire = (source: string, target: string): GraphEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle: "out",
  targetHandle: "in",
});

export const fixtures: Fixture[] = [
  {
    name: "valid",
    // p2 refers to the trigger's output with a pill, which runs before it: allowed.
    nodes: [trigger("t"), pick("p1"), pick("p2", "{{$node.t.value}}")],
    edges: [wire("t", "p1"), wire("p1", "p2")],
    expect: [],
  },
  {
    name: "no trigger",
    nodes: [pick("p1"), pick("p2")],
    edges: [wire("p1", "p2")],
    expect: ["no_trigger"],
  },
  {
    name: "two triggers",
    nodes: [trigger("t1"), trigger("t2"), pick("p1")],
    edges: [wire("t1", "p1"), wire("t2", "p1")],
    expect: ["multi_trigger"],
  },
  {
    name: "cycle",
    nodes: [trigger("t"), pick("p1"), pick("p2")],
    edges: [wire("t", "p1"), wire("p1", "p2"), wire("p2", "p1")],
    expect: ["cycle"],
  },
  {
    name: "orphan node",
    nodes: [trigger("t"), pick("p1"), pick("lonely")],
    edges: [wire("t", "p1")],
    expect: ["orphan_node"],
  },
  {
    name: "unknown brick",
    nodes: [trigger("t"), { id: "x", type: "does.not.exist", data: {} }],
    edges: [wire("t", "x")],
    expect: ["unknown_brick"],
  },
  {
    name: "invalid config",
    nodes: [trigger("t"), pick("p1", "")],
    edges: [wire("t", "p1")],
    expect: ["invalid_config"],
  },
  {
    name: "bad upstream reference",
    // p1 reads p2's output, but p2 runs after p1.
    nodes: [trigger("t"), pick("p1", "{{$node.p2.value}}"), pick("p2")],
    edges: [wire("t", "p1"), wire("p1", "p2")],
    expect: ["bad_ref"],
  },
  {
    name: "incompatible wire",
    // a json output into a text input
    nodes: [trigger("t"), { id: "s", type: "sink.text", data: {} }],
    edges: [wire("t", "s")],
    expect: ["incompatible_wire"],
  },
  {
    // Found by independent code review: not one of the original eight classes, added because the maps
    // keyed by id would otherwise silently merge the two nodes.
    name: "duplicate node id",
    nodes: [trigger("t"), pick("p1"), pick("p1")],
    edges: [wire("t", "p1")],
    expect: ["duplicate_node"],
  },
];
