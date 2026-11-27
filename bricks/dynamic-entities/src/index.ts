export { createEntityRoutes } from "./routes.ts";
export type { EntityEnv, EntityRoutesOptions } from "./routes.ts";

export async function executeEntityRecordCreatedTrigger(ctx: {
  readonly nodeId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly payload: unknown;
}): Promise<Record<string, unknown>> {
  const record =
    ctx.payload !== null && typeof ctx.payload === "object" && !Array.isArray(ctx.payload)
      ? (ctx.payload as Record<string, unknown>)
      : { value: ctx.payload ?? null };
  return {
    out: {
      entity: typeof ctx.data.entity === "string" ? ctx.data.entity : "record",
      record,
    },
  };
}

export async function executeEntityCreateRecord(ctx: {
  readonly nodeId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly inputs: Readonly<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const record = ctx.inputs.in !== null && typeof ctx.inputs.in === "object" && !Array.isArray(ctx.inputs.in) ? (ctx.inputs.in as Record<string, unknown>) : {};
  return {
    out: {
      entity: typeof ctx.data.entity === "string" ? ctx.data.entity : "record",
      created: true,
      record: { ...record },
    },
  };
}
