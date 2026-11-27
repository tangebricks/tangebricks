export * from "./sandbox.ts";
export * from "./middleware.ts";
export * from "./routes.ts";
export * from "./isolate.ts";

export async function executeRunSandboxScript(ctx: {
  readonly nodeId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly inputs: Readonly<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  return {
    out: {
      scriptId: typeof ctx.data.scriptId === "string" ? ctx.data.scriptId : "default",
      output: ctx.inputs.in ?? null,
    },
  };
}
