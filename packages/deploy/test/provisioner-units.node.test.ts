import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  CloudflareApiError,
  CloudflareMalformedError,
  CloudflareNetworkError,
  CredentialsError,
  PROOF_PREFIX,
  assertProofName,
  createClient,
  createRedactor,
  fileKeyStore,
  fileStore,
  findSecrets,
  isCloudflareError,
  isProofName,
  isWriteCall,
  loadCredentials,
  loadOrCreateAccessKey,
  memoryKeyStore,
  memoryStore,
  newSuffix,
  openLedger,
  resourceNames,
} from "../src/provisioner/index.ts";
import type { CallRecord } from "../src/provisioner/index.ts";

const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const scratch = mkdtempSync(join(tmpdir(), "prov-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("hiding secrets", () => {
  const hide = createRedactor([TOKEN, ACCOUNT]);

  test("hides a secret wherever it appears, in its plain, URL-encoded and JSON-escaped forms", () => {
    expect(hide(`token ${TOKEN} and account ${ACCOUNT}`)).toBe("token [hidden] and account [hidden]");
    expect(hide(`?t=${encodeURIComponent("a b&c=d")}`)).toBe("?t=a%20b%26c%3Dd"); // nothing registered, nothing hidden
    const tricky = createRedactor(['pa"ss\\word+/=value']);
    expect(tricky('{"x":"pa\\"ss\\\\word+/=value"}')).toBe('{"x":"[hidden]"}');
    expect(tricky(`/x?k=${encodeURIComponent('pa"ss\\word+/=value')}`)).toBe("/x?k=[hidden]");
  });

  test("leaves ordinary text alone and hides every occurrence", () => {
    expect(hide("nothing secret here")).toBe("nothing secret here");
    expect(hide(`${TOKEN}${TOKEN} ${ACCOUNT}`)).toBe("[hidden][hidden] [hidden]");
  });

  test("a value too short to be a secret is not hidden, so ordinary words survive", () => {
    expect(createRedactor(["abc", ""])("abc abc")).toBe("abc abc");
  });

  test("a longer secret that contains a shorter one is hidden whole", () => {
    expect(createRedactor(["secret-12", "secret-12-and-more"])("x secret-12-and-more y")).toBe("x [hidden] y");
  });

  test("findSecrets names which secrets are present, including URL-encoded", () => {
    expect(findSecrets(`a ${TOKEN} b`, { token: TOKEN, account: ACCOUNT })).toEqual(["token"]);
    expect(findSecrets(`id=${encodeURIComponent("some value/with+chars")}`, { weird: "some value/with+chars" })).toEqual(["weird"]);
    expect(findSecrets("clean", { token: TOKEN })).toEqual([]);
  });
});

