import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { MarketplaceSplitsService } from "./splits.ts";

export interface SplitsEnv {
  Bindings: { DB: D1Like };
  Variables: {
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    splitsService?: MarketplaceSplitsService;
  };
}

export const splitsMiddleware: MiddlewareHandler<SplitsEnv> = async (c, next) => {
  const service = new MarketplaceSplitsService(c.env.DB);
  c.set("splitsService", service);
  await next();
};
