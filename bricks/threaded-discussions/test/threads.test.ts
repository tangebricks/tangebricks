import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_threaded_discussions.sql?raw";
import {
  ThreadedDiscussionService,
  extractMentions,
  createThreadRoutes,
} from "../src/index.ts";
import type { ThreadEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_cmt_alpha";
const WS_BETA = "ws_cmt_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS cmt_comments").run();
  await db.prepare("DROP TABLE IF EXISTS cmt_threads").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Threaded Discussions Core Logic", () => {
  it("extracts user mentions from text correctly", () => {
    const text = "Hey @alice_99 and @bob, can you check with @alice_99 again?";
    const mentions = extractMentions(text);

    expect(mentions).toHaveLength(2);
    expect(mentions).toContain("alice_99");
    expect(mentions).toContain("bob");
  });

  it("creates thread and builds recursive nested comment trees", async () => {
    const service = new ThreadedDiscussionService(db);

    // 1. Root thread
    const thread = await service.createThread(
      WS_ALPHA,
      "invoice",
      "inv_9001",
      { authorId: "usr_alice", authorName: "Alice", body: "Please check line item 3" },
      "Billing Discrepancy"
    );

    expect(thread.id).toMatch(/^thrd_[a-f0-9]{32}$/);
    expect(thread.target_id).toBe("inv_9001");
    expect(thread.comments).toHaveLength(1);
    const rootCommentId = thread.comments[0].id;

    // 2. Direct Reply to Root Comment
    const reply1 = await service.addComment(
      WS_ALPHA,
      thread.id,
      { authorId: "usr_bob", authorName: "Bob" },
      "Looks like a 10% discount was omitted",
      rootCommentId
    );

    // 3. Nested Reply to Bob's Reply
    await service.addComment(
      WS_ALPHA,
      thread.id,
      { authorId: "usr_alice", authorName: "Alice" },
      "Fixed now, thanks @bob!",
      reply1.id
    );

    // Retrieve full hierarchical tree
    const tree = await service.getThreadTree(WS_ALPHA, thread.id);
    expect(tree).not.toBeNull();
    expect(tree?.comments).toHaveLength(1); // 1 root comment

    // Level 1: Bob's reply
    expect(tree?.comments[0].replies).toHaveLength(1);
    expect(tree?.comments[0].replies[0].author_name).toBe("Bob");

    // Level 2: Alice's sub-reply
    expect(tree?.comments[0].replies[0].replies).toHaveLength(1);
    expect(tree?.comments[0].replies[0].replies[0].mentions).toEqual(["bob"]);
  });

  it("handles thread resolution and reopening workflows", async () => {
    const service = new ThreadedDiscussionService(db);
    const thread = await service.createThread(
      WS_ALPHA,
      "deal",
      "deal_123",
      { authorId: "usr_a", authorName: "A", body: "Issue opened" }
    );

    expect(thread.is_resolved).toBe(false);

    // Resolve thread
    const resolved = await service.resolveThread(WS_ALPHA, thread.id, "usr_admin");
    expect(resolved).toBe(true);

    const check1 = await service.getThread(WS_ALPHA, thread.id);
    expect(check1?.is_resolved).toBe(true);
    expect(check1?.resolved_by).toBe("usr_admin");

    // Reopen thread
    const reopened = await service.reopenThread(WS_ALPHA, thread.id);
    expect(reopened).toBe(true);

    const check2 = await service.getThread(WS_ALPHA, thread.id);
    expect(check2?.is_resolved).toBe(false);
  });

  it("allows authors to edit and delete comments with permission checks", async () => {
    const service = new ThreadedDiscussionService(db);
    const thread = await service.createThread(
      WS_ALPHA,
      "page",
      "p1",
      { authorId: "usr_author", authorName: "Author", body: "Original typo here" }
    );

    const cmtId = thread.comments[0].id;

    // Non-author edit rejected
    const hackRes = await service.editComment(WS_ALPHA, cmtId, "usr_hacker", "Hacked text");
    expect(hackRes).toBeNull();

    // Author edit succeeded
    const editRes = await service.editComment(WS_ALPHA, cmtId, "usr_author", "Corrected text @manager");
    expect(editRes).not.toBeNull();
    expect(editRes?.body).toBe("Corrected text @manager");
    expect(editRes?.is_edited).toBe(true);
    expect(editRes?.mentions).toEqual(["manager"]);
  });

  it("strictly isolates discussions between workspaces", async () => {
    const service = new ThreadedDiscussionService(db);
    await service.createThread(WS_ALPHA, "doc", "d1", { authorId: "u1", authorName: "A", body: "Alpha" });
    await service.createThread(WS_BETA, "doc", "d1", { authorId: "u2", authorName: "B", body: "Beta" });

    const threadsA = await service.listThreadsForTarget(WS_ALPHA, "doc", "d1");
    const threadsB = await service.listThreadsForTarget(WS_BETA, "doc", "d1");

    expect(threadsA).toHaveLength(1);
    expect(threadsB).toHaveLength(1);
    expect(threadsA[0].workspace_id).toBe(WS_ALPHA);
    expect(threadsB[0].workspace_id).toBe(WS_BETA);
  });
});

describe("Threaded Discussions HTTP API", () => {
  it("provides full HTTP workflow for threads, replies, and resolution", async () => {
    const app = new Hono<ThreadEnv>();
    app.use("/api/*", stubWorkspaceContext);
    app.route("/api", createThreadRoutes());

    // 1. POST /threads
    const createRes = await app.request("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        targetType: "deal",
        targetId: "deal_99",
        title: "Contract Pricing Query",
        body: "Can we offer a 15% discount for annual upfront?",
        authorId: "usr_sales_rep",
        authorName: "Jim Halpert",
      }),
    }, { DB: db });
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as { thread: { id: string } };
    const threadId = createJson.thread.id;

    // 2. POST /threads/:id/comments (reply)
    const replyRes = await app.request(`/api/threads/${threadId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
      body: JSON.stringify({
        body: "Approved @jim!",
        authorId: "usr_vp_sales",
        authorName: "Michael Scott",
      }),
    }, { DB: db });
    expect(replyRes.status).toBe(201);

    // 3. GET /threads/:id
    const treeRes = await app.request(`/api/threads/${threadId}`, { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(treeRes.status).toBe(200);
    const treeJson = (await treeRes.json()) as { thread: { comments: unknown[] } };
    expect(treeJson.thread.comments).toHaveLength(2); // 2 root/linear comments

    // 4. PATCH /threads/:id/resolve
    const resolveRes = await app.request(`/api/threads/${threadId}/resolve`, {
      method: "PATCH",
      headers: { "x-workspace-id": WS_ALPHA },
    }, { DB: db });
    expect(resolveRes.status).toBe(200);

    // 5. GET /threads (filter resolved)
    const listRes = await app.request("/api/threads?targetType=deal&targetId=deal_99&resolved=true", { headers: { "x-workspace-id": WS_ALPHA } }, { DB: db });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { threads: unknown[] };
    expect(listJson.threads).toHaveLength(1);
  });
});
