import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { NotificationService } from "./notifications.ts";

export interface NotificationEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    notificationService?: NotificationService;
  };
}

export const notificationMiddleware: MiddlewareHandler<NotificationEnv> = async (c, next) => {
  const service = new NotificationService(c.env.DB);
  c.set("notificationService", service);
  await next();
};
