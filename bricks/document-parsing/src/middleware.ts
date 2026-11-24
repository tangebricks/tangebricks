import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { DocumentParsingService } from "./parser.ts";

export interface DocumentEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string; name?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    parsingService?: DocumentParsingService;
  };
}

export const documentMiddleware: MiddlewareHandler<DocumentEnv> = async (c, next) => {
  const service = new DocumentParsingService(c.env.DB);
  c.set("parsingService", service);
  await next();
};
