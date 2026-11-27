import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const repoRoot = process.cwd();
const requireDeploy = createRequire(join(repoRoot, "packages/deploy/package.json"));
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(requireDeploy.resolve("miniflare")).href);
const { build } = await import(pathToFileURL(requireDeploy.resolve("esbuild")).href);

describe("Production eval constraint confirmation (R) - UC6.6 Task 1", () => {
  let mf: any;

  beforeAll(async () => {
    const entryPath = join(repoRoot, "bricks/scripting-sandbox/src/routes.ts");
    const bundled = await build({
      stdin: {
        contents: `
          import { Hono } from "hono";
          import { createScriptingRoutes } from "${entryPath.replace(/\\/g, "/")}";
          const app = new Hono();
          app.route("/api", createScriptingRoutes());
          export default app;
        `,
        resolveDir: join(repoRoot, "bricks/scripting-sandbox"),
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      write: false,
    });

    const script = bundled.outputFiles[0].text;
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script,
        compatibilityDate: "2026-10-01",
        d1Databases: ["DB"],
      }),
    );
  });

  afterAll(async () => {
    await mf?.dispose();
  });

  it("verifies that without isolation binding configured, execution fails closed with SCRIPT_ISOLATION_UNAVAILABLE (AC4)", async () => {
    const res = await mf.dispatchFetch("http://localhost/api/scripts/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceCode: "function main() { return 42; }" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("error");
    expect(body.errorMessage).toBe("SCRIPT_ISOLATION_UNAVAILABLE");
  });
});
