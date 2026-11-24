import { scoped, systemScope, type D1Like } from "@poc/sdk";
import {
  WebhookSignatureSchemeSchema,
  type IntegrationManifestFile,
  type WebhookVerifierPreset,
} from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import {
  generateWebhookSecret,
  sha256HexString,
  unsealPxConnectionSecret,
  verifySharedSecret,
} from "./crypto.ts";
import {
  verifyWithScheme,
  type WebhookSignatureScheme,
  type WebhookVerifyReason,
} from "./signature-scheme.ts";
import {
  getDefaultSignatureHeader,
  getPreset,
  mapToDbVerifier,
  PRESETS,
  WEBHOOK_PRESETS,
  type PresetName,
} from "./presets.ts";

export interface EndpointRecord {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  signing_secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: string | null;
  target_workflow_id: string | null;
  active: boolean;
  created_at: string;
}

export interface DeliveryRecord {
  id: string;
  endpoint_id: string;
  workspace_id: string;
  status_code: number;
  headers_json: string | null;
  payload_text: string | null;
  payload_truncated: boolean;
  signature_verified: boolean;
  received_at: string;
  duration_ms: number;
}

export type WebhookVerifierType = WebhookVerifierPreset | WebhookSignatureScheme;

export interface WebhookSubscriptionRecord {
  id: string;
  workspace_id: string;
  workflow_id: string;
  connection_ref: string | null;
  app: string;
  trigger_id: string;
  verifier: string;
  signature_header: string;
  event_id_path: string | null;
  signing_secret: string | null;
  enabled: boolean;
  created_at: string;
  scheme_json?: string;
  disabled_reason?: string | null;
}

export interface CreateSubscriptionInput {
  id?: string;
  workspaceId?: string;
  workflowId: string;
  connectionRef?: string | null;
  app: string;
  triggerId: string;
  verifier?: PresetName | WebhookSignatureScheme | (string & {});
  verificationScheme?: PresetName | WebhookSignatureScheme | (string & {});
  scheme?: WebhookSignatureScheme;
  signatureHeader?: string;
  eventIdPath?: string | null;
  signingSecret?: string | null;
  enabled?: boolean;
}

export interface WebhookTriggerDispatchContext {
  subscriptionId: string;
  workspaceId: string;
  workflowId: string;
  app: string;
  triggerId: string;
  eventId: string;
  providerEventId: string;
  payload: unknown;
  eventPayload: unknown;
  rawBody: string;
  headers: Record<string, string>;
}

export interface WebhookGatewayTelemetryEvent {
  type: "trigger.fired" | "webhook.unsigned_accepted";
  kind: "trigger.fired" | "webhook.unsigned_accepted";
  subscriptionId: string;
  workflowId: string;
  workspaceId: string;
  app: string;
  triggerId: string;
  eventId: string;
  providerEventId: string;
  runId: string;
  timestamp: string;
}

export interface WebhookGatewayAdapter {
  nowSeconds?: () => number;
  connKey?: string;
  integrations?: Record<string, { manifest: IntegrationManifestFile }>;
  schemes?: Record<string, WebhookSignatureScheme>;
  onTriggerWorkflow?: (
    ctx: WebhookTriggerDispatchContext,
  ) => Promise<{ runId?: string } | void> | { runId?: string } | void;
  onTelemetryEvent?: (event: WebhookGatewayTelemetryEvent) => Promise<void> | void;
  onEmitTelemetry?: (event: WebhookGatewayTelemetryEvent) => Promise<void> | void;
}

const MAX_PAYLOAD_STORE_BYTES = 16384; // 16KB max stored in D1

function extractByDotPath(obj: unknown, dotPath: string | null | undefined): string | null {
  if (!dotPath || !dotPath.trim()) return null;
  const cleaned = dotPath.trim().replace(/^\$\.?/, "");
  const parts = cleaned.split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (part === "__proto__" || part === "constructor" || part === "prototype") return null;
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur === "string" && cur.trim().length > 0) return cur.trim();
  if (typeof cur === "number" && Number.isFinite(cur)) return String(cur);
  return null;
}

function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  headerName: string,
): string | undefined {
  const lower = headerName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower && typeof v === "string" && v.trim().length > 0) {
      return v;
    }
  }
  return undefined;
}

export interface WebhookServiceOptions {
  rotationGraceHours?: number;
  allowUnsignedForDev?: boolean;
}

