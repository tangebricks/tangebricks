import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { CustomDomainService } from "./domains.ts";

export interface CustomDomainEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string; name?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    domainService?: CustomDomainService;
  };
}

export const customDomainMiddleware: MiddlewareHandler<CustomDomainEnv> = async (c, next) => {
  const service = new CustomDomainService(c.env.DB);
  c.set("domainService", service);
  await next();
};
