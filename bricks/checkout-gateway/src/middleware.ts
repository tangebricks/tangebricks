import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { CheckoutService } from "./checkout.ts";

export interface CheckoutEnv {
  Bindings: { DB: D1Like };
  Variables: {
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    checkoutService?: CheckoutService;
  };
}

export const checkoutMiddleware: MiddlewareHandler<CheckoutEnv> = async (c, next) => {
  const service = new CheckoutService(c.env.DB);
  c.set("checkoutService", service);
  await next();
};
