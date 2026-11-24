import type { D1Like } from "@poc/sdk";
import { isProductionEnvironment, scoped } from "@poc/sdk";

export type ChannelType = "email" | "sms" | "whatsapp" | "slack" | "discord";

export interface ChannelRecord {
  id: string;
  workspace_id: string;
  channel_type: ChannelType;
  provider: string;
  sender_address: string;
  active: boolean;
  config: Record<string, unknown>;
  created_at: string;
}

export interface DispatchRecord {
  id: string;
  workspace_id: string;
  channel_id: string;
  recipient: string;
  subject: string | null;
  body_text: string;
  status: "queued" | "sent" | "delivered" | "failed";
  external_id: string | null;
  error_text: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface OutboundMessage {
  recipient: string;
  subject?: string;
  body: string;
}

export interface DeliveryAdapter {
  send(
    channel: ChannelRecord,
    message: OutboundMessage
  ): Promise<{ success: boolean; externalId?: string; error?: string }>;
}

/**
 * TEST-ONLY adapter: it records messages in memory and reports them "sent" without sending anything.
 * Never used by default (story 0.9, B11); a test injects it explicitly.
 */
export class MockDeliveryAdapter implements DeliveryAdapter {
  public sentMessages: Array<{ channel: ChannelRecord; message: OutboundMessage }> = [];
  public shouldFail = false;

  async send(channel: ChannelRecord, message: OutboundMessage) {
    if (this.shouldFail) {
      return { success: false, error: "Mock provider connection refused" };
    }
    this.sentMessages.push({ channel, message });
    return {
      success: true,
      externalId: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    };
  }
}

export class MessageDispatcherService {
  private readonly db: D1Like;
  private readonly adapter: DeliveryAdapter | undefined;

  constructor(db: D1Like, adapter?: DeliveryAdapter, options: { environment?: string } = {}) {
    this.db = db;
    // Story 0.9 (B11): no default adapter. Without one, sending fails NOT_CONFIGURED instead of
    // recording a message as "sent". In production the test-only mock is refused the same way.
    this.adapter =
      isProductionEnvironment(options.environment) && adapter instanceof MockDeliveryAdapter ? undefined : adapter;
  }

  /**
   * Registers a new communication channel for a workspace.
   */
  async createChannel(
    workspaceId: string,
    channelType: ChannelType,
    providerRaw: string,
    senderAddressRaw: string,
    config: Record<string, unknown> = {}
  ): Promise<{ ok: true; channel: ChannelRecord } | { ok: false; error: string; code: number }> {
    const provider = providerRaw.trim().toLowerCase();
    const sender = senderAddressRaw.trim();

    if (!provider || provider.length > 64) {
      return { ok: false, error: "Provider name must be between 1 and 64 characters", code: 400 };
    }
    if (!sender || sender.length > 255) {
      return { ok: false, error: "Sender address must be between 1 and 255 characters", code: 400 };
    }

    const id = `chn_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const configJson = JSON.stringify(config);

    await scoped(this.db, workspaceId).insert("msg_channels", {
      id,
      channel_type: channelType,
      provider,
      sender_address: sender,
      active: 1,
      config_json: configJson,
      created_at: now,
    });

    return {
      ok: true,
      channel: {
        id,
        workspace_id: workspaceId,
        channel_type: channelType,
        provider,
        sender_address: sender,
        active: true,
        config,
        created_at: now,
      },
    };
  }

  /**
   * Lists communication channels configured for a workspace.
   */
  async listChannels(workspaceId: string): Promise<ChannelRecord[]> {
    interface Row {
      id: string;
      workspace_id: string;
      channel_type: ChannelType;
      provider: string;
      sender_address: string;
      active: number;
      config_json: string;
      created_at: string;
    }

    const rows = await scoped(this.db, workspaceId).select<Row>(
      "msg_channels",
      "active = 1",
      [],
      { orderBy: "created_at DESC" }
    );

    return rows.map((r) => ({
      ...r,
      active: r.active === 1,
      config: JSON.parse(r.config_json || "{}"),
    }));
  }

  /**
   * Dispatches an outbound message across a specified channel or the first active channel of that type.
   */
  async sendMessage(
    workspaceId: string,
    channelIdOrType: string,
    recipientRaw: string,
    bodyRaw: string,
    subject?: string
  ): Promise<{ ok: true; dispatch: DispatchRecord } | { ok: false; error: string; code: number; errorCode?: "NOT_CONFIGURED" }> {
    const recipient = recipientRaw.trim();
    if (!recipient || recipient.length > 255) {
      return { ok: false, error: "Recipient must be between 1 and 255 characters", code: 400 };
    }

    const body = bodyRaw.trim();
    if (!body || body.length > 65536) {
      return { ok: false, error: "Message body must be between 1 and 65536 characters", code: 400 };
    }

    // Locate channel
    interface Row {
      id: string;
      workspace_id: string;
      channel_type: ChannelType;
      provider: string;
      sender_address: string;
      active: number;
      config_json: string;
      created_at: string;
    }

    let channelRow = await scoped(this.db, workspaceId).first<Row>(
      "msg_channels",
      "id = ? AND active = 1",
      [channelIdOrType]
    );
    if (!channelRow) {
      channelRow = await scoped(this.db, workspaceId).first<Row>(
        "msg_channels",
        "channel_type = ? AND active = 1",
        [channelIdOrType]
      );
    }

    if (!channelRow) {
      return { ok: false, error: `No active channel found matching "${channelIdOrType}"`, code: 404 };
    }

    const channel: ChannelRecord = {
      ...channelRow,
      active: channelRow.active === 1,
      config: JSON.parse(channelRow.config_json || "{}"),
    };

    if (!this.adapter) {
      return {
        ok: false,
        error: `NOT_CONFIGURED: no delivery adapter is configured for ${channel.channel_type} (${channel.provider}); the message was not sent.`,
        code: 503,
        errorCode: "NOT_CONFIGURED",
      };
    }

    const dispatchId = `dsp_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    // Call delivery adapter
    const delivery = await this.adapter.send(channel, {
      recipient,
      subject,
      body,
    });

    const status: "sent" | "failed" = delivery.success ? "sent" : "failed";
    const externalId = delivery.externalId || null;
    const errorText = delivery.error || null;
    const sentAt = delivery.success ? now : null;

    // Record in D1
    await scoped(this.db, workspaceId).insert("msg_dispatches", {
      id: dispatchId,
      channel_id: channel.id,
      recipient,
      subject: subject?.trim() || null,
      body_text: body,
      status,
      external_id: externalId,
      error_text: errorText,
      created_at: now,
      sent_at: sentAt,
    });

    const dispatch: DispatchRecord = {
      id: dispatchId,
      workspace_id: workspaceId,
      channel_id: channel.id,
      recipient,
      subject: subject?.trim() || null,
      body_text: body,
      status,
      external_id: externalId,
      error_text: errorText,
      created_at: now,
      sent_at: sentAt,
    };

    return { ok: true, dispatch };
  }

  /**
   * Lists message dispatches in a workspace.
   */
  async listDispatches(workspaceId: string, channelId?: string, limit = 50): Promise<DispatchRecord[]> {
    if (channelId) {
      return scoped(this.db, workspaceId).select<DispatchRecord>(
        "msg_dispatches",
        "channel_id = ?",
        [channelId],
        { orderBy: "created_at DESC", limit }
      );
    }
    return scoped(this.db, workspaceId).select<DispatchRecord>(
      "msg_dispatches",
      undefined,
      [],
      { orderBy: "created_at DESC", limit }
    );
  }
}
