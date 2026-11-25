/**
 * The verified identity of a request, set once by the workspace middleware after it checked membership. Handlers take
 * the workspace from here and never from the request body or query. The object is frozen, so nothing after the
 * middleware can point it at another workspace.
 */
export interface RequestContext {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: string;
}

/**
 * The user-id prefix an API-key identity gives its caller (story 1.11): `apikey:<keyId>`. Only a naming convention:
 * whether a request was authenticated by a key is decided by the `authenticatedBy` marker, never by this prefix.
 */
export const API_KEY_USER_PREFIX = "apikey:";

/** The request variable an alternative identity step sets, and only it (story 1.11). */
export const AUTHENTICATED_BY_VAR = "authenticatedBy";

/** The `authenticatedBy` value set when a request was authenticated by an API key. */
export const API_KEY_AUTHENTICATION = "api-key";

/** True when an API-key identity step authenticated this request (the `authenticatedBy` marker), whatever the user id. */
export function isApiKeyRequest(c: unknown): boolean {
  const get = (c as { get?: (key: string) => unknown } | undefined)?.get;
  if (typeof get !== "function") return false;
  return get.call(c, AUTHENTICATED_BY_VAR) === API_KEY_AUTHENTICATION;
}

/**
 * Story 2.6: the request variable an API-key identity step sets to the user id of the person who created the key (a
 * key acts for its creator at most at their role, story 1.11). Read it with `apiKeyCreatorId`.
 */
export const API_KEY_CREATOR_VAR = "apiKeyCreator";

/** The creator of the API key that authenticated this request, or undefined when it was not a key (or none was set). */
export function apiKeyCreatorId(c: unknown): string | undefined {
  if (!isApiKeyRequest(c)) return undefined;
  const value = (c as { get: (key: string) => unknown }).get(API_KEY_CREATOR_VAR);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * For routes only a person may call (minting keys, OAuth clients, codes or tokens, invites, signing secrets, workspace
 * management): the 403 `API_KEY_FORBIDDEN` response when an API key authenticated the request, otherwise undefined.
 */
export function refuseApiKeyCaller(c: unknown): Response | undefined {
  if (!isApiKeyRequest(c)) return undefined;
  return new Response(JSON.stringify({ error: "API keys cannot call this route", code: "API_KEY_FORBIDDEN" }), {
    status: 403,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}
