import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PROPOSED-12 (threat model C4–C6): the production studio-web bundle must not ship the e2e test hooks, the fake
// `?benchmark=200` owner session, or the fake BYOC credentials. The hooks are gated on `import.meta.env.DEV`, which is
// a literal `false` in `vite build`, so they must be gone from the emitted files. This runs a real production build.

const studioWebDir = join(process.cwd(), "apps/studio-web");
const viteBin = join(studioWebDir, "node_modules/vite/bin/vite.js");

const FORBIDDEN_MARKERS = [
  "__STUDIO_STORE__",
  "__STUDIO_BOOTSTRAP__",
  "benchmark=200",
  "usr_bench",
  "cf_ut_valid_promote_byoc_token",
  "abcdef0123456789abcdef0123456789",
];

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

describe("studio-web production bundle has no test hooks or fake values (PROPOSED-12)", () => {
  let outDir: string;
  let emitted: { path: string; text: string }[];

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "studio-web-prod-build-"));
    execFileSync(
      process.execPath,
      [viteBin, "build", "--mode", "production", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"],
      { cwd: studioWebDir, stdio: "pipe", env: { ...process.env, NODE_ENV: "production" } },
    );
    emitted = listFiles(outDir)
      .filter((p) => /\.(js|mjs|html)$/.test(p))
      .map((path) => ({ path, text: readFileSync(path, "utf8") }));
  }, 240_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("emits at least one JS chunk", () => {
    expect(emitted.some((f) => f.path.endsWith(".js"))).toBe(true);
  });

  it.each(FORBIDDEN_MARKERS)("no emitted file contains %s", (marker) => {
    const hits = emitted.filter((f) => f.text.includes(marker)).map((f) => f.path);
    expect(hits).toEqual([]);
  });
});
