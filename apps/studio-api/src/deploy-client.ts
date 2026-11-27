import { MockCloudflareControlPlane } from "../../../packages/deploy/src/target.ts";
import type { CloudflareApiClient } from "../../../packages/deploy/src/target.ts";
import { createHttpCloudflareApiClient } from "../../../packages/deploy/src/http-control-plane.ts";
import type { HttpCloudflareApiClient } from "../../../packages/deploy/src/http-control-plane.ts";
import type { RequestBudget } from "../../../packages/deploy/src/provisioner/cloudflare.ts";

// Which Cloudflare client Studio's deploy routes talk to (story R53 / 1.2).
//
// Production and every default: the HTTP client (createHttpCloudflareApiClient), over Cloudflare's REST API, with the token
// the vault decrypts (createStudioTokenResolver). A new client is made for each request or deploy, so its call log, counts and
// the tokens it holds live only as long as that request. The in-memory fake (MockCloudflareControlPlane) exists for tests only:
// it is reachable only with `PX_DEPLOY_CLIENT=fake` AND PX_ENVIRONMENT explicitly "test" or "development"; with PX_ENVIRONMENT
// unset or anything else, asking for the fake throws. scripts/lint-deploy-target.ts keeps every construction of the fake in this
// file, behind that check.

export interface StudioDeployClientEnv {
  PX_ENVIRONMENT?: string;
  /** "fake" (only with PX_ENVIRONMENT "test" or "development") or absent/"http". */
  PX_DEPLOY_CLIENT?: string;
}

/** The only environments in which the fake may be chosen. */
const FAKE_DEPLOY_CLIENT_ENVIRONMENTS: readonly string[] = ["test", "development"];

/** How Studio's real client reaches Cloudflare and builds what it uploads. Tests and the live proof script inject these. */
export interface StudioDeployOptions {
  /** How requests reach Cloudflare. Default: the global fetch. Tests pass a fake Cloudflare. */
  fetch?: (request: Request) => Promise<Response>;
  /** How the smoke check reaches a deployed workers.dev address. Default: the global fetch. */
  workerFetch?: (request: Request) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * How long the smoke check keeps trying, in milliseconds of waits: a first deploy on a new workers.dev address can take a
   * while to answer. Defaults: 120,000 for a first deploy, 20,000 for a redeploy.
   */
  smokeTimeoutMs?: { firstDeploy?: number; redeploy?: number };
  /** The request budget per account. Default: the process-wide one (1,100 requests per five minutes). */
  budgetFor?: (accountId: string) => RequestBudget;
  /**
   * Turns an assembled project into the one ES module that is uploaded (the gate, the GraphRunner Workflow and the signed
   * /__px routes around the project; see @poc/deploy bundleWorker). Bundling needs esbuild, so it runs where Studio runs in
   * Node (the live proof script). Without it the HTTP path refuses to deploy rather than upload unbundled TypeScript.
   */
  bundle?: (input: {
    project: string;
    envName: string;
    files: Record<string, string>;
  }) => Promise<{ code: string; sha256?: string; compatibilityFlags?: string[] }>;
  /** Test seam (story 1.19): runs after a deploy's approval gate, before Studio binds the secrets it generated. */
  beforeGeneratedSecretBind?: (input: { project: string; envName: string }) => Promise<void>;
}

export class StudioDeployClientConfigError extends Error {
  readonly code = "DEPLOY_CLIENT_MISCONFIGURED";
  constructor(message: string) {
    super(message);
    this.name = "StudioDeployClientConfigError";
  }
  /** Answered by Studio's error handler: 500 with the code and the configuration message, which names no secret. */
  getResponse(): Response {
    return Response.json({ error: { code: this.code, message: this.message } }, { status: 500 });
  }
}

/**
 * "fake" only when explicitly asked for AND PX_ENVIRONMENT is explicitly "test" or "development"; "http" otherwise. A fake
 * asked for anywhere else (production, preview, unset) is an error, never a silent fallback.
 */
