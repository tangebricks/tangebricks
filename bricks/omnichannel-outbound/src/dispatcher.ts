import type {
  ChannelCredentials,
  D1Like,
  DeliveryAdapter,
  DeliveryChannel,
  DeliveryResult,
  DeliveryStatus,
  OutboundMessage,
  OutboundTemplate,
  SenderVerification,
  StatusWebhookResult,
} from "@poc/sdk";
import {
  SealedJsonError,
  hasSealingKey,
  hitRateLimit,
  isProductionEnvironment,
  rateLimitStorageKey,
  scoped,
  sealJson,
  sha256HexString,
  unsealJson,
} from "@poc/sdk";

export type {
  ChannelCredentials,
  DeliveryAdapter,
  DeliveryResult,
  DeliveryStatus,
  OutboundMessage,
  OutboundTemplate,
  SenderVerification,
  StatusWebhookResult,
} from "@poc/sdk";

export type ChannelType = "email" | "sms" | "whatsapp" | "slack" | "discord";

/** The secret binding channel credentials are sealed under (story 2.4, B9). */
export const CHANNEL_CREDENTIALS_KEY_ENV = "PX_CHANNEL_CREDENTIALS_KEY";

/** A channel as the API shows it: never a credential, never a verification code. */
export interface ChannelRecord extends DeliveryChannel {
  channel_type: ChannelType;
  active: boolean;
  /** Whether the sender has been proven to belong to this channel; sending needs it. */
  verified: boolean;
  /** Whether sealed credentials are stored. The credentials themselves are never returned. */
  hasCredentials: boolean;
  /** Whether an owner/admin lets workflow runs send through this channel. Default false. */
  workflowSendAllowed: boolean;
  created_at: string;
}

export interface DispatchRecord {
  id: string;
  workspace_id: string;
  channel_id: string;
  recipient: string;
  subject: string | null;
  body_text: string;
  status: "queued" | "sent" | "delivered" | "read" | "failed";
  external_id: string | null;
  error_text: string | null;
  created_at: string;
  sent_at: string | null;
  attempts: number;
}

/** A send's adapter-facing input, before validation. */
export interface SendInput {
  recipient: string;
  body?: string;
  subject?: string;
  template?: OutboundTemplate;
  /** Set by the workflow node: the channel must have `workflowSendAllowed`. */
  viaWorkflow?: boolean;
}

type Failure = { ok: false; error: string; code: number; errorCode?: string };

export interface DispatcherOptions {
  /** One adapter per provider string; a channel's `provider` selects its adapter. No default. */
  adapters?: Readonly<Record<string, DeliveryAdapter>>;
  /** The `PX_CHANNEL_CREDENTIALS_KEY` secret. Without it, channels with credentials cannot be created or used. */
  credentialsKey?: string;
  /** The `PX_ENVIRONMENT` switch: in production a test-only mock adapter is never used. */
  environment?: string;
  /** Waits between retries. Tests inject one that takes no time. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock, in milliseconds. Tests only. */
  now?: () => number;
}

/**
 * TEST-ONLY adapter: it records messages in memory and reports them "sent" without sending anything. Never used by
 * default (story 0.9, B11) and refused in production; a test injects it explicitly under a provider name.
 */
export class MockDeliveryAdapter implements DeliveryAdapter {
  public sentMessages: Array<{ channel: DeliveryChannel; message: OutboundMessage; credentials: ChannelCredentials }> = [];
  /** Answers returned in order before falling back to "sent" (to script 429s, 5xxs, 400s). */
  public script: DeliveryResult[] = [];
  public shouldFail = false;
  public verification: SenderVerification = { method: "credential", verified: true };
  public webhook?: (rawBody: string, headers: Headers, credentials: ChannelCredentials) => Promise<StatusWebhookResult>;
  public calls = 0;

  async send(channel: DeliveryChannel, message: OutboundMessage, credentials: ChannelCredentials): Promise<DeliveryResult> {
    this.calls += 1;
    const scripted = this.script.shift();
    if (scripted) {
      if (scripted.status === "sent") this.sentMessages.push({ channel, message, credentials });
      return scripted;
    }
    if (this.shouldFail) return { status: "failed", error: "MOCK_REFUSED", retryable: false };
    this.sentMessages.push({ channel, message, credentials });
    return { status: "sent", externalId: `msg_${crypto.randomUUID().replace(/-/g, "")}` };
  }

  async verifySender(): Promise<SenderVerification> {
    return this.verification;
  }

