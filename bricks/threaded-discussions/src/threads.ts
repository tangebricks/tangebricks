import { scoped, type D1Like } from "@poc/sdk";

export interface Thread {
  id: string;
  workspace_id: string;
  target_type: string;
  target_id: string;
  title: string | null;
  is_resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  thread_id: string;
  workspace_id: string;
  parent_comment_id: string | null;
  author_id: string;
  author_name: string;
  body: string;
  mentions: string[];
  is_edited: boolean;
  created_at: string;
  updated_at: string;
}

export interface CommentNode extends Comment {
  replies: CommentNode[];
}

export interface ThreadWithTree extends Thread {
  comments: CommentNode[];
}

interface RawThreadRow {
  id: string;
  workspace_id: string;
  target_type: string;
  target_id: string;
  title: string | null;
  is_resolved: number;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RawCommentRow {
  id: string;
  thread_id: string;
  workspace_id: string;
  parent_comment_id: string | null;
  author_id: string;
  author_name: string;
  body: string;
  mentions_json: string;
  is_edited: number;
  created_at: string;
  updated_at: string;
}

/**
 * Extracts tagged user mentions (@username or @userId) from comment body text.
 */
export function extractMentions(text: string): string[] {
  const matches = text.match(/@([a-zA-Z0-9_.-]+)/g);
  if (!matches) return [];
  const set = new Set(matches.map((m) => m.slice(1)));
  return Array.from(set);
}

export class ThreadedDiscussionService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  private parseThread(row: RawThreadRow): Thread {
    return {
      ...row,
      is_resolved: row.is_resolved === 1,
    };
  }

  private parseComment(row: RawCommentRow): Comment {
    let mentions: string[] = [];
    try {
      mentions = JSON.parse(row.mentions_json || "[]");
    } catch {
      mentions = [];
    }

    return {
      ...row,
      mentions,
      is_edited: row.is_edited === 1,
    };
  }

  /**
   * Starts a new contextual thread on an entity with an initial comment.
   */
  async createThread(
    workspaceId: string,
    targetTypeRaw: string,
    targetIdRaw: string,
    initialComment: { authorId: string; authorName: string; body: string },
    title?: string
  ): Promise<ThreadWithTree> {
    const threadId = `thrd_${crypto.randomUUID().replace(/-/g, "")}`;
    const commentId = `cmt_${crypto.randomUUID().replace(/-/g, "")}`;
    const targetType = targetTypeRaw.trim().toLowerCase();
    const targetId = targetIdRaw.trim();
    const now = new Date().toISOString();
    const mentions = extractMentions(initialComment.body);
    const s = scoped(this.db, workspaceId);

    // 1. Insert Thread
    await s.insert("cmt_threads", {
      id: threadId,
      target_type: targetType,
      target_id: targetId,
      title: title?.trim() || null,
      is_resolved: 0,
      created_at: now,
      updated_at: now,
    });

    // 2. Insert Initial Comment
    await s.insert("cmt_comments", {
      id: commentId,
      thread_id: threadId,
      parent_comment_id: null,
      author_id: initialComment.authorId.trim(),
      author_name: initialComment.authorName.trim(),
      body: initialComment.body.trim(),
      mentions_json: JSON.stringify(mentions),
      is_edited: 0,
      created_at: now,
      updated_at: now,
    });

    const rootComment: CommentNode = {
      id: commentId,
      thread_id: threadId,
      workspace_id: workspaceId,
      parent_comment_id: null,
      author_id: initialComment.authorId.trim(),
      author_name: initialComment.authorName.trim(),
      body: initialComment.body.trim(),
      mentions,
      is_edited: false,
      created_at: now,
      updated_at: now,
      replies: [],
    };

    return {
      id: threadId,
      workspace_id: workspaceId,
      target_type: targetType,
      target_id: targetId,
      title: title?.trim() || null,
      is_resolved: false,
      resolved_by: null,
      resolved_at: null,
      created_at: now,
      updated_at: now,
      comments: [rootComment],
    };
  }

