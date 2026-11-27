import type { D1Like } from "@poc/sdk";
import { ensureStudioD1Schema } from "../blueprint-do.ts";
import type { StudioApiEnv } from "../blueprint-do.ts";

export interface TokenResolutionContext {
  actor: string;
  deployId: string;
  action: string;
}

export type TokenResolver = (tokenRef: string, context: TokenResolutionContext) => Promise<string>;

export const CLOUDFLARE_API_TOKENS_DASHBOARD_URL = "https://dash.cloudflare.com/profile/api-tokens";

function missingKek(): never {
  // No fallback KEK: deploy tokens must never be wrapped with a value written in source.
  throw new Error("Missing required secret PX_TOKEN_KEK");
}

export type DeployTokenStatus = "active" | "revoked" | "expired";

export type OnboardingFunnelStep =
  "wizard_opened" | "template_link_clicked" | "token_submitted" | "verification_failed" | "verification_succeeded" | "token_disconnected";

export const STUDIO_ONBOARDING_STEPS = [
  "signup_completed",
  "project_created",
  "first_blueprint_edit",
  "first_test_step_run",
  "connect_cf_wizard_opened",
  "connect_cf_token_link_clicked",
  "connect_cf_token_submitted",
  "connect_cf_permission_check_failed",
  "connect_cf_verified",
  "first_preview_deploy_started",
  "first_preview_deploy_succeeded",
  "first_production_deploy_succeeded",
] as const;

export type StudioOnboardingStep = (typeof STUDIO_ONBOARDING_STEPS)[number];

export interface StudioOnboardingEvent {
  eventId: string;
  orgId: string;
  projectId: string | null;
  actorId: string;
  step: StudioOnboardingStep;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OnboardingFunnelAnalytics {
  orgId: string | null;
  stepCounts: Record<StudioOnboardingStep, number>;
  uniqueActorsByStep: Record<StudioOnboardingStep, number>;
  ttfd: {
    sampleSize: number;
    medianTtfdMinutes: number | null;
    p90TtfdMinutes: number | null;
    ttfdTargetMinutes: 30;
    ttfdPassed: boolean;
    actorTtfdMinutes: Array<{
      actorId: string;
      orgId: string;
      signupAt: string;
      firstPreviewDeployAt: string;
      minutes: number;
    }>;
  };
  connectCloudflare: {
    wizardOpenedCount: number;
    tokenLinkClickedCount: number;
    tokenSubmittedCount: number;
    permissionCheckFailedCount: number;
    verifiedCount: number;
    dropOffRate: number;
    dropOffThreshold: 0.25;
    cp9TriggerFired: boolean;
  };
  medianTtfdMinutes: number | null;
  p90TtfdMinutes: number | null;
  ttfdTargetMinutes: 30;
  ttfdPassed: boolean;
  wizardOpenedCount: number;
  verifiedCount: number;
  dropOffRate: number;
  cp9TriggerFired: boolean;
}

export type OnboardingFunnelAnalyticsReport = OnboardingFunnelAnalytics;

export interface OnboardingFunnelEvent {
  eventId: string;
  orgId: string;
  projectId: string | null;
  actorId: string;
  step: OnboardingFunnelStep;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ProjectEnvironmentTargetRecord {
  projectId: string;
  orgId: string;
  envName: "preview" | "production";
  target: {
    type: "byoc";
    accountId: string;
    tokenRef: string;
    envName: "preview" | "production";
  };
  accountName: string;
  deployedRev: number | null;
  buildHash: string | null;
  codeHash: string | null;
  graphHash: string | null;
  deployedState?: Record<string, unknown> | null;
  status: string;
  updatedAt: string;
}

export type DeployTokenVaultErrorCode = "TOKEN_NOT_FOUND" | "TOKEN_REVOKED" | "TOKEN_TAMPERED" | "KEK_VERSION_NOT_FOUND" | "INVALID_TOKEN_INPUT";

export class DeployTokenVaultError extends Error {
  readonly code: DeployTokenVaultErrorCode;
  readonly tokenRef?: string;

