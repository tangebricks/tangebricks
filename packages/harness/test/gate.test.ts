import { describe, expect, test } from "vitest";
import { findDynamicEvaluation } from "../src/index.ts";

const rules = (source: string) => findDynamicEvaluation(source).map((h) => h.rule);

describe("findDynamicEvaluation (the C2 tripwire)", () => {
  test.each([
    ["eval('1 + 1')", "eval call"],
    ["const r = eval (code);", "eval call"],
    ["const f = new Function('a', 'return a');", "Function constructor"],
    ["const f = Function('a', 'return a');", "Function constructor"],
    ["const AsyncFunction = (async () => {}).constructor; new AsyncFunction('x');", "async or generator Function constructor"],
    ["const m = await import(path);", "dynamic import of a computed specifier"],
    ["const m = await import(`./${name}.js`);", "dynamic import of a computed specifier"],
    ["const u = 'data:text/javascript,export default 1';", "javascript data URL"],
  ])("flags %s", (source, rule) => {
    expect(rules(source)).toContain(rule);
  });

  test.each([
    "// eval('x') is not allowed here",
    "/* new Function('x') */",
    "/**\n * never call eval(x)\n */",
    "const total = evaluate(x);",
    "const retrieval = 1;",
    "const m = await import('./static.ts');",
    "const m = await import(`./static.ts`);",
    'import type { Thing } from "./thing.ts";',
    "myFunction(1);",
    "obj.Function(1);",
  ])("lets %j through", (source) => {
    expect(findDynamicEvaluation(source)).toEqual([]);
  });

  test("reports the line number in the original file", () => {
    const hits = findDynamicEvaluation("// header\n\nconst ok = 1;\neval('x');");
    expect(hits).toEqual([{ line: 4, rule: "eval call", text: "eval('x');" }]);
  });
});
