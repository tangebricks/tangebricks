import type { ConnectionLookupSelector, D1Like } from "@poc/sdk";
import { collectSecretStringsFromValue, insertStructuredLog } from "@poc/telemetry";

const OAUTH_REFRESH_BUFFER_MS = 60_000;
const REFRESH_LOCK_DURATION_MS = 15_000;

export const PX_CONNECTIONS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS px_connections (
  ref TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'default',
  env_name TEXT NOT NULL DEFAULT 'preview',
  workspace_id TEXT NOT NULL DEFAULT 'default',
  app TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'apiKey',
  label TEXT NOT NULL DEFAULT '',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  ciphertext_b64 TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  expires_at INTEGER,
  refresh_lock_until INTEGER,
  last_checked_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_px_connections_app ON px_connections(project_id, env_name, app);
CREATE INDEX IF NOT EXISTS idx_px_connections_ws ON px_connections(workspace_id, app);
`;

export type CaseAConnectionStatus = "connected" | "expired" | "revoked" | "error";

export type CaseAAuthType =
  | "oauth2"
  | "apiKey"
  | "api_key"
  | "api-key"
  | "basic"
  | "bearer"
  | "webhook_secret"
  | "webhook-secret"
  | "webhookSecret"
  | "hmac_webhook_only"
  | "none"
  | (string & {});

export interface SealedConnectionCredentials {
  app?: string;
  authType?: CaseAAuthType;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number | string | null;
  apiKey?: string;
  secret?: string;
  webhookSecret?: string;
  signingSecret?: string;
  token?: string;
  username?: string;
  password?: string;
  headerName?: string;
  prefix?: string;
  in?: "header" | "query";
  queryParam?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  workspaceId?: string;
  [key: string]: unknown;
}

export interface PxConnectionRow {
  ref: string;
  project_id: string;
  env_name: string;
  workspace_id: string;
  app: string;
  auth_type: string;
  label: string;
  scopes_json: string;
  ciphertext_b64: string;
  iv_b64: string;
  key_hint: string;
  status: CaseAConnectionStatus;
  expires_at: number | null;
  refresh_lock_until: number | null;
  last_checked_at: string | null;
  updated_at: string;
}

export interface UpsertSealedConnectionInput {
  ref: string;
  projectId?: string;
  envName?: string;
  workspaceId?: string;
  app: string;
  authType?: CaseAAuthType;
  label?: string;
  scopes?: string[];
  status?: CaseAConnectionStatus;
  expiresAt?: number | string | null;
  lastCheckedAt?: string | null;
  credentials: SealedConnectionCredentials;
}

export interface ConnectionMetadataRecord {
  ref: string;
  projectId: string;
  envName: string;
  workspaceId: string;
  app: string;
  authType: CaseAAuthType;
  label: string;
  scopes: string[];
  keyHint: string;
  status: CaseAConnectionStatus;
  expiresAt: number | null;
  lastCheckedAt: string | null;
  updatedAt: string;
}

export interface ResolveCaseAConnectionOptions {
  db?: D1Like;
  /** Studio only (story 1.4): the project stamp for the connection.expired log line. */
  telemetryWrite?: { projectId?: string | null };
  connKey?: string;
  projectId?: string;
  envName?: string;
  workspaceId?: string;
  defaultApp?: string;
  tokenUrlByApp?: Readonly<Record<string, string>>;
  oauthFetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  trackedSecrets?: Set<string>;
  runId?: string | null;
  workflowId?: string | null;
  revision?: number | null;
  nodeId?: string | null;
  onConnectionExpired?: (event: {
    type: "connection.expired";
    ref: string;
    app: string;
    workspaceId: string;
    reason: string;
    timestamp: string;
  }) => void | Promise<void>;
}

const activeRefreshPromises = new Map<string, Promise<Record<string, unknown>>>();

export function resetConnectionRefreshLocksForTest(): void {
  activeRefreshPromises.clear();
}

function parseExpiresAtMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum)) return asNum;
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function computeConnectionKeyHint(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length === 0) {
    return "••••";
  }
  const suffix = trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
  return `••••${suffix}`;
}

export async function deriveConnectionVaultKey(rawKeyMaterial?: string) {
  if (!rawKeyMaterial || rawKeyMaterial.trim().length === 0) {
    // No fallback key: connection credentials must never be sealed with a value written in source.
    throw new Error("Missing required secret PX_CONN_KEY");
  }
  const material = rawKeyMaterial.trim();
  const encoded = new TextEncoder().encode(`projectx-studio-vault-v1:${material}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealConnectionCredentials(
  credentials: SealedConnectionCredentials,
  rawKeyMaterial?: string,
): Promise<{
  ciphertextB64: string;
  ivB64: string;
  keyHint: string;
}> {
  const key = await deriveConnectionVaultKey(rawKeyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const serialized = JSON.stringify(credentials);
  const encoded = new TextEncoder().encode(serialized);
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  const primarySecret = String(
    credentials.accessToken ??
      credentials.apiKey ??
      credentials.secret ??
      credentials.webhookSecret ??
      credentials.signingSecret ??
      credentials.token ??
      credentials.password ??
      "",
  );
  return {
    ciphertextB64: toBase64(new Uint8Array(encryptedBuffer)),
    ivB64: toBase64(iv),
    keyHint: computeConnectionKeyHint(primarySecret),
  };
}

export async function unsealConnectionCredentials(
  ciphertextB64: string,
  ivB64: string,
  rawKeyMaterial?: string,
): Promise<SealedConnectionCredentials> {
  const key = await deriveConnectionVaultKey(rawKeyMaterial);
  const iv = fromBase64(ivB64);
  const ciphertext = fromBase64(ciphertextB64);
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  const text = new TextDecoder().decode(decryptedBuffer);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as SealedConnectionCredentials;
    }
    return { secret: String(parsed), apiKey: String(parsed), token: String(parsed) };
  } catch {
    // Support legacy single-string secret rows
    return { secret: text, apiKey: text, token: text, accessToken: text };
  }
}

