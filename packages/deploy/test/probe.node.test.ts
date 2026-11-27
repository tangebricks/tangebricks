import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { codeLines } from "@poc/harness";
import { createClient, describeProbe, findSecrets, forEvidence, onlyReads, runProbe } from "../src/provisioner/index.ts";
import type { CallRecord } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";
import type { FakeOptions } from "./support/fake-cloudflare.ts";

// Story 5.4: the read-only probe, against the fake. What it must never do is change anything, so every test that runs it
// also checks the fake's own record of what it was asked: only reads, and the account exactly as it was.
const root = resolve(import.meta.dirname, "..", "..", "..");
const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-10-21T00:00:00Z");
const GOOD_GROUPS = ["D1 Write", "Workers Scripts Write", "Account Settings Read"];

function world(options: Partial<FakeOptions> = {}) {
  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT, ...options });
  const client = createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch, sleep: async () => undefined });
  return { fake, client, probe: () => runProbe({ client, now: () => NOW }) };
}
const denied = (match: (path: string) => boolean) =>
  ({
    when: (m: string, p: string) => m === "GET" && match(p),
    respond: { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } },
  }) as const;

describe("a ready account", () => {
  test("is reported ready, with the name, the counts and the existing names, and the token's own list unreadable, as for a scoped token", async () => {
    const w = world();
    w.fake.seedDatabase("someone-elses-db");
    w.fake.seedScript("my-other-worker");
    const report = await w.probe();
    expect(report.token).toMatchObject({ reachable: true, status: "active", expiresOn: "2026-10-28T18:29:59Z", daysLeft: 7 });
    expect(report.permissionGroups.state).toBe("refused");
    expect(report.checks.subdomain).toEqual({ state: "readable", value: "fake-subdomain" });
    expect(report.checks.d1.value).toEqual(["someone-elses-db"]);
    expect(report.checks.scripts.value).toEqual(["my-other-worker"]);
    expect(report.checks.workflows).toMatchObject({ state: "readable", value: [] });
    expect(report.counts).toEqual({ databases: 1, scripts: 1, workflows: 0 });
    expect(report.missing).toEqual([]);
    expect(report.existingProofResources).toEqual([]);
    expect(report.ready).toBe(true);
  });

  test("says what reads cannot show: whether the token may write", async () => {
    const report = await world().probe();
    expect(report.notEstablished.join(" ")).toMatch(/may the token WRITE|WRITE to D1 and Workers Scripts/i);
  });

  test("when the token's own list is readable and has the write groups, that caveat is gone and nothing is missing", async () => {
    const report = await world({ tokenGroups: GOOD_GROUPS }).probe();
    expect(report.permissionGroups).toEqual({ state: "readable", value: ["Account Settings Read", "D1 Write", "Workers Scripts Write"] });
    expect(report.notEstablished).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.ready).toBe(true);
  });

  test("the dashboard's word 'Edit' counts as a write group, as 'Write' does", async () => {
    const report = await world({ tokenGroups: ["D1 Edit", "Workers Scripts Edit"] }).probe();
    expect(report.missing).toEqual([]);
  });

  test("when the token's own list is readable and lacks a write group, exactly that group is named as missing", async () => {
    const noD1 = await world({ tokenGroups: ["D1 Read", "Workers Scripts Write"] }).probe();
    expect(noD1.missing).toHaveLength(1);
    expect(noD1.missing[0]).toMatch(/^D1 Write/);
    expect(noD1.ready).toBe(false);
    const neither = await world({ tokenGroups: [] }).probe();
    expect(neither.missing.map((m) => m.split(" (")[0])).toEqual(["D1 Write", "Workers Scripts Write"]);
  });
});

