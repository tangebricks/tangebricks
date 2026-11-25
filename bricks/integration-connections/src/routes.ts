import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { D1Like, RequestContext, StructuredLogger } from "@poc/sdk";
import { WORKSPACE_ADMIN_ROLES, workspaceRoleRefusal } from "@poc/sdk";
import { catalog } from "@poc/assembler/catalog";
import type { IntegrationManifestFile } from "@poc/assembler";
import {
  IntegrationConnectionsError,
  completeWorkspaceOAuthCallback,
  disconnectWorkspaceIntegration,
  listWorkspaceIntegrations,
  startWorkspaceOAuthConnect,
} from "./service.ts";
import type { IntegrationConnectionsAdapter } from "./service.ts";

export interface IntegrationConnectionsEnv {
  Bindings: {
    DB: D1Like;
    PX_CONN_KEY?: string;
  };
  Variables: {
    user?: { uid: string };
    workspace?: { id: string; role: string; suspended: boolean };
    /** The verified request context set by the workspace middleware; the only source of the caller's role. */
    ctx?: RequestContext;
    log?: StructuredLogger;
  };
}

export interface IntegrationConnectionsRouteOptions {
  oauthStateTtlSeconds?: number;
  refreshWindowSeconds?: number;
  publicBaseUrl?: string;
  /**
   * Story 1.15 (A11): exact `https://` redirect URIs a caller may pass as `redirect_uri`, besides the default callback
   * URL. A comma string (the `allowedRedirectUris` setting) or a list; empty by default.
   */
  allowedRedirectUris?: string | readonly string[];
  adapter?: IntegrationConnectionsAdapter;
}

/**
 * Story 1.15 (A11): a connect that answers with a redirect is a top-level GET a cross-site page could trigger, so it
 * is refused when the browser says the request is cross-site (`Sec-Fetch-Site`) or names a foreign `Origin`.
 */
function isCrossSiteRequest(c: Ctx, publicBaseUrl: string | undefined): boolean {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite !== undefined) {
    const site = fetchSite.trim().toLowerCase();
    if (site !== "same-origin" && site !== "none") return true;
  }
  const originHeader = c.req.header("origin");
  if (originHeader !== undefined) {
    const allowed = new Set<string>([new URL(c.req.url).origin]);
    if (publicBaseUrl) {
      try {
        allowed.add(new URL(publicBaseUrl).origin);
      } catch {
        // an unparsable publicBaseUrl adds no allowed origin
      }
    }
    let origin: string;
    try {
      origin = new URL(originHeader.trim()).origin;
    } catch {
      return true; // "null" or garbage: not a same-origin request
    }
    if (!allowed.has(origin)) return true;
  }
  return false;
}

const CallbackPayloadSchema = z.object({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(512),
  // Story 1.15 (A10): the service trims and caps the label at 128; an empty one counts as absent.
  accountLabel: z.string().max(2048).optional(),
  // Story 1.15 (A10): a caller externalAccountId is accepted for compatibility but ignored.
  externalAccountId: z.unknown().optional(),
});

type Ctx = Context<IntegrationConnectionsEnv>;

