import { NotConfiguredError } from "@poc/sdk";
import type { D1Like, DeliveryAdapter, ExecutionContext } from "@poc/sdk";
import { CHANNEL_CREDENTIALS_KEY_ENV, MessageDispatcherService } from "./dispatcher.ts";
import type { OutboundTemplate } from "./dispatcher.ts";
export * from "./dispatcher.ts";
export * from "./routes.ts";

/**
 * The `omnichannel-outbound.send_message` workflow node as assembled. Story 0.9 (B11): an assembled app supplies no
 * delivery adapter, so the node fails NOT_CONFIGURED; it never reports a message as dispatched that was not sent.
 * An app that has adapters builds its executor with `createSendOutboundMessageExecutor`.
 */
export async function executeSendOutboundMessage(ctx: {
  readonly nodeId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly inputs: Readonly<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const channel = typeof ctx.data.channel === "string" ? ctx.data.channel : "email";
  throw new NotConfiguredError(
    `omnichannel-outbound.send_message (${ctx.nodeId}): no delivery adapter is configured for ${channel}; the message was not dispatched.`,
  );
}

export interface SendOutboundMessageExecutorOptions {
  /** One adapter per provider string, as for the routes. Required: with none the node stays NOT_CONFIGURED. */
  adapters: Readonly<Record<string, DeliveryAdapter>>;
  /** Waits between retries. Tests only. */
  sleep?: (ms: number) => Promise<void>;
  /** `PX_ENVIRONMENT`: in production a test-only mock adapter is never used. */
  environment?: string;
}

/**
 * The node declares the secret (manifest `nodes[].secrets`), so the runtime hands it over when the host set it. A host
 * that did not set it gets undefined (channels with credentials then answer NOT_CONFIGURED); any other refusal, such
 * as an undeclared secret, is a wiring bug and is thrown, never hidden.
 */
function optionalSecret(ctx: Pick<ExecutionContext, "secret">, name: string): string | undefined {
  try {
    return ctx.secret(name);
  } catch (error) {
    if (error instanceof Error && /was not provided/.test(error.message)) return undefined;
    throw error;
  }
}

/**
 * Story 2.4: the send node over the same dispatcher path as `POST /messages/send` (verified sender, one recipient, no
 * header break, retries, `sent` only with a provider id) in the run's verified workspace. The message comes from the
 * `in` port: `{ recipient, body?, subject?, template?, channel? }`; the node's `channel` setting is the default channel.
 * A refusal or a failed delivery throws, so a run never records a message as dispatched that was not.
 */
export function createSendOutboundMessageExecutor(options: SendOutboundMessageExecutorOptions) {
  if (!options || !options.adapters || Object.keys(options.adapters).length === 0) {
    throw new NotConfiguredError("createSendOutboundMessageExecutor needs at least one delivery adapter");
  }
  return async (
    ctx: Pick<ExecutionContext, "nodeId" | "workspaceId" | "data" | "inputs" | "secret" | "binding">,
  ): Promise<Record<string, unknown>> => {
    const input = ctx.inputs.in && typeof ctx.inputs.in === "object" ? (ctx.inputs.in as Record<string, unknown>) : {};
    const channel =
      typeof input.channel === "string" && input.channel.length > 0 ? input.channel : typeof ctx.data.channel === "string" ? ctx.data.channel : "email";
    if (typeof input.recipient !== "string") throw new Error(`omnichannel-outbound.send_message (${ctx.nodeId}): input "recipient" is required`);
    const service = new MessageDispatcherService(ctx.binding<D1Like>("DB"), {
      adapters: options.adapters,
      credentialsKey: optionalSecret(ctx, CHANNEL_CREDENTIALS_KEY_ENV),
      ...(options.environment !== undefined ? { environment: options.environment } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    const result = await service.sendMessage(ctx.workspaceId, channel, {
      recipient: input.recipient,
      ...(typeof input.body === "string" ? { body: input.body } : {}),
      ...(typeof input.subject === "string" ? { subject: input.subject } : {}),
      ...(input.template && typeof input.template === "object" ? { template: input.template as OutboundTemplate } : {}),
      // Only a channel an owner/admin opened to workflows (workflowSendAllowed) sends for a run.
      viaWorkflow: true,
    });
    if (!result.ok) {
      if (result.errorCode === "NOT_CONFIGURED") throw new NotConfiguredError(`omnichannel-outbound.send_message (${ctx.nodeId}): ${result.error.replace(/^NOT_CONFIGURED: /, "")}`);
      throw new Error(`omnichannel-outbound.send_message (${ctx.nodeId}): ${result.errorCode ?? "REFUSED"}: ${result.error}`);
    }
    const dispatch = result.dispatch;
    if (dispatch.status !== "sent") {
      throw new Error(`omnichannel-outbound.send_message (${ctx.nodeId}): delivery failed (${dispatch.error_text ?? "unknown"}) after ${dispatch.attempts} attempt(s); dispatch ${dispatch.id}`);
    }
    return { out: { dispatched: true, dispatchId: dispatch.id, externalId: dispatch.external_id, attempts: dispatch.attempts } };
  };
}
