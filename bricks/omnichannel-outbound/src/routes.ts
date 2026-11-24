import { Hono } from "hono";
import { z } from "zod";
import type { D1Like, RequestContext } from "@poc/sdk";
import { WORKSPACE_ADMIN_ROLES, pxEnvironment, workspaceRoleRefusal } from "@poc/sdk";
import { MessageDispatcherService } from "./dispatcher.ts";
import type { DeliveryAdapter } from "./dispatcher.ts";

export interface MessageEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified request context set by the workspace middleware; the only source of the caller's role. */
    ctx?: RequestContext;
  };
}

export interface MessageRouteOptions {
  channel?: "email" | "sms" | "whatsapp" | "slack";
  adapter?: DeliveryAdapter;
}

const SendMessageSchema = z.object({
  channel: z.string().min(1).max(64).optional(),
  recipient: z.string().min(1).max(255),
  subject: z.string().max(255).optional(),
  body: z.string().min(1).max(65536),
});

const CreateChannelSchema = z.object({
  channelType: z.enum(["email", "sms", "whatsapp", "slack", "discord"]),
  provider: z.string().min(1).max(64),
  senderAddress: z.string().min(1).max(255),
  config: z.record(z.string(), z.unknown()).default({}),
});

export function createMessageRoutes(options: MessageRouteOptions = {}): Hono<MessageEnv> {
  const app = new Hono<MessageEnv>();

  // Send message. Owner/admin only: outbound messages go out under the workspace's sender identity (sweep B8).
  app.post("/messages/send", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

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

    const channelChoice = parsed.data.channel || options.channel || "email";
    const service = new MessageDispatcherService(c.env.DB, options.adapter, { environment: pxEnvironment(c.env) });
    const result = await service.sendMessage(
      workspace.id,
      channelChoice,
      parsed.data.recipient,
      parsed.data.body,
      parsed.data.subject
    );

    if (!result.ok) {
      return c.json(
        { error: result.error, ...(result.errorCode ? { code: result.errorCode } : {}) },
        result.code as 400 | 404 | 500 | 503,
      );
    }

    return c.json({ dispatch: result.dispatch }, 200);
  });

  // Query dispatch history
  app.get("/messages/history", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const channelId = c.req.query("channelId");
    const limit = Number(c.req.query("limit")) || 50;

    const service = new MessageDispatcherService(c.env.DB, options.adapter, { environment: pxEnvironment(c.env) });
    const history = await service.listDispatches(workspace.id, channelId, limit);
    return c.json({ history }, 200);
  });

  // List channels
  app.get("/messages/channels", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new MessageDispatcherService(c.env.DB, options.adapter, { environment: pxEnvironment(c.env) });
    const channels = await service.listChannels(workspace.id);
    return c.json({ channels }, 200);
  });

  // Configure new channel. Owner/admin only: a channel sets the workspace's sender address (sweep B8).
  app.post("/messages/channels", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateChannelSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = new MessageDispatcherService(c.env.DB, options.adapter, { environment: pxEnvironment(c.env) });
    const result = await service.createChannel(
      workspace.id,
      parsed.data.channelType,
      parsed.data.provider,
      parsed.data.senderAddress,
      parsed.data.config
    );

    if (!result.ok) {
      return c.json({ error: result.error }, result.code as 400 | 500);
    }

    return c.json({ channel: result.channel }, 201);
  });

  return app;
}
