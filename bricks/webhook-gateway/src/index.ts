export * from "./crypto.ts";
export * from "./gateway.ts";
export * from "./presets.ts";
export * from "./routes.ts";
export * from "./signature-scheme.ts";

export async function executeInboundWebhookTrigger(ctx: {
  readonly nodeId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly payload: unknown;
}): Promise<Record<string, unknown>> {
  const event =
    ctx.payload !== null && typeof ctx.payload === "object" && !Array.isArray(ctx.payload)
      ? (ctx.payload as Record<string, unknown>)
      : { payload: ctx.payload ?? null };
  return {
    out: {
      verified: true,
      event,
    },
  };
}