export class WebhookService {
  private readonly db: D1Like;
  private readonly rotationGraceHours: number;
  readonly allowUnsignedForDev: boolean;
  private readonly subscriptionSchemes = new Map<string, WebhookSignatureScheme>();
  private static readonly globalSubscriptionSchemes = new Map<string, WebhookSignatureScheme>();

  constructor(
    db: D1Like,
    optionsOrGrace: number | WebhookServiceOptions = 24,
    allowUnsignedForDev = false,
  ) {
    this.db = db;
    if (typeof optionsOrGrace === "number") {
      this.rotationGraceHours = optionsOrGrace;
      this.allowUnsignedForDev = allowUnsignedForDev;
    } else {
      this.rotationGraceHours = optionsOrGrace?.rotationGraceHours ?? 24;
      this.allowUnsignedForDev = optionsOrGrace?.allowUnsignedForDev ?? allowUnsignedForDev;
    }
  }

  /**
   * Creates or updates a Case A webhook subscription (`wh_subscriptions`).
   */
  async registerSubscription(
    input: CreateSubscriptionInput,
  ): Promise<WebhookSubscriptionRecord> {
    const id = input.id?.trim() || `whsub_${crypto.randomUUID().replace(/-/g, "")}`;
    const workspaceId = input.workspaceId?.trim() || "default";

    let rawScheme =
      input.scheme ??
      (typeof input.verifier === "object"
        ? input.verifier
        : typeof input.verificationScheme === "object"
          ? input.verificationScheme
          : undefined);

    const verifierInput =
      typeof input.verifier === "string"
        ? input.verifier
        : typeof input.verificationScheme === "string"
          ? input.verificationScheme
          : undefined;

    let resolvedScheme: WebhookSignatureScheme | undefined;
    let schemeJson: string;

    if (rawScheme) {
      const parsed = WebhookSignatureSchemeSchema.safeParse(rawScheme);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        const path = firstIssue ? firstIssue.path.join(".") : "scheme";
        const err = new Error(`WEBHOOK_SCHEME_INVALID: ${path}`);
        (err as any).code = "WEBHOOK_SCHEME_INVALID";
        (err as any).path = path;
        (err as any).issues = parsed.error.issues;
        throw err;
      }
      resolvedScheme = parsed.data;
      schemeJson = JSON.stringify(resolvedScheme);
    } else if (verifierInput) {
      if (verifierInput === "none") {
        if (!this.allowUnsignedForDev) {
          const err = new Error("WEBHOOK_VERIFIER_NONE_FORBIDDEN");
          (err as any).code = "WEBHOOK_VERIFIER_NONE_FORBIDDEN";
          throw err;
        }
        schemeJson = JSON.stringify({ preset: "none" });
      } else if (verifierInput === "shared-secret") {
        const sigHdr = input.signatureHeader?.trim() || "X-Webhook-Secret";
        schemeJson = JSON.stringify({
          preset: "shared-secret",
          ...(sigHdr !== "X-Webhook-Secret" ? { signatureHeader: sigHdr } : {}),
        });
      } else {
        const preset = getPreset(verifierInput);
        if (preset) {
          const sigHdr = input.signatureHeader?.trim() || preset.signatureHeader;
          const candidateScheme = {
            ...preset,
            ...(sigHdr ? { signatureHeader: sigHdr } : {}),
          };
          const parsed = WebhookSignatureSchemeSchema.safeParse(candidateScheme);
          if (!parsed.success) {
            const firstIssue = parsed.error.issues[0];
            const path = firstIssue ? firstIssue.path.join(".") : "scheme";
            const err = new Error(`WEBHOOK_SCHEME_INVALID: ${path}`);
            (err as any).code = "WEBHOOK_SCHEME_INVALID";
            (err as any).path = path;
            (err as any).issues = parsed.error.issues;
            throw err;
          }
          resolvedScheme = parsed.data;
          schemeJson = JSON.stringify({
            preset: verifierInput,
            ...(input.signatureHeader?.trim() && input.signatureHeader.trim() !== preset.signatureHeader
              ? { signatureHeader: input.signatureHeader.trim() }
              : {}),
          });
        } else {
          schemeJson = JSON.stringify({
            preset: verifierInput,
            ...(input.signatureHeader?.trim() ? { signatureHeader: input.signatureHeader.trim() } : {}),
          });
        }
      }
    } else {
      const defaultPresetKey = "hmac-sha256";
      const preset = PRESETS[defaultPresetKey]!;
      resolvedScheme = preset;
      schemeJson = JSON.stringify({ preset: defaultPresetKey });
    }

    if (resolvedScheme) {
      this.subscriptionSchemes.set(id, resolvedScheme);
      WebhookService.globalSubscriptionSchemes.set(id, resolvedScheme);
    }

