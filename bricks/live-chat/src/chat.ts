import { scoped, type D1Like } from "@poc/sdk";

export type ConversationStatus = "open" | "assigned" | "resolved" | "closed";
export type ConversationPriority = "low" | "normal" | "urgent";
export type ChatChannel = "widget" | "email" | "in_app";
export type SenderType = "customer" | "agent" | "bot" | "system";

export interface ChatAttachment {
  url: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  workspace_id: string;
  sender_type: SenderType;
  sender_id: string;
  sender_name: string;
  body: string;
  attachments: ChatAttachment[];
  created_at: string;
}

export interface Conversation {
  id: string;
  workspace_id: string;
  customer_id: string;
  customer_email: string | null;
  customer_name: string | null;
  assigned_agent_id: string | null;
  status: ConversationStatus;
  priority: ConversationPriority;
  channel: ChatChannel;
  last_message_preview: string | null;
  last_message_at: string;
  created_at: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: ChatMessage[];
}

export interface CannedReply {
  id: string;
  workspace_id: string;
  shortcut: string;
  title: string;
  content: string;
  created_at: string;
}

export interface StartConversationInput {
  workspaceId: string;
  customerId: string;
  customerEmail?: string;
  customerName?: string;
  initialMessage: string;
  channel?: ChatChannel;
  priority?: ConversationPriority;
}

interface RawConvRow {
  id: string;
  workspace_id: string;
  customer_id: string;
  customer_email: string | null;
  customer_name: string | null;
  assigned_agent_id: string | null;
  status: ConversationStatus;
  priority: ConversationPriority;
  channel: ChatChannel;
  last_message_preview: string | null;
  last_message_at: string;
  created_at: string;
}

interface RawMsgRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  sender_type: SenderType;
  sender_id: string;
  sender_name: string;
  body: string;
  attachments_json: string;
  created_at: string;
}

export class LiveChatService {
  private readonly db: D1Like;

  constructor(db: D1Like) {
    this.db = db;
  }

  private parseMessage(row: RawMsgRow): ChatMessage {
    let attachments: ChatAttachment[] = [];
    try {
      attachments = JSON.parse(row.attachments_json || "[]");
    } catch {
      attachments = [];
    }

    return {
      ...row,
      attachments,
    };
  }

