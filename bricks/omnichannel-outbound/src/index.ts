import { NotConfiguredError } from "@poc/sdk";
export * from "./dispatcher.ts";
export * from "./routes.ts";

/**
 * The `omnichannel-outbound.send_message` workflow node. Story 0.9 (B11): there is no real delivery
 * adapter for workflow sends, so the node fails NOT_CONFIGURED; it never reports `dispatched: true`
 * for a message that was not sent.
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
