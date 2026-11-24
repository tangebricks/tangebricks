// What the Workers runtime provides to a Workflow, written out for the type checker. The real definitions ship with the
// runtime (and with @cloudflare/workers-types, which this repository does not install). Only what the proof uses is here.
// Source for the shapes: developers.cloudflare.com/workflows (read 2026-10-21) and a Workflow run under Miniflare in
// test/graph-workflow.node.test.ts, which is the check that these declarations match what workerd does.

declare module "cloudflare:workers" {
  export interface WorkflowEvent<Payload> {
    payload: Readonly<Payload>;
    timestamp: Date;
    instanceId: string;
  }
  export interface WorkflowStepConfig {
    retries?: { limit: number; delay: number | string; backoff?: "constant" | "linear" | "exponential" };
    timeout?: number | string;
  }
  export interface WorkflowStep {
    do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    sleep(name: string, duration: number | string): Promise<void>;
  }
  export abstract class WorkflowEntrypoint<Env = unknown, Payload = unknown> {
    protected ctx: unknown;
    protected env: Env;
    constructor(ctx: unknown, env: Env);
    abstract run(event: Readonly<WorkflowEvent<Payload>>, step: WorkflowStep): Promise<unknown>;
  }
}

declare module "cloudflare:workflows" {
  /** Thrown inside a step to end the step without retrying it. */
  export class NonRetryableError extends Error {
    constructor(message: string, name?: string);
  }
}
