// Breaks the MCP server on purpose, one way at a time, and prints how many tests fail in the workerd suite and in the
// official-client suite each time. Used while building story 4.6. Always restores what it touched.
// Usage: node scripts/mutate-mcp.ts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(root, rel), text);

function run(filter: string): string {
  const result = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", filter], { cwd: root, encoding: "utf8" });
  const out = (result.stdout + result.stderr).replace(/\x1B\[[0-9;]*m/g, "");
  const tests = out.split(/\r?\n/).find((l) => /^\s+Tests /.test(l))?.trim().replace(/^Tests\s+/, "") ?? "(no summary)";
  const first = [...out.matchAll(/^ FAIL .*? > (.*)$/gm)].map((m) => m[1]!.slice(0, 60))[0];
  return `${tests}${first ? " [" + first + "]" : ""}`;
}

const M = "packages/mcp-server/src/mcp.ts";
const T = "packages/mcp-server/src/tools.ts";
const S = "packages/mcp-server/src/store.ts";
const cases: Array<{ name: string; file: string; from: string; to: string }> = [
  { name: "no token configured lets everyone in", file: M, from: "if (!expected) return json(c, 503,", to: "if (false as boolean) return json(c, 503," },
  { name: "the token is not checked", file: M, from: "if (given === undefined || !(await sameSecret(given, expected)))", to: "if (false as boolean)" },
  { name: "the token is compared with a plain equality (prefix check)", file: M, from: "!(await sameSecret(given, expected))", to: "!expected.startsWith(given)" },
  { name: "any Origin is allowed", file: M, from: "if (origin !== undefined && !allowedOrigins.has(origin))", to: "if (false as boolean)" },
  { name: "an unsupported protocol version is accepted", file: M, from: "if (version !== undefined && version !== PROTOCOL_VERSION)", to: "if (false as boolean)" },
  { name: "a list is accepted by answering its first message", file: M, from: 'if (typeof message !== "object" || message === null || Array.isArray(message))', to: 'if (Array.isArray(message)) message = message[0];\n    if (typeof message !== "object" || message === null)' },
  { name: "a notification gets a JSON answer instead of 202", file: M, from: 'if (!("id" in rpc)) return new Response(null, { status: 202 });', to: 'if (!("id" in rpc)) return json(c, 200, rpcResult(0, {}));' },
  { name: "GET opens a stream instead of 405", file: M, from: 'app.get("/mcp", notAllowed);', to: 'app.get("/mcp", () => new Response("stream", { headers: { "content-type": "text/event-stream" } }));' },
  { name: "the request id is not echoed", file: M, from: 'const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });', to: 'const rpcResult = (_id: Id, result: unknown) => ({ jsonrpc: "2.0" as const, id: 1, result });' },
  { name: "bad arguments are a protocol error instead of a tool error", file: M, from: "if (!checked.ok) return json(c, 200, rpcResult(id, { content: [{ type: \"text\", text: `Invalid arguments: ${checked.message}` }], isError: true }));", to: "if (!checked.ok) return json(c, 200, rpcError(id, ERR.invalidParams, checked.message));" },
  { name: "a tool failure is not flagged isError", file: M, from: "...(result.isError ? { isError: true } : {})", to: "" },
  { name: "the rate limit is not applied", file: M, from: "if (!(await withinRateLimit(c.env.DB, callsPerMinute)))", to: "if (false as boolean)" },
  { name: "an internal error leaks its cause", file: M, from: 'return json(c, 200, rpcError(id, ERR.internal, "internal error"));', to: 'return json(c, 200, rpcError(id, ERR.internal, String(error)));' },
  { name: "the server assigns a session id (header)", file: M, from: 'const json = (c: Ctx, status: 200 | 400 | 401 | 403 | 406 | 413 | 415 | 429 | 503, body: unknown, headers: Record<string, string> = {}) =>\n    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });', to: 'const json = (c: Ctx, status: 200 | 400 | 401 | 403 | 406 | 413 | 415 | 429 | 503, body: unknown, headers: Record<string, string> = {}) =>\n    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "mcp-session-id": "abc123", ...headers } });' },
  { name: "build_project returns the files", file: T, from: "return ok({ project: args.project, ...summary, bricks: assembled.order,", to: "return ok({ project: args.project, ...summary, files: assembled.files, bricks: assembled.order," },
  { name: "build_project stores nothing", file: T, from: "const summary = await storeBuild(db, args.project, assembled.files);", to: "const summary = { files: Object.keys(assembled.files).length, bytes: 1, hash: 'x'.repeat(64) };" },
  { name: "build_project stores a different project from the one it assembled", file: T, from: "const summary = await storeBuild(db, args.project, assembled.files);", to: "const summary = await storeBuild(db, args.project, { ...assembled.files, 'src/extra.ts': '// extra' });" },
  { name: "enable_brick does not check the brick", file: T, from: "if (problems.length > 0) return refuse(...problems, \"nothing was changed\");", to: "" },
  { name: "define_entity does not check the entity against the other entities", file: T, from: "const all = parseEntities([...others, ...declared], reserved);", to: "const all = { ok: true as const, entities: [...others, ...declared] };" },
  { name: "enable_brick checks only the first brick of a list", file: T, from: "problems.push(...checkBrickConfig(id, config, catalog));", to: "if (id === wanted[0]!.id) problems.push(...checkBrickConfig(id, config, catalog));" },
  { name: "enable_brick does not notice a brick listed twice", file: T, from: 'if (seen.has(id)) problems.push(`brick "${id}" is listed twice`);', to: "" },
  { name: "enable_brick applies the good bricks and skips the bad ones", file: T, from: 'if (problems.length > 0) return refuse(...problems, "nothing was changed");\n    const result = await mutateProject(db, args.project, (current) => ({\n      ok: true,\n      blueprint: { ...current, bricks: [...current.bricks.filter((b) => !seen.has(b.id)), ...wanted]', to: 'const result = await mutateProject(db, args.project, (current) => ({\n      ok: true,\n      blueprint: { ...current, bricks: [...current.bricks.filter((b) => !seen.has(b.id)), ...wanted.filter((w) => catalog.bricks[w.id])]' },
  { name: "enable_brick drops the bricks a list does not name", file: T, from: "bricks: [...current.bricks.filter((b) => !seen.has(b.id)), ...wanted]", to: "bricks: [...wanted]" },
  { name: "enable_brick keeps a brick's old settings when it is listed again", file: T, from: "bricks: [...current.bricks.filter((b) => !seen.has(b.id)), ...wanted]", to: "bricks: [...current.bricks, ...wanted.filter((w) => !current.bricks.some((b) => b.id === w.id))]" },
  { name: "a list may carry any number of items", file: T, from: "const MAX_PER_CALL = 20;", to: "const MAX_PER_CALL = 5000;" },
  { name: "define_entity stores only the first table of a list", file: T, from: "const declared = alone.entities;", to: "const declared = alone.entities.slice(0, 1);" },
  { name: "define_entity drops the tables a list does not name", file: T, from: 'const others = current.entities.filter((e) => !names.has((e as { name?: string }).name ?? ""));', to: "const others: unknown[] = [];" },
  { name: "define_entity quietly merges a table listed twice", file: T, from: "const alone = parseEntities(args.entities, reserved);", to: "const alone = parseEntities(args.entities.filter((e, i, all) => all.findIndex((x) => (x as { name: string }).name === (e as { name: string }).name) === i), reserved);" },
  { name: "an item that fits no allowed form is reported as a bare Invalid input", file: T, from: 'if (issue.code === "invalid_union" && issue.errors) {', to: "if (false as boolean) {" },
  { name: "define_entity ignores brick route names", file: T, from: "const reserved = reservedRoutes(catalog);", to: "const reserved = new Set<string>();" },
  { name: "the rate limit window never resets (all calls share one counter)", file: S, from: "const window = new Date(Math.floor(now / 60_000) * 60_000).toISOString();", to: "const window = 'forever';" },
  { name: "a change is written without checking the version (the lost update)", file: S, from: "WHERE project = ? AND version = ?\")\n        .bind(text, project, existing.version)", to: "WHERE project = ? AND ? IS NOT NULL\")\n        .bind(text, project, existing.version)" },
  { name: "a failed change leaves the project half-written", file: S, from: "if (!result.ok) return result;\n    const text", to: "if (!result.ok) { await db.prepare(\"INSERT OR IGNORE INTO mcp_projects (project, blueprint, version) VALUES (?, '{\\\"bricks\\\":[],\\\"entities\\\":[]}', 1)\").bind(project).run(); return result; }\n    const text" },
  { name: "build_project does not replace the old files (leftovers stay)", file: S, from: 'db.prepare("DELETE FROM mcp_files WHERE project = ?").bind(project),', to: "" },
];

console.log(`baseline                                                    -> workerd ${run("packages/mcp-server/test/mcp.test")} | store ${run("packages/mcp-server/test/store")} | official client ${run("packages/mcp-server/test/interop")}`);
for (const c of cases) {
  const original = read(c.file);
  if (!original.includes(c.from)) {
    console.log(`${c.name.padEnd(60)}-> MUTATION DID NOT APPLY`);
    continue;
  }
  write(c.file, original.replace(c.from, c.to));
  try {
    console.log(`${c.name.padEnd(60)}-> workerd ${run("packages/mcp-server/test/mcp.test")} | store ${run("packages/mcp-server/test/store")} | official client ${run("packages/mcp-server/test/interop")}`);
  } finally {
    write(c.file, original);
  }
}
console.log(`restored                                                    -> workerd ${run("packages/mcp-server/test/mcp.test")} | store ${run("packages/mcp-server/test/store")} | official client ${run("packages/mcp-server/test/interop")}`);
