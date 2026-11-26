// Breaks the assembler or the setup step on purpose, one way at a time, and prints what the full suite and the scoreboard
// say each time. Used while building story 4.2: the emitted project must run, and a project that does not run, or that
// changed after assembly, must be noticed. Always restores what it touched.
// Usage: node scripts/mutate-emitted.ts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);

function runAll(): string {
  const run = spawnSync(process.execPath, [join(root, "scripts", "verify.ts")], { cwd: root, encoding: "utf8" });
  const out = stripVTControlCharacters(run.stdout + run.stderr);
  const tests = out.split(/\r?\n/).find((l) => l.startsWith("Tests:"))?.replace(/\. Verdicts.*/, "") ?? "Tests: (no summary)";
  const project = out.split(/\r?\n/).find((l) => l.startsWith("Assembled project"))?.replace("Assembled project two-brick: ", "project ") ?? "project (no line)";
  const first = [...out.matchAll(/^ FAIL .*? > (.*)$/gm)].map((m) => m[1]!.slice(0, 70))[0];
  return `exit ${run.status} | ${tests} | ${project}${first ? " | first: " + first : ""}`;
}

const ASM = "packages/assembler/src/assemble.ts";
const GS = "test/support/global-setup.ts";
const cases: Array<{ name: string; file: string; from: string; to: string }> = [
  { name: "the guard is never mounted in the project", file: ASM, from: "for (const path of route.guardPaths) body.push(`app.use(${JSON.stringify(path)}, ${guard.export});`);", to: "" },
  { name: "the identity stub is not mounted", file: ASM, from: '`app.use(${JSON.stringify(API_PREFIX + "/*")}, stubIdentity);`,', to: '"",' },
  { name: "a brick's routes are not mounted", file: ASM, from: "body.push(`app.route(${JSON.stringify(route.mountAt)}, ${route.factory}(${options.length > 0 ? `{ ${options.join(\", \")} }` : \"\"}));`);", to: "" },
  { name: "the wallet is mounted at the wrong path", file: ASM, from: "body.push(`app.route(${JSON.stringify(route.mountAt)}, ", to: "body.push(`app.route(${JSON.stringify(route.mountAt + \"/v1\")}, " },
  { name: "migrations are numbered in reverse", file: ASM, from: "const name = `migrations/${String(counter).padStart(4, \"0\")}_${brick.id}__${path.split(\"/\").pop()}`;", to: "const name = `migrations/${String(1000 - counter).padStart(4, \"0\")}_${brick.id}__${path.split(\"/\").pop()}`;" },
  { name: "a migration is left out of the project", file: ASM, from: "files[name] = ensureTrailingNewline(text);", to: "if (counter === 1) files[name] = ensureTrailingNewline(text);" },
  { name: "the wallet's settings are not written into the entry", file: ASM, from: "if (typeof value === \"object\" && \"$call\" in value) use(brick.manifest.worker.package, value.$call);\n        return `${name}: ${expression(value, brick.settings)}`;", to: "if (typeof value === \"object\" && \"$call\" in value) use(brick.manifest.worker.package, value.$call);\n        return `${name}: ${expression(value, {})}`;" },
  { name: "the setup step writes a different project from the test's blueprint", file: GS, from: "const result = assemble(TWO_BRICK_BLUEPRINT, catalog);", to: "const result = assemble({ ...TWO_BRICK_BLUEPRINT, bricks: ['multi-workspace'] }, catalog);" },
  { name: "the setup step does not record the hashes it wrote", file: GS, from: "writeFileSync(hashesPath(project), JSON.stringify(hashes, null, 2) + \"\\n\");", to: "writeFileSync(hashesPath(project), JSON.stringify({}, null, 2) + \"\\n\");" },
  { name: "the post-run check is skipped (always reports unchanged)", file: GS, from: "const comparison = await compareProject(dir, recorded);", to: "const comparison = { unchanged: true, changed: [], missing: [], extra: [] };" },
  { name: "the post-run check is skipped and claims to have read every file", file: GS, from: "const comparison = await compareProject(dir, recorded);", to: "const comparison = { unchanged: true, checked: 7, changed: [], missing: [], extra: [] };" },
  { name: "the post-run check reads no files but says it did not change", file: GS, from: "const comparison = await compareProject(dir, recorded);", to: "const comparison = { unchanged: true, checked: 0, changed: [], missing: [], extra: [] };" },
];

console.log(`baseline                                                    -> ${runAll()}`);
for (const c of cases) {
  const original = read(c.file);
  if (!original.includes(c.from)) {
    console.log(`${c.name.padEnd(60)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  write(c.file, original.replace(c.from, c.to));
  try {
    console.log(`${c.name.padEnd(60)}-> ${runAll()}`);
  } finally {
    write(c.file, original);
  }
}
console.log(`restored                                                    -> ${runAll()}`);
