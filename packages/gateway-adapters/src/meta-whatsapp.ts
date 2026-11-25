import type {
  ChannelCredentials,
  DeliveryAdapter,
  DeliveryChannel,
  DeliveryResult,
  DeliveryStatus,
  OutboundMessage,
  SenderVerification,
  StatusWebhookResult,
} from "@poc/sdk";
import { guardedFetch, isRetryableResponse, isUnavailableStatus, nonEmpty, retryAfterMs, thrownErrorCode } from "./delivery-http.ts";
import type { DeliveryAdapterHttpOptions } from "./delivery-http.ts";
import { constantTimeEqual, hmacSha256, toHex } from "./webhook-signature.ts";

/**
 * The Meta WhatsApp Cloud API behind the provider-neutral `DeliveryAdapter` (story 2.4).
 *
 * The channel's `sender_address` is the WhatsApp phone-number id (digits). Channel config (non-secret): `apiVersion`,
 * the Graph API version ("v21.0"): required, no default. Channel credentials (sealed by the brick): `accessToken` (a
 * system-user token), `appSecret` (signs the status webhooks; without it every webhook is refused) and `verifyToken`
 * (the value Meta echoes on the GET subscription check).
 *
 * Sender verification is "credential": `GET /<apiVersion>/<phone-number-id>` with the channel's token must answer with
 * that same id.
 */
export type MetaWhatsAppAdapterOptions = DeliveryAdapterHttpOptions;

const API_VERSION = /^v\d{1,3}\.\d{1,3}$/;
const PHONE_NUMBER_ID = /^\d{1,32}$/;
const GRAPH = "https://graph.facebook.com";
/**
 * Graph / WhatsApp error codes that say the request was refused unprocessed (throttling, service unavailable), so a
 * retry cannot send the message twice. Ambiguous ones (1 unknown, 2 service, 131000 something went wrong) are not here.
 */
const RETRYABLE_CODES = new Set([4, 17, 80007, 130429, 131016, 131056]);
const LANGUAGE = /^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})?$/;
const CHALLENGE = /^[A-Za-z0-9_-]{1,512}$/;

function failed(error: string, retryable: boolean, retryAfter?: number): DeliveryResult {
  return { status: "failed", error, retryable, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
}

/** Body parameters: numeric keys ("1", "2") are positional in key order; any other keys are named parameters. */
function bodyParameters(variables: Record<string, string>): Array<Record<string, string>> {
  const entries = Object.entries(variables);
  if (entries.every(([key]) => /^\d+$/.test(key))) {
    return entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, text]) => ({ type: "text", text }));
  }
  return entries.map(([parameter_name, text]) => ({ type: "text", parameter_name, text }));
}

