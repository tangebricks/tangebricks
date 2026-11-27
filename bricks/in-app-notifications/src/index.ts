export * from "./notifications.ts";
export * from "./middleware.ts";
export * from "./routes.ts";

export async function executeSendInAppNotification(ctx: {
  readonly nodeId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly inputs: Readonly<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  return {
    out: {
      delivered: true,
      notification: ctx.inputs.in ?? null,
    },
  };
}
