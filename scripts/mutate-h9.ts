// Breaks the MCP server, the session script and the H9 evidence on purpose, one way at a time, and prints what the H9
// scoreboard says each time. Used while building story 4.7. Always restores what it touched.
// Usage: node scripts/mutate-h9.ts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);

function h9(): string {
  const run = spawnSync(process.execPath, [join(root, "scripts", "verify.ts"), "H9"], { cwd: root, encoding: "utf8" });
  const out = stripVTControlCharacters(run.stdout + run.stderr);
  const lines = out.split(/\r?\n/);
  const row =
    lines
      .find((l) => l.startsWith("H9 "))
      ?.replace(/\s{2,}/g, " ")
      .replace(" An MCP session builds the project at a fraction of the source tokens", "") ?? "(no H9 row)";
  const reasons = lines
    .filter((l) => /^\s+- /.test(l))
    .map((l) => l.trim().replace(/^- /, "").replace("check false: ", "f:").replace("check not reported: ", "nr:"))
    .join("; ");
  const note = lines.find((l) => l.startsWith("H9: the reported ratio"))?.slice(0, 70) ?? "";
  const tests = lines.find((l) => l.startsWith("Tests:"))?.replace(/\. Verdicts.*/, "") ?? "";
  return `exit ${run.status} | ${row} | ${tests} | ${reasons.slice(0, 140)}${note ? " | " + note : ""}`;
}

const TOOLS = "packages/mcp-server/src/tools.ts";
const SESSION = "packages/mcp-server/test/support/session.ts";
const TEST = "packages/mcp-server/test/H9.session.node.test.ts";
const TOKENS = "test/support/tokens.ts";

