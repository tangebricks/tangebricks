import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { UserOnboardingService } from "./onboarding.ts";

export interface OnboardingEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string; name?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    onboardingService?: UserOnboardingService;
  };
}

export const onboardingMiddleware: MiddlewareHandler<OnboardingEnv> = async (c, next) => {
  const service = new UserOnboardingService(c.env.DB);
  c.set("onboardingService", service);
  await next();
};
