import type { ExecutionResult } from "./sandbox.ts";

export interface ScriptLimits {
  cpuMs: number;
  wallMs: number;
  maxOutputBytes: number;
}

export interface ScriptIsolate {
  run(code: string, payload: unknown, limits: ScriptLimits): Promise<ExecutionResult>;
}

export interface WorkerLoaderStub {
  fetch(request: Request, init?: RequestInit): Promise<Response>;
}

export interface WorkerLoaderBinding {
  load?(spec: { id: string; code: string; env?: Record<string, unknown>; globalOutbound?: unknown }): Promise<WorkerLoaderStub> | WorkerLoaderStub;
  get?(id: string, options?: { env?: Record<string, unknown>; globalOutbound?: unknown }): WorkerLoaderStub;
}

export interface DispatchNamespaceBinding {
  get(
    name: string,
    args?: unknown,
    options?: { limits?: { cpuMs?: number; subRequests?: number } },
  ): { fetch(request: Request, init?: RequestInit): Promise<Response> };
  upload?(name: string, code: string, options?: { bindings?: unknown[] }): Promise<void> | void;
  put?(name: string, code: string, options?: { bindings?: unknown[] }): Promise<void> | void;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function wrapScriptModule(code: string): string {
  return [
    `export default {`,
    `  async fetch(request) {`,
    `    try {`,
    `      const data = await request.json();`,
    `      const payload = data?.payload;`,
    `      ${code}`,
    `      let output = null;`,
    `      if (typeof main === "function") {`,
    `        output = await main(payload);`,
    `      }`,
    `      return new Response(JSON.stringify(output === undefined ? null : output), {`,
    `        headers: { "content-type": "application/json" },`,
    `      });`,
    `    } catch (err) {`,
    `      return new Response(`,
    `        JSON.stringify({ error: err?.message || String(err) }),`,
    `        { status: 500, headers: { "content-type": "application/json" } }`,
    `      );`,
    `    }`,
    `  }`,
    `};`,
  ].join("\n");
}

export function workerLoaderIsolate(loader: unknown): ScriptIsolate {
  const binding = loader as WorkerLoaderBinding;
  return {
    async run(code: string, payload: unknown, limits: ScriptLimits): Promise<ExecutionResult> {
      const startTime = Date.now();

      if (typeof code !== "string" || new TextEncoder().encode(code).length > 64 * 1024) {
        return {
          status: "error",
          durationMs: 0,
          result: null,
          errorMessage: "Script source exceeds maximum allowed size of 64 KiB",
        };
      }

      const scriptId = `scr_${(await sha256Hex(code)).slice(0, 32)}`;
      const wrapped = wrapScriptModule(code);

      try {
        let worker: WorkerLoaderStub | undefined;
        if (typeof binding?.load === "function") {
          worker = await binding.load({
            id: scriptId,
            code: wrapped,
            env: {},
            globalOutbound: null,
          });
        } else if (typeof binding?.get === "function") {
          worker = binding.get(scriptId, {
            env: {},
            globalOutbound: null,
          });
        } else if (typeof loader === "function") {
          worker = await (loader as any)({
            id: scriptId,
            code: wrapped,
            env: {},
            globalOutbound: null,
          });
        }

        if (!worker || typeof worker.fetch !== "function") {
          return {
            status: "error",
            durationMs: Math.max(1, Date.now() - startTime),
            result: null,
            errorMessage: "WorkerLoader returned invalid worker instance",
          };
        }

        const request = new Request("http://isolate/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload }),
        });

        const signal = AbortSignal.timeout(limits.wallMs);
        const response = await worker.fetch(request, { signal });
        const durationMs = Math.max(1, Date.now() - startTime);

        const text = await response.text();
        if (new TextEncoder().encode(text).length > limits.maxOutputBytes) {
          return {
            status: "error",
            durationMs,
            result: null,
            errorMessage: "Output exceeded maximum allowed size",
          };
        }

        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }

        if (!response.ok) {
          const errObj = parsed as { error?: string } | null;
          return {
            status: "error",
            durationMs,
            result: null,
            errorMessage: errObj?.error || `Script execution failed with HTTP ${response.status}`,
          };
        }

        return {
          status: "success",
          durationMs,
          result: parsed,
          errorMessage: null,
        };
      } catch (err: unknown) {
        const durationMs = Math.max(1, Date.now() - startTime);
        const e = err as Error;
        const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError" || /timeout|aborted|cancelled|time limit|cpu limit/i.test(e?.message || "");

        if (isTimeout) {
          return {
            status: "timeout",
            durationMs,
            result: null,
            errorMessage: "Script execution timed out",
          };
        }

        return {
          status: "error",
          durationMs,
          result: null,
          errorMessage: e?.message || "Script execution threw an error",
        };
      }
    },
  };
}