export function studioDeployClientMode(env: StudioDeployClientEnv | undefined): "http" | "fake" {
  const requested = (env?.PX_DEPLOY_CLIENT ?? "").trim().toLowerCase();
  if (requested === "" || requested === "http") return "http";
  if (requested !== "fake") throw new StudioDeployClientConfigError(`PX_DEPLOY_CLIENT must be "http" or "fake", not "${requested}"`);
  const environment = (env?.PX_ENVIRONMENT ?? "").trim().toLowerCase();
  if (!isFakeEnvironment(environment)) {
    throw new StudioDeployClientConfigError(
      `PX_DEPLOY_CLIENT=fake is refused unless PX_ENVIRONMENT is "test" or "development" (it is ${environment ? `"${environment}"` : "unset"}): outside tests Studio deploys only through the real Cloudflare client, and is refused in production`,
    );
  }
  return "fake";
}

function isFakeEnvironment(environment: string): boolean {
  return FAKE_DEPLOY_CLIENT_ENVIRONMENTS.includes(environment);
}

const fakeControlPlanes = new Map<string, MockCloudflareControlPlane>();

/**
 * TEST-ONLY: the fake control plane for one account, for a test to inspect or tamper with. It carries the same runtime guard
 * as getStudioControlPlane: outside PX_DEPLOY_CLIENT=fake with PX_ENVIRONMENT test/development it throws.
 */
export function getStudioFakeControlPlane(accountId: string, env: StudioDeployClientEnv | undefined): MockCloudflareControlPlane {
  if (studioDeployClientMode(env) !== "fake")
    throw new StudioDeployClientConfigError("the fake control plane is for tests only (PX_DEPLOY_CLIENT=fake with PX_ENVIRONMENT test or development)");
  const key = accountId.toLowerCase();
  let cp = fakeControlPlanes.get(key);
  if (!cp) {
    cp = new MockCloudflareControlPlane();
    fakeControlPlanes.set(key, cp);
  }
  return cp;
}

export function resetStudioFakeControlPlanes(): void {
  fakeControlPlanes.clear();
}

/** A new real client for one request or deploy: nothing it records or holds outlives the caller. */
function httpControlPlane(deps: StudioDeployOptions | undefined): HttpCloudflareApiClient {
  return createHttpCloudflareApiClient({
    fetch: deps?.fetch ?? ((request) => fetch(request)),
    ...(deps?.sleep ? { sleep: deps.sleep } : {}),
    ...(deps?.now ? { now: deps.now } : {}),
    ...(deps?.budgetFor ? { budgetFor: deps.budgetFor } : {}),
  });
}

/** The control plane Studio's deploy routes use for an account: the HTTP client, or the fake in an explicit test mode. */
export function getStudioControlPlane(accountId: string, env?: StudioDeployClientEnv, deps?: StudioDeployOptions): CloudflareApiClient {
  if (studioDeployClientMode(env) === "fake") return getStudioFakeControlPlane(accountId, env);
  return httpControlPlane(deps);
}

/**
 * The client a token is verified with. Real: the HTTP client, which asks Cloudflare. Fake: a fresh fake with no registered
 * token, so the test-only spelling classifier answers (what every Studio test has relied on).
 */
export function getStudioVerificationClient(env?: StudioDeployClientEnv, deps?: StudioDeployOptions): CloudflareApiClient {
  if (studioDeployClientMode(env) === "fake") return new MockCloudflareControlPlane();
  return httpControlPlane(deps);
}

/** The fake, when Studio runs in fake mode; null for the real client. For the test-only simulation hooks. */
export function asFakeControlPlane(cp: CloudflareApiClient): MockCloudflareControlPlane | null {
  return cp instanceof MockCloudflareControlPlane ? cp : null;
}

const encoder = new TextEncoder();
/**
 * The access key a deployed Worker's gate checks (x-poc-key), derived from Studio's root secret per project and environment,
 * so a redeploy binds the same value (nothing changes) and the owner's tooling can derive it without Studio storing it.
 */
export async function deriveWorkerAccessKey(rootSecret: string, project: string, envName: string): Promise<string> {
  if (typeof rootSecret !== "string" || rootSecret.trim().length < 16) throw new Error("deriveWorkerAccessKey needs the root secret (16+ characters)");
  const key = await crypto.subtle.importKey("raw", encoder.encode(rootSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`worker-access-key:${project}:${envName}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
