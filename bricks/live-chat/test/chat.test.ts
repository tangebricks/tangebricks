import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigration } from "@poc/sdk";
import type { D1Like } from "@poc/sdk";
import migration from "../migrations/0001_live_chat.sql?raw";
import {
  LiveChatService,
  createChatRoutes,
} from "../src/index.ts";
import type { ChatEnv } from "../src/middleware.ts";
import { stubWorkspaceContext } from "../../multi-workspace/test/support/stub-workspace-context.ts";

const db = env.DB as D1Like;
const WS_ALPHA = "ws_chat_alpha";
const WS_BETA = "ws_chat_beta";

async function resetDb(): Promise<void> {
  await db.prepare("DROP TABLE IF EXISTS chat_messages").run();
  await db.prepare("DROP TABLE IF EXISTS chat_canned_replies").run();
  await db.prepare("DROP TABLE IF EXISTS chat_conversations").run();
  await applyMigration(db, migration);
}

beforeEach(async () => {
  expect.hasAssertions();
  await resetDb();
});

describe("Live Chat Core Service", () => {
  it("starts a conversation with initial customer message and allows replies", async () => {
    const service = new LiveChatService(db);

    const conv = await service.startConversation({
      workspaceId: WS_ALPHA,
      customerId: "cust_123",
      customerEmail: "sarah@example.com",
      customerName: "Sarah Connor",
      initialMessage: "I cannot login to my account",
      priority: "urgent",
    });

    expect(conv.id).toMatch(/^conv_[a-f0-9]{32}$/);
    expect(conv.customer_id).toBe("cust_123");
    expect(conv.status).toBe("open");
    expect(conv.priority).toBe("urgent");
    expect(conv.last_message_preview).toBe("I cannot login to my account");
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0].sender_type).toBe("customer");
    expect(conv.messages[0].body).toBe("I cannot login to my account");

    // Agent assigns themselves
    const assigned = await service.assignAgent(WS_ALPHA, conv.id, "agent_terminator");
    expect(assigned).toBe(true);

    // Agent replies with an attachment
    const agentMsg = await service.sendMessage(
      WS_ALPHA,
      conv.id,
      { type: "agent", id: "agent_terminator", name: "Agent T-800" },
      "Have you tried resetting your password via email?",
      [{ url: "https://support.example.com/reset.png", name: "guide.png" }]
    );

    expect(agentMsg.id).toMatch(/^cmsg_[a-f0-9]{32}$/);
    expect(agentMsg.sender_type).toBe("agent");
    expect(agentMsg.attachments).toHaveLength(1);

    // Resolve conversation
    const resolved = await service.resolveConversation(WS_ALPHA, conv.id);
    expect(resolved).toBe(true);

    // Customer sends follow up -> should reopen to 'open'
    await service.sendMessage(
      WS_ALPHA,
      conv.id,
      { type: "customer", id: "cust_123", name: "Sarah Connor" },
      "Nevermind, it still fails with code 403"
    );

    const fetched = await service.getConversation(WS_ALPHA, conv.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("open");
    expect(fetched!.messages).toHaveLength(3);
    expect(fetched!.last_message_preview).toBe("Nevermind, it still fails with code 403");
  });

  it("creates, updates, and lists canned replies per workspace", async () => {
    const service = new LiveChatService(db);

    const reply1 = await service.createCannedReply(
      WS_ALPHA,
      "hello",
      "Standard Greeting",
      "Hello! Thank you for reaching out to customer support. How can I help you today?"
    );
    expect(reply1.shortcut).toBe("hello");

    // Overwrite/Update shortcut
    const reply2 = await service.createCannedReply(
      WS_ALPHA,
      "hello",
      "Updated Greeting",
      "Hello! Welcome to Support. What can I do for you?"
    );
    expect(reply2.title).toBe("Updated Greeting");

    // Create another canned reply
    await service.createCannedReply(
      WS_ALPHA,
      "bye",
      "Resolution Farewell",
      "Thank you for contacting us. Have a great day!"
    );

    const list = await service.listCannedReplies(WS_ALPHA);
    expect(list).toHaveLength(2);
    expect(list[0].shortcut).toBe("bye");
    expect(list[1].shortcut).toBe("hello");
    expect(list[1].content).toBe("Hello! Welcome to Support. What can I do for you?");
  });

  it("enforces strict multi-tenant workspace isolation", async () => {
    const service = new LiveChatService(db);

    const convAlpha = await service.startConversation({
      workspaceId: WS_ALPHA,
      customerId: "cust_alpha",
      initialMessage: "Alpha workspace question",
    });

    const listBeta = await service.listConversations(WS_BETA);
    expect(listBeta).toHaveLength(0);

    const crossFetch = await service.getConversation(WS_BETA, convAlpha.id);
    expect(crossFetch).toBeNull();

    const crossAssign = await service.assignAgent(WS_BETA, convAlpha.id, "agent_intruder");
    expect(crossAssign).toBe(false);
  });
});

