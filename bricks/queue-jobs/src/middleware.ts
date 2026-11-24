import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { JobQueueService } from "./jobs.ts";

export interface JobEnv {
  Bindings: { DB: D1Like };
  Variables: {
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    jobService?: JobQueueService;
  };
}

export const jobQueueMiddleware: MiddlewareHandler<JobEnv> = async (c, next) => {
  const service = new JobQueueService(c.env.DB);
  c.set("jobService", service);
  await next();
};
