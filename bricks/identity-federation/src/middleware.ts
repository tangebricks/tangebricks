import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { IdentityFederationService } from "./federation.ts";

export interface SsoEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid?: string; id?: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    ssoService?: IdentityFederationService;
  };
}

export const ssoMiddleware: MiddlewareHandler<SsoEnv> = async (c, next) => {
  if (!c.get("ssoService")) {
    const service = new IdentityFederationService(c.env.DB);
    c.set("ssoService", service);
  }
  await next();
};
