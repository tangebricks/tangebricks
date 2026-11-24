import { Hono } from "hono";
import { z } from "zod";
import { LiveChatService, type SenderType, type ChatChannel, type ConversationPriority } from "./chat.ts";
import { chatMiddleware, type ChatEnv } from "./middleware.ts";

const StartConversationSchema = z.object({
  customerId: z.string().min(1).max(128),
  customerEmail: z.string().email().optional(),
  customerName: z.string().max(100).optional(),
  initialMessage: z.string().min(1).max(10000),
  channel: z.enum(["widget", "email", "in_app"]).optional(),
  priority: z.enum(["low", "normal", "urgent"]).optional(),
});

const SendMessageSchema = z.object({
  senderType: z.enum(["customer", "agent", "bot", "system"]),
  senderId: z.string().min(1).max(128).optional(),
  senderName: z.string().min(1).max(100).optional(),
  body: z.string().min(1).max(10000),
  attachments: z
    .array(
      z.object({
        url: z.string().url(),
        name: z.string().min(1).max(255),
      })
    )
    .optional(),
});

const AssignAgentSchema = z.object({
  agentId: z.string().min(1).max(128),
});

const CannedReplySchema = z.object({
  shortcut: z.string().min(1).max(64),
  title: z.string().min(1).max(128),
  content: z.string().min(1).max(4096),
});

export function createChatRoutes(): Hono<ChatEnv> {
  const app = new Hono<ChatEnv>();

  app.use("*", chatMiddleware);

  // POST /chat/conversations - Start a support conversation
  app.post("/chat/conversations", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = StartConversationSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("chatService") || new LiveChatService(c.env.DB);
    const conv = await service.startConversation({
      workspaceId,
      customerId: parsed.data.customerId,
      customerEmail: parsed.data.customerEmail,
      customerName: parsed.data.customerName,
      initialMessage: parsed.data.initialMessage,
      channel: parsed.data.channel as ChatChannel | undefined,
      priority: parsed.data.priority as ConversationPriority | undefined,
    });

    return c.json(conv, 201);
  });

  // GET /chat/conversations - List conversations (Agent Inbox)
  app.get("/chat/conversations", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const status = c.req.query("status") as any;
    const agentId = c.req.query("agentId");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
    const offset = c.req.query("offset") ? Number(c.req.query("offset")) : 0;

    const service = c.get("chatService") || new LiveChatService(c.env.DB);
    const list = await service.listConversations(workspaceId, { status, agentId, limit, offset });
    return c.json({ conversations: list });
  });

  // GET /chat/conversations/:id - Get conversation with full message history
  app.get("/chat/conversations/:id", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const convId = c.req.param("id");
    const service = c.get("chatService") || new LiveChatService(c.env.DB);
    const conv = await service.getConversation(workspaceId, convId);
    if (!conv) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return c.json(conv);
  });

  // POST /chat/conversations/:id/messages - Send a message
  app.post("/chat/conversations/:id/messages", async (c) => {
    const user = c.get("user");
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const convId = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = SendMessageSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const senderId = parsed.data.senderId || user?.uid || "usr_anonymous";
    const senderName = parsed.data.senderName || user?.name || "Participant";

    const service = c.get("chatService") || new LiveChatService(c.env.DB);
    const msg = await service.sendMessage(
      workspaceId,
      convId,
      {
        type: parsed.data.senderType as SenderType,
        id: senderId,
        name: senderName,
      },
      parsed.data.body,
      parsed.data.attachments || []
    );

    return c.json(msg, 201);
  });

  // POST /chat/conversations/:id/assign - Assign an agent
  app.post("/chat/conversations/:id/assign", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const convId = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = AssignAgentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("chatService") || new LiveChatService(c.env.DB);
    const ok = await service.assignAgent(workspaceId, convId, parsed.data.agentId);
    if (!ok) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return c.json({ success: true, assignedAgentId: parsed.data.agentId });
  });

  // POST /chat/conversations/:id/resolve - Resolve conversation
  app.post("/chat/conversations/:id/resolve", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const convId = c.req.param("id");

    // The body is optional and carries nothing this route reads; the workspace comes from the verified context.
    const workspaceId = ctx.workspaceId;

    const service = c.get("chatService") || new LiveChatService(c.env.DB);
    const ok = await service.resolveConversation(workspaceId, convId);
    if (!ok) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return c.json({ success: true, status: "resolved" });
  });

  // POST /chat/canned-replies - Create or update canned reply
  app.post("/chat/canned-replies", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CannedReplySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const workspaceId = ctx.workspaceId;

    const service = c.get("chatService") || new LiveChatService(c.env.DB);
    const reply = await service.createCannedReply(
      workspaceId,
      parsed.data.shortcut,
      parsed.data.title,
      parsed.data.content
    );

    return c.json(reply, 201);
  });

  // GET /chat/canned-replies - List canned replies
  app.get("/chat/canned-replies", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    const workspaceId = ctx.workspaceId;

    const service = c.get("chatService") || new LiveChatService(c.env.DB);
    const replies = await service.listCannedReplies(workspaceId);
    return c.json({ cannedReplies: replies });
  });

  return app;
}
