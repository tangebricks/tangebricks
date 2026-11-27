import { z } from "zod";
import type { Executor, Executors } from "./executor.ts";
import { createRegistry } from "./manifest.ts";
import type { Registry } from "./manifest.ts";
import { validateGraph } from "./validate.ts";
import type { GraphEdge, GraphNode } from "./validate.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function dig(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((at, key) => (typeof at === "object" && at !== null && Object.hasOwn(at, key) ? (at as Record<string, unknown>)[key] : undefined), value);
}

/** Behaviour for the toy bricks in @poc/sdk. Real bricks bring their own executors. */
export const toyExecutors: ReadonlyMap<string, Executor> = new Map<string, Executor>([
  ["trigger.manual", ({ payload }) => ({ out: payload })],
  ["transform.pick", ({ data, inputs }) => ({ out: dig(inputs.in, String(data.path)) })],
  ["sink.text", () => ({})],
  [
    "util.delay",
    async ({ data, inputs }) => {
      await sleep(Number(data.ms));
      return { out: inputs.in };
    },
  ],
  ["util.join", ({ inputs }) => ({ out: { a: inputs.a, b: inputs.b } })],
  [
    "util.boom",
    () => {
      throw new Error("boom");
    },
  ],
]);

/** Throwaway bricks, enough to exercise the validator and the runtime. Real bricks come in epic-bricks. */
export const toyRegistry = createRegistry([
  {
    type: "trigger.manual",
    category: "trigger",
    inputs: [],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({}),
    secrets: [],
  },
  {
    type: "transform.pick",
    category: "transform",
    inputs: [{ id: "in", dataType: "json" }],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({ path: z.string().min(1) }),
    secrets: [],
  },
  {
    type: "sink.text",
    category: "action",
    inputs: [{ id: "in", dataType: "text" }],
    outputs: [],
    configSchema: z.object({}),
    secrets: [],
  },
  {
    // Waits, then passes its input through. Lets tests see whether branches really overlap.
    type: "util.delay",
    category: "transform",
    inputs: [{ id: "in", dataType: "json" }],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({ ms: z.number().int().min(0).max(5000) }),
    secrets: [],
  },
  {
    // Waits for both inputs, which is what makes a diamond a diamond.
    type: "util.join",
    category: "transform",
    inputs: [
      { id: "a", dataType: "json" },
      { id: "b", dataType: "json" },
    ],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({}),
    secrets: [],
  },
  {
    type: "util.boom",
    category: "transform",
    inputs: [{ id: "in", dataType: "json" }],
    outputs: [{ id: "out", dataType: "json" }],
    configSchema: z.object({}),
    secrets: [],
  },
]);

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphWorkflowStepRunner {
  (nodeId: string, execute: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>>;
}

export interface GraphWorkflowRunResult {
  ok: boolean;
  outputs: Record<string, Record<string, unknown>>;
  failed: Record<string, string>;
  skipped: string[];
}

export class GraphWorkflow {
  private readonly registry: Registry;
  private readonly executors: Executors;

  constructor(registry: Registry, executors: Executors) {
    this.registry = registry;
    this.executors = executors;
  }

  async start(options: {
    graph: Graph;
    payload?: unknown;
    env?: Readonly<Record<string, unknown>>;
    runStep?: GraphWorkflowStepRunner;
    runId?: string;
    /** The run's verified workspace (AD-S19), handed to every executor as `ctx.workspaceId`. Required: no default. */
    workspaceId: string;
  }): Promise<GraphWorkflowRunResult> {
    const { graph, payload, env, runStep } = options;
    const workspaceId = options.workspaceId;
    if (typeof workspaceId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(workspaceId)) {
      throw new Error("NO_WORKSPACE: the run has no verified workspace, so nothing was run");
    }
    const runId = options.runId ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { issues, order } = validateGraph(graph.nodes, graph.edges, this.registry);
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      throw new Error(`graph is invalid: ${errors.map((i) => i.code).join(", ")}`);
    }

    const unreachable = new Set(issues.filter((i) => i.code === "orphan_node").map((i) => i.nodeId));
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const result: GraphWorkflowRunResult = { ok: true, outputs: {}, failed: {}, skipped: [] };
    const done = new Map<string, Promise<boolean>>();

    for (const id of order) {
      const node = byId.get(id)!;
      const incoming = graph.edges.filter((e) => e.target === id && byId.has(e.source));
      done.set(
        id,
        (async () => {
          const upstream = await Promise.all(incoming.map((e) => done.get(e.source)!));
          if (unreachable.has(id) || !upstream.every(Boolean)) {
            result.skipped.push(id);
            return false;
          }
          try {
            const executor = this.executors.get(node.type);
            if (!executor) throw new Error(`no executor registered for ${node.type}`);
            const declared = this.registry.get(node.type)?.secrets ?? [];
            const secret = (name: string): string => {
              if (!declared.includes(name)) throw new Error(`secret "${name}" is not declared by ${node.type}`);
              const value = env?.[name];
              if (typeof value !== "string") throw new Error(`secret "${name}" is declared by ${node.type} but was not provided`);
              return value;
            };
            const declaredBindings = this.registry.get(node.type)?.bindings ?? [];
            const binding = <T = unknown>(name: string): T => {
              if (!declaredBindings.includes(name)) throw new Error(`binding "${name}" is not declared by ${node.type}`);
              const value = env?.[name];
              if (value === undefined || value === null) throw new Error(`binding "${name}" is declared by ${node.type} but was not provided`);
              return value as T;
            };
            const byPort: Record<string, unknown[]> = {};
            for (const edge of incoming) {
              const value = result.outputs[edge.source]?.[edge.sourceHandle ?? "out"];
              (byPort[edge.targetHandle ?? "in"] ??= []).push(value);
            }
            const inputs = Object.fromEntries(Object.entries(byPort).map(([port, values]) => [port, values.length === 1 ? values[0] : values]));
            const call = async () =>
              executor({
                nodeId: id,
                runId,
                idempotencyKey: `${runId}:${id}`,
                workspaceId,
                data: node.data,
                inputs,
                payload,
                secret,
                binding,
              });
            result.outputs[id] = runStep ? await runStep(id, call) : await call();
            return true;
          } catch (error) {
            result.failed[id] = error instanceof Error ? error.message : String(error);
            return false;
          }
        })(),
      );
    }
    await Promise.all(done.values());
    result.ok = Object.keys(result.failed).length === 0;
    return result;
  }
}
