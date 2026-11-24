import type { MiddlewareHandler } from "hono";
import type { D1Like, RequestContext } from "@poc/sdk";
import { DocumentPdfService } from "./document.ts";

export interface DocEnv {
  Bindings: { DB: D1Like };
  Variables: {
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
    documentService?: DocumentPdfService;
  };
}

export const documentMiddleware: MiddlewareHandler<DocEnv> = async (c, next) => {
  const service = new DocumentPdfService(c.env.DB);
  c.set("documentService", service);
  await next();
};
