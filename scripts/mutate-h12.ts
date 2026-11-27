// Breaks the H12 protocol, its re-reading, the widget, the demo page and the test driver on purpose, one way at a time, and prints
// how many of the H12 rehearsal's tests fail each time. Used while building epic 5, story 7. Always restores what it touched: it
// keeps its own copy of every file it edits and restores from that copy even after an interrupted run; a backup is only deleted
// after a clean finish; an empty backup is never trusted; hashes are compared at the end.
// Usage: node scripts/mutate-h12.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dirname, "..");
const backup = join(root, "out", "mutate-h12-backup");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const slug = (rel: string) => rel.replace(/[\\/]/g, "__");

const H = "packages/deploy/src/h12.ts";
const W = "bricks/credit-wallet/client/CreditWidget.tsx";
const P = "packages/deploy/client/demo-entry.tsx";
const D = "packages/deploy/client/support/widget-driver.tsx";

interface Case {
  name: string;
  file: string;
  from: string;
  to: string;
}
const cases: Case[] = [
  // ---- what the protocol does to the server
  { name: "the spend is a different amount from the one expected", file: H, from: '{ amount: SPEND, reason: "h12 spend" }', to: '{ amount: 1, reason: "h12 spend" }' },
  { name: "the widget is not refreshed after the spend", file: H, from: '      await widgetA.refresh();\n      await look("A: after spending through the API"', to: '      await look("A: after spending through the API"' },
  { name: "the widget is not refreshed after the top-up", file: H, from: '      await widgetA.refresh();\n      await look("A: after a top-up"', to: '      await look("A: after a top-up"' },
  { name: "the top-up takes credits away", file: H, from: "UPDATE credit_wallets SET balance_milli = balance_milli + ?2 WHERE workspace_id = ?1", to: "UPDATE credit_wallets SET balance_milli = balance_milli - ?2 WHERE workspace_id = ?1" },
  { name: "the two tenants get the same balance", file: H, from: "export const SEED = { A: 1234, B: 567 } as const;", to: "export const SEED = { A: 1234, B: 1234 } as const;" },
  { name: "tenant A gets no credit", file: H, from: "export const SEED = { A: 1234, B: 567 } as const;", to: "export const SEED = { A: 0, B: 567 } as const;" },
  { name: "tenant B's widget is pointed at tenant A's workspace", file: H, from: 'clientFor(B.id, B.user, "B")', to: 'clientFor(A.id, B.user, "B")' },
  { name: "the cross-tenant request is made as A's own user", file: H, from: 'clientFor(A.id, B.user, "B-asks-for-A")', to: 'clientFor(A.id, A.user, "B-asks-for-A")' },
  { name: "the balance is read back from the wrong workspace", file: H, from: "restBalance: await restBalance(`owner-read-${facts.observations.length + 1}`, workspace)", to: "restBalance: await restBalance(`owner-read-${facts.observations.length + 1}`, facts.workspaces.A.id)" },
  // ---- what is believed on re-reading
  { name: "equal or zero seeds are accepted", file: H, from: "seeds.A > 0 && seeds.B > 0 && seeds.A !== seeds.B;", to: "true;" },
  { name: "the widget's number is not compared with D1's", file: H, from: "a1.shown === formatCredits(seedA) &&\n      a1.restBalance === seedA &&", to: "a1.shown === formatCredits(seedA) &&" },
  { name: "the first view is not required to show the seeded ledger line", file: H, from: 'a1.history.some((line) => line.includes("seeded by the proof") && line.includes(formatCredits(seedA))) &&', to: "" },
  { name: "the widget is not required to have asked the server", file: H, from: 'widgetRequests("A").length >= 2 &&\n      widgetRequests("A").every((e) => e.status === 200) &&', to: "" },
  { name: "a balance that did not move after the spend is accepted", file: H, from: "spent.restBalance === afterSpend &&\n      spent.shown !== a1.shown &&", to: "spent.restBalance === afterSpend &&" },
  { name: "a balance that moved when nothing changed is accepted", file: H, from: "ordered.shown === spent.shown &&\n      ordered.restBalance === afterSpend &&", to: "" },
  { name: "the spend's own answer is not compared", file: H, from: "server.spend.status === 200 &&\n      server.spend.amount === SPEND &&\n      server.spend.balanceAfter === afterSpend &&", to: "" },
  { name: "a balance that did not move after the top-up is accepted", file: H, from: "topped.restBalance === afterTop &&\n      topped.shown !== ordered.shown &&", to: "topped.restBalance === afterTop &&" },
  { name: "the order that was never created is accepted", file: H, from: "server.createOrder.status === 200 &&\n      server.createOrder.hasOrderId &&", to: "" },
  { name: "the glue scan's hashes are not compared with the files", file: H, from: "files.every((p) => input.result.scanned[p] === sha256(input.sources[p]!));", to: "true;" },
  { name: "the glue scan does not read the files for network code", file: H, from: "const clean = files.every(\n      (p) =>\n        !NETWORK_CODE.test(", to: "const clean = files.every(\n      (p) => true || !NETWORK_CODE.test(" },
  { name: "the glue scan accepts fewer files than it should cover", file: H, from: "files.length === GLUE_SCAN_FILES.length && files.every", to: "files.every" },
  { name: "the glue scan no longer looks for a direct fetch call", file: H, from: '"\\\\bfetch\\\\s*\\\\(", ', to: "" },
  { name: "tenant B is not required to see exactly its own seed", file: H, from: "b1.shown === formatCredits(seeds.B) &&\n      b1.restBalance === seeds.B &&\n      !leaks(b1)", to: "!leaks(b1)" },
  { name: "tenant A's numbers appearing on tenant B's screen are accepted", file: H, from: "&&\n      !leaks(b1) &&\n      b1.workspace", to: "&& b1.workspace" },
  { name: "tenant B asking for A's wallet may be shown A's balance", file: H, from: "cross.shown === null &&\n      cross.alert !== null &&\n      cross.alert.length > 0 &&\n      !leaks(cross)", to: "true" },
  { name: "the server answering the cross-tenant request with success is accepted", file: H, from: 'widgetRequests("B-asks-for-A").every((e) => e.status === 403 || e.status === 404)', to: "true" },
  { name: "a run that wrote to the account beyond rows is believed", file: H, from: "if (uploaded || !sameVersion)\n    return", to: "if (false as boolean)\n    return" },
  { name: "a Worker whose version moved is believed", file: H, from: "f.versions.before[0] === f.versions.after[0] &&\n    f.versions.before.length === f.versions.after.length &&", to: "" },
  { name: "an edited calls file is believed", file: H, from: "if (sha256(input.callsText) !== input.result.callsSha256 ||", to: "if (false as boolean ||" },
  // ---- the widget, the page and the driver
  { name: "the widget shows a constant", file: W, from: '<strong data-testid="balance">{state.balance.toLocaleString("en-US")}</strong>', to: '<strong data-testid="balance">1,234</strong>' },
  { name: "the widget's buttons do nothing", file: W, from: "onClick={() => void load()}", to: "onClick={() => undefined}" },
  { name: "the widget never says anything went wrong", file: W, from: '{state.phase === "error" && (', to: "{false as boolean && (" },
  { name: "the page asks for the wrong workspace", file: P, from: "workspaceId: workspace,", to: "workspaceId: user," },
  { name: "the page leaves the key out", file: P, from: 'headers: { "x-poc-key": key, "x-test-user": user },', to: 'headers: { "x-test-user": user },' },
  { name: "the driver does not press Refresh", file: D, from: "      fireEvent.click(button);\n", to: "" },
  { name: "the driver reports a constant", file: D, from: 'return screen.queryByTestId("balance")?.textContent ?? null;', to: 'return "1,234";' },
];

