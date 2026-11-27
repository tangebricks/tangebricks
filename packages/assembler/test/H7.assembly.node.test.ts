import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { record } from "@poc/harness";
import { assemble, hashFiles } from "../src/index.ts";
import { catalog } from "../catalog.generated.ts";
import { TWO_BRICK_BLUEPRINT } from "../../../test/support/blueprints.ts";

// H7: assembly is deterministic, offline and fast.
//
// The assembler is run in two fresh Node processes that differ in what an assembler could wrongly depend on: the
// folder they start in, the time zone, and the clock (shifted forward by over a year in the second). Locale variables
// are set differently too, but on Windows they were found not to change Node's locale, so locale-sensitive behaviour is
// not exercised by this test and the H7 caveat says so. Their output must be identical file for file. Both run behind
// traps for every way to reach the network, and each trap is shown to fire on a deliberate attempt, so "zero attempts"
// means something. Time is the wall clock of the whole process, including starting Node, which is harsher than timing
// the call.
const root = resolve(import.meta.dirname, "..", "..", "..");
const runner = join(root, "scripts", "h7-run.ts");
const scratch = mkdtempSync(join(tmpdir(), "h7-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Report {
  files: number;
  hashes: Record<string, string>;
  assemblyMs: number;
  attempts: string[];
  /** Set when the run stopped early, usually because a trap refused an attempt. */
  failure: string | null;
  clockMs: number;
  cwd: string;
  tz: string | null;
}
interface Run {
  report: Report;
  wallSeconds: number;
}

function start(args: string[], options: { cwd: string; env: Record<string, string>; shiftClock?: boolean }) {
  const flags = options.shiftClock ? ["--import", pathToFileURL(join(root, "scripts", "h7-shift-clock.ts")).href] : [];
  const began = performance.now();
  const child = spawnSync(process.execPath, [...flags, runner, ...args], { cwd: options.cwd, env: { ...process.env, ...options.env }, encoding: "utf8" });
  const wallSeconds = (performance.now() - began) / 1000;
  if (child.status !== 0) throw new Error(`h7-run failed (exit ${child.status}): ${child.stderr || child.stdout}`);
  const line = child.stdout.trim().split(/\r?\n/).at(-1)!;
  return { json: JSON.parse(line) as Record<string, any>, wallSeconds };
}

const first: Run = (() => {
  const { json, wallSeconds } = start([], { cwd: root, env: { TZ: "UTC", LC_ALL: "C", LANG: "C" } });
  return { report: json as Report, wallSeconds };
})();
const second: Run = (() => {
  const { json, wallSeconds } = start([], { cwd: scratch, env: { TZ: "Asia/Kolkata", LC_ALL: "tr_TR.UTF-8", LANG: "tr_TR.UTF-8" }, shiftClock: true });
  return { report: json as Report, wallSeconds };
})();

describe("two cold runs that differ in folder, time zone and clock", () => {
  test("really do differ in those ways (so a match means something)", () => {
    expect(first.report.cwd).not.toBe(second.report.cwd);
    expect(first.report.tz).toBe("UTC");
    expect(second.report.tz).toBe("Asia/Kolkata");
    // the second run's clock is about 400 days ahead of the first's
    const days = (second.report.clockMs - first.report.clockMs) / 86_400_000;
    expect(days).toBeGreaterThan(399);
    expect(days).toBeLessThan(401);
  });

  test("make the same files: every path and every SHA-256 equal", () => {
    // 11 since story 0.21 (credit-wallet's rate limits bring the px_rate_limits migration); 12 since story 2.3
    // (credit-wallet's order currency migration); 13 since story 2.5 (its milli-credit migration).
    expect(second.report.files).toBe(13);
    expect(Object.keys(first.report.hashes)).toHaveLength(13);
    expect(second.report.hashes).toEqual(first.report.hashes);
  });

  test("and the same files this process makes in memory, three times over", async () => {
    const runs = await Promise.all(
      [1, 2, 3].map(async () => {
        const result = assemble(TWO_BRICK_BLUEPRINT, catalog);
        if (!result.ok) throw new Error(result.errors.join("; "));
        return hashFiles(result.files);
      }),
    );
    for (const hashes of runs) expect(hashes).toEqual(first.report.hashes);
  });

  test("make no attempt to reach outside themselves", () => {
    expect(first.report.attempts).toEqual([]);
    expect(second.report.attempts).toEqual([]);
    expect(first.report.failure).toBeNull();
    expect(second.report.failure).toBeNull();
  });

  test("are fast: each, with Node's own start-up included, finishes well inside five seconds", () => {
    expect(first.wallSeconds).toBeLessThan(5);
    expect(second.wallSeconds).toBeLessThan(5);
    expect(first.report.assemblyMs).toBeLessThan(5000);
  });
});

describe("the traps are live: each way out is caught when attempted on purpose", () => {
  const probes: Array<[string, string]> = [
    ["fetch", "fetch"],
    ["websocket", "WebSocket"],
    ["net-connect", "net.connect"],
    ["net-socket", "net.Socket.connect"],
    ["tls-connect", "tls.connect"],
    ["dns-lookup", "dns.lookup"],
    ["dns-promises", "dns.promises.lookup"],
    ["http-get", "http.get"],
    ["https-request", "https.request"],
    ["http2-connect", "http2.connect"],
    ["dgram", "dgram.createSocket"],
    ["spawn", "child_process.spawnSync"],
    ["exec", "child_process.execSync"],
  ];
  test.each(probes)("%s is recorded as %s", (kind, recorded) => {
    const { json } = start(["--probe", kind], { cwd: root, env: {} });
    expect(json.attempts).toContain(recorded);
  });

  test("and a clean run with no probe records nothing, so the traps do not fire on their own", () => {
    expect(first.report.attempts).toHaveLength(0);
  });
});

test("H7 report", async ({ task }) => {
  const trapsLive = probes().every(({ kind, recorded }) => start(["--probe", kind], { cwd: root, env: {} }).json.attempts.includes(recorded));
  const runs = [first.report, second.report];
  // A run that stopped for a reason that is not a refused outside attempt is a broken test, not a finding about the
  // assembler: it fails this file (a fail), and is not allowed to look like "different files" (a kill).
  for (const run of runs) if (run.failure !== null && run.attempts.length === 0) throw new Error(`a run stopped without any outside attempt: ${run.failure}`);
  // A run stopped by a refused outside attempt has no files to compare. That is the network check's finding (a fail),
  // not evidence that the assembler makes different files (a kill).
  const stoppedByTrap = runs.some((run) => run.failure !== null);
  // 12 files since story 2.3 (credit-wallet's order currency migration); 13 since story 2.5 (its milli-credit migration).
  const sameFiles = JSON.stringify(second.report.hashes) === JSON.stringify(first.report.hashes) && first.report.files === 13 && second.report.files === 13;
  const clockShifted = (second.report.clockMs - first.report.clockMs) / 86_400_000 > 399;
  const slowest = Math.max(first.wallSeconds, second.wallSeconds);
  record(task, {
    id: "H7",
    measured: Math.round(slowest * 1000) / 1000,
    checks: {
      // The runs only count as a comparison if they really differed in folder, zone and clock.
      identicalHashes: (stoppedByTrap || sameFiles) && clockShifted && first.report.cwd !== second.report.cwd && second.report.tz === "Asia/Kolkata",
      // "Zero attempts" only counts if the traps are shown to fire.
      noNetworkAttempts: first.report.attempts.length === 0 && second.report.attempts.length === 0 && trapsLive,
    },
  });
});

function probes(): Array<{ kind: string; recorded: string }> {
  return [
    { kind: "fetch", recorded: "fetch" },
    { kind: "websocket", recorded: "WebSocket" },
    { kind: "net-connect", recorded: "net.connect" },
    { kind: "net-socket", recorded: "net.Socket.connect" },
    { kind: "tls-connect", recorded: "tls.connect" },
    { kind: "dns-lookup", recorded: "dns.lookup" },
    { kind: "dns-promises", recorded: "dns.promises.lookup" },
    { kind: "http-get", recorded: "http.get" },
    { kind: "https-request", recorded: "https.request" },
    { kind: "http2-connect", recorded: "http2.connect" },
    { kind: "dgram", recorded: "dgram.createSocket" },
    { kind: "spawn", recorded: "child_process.spawnSync" },
    { kind: "exec", recorded: "child_process.execSync" },
  ];
}
