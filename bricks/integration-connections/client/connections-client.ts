import { z } from "zod";

const WorkspaceIntegrationItemSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  provider: z.string(),
  displayName: z.string(),
  status: z.enum(["connected", "expired", "revoked", "error"]),
  accountLabel: z.string().nullable(),
  externalAccountId: z.string().nullable(),
  scopes: z.array(z.string()),
  expiresAt: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const ListIntegrationsResponseSchema = z.object({
  ok: z.boolean(),
  workspaceId: z.string(),
  integrations: z.array(WorkspaceIntegrationItemSchema),
});

const StartConnectResponseSchema = z.object({
  ok: z.boolean(),
  workspaceId: z.string(),
  provider: z.string(),
  authorizeUrl: z.string(),
  state: z.string(),
  expiresAt: z.number(),
});

const DisconnectResponseSchema = z.object({
  ok: z.boolean(),
  workspaceId: z.string(),
  provider: z.string(),
  disconnected: z.boolean(),
});

export type WorkspaceIntegrationRecord = z.infer<typeof WorkspaceIntegrationItemSchema>;

export class IntegrationConnectionsClientError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "IntegrationConnectionsClientError";
    this.status = status;
  }
}

export interface IntegrationConnectionsClientOptions {
  baseUrl: string;
  workspaceId: string;
  headers?: Record<string, string>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface IntegrationConnectionsClient {
  listIntegrations(): Promise<WorkspaceIntegrationRecord[]>;
  startConnect(provider: string, redirectUri?: string): Promise<{
    authorizeUrl: string;
    state: string;
    provider: string;
    expiresAt: number;
  }>;
  disconnect(provider: string): Promise<{
    ok: boolean;
    workspaceId: string;
    provider: string;
    disconnected: boolean;
  }>;
}

export function createIntegrationConnectionsClient(
  options: IntegrationConnectionsClientOptions,
): IntegrationConnectionsClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        ...init,
        headers: {
          ...options.headers,
          "x-workspace-id": options.workspaceId,
          accept: "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new IntegrationConnectionsClientError("Could not reach the server", 0);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new IntegrationConnectionsClientError(
        "The server's answer was not understood",
        response.status,
      );
    }

    if (!response.ok) {
      const errObj =
        typeof body === "object" && body !== null
          ? (body as { error?: string | { message?: string } }).error
          : undefined;
      const message =
        typeof errObj === "string"
          ? errObj
          : typeof errObj === "object" && errObj !== null && typeof errObj.message === "string"
            ? errObj.message
            : `Request failed (${response.status})`;
      throw new IntegrationConnectionsClientError(message, response.status);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new IntegrationConnectionsClientError(
        "The server's answer was not understood",
        response.status,
      );
    }
    return parsed.data;
  }

  return {
    listIntegrations: async () => {
      const res = await request("/integrations", { method: "GET" }, ListIntegrationsResponseSchema);
      return res.integrations;
    },
    startConnect: async (provider: string, redirectUri?: string) => {
      const qs = redirectUri ? `?redirect_uri=${encodeURIComponent(redirectUri)}` : "";
      return request(
        `/integrations/${encodeURIComponent(provider)}/connect${qs}`,
        { method: "GET" },
        StartConnectResponseSchema,
      );
    },
    disconnect: async (provider: string) =>
      request(
        `/integrations/${encodeURIComponent(provider)}/disconnect`,
        { method: "POST" },
        DisconnectResponseSchema,
      ),
  };
}
