import { codeLines } from "./count-lines.ts";

export interface GateHit {
  line: number;
  rule: string;
  text: string;
}

const RULES: Array<[string, RegExp]> = [
  ["eval call", /\beval\s*\(/],
  ["Function constructor", /\bnew\s+Function\b|(^|[^.\w])Function\s*\(/],
  ["async or generator Function constructor", /\b(Async|Generator|AsyncGenerator)Function\b/],
  ["dynamic import of a computed specifier", /\bimport\s*\(\s*(?:[^"'`\s)]|`[^`]*\$\{)/],
  ["javascript data URL", /data:(text|application)\/javascript/],
];

/**
 * C2's tripwire: finds code that would build or evaluate code at run time. It reads code lines only,
 * so a comment that mentions eval is fine. It catches the usual routes, not a determined bypass
 * (for example a string assembled to look up `eval` on globalThis), so it is evidence, not proof.
 */
export function findDynamicEvaluation(source: string): GateHit[] {
  const hits: GateHit[] = [];
  for (const { line, text } of codeLines(source)) {
    for (const [rule, pattern] of RULES) {
      if (pattern.test(text)) hits.push({ line, rule, text });
    }
  }
  return hits;
}
