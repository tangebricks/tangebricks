import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { assemble } from "@poc/assembler";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import { codeLines, findDynamicEvaluation } from "@poc/harness";
import { catalog } from "../../assembler/catalog.generated.ts";
import { INVOICE_FLOW_BLUEPRINT } from "../../../test/support/blueprints.ts";
import { OUT_DIR, compareProject, writeProject } from "../../../test/support/emitted.ts";
import { WORKER_SIZE_LIMIT_BYTES, bundleWorker, describeBundle, sizeLimitReport, wrapDemoPage } from "../src/bundle.ts";
import type { WorkerBundle } from "../src/bundle.ts";
import { describeDifferences, runScriptedCheck, scriptedCheckPasses } from "../src/scripted-check.ts";

// Story 5.1: the assembled project becomes ONE script, and that script behaves as the project does behind an access key.
//
// The bundle is run the way it will be uploaded: as the text of an ES module, with a D1 binding and the access key as a
// secret binding, in a real workerd started by Miniflare. Nothing here imports the project's modules; only the bundle's
// text is given to the runtime.
const root = resolve(import.meta.dirname, "..", "..", "..");
const KEY = "deploy-test-key-0123456789abcdef";
const BINDINGS = { POC_ACCESS_KEY: KEY };

let files: Record<string, string>;
let projectDir: string;
let hashes: Record<string, string>;
let bundle: WorkerBundle;
let mf: Miniflare;

// Miniflare 5 takes a new shape of options; convertV4MiniflareOptions turns the familiar one (a module script, a D1 database,
// plain and secret bindings) into it. What is started is real workerd, given only the text of the bundle.
const start = (bindings: Record<string, string> = BINDINGS) =>
  new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.code, compatibilityDate: "2026-10-01", d1Databases: ["DB"], bindings }));
const sendTo = (target: Miniflare, headers: Record<string, string> = {}) => async (request: Request) => {
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  return (await target.dispatchFetch(request.url, { method: request.method, headers: { ...Object.fromEntries(request.headers), ...headers }, body } as never)) as unknown as Response;
};
const get = async (target: Miniflare, path: string, init: RequestInit = {}) => (await target.dispatchFetch(`http://deployed.invalid${path}`, init as never)) as unknown as Response;
const count = async (target: Miniflare, table: string) => ((await ((await target.getD1Database("DB")) as unknown as D1Like).prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1);

async function migrate(target: Miniflare) {
  const db = (await target.getD1Database("DB")) as unknown as D1Like;
  for (const path of Object.keys(files).filter((p) => p.startsWith("migrations/")).sort()) await applyMigration(db, files[path]!);
}

beforeAll(async () => {
  const assembled = assemble(INVOICE_FLOW_BLUEPRINT, catalog);
  if (!assembled.ok) throw new Error(assembled.errors.join("; "));
  files = assembled.files;
  projectDir = join(OUT_DIR, "deploy-test", "invoice-flow");
  hashes = await writeProject(projectDir, files);
  bundle = await bundleWorker({ projectDir });
  console.log(describeBundle(bundle));
  mf = start();
  await mf.ready;
  await migrate(mf);
});
afterAll(async () => {
  await mf?.dispose();
});

describe("the bundle is one self-contained module", () => {
  test("has no imports left but the runtime's own (cloudflare:workers, cloudflare:workflows), one default export and the one Workflow class", () => {
    const imports = bundle.code.split(/\r?\n/).filter((line) => /^\s*import\b/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/\bfrom "cloudflare:(workers|workflows)"/);
    // esbuild writes the exports as one statement, "export { Class, name as default }"
    expect(bundle.code.match(/^export \{[^}]*\bas default\b[^}]*\};?$/gm)).toHaveLength(1);
    expect(bundle.code.match(/^export /gm)).toHaveLength(1);
    expect(bundle.warnings).toEqual([]);
  });

  test("is built from the project's files and the bricks' source, a few dozen inputs and not thousands", () => {
    expect(bundle.inputs).toBeGreaterThan(15);
    expect(bundle.inputs).toBeLessThan(400);
  });

  test("fits Cloudflare's size limit with room to spare, and the size is printed", () => {
    expect(bundle.limit.within).toBe(true);
    expect(bundle.bytes).toBeGreaterThan(50_000);
    expect(bundle.bytes).toBeLessThan(WORKER_SIZE_LIMIT_BYTES / 20);
    expect(bundle.gzipBytes).toBeLessThan(bundle.bytes);
    expect(describeBundle(bundle)).toMatch(/KiB \(gzip .* KiB\) from \d+ files, [\d.]+% of the 64 MiB limit, sha256 [0-9a-f]{12}$/);
  });

  test("is byte-for-byte the same when built again, which the second deploy's 'nothing changed' depends on", async () => {
    const again = await bundleWorker({ projectDir });
    expect(again.sha256).toBe(bundle.sha256);
    expect(again.code).toBe(bundle.code);
  });

  test("bundling leaves the assembled project's files exactly as they were", async () => {
    const result = await compareProject(projectDir, hashes);
    expect(result.checked).toBe(Object.keys(files).length);
    expect(result).toMatchObject({ unchanged: true, changed: [], missing: [], extra: [] });
  });

  test("the key is not in the bundle, only the name of the binding that will hold it", () => {
    expect(bundle.code).not.toContain(KEY);
    expect(bundle.code).toContain("POC_ACCESS_KEY");
  });
});

