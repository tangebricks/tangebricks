import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { FacetedSearchService } from "./search.ts";

export interface SearchEnv {
  Bindings: { DB: D1Like };
  Variables: {
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    searchService?: FacetedSearchService;
  };
}

export const searchMiddleware: MiddlewareHandler<SearchEnv> = async (c, next) => {
  const service = new FacetedSearchService(c.env.DB);
  c.set("searchService", service);
  await next();
};
