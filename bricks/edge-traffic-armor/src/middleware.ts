import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
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

    // 2. Rate Limit Check
    if (options.rateLimit) {
      const key = workspace?.id ? `rl:${workspace.id}:${clientIp}` : `rl:${clientIp}`;
      const rl = await service.checkRateLimit(
        key,
        options.rateLimit.limit,
        options.rateLimit.windowSeconds
      );

      c.res.headers.set("RateLimit-Limit", String(rl.limit));
      c.res.headers.set("RateLimit-Remaining", String(rl.remaining));
      c.res.headers.set("RateLimit-Reset", String(rl.reset));

      if (!rl.allowed) {
        c.res.headers.set("Retry-After", String(rl.retryAfter));
        await service.logBlockedRequest(
          workspace?.id || null,
          clientIp,
          path,
          "rate_limit",
          userAgent
        );
        return c.json(
          { error: "Too many requests. Please slow down.", retryAfter: rl.retryAfter },
          429,
          {
            "RateLimit-Limit": String(rl.limit),
            "RateLimit-Remaining": "0",
            "RateLimit-Reset": String(rl.reset),
            "Retry-After": String(rl.retryAfter),
          }
        );
      }
    }

    await next();
  };
}