describe("the access key, in a real workerd running the bundle", () => {
  const protectedPaths = ["/", "/api/wallet", "/api/invoices", "/api/workspaces", "/api/payments/create-order", "/demo/", "/demo.js", "/health"];

  test("without the key every path but GET /demo is refused, and nothing is created", async () => {
    for (const path of protectedPaths) {
      for (const method of ["GET", "POST"]) {
        const res = await get(mf, path, { method, headers: { "x-test-user": "alice", ...(method === "POST" ? { "content-type": "application/json" } : {}) }, ...(method === "POST" ? { body: JSON.stringify({ name: "Sneaky" }) } : {}) });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
    expect(await count(mf, "mw_workspaces")).toBe(0);
    expect(await count(mf, "ent_invoices")).toBe(0);
  });

  test.each([
    ["a wrong key", "not-the-key-not-the-key-not-the-key"],
    ["the right key with a character added", KEY + "x"],
    ["the start of the right key", KEY.slice(0, 20)],
    ["the right key in upper case", KEY.toUpperCase()],
  ])("%s is refused", async (_label, value) => {
    const res = await get(mf, "/api/wallet", { headers: { "x-poc-key": value, "x-test-user": "alice" } });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(KEY);
  });

  test("the demo page is served without a key and holds no data, no key and no script from elsewhere", async () => {
    const res = await get(mf, "/demo");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("content-security-policy")).toMatch(/connect-src 'self'/);
    const html = await res.text();
    expect(html).toMatch(/<main id="root">/);
    expect(html).toMatch(/<script>/);
    expect(html).not.toContain(KEY);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    // The libraries inside the page carry a few URLs as plain strings (React's error-message link, XML namespace names,
    // JSON Schema identifiers). None is fetched; the page's CSP allows connections only to its own origin. Any host that
    // is not on this list is new and must be looked at before it is added.
    const hosts = [...new Set([...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase()))].sort();
    expect(hosts).toEqual(["json-schema.org", "react.dev", "www.w3.org"]);
    expect(html).not.toMatch(/XMLHttpRequest|navigator\.sendBeacon|new WebSocket|new EventSource/);
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
    expect(html.length).toBeGreaterThan(50_000);
    expect(await count(mf, "mw_workspaces")).toBe(0);
  });

  test("with the key the project gives the same answers as the unbundled project does (the same fixed expectations)", async () => {
    const seen = await runScriptedCheck(sendTo(mf, { "x-poc-key": KEY }));
    expect(describeDifferences(seen)).toEqual([]);
    expect(scriptedCheckPasses(seen)).toBe(true);
    expect(await count(mf, "mw_workspaces")).toBe(2);
    expect(await count(mf, "ent_invoices")).toBe(1);
  });

  test("the scripted check fails against the same script when the key is missing, by every step but the demo", async () => {
    const fresh = start();
    await fresh.ready;
    try {
      await migrate(fresh);
      const seen = await runScriptedCheck(sendTo(fresh));
      expect(scriptedCheckPasses(seen)).toBe(false);
      expect(seen.every((o) => o.status === 401)).toBe(true);
      expect(await count(fresh, "mw_workspaces")).toBe(0);
    } finally {
      await fresh.dispose();
    }
  });

  test.each([
    ["no key binding", {}],
    ["an empty key", { POC_ACCESS_KEY: "" }],
    ["a key that is too short", { POC_ACCESS_KEY: "short" }],
  ])("a deployment with %s refuses every request but the page, even from a caller who sends the matching header", async (_label, bindings) => {
    const bare = start(bindings as Record<string, string>);
    await bare.ready;
    try {
      const sent = (bindings as { POC_ACCESS_KEY?: string }).POC_ACCESS_KEY ?? "";
      for (const headers of [{ "x-poc-key": sent }, { "x-poc-key": "" }, {}]) expect((await get(bare, "/api/wallet", { headers })).status).toBe(503);
      expect((await get(bare, "/demo")).status).toBe(200);
    } finally {
      await bare.dispose();
    }
  });
});

describe("what the bundler refuses", () => {
  test("the demo page's script cannot close its own tag early", () => {
    const html = wrapDemoPage('var a = "x</script><img src=x onerror=alert(1)>"; var b = "</SCRIPT >";');
    expect(html.match(/<\/script/gi)).toHaveLength(1); // only the real closing tag
    expect(html).toContain('<\\/script><img src=x onerror=alert(1)>');
    expect(html).toContain("<\\/script >"); // the upper-case form is written in lower case behind the backslash, which is still the same text to JavaScript
    expect(html).not.toMatch(/<\/SCRIPT/);
    expect(html.endsWith("</script></body></html>")).toBe(true);
  });

  test("the size report says when a bundle is over Cloudflare's limit and how much of it is used", () => {
    expect(sizeLimitReport(0)).toEqual({ bytes: WORKER_SIZE_LIMIT_BYTES, percentUsed: 0, within: true });
    expect(sizeLimitReport(WORKER_SIZE_LIMIT_BYTES)).toMatchObject({ percentUsed: 100, within: true });
    expect(sizeLimitReport(WORKER_SIZE_LIMIT_BYTES + 1)).toMatchObject({ within: false });
    expect(sizeLimitReport(WORKER_SIZE_LIMIT_BYTES / 2).percentUsed).toBe(50);
  });

  test("a project that imports a Node-only module fails to bundle, with the module named", async () => {
    const bad = join(OUT_DIR, "deploy-test", "node-import");
    await writeProject(bad, { "src/index.ts": 'import { readFileSync } from "node:fs";\nexport default { fetch: () => new Response(String(readFileSync)) };\n' });
    await expect(bundleWorker({ projectDir: bad, demoHtml: "<p>x</p>" })).rejects.toThrow(/node:fs/);
  });

  test("a folder that is not an assembled project is refused before any bundling", async () => {
    await expect(bundleWorker({ projectDir: join(OUT_DIR, "deploy-test", "does-not-exist") })).rejects.toThrow(/no src\/index\.ts: assemble the project first/);
  });
});

describe("the deploy package's own source", () => {
  const list = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((p) => /\.tsx?$/.test(p) && !p.includes("node_modules"))
      .map((p) => join(dir, p));
  const own = [...list(join(root, "packages", "deploy", "src")), ...list(join(root, "packages", "deploy", "client"))];
  const bricks = [...["credit-wallet", "multi-workspace", "dynamic-entities"].flatMap((p) => list(join(root, "bricks", p, "src"))), ...list(join(root, "packages", "sdk", "src"))];

  test("the files to scan were found", () => {
    expect(own.length).toBeGreaterThanOrEqual(5);
    expect(bricks.length).toBeGreaterThanOrEqual(8);
  });

  test("builds no code at run time (C2): no eval, no Function constructor, no computed import, in this package or in the bricks that go into the bundle", () => {
    const hits = [...own, ...bricks].flatMap((file) => findDynamicEvaluation(readFileSync(file, "utf8")).map((h) => `${file}:${h.line} ${h.rule}`));
    expect(hits).toEqual([]);
  });

  test("starts no other program and does not call wrangler (C3)", () => {
    const hits = own.flatMap((file) =>
      codeLines(readFileSync(file, "utf8"))
        .filter((l) => /child_process|\bspawn\w*\s*\(|\bexec\w*\s*\(|\bexeca\b|\bwrangler\b/.test(l.text))
        .map((l) => `${file}:${l.line} ${l.text.slice(0, 80)}`),
    );
    expect(hits).toEqual([]);
  });

  test("the client page has no network code of its own: it reaches the server only through the brick's client", () => {
    const page = readFileSync(join(root, "packages", "deploy", "client", "demo-entry.tsx"), "utf8");
    const code = codeLines(page).map((l) => l.text).join("\n");
    expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
    expect(code).toMatch(/createWalletClient/);
  });

  test("third-party code in the bundle may evaluate code (zod checks whether the runtime allows it); the list is printed, not hidden", () => {
    const rules = [...new Set(bundle.dynamicEvaluation.map((h) => h.rule))];
    console.log(`dynamic evaluation in the bundle (third-party code, not ours): ${bundle.dynamicEvaluation.length} lines, rules: ${rules.join(", ") || "none"}`);
    for (const hit of bundle.dynamicEvaluation.slice(0, 5)) console.log(`  line ${hit.line} (${hit.where}): ${hit.text.slice(0, 80)}`);
    expect(Array.isArray(bundle.dynamicEvaluation)).toBe(true);
  });
});
