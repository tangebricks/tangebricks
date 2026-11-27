// Vite helpers the tests rely on, declared here because pnpm does not expose vite's own types to these packages.
declare module "*?raw" {
  const text: string;
  export default text;
}

interface ImportMeta {
  glob(patterns: string | string[], options: { query?: string; import?: string; eager: true }): Record<string, unknown>;
  glob(patterns: string | string[], options?: { query?: string; import?: string; eager?: false }): Record<string, () => Promise<unknown>>;
}

// The Workers runtime's global env, importable by any code in the isolate. Used by H3 to show what that allows.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}

// The test helpers @cloudflare/vitest-plugin provides inside workerd. Its own declarations
// (@cloudflare/vitest-plugin/types) need @cloudflare/workers-types, which this repository does not install, so only the
// members the brick tests use are written out here, with the shapes from node_modules/@cloudflare/vitest-plugin/types.
declare module "cloudflare:test" {
  export interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
  export interface ScheduledController {
    readonly scheduledTime: number;
    readonly cron: string;
    noRetry(): void;
  }
  export interface ScheduledControllerOptions {
    scheduledTime?: Date | number;
    cron?: string;
  }
  export interface MessageBatch<Body = unknown> {
    readonly queue: string;
    readonly messages: readonly { readonly id: string; readonly timestamp: Date; readonly body: Body; readonly attempts: number }[];
    ackAll(): void;
    retryAll(options?: { delaySeconds?: number }): void;
  }
  export type MessageBatchMessage<Body = unknown> = {
    id: string;
    timestamp: Date | number;
    attempts: number;
    body: Body;
  };
  export interface QueueResult {
    outcome: string;
    ackAll: boolean;
    retryBatch: { retry: boolean; delaySeconds?: number };
    explicitAcks: string[];
    retryMessages: { msgId: string; delaySeconds?: number }[];
  }
  export function createExecutionContext(): ExecutionContext;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
  export function createScheduledController(options?: ScheduledControllerOptions): ScheduledController;
  export function createMessageBatch<Body = unknown>(queueName: string, messages: MessageBatchMessage<Body>[]): MessageBatch<Body>;
  export function getQueueResult(batch: MessageBatch, ctx: ExecutionContext): Promise<QueueResult>;
}
