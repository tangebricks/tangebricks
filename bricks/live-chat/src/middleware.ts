import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { LiveChatService } from "./chat.ts";

export interface ChatEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string; name?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    chatService?: LiveChatService;
  };
}

export const chatMiddleware: MiddlewareHandler<ChatEnv> = async (c, next) => {
  const service = new LiveChatService(c.env.DB);
  c.set("chatService", service);
  await next();
};