  /**
   * Adds a reply or comment to an existing thread.
   */
  async addComment(
    workspaceId: string,
    threadId: string,
    author: { authorId: string; authorName: string },
    body: string,
    parentCommentId?: string
  ): Promise<Comment> {
    const thread = await this.getThread(workspaceId, threadId);
    if (!thread) throw new Error("Thread not found");

    const id = `cmt_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const mentions = extractMentions(body);
    const s = scoped(this.db, workspaceId);

    await s.insert("cmt_comments", {
      id,
      thread_id: threadId,
      parent_comment_id: parentCommentId || null,
      author_id: author.authorId.trim(),
      author_name: author.authorName.trim(),
      body: body.trim(),
      mentions_json: JSON.stringify(mentions),
      is_edited: 0,
      created_at: now,
      updated_at: now,
    });

    // Touch thread updated_at
    await s.update("cmt_threads", { updated_at: now }, "id = ?", [threadId]);

    return {
      id,
      thread_id: threadId,
      workspace_id: workspaceId,
      parent_comment_id: parentCommentId || null,
      author_id: author.authorId.trim(),
      author_name: author.authorName.trim(),
      body: body.trim(),
      mentions,
      is_edited: false,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Retrieves single thread header.
   */
  async getThread(workspaceId: string, threadId: string): Promise<Thread | null> {
    const s = scoped(this.db, workspaceId);
    const row = await s.first<RawThreadRow>(
      "cmt_threads",
      "id = ?",
      [threadId]
    );

    if (!row) return null;
    return this.parseThread(row);
  }

  /**
   * Retrieves full thread with recursively assembled comment reply tree.
   */
  async getThreadTree(workspaceId: string, threadId: string): Promise<ThreadWithTree | null> {
    const thread = await this.getThread(workspaceId, threadId);
    if (!thread) return null;

    const s = scoped(this.db, workspaceId);
    const rows = await s.select<RawCommentRow>(
      "cmt_comments",
      "thread_id = ?",
      [threadId],
      { orderBy: "created_at ASC" }
    );

    const commentsMap = new Map<string, CommentNode>();
    const rootNodes: CommentNode[] = [];

    // Initialize nodes
    rows.forEach((r) => {
      const parsed = this.parseComment(r);
      commentsMap.set(parsed.id, { ...parsed, replies: [] });
    });

    // Assemble hierarchical tree
    rows.forEach((r) => {
      const node = commentsMap.get(r.id)!;
      if (r.parent_comment_id && commentsMap.has(r.parent_comment_id)) {
        commentsMap.get(r.parent_comment_id)!.replies.push(node);
      } else {
        rootNodes.push(node);
      }
    });

    return {
      ...thread,
      comments: rootNodes,
    };
  }

  /**
   * Lists all threads attached to an entity.
   */
  async listThreadsForTarget(
    workspaceId: string,
    targetType: string,
    targetId: string,
    resolvedFilter?: boolean
  ): Promise<Thread[]> {
    const s = scoped(this.db, workspaceId);
    let where = "target_type = ? AND target_id = ?";
    const params: unknown[] = [targetType.trim().toLowerCase(), targetId.trim()];

    if (resolvedFilter !== undefined) {
      where += " AND is_resolved = ?";
      params.push(resolvedFilter ? 1 : 0);
    }

    const rows = await s.select<RawThreadRow>(
      "cmt_threads",
      where,
      params,
      { orderBy: "updated_at DESC" }
    );
    return rows.map((r) => this.parseThread(r));
  }

  /**
   * Resolves a discussion thread.
   */
  async resolveThread(workspaceId: string, threadId: string, resolvedBy: string): Promise<boolean> {
    const now = new Date().toISOString();
    const s = scoped(this.db, workspaceId);
    const res = await s.update(
      "cmt_threads",
      { is_resolved: 1, resolved_by: resolvedBy.trim(), resolved_at: now, updated_at: now },
      "id = ? AND is_resolved = 0",
      [threadId]
    );

    return (res.meta?.changes ?? 0) > 0;
  }

  /**
   * Reopens a resolved thread.
   */
  async reopenThread(workspaceId: string, threadId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const s = scoped(this.db, workspaceId);
    const res = await s.update(
      "cmt_threads",
      { is_resolved: 0, resolved_by: null, resolved_at: null, updated_at: now },
      "id = ? AND is_resolved = 1",
      [threadId]
    );

    return (res.meta?.changes ?? 0) > 0;
  }

  /**
   * Edits an existing comment (author-only check).
   */
  async editComment(
    workspaceId: string,
    commentId: string,
    authorId: string,
    newBody: string
  ): Promise<Comment | null> {
    const now = new Date().toISOString();
    const mentions = extractMentions(newBody);
    const s = scoped(this.db, workspaceId);

    const res = await s.update(
      "cmt_comments",
      { body: newBody.trim(), mentions_json: JSON.stringify(mentions), is_edited: 1, updated_at: now },
      "id = ? AND author_id = ?",
      [commentId, authorId.trim()]
    );

    if ((res.meta?.changes ?? 0) === 0) return null;

    const row = await s.first<RawCommentRow>(
      "cmt_comments",
      "id = ?",
      [commentId]
    );

    if (!row) return null;
    return this.parseComment(row);
  }

  /**
   * Deletes a comment.
   */
  async deleteComment(workspaceId: string, commentId: string, authorId: string): Promise<boolean> {
    const s = scoped(this.db, workspaceId);
    const res = await s.delete(
      "cmt_comments",
      "id = ? AND author_id = ?",
      [commentId, authorId.trim()]
    );

    return (res.meta?.changes ?? 0) > 0;
  }
}
