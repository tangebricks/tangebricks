import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { DataPrivacyService } from "./privacy.ts";

export interface PrivacyEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string; name?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    privacyService?: DataPrivacyService;
  };
}

export const privacyMiddleware: MiddlewareHandler<PrivacyEnv> = async (c, next) => {
  const service = new DataPrivacyService(c.env.DB);
  c.set("privacyService", service);
  await next();
};
