import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { MeteringService } from "./metering.ts";

export interface MeterEnv {
  Bindings: { DB: D1Like; PX_PLATFORM_OPERATORS?: string };
  Variables: {
    user?: { uid?: string; id?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    metering?: MeteringService;
  };
}

export const meteringMiddleware: MiddlewareHandler<MeterEnv> = async (c, next) => {
  const service = new MeteringService(c.env.DB);
  c.set("metering", service);
  await next();
};

/**
 * Route decorator / middleware that increments a meter counter whenever a route returns 2xx.
 */
export function meterRoute(meterKey: string, value: number = 1.0): MiddlewareHandler<MeterEnv> {
  return async (c, next) => {
    await next();

    // After response generated, if 2xx and workspace is present, record event
    if (c.res.status >= 200 && c.res.status < 300) {
      const workspace = c.get("workspace");
      if (workspace?.id) {
        const service = c.get("metering") || new MeteringService(c.env.DB);
        try {
          await service.ingestEvent({
            workspaceId: workspace.id,
            meterKey,
            value,
          });
        } catch {
          // Metering failure should not bring down the main user response
        }
      }
    }
  };
}
