import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkGraphBudget, createRegistry, parseEntities, toyRegistry, type GraphEdge, type GraphNode } from "../src/index.ts";

describe("Story UC7.4 — Assembly-time static budget check for graphs and entities", () => {
  const customRegistry = createRegistry([
    ...toyRegistry.values(),
    {
      type: "integration.search",
      category: "action",
      executor: "integration",
      inputs: [{ id: "in", dataType: "json" }],
      outputs: [{ id: "out", dataType: "json" }],
      configSchema: z.object({
        pagination: z
          .object({
            maxPages: z.number().int().positive(),
          })
          .optional(),
        maxOutputBytes: z.number().int().positive().optional(),
      }),
      secrets: ["API_KEY"],
    },
    {
      type: "integration.fetch_rows",
      category: "action",
      executor: "integration",
      inputs: [{ id: "in", dataType: "json" }],
      outputs: [{ id: "out", dataType: "rows" }],
      configSchema: z.object({
        maxOutputBytes: z.number().int().positive().optional(),
      }),
      secrets: [],
    },
    {
      type: "core.batch",
      category: "action",
      inputs: [{ id: "in", dataType: "json" }],
      outputs: [{ id: "out", dataType: "json" }],
      configSchema: z.object({
        chunkSize: z.union([z.number().int(), z.literal("auto")]),
        maxItems: z.number().int().optional(),
      }),
      secrets: [],
    },
  ]);

  it("red case 1: graph with 1,200 nodes on plan 'free' yields BUDGET_STEPS_EXCEEDED (AC1)", () => {
    // 1 trigger node + 1,199 action nodes = 1,200 nodes.
    // Plus 1 load step = 1,201 total steps (free limit is 1,024).
    const nodes: GraphNode[] = [{ id: "trigger_0", type: "trigger.manual", data: {} }];
    const edges: GraphEdge[] = [];

    for (let i = 1; i < 1200; i++) {
      const prevId = i === 1 ? "trigger_0" : `step_${i - 1}`;
      const currId = `step_${i}`;
      nodes.push({ id: currId, type: "transform.pick", data: { path: "x" } });
      edges.push({
        id: `e_${i}`,
        source: prevId,
        target: currId,
        sourceHandle: "out",
        targetHandle: "in",
      });
    }

    const issues = checkGraphBudget({ nodes, edges }, customRegistry, "free");
    const stepErrors = issues.filter((i) => i.code === "BUDGET_STEPS_EXCEEDED");

    expect(stepErrors).toHaveLength(1);
    const err = stepErrors[0]!;
    expect(err.code).toBe("BUDGET_STEPS_EXCEEDED");
    expect(err.severity).toBe("error");
    expect(err.measured).toBe(1201);
    expect(err.limit).toBe(1024);
    expect(err.plan).toBe("free");
    expect(err.fix).toBeTruthy();
  });

  it("red case 2: integration node with pagination.maxPages 60 on 'free' yields BUDGET_SUBREQUESTS_EXCEEDED naming the node (AC1)", () => {
    const nodes: GraphNode[] = [
      { id: "trig", type: "trigger.manual", data: {} },
      {
        id: "bulk_search",
        type: "integration.search",
        data: {
          pagination: { maxPages: 60 },
          maxOutputBytes: 10000,
        },
      },
    ];
    const edges: GraphEdge[] = [{ id: "e1", source: "trig", target: "bulk_search", sourceHandle: "out", targetHandle: "in" }];

    const issues = checkGraphBudget({ nodes, edges }, customRegistry, "free");
    const subreqErrors = issues.filter((i) => i.code === "BUDGET_SUBREQUESTS_EXCEEDED");

    expect(subreqErrors).toHaveLength(1);
    const err = subreqErrors[0]!;
    expect(err.code).toBe("BUDGET_SUBREQUESTS_EXCEEDED");
    expect(err.nodeId).toBe("bulk_search");
    expect(err.severity).toBe("error");
    expect(err.measured).toBe(60);
    expect(err.limit).toBe(50);
    expect(err.plan).toBe("free");
    expect(err.fix).toMatch(/Batch/i);
  });

  it("red case 3: entity with 97 fields yields D1_BIND_PARAMS_EXCEEDED from parseEntities (AC1)", () => {
    // 97 fields + 4 system columns = 101 parameters (limit is 100).
    const fields = Array.from({ length: 97 }, (_, i) => ({
      name: `field_${i}`,
      type: "text" as const,
      required: false,
    }));

    const result = parseEntities([
      {
        name: "wide_entity",
        workspaceScoped: true,
        fields,
      },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues?.find((i) => i.code === "D1_BIND_PARAMS_EXCEEDED");
      expect(issue).toBeDefined();
      expect(issue!.code).toBe("D1_BIND_PARAMS_EXCEEDED");
      expect(issue!.nodeId).toBe("wide_entity");
      expect(issue!.measured).toBe(101);
      expect(issue!.limit).toBe(100);
      expect(issue!.plan).toBe("free");
      expect(issue!.fix).toMatch(/split/i);
      expect(result.errors.some((e) => e.includes("D1_BIND_PARAMS_EXCEEDED"))).toBe(true);
    }
  });

  it("red case 4: fan-out feeding 300 targets yields BUDGET_FANOUT_EXCEEDED (AC1)", () => {
    const nodes: GraphNode[] = [
      { id: "trig", type: "trigger.manual", data: {} },
      { id: "broadcaster", type: "transform.pick", data: { path: "val" } },
    ];
    const edges: GraphEdge[] = [{ id: "e0", source: "trig", target: "broadcaster", sourceHandle: "out", targetHandle: "in" }];

    for (let i = 0; i < 300; i++) {
      const targetId = `leaf_${i}`;
      nodes.push({ id: targetId, type: "sink.text", data: {} });
      edges.push({
        id: `fan_${i}`,
        source: "broadcaster",
        target: targetId,
        sourceHandle: "out",
        targetHandle: "in",
      });
    }

    const issues = checkGraphBudget({ nodes, edges }, customRegistry, "free");
    const fanoutErrors = issues.filter((i) => i.code === "BUDGET_FANOUT_EXCEEDED");

    expect(fanoutErrors).toHaveLength(1);
    const err = fanoutErrors[0]!;
    expect(err.code).toBe("BUDGET_FANOUT_EXCEEDED");
    expect(err.nodeId).toBe("broadcaster");
    expect(err.severity).toBe("error");
    expect(err.measured).toBe(300);
    expect(err.limit).toBe(256);
    expect(err.plan).toBe("free");
    expect(err.fix).toBeTruthy();
  });

  it("warns BUDGET_PAYLOAD_UNBOUNDED_WARNING when node outputs rows or json without maxOutputBytes", () => {
    const nodes: GraphNode[] = [
      { id: "trig", type: "trigger.manual", data: {} },
      {
        id: "fetch_db",
        type: "integration.fetch_rows",
        data: {}, // no maxOutputBytes declared
      },
    ];
    const edges: GraphEdge[] = [{ id: "e1", source: "trig", target: "fetch_db", sourceHandle: "out", targetHandle: "in" }];

    const issues = checkGraphBudget({ nodes, edges }, customRegistry, "free");
    const warnings = issues.filter((i) => i.code === "BUDGET_PAYLOAD_UNBOUNDED_WARNING");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe("warning");
    expect(warnings[0]!.nodeId).toBe("fetch_db");
    expect(warnings[0]!.fix).toMatch(/maxOutputBytes/i);
  });

  it("paid plan accommodates 1,200 steps and 60 pages subrequests within limits", () => {
    // 1. 1,200 steps on paid (limit 4,096) -> passes steps check
    const stepNodes: GraphNode[] = [{ id: "trigger_0", type: "trigger.manual", data: {} }];
    const stepEdges: GraphEdge[] = [];
    for (let i = 1; i < 1200; i++) {
      const prevId = i === 1 ? "trigger_0" : `step_${i - 1}`;
      const currId = `step_${i}`;
      stepNodes.push({ id: currId, type: "transform.pick", data: { path: "x" } });
      stepEdges.push({
        id: `e_${i}`,
        source: prevId,
        target: currId,
        sourceHandle: "out",
        targetHandle: "in",
      });
    }

    const paidStepIssues = checkGraphBudget({ nodes: stepNodes, edges: stepEdges }, customRegistry, "paid");
    expect(paidStepIssues.filter((i) => i.code === "BUDGET_STEPS_EXCEEDED")).toHaveLength(0);

    // 2. 60 subrequests on paid (limit 1,000) -> passes subrequests check
    const subreqNodes: GraphNode[] = [
      { id: "trig", type: "trigger.manual", data: {} },
      {
        id: "bulk_search",
        type: "integration.search",
        data: {
          pagination: { maxPages: 60 },
          maxOutputBytes: 10000,
        },
      },
    ];
    const subreqEdges: GraphEdge[] = [{ id: "e1", source: "trig", target: "bulk_search", sourceHandle: "out", targetHandle: "in" }];

    const paidSubreqIssues = checkGraphBudget({ nodes: subreqNodes, edges: subreqEdges }, customRegistry, "paid");
    expect(paidSubreqIssues.filter((i) => i.code === "BUDGET_SUBREQUESTS_EXCEEDED")).toHaveLength(0);
  });

  it("core.batch counts subrequests as 1 per chunk enqueue instead of per item", () => {
    const nodes: GraphNode[] = [
      { id: "trig", type: "trigger.manual", data: {} },
      {
        id: "batch_sender",
        type: "core.batch",
        data: {
          chunkSize: "auto",
          maxItems: 2500,
        },
      },
    ];
    const edges: GraphEdge[] = [{ id: "e1", source: "trig", target: "batch_sender", sourceHandle: "out", targetHandle: "in" }];

    const issues = checkGraphBudget({ nodes, edges }, customRegistry, "free");
    expect(issues.filter((i) => i.code === "BUDGET_SUBREQUESTS_EXCEEDED")).toHaveLength(0);
  });
});