describe("where the credentials come from", () => {
  test("reads the two variables and nothing else", () => {
    expect(loadCredentials({ CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT })).toEqual({ token: TOKEN, accountId: ACCOUNT });
  });

  test.each([
    ["no token", { CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, /CLOUDFLARE_API_TOKEN is not set/],
    ["no account id", { CLOUDFLARE_API_TOKEN: TOKEN }, /CLOUDFLARE_ACCOUNT_ID is not set/],
    ["neither", {}, /CLOUDFLARE_API_TOKEN is not set; CLOUDFLARE_ACCOUNT_ID is not set/],
    ["an empty token", { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, /CLOUDFLARE_API_TOKEN is not set/],
    ["a token with a space in it", { CLOUDFLARE_API_TOKEN: "abc def", CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, /space, a line break or a quote/],
    ["a token with a line break", { CLOUDFLARE_API_TOKEN: "abc\ndef", CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, /space, a line break or a quote/],
    ["a token still wrapped in quotes", { CLOUDFLARE_API_TOKEN: `"${TOKEN}"`, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, /space, a line break or a quote/],
    ["an account id of the wrong length", { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "abc123" }, /32 hexadecimal/],
    ["an account id in capitals", { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT.toUpperCase() }, /32 hexadecimal/],
  ])("%s is refused, naming the variable and never showing a value", (_label, env, message) => {
    expect(() => loadCredentials(env)).toThrow(CredentialsError);
    try {
      loadCredentials(env);
    } catch (error) {
      expect((error as Error).message).toMatch(message);
      for (const value of Object.values(env)) if (value.length > 8) expect((error as Error).message).not.toContain(value);
    }
  });
});

describe("names the proof may touch", () => {
  test("a suffix gives three names that all carry the prefix", () => {
    expect(resourceNames("0a1b2c3d")).toEqual({ suffix: "0a1b2c3d", script: "projectx-poc-0a1b2c3d", database: "projectx-poc-0a1b2c3d-db", workflow: "projectx-poc-0a1b2c3d-graphs" });
  });

  test.each(["", "0a1b2c3", "0a1b2c3d4", "0A1B2C3D", "zzzzzzzz", "0a1b2c3d-", "../0a1b2c"])("suffix %j is refused", (suffix) => {
    expect(() => resourceNames(suffix)).toThrow();
  });

  test("a suffix is made from random bytes: 8 hex characters, different bytes give different suffixes", () => {
    expect(newSuffix(() => Uint8Array.from([1, 2, 3, 255]))).toBe("010203ff");
    expect(newSuffix(() => Uint8Array.from([9, 9, 9, 9]))).not.toBe(newSuffix(() => Uint8Array.from([9, 9, 9, 8])));
  });

  test.each([
    ["projectx-poc-0a1b2c3d", true],
    ["projectx-poc-0a1b2c3d-db", true],
    ["projectx-poc-", false],
    ["projectx-poc", false],
    ["production-db", false],
    ["my-projectx-poc-0a1b2c3d", false],
    ["PROJECTX-POC-0a1b2c3d", false],
    ["projectx-poc-0A1B", false],
    ["projectx-poc-../etc", false],
    ["projectx-poc-a b", false],
    ["projectx-poc-" + "a".repeat(80), false],
    ["", false],
  ])("isProofName(%j) is %s", (name, expected) => {
    expect(isProofName(name)).toBe(expected);
  });

  test("assertProofName refuses anything else, naming the name and the prefix", () => {
    expect(() => assertProofName("production-db")).toThrow(new RegExp(`refusing to touch "production-db".*${PROOF_PREFIX}`));
    expect(() => assertProofName("projectx-poc-0a1b2c3d")).not.toThrow();
  });
});

describe("the ledger", () => {
  const fixedNow = () => new Date("2026-10-21T01:02:03.000Z");

  test("a resource is written down as 'creating' before it exists, then 'created' with its id", () => {
    const store = memoryStore();
    const ledger = openLedger(store, () => "0a1b2c3d", fixedNow);
    ledger.planned("d1_database", "projectx-poc-0a1b2c3d-db");
    expect(store.snapshot()!.entries).toEqual([{ kind: "d1_database", name: "projectx-poc-0a1b2c3d-db", status: "creating", at: "2026-10-21T01:02:03.000Z" }]);
    ledger.created("d1_database", "projectx-poc-0a1b2c3d-db", "db-id-1");
    expect(store.snapshot()!.entries[0]).toMatchObject({ status: "created", id: "db-id-1" });
  });

  test("survives being opened again, keeping its suffix and entries", () => {
    const store = memoryStore();
    const first = openLedger(store, () => "0a1b2c3d");
    first.planned("worker_script", "projectx-poc-0a1b2c3d");
    first.created("worker_script", "projectx-poc-0a1b2c3d");
    const second = openLedger(store, () => "ffffffff");
    expect(second.suffix).toBe("0a1b2c3d");
    expect(second.has("worker_script", "projectx-poc-0a1b2c3d")).toBe(true);
  });

  test("refuses to record a name that is not the proof's", () => {
    const ledger = openLedger(memoryStore(), () => "0a1b2c3d");
    expect(() => ledger.planned("d1_database", "production-db")).toThrow(/does not carry the proof's prefix/);
  });

  test("created() for something never planned is an error, not a silent entry", () => {
    expect(() => openLedger(memoryStore(), () => "0a1b2c3d").created("workflow", "projectx-poc-0a1b2c3d-graphs")).toThrow(/never planned/);
  });

  test("a removed resource is no longer live", () => {
    const ledger = openLedger(memoryStore(), () => "0a1b2c3d");
    ledger.planned("worker_script", "projectx-poc-0a1b2c3d");
    ledger.created("worker_script", "projectx-poc-0a1b2c3d");
    ledger.removed("worker_script", "projectx-poc-0a1b2c3d");
    expect(ledger.has("worker_script", "projectx-poc-0a1b2c3d")).toBe(false);
    expect(ledger.entries()[0]!.status).toBe("removed");
  });

  test("in a file: written whole by renaming a temporary file, no temporary left behind, and read back", () => {
    const path = join(scratch, "ledger", "ledger.json");
    const ledger = openLedger(fileStore(path), () => "0a1b2c3d", fixedNow);
    ledger.planned("d1_database", "projectx-poc-0a1b2c3d-db");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ suffix: "0a1b2c3d", entries: [{ status: "creating" }] });
    expect(readdirSync(join(scratch, "ledger"))).toEqual(["ledger.json"]);
    expect(openLedger(fileStore(path), () => "ffffffff").suffix).toBe("0a1b2c3d");
  });

  test("a damaged ledger file stops the run instead of silently starting a new, empty ledger that would forget what exists", () => {
    const path = join(scratch, "damaged.json");
    writeFileSync(path, "{ this is not json");
    expect(() => openLedger(fileStore(path), () => "0a1b2c3d")).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
  });
});

describe("the access key", () => {
  const bytes = (fill: number) => (n: number) => new Uint8Array(n).fill(fill);

  test("a new key is 256 random bits as 64 hex characters, stored before it is returned", () => {
    const store = memoryKeyStore();
    const key = loadOrCreateAccessKey(store, bytes(0xab));
    expect(key).toBe("ab".repeat(32));
    expect(store.read()).toBe(key);
  });

  test("the stored key is reused, so a second deploy uploads the same secret", () => {
    const store = memoryKeyStore();
    const first = loadOrCreateAccessKey(store, bytes(1));
    expect(loadOrCreateAccessKey(store, bytes(2))).toBe(first);
  });

  test("a stored value that is too short to be a key is replaced", () => {
    expect(loadOrCreateAccessKey(memoryKeyStore("short"), bytes(7))).toBe("07".repeat(32));
  });

  test("in a file: written, read back, trailing newline ignored", () => {
    const path = join(scratch, "keys", "access.key");
    const store = fileKeyStore(path);
    const key = loadOrCreateAccessKey(store, bytes(5));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(`${key}\n`);
    expect(loadOrCreateAccessKey(fileKeyStore(path), bytes(9))).toBe(key);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe("the Cloudflare client", () => {
  const credentials = { token: TOKEN, accountId: ACCOUNT };
  const ok = (result: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status, headers: { "content-type": "application/json", ...headers } });
  const refuse = (status: number, code: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }), { status });

  function clientWith(handler: (request: Request, n: number) => Response | Promise<Response>) {
    const seen: Request[] = [];
    const bodies: string[] = [];
    const sleeps: number[] = [];
    let ticks = 0;
    const client = createClient({
      credentials,
      fetch: async (request) => {
        seen.push(request.clone());
        bodies.push(await request.clone().text());
        return handler(request, seen.length);
      },
      sleep: async (ms) => void sleeps.push(ms),
      now: () => (ticks += 10),
    });
    return { client, seen, bodies, sleeps };
  }

  test("sends the token only as a bearer header, to the API's own address, never in the address or the body", async () => {
    const { client, seen, bodies } = clientWith(() => ok([{ uuid: "u1", name: "projectx-poc-0a1b2c3d-db" }]));
    await client.listDatabases("projectx-poc-0a1b2c3d-db");
    await client.createDatabase("projectx-poc-0a1b2c3d-db").catch(() => undefined);
    for (const request of seen) {
      expect(request.url.startsWith("https://api.cloudflare.com/client/v4/accounts/")).toBe(true);
      expect(request.url).not.toContain(TOKEN);
      expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    for (const body of bodies) expect(body).not.toContain(TOKEN);
  });

  test("records each call without headers or bodies, with the account id hidden in the path", async () => {
    const { client } = clientWith(() => ok([]));
    await client.listDatabases("x");
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(Object.keys(call).sort()).toEqual(["atMs", "attempt", "method", "ms", "n", "outcome", "path", "status"]);
    expect(call.path).toBe("/accounts/{account}/d1/database?name=x");
    expect(JSON.stringify(client.calls)).not.toContain(ACCOUNT);
    expect(JSON.stringify(client.calls)).not.toContain(TOKEN);
  });

  test("a refusal from Cloudflare is an api error carrying the status, the codes and the answer, with the token hidden even if Cloudflare echoes it", async () => {
    const { client } = clientWith(() => refuse(403, 10000, `Authentication error for ${TOKEN}`));
    const error = await client.listDatabases().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    const e = error as CloudflareApiError;
    expect([e.status, e.codes, e.kind]).toEqual([403, [10000], "api_error"]);
    expect(e.message).toContain("HTTP 403, code 10000");
    expect(`${e.message} ${e.body} ${e.details.join()}`).not.toContain(TOKEN);
    expect(e.body).toContain("[hidden]");
    expect(client.calls[0]).toMatchObject({ outcome: "api_error", errorCodes: [10000] });
  });

  test("HTTP 200 with success false is still a refusal", async () => {
    const { client } = clientWith(() => new Response(JSON.stringify({ success: false, errors: [{ code: 7500, message: "no such table" }], result: null }), { status: 200 }));
    await expect(client.listDatabases()).rejects.toBeInstanceOf(CloudflareApiError);
  });

  test.each([
    ["a body that is not JSON", () => new Response("<html>Bad gateway</html>", { status: 200 }), /not JSON/],
    ["an answer with no result field", () => new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 }), /no result field/],
  ])("%s is a malformed answer, which is not a refusal", async (_label, answer, message) => {
    const { client } = clientWith(answer);
    const error = await client.listDatabases().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareMalformedError);
    expect((error as Error).message).toMatch(message);
    expect(error).not.toBeInstanceOf(CloudflareApiError);
  });

  test("a list endpoint that answers with something that is not a list is malformed", async () => {
    await expect(clientWith(() => ok({ not: "a list" })).client.listDatabases()).rejects.toBeInstanceOf(CloudflareMalformedError);
    await expect(clientWith(() => ok("nope")).client.listScripts()).rejects.toBeInstanceOf(CloudflareMalformedError);
  });

  test("a created database without an id is malformed, not trusted", async () => {
    await expect(clientWith(() => ok({ name: "x" })).client.createDatabase("x")).rejects.toBeInstanceOf(CloudflareMalformedError);
  });

  test("a read is tried up to three times when the network fails, then reported as a network error", async () => {
    const { client, seen, sleeps } = clientWith(() => {
      throw new TypeError(`fetch failed for ${TOKEN}`);
    });
    const error = await client.listDatabases().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareNetworkError);
    expect(seen).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(client.calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
  });

  test("a write is NOT repeated when the network fails, because it may have gone through", async () => {
    for (const run of [(c: ReturnType<typeof clientWith>["client"]) => c.createDatabase("x"), (c: ReturnType<typeof clientWith>["client"]) => c.uploadScript("s", { mainModule: "worker.mjs", code: "x", metadata: {} }), (c: ReturnType<typeof clientWith>["client"]) => c.deleteScript("s")]) {
      const { client, seen } = clientWith(() => {
        throw new TypeError("fetch failed");
      });
      await expect(run(client)).rejects.toBeInstanceOf(CloudflareNetworkError);
      expect(seen).toHaveLength(1);
    }
  });

  test("a read is repeated after a server error and succeeds; a write is not repeated and reports the refusal", async () => {
    const read = clientWith((_r, n) => (n < 3 ? refuse(503, 1000, "unavailable") : ok([])));
    await expect(read.client.listDatabases()).resolves.toEqual([]);
    expect(read.seen).toHaveLength(3);
    const write = clientWith(() => refuse(500, 1000, "internal"));
    await expect(write.client.createDatabase("x")).rejects.toBeInstanceOf(CloudflareApiError);
    expect(write.seen).toHaveLength(1);
  });

  test("being rate limited is waited out and repeated, for a write too (nothing was processed), but not forever", async () => {
    const limited = clientWith((_r, n) => (n < 3 ? new Response("{}", { status: 429, headers: { "retry-after": "2" } }) : ok({ uuid: "u1", name: "x" })));
    await expect(limited.client.createDatabase("x")).resolves.toEqual({ uuid: "u1", name: "x" });
    expect(limited.sleeps).toEqual([2000, 2000]);
    const forever = clientWith(() => new Response(JSON.stringify({ success: false, errors: [{ code: 971, message: "rate limited" }] }), { status: 429 }));
    await expect(forever.client.createDatabase("x")).rejects.toBeInstanceOf(CloudflareApiError);
    expect(forever.seen).toHaveLength(4);
  });

  test("a missing thing a caller treats as 'not there' comes back as null, not as an error", async () => {
    const { client } = clientWith(() => refuse(404, 10007, "not found"));
    await expect(client.getAccountSubdomain()).resolves.toBeNull();
    await expect(client.listVersions("s")).resolves.toBeNull();
    await expect(client.getScriptSubdomain("s")).resolves.toBeNull();
    await expect(client.deleteScript("s")).rejects.toBeInstanceOf(CloudflareApiError); // but deleting something absent is reported
  });

  test("a D1 query is classified as reading or writing by its SQL, and one statement or a batch has the documented shape", async () => {
    const { client, bodies } = clientWith(() => ok([{ results: [], meta: {} }]));
    await client.queryDatabase("db1", [{ sql: "SELECT 1", params: [] }]);
    await client.queryDatabase("db1", [{ sql: "  select name FROM t" }, { sql: "SELECT 2" }]);
    await client.queryDatabase("db1", [{ sql: "INSERT INTO t VALUES (?)", params: ["x"] }]);
    await client.queryDatabase("db1", [{ sql: "SELECT 1" }, { sql: "DELETE FROM t" }]);
    expect(client.calls.map((c) => c.sqlKind)).toEqual(["select", "select", "write", "write"]);
    expect(JSON.parse(bodies[0]!)).toEqual({ sql: "SELECT 1", params: [] });
    expect(JSON.parse(bodies[1]!)).toEqual({ batch: [{ sql: "  select name FROM t", params: [] }, { sql: "SELECT 2", params: [] }] });
    expect(client.calls.every((c) => c.path === "/accounts/{account}/d1/database/db1/query")).toBe(true);
  });

  test("a Worker upload is multipart: a JSON metadata part naming the main module, and the module itself", async () => {
    const { client, seen } = clientWith(() => ok({ etag: "e1", startup_time_ms: 9 }));
    const out = await client.uploadScript("projectx-poc-0a1b2c3d", { mainModule: "worker.mjs", code: "export default {};", metadata: { compatibility_date: "2026-10-01", bindings: [{ type: "secret_text", name: "K", text: "the-secret-value" }] } });
    expect(out).toEqual({ etag: "e1", startupTimeMs: 9 });
    const request = seen[0]!;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/projectx-poc-0a1b2c3d`);
    expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    const form = await request.formData();
    expect(JSON.parse(await (form.get("metadata") as File).text())).toMatchObject({ main_module: "worker.mjs", compatibility_date: "2026-10-01" });
    expect(await (form.get("worker.mjs") as File).text()).toBe("export default {};");
    // the secret travels in the upload (it has to) but is in no record of the call
    expect(JSON.stringify(client.calls)).not.toContain("the-secret-value");
  });

  test("the time of each call is recorded relative to the start, and attempts are counted", async () => {
    const { client } = clientWith(() => ok([]));
    await client.listDatabases();
    await client.listScripts();
    expect(client.calls[1]!.atMs).toBeGreaterThan(client.calls[0]!.atMs);
    expect(client.calls.map((c) => c.n)).toEqual([1, 2]);
  });

  test("isCloudflareError tells the three failures from any other error", () => {
    expect(isCloudflareError(new CloudflareNetworkError("GET", "/x", "down"))).toBe(true);
    expect(isCloudflareError(new Error("other"))).toBe(false);
    expect(isCloudflareError("text")).toBe(false);
  });

  test("a call counts as a write unless it is a GET or a D1 query that only reads", () => {
    const call = (method: string, path: string, sqlKind?: "select" | "write"): CallRecord => ({ n: 1, atMs: 0, method, path, status: 200, ms: 1, outcome: "ok", attempt: 1, ...(sqlKind ? { sqlKind } : {}) });
    const q = "/accounts/{account}/d1/database/db1/query";
    expect(isWriteCall(call("GET", "/accounts/{account}/d1/database"))).toBe(false);
    expect(isWriteCall(call("POST", q, "select"))).toBe(false);
    expect(isWriteCall(call("POST", q, "write"))).toBe(true);
    expect(isWriteCall(call("POST", q))).toBe(true); // a query nobody classified is assumed to write
    expect(isWriteCall(call("POST", "/accounts/{account}/d1/database", "select"))).toBe(true); // "select" on anything but a query endpoint proves nothing
    expect(isWriteCall(call("PUT", "/accounts/{account}/workers/scripts/s"))).toBe(true);
    expect(isWriteCall(call("DELETE", "/accounts/{account}/workers/scripts/s"))).toBe(true);
    expect(isWriteCall(call("POST", "/accounts/{account}/workers/scripts/s/subdomain"))).toBe(true);
  });
});
