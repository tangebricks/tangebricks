import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { D1Like, RequestContext } from "@poc/sdk";
import { WORKSPACE_ADMIN_ROLES, pxEnvironment, readBoundedText, workspaceRoleRefusal } from "@poc/sdk";
import { CHANNEL_CREDENTIALS_KEY_ENV, MAX_CREDENTIALS_JSON, MAX_CREDENTIAL_ENTRIES, MessageDispatcherService, credentialsJsonBytes } from "./dispatcher.ts";
import type { DeliveryAdapter } from "./dispatcher.ts";

export interface MessageEnv {
  Bindings: { DB: D1Like; PX_CHANNEL_CREDENTIALS_KEY?: string; PX_ENVIRONMENT?: string };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified request context set by the workspace middleware; the only source of the caller's role. */
    ctx?: RequestContext;
  };
}

export interface MessageRouteOptions {
  channel?: "email" | "sms" | "whatsapp" | "slack";
  /**
   * One delivery adapter per provider string (story 2.4); a channel's `provider` selects its adapter. No default: a
   * channel whose provider has no adapter answers 503 NOT_CONFIGURED on send.
   */
  adapters?: Readonly<Record<string, DeliveryAdapter>>;
}

const TemplateSchema = z.strictObject({
  name: z.string().min(1).max(256),
  language: z.string().min(2).max(16).optional(),
  variables: z.record(z.string().max(64), z.string().max(1024)).optional(),
});

const SendMessageSchema = z
  .object({
    channel: z.string().min(1).max(64).optional(),
    recipient: z.string().min(1).max(255),
    subject: z.string().max(255).optional(),
    body: z.string().min(1).max(65536).optional(),
    template: TemplateSchema.optional(),
  })
  .refine((v) => v.body !== undefined || v.template !== undefined, { message: "body or template is required" });

const CreateChannelSchema = z.object({
  channelType: z.enum(["email", "sms", "whatsapp", "slack", "discord"]),
  provider: z.string().min(1).max(64),
  senderAddress: z.string().min(1).max(255),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Secrets (API keys, tokens, app secrets): sealed, never returned. Capped so the sealed envelope always fits. */
  credentials: z
    .record(z.string().min(1).max(64), z.string().min(1).max(4096))
    .refine((v) => Object.keys(v).length <= MAX_CREDENTIAL_ENTRIES, { message: `credentials may have at most ${MAX_CREDENTIAL_ENTRIES} entries` })
    .refine((v) => credentialsJsonBytes(v) <= MAX_CREDENTIALS_JSON, { message: `credentials must be at most ${MAX_CREDENTIALS_JSON} bytes of JSON` })
    .optional(),
  /** Owner/admin choice: may workflow runs send through this channel? Default false. */
  workflowSendAllowed: z.boolean().optional(),
});

const UpdateChannelSchema = z.strictObject({ workflowSendAllowed: z.boolean() });

const VerifySchema = z.object({ code: z.string().min(1).max(16).optional() });

/** `?limit` 1..100 (default 50) and `?offset` 0..100000 (default 0), whole numbers only (B12). */
export function parsePaging(limitRaw: string | undefined, offsetRaw: string | undefined): { limit: number; offset: number } | null {
  const whole = (raw: string | undefined, fallback: number, min: number, max: number): number | null => {
    if (raw === undefined) return fallback;
    if (!/^\d{1,6}$/.test(raw)) return null;
    const n = Number(raw);
    return n >= min && n <= max ? n : null;
  };
  const limit = whole(limitRaw, 50, 1, 100);
  const offset = whole(offsetRaw, 0, 0, 100_000);
  return limit === null || offset === null ? null : { limit, offset };
}

type Ctx = Context<MessageEnv>;

