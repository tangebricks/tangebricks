// Studio's API served over local HTTP (story R55), so a separate process (Claude Code, through its MCP client) can reach
// Studio's /mcp. The node:http -> app.fetch bridge is the one the e2e backend uses (apps/studio-web/e2e/global-setup.ts),
// without the WebSocket upgrade. It listens on the loopback address only, on a port the system picks.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface StudioHttpServer {
  /** http://127.0.0.1:<port> */
  origin: string;
  close(): Promise<void>;
}

function readNodeRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

function buildFetchHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }
  return headers;
}

export async function serveStudioOverHttp<E>(app: { fetch(request: Request, env: E): Response | Promise<Response> }, env: E): Promise<StudioHttpServer> {
  let origin = "";
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const bodyBuf = hasBody ? await readNodeRequestBody(req) : undefined;
      const fetchReq = new Request(`${origin}${req.url ?? "/"}`, {
        method,
        headers: buildFetchHeaders(req),
        body: bodyBuf && bodyBuf.length > 0 ? new Uint8Array(bodyBuf) : undefined,
      });
      const fetchRes = await app.fetch(fetchReq, env);
      res.statusCode = fetchRes.status;
      const setCookies = typeof fetchRes.headers.getSetCookie === "function" ? fetchRes.headers.getSetCookie() : [];
      if (setCookies.length > 0) res.setHeader("set-cookie", setCookies);
      fetchRes.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") return;
        res.setHeader(key, value);
      });
      res.end(Buffer.from(await fetchRes.arrayBuffer()));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Internal Server Error" } }));
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections?.();
        server.close(() => resolveClose());
      }),
  };
}
