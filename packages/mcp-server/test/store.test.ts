import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { catalog } from "@poc/assembler/catalog";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_mcp_server.sql?raw";
import {
  DEFAULT_MCP_AUTHOR,
  MAX_PROJECTS,
  createDurableObjectBlueprintClient,
  createInMemoryBlueprintClient,
  storeBuild,
  withinRateLimit,
} from "../src/index.ts";
import type { BlueprintDoNamespaceLike } from "../src/index.ts";

const db = env.DB as D1Like;
const doNamespace = (env as unknown as { BLUEPRINT_DO: BlueprintDoNamespaceLike }).BLUEPRINT_DO;

beforeEach(async () => {
  expect.hasAssertions();
  for (const table of ["mcp_files", "mcp_builds", "mcp_projects", "mcp_rate"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, migration);
});

describe("BlueprintClient over BlueprintDO in workerd and in-memory adapter", () => {
  it("routes mutations and reads through BlueprintDO with agent author attribution and writes zero rows to mcp_projects", async () => {
    const client = createDurableObjectBlueprintClient(doNamespace);
    const project = "do-client-test";

    expect(await client.getProject(project)).toBeNull();

    const r1 = await client.applyOps({
      project,
      author: { type: "agent", id: "agent:claude", client: "claude-code" },
      ops: [
        { opId: "s-1", type: "enable_brick", brickId: "multi-workspace" },
        {
          opId: "s-2",
          type: "enable_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 10 },
        },
      ],
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.revision).toBe(1);
    expect(r1.data.author).toEqual({
      type: "agent",
      id: "agent:claude",
      client: "claude-code",
    });

    const loaded = await client.getProject(project);
    expect(loaded?.revision).toBe(1);
    expect(loaded?.state.bricks.map((b) => b.id)).toEqual([
      "credit-wallet",
      "multi-workspace",
    ]);

    // Verify mcp_projects is never touched
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM mcp_projects").first<{ n: number }>())!.n,
    ).toBe(0);
  });

  it("auto-rebases non-overlapping concurrent batches and rejects overlapping ones with 409 CONFLICT", async () => {
    const client = createDurableObjectBlueprintClient(doNamespace);
    const project = "do-client-rebase";

    // Seed revision 1 with multi-workspace
    await client.applyOps({
      project,
      author: DEFAULT_MCP_AUTHOR,
      ops: [{ opId: "seed-1", type: "enable_brick", brickId: "multi-workspace" }],
    });

    // Two concurrent non-overlapping edits at baseRevision: 1
    const first = await client.applyOps({
      project,
      baseRevision: 1,
      author: DEFAULT_MCP_AUTHOR,
      ops: [{ opId: "add-cw", type: "enable_brick", brickId: "credit-wallet" }],
    });
    const second = await client.applyOps({
      project,
      baseRevision: 1,
      author: DEFAULT_MCP_AUTHOR,
      ops: [{ opId: "add-de", type: "enable_brick", brickId: "dynamic-entities" }],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.revision).toBe(3);
      expect(second.data.rebasedFrom).toBe(1);
      expect(second.data.state.bricks.map((b) => b.id)).toEqual([
        "credit-wallet",
        "dynamic-entities",
        "multi-workspace",
      ]);
    }

    // Overlapping edit at stale baseRevision: 1 on credit-wallet -> 409 CONFLICT
    const conflict = await client.applyOps({
      project,
      baseRevision: 1,
      author: DEFAULT_MCP_AUTHOR,
      ops: [
        {
          opId: "overlap-cw",
          type: "configure_brick",
          brickId: "credit-wallet",
          config: { creditsPerUnit: 50 },
        },
      ],
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.status).toBe(409);
      expect(conflict.error.code).toBe("CONFLICT");
    }
  });

  it("a refused change writes nothing, and a first change that is refused creates no project", async () => {
    const client = createDurableObjectBlueprintClient(doNamespace);
    const refused = await client.applyOps({
      project: "refused-project",
      author: DEFAULT_MCP_AUTHOR,
      ops: [{ opId: "bad-1", type: "enable_brick", brickId: "no-such-brick" }],
    });
    expect(refused.ok).toBe(false);
    expect(await client.getProject("refused-project")).toBeNull();
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM mcp_projects").first<{ n: number }>())!.n,
    ).toBe(0);
  });
});

