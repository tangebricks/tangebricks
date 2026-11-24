import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { ProductAnalyticsService } from "./analytics.ts";

export interface AnalyticsEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    analyticsService?: ProductAnalyticsService;
  };
}

export const analyticsMiddleware: MiddlewareHandler<AnalyticsEnv> = async (c, next) => {
  const service = new ProductAnalyticsService(c.env.DB);
  c.set("analyticsService", service);
  await next();
};
