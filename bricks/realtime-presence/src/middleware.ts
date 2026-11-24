import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { RealtimePresenceService } from "./presence.ts";

export interface PresenceEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string; name?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    presenceService?: RealtimePresenceService;
  };
}

export const presenceMiddleware: MiddlewareHandler<PresenceEnv> = async (c, next) => {
  const service = new RealtimePresenceService(c.env.DB);
  c.set("presenceService", service);
  await next();
};
