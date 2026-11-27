// The wrapper around the assembled project when it is deployed. It is deploy-time code: the assembler's output is
// not changed, this module is bundled around it (see bundle.ts).
//
// Why it exists: the assembled project's identity is a header-trusting stub (C8), so anyone who can reach a deployed
// copy could act as any user in any workspace. Until real authentication exists, every request must carry a per-deploy
// access key, and the project never sees a request that does not. The single exception is GET /demo, a static page that
// holds no data and no key.
//
// Runs in workerd. It imports nothing from Node.

export const KEY_HEADER = "x-poc-key";
export const DEMO_PATH = "/demo";
/** A key shorter than this is treated as "not configured", so a weak or empty value can never open the project. */
export const MIN_KEY_LENGTH = 16;

export interface Fetcher {
  fetch(request: Request, env: unknown, ctx: unknown): Response | Promise<Response>;
}
export interface GateEnv {
  /** The deploy's access key, bound as a secret. */
  POC_ACCESS_KEY?: unknown;
  [binding: string]: unknown;
}

const encoder = new TextEncoder();
const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

/** Compares two secrets by their SHA-256 digests, byte by byte without stopping early, so timing says nothing about how much matched. */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const DEMO_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // The page is one inline script that talks to its own origin and nothing else.
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** Routes the deploy adds beside the project's own. Called only after the access key has been checked; null means "not mine, give it to the project". */
export type ExtraRoutes = (request: Request, env: never) => Promise<Response | null>;

export function createGatedWorker(options: { app: Fetcher; demoHtml: string; extra?: ExtraRoutes }) {
  return {
    async fetch(request: Request, env: GateEnv, ctx: unknown): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === DEMO_PATH) return new Response(options.demoHtml, { status: 200, headers: DEMO_HEADERS });

      const expected = env.POC_ACCESS_KEY;
      // Fail closed: with no usable key configured, nobody gets in, including a caller who sends an empty one.
      if (typeof expected !== "string" || expected.length < MIN_KEY_LENGTH) return json(503, { error: "this deployment has no access key configured" });

      const given = request.headers.get(KEY_HEADER);
      if (given === null || !(await sameSecret(given, expected))) return json(401, { error: "unauthorized" });

      const extra = await options.extra?.(request, env as never);
      if (extra) return extra;
      return options.app.fetch(request, env, ctx);
    },
  };
}
