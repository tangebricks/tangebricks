// UC2.8 AC2 + AC3: module size cap and a single definition site for the fidelity code registry.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIDELITY_CODES } from "@poc/assembler";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../");
const srcDir = resolve(__dirname, "../src");
const goldenDir = resolve(__dirname, "golden");

function listFiles(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? listFiles(path, ext) : path.endsWith(ext) ? [path] : [];
  });
}

describe("UC2.8 importer module layout", () => {
  it("AC2: no file under packages/integrations/src exceeds 400 lines", () => {
    const sizes = listFiles(srcDir, ".ts").map((file) => ({
      file: relative(repoRoot, file),
      lines: readFileSync(file, "utf8").split("\n").length,
    }));
    expect(sizes.length).toBeGreaterThan(5);
    expect(sizes.filter((s) => s.lines > 400)).toEqual([]);
  });
});

describe("UC2.8 fidelity code registry", () => {
  it("AC3: every registry code is declared exactly once across packages and scripts", () => {
    const roots = [join(repoRoot, "packages"), join(repoRoot, "scripts")];
    const files = roots.flatMap((root) => listFiles(root, ".ts")).filter((f) => !f.includes(`${join("packages", "integrations", "test")}`));
    const sources = files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
    for (const name of Object.keys(FIDELITY_CODES)) {
      const declaration = new RegExp(`^\\s*${name}:\\s*\\{\\s*code:\\s*"${name}"`, "m");
      const declaredIn = sources.filter((s) => declaration.test(s.text)).map((s) => s.file);
      expect(declaredIn, `${name} declarations`).toHaveLength(1);
    }
  });

  it("the importer emits codes only through the registry (no code string literals)", () => {
    const offenders = listFiles(srcDir, ".ts")
      .filter((f) => !f.endsWith("fidelity-codes.ts"))
      .filter((f) => /\bcode:\s*"[A-Z][A-Z0-9_]+"/.test(readFileSync(f, "utf8")))
      .map((f) => relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });

  it("every code in the golden reports is registered, with a matching default status", () => {
    const seen = new Map<string, { statuses: Set<string>; blocking: Set<boolean> }>();
    for (const file of listFiles(goldenDir, ".json").filter((f) => f.endsWith("import-report.json") || f.includes("fixtures"))) {
      const report = JSON.parse(readFileSync(file, "utf8")) as {
        entries: { code: string; status: string; blocking: boolean }[];
      };
      for (const e of report.entries) {
        const slot = seen.get(e.code) ?? { statuses: new Set(), blocking: new Set() };
        slot.statuses.add(e.status);
        slot.blocking.add(e.blocking);
        seen.set(e.code, slot);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    const registry = FIDELITY_CODES as Record<string, { defaultStatus: string; blocking: boolean } | undefined>;
    for (const [code, slot] of seen) {
      const info = registry[code];
      expect(info, `${code} must be in FIDELITY_CODES`).toBeDefined();
      expect([...slot.statuses], `${code} status`).toEqual([info!.defaultStatus]);
      // PARAM_LOCATION_UNSUPPORTED blocks only when the parameter is required.
      if (code !== "PARAM_LOCATION_UNSUPPORTED") {
        expect([...slot.blocking], `${code} blocking`).toEqual([info!.blocking]);
      }
    }
  });
});
