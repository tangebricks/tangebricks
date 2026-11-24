/**
 * Platform operators are the people who may write all-tenant tables (global feature-flag and meter definitions, plan
 * prices) and create platform super-admins. A caller is an operator only when their user id is listed in the
 * `PX_PLATFORM_OPERATORS` env var (comma-separated). No value, an empty value, or a value that is not a string means
 * nobody is an operator, so every operator-only write is refused (fail closed). Workspace roles never count here: a
 * workspace owner is not a platform operator.
 */
export const PLATFORM_OPERATORS_ENV = "PX_PLATFORM_OPERATORS";

export function platformOperatorIds(env: unknown): string[] {
  if (!env || typeof env !== "object") return [];
  const raw = (env as Record<string, unknown>)[PLATFORM_OPERATORS_ENV];
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function isPlatformOperator(env: unknown, userId: string | null | undefined): boolean {
  if (typeof userId !== "string" || userId.length === 0) return false;
  return platformOperatorIds(env).includes(userId);
}
