import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { OutboundWebhookService } from "./outbound.ts";

export interface OutboundWebhookEnv {
  Bindings: { DB: D1Like };
  Variables: {
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    outboundWebhooks?: OutboundWebhookService;
  };
}

export const outboundWebhookMiddleware: MiddlewareHandler<OutboundWebhookEnv> = async (c, next) => {
  const service = new OutboundWebhookService(c.env.DB);
  c.set("outboundWebhooks", service);
  await next();
};