export function createMetaWhatsAppAdapter(options: MetaWhatsAppAdapterOptions = {}): DeliveryAdapter {
  const guarded = guardedFetch(options);

  function checkConfig(channel: Pick<DeliveryChannel, "channel_type" | "sender_address" | "config">): string | null {
    if (channel.channel_type !== "whatsapp") return "the WhatsApp Cloud API adapter sends WhatsApp messages only";
    if (!PHONE_NUMBER_ID.test(channel.sender_address)) return "the sender address must be the WhatsApp phone-number id (digits)";
    const version = channel.config.apiVersion;
    if (typeof version !== "string" || !API_VERSION.test(version)) return 'config.apiVersion is required (the Graph API version, e.g. "v21.0")';
    const language = channel.config.defaultLanguage;
    if (language !== undefined && (typeof language !== "string" || !LANGUAGE.test(language))) return "config.defaultLanguage must look like en or en_US";
    return null;
  }

  const bearer = (credentials: ChannelCredentials): string | null =>
    nonEmpty(credentials.accessToken) ? `Bearer ${credentials.accessToken.trim()}` : null;

  return {
    checkConfig,

    async send(channel: DeliveryChannel, message: OutboundMessage, credentials: ChannelCredentials): Promise<DeliveryResult> {
      const auth = bearer(credentials);
      if (checkConfig(channel) !== null || !auth) return failed("META_NOT_CONFIGURED", false);
      const to = message.recipient.replace(/^\+/, "");
      let payload: Record<string, unknown>;
      if (message.template) {
        const language = message.template.language ?? (typeof channel.config.defaultLanguage === "string" ? channel.config.defaultLanguage : undefined);
        if (!nonEmpty(language)) return failed("META_TEMPLATE_LANGUAGE_REQUIRED", false);
        const variables = message.template.variables ?? {};
        payload = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "template",
          template: {
            name: message.template.name,
            language: { code: language },
            ...(Object.keys(variables).length > 0 ? { components: [{ type: "body", parameters: bodyParameters(variables) }] } : {}),
          },
        };
      } else {
        payload = { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: message.body } };
      }
      let response: Response;
      let body: Record<string, unknown> | null;
      try {
        ({ response, body } = await guarded(`${GRAPH}/${channel.config.apiVersion as string}/${channel.sender_address}/messages`, {
          method: "POST",
          headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload),
        }));
      } catch (error) {
        // Not retried: a timeout or reset may come after Meta accepted the message.
        return failed(thrownErrorCode("META", error), false);
      }
      if (response.status >= 200 && response.status < 300) {
        const messages = Array.isArray(body?.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
        const id = messages[0]?.id;
        if (nonEmpty(id) && id.length <= 255) return { status: "sent", externalId: id };
        return failed("META_NO_MESSAGE_ID", false);
      }
      const errorObject = body?.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : undefined;
      const code = typeof errorObject?.code === "number" && Number.isSafeInteger(errorObject.code) ? errorObject.code : undefined;
      const retryable = isRetryableResponse(response) || (code !== undefined && RETRYABLE_CODES.has(code));
      return failed(`META_HTTP_${response.status}${code !== undefined ? `_${code}` : ""}`, retryable, retryAfterMs(response.headers));
    },

    async verifySender(channel: DeliveryChannel, credentials: ChannelCredentials): Promise<SenderVerification> {
      const auth = bearer(credentials);
      if (checkConfig(channel) !== null || !auth) return { method: "credential", verified: false };
      try {
        const { response, body } = await guarded(`${GRAPH}/${channel.config.apiVersion as string}/${channel.sender_address}?fields=id`, {
          method: "GET",
          headers: { authorization: auth, accept: "application/json" },
        });
        if (response.status < 200 || response.status >= 300) {
          // 429 / 5xx: Meta could not answer now, which is not a "no".
          if (isUnavailableStatus(response.status)) return { method: "unavailable", error: `META_HTTP_${response.status}` };
          return { method: "credential", verified: false };
        }
        return { method: "credential", verified: body?.id === channel.sender_address };
      } catch (error) {
        return { method: "unavailable", error: thrownErrorCode("META", error) };
      }
    },

    // X-Hub-Signature-256: sha256=<hex HMAC-SHA256(rawBody, appSecret)>, compared in constant time. Only then is the body
    // read; only statuses for this channel's phone-number id are returned.
    async parseStatusWebhook(rawBody: string, headers: Headers, credentials: ChannelCredentials, channel: DeliveryChannel): Promise<StatusWebhookResult> {
      const secret = credentials.appSecret;
      const header = headers.get("x-hub-signature-256")?.trim();
      if (!nonEmpty(secret) || !header || !header.startsWith("sha256=")) return { kind: "invalid" };
      const expected = `sha256=${toHex(await hmacSha256(secret, rawBody))}`;
      if (!constantTimeEqual(header.toLowerCase(), expected)) return { kind: "invalid" };
      let event: { entry?: unknown };
      try {
        event = JSON.parse(rawBody) as { entry?: unknown };
      } catch {
        return { kind: "ignored" };
      }
      const updates: Array<{ externalId: string; status: DeliveryStatus; error?: string }> = [];
      for (const entry of Array.isArray(event?.entry) ? event.entry : []) {
        const changes = (entry as { changes?: unknown })?.changes;
        for (const change of Array.isArray(changes) ? changes : []) {
          const value = (change as { value?: Record<string, unknown> })?.value;
          const metadata = value?.metadata as { phone_number_id?: unknown } | undefined;
          if (!value || metadata?.phone_number_id !== channel.sender_address) continue;
          for (const s of Array.isArray(value.statuses) ? (value.statuses as Array<Record<string, unknown>>) : []) {
            if (!nonEmpty(s?.id) || s.id.length > 255) continue;
            if (s.status === "delivered" || s.status === "read") {
              updates.push({ externalId: s.id, status: s.status });
            } else if (s.status === "failed") {
              const first = Array.isArray(s.errors) ? (s.errors[0] as { code?: unknown } | undefined) : undefined;
              const code = typeof first?.code === "number" && Number.isSafeInteger(first.code) ? `_${first.code}` : "";
              updates.push({ externalId: s.id, status: "failed", error: `META_DELIVERY_FAILED${code}` });
            }
          }
        }
      }
      return updates.length > 0 ? { kind: "status", updates } : { kind: "ignored" };
    },

    // GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...: echo the challenge only for the channel's own token.
    answerWebhookChallenge(query: URLSearchParams, credentials: ChannelCredentials): string | null {
      const token = credentials.verifyToken;
      const given = query.get("hub.verify_token");
      const challenge = query.get("hub.challenge");
      if (query.get("hub.mode") !== "subscribe" || !nonEmpty(token) || given === null || challenge === null) return null;
      if (!constantTimeEqual(given, token) || !CHALLENGE.test(challenge)) return null;
      return challenge;
    },
  };
}