describe("Live Chat Hono Endpoints", () => {
  function createApp(workspaceId: string = WS_ALPHA) {
    const app = new Hono<ChatEnv>();
    app.use("*", async (c, next) => {
      c.set("workspace", { id: workspaceId, role: "agent" });
      c.set("ctx", Object.freeze({ userId: "usr_agent_1", workspaceId, role: "agent" }));
      c.set("user", { uid: "usr_agent_1", name: "Support Staff" });
      await next();
    });
    app.route("/", createChatRoutes());
    return app;
  }

  it("handles complete conversation lifecycle via HTTP REST API", async () => {
    const app = createApp();

    // 1. Start Conversation
    const startRes = await app.request(
      "http://localhost/chat/conversations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: "cust_web_001",
          customerEmail: "shopper@mall.com",
          customerName: "Jane Doe",
          initialMessage: "Where is my order #551?",
          channel: "widget",
          priority: "normal",
        }),
      },
      { DB: db }
    );
    expect(startRes.status).toBe(201);
    const conv = (await startRes.json()) as any;
    expect(conv.id).toBeDefined();
    expect(conv.messages).toHaveLength(1);

    // 2. List Inbox
    const listRes = await app.request(
      "http://localhost/chat/conversations?status=open",
      { method: "GET" },
      { DB: db }
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as any;
    expect(listJson.conversations).toHaveLength(1);

    // 3. Assign Agent
    const assignRes = await app.request(
      `http://localhost/chat/conversations/${conv.id}/assign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "usr_agent_1" }),
      },
      { DB: db }
    );
    expect(assignRes.status).toBe(200);

    // 4. Send Agent Message
    const msgRes = await app.request(
      `http://localhost/chat/conversations/${conv.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          senderType: "agent",
          body: "Tracking number is TRACK-88192",
        }),
      },
      { DB: db }
    );
    expect(msgRes.status).toBe(201);

    // 5. Resolve Conversation
    const resolveRes = await app.request(
      `http://localhost/chat/conversations/${conv.id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      { DB: db }
    );
    expect(resolveRes.status).toBe(200);

    // 6. Verify Fetch Conversation
    const getRes = await app.request(
      `http://localhost/chat/conversations/${conv.id}`,
      { method: "GET" },
      { DB: db }
    );
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as any;
    expect(getJson.status).toBe("resolved");
    expect(getJson.messages).toHaveLength(2);
  });

  it("creates and retrieves canned replies via HTTP", async () => {
    const app = createApp();

    const postRes = await app.request(
      "http://localhost/chat/canned-replies",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortcut: "refund",
          title: "Refund Policy Details",
          content: "Refunds take 3 to 5 business days to post back to original payment.",
        }),
      },
      { DB: db }
    );
    expect(postRes.status).toBe(201);

    const getRes = await app.request(
      "http://localhost/chat/canned-replies",
      { method: "GET" },
      { DB: db }
    );
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as any;
    expect(getJson.cannedReplies).toHaveLength(1);
    expect(getJson.cannedReplies[0].shortcut).toBe("refund");
  });

  it("returns 400 on malformed input and 404 on missing conversation", async () => {
    const app = createApp();

    // Missing required customerId
    const badStart = await app.request(
      "http://localhost/chat/conversations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialMessage: "Hi" }),
      },
      { DB: db }
    );
    expect(badStart.status).toBe(400);

    // Non-existent conversation
    const notFound = await app.request(
      "http://localhost/chat/conversations/conv_unknown999",
      { method: "GET" },
      { DB: db }
    );
    expect(notFound.status).toBe(404);
  });
});

describe("Live Chat HTTP API: the workspace comes from the verified context only", () => {
  const createApp = () => {
    const app = new Hono<ChatEnv>();
    app.use("*", stubWorkspaceContext);
    app.route("/", createChatRoutes());
    return app;
  };

  it("header A with ?workspaceId=B lists A's conversations only (HEADER_A_QUERY_B)", async () => {
    const service = new LiveChatService(db);
    await service.startConversation({ workspaceId: WS_ALPHA, customerId: "cust_alpha", initialMessage: "alpha here" });
    await service.startConversation({ workspaceId: WS_BETA, customerId: "cust_beta", initialMessage: "beta secret" });

    const res = await createApp().request(
      `http://localhost/chat/conversations?workspaceId=${WS_BETA}`,
      { headers: { "x-workspace-id": WS_ALPHA } },
      { DB: db }
    );
    expect(res.status).toBe(200);
    const { conversations } = (await res.json()) as { conversations: Array<{ customer_id: string }> };
    expect(conversations.map((conv) => conv.customer_id)).toEqual(["cust_alpha"]);
  });

  it("header A with body workspaceId B writes to A only; B's rows are untouched (HEADER_A_BODY_B)", async () => {
    const service = new LiveChatService(db);
    await service.createCannedReply(WS_BETA, "beta", "Beta reply", "beta content");

    const res = await createApp().request(
      "http://localhost/chat/canned-replies",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workspace-id": WS_ALPHA },
        body: JSON.stringify({ workspaceId: WS_BETA, shortcut: "planted", title: "Planted", content: "aimed at beta" }),
      },
      { DB: db }
    );
    expect(res.status).toBe(201);
    expect((await service.listCannedReplies(WS_ALPHA)).map((r) => r.shortcut)).toEqual(["planted"]);
    expect((await service.listCannedReplies(WS_BETA)).map((r) => r.shortcut)).toEqual(["beta"]);
  });
});
