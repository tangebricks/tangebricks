import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

// When running inside Cloudflare Workers / workerd, use the platform WorkflowEntrypoint.
// When running inside Node (e.g. scripts or test harnesses), use a fallback class so imports do not fail.
let BaseEntrypoint: new (ctx: unknown, env: unknown) => { ctx: unknown; env: unknown } = class {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
};
let NonRetryableErrorClass: typeof Error = Error;

try {
  const cfWorkers = await import("cloudflare:workers");
  if (cfWorkers.WorkflowEntrypoint) {
    BaseEntrypoint = cfWorkers.WorkflowEntrypoint as never;
  }
} catch {
  // In Node environment outside workerd
}

try {
  const cfWorkflows = await import("cloudflare:workflows");
  if (cfWorkflows.NonRetryableError) {
    NonRetryableErrorClass = cfWorkflows.NonRetryableError as never;
  }
} catch {
  // In Node environment outside workerd
}

export const LIMITS_PROBE_WORKFLOW_CLASS = "LimitsProbeWorkflow";

export interface LimitsProbePayload {
  mode: "steps" | "return" | "event" | "subrequests" | "retries";
  target?: number;
  payload?: unknown;
  hostUrl?: string;
  failUntilAttempt?: number;
}

export interface LimitsProbeEnv {
  PROBE_WORKFLOW?: {
    create: (options: { id?: string; params?: LimitsProbePayload }) => Promise<{ id: string }>;
  };
  [key: string]: unknown;
}

export class LimitsProbe extends (BaseEntrypoint as new (ctx: unknown, env: LimitsProbeEnv) => { ctx: unknown; env: LimitsProbeEnv }) {
  async run(event: Readonly<WorkflowEvent<LimitsProbePayload>>, step: WorkflowStep) {
    const payload = event.payload ?? { mode: "steps", target: 1 };
    const mode = payload.mode;
    const target = payload.target ?? 1;

    switch (mode) {
      case "steps": {
        for (let i = 0; i < target; i++) {
          await step.do(`step-${i}`, async () => ({ step: i }));
        }
        return { ok: true, mode: "steps", stepsCompleted: target };
      }

      case "return": {
        const result = await step.do("return-step", async () => {
          return "x".repeat(target);
        });
        return { ok: true, mode: "return", bytes: result.length };
      }

      case "event": {
        const receivedBytes = typeof payload.payload === "string" ? payload.payload.length : JSON.stringify(payload).length;
        const result = await step.do("event-step", async () => ({
          receivedBytes,
        }));
        return { ok: true, mode: "event", ...result };
      }

      case "subrequests": {
        return step.do("subrequests-step", async () => {
          const targetUrl = payload.hostUrl ? `${payload.hostUrl.replace(/\/$/, "")}/__px/echo` : "https://cloudflare.com";
          const statuses: number[] = [];
          for (let i = 0; i < target; i++) {
            const resp = await fetch(targetUrl);
            statuses.push(resp.status);
          }
          return { ok: true, mode: "subrequests", fetchesCompleted: statuses.length };
        });
      }

      case "retries": {
        let attemptCounter = 0;
        return step.do(
          "retry-step",
          {
            retries: {
              limit: target,
              delay: "50 milliseconds",
              backoff: "constant",
            },
          },
          async () => {
            attemptCounter++;
            const failUntil = payload.failUntilAttempt ?? target;
            if (attemptCounter < failUntil) {
              throw new Error(`Intentional transient failure on attempt ${attemptCounter}`);
            }
            return { ok: true, mode: "retries", totalAttempts: attemptCounter };
          },
        );
      }

      default:
        throw new NonRetryableErrorClass(`Unknown probe mode: ${String(mode)}`);
    }
  }
}

export function handleLimitsProbeFetch(request: Request, env: LimitsProbeEnv): Response | Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/__px/echo") {
    return new Response(JSON.stringify({ ok: true, echo: true, timestamp: Date.now() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (url.pathname === "/__px/probe/start" && request.method === "POST") {
    return (async () => {
      const body = (await request.json().catch(() => ({}))) as LimitsProbePayload;
      if (!env.PROBE_WORKFLOW) {
        return new Response(JSON.stringify({ error: "PROBE_WORKFLOW binding not present" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      const instanceId = `probe-${body.mode}-${body.target ?? 1}-${Date.now()}`;
      const instance = await env.PROBE_WORKFLOW.create({
        id: instanceId,
        params: body,
      });
      return new Response(JSON.stringify({ ok: true, instanceId: instance.id }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })();
  }

  return new Response(JSON.stringify({ ok: true, service: "limits-probe" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
