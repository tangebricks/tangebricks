/**
 * Canonical AuthUser shape for authenticated callers across identity providers,
 * middleware, and application bricks.
 */
export interface AuthUser {
  /** Canonical user ID or provider subject. */
  id?: string;
  /** Legacy alias for id, matching uid-keyed middleware expectations. */
  uid?: string;
  /** Primary verified or declared user email. */
  email?: string | null;
  /** User display name or full name. */
  displayName?: string | null;
  /** Whether the user email has been verified. */
  emailVerified?: boolean;
  /** ISO 8601 string when the user record was created. */
  createdAt?: string;
  /** Optional active workspace or tenant ID. */
  workspaceId?: string;
  /** Assigned roles in the resolved context. */
  roles?: string[];
  /** Raw or custom claims from external token verification. */
  claims?: Record<string, unknown>;
}
