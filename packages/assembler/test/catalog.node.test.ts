import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { buildCatalog, renderCatalogSource } from "../../../scripts/build-catalog.ts";
import { BRICK_CATEGORIES } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";

const root = resolve(import.meta.dirname, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const brickDirs = readdirSync(join(root, "bricks")).filter((name) => {
  try {
    readFileSync(join(root, "bricks", name, "brick.manifest.json"));
    return true;
  } catch {
    return false;
  }
});

describe("the committed catalog", () => {
  test("is exactly what the bricks' manifests and migrations produce now (run `pnpm catalog:build` when this fails)", () => {
    expect(read("packages", "assembler", "catalog.generated.ts").replace(/\r\n/g, "\n")).toBe(renderCatalogSource(buildCatalog(root)));
  });

  test("holds every brick that has a manifest, and nothing else", () => {
    expect(Object.keys(catalog.bricks).sort()).toEqual(brickDirs.sort());
    expect(brickDirs.length).toBe(43);
  });

  test("every brick entry has a non-empty ui.summary, ui.category, and ui.displayName, and standardize-bricks.ts is removed", () => {
    for (const [id, { manifest }] of Object.entries(catalog.bricks)) {
      expect(manifest.ui, `${id} should define ui`).toBeDefined();
      expect(manifest.ui?.displayName.trim().length, `${id} ui.displayName`).toBeGreaterThan(0);
      expect(manifest.ui?.summary.trim().length, `${id} ui.summary`).toBeGreaterThan(0);
      expect(manifest.ui?.summary.length, `${id} ui.summary <= 140`).toBeLessThanOrEqual(140);
      expect(BRICK_CATEGORIES, `${id} ui.category`).toContain(manifest.ui?.category);
    }
    expect(existsSync(join(root, "scripts", "standardize-bricks.ts"))).toBe(false);
  });
});

describe("each manifest tells the truth about its package", () => {
  test.each(brickDirs)("%s", async (dir) => {
    const { manifest, files } = Object.values(catalog.bricks).find((b) => b.manifest.worker.package.endsWith(`/${dir}`))!;
    const pkg = JSON.parse(read("bricks", dir, "package.json")) as { name: string; dependencies?: Record<string, string> };

    // the package name is the real one, and every export the manifest uses is a function the package really exports
    expect(manifest.worker.package).toBe(pkg.name);
    const module = (await import(/* @vite-ignore */ pathToFileURL(join(root, "bricks", dir, "src", "index.ts")).href)) as Record<string, unknown>;
    const used = new Set<string>();
    if (manifest.worker.guard) used.add(manifest.worker.guard.export);
    for (const route of manifest.worker.routes) {
      used.add(route.factory);
      for (const value of Object.values(route.options)) if (typeof value === "object" && "$call" in value) used.add(value.$call);
    }
    for (const sched of manifest.triggers?.schedules ?? []) used.add(sched.handler);
    for (const q of manifest.triggers?.queues ?? []) used.add(q.handler);
    for (const node of manifest.nodes ?? []) used.add(node.executor);
    for (const name of used) expect(typeof module[name], `${pkg.name} should export ${name}`).toBe("function");

    // the third-party versions it asks for are the ones the package is built and tested with
    for (const [name, version] of Object.entries(manifest.npmDependencies)) expect(pkg.dependencies?.[name], `${name} in ${dir}/package.json`).toBe(version);

    // every migration in the brick's folder is listed, and every listed one exists with the catalog's text (a brick may have none)
    const migrationsDir = join(root, "bricks", dir, "migrations");
    const onDisk = existsSync(migrationsDir)
      ? readdirSync(migrationsDir)
          .filter((f) => f.endsWith(".sql"))
          .map((f) => `migrations/${f}`)
          .sort()
      : [];
    expect([...manifest.migrations].sort()).toEqual(onDisk);
    for (const file of manifest.migrations) expect(files[file]).toBe(read("bricks", dir, file).replace(/\r\n/g, "\n"));
  });

  test("a manifest's settings are all used by a route option, and every route option setting is defined", () => {
    for (const { manifest } of Object.values(catalog.bricks)) {
      if (manifest.worker.routes.length === 0) {
        expect(manifest.worker.guard, `${manifest.id} has no routes so must define a worker.guard`).toBeDefined();
        continue;
      }
      const referenced = new Set<string>();
      for (const route of manifest.worker.routes)
        for (const value of Object.values(route.options)) if (typeof value === "object" && "$setting" in value) referenced.add(value.$setting);
      expect([...referenced].sort(), manifest.id).toEqual(Object.keys(manifest.settings).sort());
    }
  });
});

describe("the assembler knows no brick", () => {
  const sourceDir = join(root, "packages", "assembler", "src");
  const sources = readdirSync(sourceDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, text: readFileSync(join(sourceDir, f), "utf8") }));

  // Everything a brick could be called: its id, its package, and every function the emitted code imports from it.
  const names = new Set<string>();
  for (const { manifest } of Object.values(catalog.bricks)) {
    names.add(manifest.id);
    names.add(manifest.worker.package);
    if (manifest.worker.guard) names.add(manifest.worker.guard.export);
    for (const route of manifest.worker.routes) {
      names.add(route.factory);
      for (const value of Object.values(route.options)) if (typeof value === "object" && "$call" in value) names.add(value.$call);
    }
    for (const sched of manifest.triggers?.schedules ?? []) names.add(sched.handler);
    for (const q of manifest.triggers?.queues ?? []) names.add(q.handler);
    for (const capability of [...manifest.provides, ...manifest.requires]) names.add(capability);
    for (const setting of Object.keys(manifest.settings)) names.add(setting);
  }

  test("the scan has something to look for, and something to look in", () => {
    expect(names.size).toBeGreaterThan(10);
    expect(names.has("credit-wallet")).toBe(true);
    expect(names.has("createWalletRoutes")).toBe(true);
    expect(sources.map((s) => s.file).sort()).toEqual([
      "assemble.ts",
      "hash.ts",
      "identity-stub.ts",
      "index.ts",
      "integration-fidelity-codes.ts",
      "openapi-sample.ts",
      "openapi.ts",
      "schedules.ts",
      "schemas.ts",
      "semver.ts",
      "tail-worker.ts",
    ]);
  });

  test("no brick id, package, export, capability or setting name appears in the assembler's source", () => {
    const found = sources.flatMap(({ file, text }) => [...names].filter((name) => text.includes(name)).map((name) => `${file}: ${name}`));
    expect(found).toEqual([]);
  });

  test("the assembler imports no package of this repository and no Node module", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\bfrom\s+["']@poc\/(?!sdk["']|telemetry["'])|\bimport\(\s*["']@poc\//);
      expect(text, file).not.toMatch(/from\s+["']node:|require\(/);
    }
  });
});
