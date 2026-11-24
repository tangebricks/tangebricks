import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { findDynamicEvaluation } from "@poc/harness";
import { STARTUP_LIMIT_MS, WORKER_SIZE_LIMIT_BYTES } from "@poc/sdk";
import { WORKFLOW_CLASS } from "./worker/graph-run.ts";

export { STARTUP_LIMIT_MS, WORKER_SIZE_LIMIT_BYTES };

// Turns an assembled project into the one script that gets uploaded.
//
// The assembler's output is not touched. This step bundles it with esbuild into a single ES module and wraps it with
// the access-key gate and the demo page (src/worker/gate.ts, client/demo-entry.tsx). It is Node-side code and is part of
// the deploy clock (H10): it runs before the upload.

const repoRoot =
  typeof import.meta.dirname === "string"
    ? resolve(import.meta.dirname, "..", "..", "..")
    : ".";
const slash = (path: string) => path.replace(/\\/g, "/");

export interface WorkerBundle {
  /** The ES module to upload. */
  code: string;
  bytes: number;
  gzipBytes: number;
  sha256: string;
  /** How many source files went into it. */
  inputs: number;
  /** Messages from the bundler that were warnings (errors throw). */
  warnings: string[];
  /** Places in the bundle where dynamic evaluation appears, with whose file it came from where esbuild could say. Informational: see the note in the tests. */
  dynamicEvaluation: Array<{ rule: string; line: number; where: "in the Worker bundle" | "inside the demo page's own script"; text: string }>;
  limit: { bytes: number; percentUsed: number; within: boolean };
}

/** Wraps the page's script in one HTML document. A `</script` inside the script would end the tag early and let the rest run as page markup, so it is written as `<\/script`, which JavaScript reads as the same text. */
export function wrapDemoPage(script: string): string {
  const safe = script.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ProjectX proof: credit balance</title></head><body><main id="root">Loading…</main><script>${safe}</script></body></html>`;
}

/** Where a bundle of this size stands against Cloudflare's limit. */
export function sizeLimitReport(bytes: number): WorkerBundle["limit"] {
  return { bytes: WORKER_SIZE_LIMIT_BYTES, percentUsed: Math.round((bytes / WORKER_SIZE_LIMIT_BYTES) * 10000) / 100, within: bytes <= WORKER_SIZE_LIMIT_BYTES };
}

/** The demo page: one HTML document with the credit widget's script inline. It holds no data and no key. */
export async function buildDemoPage(): Promise<string> {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [join(repoRoot, "packages", "deploy", "client", "demo-entry.tsx")],
    tsconfig: join(repoRoot, "packages", "deploy", "client", "tsconfig.json"),
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    logLevel: "silent",
  });
  return wrapDemoPage(result.outputFiles[0]!.text);
}

/**
 * Bundles the project in `projectDir` (a folder the assembler wrote, with src/index.ts) behind the gate. Resolves every
 * import itself, so the result has none left except `cloudflare:*`, which the Workers runtime provides. A Node-only
 * import in the project makes the build fail here rather than at the upload.
 */
export async function bundleWorker(options: { projectDir: string; demoHtml?: string }): Promise<WorkerBundle> {
  const { build } = await import("esbuild");
  const projectDir = resolve(options.projectDir);
  if (!existsSync(join(projectDir, "src", "index.ts"))) throw new Error(`${projectDir} has no src/index.ts: assemble the project first`);
  const demoHtml = options.demoHtml ?? (await buildDemoPage());
  const gate = slash(join(repoRoot, "packages", "deploy", "src", "worker", "gate.ts"));
  const worker = (file: string) => JSON.stringify(slash(join(repoRoot, "packages", "deploy", "src", "worker", file)));
  // The Workflow class has to be a top-level export of the script under the name the upload's binding gives, so it is declared here.
  const entry = [
    `import app from "./src/index.ts";`,
    `import { createGatedWorker } from ${JSON.stringify(gate)};`,
    `import { createGraphRunner } from ${worker("graph-workflow.ts")};`,
    `import { createProofRoutes } from ${worker("proof-routes.ts")};`,
    `import { proofExecutors, proofRegistry } from ${worker("proof-bricks.ts")};`,
    `export class ${WORKFLOW_CLASS} extends createGraphRunner({ registry: proofRegistry, executors: proofExecutors }) {}`,
    `export default createGatedWorker({ app, demoHtml: ${JSON.stringify(demoHtml)}, extra: createProofRoutes() });`,
  ].join("\n");

  const result = await build({
    stdin: { contents: entry, resolveDir: projectDir, sourcefile: "deploy-entry.ts", loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*"],
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
  });

  const code = result.outputFiles[0]!.text;
  const bytes = Buffer.byteLength(code, "utf8");
  return {
    code,
    bytes,
    gzipBytes: gzipSync(code).length,
    sha256: createHash("sha256").update(code).digest("hex"),
    inputs: Object.keys(result.metafile!.inputs).length,
    warnings: result.warnings.map((w) => w.text),
    dynamicEvaluation: findDynamicEvaluation(code).map((hit) => ({
      rule: hit.rule,
      line: hit.line,
      // the demo page is one long string on a single line of the bundle; a match there is in browser code, not Worker code
      where: hit.text.includes("demoHtml:") ? ("inside the demo page's own script" as const) : ("in the Worker bundle" as const),
      text: hit.text.slice(0, 100),
    })),
    limit: sizeLimitReport(bytes),
  };
}

export function describeBundle(bundle: WorkerBundle): string {
  const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
  return `worker bundle: ${kib(bundle.bytes)} (gzip ${kib(bundle.gzipBytes)}) from ${bundle.inputs} files, ${bundle.limit.percentUsed}% of the ${bundle.limit.bytes / 1024 / 1024} MiB limit, sha256 ${bundle.sha256.slice(0, 12)}`;
}
