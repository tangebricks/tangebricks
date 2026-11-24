import { describe, expect, test } from "vitest";
import portListJson from "../../../ported-tests.json";
import { PortListSchema, checkPortedTests } from "../src/ported.ts";
import type { PortList, TestOutcome } from "../src/ported.ts";

const list: PortList = {
  version: 1,
  about: "x",
  tests: [
    { title: "alpha", from: "a.test.ts", kind: "ported" },
    { title: "beta", from: "a.test.ts", kind: "rewritten", why: "reason" },
  ],
};
const ok = (name: string): TestOutcome => ({ name, state: "passed" });

describe("checkPortedTests", () => {
  test("passes when every listed test ran and passed, whatever describe block it sits in", () => {
    expect(checkPortedTests(list, [ok("alpha"), ok("group > nested > beta"), ok("unrelated")])).toEqual({ ok: true, problems: [] });
  });

  test("a listed test that does not exist is a problem, so it cannot be dropped quietly", () => {
    const out = checkPortedTests(list, [ok("alpha")]);
    expect(out.ok).toBe(false);
    expect(out.problems).toEqual(["not found: beta"]);
  });

  test.each(["failed", "skipped", "pending"])("a listed test that is %s is a problem", (state) => {
    const out = checkPortedTests(list, [ok("alpha"), { name: "beta", state }]);
    expect(out.ok).toBe(false);
    expect(out.problems).toEqual([`${state}: beta`]);
  });

  test("two tests with the same listed title are ambiguous, not a pass", () => {
    const out = checkPortedTests(list, [ok("alpha"), ok("beta"), ok("other > beta")]);
    expect(out.ok).toBe(false);
    expect(out.problems).toEqual(["ambiguous (2 tests): beta"]);
  });

  test("a test whose title merely ends with the listed text does not count", () => {
    expect(checkPortedTests(list, [ok("alpha"), ok("not beta")]).problems).toEqual(["not found: beta"]);
  });

  test("every problem is reported, not only the first", () => {
    expect(checkPortedTests(list, []).problems).toEqual(["not found: alpha", "not found: beta"]);
  });
});

describe("PortListSchema", () => {
  test("rejects a list that names a title twice", () => {
    expect(() => PortListSchema.parse({ ...list, tests: [list.tests[0], list.tests[0]] })).toThrow(/unique/);
  });

  test("rejects a rewritten or changed test with no reason", () => {
    expect(() => PortListSchema.parse({ ...list, tests: [{ title: "x", from: "f", kind: "rewritten" }] })).toThrow(/needs a reason/);
  });

  test("rejects an unknown kind and unknown keys", () => {
    expect(() => PortListSchema.parse({ ...list, tests: [{ title: "x", from: "f", kind: "copied" }] })).toThrow();
    expect(() => PortListSchema.parse({ ...list, extra: 1 })).toThrow();
  });
});

describe("the committed ported-tests.json", () => {
  const committed = PortListSchema.parse(portListJson);

  test("lists the 10 workspace-middleware tests, the 9 payment tests and the 3 deduction tests", () => {
    const count = (prefix: string) => committed.tests.filter((t) => t.from.startsWith(prefix)).length;
    expect(count("middleware/workspace.test.ts")).toBe(10);
    expect(count("routes/payments.test.ts")).toBe(9);
    expect(count("routes/clientGenerate.test.ts")).toBe(3);
    expect(committed.tests.length).toBe(22);
  });

  test("only the three deduction tests are rewritten, and only the two database-error tests change an assertion", () => {
    expect(committed.tests.filter((t) => t.kind === "rewritten").map((t) => t.from.split(",")[0])).toEqual([
      "routes/clientGenerate.test.ts",
      "routes/clientGenerate.test.ts",
      "routes/clientGenerate.test.ts",
    ]);
    expect(committed.tests.filter((t) => t.kind === "assertion-changed").map((t) => t.title)).toEqual([
      "should handle DB errors in workspaceMiddleware",
      "should handle DB errors in requireNotSuspended",
    ]);
  });
});
