import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { FeatureFlagService } from "./flags.ts";

export interface FlagEnv {
  Bindings: { DB: D1Like; PX_PLATFORM_OPERATORS?: string };
  Variables: {
    user?: { uid: string; email?: string };
    /** The verified request context set by the workspace middleware; the only source of the caller's role. */
    ctx?: RequestContext;
    workspace?: { id: string; role?: string; suspended?: boolean };
    flags?: {
      isEnabled: (key: string) => Promise<boolean>;
    };
  };
}

/**
 * Attaches the feature flag evaluation context to the Hono request.
 */
export const featureFlagMiddleware: MiddlewareHandler<FlagEnv> = async (c, next) => {
  const user = c.get("user");
  const workspace = c.get("workspace");

  const service = new FeatureFlagService(c.env.DB);
  c.set("flags", {
    isEnabled: (key: string) =>
      service.isEnabled(key, { workspaceId: workspace?.id, userId: user?.uid }),
  });

  await next();
};

/**
 * Guards a route: returns 404 Not Found if the requested feature flag is disabled for the caller.
 */
export function requireFlag(flagKey: string): MiddlewareHandler<FlagEnv> {
  return async (c, next) => {
    const user = c.get("user");
    const workspace = c.get("workspace");

    const service = new FeatureFlagService(c.env.DB);
    const enabled = await service.isEnabled(flagKey, {
      workspaceId: workspace?.id,
      userId: user?.uid,
    });

    if (!enabled) {
      return c.json({ error: "Feature not available", flag: flagKey }, 404);
    }

    await next();
  };
}