const suites = ["packages/deploy/client/test/H12"];
function run(): string {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--project", "dom", ...suites], { cwd: root, encoding: "utf8", timeout: 600_000 });
  const out = stripVTControlCharacters(result.stdout + result.stderr);
  const tests = out.split(/\r?\n/).find((l) => /^\s+Tests /.test(l))?.trim().replace(/^Tests\s+/, "");
  if (tests) return tests.replace(/ passed/g, "p").replace(/ failed/g, "f");
  return /FAIL|Error/.test(out) || result.error ? "(did not run)" : "(no summary)";
}

mkdirSync(backup, { recursive: true });
const targets = [...new Set(cases.map((c) => c.file))];
for (const file of targets) {
  const saved = join(backup, slug(file));
  if (!existsSync(saved)) continue;
  const text = readFileSync(saved, "utf8");
  if (text.length === 0) {
    rmSync(saved);
    console.log(`ignored an empty leftover backup of ${file}`);
    continue;
  }
  write(file, text);
  rmSync(saved);
  console.log(`restored ${file} from a previous interrupted run`);
}
const before = new Map(targets.map((f) => [f, sha(read(f))]));
for (const file of targets) {
  if (read(file).length === 0) throw new Error(`${file} is empty: refusing to start, there is nothing to protect`);
  writeFileSync(join(backup, slug(file)), read(file));
}

console.log(`baseline -> ${run()}`);
for (const c of cases) {
  const original = read(c.file);
  if (!original.includes(c.from)) {
    console.log(`${c.name.padEnd(86)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  write(c.file, original.split(c.from).join(c.to));
  try {
    console.log(`${c.name.padEnd(86)}-> ${run()}`);
  } finally {
    write(c.file, original);
  }
}
console.log(`restored -> ${run()}`);
const after = new Map(targets.map((f) => [f, sha(read(f))]));
const changed = targets.filter((f) => before.get(f) !== after.get(f));
console.log(changed.length === 0 ? `files identical to before the run: ${targets.length} of ${targets.length}` : `FILES NOT RESTORED: ${changed.join(", ")}`);
if (changed.length === 0) for (const file of targets) rmSync(join(backup, slug(file)), { force: true });
