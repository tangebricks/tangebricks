import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { compareProject, writeProject } from "../../../test/support/emitted.ts";

const made: string[] = [];
const scratch = () => {
  const out = mkdtempSync(join(tmpdir(), "poc-out-"));
  made.push(out);
  return out;
};
afterEach(() => made.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const files = { "src/index.ts": "export default 1;\n", "migrations/0001_a.sql": "SELECT 1;\n", "package.json": "{}\n" };

describe("writing a project and checking it later", () => {
  test("a project that was not touched compares as unchanged", async () => {
    const out = scratch();
    const hashes = await writeProject(join(out, "p"), files, out);
    expect(Object.keys(hashes)).toEqual(["migrations/0001_a.sql", "package.json", "src/index.ts"]);
    expect(await compareProject(join(out, "p"), hashes)).toEqual({ unchanged: true, checked: 3, changed: [], missing: [], extra: [] });
  });

  test.each([
    ["a changed byte", (dir: string) => writeFileSync(join(dir, "src/index.ts"), "export default 2;\n"), { changed: ["src/index.ts"], missing: [], extra: [] }],
    ["an appended newline", (dir: string) => writeFileSync(join(dir, "package.json"), "{}\n\n"), { changed: ["package.json"], missing: [], extra: [] }],
    ["a line-ending change", (dir: string) => writeFileSync(join(dir, "migrations/0001_a.sql"), "SELECT 1;\r\n"), { changed: ["migrations/0001_a.sql"], missing: [], extra: [] }],
    ["a deleted file", (dir: string) => rmSync(join(dir, "package.json")), { changed: [], missing: ["package.json"], extra: [] }],
    ["an added file", (dir: string) => writeFileSync(join(dir, "src/extra.ts"), "x"), { changed: [], missing: [], extra: ["src/extra.ts"] }],
    ["an added folder with a file", (dir: string) => (mkdirSync(join(dir, "hand-edit")), writeFileSync(join(dir, "hand-edit/fix.ts"), "x")), { changed: [], missing: [], extra: ["hand-edit/fix.ts"] }],
  ])("%s is reported", async (_label, tamper, expected) => {
    const out = scratch();
    const dir = join(out, "p");
    const hashes = await writeProject(dir, files, out);
    tamper(dir);
    const result = await compareProject(dir, hashes);
    expect(result).toMatchObject({ unchanged: false, ...expected });
    expect(result.checked).toBeGreaterThan(0);
  });

  test("writing again replaces the folder: a leftover file from an earlier run does not survive", async () => {
    const out = scratch();
    const dir = join(out, "p");
    await writeProject(dir, files, out);
    writeFileSync(join(dir, "leftover.ts"), "old");
    const hashes = await writeProject(dir, files, out);
    expect(await compareProject(dir, hashes)).toMatchObject({ unchanged: true });
  });

  test("it refuses to write outside the out folder, or a file path that climbs out of the project", async () => {
    const out = scratch();
    await expect(writeProject(join(out, "..", "elsewhere"), files, out)).rejects.toThrow(/outside/);
    await expect(writeProject(join(out, "p"), { "../escape.txt": "x" }, out)).rejects.toThrow(/leaves the project folder/);
    await expect(writeProject(out, files, out)).rejects.toThrow(/outside/);
  });
});
