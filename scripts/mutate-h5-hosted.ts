// Breaks the hosted money check on purpose, one way at a time: how it judges a run, how it counts unknown outcomes, how it classifies
// answers and how its REST adapter and spacer work. Prints how many of its rehearsal tests fail each time. Used while building epic 5,
// story 8. Always restores what it touched: it keeps its own copy of every file it edits and restores from that copy even after an
// interrupted run; a backup is only deleted after a clean finish; an empty backup is never trusted; hashes are compared at the end.
// Usage: node scripts/mutate-h5-hosted.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const backup = join(root, "out", "mutate-h5-hosted-backup");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const slug = (rel: string) => rel.replace(/[\\/]/g, "__");

const H = "packages/deploy/src/h5-hosted.ts";
interface Case {
  name: string;
  from: string;
  to: string;
}
const cases: Case[] = [
  // ---- how a run is judged
  { name: "a final balance the ledger does not explain is accepted", from: "if (f.balance !== run.start + sum) reasons.push(", to: "if (false as boolean) reasons.push(" },
  { name: "a negative final balance is accepted", from: "if (f.balance < 0) reasons.push(", to: "if (false as boolean) reasons.push(" },
  { name: "a balance_after that a replay does not reproduce is accepted", from: "if (row.balance_after !== running) mismatches += 1;", to: "" },
  { name: "a negative balance_after is accepted", from: "if (row.balance_after < 0) negatives += 1;", to: "" },
  { name: "an accepted deduction with no row is accepted", from: "if (rows < accepted) reasons.push(", to: "if (false as boolean) reasons.push(" },
  { name: "a deduction row nobody asked for is accepted", from: "if (rows > accepted + unknown) reasons.push(", to: "if (false as boolean) reasons.push(" },
  { name: "an unknown deduction is allowed any number of rows", from: "if (rows > accepted + unknown) reasons.push(", to: "if (rows > accepted + unknown + 99) reasons.push(" },
  { name: "an unknown deduction is allowed no row at all", from: "if (rows > accepted + unknown) reasons.push(", to: "if (rows > accepted) reasons.push(" },
  { name: "an order credited twice is accepted", from: "if (twice > 0) reasons.push(", to: "if (false as boolean) reasons.push(" },
  { name: "an order credited for another amount is accepted", from: "if (row.amount !== requested.get(order)) reasons.push(", to: "if (false as boolean) reasons.push(" },
  { name: "a top-up row for an order nobody requested is accepted", from: "if (!order || !requested.has(order)) {", to: "if (false as boolean) {" },
  { name: "an accepted top-up with no row is accepted", from: 'if (t.result === "accepted" && rows !== 1) reasons.push(', to: 'if (false as boolean) reasons.push(' },
  { name: "a top-up confirmed twice that did not credit exactly once is accepted", from: 'if (t.result === "violation") reasons.push(`order ${t.orderId} was confirmed twice', to: 'if (false as boolean) reasons.push(`order ${t.orderId} was confirmed twice' },
  { name: "a ledger row of a kind no operation makes is accepted", from: 'if (f.ledger.some((r) => r.type !== "deduction" && r.type !== "topup")) reasons.push(', to: 'if (false as boolean) reasons.push(' },
  { name: "a missing wallet is accepted", from: 'if (f.balance === null) return ["the wallet row is missing"];', to: "if (f.balance === null) return [];" },
  // ---- what is concluded
  { name: "a violating run does not make the check false", from: "if (violating.length > 0) checks.holdsOnHostedD1 = false;", to: "if (false as boolean) checks.holdsOnHostedD1 = false;" },
  { name: "a mostly unknown run still reports true", from: "unknownShare <= UNKNOWN_SHARE_LIMIT && operations > 0)", to: "operations > 0)" },
  { name: "the share of unknown outcomes ignores the top-ups", from: "r.deducts.filter((d) => d.result === \"unknown\").length + r.topups.filter((t) => t.result === \"unknown\").length, 0);\n  const unknownShare", to: "r.deducts.filter((d) => d.result === \"unknown\").length, 0);\n  const unknownShare" },
  { name: "a pilot with fewer runs than the rule needs reports true", from: "else if (f.runsWanted === requiredRuns && f.runs.length", to: "else if (f.runs.length" },
  { name: "fewer runs than wanted still report true", from: "else if (f.runs.length === f.runsWanted && judged.length", to: "else if (judged.length" },
  { name: "a run that could not be set up still reports true", from: "&& f.runs.every((r) => !r.setupError) &&", to: "&&" },
  { name: "a run whose state was not read is skipped silently", from: "const judged = f.runs.filter((r) => r.final !== null);\n  const violating = judged", to: "const judged = f.runs;\n  const violating = judged.filter((r) => r.final !== null)" },
  { name: "a Worker whose version moved is believed", from: "f.versions.before[0] === f.versions.after[0] && f.versions.before.length === f.versions.after.length &&", to: "" },
  { name: "a write to anything but rows is believed", from: "const wrote = all.some((c) => c.method !== \"GET\" && !isQuery(c));", to: "const wrote = false;" },
  { name: "an edited calls file is believed", from: "if (sha256(input.callsText) !== input.result.callsSha256 ||", to: "if (false as boolean ||" },
  // ---- how answers are classified
  { name: "a refusal for insufficient balance is called accepted", from: 'status === 402 ? "refused" : "unknown"', to: 'status === 402 ? "accepted" : "unknown"' },
  { name: "any answer below 500 is called accepted", from: 'status === 200 ? "accepted"', to: 'status !== null && status < 500 ? "accepted"' },
  { name: "a server error is called refused, not unknown", from: 'status === 402 ? "refused" : "unknown"', to: 'status === 402 || (status !== null && status >= 500) ? "refused" : "unknown"' },
  { name: "a failed confirmation is called accepted", from: 'return failed ? "unknown" : credited === 1 ? "accepted" : "violation";', to: 'return failed ? "accepted" : credited === 1 ? "accepted" : "violation";' },
  { name: "a top-up credited twice is called accepted", from: 'credited === 1 ? "accepted" : "violation";', to: 'credited >= 1 ? "accepted" : "violation";' },
  { name: "a stored outcome is trusted over the recorded answer", from: 'if (disagrees) return', to: 'if (false as boolean) return' },
  { name: "the judging uses the stored outcome, not the recorded answer", from: 'deducts: rawRun.deducts.map((d) => ({ ...d, result: classifyDeduct(d.status) })), topups: rawRun.topups.map((t) => ({ ...t, result: classifyTopup(t.confirmations) })) };', to: 'deducts: rawRun.deducts, topups: rawRun.topups };' },  { name: "each order is confirmed only once", from: "await Promise.all([0, 1].map(() => wallet.confirmOrder", to: "await Promise.all([0].map(() => wallet.confirmOrder" },
  // ---- the adapter and the spacer
  { name: "the adapter sends only the first statement of a batch", from: "const results = await client.queryDatabase(databaseId, parts);", to: "const results = await client.queryDatabase(databaseId, parts.slice(0, 1));" },
  { name: "the adapter does not space its calls", from: "    if (at > now) await sleep(at - now);", to: "" },
  { name: "the spacer lets every caller start at once", from: "nextFree = at + ms;", to: "nextFree = at;" },
];