describe("it changes nothing", () => {
  test("every request made is a GET, in the fake's own record and in the client's log, and the account is as it was", async () => {
    const w = world();
    w.fake.seedDatabase("keep-me");
    w.fake.seedScript("keep-me-too");
    const before = JSON.stringify(w.fake.state());
    await w.probe();
    expect(w.fake.requests.length).toBeGreaterThan(0);
    expect(w.fake.requests.map((r) => r.method)).toEqual(w.fake.requests.map(() => "GET"));
    expect(onlyReads(w.client.calls)).toBe(true);
    expect(JSON.stringify(w.fake.state())).toBe(before);
    expect(w.fake.bodies.every((b) => b === "")).toBe(true); // not one request carried a body
  });

  test("the requests are exactly: the token check, the token's own policies, the database list, the Worker list, the account's name, the Workflow list", async () => {
    const w = world();
    await w.probe();
    expect(w.fake.requests.map((r) => r.path.replace("/client/v4/accounts/{account}", ""))).toEqual([
      "/tokens/verify",
      "/tokens/fake-token-id",
      "/d1/database",
      "/workers/scripts",
      "/workers/subdomain",
      "/workflows",
    ]);
  });

  test("an account with no workers.dev name is reported as such, and the probe does not create one", async () => {
    const w = world({ subdomain: null });
    const report = await w.probe();
    expect(report.checks.subdomain).toEqual({ state: "readable", value: null });
    expect(report.ready).toBe(false);
    expect(report.notEstablished.join(" ")).toMatch(/no workers\.dev name yet.*choose one in the dashboard.*does not create it/);
    expect(w.fake.requests.some((r) => r.method !== "GET")).toBe(false);
    expect(w.fake.state()).toEqual({ databases: [], scripts: [], workflows: [] });
  });

  test("onlyReads is false for any write and for an empty log", () => {
    const call = (method: string): CallRecord => ({ n: 1, atMs: 0, method, path: "/x", status: 200, ms: 1, outcome: "ok", attempt: 1 });
    expect(onlyReads([call("GET"), call("GET")])).toBe(true);
    expect(onlyReads([call("GET"), call("POST")])).toBe(false);
    expect(onlyReads([call("GET"), call("DELETE")])).toBe(false);
    expect(onlyReads([call("PUT")])).toBe(false);
    expect(onlyReads([])).toBe(false);
  });
});

describe("what is missing", () => {
  test("a refused database list names D1 and nothing else", async () => {
    const w = world();
    w.fake.fail(denied((p) => p.endsWith("/d1/database")));
    const report = await w.probe();
    expect(report.checks.d1).toMatchObject({ state: "refused", status: 403, codes: [10000] });
    expect(report.missing).toEqual(["D1 (Read or Write)"]);
    expect(report.ready).toBe(false);
  });

  test("a refused Worker list names Workers Scripts, once, even if the account name is refused too", async () => {
    const w = world();
    w.fake.fail(denied((p) => p.endsWith("/workers/scripts") || p.endsWith("/workers/subdomain")));
    const report = await w.probe();
    expect(report.missing).toEqual(["Workers Scripts (Read or Write)"]);
  });

  test("a refused Workflow list names the permission that covers Workflows, without calling it a failure of the others", async () => {
    const w = world();
    w.fake.fail(denied((p) => p.endsWith("/workflows")));
    const report = await w.probe();
    expect(report.missing).toHaveLength(1);
    expect(report.missing[0]).toMatch(/covers Workflows/);
    expect(report.checks.d1.state).toBe("readable");
  });

  test("a Workflow list that is 'not found' is a wrong guess about the address, not a missing permission", async () => {
    const w = world();
    w.fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/workflows"),
      respond: { status: 404, body: { success: false, errors: [{ code: 7003, message: "No route for that URI" }] } },
    });
    const report = await w.probe();
    expect(report.checks.workflows.state).toBe("not_found");
    expect(report.missing).toEqual([]);
    expect(report.notEstablished.join(" ")).toMatch(/Workflows list request.*guess/);
    expect(report.ready).toBe(true); // it is only used to look for leftovers
  });

  test("a network failure or a server error is 'failed', which is neither a missing permission nor a pass", async () => {
    const w = world();
    w.fake.fail({ when: (m, p) => m === "GET" && p.endsWith("/d1/database"), respond: "network-error" });
    w.fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/workflows"),
      respond: { status: 500, body: { success: false, errors: [{ code: 1000, message: "internal" }] } },
    });
    const report = await w.probe();
    expect(report.checks.d1.state).toBe("failed");
    expect(report.checks.workflows.state).toBe("failed");
    expect(report.missing).toEqual([]);
    expect(report.ready).toBe(false); // the database list could not be read, so it is not ready
    expect(report.notEstablished.join(" ")).toMatch(/failed for a reason other than permission/);
  });

  test("an answer that is not what the API documents is 'failed' too", async () => {
    const w = world();
    w.fake.fail({ when: (m, p) => m === "GET" && p.endsWith("/workers/scripts"), respond: { status: 200, text: "<html>maintenance</html>" } });
    const report = await w.probe();
    expect(report.checks.scripts.state).toBe("failed");
    expect(report.ready).toBe(false);
  });
});

