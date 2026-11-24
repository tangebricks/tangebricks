import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { rateLimit } from "@poc/sdk";
import { TrafficArmorService } from "./armor.ts";

export interface ArmorEnv {
  Bindings: { DB: D1Like };
  Variables: {
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    armorService?: TrafficArmorService;
  };
}

export interface ArmorMiddlewareOptions {
  rateLimit?: {
    limit: number;
    windowSeconds: number;
    /** What a request is counted by: the client IP (default) or the verified workspace. */
    key?: "ip" | "workspace";
  };
  enforceIpRules?: boolean;
}

export function trafficArmorMiddleware(
  options: ArmorMiddlewareOptions = {}
): MiddlewareHandler<ArmorEnv> {
  return async (c, next) => {
    const service = new TrafficArmorService(c.env.DB);
    c.set("armorService", service);

    const clientIp =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      "127.0.0.1";
    const userAgent = c.req.header("user-agent") || undefined;
    const workspace = c.get("workspace");
    const path = c.req.path;

    // 1. IP Rule Check
    if (options.enforceIpRules !== false && workspace?.id) {
      const action = await service.checkIp(workspace.id, clientIp);
      if (action === "block") {
        await service.logBlockedRequest(workspace.id, clientIp, path, "ip_block", userAgent);
        return c.json({ error: "Access denied by IP security rule" }, 403);
      }
    }

    // 2. Rate Limit Check: the shared SDK limiter (story 0.21), bucket "armor", counted in px_rate_limits. Fails open:
    // an armor limit is a traffic shield, not an auth control. A refused request is still logged as an incident.
    if (options.rateLimit) {
      const limiter = rateLimit(
        {
          bucket: "armor",
          limit: options.rateLimit.limit,
          windowSeconds: options.rateLimit.windowSeconds,
          key: options.rateLimit.key ?? "ip",
        },
        {
          onLimited: () => service.logBlockedRequest(workspace?.id || null, clientIp, path, "rate_limit", userAgent),
        },
      );
      return limiter(c, next);
    }

    await next();
  };
}