  constructor(code: DeployTokenVaultErrorCode, message: string, tokenRef?: string) {
    super(message);
    this.name = "DeployTokenVaultError";
    this.code = code;
    this.tokenRef = tokenRef;
  }
}

export interface DeployTokenMetadata {
  tokenRef: string;
  orgId: string;
  accountId: string;
  accountName: string;
  tokenLast4: string;
  scopes: string[];
  status: DeployTokenStatus;
  kekVersion: number;
  createdBy: string;
  createdAt: string;
  lastVerifiedAt: string | null;
  revokedAt: string | null;
}

export interface DeployTokenAuditEntry {
  auditId: string;
  tokenRef: string;
  orgId: string;
  actor: string;
  deployId: string;
  action: string;
  createdAt: string;
}

export interface SealDeployTokenInput {
  orgId: string;
  accountId: string;
  accountName?: string;
  plaintextToken: string;
  scopes?: string[];
  createdBy: string;
  lastVerifiedAt?: string | null;
}

export interface RevokeDeployTokenOptions {
  orgId?: string;
  actor: string;
  deployId?: string;
}

export interface RevokeDeployTokenResult {
  tokenRef: string;
  orgId: string;
  status: "revoked";
  revokedAt: string;
  cloudflareDashboardUrl: string;
}

export interface TokenKekConfig {
  currentKek?: string;
  currentKekVersion?: number;
  keyring?: Record<number, string>;
}

export interface RotateKekResult {
  fromKekVersion: number;
  toKekVersion: number;
  rotatedCount: number;
  rotatedTokenRefs: string[];
}

interface DeployTokenRow {
  token_ref: string;
  org_id: string;
  account_id: string;
  account_name: string;
  token_last4: string;
  scopes: string;
  status: DeployTokenStatus;
  ciphertext: string | null;
  iv: string | null;
  wrapped_dek: string | null;
  dek_iv: string | null;
  kek_version: number;
  created_by: string;
  created_at: string;
  last_verified_at: string | null;
  revoked_at: string | null;
}

interface DeployTokenAuditRow {
  audit_id: string;
  token_ref: string;
  org_id: string;
  actor: string;
  deploy_id: string;
  action: string;
  created_at: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new DeployTokenVaultError("TOKEN_TAMPERED", "Invalid base64 encoding in encrypted token record");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function generateUuidV7(nowMs: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const timestamp = BigInt(Math.max(0, Math.floor(nowMs)));
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);

  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function generateTokenRef(nowMs?: number): string {
  return `tok_${generateUuidV7(nowMs)}`;
}

export function computeTokenLast4(plaintextToken: string): string {
  const trimmed = plaintextToken.trim();
  return trimmed.length >= 4 ? trimmed.slice(-4) : trimmed.padStart(4, "0");
}

async function deriveKekCryptoKey(rawKekSecret: string) {
  const normalized = rawKekSecret.trim();
  const keyMaterial = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", keyMaterial);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function importRawDekCryptoKey(rawDekBytes: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.importKey("raw", rawDekBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function resolveKekConfig(envOrConfig?: StudioApiEnv | TokenKekConfig): Required<TokenKekConfig> {
  if (!envOrConfig) {
    return missingKek();
  }

  if ("STUDIO_DB" in envOrConfig || "BLUEPRINT_DO" in envOrConfig) {
    const env = envOrConfig as StudioApiEnv;
    const versionRaw = env.PX_TOKEN_KEK_VERSION ? Number.parseInt(env.PX_TOKEN_KEK_VERSION, 10) : 1;
    const currentKekVersion = Number.isFinite(versionRaw) && versionRaw >= 1 ? versionRaw : 1;
    const currentKek = env.PX_TOKEN_KEK && env.PX_TOKEN_KEK.trim().length > 0 ? env.PX_TOKEN_KEK.trim() : missingKek();
    const keyring: Record<number, string> = {
      ...env.PX_TOKEN_KEK_MAP,
      [currentKekVersion]: currentKek,
    };
    return {
      currentKek,
      currentKekVersion,
      keyring,
    };
  }

  const cfg = envOrConfig as TokenKekConfig;
  const currentKekVersion = cfg.currentKekVersion && cfg.currentKekVersion >= 1 ? cfg.currentKekVersion : 1;
  const currentKek = cfg.currentKek && cfg.currentKek.trim().length > 0 ? cfg.currentKek.trim() : (cfg.keyring?.[currentKekVersion] ?? missingKek());
  const keyring: Record<number, string> = {
    ...cfg.keyring,
    [currentKekVersion]: currentKek,
  };
  return {
    currentKek,
    currentKekVersion,
    keyring,
  };
}

function resolveKekForVersion(kekVersion: number, envOrConfig?: StudioApiEnv | TokenKekConfig, tokenRef?: string): string {
  const resolved = resolveKekConfig(envOrConfig);
  const secret = resolved.keyring[kekVersion];
  if (!secret || secret.trim().length === 0) {
    throw new DeployTokenVaultError("KEK_VERSION_NOT_FOUND", `No Key Encryption Key configured for kekVersion ${kekVersion}`, tokenRef);
  }
  return secret;
}

function parseScopesColumn(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((s) => String(s).trim()).filter(Boolean);
    }
  } catch {
    // fallback to comma split
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function rowToMetadata(row: DeployTokenRow): DeployTokenMetadata {
  return {
    tokenRef: row.token_ref,
    orgId: row.org_id,
    accountId: row.account_id,
    accountName: row.account_name,
    tokenLast4: row.token_last4,
    scopes: parseScopesColumn(row.scopes),
    status: row.status,
    kekVersion: Number(row.kek_version),
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastVerifiedAt: row.last_verified_at ?? null,
    revokedAt: row.revoked_at ?? null,
  };
}

async function recordTokenAuditEntry(
  db: D1Like,
  entry: {
    tokenRef: string;
    orgId: string;
    actor: string;
    deployId: string;
    action: string;
    createdAt?: string;
  },
): Promise<DeployTokenAuditEntry> {
  const auditId = `aud_${generateUuidV7()}`;
  const createdAt = entry.createdAt ?? new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO deploy_token_audit_log (
        audit_id, token_ref, org_id, actor, deploy_id, action, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(auditId, entry.tokenRef, entry.orgId, entry.actor, entry.deployId, entry.action, createdAt)
    .run();

  return {
    auditId,
    tokenRef: entry.tokenRef,
    orgId: entry.orgId,
    actor: entry.actor,
    deployId: entry.deployId,
    action: entry.action,
    createdAt,
  };
}

export async function sealDeployToken(db: D1Like, input: SealDeployTokenInput, envOrKek?: StudioApiEnv | TokenKekConfig): Promise<DeployTokenMetadata> {
  await ensureStudioD1Schema(db);

  const plaintext = input.plaintextToken.trim();
  if (!plaintext) {
    throw new DeployTokenVaultError("INVALID_TOKEN_INPUT", "Cloudflare API token value must not be empty");
  }
  const accountId = input.accountId.trim();
  if (!accountId) {
    throw new DeployTokenVaultError("INVALID_TOKEN_INPUT", "Cloudflare accountId must not be empty");
  }

  const { currentKek, currentKekVersion } = resolveKekConfig(envOrKek);

  // 1. Generate a fresh random 256-bit DEK and 96-bit IV for the token ciphertext
  const rawDek = crypto.getRandomValues(new Uint8Array(32));
  const tokenIv = crypto.getRandomValues(new Uint8Array(12));
  const dekKey = await importRawDekCryptoKey(rawDek);
  const encodedPlaintext = new TextEncoder().encode(plaintext);
  const ciphertextBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv: tokenIv }, dekKey, encodedPlaintext);

  // 2. Wrap the 256-bit DEK using the master KEK with its own fresh 96-bit IV
  const kekKey = await deriveKekCryptoKey(currentKek);
  const dekIv = crypto.getRandomValues(new Uint8Array(12));
  const wrappedDekBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv: dekIv }, kekKey, rawDek);