export function dispatchNamespaceIsolate(dispatcher: unknown): ScriptIsolate {
  const binding = dispatcher as DispatchNamespaceBinding;
  return {
    async run(code: string, payload: unknown, limits: ScriptLimits): Promise<ExecutionResult> {
      const startTime = Date.now();

      if (typeof code !== "string" || new TextEncoder().encode(code).length > 64 * 1024) {
        return {
          status: "error",
          durationMs: 0,
          result: null,
          errorMessage: "Script source exceeds maximum allowed size of 64 KiB",
        };
      }

      const scriptId = `scr_${(await sha256Hex(code)).slice(0, 32)}`;
      const wrapped = wrapScriptModule(code);

      try {
        if (typeof binding?.upload === "function") {
          await binding.upload(scriptId, wrapped, { bindings: [] });
        } else if (typeof binding?.put === "function") {
          await binding.put(scriptId, wrapped, { bindings: [] });
        }

        const worker = binding?.get(
          scriptId,
          {},
          {
            limits: { cpuMs: limits.cpuMs, subRequests: 0 },
          },
        );

        if (!worker || typeof worker.fetch !== "function") {
          return {
            status: "error",
            durationMs: Math.max(1, Date.now() - startTime),
            result: null,
            errorMessage: "Dispatch namespace returned invalid worker instance",
          };
        }

        const request = new Request("http://isolate/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload }),
        });

        const signal = AbortSignal.timeout(limits.wallMs);
        const response = await worker.fetch(request, { signal });
        const durationMs = Math.max(1, Date.now() - startTime);

        const text = await response.text();
        if (new TextEncoder().encode(text).length > limits.maxOutputBytes) {
          return {
            status: "error",
            durationMs,
            result: null,
            errorMessage: "Output exceeded maximum allowed size",
          };
        }

        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }

        if (!response.ok) {
          const errObj = parsed as { error?: string } | null;
          return {
            status: "error",
            durationMs,
            result: null,
            errorMessage: errObj?.error || `Script execution failed with HTTP ${response.status}`,
          };
        }

        return {
          status: "success",
          durationMs,
          result: parsed,
          errorMessage: null,
        };
      } catch (err: unknown) {
        const durationMs = Math.max(1, Date.now() - startTime);
        const e = err as Error;
        const isTimeout = e?.name === "TimeoutError" || e?.name === "AbortError" || /timeout|aborted|cancelled|time limit|cpu limit/i.test(e?.message || "");

        if (isTimeout) {
          return {
            status: "timeout",
            durationMs,
            result: null,
            errorMessage: "Script execution timed out",
          };
        }

        return {
          status: "error",
          durationMs,
          result: null,
          errorMessage: e?.message || "Script execution threw an error",
        };
      }
    },
  };
}

export function createScriptIsolate(env?: { SCRIPT_LOADER?: unknown; SCRIPT_DISPATCH?: unknown } | null): ScriptIsolate {
  if (env && typeof env === "object") {
    if (env.SCRIPT_LOADER) {
      return workerLoaderIsolate(env.SCRIPT_LOADER);
    }
    if (env.SCRIPT_DISPATCH) {
      return dispatchNamespaceIsolate(env.SCRIPT_DISPATCH);
    }
  }

  return {
    async run(): Promise<ExecutionResult> {
      return {
        status: "error",
        durationMs: 0,
        result: null,
        errorMessage: "SCRIPT_ISOLATION_UNAVAILABLE",
      };
    },
  };
}
