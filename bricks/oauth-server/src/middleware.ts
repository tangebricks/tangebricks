import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { OAuthServerService } from "./oauth.ts";

export interface OAuthEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string; name?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    oauthService?: OAuthServerService;
  };
}

export const oauthMiddleware: MiddlewareHandler<OAuthEnv> = async (c, next) => {
  const service = new OAuthServerService(c.env.DB);
  c.set("oauthService", service);
  await next();
};