describe("the token", () => {
  test("a token Cloudflare does not accept stops the probe after the two verify requests (account, then user endpoint), with nothing else attempted", async () => {
    const w = world();
    const wrong = createClient({
      credentials: { token: "cfut_wrong_wrong_wrong_wrong_wrong_wrong_wrong_1234", accountId: ACCOUNT },
      fetch: w.fake.fetch,
      sleep: async () => undefined,
    });
    const report = await runProbe({ client: wrong, now: () => NOW });
    expect(report.token.reachable).toBe(false);
    expect(report.ready).toBe(false);
    expect(report.missing[0]).toMatch(/working token/);
    // story R53: a user token verifies only at /user/tokens/verify, so a refused token is asked at both endpoints, and nothing else
    expect(w.fake.requests.map((r) => r.path)).toEqual(["/client/v4/accounts/{account}/tokens/verify", "/client/v4/user/tokens/verify"]);
  });

  test("a token that is not active stops the probe after the check", async () => {
    const w = world();
    w.fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/tokens/verify"),
      respond: { status: 200, body: { success: true, errors: [], result: { id: "fake-token-id", status: "disabled" } } },
    });
    const report = await w.probe();
    expect(report.token).toMatchObject({ reachable: true, status: "disabled" });
    expect(report.token.note).toMatch(/"disabled", not "active"/);
    expect(report.ready).toBe(false);
    expect(w.fake.requests).toHaveLength(1);
  });

  test("days left are counted from the expiry date, and under one day is not ready", async () => {
    expect((await world({ expiresOn: "2026-10-24T00:00:00Z" }).probe()).token.daysLeft).toBe(3);
    const soon = await world({ expiresOn: "2026-10-21T12:00:00Z" }).probe();
    expect(soon.token.daysLeft).toBe(0);
    expect(soon.ready).toBe(false);
    expect(soon.notEstablished.join(" ")).toMatch(/expires in 0 day/);
  });

  test("a token without an expiry date is reported as having none", async () => {
    const w = world();
    w.fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/tokens/verify"),
      respond: { status: 200, body: { success: true, errors: [], result: { id: "fake-token-id", status: "active" } } },
    });
    const report = await w.probe();
    expect(report.token.expiresOn).toBeNull();
    expect(report.token.daysLeft).toBeNull();
    expect(describeProbe(report)[0]).toContain("no expiry date");
  });
});

