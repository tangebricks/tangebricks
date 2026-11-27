// Node-side checks shared by tests and by scripts/verify.ts, so a rule has one definition.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { catalog } from "../../packages/assembler/catalog.generated.ts";
import type { AssembleResult } from "../../packages/assembler/src/index.ts";

const defaultRoot = resolve(import.meta.dirname, "..", "..");

export interface NameScan {
  /** Each brick-specific name found in the assembler's source, as "file: name". */
  found: string[];
  namesChecked: number;
  filesScanned: number;
}

/**
 * Looks for anything that names a particular brick (its id, package, exports, capabilities, settings) in the assembler's
 * source. The assembler must learn what a brick is from its manifest and nowhere else; a hit means it was hard-wired.
 */
export function scanAssemblerForBrickNames(repoRoot = defaultRoot): NameScan {
  const names = new Set<string>();
  for (const { manifest } of Object.values(catalog.bricks)) {
    names.add(manifest.id);
    names.add(manifest.worker.package);
    if (manifest.worker.guard) names.add(manifest.worker.guard.export);
    for (const route of manifest.worker.routes) {
      names.add(route.factory);
      for (const value of Object.values(route.options)) if (typeof value === "object" && "$call" in value) names.add(value.$call);
    }
    for (const capability of [...manifest.provides, ...manifest.requires]) names.add(capability);
    for (const setting of Object.keys(manifest.settings)) names.add(setting);
  }
  const dir = join(repoRoot, "packages", "assembler", "src");
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));
  const found = sources.flatMap(({ file, text }) => [...names].filter((name) => text.includes(name)).map((name) => `${file}: ${name}`));
  return { found, namesChecked: names.size, filesScanned: sources.length };
}

export interface RepoOwnedCheck {
  ok: boolean;
  problems: string[];
}

const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_CODE = /\b(describe|it|test)\s*\(|\bexpect\s*\(|from\s+["']vitest["']/;

/**
 * The denial tests must be written and owned by this repository, not produced by the assembler: an assembler that
 * writes its own tests could write ones that pass. So the assembled project may hold no test file and no test code,
 * and the repo's own denial test file must exist.
 */
export function checkDenialTestsRepoOwned(emittedFiles: Record<string, string>, denialTestFile: string, repoRoot = defaultRoot): RepoOwnedCheck {
  const problems: string[] = [];
  for (const [path, text] of Object.entries(emittedFiles)) {
    if (TEST_PATH.test(path)) problems.push(`the assembled project contains a test file: ${path}`);
    else if (TEST_CODE.test(text)) problems.push(`the assembled project's ${path} contains test code`);
  }
  if (!existsSync(join(repoRoot, denialTestFile))) problems.push(`the repo's denial test file is missing: ${denialTestFile}`);
  return { ok: problems.length === 0, problems };
}

export interface EntityNameScan {
  ok: boolean;
  /** Each place a declared entity's or field's name appears in code, as "where: name". */
  found: string[];
  namesChecked: number;
  filesScanned: number;
}

interface DeclaredEntity {
  name: string;
  fields: ReadonlyArray<{ name: string }>;
}

/**
 * A declared entity is data, never code. This looks for the entity's name, and for the names of its fields that are
 * distinctive enough to search for (those with an underscore: an everyday word like "status" appears in unrelated code),
 * in everything that runs: the assembler, the shared contract, the router, and every emitted source file. The one place
 * allowed to name an entity is the entry file's own guard lines (`app.use("/api/<name>", ...)`), because they are the
 * assembler's wiring written from the declaration; the declaration itself lives in entities.json and the table in a migration.
 */
export function scanForEntityNames(entities: ReadonlyArray<DeclaredEntity>, assembled: AssembleResult, repoRoot = defaultRoot): EntityNameScan {
  const names = new Set<string>();
  for (const entity of entities) {
    names.add(entity.name);
    for (const field of entity.fields) if (field.name.includes("_")) names.add(field.name);
  }
  const sourceFiles = [
    ...listTs(join(repoRoot, "packages", "assembler", "src")),
    ...listTs(join(repoRoot, "bricks", "dynamic-entities", "src")),
    join(repoRoot, "packages", "sdk", "src", "entities.ts"),
  ];
  const found: string[] = [];
  for (const file of sourceFiles) {
    const text = readFileSync(file, "utf8");
    for (const name of names) if (text.includes(name)) found.push(`${file.slice(repoRoot.length + 1).replaceAll("\\", "/")}: ${name}`);
  }
  let emittedScanned = 0;
  if (assembled.ok) {
    for (const [path, text] of Object.entries(assembled.files)) {
      if (!/\.[cm]?[jt]s$/.test(path)) continue; // migrations, entities.json, package.json and project.json are data
      emittedScanned += 1;
      if (path === "src/index.ts") {
        // only the guard lines and the readiness manifest's migration file names, which the assembler writes from the declaration, may name an entity
        const withoutGuards = text
          .split("\n")
          .filter((line) => !/^app\.use\("\/api\/[a-z0-9_]+(\/\*)?", \w+\);$/.test(line))
          // the readiness manifest (UC8.4) lists migration file names, which are data: "0003_entity__<name>.sql"
          .filter((line) => !/^\s+"name": "\d{4}_[A-Za-z0-9_.-]+\.sql",$/.test(line))
          .join("\n");
        for (const name of names) if (withoutGuards.includes(name)) found.push(`emitted ${path}: ${name}`);
      } else if (path === "src/privacy.generated.ts") {
        // the privacy table list (UC9.2) is data written from the declaration: only its `"table": "ent_<name>",` lines may name an entity
        const withoutTables = text
          .split("\n")
          .filter((line) => !/^\s+"table": "ent_[A-Za-z0-9_]+",$/.test(line))
          .join("\n");
        for (const name of names) if (withoutTables.includes(name)) found.push(`emitted ${path}: ${name}`);
      } else {
        for (const name of names) if (text.includes(name)) found.push(`emitted ${path}: ${name}`);
      }
    }
  } else {
    found.push("the blueprint did not assemble");
  }
  const filesScanned = sourceFiles.length + emittedScanned;
  return { ok: found.length === 0 && names.size >= 2 && sourceFiles.length >= 5 && emittedScanned >= 2, found, namesChecked: names.size, filesScanned };
}

function listTs(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}
