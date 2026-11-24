import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { ScriptingSandboxService } from "./sandbox.ts";
import { createScriptIsolate, type ScriptIsolate } from "./isolate.ts";

export interface ScriptEnv {
  Bindings: {
    DB: D1Like;
    SCRIPT_LOADER?: unknown;
    SCRIPT_DISPATCH?: unknown;
  };
  Variables: {
    user?: { uid: string; email?: string; name?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    sandboxService?: ScriptingSandboxService;
    scriptIsolate?: ScriptIsolate;
  };
}

export const sandboxMiddleware: MiddlewareHandler<ScriptEnv> = async (c, next) => {
  const isolate = createScriptIsolate(c.env);
  const service = new ScriptingSandboxService(c.env.DB, isolate);
  c.set("sandboxService", service);
  c.set("scriptIsolate", isolate);
  await next();
};
