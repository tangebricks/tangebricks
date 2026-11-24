import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { D1Like, Executors, Registry } from "@poc/sdk";
import { runStoredGraph } from "./graph-run.ts";
import type { RunParams } from "./graph-run.ts";

// The one Workflow class. It exists only in workerd (the two cloudflare: imports); the logic it runs is in graph-run.ts.
// It is made by a function so that tests can give it other bricks, and so the bundle entry decides which bricks the
// deployed one has.

export interface GraphRunnerEnv {
  DB: D1Like;
  [binding: string]: unknown;
}

export function createGraphRunner(options: { registry: Registry; executors: Executors }) {
  return class GraphRunnerBase extends WorkflowEntrypoint<GraphRunnerEnv, RunParams> {
    async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep) {
      return runStoredGraph({
        step,
        db: this.env.DB,
        params: {
          ...event.payload,
          runId: event.instanceId,
        },
        runId: event.instanceId,
        env: this.env,
        registry: options.registry,
        executors: options.executors,
        nonRetryable: (message) => new NonRetryableError(message),
      });
    }
  };
}
