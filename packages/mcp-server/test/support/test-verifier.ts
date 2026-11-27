import type { McpScope, McpTokenVerifier } from "../../src/index.ts";

// The test token verifier (story 0.15). The standalone MCP server has no shared bearer any more: a token is bound to one
// project with fixed scopes. Local tests mint a token per project with testToken(); the verifier accepts only the exact
// shape below (an exact secret prefix, a project slug, and only known scopes), so a prefix, a suffix or an unknown scope
// is refused like any wrong token.

const TEST_TOKEN_SECRET = "test-mcp-token-0123456789";
export const TEST_TOKEN_USER_ID = "user:mcp-test";
export const TEST_TOKEN_CLIENT = "mcp-test";
export const ALL_TEST_SCOPES: readonly McpScope[] = ["read", "edit", "deploy", "connect"];

const SHAPE = /^test-mcp-token-0123456789\.(.+)\.((?:read|edit|deploy|connect)(?:\+(?:read|edit|deploy|connect))*)(?:~([A-Za-z0-9:_ -]{1,60}))?$/;

/**
 * A token bound to `project` with `scopes` (all four by default). `client` labels a distinct token (and author) for the
 * same project, the way two MCP clients would each hold their own token.
 */
export function testToken(project: string, scopes: readonly McpScope[] = ALL_TEST_SCOPES, client?: string): string {
  return `${TEST_TOKEN_SECRET}.${project}.${scopes.join("+")}${client ? `~${client}` : ""}`;
}

/** The author id a call made with testToken(project, scopes, client) is recorded under. */
export const testTokenId = (project: string, client?: string) => (client ? `mcp-test-token:${project}:${client}` : `mcp-test-token:${project}`);

export const testTokenVerifier: McpTokenVerifier = async (token) => {
  const match = SHAPE.exec(token);
  if (!match) return null;
  const project = match[1]!;
  const scopes = [...new Set(match[2]!.split("+"))] as McpScope[];
  const client = match[3];
  return {
    userId: TEST_TOKEN_USER_ID,
    projectId: project,
    scopes,
    tokenId: testTokenId(project, client),
    clientName: client ?? TEST_TOKEN_CLIENT,
  };
};

/** The project a JSON-RPC message's tool call names, if any. */
export function projectOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const params = (message as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return undefined;
  const args = (params as { arguments?: unknown }).arguments;
  if (typeof args !== "object" || args === null) return undefined;
  const project = (args as { project?: unknown }).project;
  return typeof project === "string" ? project : undefined;
}