export function createIntegrationConnectionsRoutes(
  options: IntegrationConnectionsRouteOptions = {},
): Hono<IntegrationConnectionsEnv> {
  const oauthStateTtlSeconds = options.oauthStateTtlSeconds ?? 600;
  const refreshWindowSeconds = options.refreshWindowSeconds ?? 60;
  const publicBaseUrl = options.publicBaseUrl;
  const allowedRedirectUris = options.allowedRedirectUris;
  const adapter: IntegrationConnectionsAdapter = {
    ...options.adapter,
    integrations:
      options.adapter?.integrations ??
      (catalog.integrations as Record<string, { manifest: IntegrationManifestFile }> | undefined),
  };

  const router = new Hono<IntegrationConnectionsEnv>();

  const needWorkspace = (c: Ctx) => {
    const user = c.get("user");
    const workspace = c.get("workspace");
    if (!user) {
      return { failure: c.json({ error: "Unauthorized" }, 401) } as const;
    }
    if (!workspace) {
      return { failure: c.json({ error: "Missing workspace context" }, 400) } as const;
    }
    return { user, workspace } as const;
  };

  // Connecting, completing a callback for, or disconnecting the workspace's integration replaces the credentials every
  // member's runs use, so it needs owner or admin (sweep A9). Checked before anything is read from the request.
  const needWorkspaceAdmin = (c: Ctx) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return { failure: c.json(denied.body, denied.status) } as const;
    return needWorkspace(c);
  };

  const handleStartConnect = async (c: Ctx) => {
    const ctx = needWorkspaceAdmin(c);
    if ("failure" in ctx) return ctx.failure;

    const provider = c.req.param("provider") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? c.req.query("redirectUri") ?? undefined;
    const rawScopes = c.req.query("scope") ?? c.req.query("scopes") ?? undefined;
    const scopes = rawScopes
      ? rawScopes.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
      : undefined;
    const wantsRedirect = c.req.query("redirect") === "1" || c.req.query("redirect") === "true";
    if (wantsRedirect && isCrossSiteRequest(c, publicBaseUrl)) {
      return c.json(
        { error: { code: "CSRF_REJECTED", message: "Cross-site redirecting connect requests are refused" } },
        403,
      );
    }

    try {
      const started = await startWorkspaceOAuthConnect(c.env.DB, {
        workspaceId: ctx.workspace.id,
        userId: ctx.user.uid,
        provider,
        ...(redirectUri ? { redirectUri } : {}),
        ...(scopes ? { scopes } : {}),
        oauthStateTtlSeconds,
        ...(publicBaseUrl ? { publicBaseUrl } : {}),
        ...(allowedRedirectUris !== undefined ? { allowedRedirectUris } : {}),
        adapter,
      });

      if (wantsRedirect) {
        return c.redirect(started.authorizeUrl, 302);
      }

      return c.json(
        {
          ok: true,
          workspaceId: ctx.workspace.id,
          provider: started.provider,
          authorizeUrl: started.authorizeUrl,
          state: started.state,
          expiresAt: started.expiresAt,
        },
        200,
      );
    } catch (error) {
      if (error instanceof IntegrationConnectionsError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          (error.status ?? 400) as 400 | 404 | 503,
        );
      }
      return c.json(
        { error: { code: "CONNECT_START_FAILED", message: "Failed to initiate OAuth flow" } },
        500,
      );
    }
  };

  const handleCallback = async (c: Ctx) => {
    const ctx = needWorkspaceAdmin(c);
    if ("failure" in ctx) return ctx.failure;

    const provider = c.req.param("provider") ?? "";
    let code = c.req.query("code") ?? "";
    let state = c.req.query("state") ?? "";
    // Story 1.15 (A10): a caller label is only a fallback for a provider that returns none; a caller external
    // account id (query or body) is ignored.
    let accountLabel = c.req.query("account_label") ?? c.req.query("accountLabel") ?? undefined;

    if (c.req.method === "POST" && (!code || !state)) {
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return c.json(
          { error: { code: "INVALID_JSON", message: "Invalid callback JSON body" } },
          400,
        );
      }
      const parsed = CallbackPayloadSchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json(
          {
            error: {
              code: "OAUTH_MISSING_PARAMS",
              message: "Callback requires code and state",
            },
          },
          400,
        );
      }
      code = parsed.data.code;
      state = parsed.data.state;
      accountLabel = parsed.data.accountLabel ?? accountLabel;
    }

    try {
      const connection = await completeWorkspaceOAuthCallback(c.env.DB, {
        workspaceId: ctx.workspace.id,
        userId: ctx.user.uid,
        provider,
        code,
        state,
        ...(accountLabel ? { accountLabel } : {}),
        connKey: c.env.PX_CONN_KEY,
        adapter,
      });

      return c.json(
        {
          ok: true,
          connection,
        },
        200,
      );
    } catch (error) {
      if (error instanceof IntegrationConnectionsError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          (error.status ?? 400) as 400 | 404 | 503,
        );
      }
      return c.json(
        { error: { code: "OAUTH_CALLBACK_FAILED", message: "Failed to complete OAuth callback" } },
        500,
      );
    }
  };

  router.get("/integrations", async (c) => {
    const ctx = needWorkspace(c);
    if ("failure" in ctx) return ctx.failure;

    try {
      const integrations = await listWorkspaceIntegrations(c.env.DB, {
        workspaceId: ctx.workspace.id,
        refreshWindowSeconds,
        adapter,
      });
      return c.json(
        {
          ok: true,
          workspaceId: ctx.workspace.id,
          integrations,
        },
        200,
      );
    } catch (error) {
      if (error instanceof IntegrationConnectionsError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          (error.status ?? 400) as 400 | 404 | 503,
        );
      }
      return c.json(
        { error: { code: "LIST_INTEGRATIONS_FAILED", message: "Failed to list workspace integrations" } },
        500,
      );
    }
  });

  router.get("/integrations/:provider/connect", handleStartConnect);
  router.get("/connect/:provider", handleStartConnect);

  router.get("/integrations/:provider/callback", handleCallback);
  router.post("/integrations/:provider/callback", handleCallback);

  router.post("/integrations/:provider/disconnect", async (c) => {
    const ctx = needWorkspaceAdmin(c);
    if ("failure" in ctx) return ctx.failure;

    const provider = c.req.param("provider") ?? "";
    try {
      const res = await disconnectWorkspaceIntegration(c.env.DB, {
        workspaceId: ctx.workspace.id,
        provider,
      });
      return c.json(res, 200);
    } catch {
      return c.json(
        { error: { code: "DISCONNECT_FAILED", message: "Failed to disconnect workspace integration" } },
        500,
      );
    }
  });

  return router;
}
