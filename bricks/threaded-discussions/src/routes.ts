import { Hono } from "hono";
import { z } from "zod";
import { ThreadedDiscussionService } from "./threads.ts";
import { discussionMiddleware, type ThreadEnv } from "./middleware.ts";

const CreateThreadSchema = z.object({
  targetType: z.string().min(1).max(64),
  targetId: z.string().min(1).max(128),
  title: z.string().max(255).optional(),
  body: z.string().min(1).max(8192),
  authorId: z.string().max(128).optional(),
  authorName: z.string().max(100).optional(),
});

const AddCommentSchema = z.object({
  body: z.string().min(1).max(8192),
  parentCommentId: z.string().max(128).optional(),
  authorId: z.string().max(128).optional(),
  authorName: z.string().max(100).optional(),
});

export function createThreadRoutes(): Hono<ThreadEnv> {
  const app = new Hono<ThreadEnv>();

  app.use("*", discussionMiddleware);

  // POST /threads
  app.post("/threads", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateThreadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const authorId = parsed.data.authorId || user?.uid || "usr_anonymous";
    const authorName = parsed.data.authorName || user?.name || "Anonymous";

    const service = c.get("discussionService") || new ThreadedDiscussionService(c.env.DB);
    const thread = await service.createThread(
      workspaceId,
      parsed.data.targetType,
      parsed.data.targetId,
      { authorId, authorName, body: parsed.data.body },
      parsed.data.title
    );

    return c.json({ thread }, 201);
  });

  // GET /threads - list threads for target
  app.get("/threads", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const targetType = c.req.query("targetType");
    const targetId = c.req.query("targetId");
    const resolved = c.req.query("resolved") !== undefined ? c.req.query("resolved") === "true" : undefined;

    if (!targetType || !targetId) {
      return c.json({ error: "targetType and targetId query parameters are required" }, 400);
    }

    const service = c.get("discussionService") || new ThreadedDiscussionService(c.env.DB);
    const threads = await service.listThreadsForTarget(workspaceId, targetType, targetId, resolved);

    return c.json({ threads }, 200);
  });

  // GET /threads/:id - get full thread tree
  app.get("/threads/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const threadId = c.req.param("id");

    const service = c.get("discussionService") || new ThreadedDiscussionService(c.env.DB);
    const tree = await service.getThreadTree(workspaceId, threadId);

    if (!tree) {
      return c.json({ error: "Thread not found" }, 404);
    }

    return c.json({ thread: tree }, 200);
  });

  // POST /threads/:id/comments - add reply
  app.post("/threads/:id/comments", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const threadId = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = AddCommentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const authorId = parsed.data.authorId || user?.uid || "usr_anonymous";
    const authorName = parsed.data.authorName || user?.name || "Anonymous";

    const service = c.get("discussionService") || new ThreadedDiscussionService(c.env.DB);
    try {
      const comment = await service.addComment(
        workspaceId,
        threadId,
        { authorId, authorName },
        parsed.data.body,
        parsed.data.parentCommentId
      );
      return c.json({ comment }, 201);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // PATCH /threads/:id/resolve
  app.patch("/threads/:id/resolve", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const threadId = c.req.param("id");

    const resolvedBy = user?.uid || "system";
    const service = c.get("discussionService") || new ThreadedDiscussionService(c.env.DB);
    const ok = await service.resolveThread(workspaceId, threadId, resolvedBy);

    if (!ok) {
      return c.json({ error: "Thread not found or already resolved" }, 400);
    }

    return c.json({ ok: true }, 200);
  });

  // PATCH /threads/:id/reopen
  app.patch("/threads/:id/reopen", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;
    const threadId = c.req.param("id");

    const service = c.get("discussionService") || new ThreadedDiscussionService(c.env.DB);
    const ok = await service.reopenThread(workspaceId, threadId);

    if (!ok) {
      return c.json({ error: "Thread not found or already active" }, 400);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