interface Case {
  name: string;
  file: string;
  from: string;
  to: string;
  also?: Array<{ file: string; from: string; to: string }>;
}
const cases: Case[] = [
  {
    name: "build_project answers with the files, as a coding tool would",
    file: TOOLS,
    from: "return ok({\n      project: args.project,\n      ...summary,\n      bricks: assembled.order,",
    to: "return ok({\n      project: args.project,\n      ...summary,files: assembled.files, bricks: assembled.order,",
  },
  {
    name: "every enable_brick answer repeats the whole catalog",
    file: TOOLS,
    from: "return ok({\n          project: args.project,\n          enabled: result.blueprint.bricks.map((b) => b.id),\n          needs:",
    to: "return ok({everything: JSON.stringify(catalog), project: args.project,\n          enabled: result.blueprint.bricks.map((b) => b.id),\n          needs:",
  },
  {
    name: "the tool list carries a long description (+20 000 characters)",
    file: TOOLS,
    from: 'description:\n    "List the bricks you can enable,',
    to: 'description:\n    "x".repeat(20000) + "List the bricks you can enable,',
  },
  {
    name: "the tool list is much smaller (descriptions cut to one word)",
    file: TOOLS,
    from: "return { name: tool.name, description: tool.description, inputSchema: trim(schema),",
    to: "return { name: tool.name, description: 'tool', inputSchema: trim(schema),",
  },
  {
    name: "the session skips list_bricks (three calls)",
    file: SESSION,
    from: 'export const FULL_SESSION: Step[] = [\n  { tool: "list_bricks", args: {} },',
    to: "export const FULL_SESSION: Step[] = [",
  },
  {
    name: "the session never declares the table (a different, smaller project)",
    file: SESSION,
    from: '  { tool: "define_entity", args: { project: "invoice-flow", entities: [INVOICES] } },\n  { tool: "build_project", args: { project: "invoice-flow" } },\n];\n\n/** For information',
    to: '  { tool: "build_project", args: { project: "invoice-flow" } },\n];\n\n/** For information',
  },
  {
    name: "the session enables the bricks one call each (six calls again)",
    file: SESSION,
    from: '  proposeBricks("invoice-flow", ["multi-workspace", "credit-wallet", "dynamic-entities"]),',
    to: '  proposeBricks("invoice-flow", ["multi-workspace"]),\n  proposeBricks("invoice-flow", ["credit-wallet"]),\n  proposeBricks("invoice-flow", ["dynamic-entities"]),',
  },
  {
    name: "the conversation is counted from the answers only (requests ignored)",
    file: SESSION,
    from: "const rawTokens = exchanges.reduce((sum, e) => sum + e.requestTokens + e.responseTokens, 0);",
    to: "const rawTokens = exchanges.reduce((sum, e) => sum + e.responseTokens, 0);",
  },
  {
    name: "the tool list is left out of the conversation",
    file: SESSION,
    from: "const rawTokens = exchanges.reduce((sum, e) => sum + e.requestTokens + e.responseTokens, 0);",
    to: "const rawTokens = exchanges.filter((e) => e.rpc !== 'tools/list').reduce((sum, e) => sum + e.requestTokens + e.responseTokens, 0);",
  },
  {
    name: "the tokenizer is replaced by a guess of one token per four characters",
    file: TOKENS,
    from: "export const countTokens = (text: string): number => encode(text).length;",
    to: "export const countTokens = (text: string): number => Math.ceil(text.length / 4);\nvoid encode;",
  },
  {
    name: "third-party and shared code is counted as the project's own (denominator inflated)",
    file: TEST,
    from: "bricks.map((b) => BRICK_PACKAGES[b]!)",
    to: 'bricks.map((b) => BRICK_PACKAGES[b]!).concat(["packages/sdk", "packages/runtime", "packages/harness"])',
  },
  { name: "copied migrations are counted twice (denominator inflated)", file: TOKENS, from: "if (!seen.has(key)) seen.set(key, rel);", to: "seen.clear();" },
  {
    name: "the ratio is hard-coded in the report",
    file: TEST,
    from: 'record(task, { id: "H9", measured: round(full.percent), checks });',
    to: 'record(task, { id: "H9", measured: 5, checks });',
  },
  {
    name: "the call-count check is hard-coded true while the session takes six calls",
    file: TEST,
    from: "fiveToolCallsOrFewer: full.session.toolCalls <= 5,",
    to: "fiveToolCallsOrFewer: true,",
    also: [
      {
        file: SESSION,
        from: '  proposeBricks("invoice-flow", ["multi-workspace", "credit-wallet", "dynamic-entities"]),',
        to: '  proposeBricks("invoice-flow", ["multi-workspace"]),\n  proposeBricks("invoice-flow", ["credit-wallet"]),\n  proposeBricks("invoice-flow", ["dynamic-entities"]),',
      },
    ],
  },
  {
    name: "the same-project check is hard-coded true while the session builds something else",
    file: TEST,
    from: "sessionBuiltTheDirectProject: full.sameFiles && full.sameHash && full.session.summary !== null,",
    to: "sessionBuiltTheDirectProject: true,",
    also: [
      {
        file: SESSION,
        from: '  { tool: "define_entity", args: { project: "invoice-flow", entities: [INVOICES] } },\n  { tool: "build_project", args: { project: "invoice-flow" } },\n];\n\n/** For information',
        to: '  { tool: "build_project", args: { project: "invoice-flow" } },\n];\n\n/** For information',
      },
    ],
  },
  {
    name: "the server builds a different project from what was asked (an extra file stored)",
    file: TOOLS,
    from: "const summary = await storeBuild(db, args.project, assembled.files);",
    to: "const summary = await storeBuild(db, args.project, { ...assembled.files, 'src/extra.ts': '// extra' });",
  },
];

console.log(`baseline                                                    -> ${h9()}`);
for (const c of cases) {
  const edits = [{ file: c.file, from: c.from, to: c.to }, ...(c.also ?? [])];
  const originals = new Map(edits.map((e) => [e.file, read(e.file)]));
  if (edits.some((e) => !originals.get(e.file)!.includes(e.from))) {
    console.log(`${c.name.padEnd(60)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  for (const e of edits) write(e.file, read(e.file).replace(e.from, e.to));
  try {
    console.log(`${c.name.padEnd(60)}-> ${h9()}`);
  } finally {
    for (const [file, text] of originals) write(file, text);
  }
}
console.log(`restored                                                    -> ${h9()}`);