describe("limits", () => {
  it("in-memory BlueprintClient adapter enforces MAX_PROJECTS while allowing existing projects to change", async () => {
    const memClient = createInMemoryBlueprintClient(catalog, 3);
    for (let i = 0; i < 3; i += 1) {
      const res = await memClient.applyOps({
        project: `p-${i}`,
        author: DEFAULT_MCP_AUTHOR,
        ops: [{ opId: `op-${i}`, type: "enable_brick", brickId: "multi-workspace" }],
      });
      expect(res.ok).toBe(true);
    }

    const over = await memClient.applyOps({
      project: "p-overflow",
      author: DEFAULT_MCP_AUTHOR,
      ops: [{ opId: "op-over", type: "enable_brick", brickId: "multi-workspace" }],
    });
    expect(over.ok).toBe(false);
    if (!over.ok && over.status === 422) {
      expect(over.error.issues[0]?.message).toMatch(/at most 3 projects/);
    }
    expect(await memClient.getProject("p-overflow")).toBeNull();

    // Existing project can still be updated
    const existingUpdate = await memClient.applyOps({
      project: "p-0",
      author: DEFAULT_MCP_AUTHOR,
      ops: [{ opId: "op-0-next", type: "enable_brick", brickId: "credit-wallet" }],
    });
    expect(existingUpdate.ok).toBe(true);
    expect(MAX_PROJECTS).toBe(1000);
  });

  it("the call counter counts within a minute, starts again in the next, and forgets old windows", async () => {
    const now = Date.UTC(2026, 9, 20, 12, 0, 30);
    expect([
      await withinRateLimit(db, 2, now),
      await withinRateLimit(db, 2, now + 1000),
      await withinRateLimit(db, 2, now + 2000),
    ]).toEqual([true, true, false]);
    expect(await withinRateLimit(db, 2, now + 60_000)).toBe(true);
    await withinRateLimit(db, 2, now + 2 * 3_600_000);
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM mcp_rate").first<{ n: number }>())!.n,
    ).toBe(1);
  });
});

describe("storing a build", () => {
  const files = { "a.txt": "alpha\n", "b/c.txt": "gamma\n" };

  it("replaces whatever the project had, in one step", async () => {
    await storeBuild(db, "p", { "old.txt": "old", ...files });
    const summary = await storeBuild(db, "p", files);
    expect(summary).toMatchObject({ files: 2, bytes: 12 });
    expect(
      (
        await db
          .prepare("SELECT path FROM mcp_files WHERE project = 'p' ORDER BY path")
          .all<{ path: string }>()
      ).results.map((r) => r.path),
    ).toEqual(["a.txt", "b/c.txt"]);
    expect(
      (
        await db
          .prepare("SELECT file_count FROM mcp_builds WHERE project = 'p'")
          .first<{ file_count: number }>()
      )?.file_count,
    ).toBe(2);
  });

  it("counts bytes, not characters", async () => {
    expect((await storeBuild(db, "p", { "u.txt": "héllo 日本" })).bytes).toBe(
      new TextEncoder().encode("héllo 日本").length,
    );
  });

  it("gives the same hash for the same files whatever order they are given in, and a different one for a different file", async () => {
    const a = await storeBuild(db, "p", { x: "1", y: "2" });
    const b = await storeBuild(db, "q", { y: "2", x: "1" });
    const c = await storeBuild(db, "r", { x: "1", y: "3" });
    expect(a.hash).toBe(b.hash);
    expect(c.hash).not.toBe(a.hash);
  });

  it("does not let one project's files leak into another's", async () => {
    await storeBuild(db, "p", { "only-p.txt": "p" });
    await storeBuild(db, "q", { "only-q.txt": "q" });
    expect(
      (
        await db
          .prepare("SELECT path FROM mcp_files WHERE project = 'q'")
          .all<{ path: string }>()
      ).results.map((r) => r.path),
    ).toEqual(["only-q.txt"]);
  });
});
