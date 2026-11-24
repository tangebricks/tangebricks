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
  adapter?: IntegrationConnectionsAdapter;
}

const CallbackPayloadSchema = z.object({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(512),
  accountLabel: z.string().min(1).max(320).optional(),
  externalAccountId: z.string().min(1).max(320).optional(),
});

type Ctx = Context<IntegrationConnectionsEnv>;

export function createIntegrationConnectionsRoutes(
  options: IntegrationConnectionsRouteOptions = {},
): Hono<IntegrationConnectionsEnv> {
  const oauthStateTtlSeconds = options.oauthStateTtlSeconds ?? 600;
  const refreshWindowSeconds = options.refreshWindowSeconds ?? 60;
  const publicBaseUrl = options.publicBaseUrl;
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

    try {
      const started = await startWorkspaceOAuthConnect(c.env.DB, {
        workspaceId: ctx.workspace.id,
        userId: ctx.user.uid,
        provider,
        ...(redirectUri ? { redirectUri } : {}),
        ...(scopes ? { scopes } : {}),
        oauthStateTtlSeconds,
        ...(publicBaseUrl ? { publicBaseUrl } : {}),
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
    let accountLabel = c.req.query("account_label") ?? c.req.query("accountLabel") ?? undefined;
    let externalAccountId =
      c.req.query("external_account_id") ?? c.req.query("externalAccountId") ?? undefined;

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
      externalAccountId = parsed.data.externalAccountId ?? externalAccountId;
    }

    try {
      const connection = await completeWorkspaceOAuthCallback(c.env.DB, {
        workspaceId: ctx.workspace.id,
        provider,
        code,
        state,
        ...(accountLabel ? { accountLabel } : {}),
        ...(externalAccountId ? { externalAccountId } : {}),
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
