/**
 * Story 0.9 (no fake success): the typed error a path throws when the thing it
 * needs (a provider, an adapter, a real executor, a deploy target) is not
 * configured. Callers record it as a failure; nothing reports success instead.
 *
 * The message always starts with the code so run records, logs and step
 * errors that only keep the message still carry it.
 */
export type NotConfiguredCode = "NOT_CONFIGURED" | "NO_TARGET" | "PROVIDER_ERROR";

export class NotConfiguredError extends Error {
  readonly code: NotConfiguredCode;
  constructor(message: string, code: NotConfiguredCode = "NOT_CONFIGURED") {
    super(`${code}: ${message}`);
    this.name = "NotConfiguredError";
    this.code = code;
  }
}

/** The platform's deploy environment switch (`PX_ENVIRONMENT`) from a Worker env, if set. */
export function pxEnvironment(env: unknown): string | undefined {
  const value = env && typeof env === "object" ? (env as Record<string, unknown>)["PX_ENVIRONMENT"] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** True when an environment switch (e.g. `PX_ENVIRONMENT`) names production. */
export function isProductionEnvironment(environment: string | undefined | null): boolean {
  return typeof environment === "string" && environment.trim().toLowerCase() === "production";
}