export function createMessageRoutes(options: MessageRouteOptions = {}): Hono<MessageEnv> {
  const app = new Hono<MessageEnv>();

  const serviceFor = (c: Ctx) =>
    new MessageDispatcherService(c.env.DB, {
      ...(options.adapters ? { adapters: options.adapters } : {}),
      credentialsKey: c.env[CHANNEL_CREDENTIALS_KEY_ENV],
      environment: pxEnvironment(c.env),
    });

  const refusal = (c: Ctx, result: { error: string; code: number; errorCode?: string }) =>
    c.json({ error: result.error, ...(result.errorCode ? { code: result.errorCode } : {}) }, result.code as 400 | 404 | 409 | 410 | 429 | 500 | 502 | 503);

  async function jsonBody(c: Ctx): Promise<{ ok: true; body: unknown } | { ok: false }> {
    try {
      return { ok: true, body: await c.req.json() };
    } catch {
      return { ok: false };
    }
  }

  // Send message. Owner/admin only: outbound messages go out under the workspace's sender identity (sweep B8).
  app.post("/messages/send", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const read = await jsonBody(c);
    if (!read.ok) return c.json({ error: "Invalid JSON body" }, 400);
    const parsed = SendMessageSchema.safeParse(read.body);
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);

    const channelChoice = parsed.data.channel || options.channel || "email";
    const result = await serviceFor(c).sendMessage(workspace.id, channelChoice, {
      recipient: parsed.data.recipient,
      ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
      ...(parsed.data.subject !== undefined ? { subject: parsed.data.subject } : {}),
      ...(parsed.data.template !== undefined ? { template: parsed.data.template } : {}),
    });
    if (!result.ok) return refusal(c, result);
    return c.json({ dispatch: result.dispatch }, 200);
  });

  // Query dispatch history (bounded paging, B12).
  app.get("/messages/history", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);
    const paging = parsePaging(c.req.query("limit"), c.req.query("offset"));
    if (!paging) return c.json({ error: "limit must be a whole number from 1 to 100 and offset from 0 to 100000" }, 400);
    const channelId = c.req.query("channelId");
    const history = await serviceFor(c).listDispatches(workspace.id, { ...(channelId ? { channelId } : {}), ...paging });
    return c.json({ history }, 200);
  });

  // List channels: never credentials, only hasCredentials (B9).
  app.get("/messages/channels", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);
    const channels = await serviceFor(c).listChannels(workspace.id);
    return c.json({ channels }, 200);
  });

  // Configure new channel. Owner/admin only: a channel sets the workspace's sender address (sweep B8).
  app.post("/messages/channels", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const read = await jsonBody(c);
    if (!read.ok) return c.json({ error: "Invalid JSON body" }, 400);
    const parsed = CreateChannelSchema.safeParse(read.body);
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);

    const result = await serviceFor(c).createChannel(
      workspace.id,
      parsed.data.channelType,
      parsed.data.provider,
      parsed.data.senderAddress,
      parsed.data.config,
      parsed.data.credentials,
      { workflowSendAllowed: parsed.data.workflowSendAllowed === true },
    );
    if (!result.ok) return refusal(c, result);
    return c.json({ channel: result.channel }, 201);
  });

  // Channel settings. Owner/admin only: whether workflow runs may send under this channel's sender.
  app.patch("/messages/channels/:id", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);
    const read = await jsonBody(c);
    if (!read.ok) return c.json({ error: "Invalid JSON body" }, 400);
    const parsed = UpdateChannelSchema.safeParse(read.body);
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    const result = await serviceFor(c).setWorkflowSendAllowed(workspace.id, c.req.param("id"), parsed.data.workflowSendAllowed);
    if (!result.ok) return refusal(c, result);
    return c.json({ channel: result.channel }, 200);
  });

  // Sender verification (B8). Owner/admin only. With {code}: confirm a mailed code. Without: check the sender with the
  // provider again ("credential") or send a new code ("code").
  app.post("/messages/channels/:id/verify", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const text = await c.req.text();
    let body: unknown = {};
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }
    }
    const parsed = VerifySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);

    const service = serviceFor(c);
    const channelId = c.req.param("id");
    if (parsed.data.code !== undefined) {
      const result = await service.confirmVerification(workspace.id, channelId, parsed.data.code);
      if (!result.ok) return refusal(c, result);
      return c.json({ channel: result.channel, verified: true }, 200);
    }
    const result = await service.startVerification(workspace.id, channelId);
    if (!result.ok) return refusal(c, result);
    return c.json(
      { channel: result.channel, method: result.method, verified: result.channel.verified, ...(result.codeSent !== undefined ? { codeSent: result.codeSent } : {}) },
      200,
    );
  });

  // The webhook routes are unauthenticated: a failure answers a generic 503/500 with no secret name or detail, and the
  // detail is logged with the channel id.
  const webhookFailure = (c: Ctx, method: string, result: { code: number; errorCode?: string }) => {
    console.error(`${method} /message-webhooks: channel ${c.req.param("channelId")}: ${result.errorCode ?? "ERROR"}`);
    return result.code === 503 ? c.json({ error: "Webhook unavailable" }, 503) : c.json({ error: "Webhook processing failed" }, 500);
  };

  // Story 2.4: a provider's delivery-status webhook. The provider calls it, so it has no user and no workspace and is
  // never behind the workspace guard; the signature over the raw body, checked with the channel's own credentials, is
  // its authentication. 401 forged; 200 for an unknown channel or dispatch (nothing changes); 413 over 64 KiB.
  app.post("/message-webhooks/:channelId", async (c) => {
    const rawBody = await readBoundedText(c.req.raw);
    if (rawBody === null) return c.json({ error: "Webhook body too large" }, 413);
    try {
      const result = await serviceFor(c).handleStatusWebhook(c.req.param("channelId"), rawBody, c.req.raw.headers);
      if ("ok" in result) return webhookFailure(c, "POST", result);
      if (result.status === 401) return c.json({ error: "Invalid webhook signature" }, 401);
      return c.json({ received: true, ...(result.ignored ? { status: "ignored" } : {}), updated: result.updated }, 200);
    } catch (error) {
      console.error(`POST /message-webhooks: channel ${c.req.param("channelId")}: failed:`, error instanceof Error ? error.name : "error");
      return c.json({ error: "Webhook processing failed" }, 500);
    }
  });

  // A provider's GET subscription check: echoes the challenge only for the channel's own verify token.
  app.get("/message-webhooks/:channelId", async (c) => {
    try {
      const answer = await serviceFor(c).answerWebhookChallenge(c.req.param("channelId"), new URL(c.req.url).searchParams);
      if (answer !== null && typeof answer === "object") return webhookFailure(c, "GET", answer);
      if (answer === null) return c.json({ error: "Verification refused" }, 403);
      return c.text(answer, 200);
    } catch (error) {
      console.error(`GET /message-webhooks: channel ${c.req.param("channelId")}: failed:`, error instanceof Error ? error.name : "error");
      return c.json({ error: "Webhook verification failed" }, 500);
    }
  });

  return app;
}