  /**
   * Starts a new conversation with an initial customer message.
   */
  async startConversation(input: StartConversationInput): Promise<ConversationWithMessages> {
    const convId = `conv_${crypto.randomUUID().replace(/-/g, "")}`;
    const msgId = `cmsg_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const preview = input.initialMessage.trim().slice(0, 255);
    const channel = input.channel || "widget";
    const priority = input.priority || "normal";
    const senderName = input.customerName?.trim() || "Visitor";

    // 1. Insert conversation
    await scoped(this.db, input.workspaceId).insert("chat_conversations", {
      id: convId,
      customer_id: input.customerId.trim(),
      customer_email: input.customerEmail?.trim() || null,
      customer_name: input.customerName?.trim() || null,
      assigned_agent_id: null,
      status: "open",
      priority,
      channel,
      last_message_preview: preview,
      last_message_at: now,
      created_at: now,
    });

    // 2. Insert initial message
    await scoped(this.db, input.workspaceId).insert("chat_messages", {
      id: msgId,
      conversation_id: convId,
      sender_type: "customer",
      sender_id: input.customerId.trim(),
      sender_name: senderName,
      body: input.initialMessage.trim(),
      attachments_json: "[]",
      created_at: now,
    });

    const initialMsg: ChatMessage = {
      id: msgId,
      conversation_id: convId,
      workspace_id: input.workspaceId,
      sender_type: "customer",
      sender_id: input.customerId.trim(),
      sender_name: senderName,
      body: input.initialMessage.trim(),
      attachments: [],
      created_at: now,
    };

    return {
      id: convId,
      workspace_id: input.workspaceId,
      customer_id: input.customerId.trim(),
      customer_email: input.customerEmail?.trim() || null,
      customer_name: input.customerName?.trim() || null,
      assigned_agent_id: null,
      status: "open",
      priority,
      channel,
      last_message_preview: preview,
      last_message_at: now,
      created_at: now,
      messages: [initialMsg],
    };
  }

  /**
   * Appends a message to a conversation. Reopens conversation if resolved.
   */
  async sendMessage(
    workspaceId: string,
    conversationId: string,
    sender: { type: SenderType; id: string; name: string },
    bodyRaw: string,
    attachments: ChatAttachment[] = [],
  ): Promise<ChatMessage> {
    const msgId = `cmsg_${crypto.randomUUID().replace(/-/g, "")}`;
    const body = bodyRaw.trim();
    const preview = body.slice(0, 255);
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).insert("chat_messages", {
      id: msgId,
      conversation_id: conversationId,
      sender_type: sender.type,
      sender_id: sender.id.trim(),
      sender_name: sender.name.trim(),
      body,
      attachments_json: JSON.stringify(attachments),
      created_at: now,
    });

    // Update conversation state & reopen if customer replies
    const updates: Record<string, unknown> = {
      last_message_preview: preview,
      last_message_at: now,
    };
    if (sender.type === "customer") {
      updates.status = "open";
    }

    await scoped(this.db, workspaceId).update("chat_conversations", updates, "id = ?", [conversationId]);

    return {
      id: msgId,
      conversation_id: conversationId,
      workspace_id: workspaceId,
      sender_type: sender.type,
      sender_id: sender.id.trim(),
      sender_name: sender.name.trim(),
      body,
      attachments,
      created_at: now,
    };
  }

  /**
   * Assigns an agent to a conversation.
   */
  async assignAgent(workspaceId: string, conversationId: string, agentId: string): Promise<boolean> {
    const res = await scoped(this.db, workspaceId).update(
      "chat_conversations",
      {
        assigned_agent_id: agentId.trim(),
        status: "assigned",
      },
      "id = ?",
      [conversationId],
    );

    return res.meta.changes > 0;
  }

  /**
   * Resolves a support conversation.
   */
  async resolveConversation(workspaceId: string, conversationId: string): Promise<boolean> {
    const res = await scoped(this.db, workspaceId).update("chat_conversations", { status: "resolved" }, "id = ?", [conversationId]);

    return res.meta.changes > 0;
  }

  /**
   * Retrieves conversation details with full message history.
   */
  async getConversation(workspaceId: string, conversationId: string): Promise<ConversationWithMessages | null> {
    const s = scoped(this.db, workspaceId);
    const conv = await s.first<RawConvRow>("chat_conversations", "id = ?", [conversationId]);

    if (!conv) return null;

    const msgRows = await s.select<RawMsgRow>("chat_messages", "conversation_id = ?", [conversationId], { orderBy: "created_at ASC" });

    return {
      ...conv,
      messages: msgRows.map((m) => this.parseMessage(m)),
    };
  }

  /**
   * Lists conversations for agent inbox.
   */
  async listConversations(
    workspaceId: string,
    options: { status?: ConversationStatus; agentId?: string; limit?: number; offset?: number } = {},
  ): Promise<Conversation[]> {
    const s = scoped(this.db, workspaceId);
    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (options.status) {
      whereClauses.push("status = ?");
      params.push(options.status);
    }

    if (options.agentId) {
      whereClauses.push("assigned_agent_id = ?");
      params.push(options.agentId.trim());
    }

    const where = whereClauses.length > 0 ? whereClauses.join(" AND ") : undefined;
    const rows = await s.select<RawConvRow>("chat_conversations", where, params, {
      orderBy: "last_message_at DESC",
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
    return rows;
  }

  /**
   * Creates a canned reply shortcut.
   */
  async createCannedReply(workspaceId: string, shortcutRaw: string, titleRaw: string, contentRaw: string): Promise<CannedReply> {
    const id = `can_${crypto.randomUUID().replace(/-/g, "")}`;
    const shortcut = shortcutRaw.trim().toLowerCase();
    const title = titleRaw.trim();
    const content = contentRaw.trim();
    const now = new Date().toISOString();
    const s = scoped(this.db, workspaceId);

    const existing = await s.first<CannedReply>("chat_canned_replies", "shortcut = ?", [shortcut]);

    if (existing) {
      await s.update("chat_canned_replies", { title, content }, "id = ?", [existing.id]);
      return {
        ...existing,
        title,
        content,
      };
    }

    await s.insert("chat_canned_replies", {
      id,
      shortcut,
      title,
      content,
      created_at: now,
    });

    return {
      id,
      workspace_id: workspaceId,
      shortcut,
      title,
      content,
      created_at: now,
    };
  }

  /**
   * Lists canned replies for workspace.
   */
  async listCannedReplies(workspaceId: string): Promise<CannedReply[]> {
    const s = scoped(this.db, workspaceId);
    const rows = await s.select<CannedReply>("chat_canned_replies", undefined, [], { orderBy: "shortcut ASC" });

    return rows;
  }
}
