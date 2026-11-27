// The Prettier format gate. `pnpm format:check`'s command, run with the pinned Prettier and the repo's .prettierrc.json
// and .prettierignore copied into a temporary directory, must fail on a seeded unformatted file and name it, pass once
// the file is formatted, and leave the ignored files (H12's pinned glue files, JSON, Markdown, fixtures) alone.
// CI runs the same script in the gates job.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const prettierBin = join(repoRoot, "node_modules", "prettier", "bin", "prettier.cjs");
const scripts = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

/** The arguments of a `prettier ...` package script, so the test runs exactly what `pnpm <name>` runs. */
function prettierArgs(name: string): string[] {
  const command = scripts[name];
  expect(command, `package.json script ${name}`).toMatch(/^prettier /);
  return command!.split(" ").slice(1);
}

const UNFORMATTED = "export const answer = {a:1,b:'two'}\n";
const FORMATTED = 'export const answer = { a: 1, b: "two" };\n';

describe("Prettier format gate (temporary directory)", () => {
  let dir: string;

  function put(rel: string, text: string): void {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, "utf8");
  }
  function run(name: string): { status: number | null; output: string } {
    const r = spawnSync(process.execPath, [prettierBin, ...prettierArgs(name)], { cwd: dir, encoding: "utf8" });
    return { status: r.status, output: `${r.error?.message ?? ""}${r.stdout}${r.stderr}` };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "format-check-"));
    for (const file of [".prettierrc.json", ".prettierignore"]) copyFileSync(join(repoRoot, file), join(dir, file));
    put("src/clean.ts", FORMATTED);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails on a seeded unformatted file and names it", () => {
    put("src/seeded.ts", UNFORMATTED);
    const { status, output } = run("format:check");
    expect(status, output).not.toBe(0);
    expect(output).toContain("seeded.ts");
    expect(output).not.toContain("clean.ts");
  });

  it("passes once `pnpm format` has formatted the seeded file", () => {
    put("src/seeded.ts", UNFORMATTED);
    const write = run("format");
    expect(write.status, write.output).toBe(0);
    expect(readFileSync(join(dir, "src", "seeded.ts"), "utf8")).toBe(FORMATTED);
    const check = run("format:check");
    expect(check.status, check.output).toBe(0);
  });

  it("ignores pinned, generated, JSON and Markdown files", () => {
    const ignored = [
      "packages/deploy/client/test/H12.rehearsal.test.tsx",
      "bricks/credit-wallet/client/CreditWidget.tsx",
      "packages/assembler/catalog.generated.ts",
      "evidence/deployed/x.ts",
      "bricks/x/test/fixtures/y.ts",
      "_bmad-output/z.ts",
    ];
    for (const rel of ignored) put(rel, UNFORMATTED);
    const json = '{\n  "tags": [\n    "a"\n  ]\n}\n';
    const markdown = "*  not   prettier   markdown\n";
    put("integrations/x/integration.json", json);
    put("notes.md", markdown);
    const { status, output } = run("format:check");
    expect(status, output).toBe(0);
    const write = run("format");
    expect(write.status, write.output).toBe(0);
    for (const rel of ignored) expect(readFileSync(join(dir, rel), "utf8"), rel).toBe(UNFORMATTED);
    expect(readFileSync(join(dir, "integrations", "x", "integration.json"), "utf8")).toBe(json);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe(markdown);
  });
});
