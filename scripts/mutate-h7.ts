// Breaks the assembler and the H7 test on purpose, one way at a time, and prints what the H7 scoreboard says each time.
// Used while building story 4.4. Always restores what it touched.
// Usage: node scripts/mutate-h7.ts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);

function h7(): string {
  const run = spawnSync(process.execPath, [join(root, "scripts", "verify.ts"), "H7"], { cwd: root, encoding: "utf8" });
  const out = stripVTControlCharacters(run.stdout + run.stderr);
  const lines = out.split(/\r?\n/);
  const row = lines.find((l) => l.startsWith("H7 "))?.replace(/\s{2,}/g, " ").replace(" Assembly is deterministic, offline and fast", "") ?? "(no H7 row)";
  const reasons = lines.filter((l) => /^\s+- /.test(l)).map((l) => l.trim().replace(/^- /, "")).join("; ");
  const tests = lines.find((l) => l.startsWith("Tests:"))?.replace(/\. Verdicts.*/, "") ?? "";
  return `exit ${run.status} | ${row} | ${tests} | ${reasons.slice(0, 120)}`;
}

const ASM = "packages/assembler/src/assemble.ts";
const TEST = "packages/assembler/test/H7.assembly.node.test.ts";
const RUNNER = "scripts/h7-run.ts";
const START = "export function assemble(input: unknown, catalog: Catalog): AssembleResult {\n";

interface Case {
  name: string;
  file: string;
  from: string;
  to: string;
  also?: Array<{ file: string; from: string; to: string }>;
}
const cases: Case[] = [
  { name: "a timestamp in project.json", file: ASM, ...tweak('project: blueprint.project,\n    identity: blueprint.identity,', 'project: blueprint.project,\n    builtAt: new Date().toISOString(),\n    identity: blueprint.identity,') },
  { name: "only the DATE is stamped (identical across runs on one day)", file: ASM, ...tweak('project: blueprint.project,\n    identity: blueprint.identity,', 'project: blueprint.project,\n    builtOn: new Date().toISOString().slice(0, 10),\n    identity: blueprint.identity,') },
  { name: "the year is stamped (identical for a year)", file: ASM, ...tweak('project: blueprint.project,\n    identity: blueprint.identity,', 'project: blueprint.project,\n    year: new Date().getFullYear(),\n    identity: blueprint.identity,') },
  { name: "Math.random in package.json", file: ASM, ...tweak('name: blueprint.project,\n    private: true,', 'name: blueprint.project,\n    nonce: Math.random(),\n    private: true,') },
  { name: "a random id in package.json", file: ASM, ...tweak('name: blueprint.project,\n    private: true,', 'name: blueprint.project,\n    nonce: globalThis.crypto.randomUUID(),\n    private: true,') },
  { name: "the time zone is read from the environment", file: ASM, ...tweak('project: blueprint.project,\n    identity: blueprint.identity,', 'project: blueprint.project,\n    zone: (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.TZ ?? null,\n    identity: blueprint.identity,') },
  { name: "the working folder is read", file: ASM, ...tweak('project: blueprint.project,\n    identity: blueprint.identity,', 'project: blueprint.project,\n    where: (globalThis as { process?: { cwd(): string } }).process?.cwd(),\n    identity: blueprint.identity,') },
  { name: "a fetch to the network", file: ASM, ...tweak(START, START + '  void fetch("http://127.0.0.1:9/");\n') },
  { name: "a socket connection", file: ASM, ...tweak(START, START + '  (globalThis as { process: { getBuiltinModule(n: string): { connect(p: number, h: string): unknown } } }).process.getBuiltinModule("node:net").connect(9, "127.0.0.1");\n') },
  { name: "a DNS lookup", file: ASM, ...tweak(START, START + '  (globalThis as { process: { getBuiltinModule(n: string): { lookup(h: string, cb: () => void): unknown } } }).process.getBuiltinModule("node:dns").lookup("example.invalid", () => {});\n') },
  { name: "a program is started", file: ASM, ...tweak(START, START + '  (globalThis as { process: { getBuiltinModule(n: string): { spawnSync(c: string): unknown } } }).process.getBuiltinModule("node:child_process").spawnSync("curl");\n') },
  { name: "six seconds of busy work (slow, not wrong)", file: ASM, ...tweak(START, START + '  for (const end = performance.now() + 6000; performance.now() < end; ) { /* busy */ }\n') },
  { name: "the second run is no longer shifted in time", file: TEST, ...tweak('shiftClock: true', 'shiftClock: false'), also: [{ file: ASM, from: 'project: blueprint.project,\n    identity: blueprint.identity,', to: 'project: blueprint.project,\n    builtOn: new Date().toISOString().slice(0, 10),\n    identity: blueprint.identity,' }] },
  { name: "both runs start in the same folder and zone (a leak on either would be hidden)", file: TEST, ...tweak('{ cwd: scratch, env: { TZ: "Asia/Kolkata"', '{ cwd: root, env: { TZ: "UTC"'), also: [{ file: ASM, from: 'project: blueprint.project,\n    identity: blueprint.identity,', to: 'project: blueprint.project,\n    where: (globalThis as { process?: { cwd(): string } }).process?.cwd(),\n    identity: blueprint.identity,' }] },
  { name: "the traps are removed from the runner (a fetch goes unseen)", file: RUNNER, ...tweak('globalThis.fetch = ((): Promise<Response> => {\n  attempts.push("fetch");', 'const keepFetch = ((): Promise<Response> => {\n  attempts.push("fetch");'), also: [{ file: ASM, from: START, to: START + '  void fetch("http://127.0.0.1:9/").catch(() => {});\n' }] },
  { name: "the report claims zero attempts without looking", file: TEST, ...tweak('noNetworkAttempts: first.report.attempts.length === 0 && second.report.attempts.length === 0 && trapsLive,', 'noNetworkAttempts: true,'), also: [{ file: ASM, from: START, to: START + '  void fetch("http://127.0.0.1:9/").catch(() => {});\n' }] },
  { name: "the report claims identical hashes without looking", file: TEST, ...tweak('identicalHashes: (stoppedByTrap || sameFiles) && clockShifted && first.report.cwd !== second.report.cwd && second.report.tz === "Asia/Kolkata",', 'identicalHashes: true,'), also: [{ file: ASM, from: 'name: blueprint.project,\n    private: true,', to: 'name: blueprint.project,\n    nonce: Math.random(),\n    private: true,' }] },
  { name: "a run that stops for an unexplained reason is waved through as 'identical'", file: TEST, ...tweak('for (const run of runs) if (run.failure !== null && run.attempts.length === 0) throw new Error(`a run stopped without any outside attempt: ${run.failure}`);', ''), also: [{ file: ASM, from: START, to: START + '  throw new Error("something unrelated broke");\n' }] },
];
function tweak(from: string, to: string) {
  return { from, to };
}

console.log(`baseline                                                    -> ${h7()}`);
for (const c of cases) {
  const edits = [{ file: c.file, from: c.from, to: c.to }, ...(c.also ?? [])];
  const originals = new Map(edits.map((e) => [e.file, read(e.file)]));
  if (edits.some((e) => !originals.get(e.file)!.includes(e.from))) {
    console.log(`${c.name.padEnd(60)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  for (const e of edits) write(e.file, read(e.file).replace(e.from, e.to));
  try {
    console.log(`${c.name.padEnd(60)}-> ${h7()}`);
  } finally {
    for (const [file, text] of originals) write(file, text);
  }
}
console.log(`restored                                                    -> ${h7()}`);