    const verifier: string =
      verifierInput ??
      (rawScheme ? rawScheme.algorithm : "hmac-sha256");

    const signatureHeader =
      input.signatureHeader?.trim() ||
      resolvedScheme?.signatureHeader ||
      getDefaultSignatureHeader(verifierInput, rawScheme);

    const eventIdPath = input.eventIdPath === null ? null : (input.eventIdPath ?? "id");
    const enabled = input.enabled !== false;
    const now = new Date().toISOString();
    const s = scoped(this.db, workspaceId);

    const existing = await s.first<WebhookSubscriptionRecord>(
      "wh_subscriptions",
      "id = ?",
      [id]
    );

    const baseRow: Record<string, unknown> = {
      workflow_id: input.workflowId,
      connection_ref: input.connectionRef ?? null,
      app: input.app,
      trigger_id: input.triggerId,
      verifier,
      signature_header: signatureHeader,
      event_id_path: eventIdPath,
      signing_secret: input.signingSecret ?? null,
      enabled: enabled ? 1 : 0,
    };

    if (existing) {
      try {
        await s.update(
          "wh_subscriptions",
          {
            ...baseRow,
            scheme_json: schemeJson,
            disabled_reason: null,
          },
          "id = ?",
          [id]
        );
      } catch (err: any) {
        if (err?.message?.includes("no column named scheme_json")) {
          const fallbackVerifier = mapToDbVerifier(verifierInput, rawScheme);
          await s.update(
            "wh_subscriptions",
            { ...baseRow, verifier: fallbackVerifier },
            "id = ?",
            [id]
          );
        } else {
          throw err;
        }
      }
    } else {
      try {
        await s.insert("wh_subscriptions", {
          id,
          ...baseRow,
          created_at: now,
          scheme_json: schemeJson,
          disabled_reason: null,
        });
      } catch (err: any) {
        if (err?.message?.includes("no column named scheme_json")) {
          const fallbackVerifier = mapToDbVerifier(verifierInput, rawScheme);
          await s.insert("wh_subscriptions", {
            id,
            ...baseRow,
            verifier: fallbackVerifier,
            created_at: now,
          });
        } else {
          throw err;
        }
      }
    }

