import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { assemble } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import { toAssemblerBlueprint } from "@poc/blueprint";
import type { BlueprintState, Op } from "@poc/blueprint";
import { app, computeBuildHash } from "../src/index.ts";
import type { StudioApiEnv } from "../src/index.ts";
import { ensureTestAuthForPath, ensureTestProjectToken } from "./project-token.ts";

const studioEnv = env as unknown as StudioApiEnv;

async function apiRequest(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: Record<string, any> }> {
  // Story 0.15: the author is the verified caller. A body `author` names the actor, who calls with a project token of
  // its own; the body `author` itself is ignored by the server.
  const actor = (init?.body as { author?: { id?: string } } | undefined)?.author?.id;
  const projectMatch = /^\/api\/projects\/([^/?]+)/.exec(path);
  const { headers: authHeaders } =
    actor && projectMatch?.[1]
      ? await ensureTestProjectToken(studioEnv, projectMatch[1], { clientName: actor })
      : await ensureTestAuthForPath(studioEnv, path);
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers: {
        ...authHeaders,
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : null,
    }),
    studioEnv,
  );
  const body = (await response.json()) as Record<string, any>;
  return { status: response.status, body };
}

async function actorAuthor(project: string, actor: string) {
  const t = await ensureTestProjectToken(studioEnv, project, { clientName: actor });
  return { type: "agent", id: t.tokenId, client: actor, onBehalfOf: t.userId };
}

