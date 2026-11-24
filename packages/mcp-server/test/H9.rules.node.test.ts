import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { TOKENIZER, countTokens, firstPartySource } from "../../../test/support/tokens.ts";
import { FULL_SESSION, ONE_AT_A_TIME_SESSION, SMALL_SESSION, runSession } from "./support/session.ts";

// The rules of the H9 measurement, pinned before and apart from the measurement itself.

describe("the tokenizer", () => {
  test("is the one the evidence names", () => {
    expect(TOKENIZER).toBe("gpt-tokenizer 4.1.0, o200k_base");
  });

  test.each([
    ["", 0],
    ["hello world", 2],
    ["The quick brown fox jumps over the lazy dog.", 10],
    ['{"jsonrpc":"2.0","id":1,"method":"tools/list"}', 17],
  ])("counts %j as %i tokens (fixed values, so a different tokenizer or a length-based guess would be noticed)", (text, expected) => {
    expect(countTokens(text)).toBe(expected);
  });

  test("a longer text is never counted as fewer tokens, and counting is deterministic", () => {
    const text = "const x = 1;\n".repeat(50);
    expect(countTokens(text + text)).toBeGreaterThan(countTokens(text));
    expect(countTokens(text)).toBe(countTokens(text));
  });
});

describe("the first-party source count", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "h9-"));
    dirs.push(root);
    mkdirSync(join(root, "pkg", "src"), { recursive: true });
    mkdirSync(join(root, "pkg", "migrations"), { recursive: true });
    mkdirSync(join(root, "pkg", "test"), { recursive: true });
    mkdirSync(join(root, "pkg", "client"), { recursive: true });
    writeFileSync(join(root, "pkg", "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "pkg", "src", "a.test.ts"), "test('x', () => {});\n");
    writeFileSync(join(root, "pkg", "migrations", "0001.sql"), "CREATE TABLE t (id TEXT);\n");
    writeFileSync(join(root, "pkg", "brick.manifest.json"), '{"id":"pkg"}\n');
    writeFileSync(join(root, "pkg", "test", "x.test.ts"), "// a test\n");
    writeFileSync(join(root, "pkg", "client", "Widget.tsx"), "export const W = 1;\n");
    return root;
  };

  test("counts a brick's source, migrations and manifest, and leaves out tests and the widget", () => {
    const root = fixture();
    const count = firstPartySource({ root, packageDirs: ["pkg"], generated: {} });
    expect(count.files.map((f) => f.path).sort()).toEqual(["pkg/brick.manifest.json", "pkg/migrations/0001.sql", "pkg/src/a.ts"]);
  });

  test("a generated file that is a copy of a brick file is counted once in the total, but stays in the generated-only count", () => {
    const root = fixture();
    const sql = "CREATE TABLE t (id TEXT);\n";
    const count = firstPartySource({ root, packageDirs: ["pkg"], generated: { "migrations/0001_pkg__0001.sql": sql, "src/index.ts": "export default 1;\n" } });
    expect(count.deduplicated).toBe(1);
    const separate = firstPartySource({ root, packageDirs: ["pkg"], generated: {} });
    expect(count.total).toBe(separate.total + countTokens("export default 1;\n")); // the copied migration added nothing
    expect(count.generatedOnly).toBe(countTokens(sql) + countTokens("export default 1;\n")); // but it is a generated file
  });

  test("the total is the sum of the counted files, line endings do not change it, and a missing folder counts nothing", () => {
    const root = fixture();
    writeFileSync(join(root, "pkg", "src", "a.ts"), "export const a = 1;\r\n");
    const count = firstPartySource({ root, packageDirs: ["pkg", "no-such-package"], generated: {} });
    expect(count.total).toBe(count.files.reduce((sum, f) => sum + f.tokens, 0));
    expect(count.files.find((f) => f.path === "pkg/src/a.ts")!.tokens).toBe(countTokens("export const a = 1;\n"));
  });
});

describe("what a session records", () => {
  test("the transcript holds the handshake, the tool list and every call with its answer, and each message is counted on its own", async () => {
    const session = await runSession(SMALL_SESSION);
    const methods = session.exchanges.map((e) => e.rpc).filter(Boolean);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call", "tools/call", "tools/call"]);
    expect(session.exchanges.find((e) => e.rpc === "tools/list")!.responseTokens).toBeGreaterThan(500); // the tool list is part of the cost
    expect(session.rawTokens).toBe(session.exchanges.reduce((sum, e) => sum + countTokens(e.requestBody) + countTokens(e.responseBody), 0));
    expect(session.exchanges.every((e) => e.requestTokens >= 0 && e.responseTokens >= 0)).toBe(true);
  });

  test("a call counts as a tool call only when it is tools/call: the handshake and the tool list are not", async () => {
    expect((await runSession(SMALL_SESSION)).toolCalls).toBe(4);
    expect((await runSession(FULL_SESSION)).toolCalls).toBe(4);
    expect((await runSession(ONE_AT_A_TIME_SESSION)).toolCalls).toBe(6);
  });

  test("the model-visible count is part of the raw count, never larger", async () => {
    const session = await runSession(SMALL_SESSION);
    expect(session.modelVisibleTokens).toBeGreaterThan(0);
    expect(session.modelVisibleTokens).toBeLessThan(session.rawTokens);
  });

  test("build_project's answer holds none of the project's source", async () => {
    const session = await runSession(SMALL_SESSION);
    const answer = session.answers.at(-1)!;
    expect(answer.tool).toBe("build_project");
    expect(answer.text.length).toBeLessThan(400);
    expect(answer.text).not.toMatch(/CREATE TABLE|import |workspaceMiddleware/);
  });

  test("a session that builds nothing stores nothing and has no summary", async () => {
    const session = await runSession([{ tool: "list_bricks", args: {} }]);
    expect(session.summary).toBeNull();
    expect(session.stored).toEqual({});
  });
});