describe("what it prints and writes", () => {
  test("leftovers with the proof's prefix are reported, not touched", async () => {
    const w = world();
    w.fake.seedDatabase("projectx-poc-deadbeef-db");
    w.fake.seedScript("projectx-poc-deadbeef");
    w.fake.seedDatabase("not-ours");
    const report = await w.probe();
    expect(report.existingProofResources).toEqual([
      { kind: "d1_database", name: "projectx-poc-deadbeef-db" },
      { kind: "worker_script", name: "projectx-poc-deadbeef" },
    ]);
    expect(w.fake.state().databases).toHaveLength(2);
    expect(describeProbe(report).join("\n")).toContain("reported, never touched");
  });

  test("the console text lists the owner's existing names; the evidence version keeps only this proof's own", async () => {
    const w = world();
    w.fake.seedDatabase("customers-prod");
    w.fake.seedScript("billing-worker");
    w.fake.seedScript("projectx-poc-deadbeef");
    const report = await w.probe();
    const shown = describeProbe(report, {
      databases: report.checks.d1.value,
      scripts: report.checks.scripts.value,
      workflows: report.checks.workflows.value,
      subdomain: report.checks.subdomain.value,
    }).join("\n");
    expect(shown).toContain("customers-prod");
    expect(shown).toContain("billing-worker");
    expect(shown).toContain("fake-subdomain.workers.dev");
    const kept = JSON.stringify(forEvidence(report));
    expect(kept).not.toContain("customers-prod");
    expect(kept).not.toContain("billing-worker");
    expect(kept).toContain("projectx-poc-deadbeef");
    expect(forEvidence(report).counts).toEqual({ databases: 1, scripts: 2, workflows: 0 }); // counts still tell the whole story
  });

  test("with no details given, the console text still says what it found", async () => {
    const lines = describeProbe(await world().probe());
    expect(lines.some((l) => l.startsWith("token: active"))).toBe(true);
    expect(lines.at(-1)).toBe("ready: yes, as far as reads can show");
  });

  test("neither the token nor the account id appears in the report, the text, the evidence or the call log, even when Cloudflare echoes them back", async () => {
    const w = world({ tokenGroups: GOOD_GROUPS });
    w.fake.fail({
      when: (m, p) => m === "GET" && p.endsWith("/workflows"),
      respond: { status: 403, body: { success: false, errors: [{ code: 10000, message: `denied for ${TOKEN} on account ${ACCOUNT}` }] } },
    });
    const report = await w.probe();
    const everything = [JSON.stringify(report), JSON.stringify(forEvidence(report)), describeProbe(report).join("\n"), JSON.stringify(w.client.calls)].join(
      "\n",
    );
    expect(findSecrets(everything, { token: TOKEN, accountId: ACCOUNT })).toEqual([]);
    expect(report.checks.workflows.note).toContain("[hidden]");
  });

  test("the call log shows the account as {account} and the token's id as {token-id}, and carries no header or body", async () => {
    const w = world();
    await w.probe();
    expect(w.client.calls.map((c) => c.path)).toContain("/accounts/{account}/tokens/{token-id}");
    expect(JSON.stringify(w.client.calls)).not.toContain("fake-token-id");
    for (const call of w.client.calls) {
      expect(call.path).toContain("{account}");
      const allowed = new Set(["atMs", "attempt", "errorCodes", "method", "ms", "n", "outcome", "path", "sqlKind", "status"]);
      for (const key of Object.keys(call)) expect(allowed.has(key), key).toBe(true);
    }
  });
});

describe("the probe's own source and command", () => {
  const code = (rel: string) =>
    codeLines(readFileSync(join(root, rel), "utf8"))
      .map((l) => l.text)
      .join("\n");

  test("the probe library calls only the client's read methods", () => {
    const source = code("packages/deploy/src/provisioner/probe.ts");
    const called = new Set([...source.matchAll(/client\.(\w+)\(/g)].map((m) => m[1]));
    expect([...called].sort()).toEqual(["getAccountSubdomain", "getTokenPermissions", "hide", "listDatabases", "listScripts", "listWorkflows", "verifyToken"]);
    expect(source).not.toMatch(/\.(create|upload|delete|set|query)\w*\(/);
  });

  test("the command starts no program, reads the environment only through loadCredentials, and writes one file", () => {
    const source = code("scripts/poc-probe.ts");
    expect(source).not.toMatch(/child_process|\bspawn\w*\s*\(|\bexec\w*\s*\(|\bwrangler\b/);
    expect(source).not.toMatch(/process\.env\.\w|process\.env\[/);
    expect(source.match(/writeFileSync\(/g)).toHaveLength(1);
    expect(source).toContain("onlyReads(client.calls)");
    expect(source).toContain("findSecrets(text");
  });

  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [join(root, "scripts", "poc-probe.ts")], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env },
      encoding: "utf8",
      timeout: 30_000,
    });

  test("with no credentials it stops before any request and names the missing variables", () => {
    const result = run({});
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/CLOUDFLARE_API_TOKEN is not set; CLOUDFLARE_ACCOUNT_ID is not set/);
    expect(result.stdout).toBe("");
  });

  test("with a damaged token it says so without repeating the value", () => {
    const token = "has a space inside secretvalue12345";
    const result = run({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/CLOUDFLARE_API_TOKEN has a space/);
    expect(result.stderr + result.stdout).not.toContain("secretvalue12345");
    expect(result.stderr + result.stdout).not.toContain("0123456789abcdef0123456789abcdef");
  });
});