const suites = ["packages/deploy/test/H5.hosted"];
function run(): string {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...suites], { cwd: root, encoding: "utf8", timeout: 600_000 });
  const out = (result.stdout + result.stderr).replace(/\x1B\[[0-9;]*m/g, "");
  const tests = out.split(/\r?\n/).find((l) => /^\s+Tests /.test(l))?.trim().replace(/^Tests\s+/, "");
  if (tests) return tests.replace(/ passed/g, "p").replace(/ failed/g, "f");
  return /FAIL|Error/.test(out) || result.error ? "(did not run)" : "(no summary)";
}

mkdirSync(backup, { recursive: true });
const saved = join(backup, slug(H));
if (existsSync(saved)) {
  const text = readFileSync(saved, "utf8");
  if (text.length === 0) {
    rmSync(saved);
    console.log(`ignored an empty leftover backup of ${H}`);
  } else {
    write(H, text);
    rmSync(saved);
    console.log(`restored ${H} from a previous interrupted run`);
  }
}
const before = sha(read(H));
if (read(H).length === 0) throw new Error(`${H} is empty: refusing to start, there is nothing to protect`);
writeFileSync(saved, read(H));

console.log(`baseline -> ${run()}`);
for (const c of cases) {
  const original = read(H);
  if (!original.includes(c.from)) {
    console.log(`${c.name.padEnd(86)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  write(H, original.replace(c.from, c.to));
  try {
    console.log(`${c.name.padEnd(86)}-> ${run()}`);
  } finally {
    write(H, original);
  }
}
console.log(`restored -> ${run()}`);
const after = sha(read(H));
console.log(before === after ? "files identical to before the run: 1 of 1" : `FILES NOT RESTORED: ${H}`);
if (before === after) rmSync(saved, { force: true });