    return {
      id,
      workspace_id: workspaceId,
      workflow_id: input.workflowId,
      connection_ref: input.connectionRef ?? null,
      app: input.app,
      trigger_id: input.triggerId,
      verifier,
      signature_header: signatureHeader,
      event_id_path: eventIdPath,
      signing_secret: input.signingSecret ?? null,
      enabled,
      created_at: now,
      scheme_json: schemeJson,
      disabled_reason: null,
    };
  }

  async getSubscription(subscriptionId: string): Promise<WebhookSubscriptionRecord | null> {
    interface SubRow {
      id: string;
      workspace_id: string;
      workflow_id: string;
      connection_ref: string | null;
      app: string;
      trigger_id: string;
      verifier: string;
      signature_header: string;
      event_id_path: string | null;
      signing_secret: string | null;
      enabled: number;
      created_at: string;
      scheme_json?: string;
      disabled_reason?: string | null;
    }

    const sys = systemScope(this.db, "inbound webhook subscription lookup by public subscription id");
    const row = await sys.first<SubRow>(
      "wh_subscriptions",
      "id = ?",
      [subscriptionId]
    );

    if (!row) return null;
    return {
      ...row,
      enabled: row.enabled === 1,
      scheme_json: row.scheme_json,
      disabled_reason: row.disabled_reason ?? null,
    };
  }

  /**
   * Ingests an inbound webhook for `/api/webhooks/in/:subscriptionId` (AD-S20):
   * 1. Looks up `subscriptionId` in `wh_subscriptions`.
   * 2. Unseals signing secret from `px_connections` (`PX_CONN_KEY`) or subscription's `signing_secret`.
   * 3. Verifies signature using configured scheme or preset, or shared-secret.
   * 4. Deduplicates by `(subscription_id, provider_event_id)` in `px_webhook_deliveries`.
   * 5. Starts bound `GraphWorkflow` and emits `trigger.fired` telemetry on novel deliveries.
   */
  async ingestSubscriptionWebhook(
    subscriptionId: string,
    rawBody: string,
    headers: Record<string, string>,
    options: {
      connKey?: string;
      adapter?: WebhookGatewayAdapter;
    } = {},
  ): Promise<
    | {
        ok: true;
        status: 200;
        received: true;
        deduplicated: boolean;
        subscriptionId: string;
        eventId: string;
        workflowId: string;
        runId: string | null;
      }
    | {
        ok: false;
        status: 401 | 404 | 500;
        error: string;
        reason?: string;
      }
  > {
    const subscription = await this.getSubscription(subscriptionId);
    if (!subscription) {
      return {
        ok: false,
        status: 404,
        error: "Webhook subscription not found",
      };
    }

    if (subscription.disabled_reason) {
      return {
        ok: false,
        status: 401,
        error: subscription.disabled_reason,
        reason: subscription.disabled_reason,
      };
    }

    if (!subscription.enabled) {
      return {
        ok: false,
        status: 404,
        error: "Webhook subscription not found or disabled",
      };
    }

    const effectiveConnKey = options.connKey ?? options.adapter?.connKey;
    let resolvedSecret: string | null = subscription.signing_secret;

    if (subscription.connection_ref) {
      const sys = systemScope(this.db, "unseal webhook signing secret from px_connections");
      const connRow = await sys.first<{ ciphertext_b64: string; iv_b64: string; status: string }>(
        "px_connections",
        "ref = ?",
        [subscription.connection_ref]
      );

      if (connRow && connRow.status !== "revoked") {
        try {
          const unsealed = await unsealPxConnectionSecret(
            connRow.ciphertext_b64,
            connRow.iv_b64,
            effectiveConnKey,
          );
          if (unsealed) {
            resolvedSecret = unsealed;
          }
        } catch {
          return {
            ok: false,
            status: 401,
            error: "Failed to unseal webhook signing secret for subscription",
          };
        }
      }
    }

    let scheme: WebhookSignatureScheme | undefined =
      this.subscriptionSchemes.get(subscription.id) ??
      WebhookService.globalSubscriptionSchemes.get(subscription.id);

    if (!scheme && subscription.scheme_json) {
      try {
        const parsed = JSON.parse(subscription.scheme_json);
        if (parsed.preset) {
          if (parsed.preset !== "shared-secret" && parsed.preset !== "none") {
            const basePreset = getPreset(parsed.preset);
            if (basePreset) {
              const { preset: _p, ...overrides } = parsed;
              scheme = { ...basePreset, ...overrides };
            }
          }
        } else if (parsed.algorithm) {
          scheme = parsed as WebhookSignatureScheme;
        }
      } catch {
        // ignore parse error, fallback
      }
    }

    if (!scheme) {
      scheme = getPreset(subscription.verifier);
    }

    if (
      subscription.verifier === "none" ||
      (subscription.scheme_json && subscription.scheme_json.includes('"preset":"none"'))
    ) {
      if (!this.allowUnsignedForDev) {
        return {
          ok: false,
          status: 401,
          error: "WEBHOOK_VERIFIER_NONE_FORBIDDEN",
        };
      }
    } else {
      if (!resolvedSecret) {
        return {
          ok: false,
          status: 401,
          error: "Missing webhook signing secret for subscription",
        };
      }

      const integrations =
        options.adapter?.integrations ??
        (catalog.integrations as Record<string, { manifest: IntegrationManifestFile }> | undefined);
      const manifest = integrations?.[subscription.app]?.manifest;
      const trigger = manifest?.triggers?.find((t) => t.id === subscription.trigger_id);

      if (options.adapter?.integrations && trigger?.verifier) {
        scheme =
          typeof trigger.verifier === "object"
            ? (trigger.verifier as WebhookSignatureScheme)
            : getPreset(trigger.verifier) ?? scheme;
      }

      if (!scheme) {
        if (trigger && typeof trigger.verifier === "object") {
          scheme = trigger.verifier as WebhookSignatureScheme;
        } else if (trigger && typeof trigger.verifier === "string" && getPreset(trigger.verifier)) {
          scheme = getPreset(trigger.verifier);
        } else if (options.adapter?.schemes?.[subscription.verifier]) {
          scheme = options.adapter.schemes[subscription.verifier];
        } else if (getPreset(subscription.verifier)) {
          scheme = getPreset(subscription.verifier);
        } else if (subscription.verifier === "hmac-sha256") {
          const sigHeaderName = subscription.signature_header || "x-hub-signature-256";
          const rawSig = getHeaderCaseInsensitive(headers, sigHeaderName) ?? "";
          const detectedPrefix = rawSig.startsWith("sha256=")
            ? "sha256="
            : rawSig.startsWith("v0=")
              ? "v0="
              : undefined;
          scheme = {
            algorithm: "hmac-sha256",
            signedPayload: "{body}",
            signatureHeader: sigHeaderName,
            encoding: "hex",
            prefix: detectedPrefix,
          };
        } else if (subscription.verifier === "ed25519") {
          const sigHeaderName =
            subscription.signature_header || "x-signature-ed25519";
          const hasTimestamp = Boolean(
            getHeaderCaseInsensitive(headers, "x-signature-timestamp"),
          );
          scheme = {
            algorithm: "ed25519",
            signedPayload: hasTimestamp ? "{timestamp}{body}" : "{body}",
            signatureHeader: sigHeaderName,
            ...(hasTimestamp ? { timestampHeader: "x-signature-timestamp" } : {}),
            encoding: "hex",
          };
        }

        if (scheme && subscription.signature_header && scheme.signatureHeader !== subscription.signature_header) {
          scheme = { ...scheme, signatureHeader: subscription.signature_header };
        }
      }

      if (scheme) {
        if (
          scheme.algorithm === "ed25519" &&
          scheme.timestampHeader &&
          !getHeaderCaseInsensitive(headers, scheme.timestampHeader)
        ) {
          scheme = {
            ...scheme,
            signedPayload: "{body}",
            timestampHeader: undefined,
            toleranceSec: undefined,
          };
        }

        const nowSec = options.adapter?.nowSeconds
          ? options.adapter.nowSeconds()
          : Math.floor(Date.now() / 1000);
        const schemeResult = await verifyWithScheme(
          scheme,
          { rawBody, headers },
          resolvedSecret,
          nowSec,
        );
        if (!schemeResult.ok) {
          // If default hmac-sha256 scheme failed with malformed due to prefix, try without prefix for raw hex callers
          if (
            subscription.verifier === "hmac-sha256" &&
            schemeResult.reason === "WEBHOOK_SIGNATURE_MALFORMED" &&
            scheme.prefix
          ) {
            const fallbackScheme = { ...scheme, prefix: undefined };
            const fallbackResult = await verifyWithScheme(
              fallbackScheme,
              { rawBody, headers },
              resolvedSecret,
              nowSec,
            );
            if (!fallbackResult.ok) {
              return {
                ok: false,
                status: 401,
                error: fallbackResult.reason,
                reason: fallbackResult.reason,
              };
            }
          } else {
            return {
              ok: false,
              status: 401,
              error: schemeResult.reason,
              reason: schemeResult.reason,
            };
          }
        }
      } else if (
        subscription.verifier === "shared-secret" ||
        (subscription.scheme_json && subscription.scheme_json.includes('"shared-secret"'))
      ) {
        const sigHeaderVal =
          getHeaderCaseInsensitive(headers, subscription.signature_header) ??
          getHeaderCaseInsensitive(headers, "x-webhook-secret");

        if (!sigHeaderVal) {
          return {
            ok: false,
            status: 401,
            error: `Missing required signature header "${subscription.signature_header}"`,
            reason: "WEBHOOK_SIGNATURE_HEADER_MISSING",
          };
        }

        const validShared = verifySharedSecret(sigHeaderVal, resolvedSecret);
        if (!validShared) {
          return {
            ok: false,
            status: 401,
            error: "Invalid webhook shared secret",
            reason: "WEBHOOK_SIGNATURE_MISMATCH",
          };
        }
      }
    }

    let parsedPayload: unknown = rawBody;
    try {
      parsedPayload = rawBody.trim().length > 0 ? JSON.parse(rawBody) : {};
    } catch {
      parsedPayload = { rawBody };
    }

    const dotPathId = subscription.event_id_path
      ? extractByDotPath(parsedPayload, subscription.event_id_path)
      : null;

    const headerDeliveryId =
      getHeaderCaseInsensitive(headers, "x-webhook-delivery") ??
      getHeaderCaseInsensitive(headers, "x-delivery-id") ??
      getHeaderCaseInsensitive(headers, "x-event-id") ??
      getHeaderCaseInsensitive(headers, "x-request-id");

    const sigHeaderName =
      scheme?.signatureHeader ||
      subscription.signature_header ||
      "x-hub-signature-256";
    const sigHeaderVal =
      getHeaderCaseInsensitive(headers, sigHeaderName) ??
      getHeaderCaseInsensitive(headers, "x-signature-ed25519") ??
      getHeaderCaseInsensitive(headers, "x-signature") ??
      getHeaderCaseInsensitive(headers, "x-hub-signature-256") ??
      "";

    let extractedId: string;
    if (dotPathId && String(dotPathId).trim()) {
      extractedId = String(dotPathId).trim();
    } else if (headerDeliveryId && headerDeliveryId.trim()) {
      extractedId = headerDeliveryId.trim();
    } else {
      // When no provider event id is found, use sig: + sha256Hex(signatureHeaderValue)
      const sigHash = await sha256HexString(sigHeaderVal || rawBody);
      extractedId = `sig:${sigHash}`;
    }

    const s = scoped(this.db, subscription.workspace_id);

    // Check deduplication in px_webhook_deliveries
    const existingDelivery = await s.first<{ id: string; run_id: string | null }>(
      "px_webhook_deliveries",
      "subscription_id = ? AND provider_event_id = ?",
      [subscription.id, extractedId]
    );

    if (existingDelivery) {
      return {
        ok: true,
        status: 200,
        received: true,
        deduplicated: true,
        subscriptionId: subscription.id,
        eventId: extractedId,
        workflowId: subscription.workflow_id,
        runId: existingDelivery.run_id,
      };
    }

    const deliveryId = `pxwhd_${crypto.randomUUID().replace(/-/g, "")}`;
    const nowIso = new Date().toISOString();
    let runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Insert delivery record first with UNIQUE(subscription_id, provider_event_id)
    try {
      await s.insert("px_webhook_deliveries", {
        id: deliveryId,
        subscription_id: subscription.id,
        provider_event_id: extractedId,
        workflow_id: subscription.workflow_id,
        run_id: runId,
        status: "processed",
        received_at: nowIso,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE")) {
        return {
          ok: true,
          status: 200,
          received: true,
          deduplicated: true,
          subscriptionId: subscription.id,
          eventId: extractedId,
          workflowId: subscription.workflow_id,
          runId: null,
        };
      }
      throw err;
    }

    if (options.adapter?.onTriggerWorkflow) {
      const triggerRes = await options.adapter.onTriggerWorkflow({
        subscriptionId: subscription.id,
        workspaceId: subscription.workspace_id,
        workflowId: subscription.workflow_id,
        app: subscription.app,
        triggerId: subscription.trigger_id,
        eventId: extractedId,
        providerEventId: extractedId,
        payload: parsedPayload,
        eventPayload: parsedPayload,
        rawBody,
        headers,
      });
      if (triggerRes && typeof triggerRes.runId === "string" && triggerRes.runId) {
        runId = triggerRes.runId;
        await s.update(
          "px_webhook_deliveries",
          { run_id: runId },
          "id = ?",
          [deliveryId]
        );
      }
    }

    const telemetryEvt: WebhookGatewayTelemetryEvent = {
      type: "trigger.fired",
      kind: "trigger.fired",
      subscriptionId: subscription.id,
      workflowId: subscription.workflow_id,
      workspaceId: subscription.workspace_id,
      app: subscription.app,
      triggerId: subscription.trigger_id,
      eventId: extractedId,
      providerEventId: extractedId,
      runId,
      timestamp: nowIso,
    };
    if (options.adapter?.onTelemetryEvent) {
      await options.adapter.onTelemetryEvent(telemetryEvt);
    }
    if (options.adapter?.onEmitTelemetry) {
      await options.adapter.onEmitTelemetry(telemetryEvt);
    }

    if (subscription.verifier === "none" && this.allowUnsignedForDev) {
      const warningEvt: WebhookGatewayTelemetryEvent = {
        type: "webhook.unsigned_accepted",
        kind: "webhook.unsigned_accepted",
        subscriptionId: subscription.id,
        workflowId: subscription.workflow_id,
        workspaceId: subscription.workspace_id,
        app: subscription.app,
        triggerId: subscription.trigger_id,
        eventId: extractedId,
        providerEventId: extractedId,
        runId,
        timestamp: nowIso,
      };
      if (options.adapter?.onTelemetryEvent) {
        await options.adapter.onTelemetryEvent(warningEvt);
      }
      if (options.adapter?.onEmitTelemetry) {
        await options.adapter.onEmitTelemetry(warningEvt);
      }
    }

    // Also record trigger.fired in px_logs if telemetry table is present
    try {
      await this.db
        .prepare(
          `INSERT INTO px_logs (
            id, timestamp, level, message, brick_id, workflow_id, run_id, node_id, workspace_id, px_env, data_json
          ) VALUES (?, ?, 'info', ?, 'webhook-gateway', ?, ?, ?, ?, 'preview', ?)`,
        )
        .bind(
          `log_trig_${deliveryId}`,
          nowIso,
          `trigger.fired: Inbound webhook ${subscription.app}.${subscription.trigger_id} (${extractedId}) started workflow ${subscription.workflow_id}`,
          subscription.workflow_id,
          runId,
          subscription.trigger_id,
          subscription.workspace_id,
          JSON.stringify({
            event: "trigger.fired",
            subscriptionId: subscription.id,
            app: subscription.app,
            triggerId: subscription.trigger_id,
            eventId: extractedId,
            workflowId: subscription.workflow_id,
            runId,
          }),
        )
        .run();
    } catch {
      // Ignore if px_logs table does not exist in standalone brick unit test DB
    }

    return {
      ok: true,
      status: 200,
      received: true,
      deduplicated: false,
      subscriptionId: subscription.id,
      eventId: extractedId,
      workflowId: subscription.workflow_id,
      runId,
    };
  }

  /**
   * Creates a new webhook ingress endpoint.
   */
  async createEndpoint(
    workspaceId: string,
    nameRaw: string,
    slugRaw: string,
    options: { targetWorkflowId?: string; customSecret?: string } = {},
  ): Promise<{ ok: true; endpoint: EndpointRecord } | { ok: false; error: string; code: number }> {
    const name = nameRaw.trim();
    if (!name || name.length > 100) {
      return { ok: false, error: "Endpoint name must be between 1 and 100 characters", code: 400 };
    }

    const slug = slugRaw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!slug || slug.length > 64) {
      return { ok: false, error: "Slug must be alphanumeric (up to 64 chars)", code: 400 };
    }

    const id = `whe_${crypto.randomUUID().replace(/-/g, "")}`;
    const secret = options.customSecret || generateWebhookSecret();
    const now = new Date().toISOString();
    const s = scoped(this.db, workspaceId);

    try {
      await s.insert("wh_endpoints", {
        id,
        name,
        slug,
        signing_secret: secret,
        target_workflow_id: options.targetWorkflowId || null,
        active: 1,
        created_at: now,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE")) {
        return { ok: false, error: "An endpoint with this slug already exists", code: 409 };
      }
      return { ok: false, error: `Failed to create endpoint: ${msg}`, code: 500 };
    }

    return {
      ok: true,
      endpoint: {
        id,
        workspace_id: workspaceId,
        name,
        slug,
        signing_secret: secret,
        previous_secret: null,
        previous_secret_expires_at: null,
        target_workflow_id: options.targetWorkflowId || null,
        active: true,
        created_at: now,
      },
    };
  }

  /**
   * Retrieves an endpoint by ID or slug scoped to workspace.
   */
  async getEndpoint(workspaceId: string, idOrSlug: string): Promise<EndpointRecord | null> {
    interface Row {
      id: string;
      workspace_id: string;
      name: string;
      slug: string;
      signing_secret: string;
      previous_secret: string | null;
      previous_secret_expires_at: string | null;
      target_workflow_id: string | null;
      active: number;
      created_at: string;
    }

    const s = scoped(this.db, workspaceId);
    const row = await s.first<Row>(
      "wh_endpoints",
      "(id = ? OR slug = ?)",
      [idOrSlug, idOrSlug]
    );

    if (!row) return null;
    return {
      ...row,
      active: row.active === 1,
    };
  }

  /**
   * Lists endpoints in a workspace.
   */
  async listEndpoints(workspaceId: string): Promise<EndpointRecord[]> {
    interface Row {
      id: string;
      workspace_id: string;
      name: string;
      slug: string;
      signing_secret: string;
      previous_secret: string | null;
      previous_secret_expires_at: string | null;
      target_workflow_id: string | null;
      active: number;
      created_at: string;
    }

    const s = scoped(this.db, workspaceId);
    const rows = await s.select<Row>(
      "wh_endpoints",
      undefined,
      [],
      { orderBy: "created_at DESC" }
    );

    return rows.map((r) => ({
      ...r,
      active: r.active === 1,
    }));
  }

  /**
   * Rotates an endpoint's signing secret gracefully, preserving the previous secret for a grace period.
   */
  async rotateSecret(
    workspaceId: string,
    endpointId: string,
  ): Promise<{ ok: true; newSecret: string; expiresAt: string } | { ok: false; error: string }> {
    const endpoint = await this.getEndpoint(workspaceId, endpointId);
    if (!endpoint) return { ok: false, error: "Endpoint not found" };

    const newSecret = generateWebhookSecret();
    const expiresAt = new Date(Date.now() + this.rotationGraceHours * 3600 * 1000).toISOString();
    const s = scoped(this.db, workspaceId);

    await s.update(
      "wh_endpoints",
      {
        signing_secret: newSecret,
        previous_secret: endpoint.signing_secret,
        previous_secret_expires_at: expiresAt,
      },
      "id = ?",
      [endpoint.id]
    );

    return { ok: true, newSecret, expiresAt };
  }

  /**
   * Ingests an inbound webhook by slug, verifies HMAC-SHA256 signature, logs delivery, and triggers downstream workflow.
   */
  async ingestWebhook(
    slug: string,
    payloadText: string,
    headers: Record<string, string>,
    signatureHeader?: string,
  ): Promise<{ ok: true; deliveryId: string; status: number } | { ok: false; error: string; status: number }> {
    const startTime = Date.now();

    interface IngestRow {
      id: string;
      workspace_id: string;
      signing_secret: string;
      previous_secret: string | null;
      previous_secret_expires_at: string | null;
      target_workflow_id: string | null;
      active: number;
    }

    const sys = systemScope(this.db, "inbound webhook endpoint lookup by public slug");
    const endpoint = await sys.first<IngestRow>(
      "wh_endpoints",
      "slug = ?",
      [slug.toLowerCase().trim()]
    );

    if (!endpoint || endpoint.active !== 1) {
      return { ok: false, error: "Webhook endpoint not found or inactive", status: 404 };
    }

    // Verify signature
    let verified = false;
    if (signatureHeader) {
      const prefix = signatureHeader.startsWith("sha256=")
        ? "sha256="
        : signatureHeader.startsWith("v0=")
          ? "v0="
          : undefined;
      const scheme: WebhookSignatureScheme = {
        algorithm: "hmac-sha256",
        signedPayload: "{body}",
        signatureHeader: "x-signature",
        encoding: "hex",
        ...(prefix ? { prefix } : {}),
      };

      const verifyRes = await verifyWithScheme(
        scheme,
        { rawBody: payloadText, headers: { "x-signature": signatureHeader } },
        endpoint.signing_secret,
      );
      verified = verifyRes.ok;

      // If not verified with current, check previous secret if within grace period
      if (!verified && endpoint.previous_secret && endpoint.previous_secret_expires_at) {
        if (new Date(endpoint.previous_secret_expires_at).getTime() > Date.now()) {
          const prevRes = await verifyWithScheme(
            scheme,
            { rawBody: payloadText, headers: { "x-signature": signatureHeader } },
            endpoint.previous_secret,
          );
          verified = prevRes.ok;
        }
      }
    }

    // An unsigned or badly signed call is refused before anything is stored: anyone can reach this public route, so
    // writing a delivery row first would let them fill any workspace's table (story 0.6).
    if (!verified && !this.allowUnsignedForDev) {
      return { ok: false, error: "Invalid webhook HMAC signature", status: 401 };
    }

    const statusCode = 200;
    const durationMs = Date.now() - startTime;
    const deliveryId = `whd_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    // Check payload length and truncate if needed to prevent D1 exhaustion
    const isTruncated = payloadText.length > MAX_PAYLOAD_STORE_BYTES;
    const storedPayload = isTruncated
      ? payloadText.substring(0, MAX_PAYLOAD_STORE_BYTES)
      : payloadText;

    const s = scoped(this.db, endpoint.workspace_id);
    await s.insert("wh_deliveries", {
      id: deliveryId,
      endpoint_id: endpoint.id,
      status_code: statusCode,
      headers_json: JSON.stringify(headers),
      payload_text: storedPayload,
      payload_truncated: isTruncated ? 1 : 0,
      signature_verified: verified ? 1 : 0,
      received_at: now,
      duration_ms: durationMs,
    });

    return { ok: true, deliveryId, status: 200 };
  }

  /**
   * Lists deliveries for an endpoint.
   */
  async listDeliveries(
    workspaceId: string,
    endpointId?: string,
    limit = 50,
  ): Promise<DeliveryRecord[]> {
    interface Row {
      id: string;
      endpoint_id: string;
      workspace_id: string;
      status_code: number;
      headers_json: string | null;
      payload_text: string | null;
      payload_truncated: number;
      signature_verified: number;
      received_at: string;
      duration_ms: number;
    }

    const s = scoped(this.db, workspaceId);
    const rows = await s.select<Row>(
      "wh_deliveries",
      endpointId ? "endpoint_id = ?" : undefined,
      endpointId ? [endpointId] : [],
      { orderBy: "received_at DESC", limit }
    );

    return rows.map((r) => ({
      ...r,
      payload_truncated: r.payload_truncated === 1,
      signature_verified: r.signature_verified === 1,
    }));
  }
}
