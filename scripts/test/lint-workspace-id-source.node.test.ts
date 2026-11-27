import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { EXEMPTIONS, findClientWorkspaceReads } from "../lint-workspace-id-source.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts", "lint-workspace-id-source.ts");
const ROUTE = "bricks/x/src/routes.ts";
const lint = (text: string, path = ROUTE) => findClientWorkspaceReads([{ path, text }], []);

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("findClientWorkspaceReads", () => {
  test.each([
    ["double-quoted query", `const ws = c.req.query("workspaceId") || workspace?.id;`, "query"],
    ["single-quoted query", `const ws = c.req.query('workspaceId');`, "query"],
    ["backtick query", "const ws = c.req.query(`workspaceId`);", "query"],
    ["queries()", `const ws = c.req.queries("workspaceId");`, "query"],
    ["query().workspaceId", `const ws = c.req.query().workspaceId;`, "query"],
    ["parsed.data", `const ws = parsed.data.workspaceId || workspace?.id; c.req.json();`, "body-read"],
    ["body", `const ws = body.workspaceId || c.get("ctx")!.workspaceId; const x = c.req.json();`, "body-read"],
    ["json optional chain", `const ws = json?.workspaceId; c.req.json();`, "body-read"],
    ["data", `const ws = data.workspaceId; c.req.json();`, "body-read"],
    ["input", `const ws = input.workspaceId; c.req.json();`, "body-read"],
    ["payload", `const ws = payload.workspaceId; c.req.json();`, "body-read"],
    ["destructure", `const { workspaceId, name } = await c.req.json();`, "body-destructure"],
    ["zod schema", `const S = z.object({\n  name: z.string(),\n  workspaceId: z.string().optional(),\n}); c.req.json();`, "zod-schema"],
    ["result.data (any variable)", `const ws = result.data.workspaceId;`, "body-read"],
    ["(await c.req.json()).workspaceId", `const ws = (await c.req.json()).workspaceId;`, "body-read"],
    ['c.req.valid("json").workspaceId', `const ws = c.req.valid("json").workspaceId;`, "body-read"],
    ['c.req.valid("query").workspaceId', `const ws = c.req.valid("query").workspaceId;`, "query"],
    ["destructure from c.req.query()", `const { workspaceId } = c.req.query();`, "query"],
    ["destructure from parsed.data", `const { workspaceId } = parsed.data;`, "body-destructure"],
    ["zod schema in a file that never touches the request", `const S = z.object({ workspaceId: z.string() });`, "zod-schema"],
    ["input.workspaceId in a file that never touches the request", `await scoped(db, input.workspaceId).insert("t", {});`, "body-read"],
  ])("flags %s", (_label, text, rule) => {
    const reads = lint(text);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.map((r) => r.rule)).toContain(rule);
    expect(reads[0]!.file).toBe(ROUTE);
  });

  test("reports the line of the read", () => {
    const reads = lint(`import { Hono } from "hono";\n\nconst ws = c.req.query("workspaceId");`);
    expect(reads).toEqual([{ file: ROUTE, line: 3, rule: "query", snippet: `const ws = c.req.query("workspaceId");` }]);
  });

  test("a handler that takes the workspace from the verified context passes", () => {
    const clean = [
      `import { Hono } from "hono";`,
      `const Schema = z.object({ name: z.string() });`,
      `app.post("/x", async (c) => {`,
      `  const ctx = c.get("ctx");`,
      `  if (!ctx) return c.json({ error: "Missing workspace context" }, 400);`,
      `  const parsed = Schema.safeParse(await c.req.json());`,
      `  await service.create({ workspaceId: ctx.workspaceId, name: parsed.data.name });`,
      `  return c.json({ workspaceId: ctx.workspaceId, other: row.workspaceId });`,
      `});`,
    ].join("\n");
    expect(lint(clean)).toEqual([]);
  });

  test("service and executor files are allowed only through a named exemption with a reason", () => {
    const svc = "bricks/x/src/service.ts";
    const text = `await scoped(db, input.workspaceId).insert("t", {});`;
    expect(lint(text, svc)).toHaveLength(1);
    expect(findClientWorkspaceReads([{ path: svc, text }], [{ file: svc, rule: "body-read", reason: "test" }])).toEqual([]);
    // a body-read exemption does not cover a query read in the same file
    expect(
      findClientWorkspaceReads([{ path: svc, text: `const ws = c.req.query("workspaceId");` }], [{ file: svc, rule: "body-read", reason: "test" }]),
    ).toHaveLength(1);
    for (const e of EXEMPTIONS) {
      expect(e.rule).not.toBe("*");
      expect(e.reason.length).toBeGreaterThan(10);
    }
  });

  test("an exemption needs the exact file and rule", () => {
    const text = `const ws = c.req.query("workspaceId");`;
    expect(findClientWorkspaceReads([{ path: ROUTE, text }], [{ file: ROUTE, rule: "query", reason: "test" }])).toEqual([]);
    expect(findClientWorkspaceReads([{ path: ROUTE, text }], [{ file: ROUTE, rule: "body-read", reason: "test" }])).toHaveLength(1);
  });
});

describe("CLI", () => {
  const run = (bricksDir?: string) => spawnSync(process.execPath, [SCRIPT, ...(bricksDir ? ["--bricks-dir", bricksDir] : [])], { cwd: ROOT, encoding: "utf8" });

  test('exits 1 and prints file:line for a seeded c.req.query("workspaceId")', () => {
    const dir = mkdtempSync(join(tmpdir(), "ws-id-lint-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "seeded", "src"), { recursive: true });
    writeFileSync(join(dir, "seeded", "src", "routes.ts"), `export const h = (c: any) => {\n  return c.req.query("workspaceId");\n};\n`);
    const res = run(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/seeded[\\/]src[\\/]routes\.ts:2 \[query\]/);
  });

  test("exits 0 on the repo's bricks", () => {
    const res = run();
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
  });
});
