// Every brick's code is typechecked. The root tsconfig.json must include each bricks/<name>/src and bricks/<name>/test,
// and each bricks/<name>/client (which has its own tsconfig) must be a project the `typecheck` script runs. A brick
// directory that neither covers is named in the failure, so a new brick cannot slip out of `pnpm typecheck`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..");

/** The directories inside one brick that hold TypeScript, by kind. */
interface BrickDirs {
  readonly brick: string;
  readonly dirs: ReadonlyArray<"src" | "test" | "client">;
}

/** Turns a tsconfig include entry into a test for a directory path: the entry itself or anything under it. */
function includeMatcher(pattern: string): RegExp {
  const body = pattern
    .replace(/\/+$/, "")
    .split("/")
    .map((part) => (part === "**" ? ".*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
    .join("/");
  return new RegExp(`^${body}(/.*)?$`);
}

/** The typecheck script's `-p <dir>` projects, normalised to forward slashes without a trailing slash. */
function typecheckProjects(script: string): Set<string> {
  const projects = new Set<string>();
  for (const match of script.matchAll(/(?:^|\s)(?:-p|--project)\s+(\S+)/g)) {
    const dir = match[1];
    if (dir !== undefined) {
      projects.add(
        dir
          .replace(/\\/g, "/")
          .replace(/^\.\//, "")
          .replace(/\/tsconfig(\.[^/]*)?\.json$/, "")
          .replace(/\/+$/, ""),
      );
    }
  }
  return projects;
}

/**
 * Returns the brick directories (as `bricks/<name>/<dir>`) that `pnpm typecheck` does not cover: src and test must be
 * matched by the root include; client must be a project of the typecheck script.
 */
function uncoveredBrickDirs(bricks: readonly BrickDirs[], include: readonly string[], typecheckScript: string, exclude: readonly string[] = []): string[] {
  const matchers = include.map(includeMatcher);
  const excluded = exclude.map(includeMatcher);
  const projects = typecheckProjects(typecheckScript);
  const missing: string[] = [];
  for (const { brick, dirs } of bricks) {
    for (const dir of dirs) {
      const path = `bricks/${brick}/${dir}`;
      const covered = dir === "client" ? projects.has(path) : matchers.some((m) => m.test(path)) && !excluded.some((m) => m.test(path));
      if (!covered) missing.push(path);
    }
  }
  return missing;
}

/** Reads bricks/ on disk: every brick directory with a src, test or client folder. */
function bricksOnDisk(): BrickDirs[] {
  const bricksDir = join(repoRoot, "bricks");
  return readdirSync(bricksDir)
    .filter((name) => statSync(join(bricksDir, name)).isDirectory())
    .map((brick) => ({
      brick,
      dirs: (["src", "test", "client"] as const).filter((dir) => existsSync(join(bricksDir, brick, dir))),
    }))
    .filter(({ dirs }) => dirs.length > 0);
}

function rootInclude(): string[] {
  const tsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as { include?: unknown };
  if (!Array.isArray(tsconfig.include) || !tsconfig.include.every((entry) => typeof entry === "string")) {
    throw new Error("tsconfig.json has no include list of strings");
  }
  return tsconfig.include;
}

function rootExclude(): string[] {
  const tsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as { exclude?: unknown };
  if (tsconfig.exclude === undefined) return [];
  if (!Array.isArray(tsconfig.exclude) || !tsconfig.exclude.every((entry) => typeof entry === "string")) {
    throw new Error("tsconfig.json exclude is not a list of strings");
  }
  return tsconfig.exclude;
}

function typecheckScript(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
  const script = pkg.scripts?.["typecheck"];
  if (typeof script !== "string") throw new Error("package.json has no typecheck script");
  return script;
}

function compilerOptions(): Record<string, unknown> {
  const tsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as { compilerOptions?: Record<string, unknown> };
  return tsconfig.compilerOptions ?? {};
}

describe("typecheck coverage: every brick is typechecked", () => {
  it("COVERED: every bricks/*/src, bricks/*/test and bricks/*/client on disk is covered by `pnpm typecheck`", () => {
    const bricks = bricksOnDisk();
    expect(bricks.length).toBeGreaterThan(0);
    expect(uncoveredBrickDirs(bricks, rootInclude(), typecheckScript(), rootExclude())).toEqual([]);
  });

  it("GLOBS: the root include uses bricks/*/src and bricks/*/test, so a new brick is covered without an edit", () => {
    expect(rootInclude()).toEqual(expect.arrayContaining(["bricks/*/src", "bricks/*/test"]));
  });

  it("STRICT: the root project keeps its strict options and adds noImplicitOverride and noFallthroughCasesInSwitch", () => {
    expect(compilerOptions()).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      erasableSyntaxOnly: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
    });
  });

  it("MISSING_NAMED: a brick directory left out of the include or the typecheck script is named", () => {
    const bricks: BrickDirs[] = [
      { brick: "alpha", dirs: ["src", "test"] },
      { brick: "beta", dirs: ["src", "client"] },
    ];
    const include = ["bricks/alpha/src", "bricks/beta/src"];
    expect(uncoveredBrickDirs(bricks, include, "tsc --noEmit")).toEqual(["bricks/alpha/test", "bricks/beta/client"]);
    expect(uncoveredBrickDirs(bricks, ["bricks/*/src", "bricks/*/test"], "tsc --noEmit && tsc --noEmit -p bricks/beta/client")).toEqual([]);
  });

  it("EXCLUDED: a brick directory the root tsconfig excludes counts as not covered", () => {
    const bricks: BrickDirs[] = [{ brick: "alpha", dirs: ["src", "test"] }];
    expect(uncoveredBrickDirs(bricks, ["bricks/*/src", "bricks/*/test"], "", ["bricks/alpha/src"])).toEqual(["bricks/alpha/src"]);
  });

  it("PROJECT_SPELLINGS: -p ./dir, -p dir/ and -p dir/tsconfig.json count as the same client project", () => {
    const bricks: BrickDirs[] = [{ brick: "beta", dirs: ["client"] }];
    for (const p of ["./bricks/beta/client", "bricks/beta/client/", "bricks/beta/client/tsconfig.json"]) {
      expect(uncoveredBrickDirs(bricks, [], `tsc --noEmit -p ${p}`)).toEqual([]);
    }
  });

  it("MATCHING: include entries match a directory exactly, by a single-segment *, by **, or as a parent folder", () => {
    const one = (path: string, include: string[]) => uncoveredBrickDirs([{ brick: path, dirs: ["src"] }], include, "");
    expect(one("x", ["bricks/*/src"])).toEqual([]);
    expect(one("x", ["bricks"])).toEqual([]);
    expect(one("x", ["bricks/**"])).toEqual([]);
    expect(one("x", ["bricks/x/src/"])).toEqual([]);
    expect(one("x", ["bricks/*/test", "bricks/y/src", "bricks/xsrc"])).toEqual(["bricks/x/src"]);
  });
});
