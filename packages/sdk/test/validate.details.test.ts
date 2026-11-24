import { describe, expect, test } from "vitest";
import { checkWire, createRegistry, toyRegistry, validateGraph, type GraphEdge, type GraphNode } from "../src/index.ts";

const nodes: GraphNode[] = [
  { id: "t", type: "trigger.manual", data: {} },
  { id: "p", type: "transform.pick", data: { path: "a" } },
  { id: "s", type: "sink.text", data: {} },
];
const edge = (source: string, target: string, sourceHandle = "out", targetHandle = "in"): GraphEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle,
  targetHandle,
});

describe("checkWire (the live wire-drop guard)", () => {
  test("accepts matching types", () => {
    expect(checkWire(edge("t", "p"), nodes, toyRegistry)).toBeNull();
  });

  test("refuses a node wired to itself", () => {
    expect(checkWire(edge("p", "p"), nodes, toyRegistry)).toMatch(/itself/);
  });

  test("refuses json into text and names both types", () => {
    expect(checkWire(edge("p", "s"), nodes, toyRegistry)).toBe("json cannot feed text");
  });

  test("refuses a port that does not exist", () => {
    expect(checkWire(edge("t", "p", "nope"), nodes, toyRegistry)).toBe("unknown port");
  });

  test("an 'any' port connects to anything", () => {
    const registry = createRegistry([
      { type: "a", category: "trigger", inputs: [], outputs: [{ id: "out", dataType: "any" }], configSchema: toyRegistry.get("sink.text")!.configSchema, secrets: [] },
      ...[...toyRegistry.values()].filter((b) => b.type === "sink.text"),
    ]);
    const graph: GraphNode[] = [{ id: "a", type: "a", data: {} }, { id: "s", type: "sink.text", data: {} }];
    expect(checkWire(edge("a", "s"), graph, registry)).toBeNull();
  });
});

describe("validateGraph details beyond the nine fixtures", () => {
  test("a node wired to itself is reported as a loop and as an incompatible wire", () => {
    const { issues } = validateGraph(nodes.slice(0, 2), [edge("t", "p"), edge("p", "p")], toyRegistry);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("cycle");
    expect(codes).toContain("incompatible_wire");
  });

  test("orphans are warnings; everything else is an error", () => {
    const { issues } = validateGraph(
      [...nodes.slice(0, 2), { id: "lonely", type: "transform.pick", data: { path: "a" } }],
      [edge("t", "p")],
      toyRegistry,
    );
    expect(issues).toEqual([expect.objectContaining({ code: "orphan_node", nodeId: "lonely", severity: "warning" })]);
  });

  test("a reference to a node that does not exist is reported", () => {
    const { issues } = validateGraph(
      [nodes[0]!, { id: "p", type: "transform.pick", data: { path: "{{$node.ghost.x}}" } }],
      [edge("t", "p")],
      toyRegistry,
    );
    expect(issues.map((i) => i.code)).toEqual(["bad_ref"]);
  });

  test("the run order puts every node after the nodes that feed it", () => {
    const { order } = validateGraph(nodes.slice(0, 2), [edge("t", "p")], toyRegistry);
    expect(order).toEqual(["t", "p"]);
  });

  test("an empty graph reports only the missing trigger", () => {
    expect(validateGraph([], [], toyRegistry).issues.map((i) => i.code)).toEqual(["no_trigger"]);
  });

  test("an edge naming a missing node is ignored, not a crash", () => {
    expect(() => validateGraph(nodes.slice(0, 2), [edge("t", "p"), edge("p", "ghost")], toyRegistry)).not.toThrow();
  });

  test("duplicate brick types are rejected when building a registry", () => {
    const brick = toyRegistry.get("sink.text")!;
    expect(() => createRegistry([brick, brick])).toThrow(/duplicate brick type/);
  });
});
