// Runs the assembler once, in this fresh process, behind traps for every way a program can reach outside itself, and
// prints one JSON line: how many files it made, each file's hash, how long assembly took, and every outside attempt the
// traps saw. Used by the H7 test, which starts it twice under different conditions and compares the answers.
//
//   node [--import ./scripts/h7-shift-clock.ts] scripts/h7-run.ts [--probe <kind>]
//
// `--probe <kind>` makes the process attempt one outside action on purpose, so the test can show each trap fires.
// A trap records the attempt and then refuses it, so a probe (or a mutation) never really goes online.
import { createRequire } from "node:module";

const attempts: string[] = [];
const refuse = (kind: string) => () => {
  attempts.push(kind);
  throw new Error(`blocked by the H7 network trap: ${kind}`);
};

const require = createRequire(import.meta.url);
// Patching the module objects (not ESM namespaces) is what stops callers who import them later or by another route.
const patch = (target: Record<string, unknown>, names: string[], prefix: string) => {
  for (const name of names) if (typeof target[name] === "function") target[name] = refuse(`${prefix}.${name}`);
};

const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const http2 = require("node:http2");
const dgram = require("node:dgram");
const childProcess = require("node:child_process");

globalThis.fetch = ((): Promise<Response> => {
  attempts.push("fetch");
  return Promise.reject(new Error("blocked by the H7 network trap: fetch"));
}) as typeof fetch;
for (const name of ["WebSocket", "EventSource"] as const) {
  if (name in globalThis) {
    (globalThis as Record<string, unknown>)[name] = function blocked() {
      attempts.push(name);
      throw new Error(`blocked by the H7 network trap: ${name}`);
    };
  }
}
patch(net, ["connect", "createConnection"], "net");
net.Socket.prototype.connect = refuse("net.Socket.connect");
patch(tls, ["connect"], "tls");
patch(dns, ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveMx", "resolveTxt", "resolveSrv", "reverse"], "dns");
patch(dns.promises, ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveMx", "resolveTxt", "resolveSrv", "reverse"], "dns.promises");
patch(http, ["request", "get"], "http");
patch(https, ["request", "get"], "https");
patch(http2, ["connect"], "http2");
patch(dgram, ["createSocket"], "dgram");
patch(childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"], "child_process");

// A rejected promise from a trapped call must not kill the process before it can report what it saw.
process.on("unhandledRejection", () => {});

const probe = process.argv.includes("--probe") ? process.argv[process.argv.indexOf("--probe") + 1] : undefined;
const probes: Record<string, () => unknown> = {
  fetch: () => fetch("http://127.0.0.1:9/"),
  websocket: () => new (globalThis as unknown as { WebSocket: new (url: string) => unknown }).WebSocket("ws://127.0.0.1:9/"),
  "net-connect": () => net.connect(9, "127.0.0.1"),
  "net-socket": () => new net.Socket().connect(9, "127.0.0.1"),
  "tls-connect": () => tls.connect(9, "127.0.0.1"),
  "dns-lookup": () => dns.lookup("example.invalid", () => {}),
  "dns-promises": () => dns.promises.lookup("example.invalid"),
  "http-get": () => http.get("http://127.0.0.1:9/"),
  "https-request": () => https.request("https://127.0.0.1:9/"),
  "http2-connect": () => http2.connect("https://127.0.0.1:9/"),
  dgram: () => dgram.createSocket("udp4"),
  spawn: () => childProcess.spawnSync("curl", ["http://127.0.0.1:9/"]),
  exec: () => childProcess.execSync("curl http://127.0.0.1:9/"),
};
if (probe !== undefined) {
  if (!(probe in probes)) throw new Error(`unknown probe: ${probe}`);
  try {
    await Promise.resolve(probes[probe]!()).catch(() => {});
  } catch {
    // the trap threw, as intended; it has recorded the attempt
  }
  await new Promise((resolve) => setTimeout(resolve, 20)); // let any asynchronous attempt show itself
  console.log(JSON.stringify({ probe, attempts, clockMs: Date.now() }));
} else {
  const started = performance.now();
  let failure: string | null = null;
  let files = 0;
  let hashes: Record<string, string> = {};
  try {
    const { assemble, hashFiles } = await import("../packages/assembler/src/index.ts");
    const { catalog } = await import("../packages/assembler/catalog.generated.ts");
    const { TWO_BRICK_BLUEPRINT } = await import("../test/support/blueprints.ts");
    const result = assemble(TWO_BRICK_BLUEPRINT, catalog);
    if (!result.ok) throw new Error(`the blueprint did not assemble: ${result.errors.join("; ")}`);
    files = Object.keys(result.files).length;
    hashes = await hashFiles(result.files);
  } catch (error) {
    // A trap throws to refuse the attempt. The attempt is already recorded, so report it instead of crashing: a crash
    // would hide what was attempted behind a generic "could not run".
    failure = error instanceof Error ? error.message : String(error);
  }
  const assemblyMs = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 20)); // let any asynchronous attempt show itself
  console.log(JSON.stringify({ files, hashes, assemblyMs, attempts, failure, clockMs: Date.now(), cwd: process.cwd(), tz: process.env.TZ ?? null }));
}
