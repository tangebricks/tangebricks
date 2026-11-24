import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { ThreadedDiscussionService } from "./threads.ts";

export interface ThreadEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string; name?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    discussionService?: ThreadedDiscussionService;
  };
}

export const discussionMiddleware: MiddlewareHandler<ThreadEnv> = async (c, next) => {
  const service = new ThreadedDiscussionService(c.env.DB);
  c.set("discussionService", service);
  await next();
};