  async parseStatusWebhook(rawBody: string, headers: Headers, credentials: ChannelCredentials): Promise<StatusWebhookResult> {
    return this.webhook ? this.webhook(rawBody, headers, credentials) : { kind: "invalid" };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Input checks (B10)
// ---------------------------------------------------------------------------------------------------------------------

const HEADER_BREAK = /[\r\n\0]/;
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const SECRET_LIKE_KEY = /key|token|secret|password|authorization/i;
const TEMPLATE_NAME = /^[A-Za-z0-9_.:-]{1,256}$/;
const TEMPLATE_LANGUAGE = /^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})?$/;
const TEMPLATE_VARIABLE = /^[A-Za-z0-9_.-]{1,64}$/;
const CHANNEL_ID = /^chn_[0-9a-f]{32}$/;
const CODE = /^\d{6}$/;

export const VERIFY_CODE_TTL_MS = 15 * 60 * 1000;
export const VERIFY_CODE_MAX_ATTEMPTS = 5;
export const MAX_SEND_ATTEMPTS = 3;
/** Waits before the 2nd and 3rd attempt; a provider's Retry-After replaces them, up to MAX_RETRY_WAIT_MS. */
export const RETRY_BACKOFF_MS = [250, 1000] as const;
export const MAX_RETRY_WAIT_MS = 2000;
/** The whole send, every attempt and wait included. A send still running at the end is UNKNOWN_OUTCOME. */
export const SEND_BUDGET_MS = 20_000;
/** Codes sent per channel per hour, across create and re-verify. */
export const VERIFY_CODE_MAX_SENDS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
/**
 * Credentials: at most this many entries and this many UTF-8 bytes of JSON. Sealing adds a 16-byte tag and base64
 * (4/3) plus a small envelope, so 10240 bytes seal to under 13 700 characters: always inside the column's 16384.
 */
export const MAX_CREDENTIAL_ENTRIES = 16;
export const MAX_CREDENTIALS_JSON = 10_240;
/** UTF-8 byte length of the credentials' JSON (what is sealed). */
export function credentialsJsonBytes(credentials: unknown): number {
  return new TextEncoder().encode(JSON.stringify(credentials)).length;
}
/** Code mails per workspace per hour (all channels together), counted with the SDK rate limiter. */
export const VERIFY_CODE_MAX_SENDS_PER_WORKSPACE_HOUR = 20;
/** A send attempt is started only while at least this much of the budget remains (the adapters' request timeout). */
export const ADAPTER_TIMEOUT_MS = 10_000;
const MAX_CONFIG_DEPTH = 8;
const MAX_CONFIG_KEYS = 200;

/** True for a value with CR, LF or NUL (a header break). */
export function hasHeaderBreak(value: string): boolean {
  return HEADER_BREAK.test(value);
}

/**
 * Why `config` is refused, or null. A key (at any depth) that looks like a secret is refused (secrets belong in
 * `credentials`), and so is config nested deeper than 8 levels or with more than 200 keys in all: too deep or too wide
 * is refused, never passed unchecked.
 */