  // Zero out raw DEK bytes in memory after wrapping
  rawDek.fill(0);

  const tokenRef = generateTokenRef();
  const nowIso = new Date().toISOString();
  const accountName = input.accountName?.trim() || `Account ${accountId.slice(0, 6)}`;
  const tokenLast4 = computeTokenLast4(plaintext);
  const scopes = input.scopes ?? ["workers_scripts:write", "d1:write", "queues:write", "account:read"];
  const lastVerifiedAt = input.lastVerifiedAt !== undefined ? input.lastVerifiedAt : nowIso;

  await db
    .prepare(
      `INSERT INTO deploy_tokens (
        token_ref, org_id, account_id, account_name, token_last4, scopes, status,
        ciphertext, iv, wrapped_dek, dek_iv, kek_version,
        created_by, created_at, last_verified_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      tokenRef,
      input.orgId,
      accountId,
      accountName,
      tokenLast4,
      JSON.stringify(scopes),
      bytesToBase64(new Uint8Array(ciphertextBuffer)),
      bytesToBase64(tokenIv),
      bytesToBase64(new Uint8Array(wrappedDekBuffer)),
      bytesToBase64(dekIv),
      currentKekVersion,
      input.createdBy,
      nowIso,
      lastVerifiedAt,
    )
    .run();

  return {
    tokenRef,
    orgId: input.orgId,
    accountId,
    accountName,
    tokenLast4,
    scopes,
    status: "active",
    kekVersion: currentKekVersion,
    createdBy: input.createdBy,
    createdAt: nowIso,
    lastVerifiedAt,
    revokedAt: null,
  };
}

export async function decryptToken(db: D1Like, tokenRef: string, context: TokenResolutionContext, envOrKek?: StudioApiEnv | TokenKekConfig): Promise<string> {
  await ensureStudioD1Schema(db);

  const row = await db
    .prepare(
      `SELECT
        token_ref, org_id, account_id, account_name, token_last4, scopes, status,
        ciphertext, iv, wrapped_dek, dek_iv, kek_version,
        created_by, created_at, last_verified_at, revoked_at
      FROM deploy_tokens
      WHERE token_ref = ?
      LIMIT 1`,
    )
    .bind(tokenRef)
    .first<DeployTokenRow>();

  if (!row) {
    throw new DeployTokenVaultError("TOKEN_NOT_FOUND", `Deploy token "${tokenRef}" was not found`, tokenRef);
  }

  if (row.status !== "active" || row.ciphertext === null || row.iv === null || row.wrapped_dek === null || row.dek_iv === null) {
    throw new DeployTokenVaultError("TOKEN_REVOKED", `TOKEN_REVOKED: Deploy token "${tokenRef}" has been revoked and cannot be used`, tokenRef);
  }

  const kekSecret = resolveKekForVersion(Number(row.kek_version), envOrKek, tokenRef);
  const kekKey = await deriveKekCryptoKey(kekSecret);

  let rawDekBytes: Uint8Array<ArrayBuffer>;
  try {
    const wrappedDekBytes = base64ToBytes(row.wrapped_dek);
    const dekIvBytes = base64ToBytes(row.dek_iv);
    const unwrappedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: dekIvBytes }, kekKey, wrappedDekBytes);
    rawDekBytes = new Uint8Array(unwrappedBuffer);
  } catch (err) {
    if (err instanceof DeployTokenVaultError) {
      throw err;
    }
    throw new DeployTokenVaultError(
      "TOKEN_TAMPERED",
      `Failed to unwrap DEK for token "${tokenRef}" (ciphertext or wrapped_dek integrity check failed)`,
      tokenRef,
    );
  }

  let plaintext: string;
  try {
    const dekKey = await importRawDekCryptoKey(rawDekBytes);
    const cipherBytes = base64ToBytes(row.ciphertext);
    const ivBytes = base64ToBytes(row.iv);
    const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, dekKey, cipherBytes);
    plaintext = new TextDecoder().decode(plainBuffer);
  } catch (err) {
    rawDekBytes.fill(0);
    if (err instanceof DeployTokenVaultError) {
      throw err;
    }
    throw new DeployTokenVaultError("TOKEN_TAMPERED", `Failed to decrypt ciphertext for token "${tokenRef}" (AES-GCM authentication tag mismatch)`, tokenRef);
  }

  rawDekBytes.fill(0);

  await recordTokenAuditEntry(db, {
    tokenRef: row.token_ref,
    orgId: row.org_id,
    actor: context.actor,
    deployId: context.deployId,
    action: context.action,
  });

  return plaintext;
}

export async function revokeDeployToken(db: D1Like, tokenRef: string, options: RevokeDeployTokenOptions): Promise<RevokeDeployTokenResult> {
  await ensureStudioD1Schema(db);

  const row = await db.prepare("SELECT token_ref, org_id, status, revoked_at FROM deploy_tokens WHERE token_ref = ? LIMIT 1").bind(tokenRef).first<{
    token_ref: string;
    org_id: string;
    status: DeployTokenStatus;
    revoked_at: string | null;
  }>();

  if (!row || (options.orgId && row.org_id !== options.orgId)) {
    throw new DeployTokenVaultError("TOKEN_NOT_FOUND", `Deploy token "${tokenRef}" not found`, tokenRef);
  }

  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `UPDATE deploy_tokens
       SET status = 'revoked',
           ciphertext = NULL,
           iv = NULL,
           wrapped_dek = NULL,
           dek_iv = NULL,
           revoked_at = ?
       WHERE token_ref = ? AND org_id = ?`,
    )
    .bind(nowIso, tokenRef, row.org_id)
    .run();

  await recordTokenAuditEntry(db, {
    tokenRef,
    orgId: row.org_id,
    actor: options.actor,
    deployId: options.deployId ?? "revoke",
    action: "revoke",
    createdAt: nowIso,
  });

  return {
    tokenRef,
    orgId: row.org_id,
    status: "revoked",
    revokedAt: nowIso,
    cloudflareDashboardUrl: CLOUDFLARE_API_TOKENS_DASHBOARD_URL,
  };
}

export async function rotateDeployTokenKek(
  db: D1Like,
  options: {
    fromKekVersion: number;
    fromKek: string;
    toKekVersion: number;
    toKek: string;
    orgId?: string;
  },
): Promise<RotateKekResult> {
  await ensureStudioD1Schema(db);

  const query = options.orgId
    ? `SELECT token_ref, org_id, ciphertext, iv, wrapped_dek, dek_iv, kek_version
       FROM deploy_tokens
       WHERE status = 'active' AND kek_version = ? AND org_id = ?`
    : `SELECT token_ref, org_id, ciphertext, iv, wrapped_dek, dek_iv, kek_version
       FROM deploy_tokens
       WHERE status = 'active' AND kek_version = ?`;

  const stmt = options.orgId ? db.prepare(query).bind(options.fromKekVersion, options.orgId) : db.prepare(query).bind(options.fromKekVersion);

  const rows = await stmt.all<{
    token_ref: string;
    org_id: string;
    ciphertext: string | null;
    iv: string | null;
    wrapped_dek: string | null;
    dek_iv: string | null;
    kek_version: number;
  }>();

  const oldKekKey = await deriveKekCryptoKey(options.fromKek);
  const newKekKey = await deriveKekCryptoKey(options.toKek);
  const rotatedTokenRefs: string[] = [];

  for (const row of rows.results ?? []) {
    if (!row.wrapped_dek || !row.dek_iv) continue;

    const wrappedDekBytes = base64ToBytes(row.wrapped_dek);
    const dekIvBytes = base64ToBytes(row.dek_iv);
    let rawDekBytes: Uint8Array<ArrayBuffer>;
    try {
      const unwrappedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: dekIvBytes }, oldKekKey, wrappedDekBytes);
      rawDekBytes = new Uint8Array(unwrappedBuffer);
    } catch {
      throw new DeployTokenVaultError("TOKEN_TAMPERED", `Failed to unwrap DEK for token "${row.token_ref}" during KEK rotation`, row.token_ref);
    }

    const nextDekIv = crypto.getRandomValues(new Uint8Array(12));
    const rewrappedDekBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nextDekIv }, newKekKey, rawDekBytes);
    rawDekBytes.fill(0);

    await db
      .prepare(
        `UPDATE deploy_tokens
         SET wrapped_dek = ?, dek_iv = ?, kek_version = ?
         WHERE token_ref = ?`,
      )
      .bind(bytesToBase64(new Uint8Array(rewrappedDekBuffer)), bytesToBase64(nextDekIv), options.toKekVersion, row.token_ref)
      .run();

    rotatedTokenRefs.push(row.token_ref);
  }

  return {
    fromKekVersion: options.fromKekVersion,
    toKekVersion: options.toKekVersion,
    rotatedCount: rotatedTokenRefs.length,
    rotatedTokenRefs,
  };
}

export async function getDeployTokenMetadata(db: D1Like, tokenRef: string, orgId?: string): Promise<DeployTokenMetadata | null> {
  await ensureStudioD1Schema(db);
  const row = await db
    .prepare(
      `SELECT
        token_ref, org_id, account_id, account_name, token_last4, scopes, status,
        ciphertext, iv, wrapped_dek, dek_iv, kek_version,
        created_by, created_at, last_verified_at, revoked_at
      FROM deploy_tokens
      WHERE token_ref = ?
      LIMIT 1`,
    )
    .bind(tokenRef)
    .first<DeployTokenRow>();

  if (!row) return null;
  if (orgId && row.org_id !== orgId) return null;
  return rowToMetadata(row);
}

export async function listOrgDeployTokens(db: D1Like, orgId: string): Promise<DeployTokenMetadata[]> {
  await ensureStudioD1Schema(db);
  const rows = await db
    .prepare(
      `SELECT
        token_ref, org_id, account_id, account_name, token_last4, scopes, status,
        ciphertext, iv, wrapped_dek, dek_iv, kek_version,
        created_by, created_at, last_verified_at, revoked_at
      FROM deploy_tokens
      WHERE org_id = ?
      ORDER BY created_at DESC`,
    )
    .bind(orgId)
    .all<DeployTokenRow>();

  return (rows.results ?? []).map(rowToMetadata);
}

export async function listDeployTokenAuditLog(db: D1Like, filter: { tokenRef?: string; orgId?: string }): Promise<DeployTokenAuditEntry[]> {
  await ensureStudioD1Schema(db);

  let sql = `SELECT audit_id, token_ref, org_id, actor, deploy_id, action, created_at
             FROM deploy_token_audit_log`;
  const binds: string[] = [];

  if (filter.tokenRef && filter.orgId) {
    sql += " WHERE token_ref = ? AND org_id = ?";
    binds.push(filter.tokenRef, filter.orgId);
  } else if (filter.tokenRef) {
    sql += " WHERE token_ref = ?";
    binds.push(filter.tokenRef);
  } else if (filter.orgId) {
    sql += " WHERE org_id = ?";
    binds.push(filter.orgId);
  }
  sql += " ORDER BY created_at ASC";

  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<DeployTokenAuditRow>();

  return (rows.results ?? []).map((r) => ({
    auditId: r.audit_id,
    tokenRef: r.token_ref,
    orgId: r.org_id,
    actor: r.actor,
    deployId: r.deploy_id,
    action: r.action,
    createdAt: r.created_at,
  }));
}

export function createStudioTokenResolver(db: D1Like, envOrKek?: StudioApiEnv | TokenKekConfig): TokenResolver {
  return async (tokenRef: string, context: TokenResolutionContext) => decryptToken(db, tokenRef, context, envOrKek);
}

export interface StudioTokenVault {
  sealToken(input: SealDeployTokenInput): Promise<DeployTokenMetadata>;
  decryptToken(tokenRef: string, context: TokenResolutionContext): Promise<string>;
  revokeToken(tokenRef: string, options: RevokeDeployTokenOptions): Promise<RevokeDeployTokenResult>;
  rotateKek(options: { fromKekVersion: number; fromKek: string; toKekVersion: number; toKek: string; orgId?: string }): Promise<RotateKekResult>;
  getMetadata(tokenRef: string, orgId?: string): Promise<DeployTokenMetadata | null>;
  listOrgTokens(orgId: string): Promise<DeployTokenMetadata[]>;
  listAuditLog(filter: { tokenRef?: string; orgId?: string }): Promise<DeployTokenAuditEntry[]>;
  createTokenResolver(): TokenResolver;
}

export function createTokenVault(db: D1Like, envOrKek?: StudioApiEnv | TokenKekConfig): StudioTokenVault {
  return {
    sealToken: (input) => sealDeployToken(db, input, envOrKek),
    decryptToken: (tokenRef, context) => decryptToken(db, tokenRef, context, envOrKek),
    revokeToken: (tokenRef, options) => revokeDeployToken(db, tokenRef, options),
    rotateKek: (options) => rotateDeployTokenKek(db, options),
    getMetadata: (tokenRef, orgId) => getDeployTokenMetadata(db, tokenRef, orgId),
    listOrgTokens: (orgId) => listOrgDeployTokens(db, orgId),
    listAuditLog: (filter) => listDeployTokenAuditLog(db, filter),
    createTokenResolver: () => createStudioTokenResolver(db, envOrKek),
  };
}

export async function recordOnboardingFunnelEvent(
  db: D1Like,
  input: {
    orgId: string;
    projectId?: string | null;
    actorId: string;
    step: OnboardingFunnelStep;
    metadata?: Record<string, unknown> | null;
    createdAt?: string;
  },
): Promise<OnboardingFunnelEvent> {
  await ensureStudioD1Schema(db);
  const eventId = `fnl_${generateUuidV7()}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const projectId = input.projectId ?? null;
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

  await db
    .prepare(
      `INSERT INTO onboarding_funnel_events (
        event_id, org_id, project_id, actor_id, step, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(eventId, input.orgId, projectId, input.actorId, input.step, metadataJson, createdAt)
    .run();

  const stepMap: Partial<Record<OnboardingFunnelStep, StudioOnboardingStep>> = {
    wizard_opened: "connect_cf_wizard_opened",
    template_link_clicked: "connect_cf_token_link_clicked",
    token_submitted: "connect_cf_token_submitted",
    verification_failed: "connect_cf_permission_check_failed",
    verification_succeeded: "connect_cf_verified",
  };
  const mappedStep = stepMap[input.step];
  if (mappedStep) {
    await recordStudioOnboardingEvent(db, {
      orgId: input.orgId,
      projectId,
      actorId: input.actorId,
      step: mappedStep,
      metadata: input.metadata ?? {},
      createdAt,
    }).catch(() => {});
  }

  return {
    eventId,
    orgId: input.orgId,
    projectId,
    actorId: input.actorId,
    step: input.step,
    metadata: input.metadata ?? null,
    createdAt,
  };
}

export async function recordStudioOnboardingEvent(
  db: D1Like,
  input: {
    orgId: string;
    projectId?: string | null;
    actorId: string;
    step: StudioOnboardingStep;
    templateId?: string | null;
    source?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt?: string;
    onlyOncePerProject?: boolean;
  },
): Promise<StudioOnboardingEvent> {
  await ensureStudioD1Schema(db);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const projectId = input.projectId ?? null;
  const metadataObj: Record<string, unknown> = {
    ...input.metadata,
    ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
  const metadataJson = JSON.stringify(metadataObj);

  if (input.onlyOncePerProject && projectId) {
    const existing = await db
      .prepare(
        `SELECT event_id, org_id, project_id, actor_id, step, metadata_json, created_at
         FROM studio_onboarding_events
         WHERE org_id = ? AND project_id = ? AND step = ?
         LIMIT 1`,
      )
      .bind(input.orgId, projectId, input.step)
      .first<{
        event_id: string;
        org_id: string;
        project_id: string | null;
        actor_id: string;
        step: StudioOnboardingStep;
        metadata_json: string;
        created_at: string;
      }>();
    if (existing) {
      let parsedMeta: Record<string, unknown> = {};
      try {
        parsedMeta = JSON.parse(existing.metadata_json) as Record<string, unknown>;
      } catch {
        parsedMeta = {};
      }
      if (metadataObj.templateId && (!parsedMeta.templateId || parsedMeta.source === "blank")) {
        const mergedMeta = { ...parsedMeta, ...metadataObj };
        await db
          .prepare(
            `UPDATE studio_onboarding_events
             SET metadata_json = ?
             WHERE event_id = ?`,
          )
          .bind(JSON.stringify(mergedMeta), existing.event_id)
          .run();
        parsedMeta = mergedMeta;
      }
      return {
        eventId: existing.event_id,
        orgId: existing.org_id,
        projectId: existing.project_id,
        actorId: existing.actor_id,
        step: existing.step,
        metadata: parsedMeta,
        createdAt: existing.created_at,
      };
    }
  }

  const eventId = `ob_${generateUuidV7()}`;
  await db
    .prepare(
      `INSERT INTO studio_onboarding_events (
        event_id, org_id, project_id, actor_id, step, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(eventId, input.orgId, projectId, input.actorId, input.step, metadataJson, createdAt)
    .run();

  return {
    eventId,
    orgId: input.orgId,
    projectId,
    actorId: input.actorId,
    step: input.step,
    metadata: metadataObj,
    createdAt,
  };
}

export async function listStudioOnboardingEvents(
  db: D1Like,
  filter?: {
    orgId?: string;
    projectId?: string;
    actorId?: string;
    step?: StudioOnboardingStep;
  },
): Promise<StudioOnboardingEvent[]> {
  await ensureStudioD1Schema(db);
  const clauses: string[] = [];
  const binds: string[] = [];

  if (filter?.orgId) {
    clauses.push("org_id = ?");
    binds.push(filter.orgId);
  }
  if (filter?.projectId) {
    clauses.push("project_id = ?");
    binds.push(filter.projectId);
  }
  if (filter?.actorId) {
    clauses.push("actor_id = ?");
    binds.push(filter.actorId);
  }
  if (filter?.step) {
    clauses.push("step = ?");
    binds.push(filter.step);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await db
    .prepare(
      `SELECT event_id, org_id, project_id, actor_id, step, metadata_json, created_at
       FROM studio_onboarding_events
       ${whereSql}
       ORDER BY created_at ASC`,
    )
    .bind(...binds)
    .all<{
      event_id: string;
      org_id: string;
      project_id: string | null;
      actor_id: string;
      step: StudioOnboardingStep;
      metadata_json: string;
      created_at: string;
    }>();

  return (rows.results ?? []).map((r) => {
    let metadata: Record<string, unknown> = {};
    if (r.metadata_json) {
      try {
        metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
    }
    return {
      eventId: r.event_id,
      orgId: r.org_id,
      projectId: r.project_id,
      actorId: r.actor_id,
      step: r.step,
      metadata,
      createdAt: r.created_at,
    };
  });
}

function computePercentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return Number(sortedAsc[0]!.toFixed(2));
  if (p === 0.5) {
    const mid = Math.floor(sortedAsc.length / 2);
    const val = sortedAsc.length % 2 === 1 ? sortedAsc[mid]! : (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
    return Number(val.toFixed(2));
  }
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return Number(sortedAsc[idx]!.toFixed(2));
}

export async function computeOnboardingFunnelAnalytics(db: D1Like, filter?: { orgId?: string }): Promise<OnboardingFunnelAnalytics> {
  const events = await listStudioOnboardingEvents(db, filter?.orgId ? { orgId: filter.orgId } : {});

  const stepCounts = Object.fromEntries(STUDIO_ONBOARDING_STEPS.map((s) => [s, 0])) as Record<StudioOnboardingStep, number>;
  const actorsByStep = new Map<StudioOnboardingStep, Set<string>>();
  for (const s of STUDIO_ONBOARDING_STEPS) {
    actorsByStep.set(s, new Set<string>());
  }

  const signupsByActor = new Map<string, StudioOnboardingEvent[]>();
  const deploysByActor = new Map<string, StudioOnboardingEvent[]>();

  for (const ev of events) {
    if (ev.step in stepCounts) {
      stepCounts[ev.step] += 1;
      actorsByStep.get(ev.step)?.add(ev.actorId);
    }
    if (ev.step === "signup_completed") {
      const list = signupsByActor.get(ev.actorId) ?? [];
      list.push(ev);
      signupsByActor.set(ev.actorId, list);
    } else if (ev.step === "first_preview_deploy_succeeded") {
      const list = deploysByActor.get(ev.actorId) ?? [];
      list.push(ev);
      deploysByActor.set(ev.actorId, list);
    }
  }

  const uniqueActorsByStep = Object.fromEntries(STUDIO_ONBOARDING_STEPS.map((s) => [s, actorsByStep.get(s)?.size ?? 0])) as Record<
    StudioOnboardingStep,
    number
  >;

  const actorTtfdMinutes: Array<{
    actorId: string;
    orgId: string;
    signupAt: string;
    firstPreviewDeployAt: string;
    minutes: number;
  }> = [];

  for (const [actorId, signups] of signupsByActor.entries()) {
    const deploys = deploysByActor.get(actorId) ?? [];
    const pairCount = Math.min(signups.length, deploys.length);
    for (let i = 0; i < pairCount; i += 1) {
      const sEv = signups[i]!;
      const dEv = deploys[i]!;
      const sMs = Date.parse(sEv.createdAt);
      const dMs = Date.parse(dEv.createdAt);
      if (Number.isFinite(sMs) && Number.isFinite(dMs)) {
        const minutes = Number(Math.max(0, (dMs - sMs) / 60000).toFixed(2));
        actorTtfdMinutes.push({
          actorId,
          orgId: dEv.orgId || sEv.orgId,
          signupAt: sEv.createdAt,
          firstPreviewDeployAt: dEv.createdAt,
          minutes,
        });
      }
    }
  }

  const sortedMinutes = actorTtfdMinutes.map((a) => a.minutes).sort((a, b) => a - b);
  const medianTtfdMinutes = computePercentile(sortedMinutes, 0.5);
  const p90TtfdMinutes = computePercentile(sortedMinutes, 0.9);
  const ttfdTargetMinutes = 30 as const;
  const ttfdPassed = medianTtfdMinutes !== null ? medianTtfdMinutes <= ttfdTargetMinutes : true;

  const wizardOpenedCount = stepCounts.connect_cf_wizard_opened;
  const verifiedCount = stepCounts.connect_cf_verified;
  const rawDropOff = wizardOpenedCount > 0 ? 1 - verifiedCount / wizardOpenedCount : 0;
  const dropOffRate = Number(Math.max(0, Math.min(1, rawDropOff)).toFixed(4));
  const dropOffThreshold = 0.25 as const;
  const cp9TriggerFired = dropOffRate > dropOffThreshold;

  return {
    orgId: filter?.orgId ?? null,
    stepCounts,
    uniqueActorsByStep,
    ttfd: {
      sampleSize: actorTtfdMinutes.length,
      medianTtfdMinutes,
      p90TtfdMinutes,
      ttfdTargetMinutes,
      ttfdPassed,
      actorTtfdMinutes,
    },
    connectCloudflare: {
      wizardOpenedCount,
      tokenLinkClickedCount: stepCounts.connect_cf_token_link_clicked,
      tokenSubmittedCount: stepCounts.connect_cf_token_submitted,
      permissionCheckFailedCount: stepCounts.connect_cf_permission_check_failed,
      verifiedCount,
      dropOffRate,
      dropOffThreshold,
      cp9TriggerFired,
    },
    medianTtfdMinutes,
    p90TtfdMinutes,
    ttfdTargetMinutes,
    ttfdPassed,
    wizardOpenedCount,
    verifiedCount,
    dropOffRate,
    cp9TriggerFired,
  };
}

export async function listOnboardingFunnelEvents(
  db: D1Like,
  filter: {
    orgId: string;
    projectId?: string;
    step?: OnboardingFunnelStep;
  },
): Promise<OnboardingFunnelEvent[]> {
  await ensureStudioD1Schema(db);

  const clauses = ["org_id = ?"];
  const binds: string[] = [filter.orgId];

  if (filter.projectId) {
    clauses.push("project_id = ?");
    binds.push(filter.projectId);
  }
  if (filter.step) {
    clauses.push("step = ?");
    binds.push(filter.step);
  }

  const sql = `SELECT event_id, org_id, project_id, actor_id, step, metadata_json, created_at
               FROM onboarding_funnel_events
               WHERE ${clauses.join(" AND ")}
               ORDER BY created_at ASC`;

  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<{
      event_id: string;
      org_id: string;
      project_id: string | null;
      actor_id: string;
      step: OnboardingFunnelStep;
      metadata_json: string | null;
      created_at: string;
    }>();

  return (rows.results ?? []).map((r) => {
    let metadata: Record<string, unknown> | null = null;
    if (r.metadata_json) {
      try {
        metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
      } catch {
        metadata = null;
      }
    }
    return {
      eventId: r.event_id,
      orgId: r.org_id,
      projectId: r.project_id,
      actorId: r.actor_id,
      step: r.step,
      metadata,
      createdAt: r.created_at,
    };
  });
}

export async function upsertProjectDeployEnvironments(
  db: D1Like,
  input: {
    orgId: string;
    projectIds: string[];
    accountId: string;
    accountName: string;
    tokenRef: string;
  },
): Promise<ProjectEnvironmentTargetRecord[]> {
  await ensureStudioD1Schema(db);

  const nowIso = new Date().toISOString();
  const envs: Array<"preview" | "production"> = ["preview", "production"];
  const records: ProjectEnvironmentTargetRecord[] = [];

  for (const projectId of input.projectIds) {
    for (const envName of envs) {
      await db
        .prepare(
          `INSERT INTO project_environments (
            project_id, org_id, env_name, target_type, account_id, account_name, token_ref, status, updated_at
          ) VALUES (?, ?, ?, 'byoc', ?, ?, ?, 'connected', ?)
          ON CONFLICT(project_id, env_name) DO UPDATE SET
            org_id = excluded.org_id,
            target_type = 'byoc',
            account_id = excluded.account_id,
            account_name = excluded.account_name,
            token_ref = excluded.token_ref,
            status = 'connected',
            updated_at = excluded.updated_at`,
        )
        .bind(projectId, input.orgId, envName, input.accountId, input.accountName, input.tokenRef, nowIso)
        .run();

      records.push({
        projectId,
        orgId: input.orgId,
        envName,
        target: {
          type: "byoc",
          accountId: input.accountId,
          tokenRef: input.tokenRef,
          envName,
        },
        accountName: input.accountName,
        deployedRev: null,
        buildHash: null,
        codeHash: null,
        graphHash: null,
        status: "connected",
        updatedAt: nowIso,
      });
    }
  }

  return records;
}

export async function listProjectDeployEnvironments(db: D1Like, filter: { orgId?: string; projectId?: string }): Promise<ProjectEnvironmentTargetRecord[]> {
  await ensureStudioD1Schema(db);

  const clauses: string[] = [];
  const binds: string[] = [];

  if (filter.orgId) {
    clauses.push("org_id = ?");
    binds.push(filter.orgId);
  }
  if (filter.projectId) {
    clauses.push("project_id = ?");
    binds.push(filter.projectId);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await db
    .prepare(
      `SELECT
        project_id, org_id, env_name, target_type, account_id, account_name, token_ref,
        deployed_rev, build_hash, code_hash, graph_hash, deployed_state_json, status, updated_at
      FROM project_environments
      ${whereSql}
      ORDER BY project_id ASC, env_name ASC`,
    )
    .bind(...binds)
    .all<{
      project_id: string;
      org_id: string;
      env_name: "preview" | "production";
      target_type: "byoc";
      account_id: string;
      account_name: string;
      token_ref: string;
      deployed_rev: number | null;
      build_hash: string | null;
      code_hash: string | null;
      graph_hash: string | null;
      deployed_state_json: string | null;
      status: string;
      updated_at: string;
    }>();

  return (rows.results ?? []).map((r) => {
    let deployedState: Record<string, unknown> | null = null;
    if (r.deployed_state_json) {
      try {
        deployedState = JSON.parse(r.deployed_state_json) as Record<string, unknown>;
      } catch {
        deployedState = null;
      }
    }
    return {
      projectId: r.project_id,
      orgId: r.org_id,
      envName: r.env_name,
      target: {
        type: "byoc",
        accountId: r.account_id,
        tokenRef: r.token_ref,
        envName: r.env_name,
      },
      accountName: r.account_name,
      deployedRev: r.deployed_rev ?? null,
      buildHash: r.build_hash ?? null,
      codeHash: r.code_hash ?? null,
      graphHash: r.graph_hash ?? null,
      deployedState,
      status: r.status,
      updatedAt: r.updated_at,
    };
  });
}

export async function markDeployTokenVerificationStatus(
  db: D1Like,
  tokenRef: string,
  status: DeployTokenStatus,
  lastVerifiedAt?: string,
): Promise<DeployTokenMetadata | null> {
  await ensureStudioD1Schema(db);
  const nowIso = lastVerifiedAt ?? new Date().toISOString();
  if (status === "active") {
    await db.prepare("UPDATE deploy_tokens SET status = 'active', last_verified_at = ? WHERE token_ref = ?").bind(nowIso, tokenRef).run();
  } else {
    await db.prepare("UPDATE deploy_tokens SET status = ? WHERE token_ref = ?").bind(status, tokenRef).run();
  }
  return getDeployTokenMetadata(db, tokenRef);
}