export async function ensureConnectionsTable(db: D1Like): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS px_connections (
        ref TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT 'default',
        env_name TEXT NOT NULL DEFAULT 'preview',
        workspace_id TEXT NOT NULL DEFAULT 'default',
        app TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'apiKey',
        label TEXT NOT NULL DEFAULT '',
        scopes_json TEXT NOT NULL DEFAULT '[]',
        ciphertext_b64 TEXT NOT NULL,
        iv_b64 TEXT NOT NULL,
        key_hint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'connected',
        expires_at INTEGER,
        refresh_lock_until INTEGER,
        last_checked_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    )
    .run();
}

export const ensurePxConnectionsTable = ensureConnectionsTable;

export async function upsertSealedConnection(
  db: D1Like,
  input: UpsertSealedConnectionInput,
  connKey?: string,
): Promise<ConnectionMetadataRecord> {
  await ensureConnectionsTable(db);
  const nowIso = new Date().toISOString();
  const projectId = input.projectId ?? "default";
  const envName = input.envName ?? "preview";
  const workspaceId = input.workspaceId ?? input.credentials.workspaceId ?? "default";
  const authType: CaseAAuthType =
    input.authType ??
    input.credentials.authType ??
    (input.credentials.accessToken || input.credentials.refreshToken ? "oauth2" : "apiKey");
  const scopes = input.scopes ?? input.credentials.scopes ?? [];
  const expiresAt =
    input.expiresAt !== undefined
      ? parseExpiresAtMs(input.expiresAt)
      : parseExpiresAtMs(input.credentials.expiresAt);
  const status: CaseAConnectionStatus = input.status ?? "connected";
  const lastCheckedAt = input.lastCheckedAt !== undefined ? input.lastCheckedAt : nowIso;
  const label = input.label ?? input.ref;

  const payloadToSeal: SealedConnectionCredentials = {
    ...input.credentials,
    app: input.app,
    authType,
    ...(expiresAt !== null ? { expiresAt } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    workspaceId,
  };

  const sealed = await sealConnectionCredentials(payloadToSeal, connKey);

  await db
    .prepare(
      `INSERT INTO px_connections (
        ref, project_id, env_name, workspace_id, app, auth_type, label,
        scopes_json, ciphertext_b64, iv_b64, key_hint, status,
        expires_at, refresh_lock_until, last_checked_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(ref) DO UPDATE SET
        project_id = excluded.project_id,
        env_name = excluded.env_name,
        workspace_id = excluded.workspace_id,
        app = excluded.app,
        auth_type = excluded.auth_type,
        label = excluded.label,
        scopes_json = excluded.scopes_json,
        ciphertext_b64 = excluded.ciphertext_b64,
        iv_b64 = excluded.iv_b64,
        key_hint = excluded.key_hint,
        status = excluded.status,
        expires_at = excluded.expires_at,
        refresh_lock_until = NULL,
        last_checked_at = excluded.last_checked_at,
        updated_at = excluded.updated_at
      WHERE px_connections.project_id = excluded.project_id`,
    )
    .bind(
      input.ref,
      projectId,
      envName,
      workspaceId,
      input.app,
      authType,
      label,
      JSON.stringify(scopes),
      sealed.ciphertextB64,
      sealed.ivB64,
      sealed.keyHint,
      status,
      expiresAt,
      lastCheckedAt,
      nowIso,
    )
    .run();

  return {
    ref: input.ref,
    projectId,
    envName,
    workspaceId,
    app: input.app,
    authType,
    label,
    scopes,
    keyHint: sealed.keyHint,
    status,
    expiresAt,
    lastCheckedAt,
    updatedAt: nowIso,
  };
}

function buildLookupCandidates(
  nameOrSelector: string | ConnectionLookupSelector,
  options: ResolveCaseAConnectionOptions,
): { candidates: string[]; targetApp?: string; targetWorkspaceId: string } {
  // The run's workspace is required (story 1.1): there is no default to fall back to.
  const defaultWs = options.workspaceId?.trim() ?? "";
  if (!defaultWs) {
    throw new Error("NO_WORKSPACE: the run has no verified workspace, so no connection is resolved");
  }
  if (typeof nameOrSelector === "string") {
    const trimmed = nameOrSelector.trim();
    const candidates = [trimmed];
    if (trimmed.startsWith("project:")) {
      candidates.push(trimmed.slice("project:".length));
    }
    return {
      candidates,
      targetApp: options.defaultApp,
      targetWorkspaceId: defaultWs,
    };
  }

  const scope = nameOrSelector.scope ?? "project";
  const ref = nameOrSelector.ref?.trim();
  const app = nameOrSelector.app?.trim() ?? options.defaultApp;
  // The run's workspace only (AD-S19): a selector's own workspaceId is never used to pick another tenant's connection.
  const wsId = defaultWs;
  const candidates: string[] = [];

  if (scope === "workspace") {
    if (app) {
      candidates.push(`workspace:${wsId}:${app}`);
      candidates.push(`workspace:${app}`);
    }
    if (ref) {
      candidates.push(ref);
    }
    if (app) {
      candidates.push(app);
    }
  } else {
    if (ref) {
      candidates.push(ref);
      candidates.push(`project:${ref}`);
    }
    if (app) {
      candidates.push(app);
    }
  }

  return {
    candidates,
    targetApp: app,
    targetWorkspaceId: wsId,
  };
}

async function findPxConnectionRow(
  db: D1Like,
  candidates: string[],
  targetApp: string | undefined,
  targetWorkspaceId: string,
): Promise<PxConnectionRow | null> {
  await ensureConnectionsTable(db);
  for (const candidate of candidates) {
    const byRef = await db
      .prepare("SELECT * FROM px_connections WHERE ref = ? LIMIT 1")
      .bind(candidate)
      .first<PxConnectionRow>();
    if (byRef) return byRef;
  }

  const appToSearch =
    targetApp ?? (candidates.length > 0 ? candidates[candidates.length - 1] : undefined);
  if (appToSearch) {
    if (targetWorkspaceId && targetWorkspaceId !== "default" && targetWorkspaceId !== "ws_default") {
      const byWsApp = await db
        .prepare(
          "SELECT * FROM px_connections WHERE app = ? AND workspace_id = ? ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(appToSearch, targetWorkspaceId)
        .first<PxConnectionRow>();
      if (byWsApp) return byWsApp;
    }
    const byApp = await db
      .prepare("SELECT * FROM px_connections WHERE app = ? ORDER BY updated_at DESC LIMIT 1")
      .bind(appToSearch)
      .first<PxConnectionRow>();
    if (byApp) return byApp;
  }

  return null;
}

async function emitConnectionExpiredTelemetry(
  db: D1Like | undefined,
  row: PxConnectionRow,
  reason: string,
  options: ResolveCaseAConnectionOptions,
): Promise<void> {
  const nowIso = new Date().toISOString();
  if (options.onConnectionExpired) {
    await options.onConnectionExpired({
      type: "connection.expired",
      ref: row.ref,
      app: row.app,
      workspaceId: row.workspace_id,
      reason,
      timestamp: nowIso,
    });
  }
  if (!db) return;
  try {
    await insertStructuredLog(
      db,
      {
        level: "warn",
        message: `connection.expired: Connection "${row.ref}" (${row.app}) expired: ${reason}`,
        runId: options.runId ?? null,
        workflowId: options.workflowId ?? null,
        revision: options.revision ?? null,
        nodeId: options.nodeId ?? null,
        brickId: `int:${row.app}`,
        workspaceId: options.workspaceId || row.workspace_id,
        fields: {
          event: "connection.expired",
          ref: row.ref,
          app: row.app,
          status: "expired",
          reason,
          pxEnv: options.envName === "production" ? "production" : "preview",
        },
      },
      {
        secretValues: options.trackedSecrets,
      },
      options.telemetryWrite ?? {},
    );
  } catch {
    // Ignore if px_logs table is not initialized on standalone DB
  }
}

export async function sealWorkspaceCredentialsWithAad(
  credentials: SealedConnectionCredentials,
  workspaceId: string,
  rawKeyMaterial?: string,
): Promise<string> {
  const key = await deriveConnectionVaultKey(rawKeyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(workspaceId);
  const encoded = new TextEncoder().encode(JSON.stringify(credentials));
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    encoded,
  );
  return JSON.stringify({
    v: 1,
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(encryptedBuffer)),
  });
}

export async function unsealWorkspaceCredentialsWithAad(
  sealedEnvelope: string,
  workspaceId: string,
  rawKeyMaterial?: string,
): Promise<SealedConnectionCredentials> {
  let parsedEnvelope: { iv?: string; ct?: string };
  try {
    parsedEnvelope = JSON.parse(sealedEnvelope) as { iv?: string; ct?: string };
  } catch {
    throw new Error(
      `WORKSPACE_CREDENTIAL_INTEGRITY_ERROR: Malformed sealed_credentials envelope for workspace "${workspaceId}"`,
    );
  }
  if (typeof parsedEnvelope.iv !== "string" || typeof parsedEnvelope.ct !== "string") {
    throw new Error(
      `WORKSPACE_CREDENTIAL_INTEGRITY_ERROR: Missing IV or ciphertext in sealed_credentials for workspace "${workspaceId}"`,
    );
  }
  const key = await deriveConnectionVaultKey(rawKeyMaterial);
  const iv = fromBase64(parsedEnvelope.iv);
  const ciphertext = fromBase64(parsedEnvelope.ct);
  const aad = new TextEncoder().encode(workspaceId);

  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      ciphertext,
    );
  } catch {
    throw new Error(
      `WORKSPACE_CREDENTIAL_INTEGRITY_ERROR: AES-GCM authentication failed for workspace "${workspaceId}" (AAD mismatch or tampered ciphertext)`,
    );
  }

  const text = new TextDecoder().decode(decryptedBuffer);
  return JSON.parse(text) as SealedConnectionCredentials;
}

