import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { VectorMemoryService } from "./vectors.ts";

export interface VectorEnv {
  Bindings: { DB: D1Like };
  Variables: {
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    vectorService?: VectorMemoryService;
  };
}

export const vectorMiddleware: MiddlewareHandler<VectorEnv> = async (c, next) => {
  const service = new VectorMemoryService(c.env.DB);
  c.set("vectorService", service);
  await next();
};