export function configError(config: unknown): string | null {
  let keys = 0;
  const walk = (value: unknown, depth: number): string | null => {
    if (!value || typeof value !== "object") return null;
    if (depth > MAX_CONFIG_DEPTH) return `config must not be nested more than ${MAX_CONFIG_DEPTH} levels deep`;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      keys += 1;
      if (keys > MAX_CONFIG_KEYS) return `config must have at most ${MAX_CONFIG_KEYS} keys`;
      if (SECRET_LIKE_KEY.test(key)) return `config must hold non-secret settings only; "${key}" looks like a secret: send it in credentials`;
      const problem = walk(nested, depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  return walk(config, 0);
}

/** Why `credentials` are refused, or null: string values only, at most 16 entries and 10240 UTF-8 bytes of JSON. */
export function credentialsError(credentials: unknown): string | null {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) return "credentials must be an object of strings";
  const entries = Object.entries(credentials as Record<string, unknown>);
  if (entries.length > MAX_CREDENTIAL_ENTRIES) return `credentials may have at most ${MAX_CREDENTIAL_ENTRIES} entries`;
  if (entries.some(([, v]) => typeof v !== "string")) return "credentials must be an object of strings";
  if (credentialsJsonBytes(credentials) > MAX_CREDENTIALS_JSON) return `credentials must be at most ${MAX_CREDENTIALS_JSON} bytes of JSON`;
  return null;
}

/** Checks one recipient for a channel type: one address or number, no header break. */
export function recipientError(channelType: string, recipient: string): string | null {
  if (hasHeaderBreak(recipient)) return "Recipient must not contain CR, LF or NUL";
  if (/[,;]/.test(recipient)) return "Exactly one recipient per send: commas and semicolons are not allowed";
  if (channelType === "email" && !EMAIL.test(recipient)) return "Recipient must be one valid email address";
  if ((channelType === "whatsapp" || channelType === "sms") && !E164.test(recipient)) return "Recipient must be one E.164 phone number (+ and 7 to 15 digits)";
  return null;
}

function templateError(template: OutboundTemplate): string | null {
  if (!template || typeof template !== "object") return "Template must be an object";
  if (template.language !== undefined && typeof template.language !== "string") return "Template language must be a string";
  if (template.variables !== undefined && (!template.variables || typeof template.variables !== "object" || Array.isArray(template.variables))) {
    return "Template variables must be an object of strings";
  }
  if (typeof template.name !== "string" || !TEMPLATE_NAME.test(template.name)) return "Template name must be 1 to 256 letters, digits, '_', '.', ':' or '-'";
  if (template.language !== undefined && !TEMPLATE_LANGUAGE.test(template.language)) return "Template language must look like en or en_US";
  const variables = Object.entries(template.variables ?? {});
  if (variables.length > 50) return "A template takes at most 50 variables";
  for (const [key, value] of variables) {
    if (!TEMPLATE_VARIABLE.test(key)) return "Template variable names must be 1 to 64 letters, digits, '_', '.' or '-'";
    if (typeof value !== "string" || value.length > 1024 || hasHeaderBreak(value)) return "Template variable values must be strings of at most 1024 characters without CR, LF or NUL";
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ChannelRow {
  id: string;
  workspace_id: string;
  channel_type: ChannelType;
  provider: string;
  sender_address: string;
  active: number;
  config_json: string;
  created_at: string;
  verified: number;
  credentials_ciphertext: string | null;
  verify_code_hash: string | null;
  verify_code_expires_at: string | null;
  verify_code_attempts: number;
  verify_code_sends: number;
  verify_code_window_start: string | null;
  workflow_send_allowed: number;
}

function toChannel(row: ChannelRow): ChannelRecord {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    channel_type: row.channel_type,
    provider: row.provider,
    sender_address: row.sender_address,
    active: row.active === 1,
    verified: row.verified === 1,
    hasCredentials: typeof row.credentials_ciphertext === "string" && row.credentials_ciphertext.length > 0,
    workflowSendAllowed: row.workflow_send_allowed === 1,
    config: JSON.parse(row.config_json || "{}") as Record<string, unknown>,
    created_at: row.created_at,
  };
}

/** What the adapter sees: the non-secret channel only. */
function adapterChannel(channel: ChannelRecord): DeliveryChannel {
  return {
    id: channel.id,
    workspace_id: channel.workspace_id,
    channel_type: channel.channel_type,
    provider: channel.provider,
    sender_address: channel.sender_address,
    config: channel.config,
  };
}

const STATUS_FROM: Record<DeliveryStatus, string[]> = {
  // Forward only: sent -> delivered -> read, and sent -> failed. Nothing moves backwards.
  delivered: ["sent"],
  read: ["sent", "delivered"],
  failed: ["sent"],
};

export class MessageDispatcherService {
  private readonly db: D1Like;
  private readonly adapters: Readonly<Record<string, DeliveryAdapter>>;
  private readonly credentialsKey: string | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(db: D1Like, options: DispatcherOptions = {}) {
    this.db = db;
    // Story 0.9 (B11): no default adapter. In production the test-only mock is refused like a missing adapter.
    const production = isProductionEnvironment(options.environment);
    this.adapters = Object.fromEntries(
      Object.entries(options.adapters ?? {}).filter(([, adapter]) => adapter && !(production && adapter instanceof MockDeliveryAdapter)),
    );
    this.credentialsKey = options.credentialsKey;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
  }

  private adapterFor(provider: string): DeliveryAdapter | undefined {
    return Object.prototype.hasOwnProperty.call(this.adapters, provider) ? this.adapters[provider] : undefined;
  }

  private notConfigured(what: string): Failure {
    return { ok: false, error: `NOT_CONFIGURED: ${what}`, code: 503, errorCode: "NOT_CONFIGURED" };
  }

  private sealOptions(workspaceId: string, channelId: string) {
    return {
      keyMaterial: this.credentialsKey,
      keyName: CHANNEL_CREDENTIALS_KEY_ENV,
      domain: "projectx-omnichannel-credentials-v1",
      associatedData: `${workspaceId}:${channelId}`,
    };
  }

  /** The channel's credentials, decrypted; {} when none are stored. Throws SealedJsonError (MISSING_KEY, INTEGRITY). */
  private async credentialsOf(row: Pick<ChannelRow, "id" | "workspace_id" | "credentials_ciphertext">): Promise<ChannelCredentials> {
    if (!row.credentials_ciphertext) return {};
    return unsealJson<ChannelCredentials>(row.credentials_ciphertext, this.sealOptions(row.workspace_id, row.id));
  }

  private async channelRow(workspaceId: string, channelId: string): Promise<ChannelRow | null> {
    return scoped(this.db, workspaceId).first<ChannelRow>("msg_channels", "id = ? AND active = 1", [channelId]);
  }

  /**
   * Registers a channel (B8, B9). It starts unverified; with an adapter for its provider the sender is checked right
   * away ("credential") or a code is sent to it ("code"). Credentials are sealed; secret-like keys in `config` are
   * refused.
   */
  async createChannel(
    workspaceId: string,
    channelType: ChannelType,
    providerRaw: string,
    senderAddressRaw: string,
    config: Record<string, unknown> = {},
    credentials?: Record<string, string>,
    options: { workflowSendAllowed?: boolean } = {},
  ): Promise<{ ok: true; channel: ChannelRecord } | Failure> {
    const provider = providerRaw.trim().toLowerCase();
    const sender = senderAddressRaw.trim();

    if (!provider || provider.length > 64) return { ok: false, error: "Provider name must be between 1 and 64 characters", code: 400 };
    if (!sender || sender.length > 255) return { ok: false, error: "Sender address must be between 1 and 255 characters", code: 400 };
    if (hasHeaderBreak(senderAddressRaw) || /[,;]/.test(sender)) return { ok: false, error: "Sender address must be one address without CR, LF or NUL", code: 400 };
    if (channelType === "email" && !EMAIL.test(sender)) return { ok: false, error: "Sender address must be a valid email address", code: 400 };

    const configShapeProblem = configError(config);
    if (configShapeProblem) return { ok: false, error: configShapeProblem, code: 400 };
    if (credentials !== undefined) {
      const problem = credentialsError(credentials);
      if (problem) return { ok: false, error: problem, code: 400 };
    }
    const configJson = JSON.stringify(config);
    if (configJson.length > 4096) return { ok: false, error: "config must be at most 4096 characters of JSON", code: 400 };

    // A provider is known when some adapter serves it. With no adapters at all (the assembled default) the channel can
    // be recorded, but it stays unverified and sending answers 503 NOT_CONFIGURED.
    const adapter = this.adapterFor(provider);
    if (!adapter && Object.keys(this.adapters).length > 0) return { ok: false, error: `Unknown provider "${provider}"`, code: 400 };
    const configProblem = adapter?.checkConfig?.({ channel_type: channelType, sender_address: sender, config }) ?? null;
    if (configProblem) return { ok: false, error: configProblem, code: 400 };

    const hasCredentials = credentials !== undefined && Object.keys(credentials).length > 0;
    if (hasCredentials && !hasSealingKey(this.credentialsKey)) {
      return this.notConfigured(`${CHANNEL_CREDENTIALS_KEY_ENV} is not set, so channel credentials cannot be stored; the channel was not created.`);
    }

    const id = `chn_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date(this.now()).toISOString();
    const ciphertext = hasCredentials ? await sealJson(credentials, this.sealOptions(workspaceId, id)) : null;

    await scoped(this.db, workspaceId).insert("msg_channels", {
      id,
      channel_type: channelType,
      provider,
      sender_address: sender,
      active: 1,
      config_json: configJson,
      created_at: now,
      verified: 0,
      credentials_ciphertext: ciphertext,
      workflow_send_allowed: options.workflowSendAllowed === true ? 1 : 0,
    });

    if (adapter) {
      // Best effort: a provider that cannot be reached leaves the channel unverified; verify can be asked again.
      await this.startVerification(workspaceId, id).catch(() => undefined);
    }
    const row = await this.channelRow(workspaceId, id);
    return { ok: true, channel: toChannel(row!) };
  }

  /**
   * Starts (or repeats) sender verification: for "credential" asks the provider and records its answer; for "code"
   * sends a fresh one-time code to the sender address (any earlier code stops working).
   */
  async startVerification(
    workspaceId: string,
    channelId: string,
  ): Promise<{ ok: true; channel: ChannelRecord; method: "credential" | "code"; codeSent?: boolean } | Failure> {
    const row = await this.channelRow(workspaceId, channelId);
    if (!row) return { ok: false, error: "Channel not found", code: 404 };
    const adapter = this.adapterFor(row.provider);
    if (!adapter) return this.notConfigured(`no delivery adapter is configured for provider "${row.provider}".`);
    let credentials: ChannelCredentials;
    try {
      credentials = await this.credentialsOf(row);
    } catch (error) {
      return this.credentialFailure(error);
    }
    const channel = toChannel(row);
    let verification: SenderVerification;
    try {
      verification = await adapter.verifySender(adapterChannel(channel), credentials);
    } catch {
      verification = { method: "unavailable", error: "ADAPTER_ERROR" };
    }
    const db = scoped(this.db, workspaceId);
    if (verification.method === "unavailable") {
      // Not a "no": the verified state is left as it was.
      return { ok: false, error: "The provider could not be asked about the sender; try again later", code: 502, errorCode: "PROVIDER_UNAVAILABLE" };
    }
    if (verification.method === "credential") {
      await db.update("msg_channels", { verified: verification.verified ? 1 : 0, verify_code_hash: null, verify_code_expires_at: null, verify_code_attempts: 0 }, "id = ?", [channelId]);
      return { ok: true, channel: { ...channel, verified: verification.verified }, method: "credential" };
    }
    if (channel.verified) return { ok: true, channel, method: "code", codeSent: false };

    const digits = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
    const code = String(digits).padStart(6, "0");
    const nowMs = this.now();
    // A workspace-wide cap first, so creating many channels cannot multiply the per-channel one. Fails closed: without
    // the limiter's table no code is mailed.
    try {
      const key = await rateLimitStorageKey("messages-verify-code-workspace", workspaceId);
      const counted = await hitRateLimit(this.db, key, VERIFY_CODE_MAX_SENDS_PER_WORKSPACE_HOUR, 3600, nowMs);
      if (!counted.allowed) {
        return { ok: false, error: `At most ${VERIFY_CODE_MAX_SENDS_PER_WORKSPACE_HOUR} codes per workspace per hour; try again later`, code: 429, errorCode: "TOO_MANY_CODES" };
      }
    } catch {
      return { ok: false, error: "The code limiter is unavailable; no code was sent", code: 503, errorCode: "RATE_LIMIT_UNAVAILABLE" };
    }
    const codeHash = await sha256HexString(`${channelId}:${code}`);
    const windowCutoff = new Date(nowMs - HOUR_MS).toISOString();
    // One conditional statement: store the new code and count it in the hourly window, unless 5 were already sent in
    // the current window (then nothing changes and nothing is sent).
    const claimed = await db
      .raw(
        "UPDATE msg_channels SET " +
          "verify_code_sends = CASE WHEN COALESCE(verify_code_window_start, '') > ? THEN verify_code_sends + 1 ELSE 1 END, " +
          "verify_code_window_start = CASE WHEN COALESCE(verify_code_window_start, '') > ? THEN verify_code_window_start ELSE ? END, " +
          "verify_code_hash = ?, verify_code_expires_at = ?, verify_code_attempts = 0 " +
          "WHERE id = ? AND workspace_id = ? AND NOT (COALESCE(verify_code_window_start, '') > ? AND verify_code_sends >= ?)",
        [
          windowCutoff,
          windowCutoff,
          new Date(nowMs).toISOString(),
          codeHash,
          new Date(nowMs + VERIFY_CODE_TTL_MS).toISOString(),
          channelId,
          workspaceId,
          windowCutoff,
          VERIFY_CODE_MAX_SENDS_PER_HOUR,
        ],
      )
      .run();
    if (Number(claimed.meta?.changes ?? 0) !== 1) {
      return { ok: false, error: `At most ${VERIFY_CODE_MAX_SENDS_PER_HOUR} codes per hour for one channel; try again later`, code: 429, errorCode: "TOO_MANY_CODES" };
    }
    const outcome = await this.deliver(adapter, channel, credentials, {
      recipient: channel.sender_address,
      subject: "Confirm your sender address",
      body: `Your sender verification code is ${code}. It expires in 15 minutes. If you did not ask for it, ignore this message.`,
    });
    if (outcome.result.status !== "sent") {
      if (/UNKNOWN_OUTCOME$/.test(outcome.result.error)) {
        // It may have arrived: the code is kept so it can still be confirmed.
        return {
          ok: false,
          error: "It is not known whether the verification code was delivered; check the sender's inbox, or ask for a new code later",
          code: 502,
          errorCode: "VERIFICATION_OUTCOME_UNKNOWN",
        };
      }
      // A definite non-delivery: clear this request's code only, never a newer one stored meanwhile.
      await db.update("msg_channels", { verify_code_hash: null, verify_code_expires_at: null }, "id = ? AND verify_code_hash = ?", [channelId, codeHash]);
      return { ok: false, error: "The verification code could not be sent", code: 502, errorCode: "VERIFICATION_NOT_SENT" };
    }
    return { ok: true, channel, method: "code", codeSent: true };
  }

  /**
   * Confirms a "code" verification. The attempt is counted by one conditional increment (same pending code, fewer
   * than 5 attempts, not expired) and the code is compared only when that increment landed, so parallel guesses all
   * count. Verified only when the final conditional update changed the row; a code replaced meanwhile is refused.
   */
  async confirmVerification(workspaceId: string, channelId: string, codeRaw: string): Promise<{ ok: true; channel: ChannelRecord } | Failure> {
    const row = await this.channelRow(workspaceId, channelId);
    if (!row) return { ok: false, error: "Channel not found", code: 404 };
    if (row.verified === 1) return { ok: true, channel: toChannel(row) };
    const hash = row.verify_code_hash;
    if (!hash || !row.verify_code_expires_at) {
      return { ok: false, error: "No verification code is pending; ask for one first", code: 409, errorCode: "NO_PENDING_CODE" };
    }
    const db = scoped(this.db, workspaceId);
    const counted = await db
      .raw(
        "UPDATE msg_channels SET verify_code_attempts = verify_code_attempts + 1 " +
          "WHERE id = ? AND workspace_id = ? AND verify_code_hash = ? AND verify_code_attempts < ? AND verify_code_expires_at > ?",
        [channelId, workspaceId, hash, VERIFY_CODE_MAX_ATTEMPTS, new Date(this.now()).toISOString()],
      )
      .run();
    if (Number(counted.meta?.changes ?? 0) !== 1) {
      const current = await this.channelRow(workspaceId, channelId);
      if (!current || current.verify_code_hash !== hash) {
        return { ok: false, error: "The verification code was superseded; use the latest code", code: 409, errorCode: "CODE_SUPERSEDED" };
      }
      if (current.verify_code_attempts >= VERIFY_CODE_MAX_ATTEMPTS) {
        return { ok: false, error: "Too many attempts for this code; ask for a new one", code: 429, errorCode: "TOO_MANY_ATTEMPTS" };
      }
      return { ok: false, error: "The verification code has expired; ask for a new one", code: 410, errorCode: "CODE_EXPIRED" };
    }
    const code = codeRaw.trim();
    const matches = CODE.test(code) && constantTimeEqual(await sha256HexString(`${channelId}:${code}`), hash);
    if (!matches) return { ok: false, error: "Wrong verification code", code: 400, errorCode: "INVALID_CODE" };
    const done = await db.update(
      "msg_channels",
      { verified: 1, verify_code_hash: null, verify_code_expires_at: null, verify_code_attempts: 0 },
      "id = ? AND verify_code_hash = ?",
      [channelId, hash],
    );
    if (Number(done.meta?.changes ?? 0) !== 1) {
      return { ok: false, error: "The verification code was superseded; use the latest code", code: 409, errorCode: "CODE_SUPERSEDED" };
    }
    return { ok: true, channel: { ...toChannel(row), verified: true } };
  }

  /** Lets (or stops) workflow runs send through a channel. Owner/admin only (the route checks the role). */
  async setWorkflowSendAllowed(workspaceId: string, channelId: string, allowed: boolean): Promise<{ ok: true; channel: ChannelRecord } | Failure> {
    const res = await scoped(this.db, workspaceId).update("msg_channels", { workflow_send_allowed: allowed ? 1 : 0 }, "id = ? AND active = 1", [channelId]);
    if (Number(res.meta?.changes ?? 0) !== 1) return { ok: false, error: "Channel not found", code: 404 };
    const row = await this.channelRow(workspaceId, channelId);
    return { ok: true, channel: toChannel(row!) };
  }

  private credentialFailure(error: unknown): Failure {
    if (error instanceof SealedJsonError && error.code === "MISSING_KEY") {
      return this.notConfigured(`${CHANNEL_CREDENTIALS_KEY_ENV} is not set, so the channel's credentials cannot be opened.`);
    }
    return { ok: false, error: "The channel's credentials could not be opened", code: 500, errorCode: "CREDENTIALS_UNREADABLE" };
  }

  /** Lists a workspace's channels: never credentials, only `hasCredentials`. */
  async listChannels(workspaceId: string): Promise<ChannelRecord[]> {
    const rows = await scoped(this.db, workspaceId).select<ChannelRow>("msg_channels", "active = 1", [], { orderBy: "created_at DESC" });
    return rows.map(toChannel);
  }

  /**
   * Up to MAX_SEND_ATTEMPTS attempts, but only for a failure the provider marked `retryable` (it said the message was
   * not processed: 429, a 503 with Retry-After, a throttling code). It waits 250 ms, then 1 s, or the provider's
   * Retry-After up to 2 s. The whole send has SEND_BUDGET_MS: an attempt still running then, or an adapter that throws,
   * is `failed` with UNKNOWN_OUTCOME and not retried, because the message may have been delivered. `sent` needs an id.
   */
  private async deliver(
    adapter: DeliveryAdapter,
    channel: ChannelRecord,
    credentials: ChannelCredentials,
    message: OutboundMessage,
  ): Promise<{ result: DeliveryResult; attempts: number }> {
    const started = this.now();
    let result: DeliveryResult = { status: "failed", error: "NOT_ATTEMPTED", retryable: false };
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      const remaining = SEND_BUDGET_MS - (this.now() - started);
      // Never start an attempt that could not finish inside the budget. Before the first attempt nothing was sent;
      // after a retryable failure the last definite failure is what is recorded.
      if (remaining < ADAPTER_TIMEOUT_MS) {
        if (attempt === 1) return { result: { status: "failed", error: "SEND_BUDGET_EXHAUSTED", retryable: false }, attempts: 0 };
        return { result: { ...result, retryable: false }, attempts: attempt - 1 };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          adapter.send(adapterChannel(channel), message, credentials),
          new Promise<DeliveryResult>((resolve) => {
            timer = setTimeout(() => resolve({ status: "failed", error: "SEND_TIMEOUT_UNKNOWN_OUTCOME", retryable: false }), Math.max(remaining, 0));
          }),
        ]);
      } catch {
        result = { status: "failed", error: "ADAPTER_ERROR_UNKNOWN_OUTCOME", retryable: false };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (result.status === "sent") {
        const id = result.externalId;
        if (typeof id === "string" && id.trim().length > 0 && id.length <= 255) return { result, attempts: attempt };
        return { result: { status: "failed", error: "NO_PROVIDER_ID", retryable: false }, attempts: attempt };
      }
      if (result.status !== "failed") result = { status: "failed", error: "INVALID_ADAPTER_RESULT", retryable: false };
      if (result.retryable !== true || attempt === MAX_SEND_ATTEMPTS) return { result, attempts: attempt };
      const backoff: number = RETRY_BACKOFF_MS[attempt - 1] ?? MAX_RETRY_WAIT_MS;
      const wait = typeof result.retryAfterMs === "number" && result.retryAfterMs >= 0 ? Math.min(result.retryAfterMs, MAX_RETRY_WAIT_MS) : backoff;
      // No retry that could not finish inside the budget: the last definite failure stands.
      if (this.now() - started + wait + ADAPTER_TIMEOUT_MS > SEND_BUDGET_MS) return { result: { ...result, retryable: false }, attempts: attempt };
      await this.sleep(wait);
    }
    return { result, attempts: MAX_SEND_ATTEMPTS };
  }

  /**
   * Sends one message through a channel (by id, else the first active channel of that type). Refuses a header break,
   * more than one recipient, an unverified sender (409) and a provider without an adapter (503). The outcome is
   * recorded once: `sent` only with the provider's id, otherwise `failed`.
   */
  async sendMessage(
    workspaceId: string,
    channelIdOrType: string,
    input: SendInput,
  ): Promise<{ ok: true; dispatch: DispatchRecord } | Failure> {
    const recipient = input.recipient.trim();
    if (!recipient || recipient.length > 255) return { ok: false, error: "Recipient must be between 1 and 255 characters", code: 400 };
    if (hasHeaderBreak(input.recipient)) return { ok: false, error: "Recipient must not contain CR, LF or NUL", code: 400 };
    if (input.subject !== undefined && (hasHeaderBreak(input.subject) || input.subject.length > 255)) {
      return { ok: false, error: "Subject must be at most 255 characters without CR, LF or NUL", code: 400 };
    }
    const subject = input.subject?.trim() || undefined;
    if (input.template) {
      const problem = templateError(input.template);
      if (problem) return { ok: false, error: problem, code: 400 };
    }
    const body = (input.body ?? "").trim();
    if (!input.template && (!body || body.length > 65536)) return { ok: false, error: "Message body must be between 1 and 65536 characters", code: 400 };
    if (body.length > 65536) return { ok: false, error: "Message body must be at most 65536 characters", code: 400 };

    let row = await this.channelRow(workspaceId, channelIdOrType);
    if (!row) {
      // By type: a verified channel first, then the oldest, so the choice is deterministic. A workflow send prefers a
      // channel opened to workflows.
      const rows = await scoped(this.db, workspaceId).select<ChannelRow>("msg_channels", "channel_type = ? AND active = 1", [channelIdOrType], {
        orderBy: input.viaWorkflow === true ? "workflow_send_allowed DESC, verified DESC, created_at ASC, id ASC" : "verified DESC, created_at ASC, id ASC",
        limit: 1,
      });
      row = rows[0] ?? null;
    }
    if (!row) return { ok: false, error: `No active channel found matching "${channelIdOrType}"`, code: 404 };
    const channel = toChannel(row);

    const recipientProblem = recipientError(channel.channel_type, recipient);
    if (recipientProblem) return { ok: false, error: recipientProblem, code: 400 };

    const adapter = this.adapterFor(channel.provider);
    if (!adapter) {
      return this.notConfigured(`no delivery adapter is configured for ${channel.channel_type} (${channel.provider}); the message was not sent.`);
    }
    if (!channel.verified) {
      return { ok: false, error: "The channel's sender has not been verified; nothing was sent", code: 409, errorCode: "SENDER_NOT_VERIFIED" };
    }
    if (input.viaWorkflow === true && !channel.workflowSendAllowed) {
      return {
        ok: false,
        error: "Workflow runs may not send through this channel; an owner or admin can allow it (workflowSendAllowed)",
        code: 403,
        errorCode: "WORKFLOW_SEND_NOT_ALLOWED",
      };
    }
    let credentials: ChannelCredentials;
    try {
      credentials = await this.credentialsOf(row);
    } catch (error) {
      return this.credentialFailure(error);
    }

    const template = input.template
      ? {
          name: input.template.name,
          ...(input.template.language !== undefined ? { language: input.template.language } : {}),
          ...(input.template.variables !== undefined ? { variables: { ...input.template.variables } } : {}),
        }
      : undefined;
    const message: OutboundMessage = { recipient, body, ...(subject !== undefined ? { subject } : {}), ...(template ? { template } : {}) };
    const { result, attempts } = await this.deliver(adapter, channel, credentials, message);

    const now = new Date(this.now()).toISOString();
    const sent = result.status === "sent";
    const dispatch: DispatchRecord = {
      id: `dsp_${crypto.randomUUID().replace(/-/g, "")}`,
      workspace_id: workspaceId,
      channel_id: channel.id,
      recipient,
      subject: subject ?? null,
      body_text: body || `template:${template?.name ?? ""}`,
      status: sent ? "sent" : "failed",
      external_id: sent ? result.externalId : null,
      error_text: sent ? null : result.error.slice(0, 256),
      created_at: now,
      sent_at: sent ? now : null,
      attempts,
    };
    const { workspace_id: _ws, ...stored } = dispatch;
    await scoped(this.db, workspaceId).insert("msg_dispatches", stored);
    return { ok: true, dispatch };
  }

  /** A workspace's dispatches, newest first. The caller bounds `limit` (1..100) and `offset` (0..100000). */
  async listDispatches(workspaceId: string, options: { channelId?: string; limit?: number; offset?: number } = {}): Promise<DispatchRecord[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
    const offset = Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), 100_000);
    const db = scoped(this.db, workspaceId);
    if (options.channelId) {
      return db.select<DispatchRecord>("msg_dispatches", "channel_id = ?", [options.channelId], { orderBy: "created_at DESC", limit, offset });
    }
    return db.select<DispatchRecord>("msg_dispatches", undefined, [], { orderBy: "created_at DESC", limit, offset });
  }

  /**
   * A provider's delivery-status webhook for one channel. The channel is found by its unguessable id across
   * workspaces; the signature is checked with that channel's own credentials; only that workspace's dispatches on
   * that channel are updated, and only forwards.
   */
  async handleStatusWebhook(
    channelId: string,
    rawBody: string,
    headers: Headers,
  ): Promise<{ status: 200; ignored: boolean; updated: number } | { status: 401 } | Failure> {
    const row = await this.channelById(channelId);
    if (!row) return { status: 200, ignored: true, updated: 0 };
    const adapter = this.adapterFor(row.provider);
    if (!adapter?.parseStatusWebhook) return { status: 200, ignored: true, updated: 0 };
    let credentials: ChannelCredentials;
    try {
      credentials = await this.credentialsOf(row);
    } catch (error) {
      return this.credentialFailure(error);
    }
    const parsed = await adapter.parseStatusWebhook(rawBody, headers, credentials, adapterChannel(toChannel(row)));
    if (parsed.kind === "invalid") return { status: 401 };
    if (parsed.kind !== "status") return { status: 200, ignored: true, updated: 0 };
    const db = scoped(this.db, row.workspace_id);
    let updated = 0;
    for (const update of parsed.updates.slice(0, 100)) {
      const from = STATUS_FROM[update.status];
      if (!from || typeof update.externalId !== "string") continue;
      const set: Record<string, unknown> = { status: update.status };
      if (update.status === "failed") set.error_text = (update.error ?? "PROVIDER_REPORTED_FAILURE").slice(0, 256);
      const res = await db.update(
        "msg_dispatches",
        set,
        `external_id = ? AND channel_id = ? AND status IN (${from.map(() => "?").join(", ")})`,
        [update.externalId, row.id, ...from],
      );
      updated += Number(res.meta?.changes ?? 0);
    }
    return { status: 200, ignored: updated === 0, updated };
  }

  /** A provider's GET subscription check: the text to echo, or null. */
  async answerWebhookChallenge(channelId: string, query: URLSearchParams): Promise<string | null | Failure> {
    const row = await this.channelById(channelId);
    if (!row) return null;
    const adapter = this.adapterFor(row.provider);
    if (!adapter?.answerWebhookChallenge) return null;
    let credentials: ChannelCredentials;
    try {
      credentials = await this.credentialsOf(row);
    } catch (error) {
      return this.credentialFailure(error);
    }
    return adapter.answerWebhookChallenge(query, credentials, adapterChannel(toChannel(row)));
  }

  private async channelById(channelId: string): Promise<ChannelRow | null> {
    if (!CHANNEL_ID.test(channelId)) return null;
    // tenant-lint: allow a provider webhook resolves its channel by the channel's unguessable id to learn its workspace
    return this.db.prepare("SELECT * FROM msg_channels WHERE id = ? AND active = 1").bind(channelId).first<ChannelRow>();
  }
}