interface IntConnectionD1Row {
  id: string;
  workspace_id: string;
  provider: string;
  external_account_id: string | null;
  account_label: string | null;
  sealed_credentials: string;
  scopes: string;
  status: CaseAConnectionStatus;
  expires_at: number | null;
  refresh_lock_until: number | null;
  created_at: string;
  updated_at: string;
}

export async function resolveCaseBWorkspaceConnection(
  providerRaw: string,
  options: ResolveCaseAConnectionOptions,
): Promise<Record<string, unknown>> {
  const db = options.db;
  const provider = providerRaw.trim().toLowerCase();
  // Immutable RunContext.workspaceId: never trust caller-supplied selector/node/payload workspaceId
  const workspaceId = (options.workspaceId ?? "").trim();
  if (!workspaceId) {
    throw new Error(
      `NO_WORKSPACE: the run has no verified workspace, so no workspace connection for provider "${provider}" is resolved`,
    );
  }

  if (!db) {
    throw new Error(
      `WORKSPACE_CONNECTION_NOT_FOUND: No D1 binding available to resolve workspace connection for provider "${provider}" in workspace "${workspaceId}"`,
    );
  }

  let row: IntConnectionD1Row | null = null;
  try {
    row = await db
      .prepare(
        `SELECT id, workspace_id, provider, external_account_id, account_label,
                sealed_credentials, scopes, status, expires_at, refresh_lock_until, created_at, updated_at
         FROM int_connections
         WHERE workspace_id = ? AND provider = ?
         LIMIT 1`,
      )
      .bind(workspaceId, provider)
      .first<IntConnectionD1Row>();
  } catch {
    row = null;
  }

  if (!row) {
    throw new Error(
      `WORKSPACE_CONNECTION_NOT_FOUND: No workspace connection found for provider "${provider}" in workspace "${workspaceId}"`,
    );
  }

  if (row.status === "revoked") {
    throw new Error(
      `CONNECTION_EXPIRED: Workspace connection for provider "${provider}" in workspace "${workspaceId}" has been revoked`,
    );
  }

  // Unseal verifying AES-GCM AAD === workspaceId
  const decrypted = await unsealWorkspaceCredentialsWithAad(
    row.sealed_credentials,
    workspaceId,
    options.connKey,
  );

  if (options.trackedSecrets) {
    collectSecretStringsFromValue(decrypted, options.trackedSecrets);
  }

  const nowMs = options.now ? options.now() : Date.now();
  const expiresAt =
    parseExpiresAtMs(row.expires_at) ?? parseExpiresAtMs(decrypted.expiresAt);
  const refreshToken =
    typeof decrypted.refreshToken === "string" && decrypted.refreshToken.trim().length > 0
      ? decrypted.refreshToken.trim()
      : undefined;

  const isExpiringOrExpired =
    row.status === "expired" ||
    (expiresAt !== null && expiresAt <= nowMs + OAUTH_REFRESH_BUFFER_MS);

  if (isExpiringOrExpired) {
    if (!refreshToken) {
      await db
        .prepare(
          "UPDATE int_connections SET status = 'expired', updated_at = ? WHERE workspace_id = ? AND provider = ?",
        )
        .bind(new Date(nowMs).toISOString(), workspaceId, provider)
        .run();
      throw new Error(
        `CONNECTION_EXPIRED: Workspace connection for provider "${provider}" in workspace "${workspaceId}" is expired and has no refresh token`,
      );
    }

    const lockKey = `ws:${workspaceId}:${provider}`;
    const existingPromise = activeRefreshPromises.get(lockKey);
    if (existingPromise) {
      return existingPromise;
    }

    const refreshTask = (async (): Promise<Record<string, unknown>> => {
      try {
        const lockUntil = nowMs + REFRESH_LOCK_DURATION_MS;
        await db
          .prepare(
            "UPDATE int_connections SET refresh_lock_until = ? WHERE workspace_id = ? AND provider = ? AND (refresh_lock_until IS NULL OR refresh_lock_until < ?)",
          )
          .bind(lockUntil, workspaceId, provider, nowMs)
          .run();

        const tokenUrl =
          (typeof decrypted.tokenUrl === "string" && decrypted.tokenUrl.trim()) ||
          options.tokenUrlByApp?.[provider] ||
          `https://oauth.${provider}.com/oauth/token`;

        const form = new URLSearchParams();
        form.set("grant_type", "refresh_token");
        form.set("refresh_token", refreshToken);
        if (typeof decrypted.clientId === "string" && decrypted.clientId.trim()) {
          form.set("client_id", decrypted.clientId.trim());
        }
        if (typeof decrypted.clientSecret === "string" && decrypted.clientSecret.trim()) {
          form.set("client_secret", decrypted.clientSecret.trim());
        }

        const fetcher = options.oauthFetcher ?? globalThis.fetch;
        const response = await fetcher(tokenUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: form.toString(),
        });

        const rawText = await response.text();
        let parsedTokenBody: Record<string, unknown> = {};
        try {
          const json = JSON.parse(rawText);
          if (typeof json === "object" && json !== null && !Array.isArray(json)) {
            parsedTokenBody = json as Record<string, unknown>;
          }
        } catch {
          parsedTokenBody = {};
        }

        if (response.status === 400 || response.status === 401 || !response.ok) {
          const errCode =
            typeof parsedTokenBody.error === "string"
              ? parsedTokenBody.error
              : `http_${response.status}`;
          await db
            .prepare(
              "UPDATE int_connections SET status = 'expired', refresh_lock_until = NULL, updated_at = ? WHERE workspace_id = ? AND provider = ?",
            )
            .bind(new Date(nowMs).toISOString(), workspaceId, provider)
            .run();
          throw new Error(
            `CONNECTION_EXPIRED: OAuth2 token refresh failed (${errCode}) for workspace "${workspaceId}" provider "${provider}"`,
          );
        }

        const newAccessToken = String(
          parsedTokenBody.access_token ??
            parsedTokenBody.accessToken ??
            decrypted.accessToken ??
            "",
        );
        const newRefreshToken = String(
          parsedTokenBody.refresh_token ??
            parsedTokenBody.refreshToken ??
            refreshToken,
        );
        const expiresInSec =
          typeof parsedTokenBody.expires_in === "number" &&
          Number.isFinite(parsedTokenBody.expires_in)
            ? parsedTokenBody.expires_in
            : 3600;
        const newExpiresAt =
          typeof parsedTokenBody.expires_at === "number"
            ? parsedTokenBody.expires_at
            : nowMs + expiresInSec * 1000;

        const updatedCredentials: SealedConnectionCredentials = {
          ...decrypted,
          app: provider,
          provider,
          authType: "oauth2",
          accessToken: newAccessToken,
          token: newAccessToken,
          refreshToken: newRefreshToken,
          expiresAt: newExpiresAt,
          workspaceId,
        };

        if (options.trackedSecrets) {
          collectSecretStringsFromValue(updatedCredentials, options.trackedSecrets);
        }

        const resealedEnvelope = await sealWorkspaceCredentialsWithAad(
          updatedCredentials,
          workspaceId,
          options.connKey,
        );

        await db
          .prepare(
            `UPDATE int_connections
             SET sealed_credentials = ?,
                 status = 'connected',
                 expires_at = ?,
                 refresh_lock_until = NULL,
                 updated_at = ?
             WHERE workspace_id = ? AND provider = ?`,
          )
          .bind(
            resealedEnvelope,
            newExpiresAt,
            new Date(nowMs).toISOString(),
            workspaceId,
            provider,
          )
          .run();

        return {
          ...updatedCredentials,
          app: provider,
          provider,
          workspaceId,
          status: "connected",
        };
      } finally {
        activeRefreshPromises.delete(lockKey);
      }
    })();

    activeRefreshPromises.set(lockKey, refreshTask);
    return refreshTask;
  }

  return {
    ...decrypted,
    app: provider,
    provider,
    workspaceId,
    status: row.status,
    ...(expiresAt !== null ? { expiresAt } : {}),
  };
}

