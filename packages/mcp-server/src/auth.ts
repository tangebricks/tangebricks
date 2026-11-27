// Who may call the standalone MCP server, and on which project (story 0.15).
//
// The server no longer trusts one shared bearer. The host injects a token verifier; the verifier turns a presented
// bearer into a user, the one project the token is bound to, and its scopes. With no verifier the server refuses every
// call. Tool calls are then authorised against the verified project and scopes, and the author comes from the verified
// user, never from request headers.

export type McpScope = "read" | "edit" | "deploy" | "connect";

/** The only scopes a token can carry. */
export const MCP_SCOPES: readonly McpScope[] = ["read", "edit", "deploy", "connect"];

export function isMcpScope(value: unknown): value is McpScope {
  return typeof value === "string" && (MCP_SCOPES as readonly string[]).includes(value);
}

export interface McpVerifiedToken {
  /** The user the token acts for. */
  userId: string;
  /** The one project the token is bound to. Every tool call runs against it. */
  projectId: string;
  scopes: readonly McpScope[];
  /** Optional token id, recorded as the author id. */
  tokenId?: string;
  /** Optional client label, recorded on the author. */
  clientName?: string;
}

/**
 * Turns a presented bearer into a verified token, or null to refuse it. `env` is the Worker's bindings, so a verifier can
 * read its records from a secret binding.
 */
export type McpTokenVerifier = (token: string, env: Record<string, unknown>) => Promise<McpVerifiedToken | null>;

/** The scope a tool needs: deploy_apply needs deploy, request_connection needs connect, other writes need edit. */
export function requiredScopeForTool(name: string, readOnly: boolean): McpScope {
  if (readOnly) return "read";
  if (name === "deploy_apply") return "deploy";
  if (name === "request_connection") return "connect";
  return "edit";
}

/** Whether `scopes` allow a tool. Any valid scope allows reading; a write needs its own scope. */
export function scopesAllow(scopes: readonly McpScope[], required: McpScope): boolean {
  if (required === "read") return scopes.some((s) => isMcpScope(s));
  return scopes.includes(required);
}

export async function hashMcpToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two equal-length hex digests in time that does not depend on where they first differ. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** A stored token record: only the SHA-256 of the token is kept. */
export interface McpTokenRecord {
  tokenHash: string;
  userId: string;
  projectId: string;
  scopes: readonly string[];
  tokenId?: string;
  clientName?: string;
}

function parseRecord(value: unknown): McpTokenRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(r.tokenHash)) return null;
  if (typeof r.userId !== "string" || r.userId.length === 0) return null;
  if (typeof r.projectId !== "string" || r.projectId.length === 0) return null;
  if (!Array.isArray(r.scopes)) return null;
  return {
    tokenHash: r.tokenHash,
    userId: r.userId,
    projectId: r.projectId,
    scopes: r.scopes.filter((s): s is string => typeof s === "string"),
    ...(typeof r.tokenId === "string" ? { tokenId: r.tokenId } : {}),
    ...(typeof r.clientName === "string" ? { clientName: r.clientName } : {}),
  };
}

async function verifyAgainst(token: string, records: readonly McpTokenRecord[]): Promise<McpVerifiedToken | null> {
  if (token.length === 0) return null;
  const presented = await hashMcpToken(token);
  let match: McpTokenRecord | null = null;
  // Every record is compared, so the time taken does not say which record (if any) matched.
  for (const record of records) {
    if (sameDigest(presented, record.tokenHash) && match === null) match = record;
  }
  if (!match) return null;
  const scopes = match.scopes.filter(isMcpScope);
  if (scopes.length === 0) return null;
  return {
    userId: match.userId,
    projectId: match.projectId,
    scopes,
    ...(match.tokenId ? { tokenId: match.tokenId } : {}),
    ...(match.clientName ? { clientName: match.clientName } : {}),
  };
}

/** The secret binding the deployed MCP Worker reads its hashed per-project token records from. */
export const MCP_TOKEN_RECORDS_BINDING = "MCP_TOKEN_RECORDS";

/**
 * A verifier that reads hashed per-project token records (a JSON array of McpTokenRecord) from a secret binding. A missing,
 * empty or malformed binding refuses every token.
 */
export function createHashedTokenVerifier(binding: string = MCP_TOKEN_RECORDS_BINDING): McpTokenVerifier {
  return async (token, env) => {
    const raw = env[binding];
    if (typeof raw !== "string" || raw.trim().length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const records = parsed.map(parseRecord).filter((r): r is McpTokenRecord => r !== null);
    return verifyAgainst(token, records);
  };
}

/** A verifier over plaintext tokens held in memory (local tools and harnesses). Only their hashes are kept. */
export function createStaticTokenVerifier(
  tokens: ReadonlyArray<{
    token: string;
    userId: string;
    projectId: string;
    scopes: readonly McpScope[];
    tokenId?: string;
    clientName?: string;
  }>,
): McpTokenVerifier {
  const records = Promise.all(tokens.map(async ({ token, ...rest }) => ({ ...rest, tokenHash: await hashMcpToken(token) })));
  return async (token) => verifyAgainst(token, await records);
}
