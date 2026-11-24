import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { TabularService } from "./tabular.ts";

export interface TabularEnv {
  Bindings: { DB: D1Like };
  Variables: {
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    tabularService?: TabularService;
  };
}

export const tabularMiddleware: MiddlewareHandler<TabularEnv> = async (c, next) => {
  const service = new TabularService(c.env.DB);
  c.set("tabularService", service);
  await next();
};