describe("BlueprintDO SQLite ops log and apps/studio-api command bus (Story 1.2)", () => {
  test("applying 55 sequential mutations creates revisions 1..55, creates a snapshot at revision 50, updates D1 index, and reconstructs state at revision 12 and revision 53", async () => {
    const project = "tracer-fifty-five";

    // Initial GET before any commits returns revision 0
    const initialGet = await apiRequest(`/api/projects/${project}`);
    expect(initialGet.status).toBe(200);
    expect(initialGet.body.revision).toBe(0);
    expect(initialGet.body.readiness.ready).toBe(false);

    const committedSnapshots = new Map<
      number,
      { state: BlueprintState; semanticHash: string }
    >();

    // Revision 1: enable multi-workspace (human)
    const rev1 = await apiRequest(`/api/projects/${project}/ops`, {
      body: {
        author: { type: "human", id: "alice" },
        summary: "Enable multi-workspace",
        ops: [
          {
            opId: "op-rev-1",
            type: "enable_brick",
            brickId: "multi-workspace",
          } satisfies Op,
        ],
      },
    });
    expect(rev1.status).toBe(200);
    expect(rev1.body.revision).toBe(1);
    expect(rev1.body.parentRevision).toBe(0);
    expect(rev1.body.author).toEqual(await actorAuthor(project, "alice"));
    committedSnapshots.set(1, {
      state: rev1.body.state,
      semanticHash: rev1.body.semanticHash,
    });

    // Revision 2: enable credit-wallet (agent)
    const rev2 = await apiRequest(`/api/projects/${project}/ops`, {
      body: {
        author: { type: "agent", id: "claude-code", client: "mcp" },
        ops: [
          {
            opId: "op-rev-2",
            type: "enable_brick",
            brickId: "credit-wallet",
            config: { creditsPerUnit: 2, minOrderAmount: 10 },
          } satisfies Op,
        ],
      },
    });
    expect(rev2.status).toBe(200);
    expect(rev2.body.revision).toBe(2);
    expect(rev2.body.parentRevision).toBe(1);
    expect(rev2.body.author).toEqual(await actorAuthor(project, "claude-code"));
    committedSnapshots.set(2, {
      state: rev2.body.state,
      semanticHash: rev2.body.semanticHash,
    });

    // Revisions 3..55: alternate configuring credit-wallet and updating metadata
    for (let rev = 3; rev <= 55; rev += 1) {
      const isHuman = rev % 2 === 1;
      const author = isHuman
        ? { type: "human" as const, id: `user-${rev}` }
        : { type: "agent" as const, id: `agent-${rev}`, client: "cursor" };

      const op: Op =
        rev % 3 === 0
          ? {
              opId: `op-rev-${rev}`,
              type: "set_metadata",
              metadata: {
                displayName: `Project v${rev}`,
                layout: { "credit-wallet": { x: rev * 10, y: rev * 5 } },
              },
            }
          : {
              opId: `op-rev-${rev}`,
              type: "configure_brick",
              brickId: "credit-wallet",
              config: {
                creditsPerUnit: rev * 10,
                minOrderAmount: rev,
              },
            };

      const res = await apiRequest(`/api/projects/${project}/ops`, {
        body: {
          author,
          ops: [op],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.revision).toBe(rev);
      expect(res.body.parentRevision).toBe(rev - 1);
      expect(res.body.author).toEqual(await actorAuthor(project, author.id));

      committedSnapshots.set(rev, {
        state: res.body.state,
        semanticHash: res.body.semanticHash,
      });
    }

    // Verify snapshot was created at revision 50
    const snapsRes = await apiRequest(`/api/projects/${project}/snapshots`);
    expect(snapsRes.status).toBe(200);
    expect(snapsRes.body.snapshots).toHaveLength(1);
    expect(snapsRes.body.snapshots[0].revision).toBe(50);
    expect(snapsRes.body.snapshots[0].semanticHash).toBe(
      committedSnapshots.get(50)?.semanticHash,
    );
    expect(snapsRes.body.snapshots[0].state).toEqual(
      committedSnapshots.get(50)?.state,
    );

    // Reconstruct state at revision 12 (replayed from revision 0 + ops 1..12)
    const rev12Res = await apiRequest(`/api/projects/${project}/revisions/12`);
    expect(rev12Res.status).toBe(200);
    expect(rev12Res.body.revision).toBe(12);
    expect(rev12Res.body.parentRevision).toBe(11);
    expect(rev12Res.body.author).toEqual(await actorAuthor(project, "agent-12"));
    expect(rev12Res.body.semanticHash).toBe(committedSnapshots.get(12)?.semanticHash);
    expect(rev12Res.body.state).toEqual(committedSnapshots.get(12)?.state);

    // Reconstruct state at revision 53 (replayed from snapshot 50 + ops 51..53)
    const rev53Res = await apiRequest(`/api/projects/${project}/revisions/53`);
    expect(rev53Res.status).toBe(200);
    expect(rev53Res.body.revision).toBe(53);
    expect(rev53Res.body.parentRevision).toBe(52);
    expect(rev53Res.body.author).toEqual(await actorAuthor(project, "user-53"));
    expect(rev53Res.body.semanticHash).toBe(committedSnapshots.get(53)?.semanticHash);
    expect(rev53Res.body.state).toEqual(committedSnapshots.get(53)?.state);

    // Verify D1 projects index has current_revision = 55. Story 16: an MCP token lists only the project it is bound to,
    // so the listing is read with this project's own token.
    const projectToken = await ensureTestProjectToken(studioEnv, project);
    const listResponse = await app.fetch(
      new Request("http://localhost/api/projects", { headers: projectToken.headers }),
      studioEnv,
    );
    const listRes = { status: listResponse.status, body: (await listResponse.json()) as Record<string, any> };
    expect(listRes.status).toBe(200);
    expect(listRes.body.projects.map((p: { project: string }) => p.project)).toEqual([project]);
    const indexed = listRes.body.projects.find(
      (p: { project: string }) => p.project === project,
    );
    expect(indexed).toBeDefined();
    expect(indexed.revision).toBe(55);
    expect(indexed.semanticHash).toBe(committedSnapshots.get(55)?.semanticHash);
  });

  test("invalid mutations return 422 with machine-readable code, path, message, suggestedFix and do not advance revision", async () => {
    const project = "validation-guard";

    // Commit valid revision 1
    const r1 = await apiRequest(`/api/projects/${project}/ops`, {
      body: {
        author: { type: "human", id: "alice" },
        ops: [
          {
            opId: "v-1",
            type: "enable_brick",
            brickId: "multi-workspace",
          } satisfies Op,
        ],
      },
    });
    expect(r1.status).toBe(200);
    expect(r1.body.revision).toBe(1);

    // Attempt invalid op batch (unknown brick)
    const badBrick = await apiRequest(`/api/projects/${project}/ops`, {
      body: {
        author: { type: "agent", id: "bot" },
        ops: [
          {
            opId: "v-bad-1",
            type: "enable_brick",
            brickId: "non-existent-brick",
          },
        ],
      },
    });
    expect(badBrick.status).toBe(422);
    expect(badBrick.body.error.code).toBe("VALIDATION_FAILED");
    expect(badBrick.body.error.issues[0]).toMatchObject({
      code: "UNKNOWN_BRICK",
      path: "bricks.non-existent-brick",
    });
    expect(typeof badBrick.body.error.issues[0].message).toBe("string");
    expect(typeof badBrick.body.error.issues[0].suggestedFix).toBe("string");

    // Attempt batch where first op is valid and second op is invalid -> atomic rollback, nothing written!
    const atomicBatch = await apiRequest(`/api/projects/${project}/ops`, {
      body: {
        author: { type: "human", id: "alice" },
        ops: [
          {
            opId: "v-good-part",
            type: "enable_brick",
            brickId: "credit-wallet",
          },
          {
            opId: "v-bad-part",
            type: "configure_brick",
            brickId: "credit-wallet",
            config: { creditsPerUnit: -99 },
          },
        ],
      },
    });
    expect(atomicBatch.status).toBe(422);
    expect(atomicBatch.body.error.code).toBe("VALIDATION_FAILED");
    expect(atomicBatch.body.error.issues[0].code).toBe("INVALID_BRICK_CONFIG");

    // Verify revision is still 1 and credit-wallet was NOT enabled
    const afterFailed = await apiRequest(`/api/projects/${project}`);
    expect(afterFailed.status).toBe(200);
    expect(afterFailed.body.revision).toBe(1);
    expect(afterFailed.body.state.bricks.map((b: { id: string }) => b.id)).toEqual([
      "multi-workspace",
    ]);
  });

  test("building an unready project returns 422, and building a ready project returns a deterministic buildHash matching assemble()", async () => {
    const project = "build-tracer";

    // Enable credit-wallet alone (missing workspace-context provider -> not ready)
    const rev1 = await apiRequest(`/api/projects/${project}/ops`, {
      body: {
        author: { type: "human", id: "alice" },
        ops: [
          {
            opId: "b-1",
            type: "enable_brick",
            brickId: "credit-wallet",
            config: { creditsPerUnit: 5, minOrderAmount: 10 },
          } satisfies Op,
        ],
      },
    });
    expect(rev1.status).toBe(200);
    expect(rev1.body.readiness.ready).toBe(false);

    const unreadyBuild = await apiRequest(`/api/projects/${project}/build`, {
      method: "POST",
    });
    expect(unreadyBuild.status).toBe(422);
    expect(unreadyBuild.body.error.code).toBe("PROJECT_NOT_READY");

    // Enable multi-workspace -> now ready!
    const rev2 = await apiRequest(`/api/projects/${project}/ops`, {
      body: {
        author: { type: "human", id: "alice" },
        ops: [
          {
            opId: "b-2",
            type: "enable_brick",
            brickId: "multi-workspace",
          } satisfies Op,
        ],
      },
    });
    expect(rev2.status).toBe(200);
    expect(rev2.body.readiness.ready).toBe(true);

    const readyBuild1 = await apiRequest(`/api/projects/${project}/build`, {
      method: "POST",
    });
    expect(readyBuild1.status).toBe(200);
    expect(readyBuild1.body.project).toBe(project);
    expect(readyBuild1.body.revision).toBe(2);
    expect(readyBuild1.body.files).toBe(10);
    expect(readyBuild1.body.bytes).toBeGreaterThan(0);

    // Compare against direct assemble()
    const directAssembled = assemble(toAssemblerBlueprint(rev2.body.state), catalog);
    expect(directAssembled.ok).toBe(true);
    if (directAssembled.ok) {
      const expectedHash = await computeBuildHash(directAssembled.files);
      expect(readyBuild1.body.buildHash).toBe(expectedHash);
    }

    // Building again produces the exact same buildHash
    const readyBuild2 = await apiRequest(`/api/projects/${project}/build`, {
      method: "POST",
    });
    expect(readyBuild2.status).toBe(200);
    expect(readyBuild2.body.buildHash).toBe(readyBuild1.body.buildHash);
  });
});
