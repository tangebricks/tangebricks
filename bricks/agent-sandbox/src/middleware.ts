import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { AgentSandboxService } from "./agent.ts";

export interface AgentEnv {
  Bindings: { DB: D1Like };
  Variables: {
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    agentSandbox?: AgentSandboxService;
  };
}

export const agentSandboxMiddleware: MiddlewareHandler<AgentEnv> = async (c, next) => {
  const service = new AgentSandboxService(c.env.DB);
  c.set("agentSandbox", service);
  await next();
};
