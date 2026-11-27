// Breaks the credit widget and its client on purpose, one way at a time, and prints how many DOM tests fail each time.
// Used while building story 3.6. Always restores what it touched.
// Usage: node scripts/mutate-widget.ts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);

function runDom(): string {
  const run = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--project", "dom"], { cwd: root, encoding: "utf8" });
  const out = stripVTControlCharacters(run.stdout + run.stderr);
  const tests =
    out
      .split(/\r?\n/)
      .find((l) => /^\s+Tests /.test(l))
      ?.trim() ?? "(no test summary)";
  const failed = [...out.matchAll(/^ FAIL .*? > (.*)$/gm)].map((m) => m[1]!.slice(0, 70));
  return `${tests}${failed.length ? "  first failing: " + failed[0] : ""}`;
}

const WIDGET = "bricks/credit-wallet/client/CreditWidget.tsx";
const CLIENT = "bricks/credit-wallet/client/wallet-client.ts";
const cases: Array<{ name: string; file: string; from: string; to: string }> = [
  { name: "balance is a constant, not what the server says", file: WIDGET, from: "balance: balance.currentBalance,", to: "balance: 1000," },
  { name: "history is shown without a limit", file: WIDGET, from: "history.slice(0, historyLimit)", to: "history" },
  { name: "history is shown oldest first", file: WIDGET, from: "history.slice(0, historyLimit)", to: "[...history].reverse().slice(0, historyLimit)" },
  {
    name: "Refresh does nothing",
    file: WIDGET,
    from: '<button type="button" onClick={() => void load()}>\n            Refresh',
    to: '<button type="button" onClick={() => undefined}>\n            Refresh',
  },
  {
    name: "the description is rendered as HTML",
    file: WIDGET,
    from: "{entry.description}: {entry.amount > 0",
    to: "<span dangerouslySetInnerHTML={{ __html: entry.description }} />: {entry.amount > 0",
  },
  {
    name: "an error is swallowed and the widget stays on Loading",
    file: WIDGET,
    from: 'setState({ phase: "error", message: error instanceof Error ? error.message : "Something went wrong" });',
    to: "void error;",
  },
  {
    name: "Try again does not retry",
    file: WIDGET,
    from: '<button type="button" onClick={() => void load()}>\n            Try again',
    to: '<button type="button" onClick={() => undefined}>\n            Try again',
  },
  { name: "client does not send the workspace", file: CLIENT, from: '"x-workspace-id": options.workspaceId, ', to: "" },
  { name: "client drops the host's headers", file: CLIENT, from: "...options.headers, ", to: "" },
  {
    name: "client trusts any JSON the server sends",
    file: CLIENT,
    from: 'if (!parsed.success) throw new WalletClientError("The server\'s answer was not understood", response.status);\n    return parsed.data;',
    to: "return body as T;",
  },
  { name: "client treats an error status as data", file: CLIENT, from: "if (!response.ok) {", to: "if (false as boolean) {" },
  {
    name: "client swallows an unreachable server as an empty balance",
    file: CLIENT,
    from: 'throw new WalletClientError("Could not reach the server", 0);',
    to: "return { currentBalance: 0, creditsPerUnit: 1, minOrderAmount: 1, ledgers: [] } as T;",
  },
];

console.log(`baseline                                                    -> ${runDom()}`);
for (const c of cases) {
  const original = read(c.file);
  if (!original.includes(c.from) || c.from === c.to) {
    console.log(`${c.name.padEnd(60)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  write(c.file, original.replace(c.from, c.to));
  try {
    console.log(`${c.name.padEnd(60)}-> ${runDom()}`);
  } finally {
    write(c.file, original);
  }
}
console.log(`restored                                                    -> ${runDom()}`);