export async function resolveCaseAConnection(
  nameOrSelector: string | ConnectionLookupSelector,
  options: ResolveCaseAConnectionOptions,
): Promise<Record<string, unknown>> {
  if (typeof nameOrSelector === "object" && nameOrSelector.scope === "workspace") {
    const provider = nameOrSelector.app ?? options.defaultApp ?? "";
    return resolveCaseBWorkspaceConnection(provider, options);
  }
  const db = options.db;
  if (!db) {
    const label =
      typeof nameOrSelector === "string"
        ? nameOrSelector
        : (nameOrSelector.ref ?? nameOrSelector.app ?? "unknown");
    throw new Error(`connection "${label}" was not provided`);
  }

  const { candidates, targetApp, targetWorkspaceId } = buildLookupCandidates(
    nameOrSelector,
    options,
  );
  const row = await findPxConnectionRow(db, candidates, targetApp, targetWorkspaceId);
  if (!row) {
    const label = candidates[0] ?? targetApp ?? "unknown";
    throw new Error(`connection "${label}" was not found in px_connections`);
  }

  if (row.status === "revoked") {
    throw new Error(
      `CONNECTION_EXPIRED: Connection "${row.ref}" for app "${row.app}" has been revoked`,
    );
  }

  const decrypted = await unsealConnectionCredentials(
    row.ciphertext_b64,
    row.iv_b64,
    options.connKey,
  );

  if (options.trackedSecrets) {
    collectSecretStringsFromValue(decrypted, options.trackedSecrets);
  }

  const nowMs = options.now ? options.now() : Date.now();
  const expiresAt =
    parseExpiresAtMs(row.expires_at) ?? parseExpiresAtMs(decrypted.expiresAt);
  const refreshToken =
    typeof decrypted.refreshToken === "string" && decrypted.refreshToken.trim().length > 0
      ? decrypted.refreshToken.trim()
      : undefined;

  const isExpiringOrExpired =
    row.status === "expired" ||
    (expiresAt !== null && expiresAt <= nowMs + OAUTH_REFRESH_BUFFER_MS);

  if (isExpiringOrExpired) {
    if (!refreshToken) {
      await db
        .prepare("UPDATE px_connections SET status = 'expired', updated_at = ? WHERE ref = ?")
        .bind(new Date(nowMs).toISOString(), row.ref)
        .run();
      await emitConnectionExpiredTelemetry(
        db,
        row,
        "OAuth2 token expired and no refresh_token is available",
        options,
      );
      throw new Error(
        `CONNECTION_EXPIRED: Connection "${row.ref}" for app "${row.app}" is expired and has no refresh token`,
      );
    }

    const existingPromise = activeRefreshPromises.get(row.ref);
    if (existingPromise) {
      return existingPromise;
    }

    const refreshTask = (async (): Promise<Record<string, unknown>> => {
      try {
        const lockUntil = nowMs + REFRESH_LOCK_DURATION_MS;
        await db
          .prepare(
            "UPDATE px_connections SET refresh_lock_until = ? WHERE ref = ? AND (refresh_lock_until IS NULL OR refresh_lock_until < ?)",
          )
          .bind(lockUntil, row.ref, nowMs)
          .run();

        const tokenUrl =
          (typeof decrypted.tokenUrl === "string" && decrypted.tokenUrl.trim()) ||
          options.tokenUrlByApp?.[row.app] ||
          `https://oauth.${row.app}.com/oauth/token`;

        const form = new URLSearchParams();
        form.set("grant_type", "refresh_token");
        form.set("refresh_token", refreshToken);
        if (typeof decrypted.clientId === "string" && decrypted.clientId.trim()) {
          form.set("client_id", decrypted.clientId.trim());
        }
        if (typeof decrypted.clientSecret === "string" && decrypted.clientSecret.trim()) {
          form.set("client_secret", decrypted.clientSecret.trim());
        }

        const fetcher = options.oauthFetcher ?? globalThis.fetch;
        const response = await fetcher(tokenUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: form.toString(),
        });

        const rawText = await response.text();
        let parsedTokenBody: Record<string, unknown> = {};
        try {
          const json = JSON.parse(rawText);
          if (typeof json === "object" && json !== null && !Array.isArray(json)) {
            parsedTokenBody = json as Record<string, unknown>;
          }
        } catch {
          parsedTokenBody = {};
        }

        if (response.status === 400 || response.status === 401 || !response.ok) {
          const errCode =
            typeof parsedTokenBody.error === "string"
              ? parsedTokenBody.error
              : `http_${response.status}`;
          await db
            .prepare(
              "UPDATE px_connections SET status = 'expired', refresh_lock_until = NULL, updated_at = ? WHERE ref = ?",
            )
            .bind(new Date(nowMs).toISOString(), row.ref)
            .run();
          await emitConnectionExpiredTelemetry(
            db,
            row,
            `Token refresh failed with ${errCode} (HTTP ${response.status})`,
            options,
          );
          throw new Error(
            `CONNECTION_EXPIRED: OAuth2 token refresh failed (${errCode}) for connection "${row.ref}"`,
          );
        }

        const newAccessToken = String(
          parsedTokenBody.access_token ??
            parsedTokenBody.accessToken ??
            decrypted.accessToken ??
            "",
        );
        const newRefreshToken = String(
          parsedTokenBody.refresh_token ??
            parsedTokenBody.refreshToken ??
            refreshToken,
        );
        const expiresInSec =
          typeof parsedTokenBody.expires_in === "number" &&
          Number.isFinite(parsedTokenBody.expires_in)
            ? parsedTokenBody.expires_in
            : 3600;
        const newExpiresAt =
          typeof parsedTokenBody.expires_at === "number"
            ? parsedTokenBody.expires_at
            : nowMs + expiresInSec * 1000;

        const updatedCredentials: SealedConnectionCredentials = {
          ...decrypted,
          app: row.app,
          authType: "oauth2",
          accessToken: newAccessToken,
          token: newAccessToken,
          refreshToken: newRefreshToken,
          expiresAt: newExpiresAt,
        };

        if (options.trackedSecrets) {
          collectSecretStringsFromValue(updatedCredentials, options.trackedSecrets);
        }

        await upsertSealedConnection(
          db,
          {
            ref: row.ref,
            projectId: row.project_id,
            envName: row.env_name,
            workspaceId: row.workspace_id,
            app: row.app,
            authType: "oauth2",
            label: row.label,
            scopes: (() => {
              try {
                return JSON.parse(row.scopes_json) as string[];
              } catch {
                return [];
              }
            })(),
            status: "connected",
            expiresAt: newExpiresAt,
            lastCheckedAt: new Date(nowMs).toISOString(),
            credentials: updatedCredentials,
          },
          options.connKey,
        );

        return {
          ...updatedCredentials,
          ref: row.ref,
          app: row.app,
          status: "connected",
        };
      } finally {
        activeRefreshPromises.delete(row.ref);
      }
    })();

    activeRefreshPromises.set(row.ref, refreshTask);
    return refreshTask;
  }

  return {
    ...decrypted,
    ref: row.ref,
    app: row.app,
    status: row.status,
    ...(expiresAt !== null ? { expiresAt } : {}),
  };
}
