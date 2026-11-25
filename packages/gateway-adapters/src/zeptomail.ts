import type { ChannelCredentials, DeliveryAdapter, DeliveryChannel, DeliveryResult, OutboundMessage } from "@poc/sdk";
import { guardedFetch, isRetryableResponse, nonEmpty, retryAfterMs, thrownErrorCode } from "./delivery-http.ts";
import type { DeliveryAdapterHttpOptions } from "./delivery-http.ts";

/**
 * ZeptoMail (Zoho's transactional email API) behind the provider-neutral `DeliveryAdapter` (story 2.4).
 *
 * Channel config (non-secret, on the channel): `region`, the API domain's suffix ("com", "in", "eu", ...): required,
 * no default. Optional `fromName` and `bodyFormat` ("text", the default, or "html").
 * Channel credentials (sealed by the brick): `apiKey`, the Send Mail token (with or without its "Zoho-enczapikey "
 * prefix).
 *
 * Sender verification is "code": ZeptoMail has no API that says whether an address belongs to a token, so the brick
 * mails a one-time code to the sender address. ZeptoMail delivery webhooks are not handled (see the README): a
 * dispatch stays `sent`.
 */
export type ZeptoMailAdapterOptions = DeliveryAdapterHttpOptions;

const REGION = /^[a-z]{2,3}(?:\.[a-z]{2,3})?$/;
const AUTH_PREFIX = "Zoho-enczapikey ";
const ERROR_CODE = /^[A-Z]{2,4}_\d{2,6}$/;
const HEADER_BREAK = /[\r\n\0]/;

function failed(error: string, retryable: boolean, retryAfter?: number): DeliveryResult {
  return { status: "failed", error, retryable, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
}

export function createZeptoMailAdapter(options: ZeptoMailAdapterOptions = {}): DeliveryAdapter {
  const guarded = guardedFetch(options);

  function checkConfig(channel: Pick<DeliveryChannel, "channel_type" | "config">): string | null {
    if (channel.channel_type !== "email") return "the ZeptoMail adapter sends email only";
    const region = channel.config.region;
    if (typeof region !== "string" || !REGION.test(region)) return 'config.region is required (the ZeptoMail API domain suffix, e.g. "com", "in", "eu")';
    const format = channel.config.bodyFormat;
    if (format !== undefined && format !== "text" && format !== "html") return 'config.bodyFormat must be "text" or "html"';
    const fromName = channel.config.fromName;
    if (fromName !== undefined && (typeof fromName !== "string" || fromName.length > 128 || HEADER_BREAK.test(fromName))) {
      return "config.fromName must be a string of at most 128 characters without CR, LF or NUL";
    }
    return null;
  }

  function requestBody(channel: DeliveryChannel, message: OutboundMessage): Record<string, unknown> {
    const fromName = typeof channel.config.fromName === "string" && channel.config.fromName.length > 0 ? channel.config.fromName : undefined;
    const base = {
      from: { address: channel.sender_address, ...(fromName ? { name: fromName } : {}) },
      to: [{ email_address: { address: message.recipient } }],
    };
    if (message.template) {
      return {
        ...base,
        mail_template_key: message.template.name,
        merge_info: { ...(message.template.variables ?? {}) },
        ...(message.subject ? { subject: message.subject } : {}),
      };
    }
    const html = channel.config.bodyFormat === "html";
    return { ...base, subject: message.subject ?? "", ...(html ? { htmlbody: message.body } : { textbody: message.body }) };
  }

  return {
    checkConfig,

    async send(channel: DeliveryChannel, message: OutboundMessage, credentials: ChannelCredentials): Promise<DeliveryResult> {
      if (checkConfig(channel) !== null) return failed("ZEPTOMAIL_NOT_CONFIGURED", false);
      const apiKey = credentials.apiKey;
      if (!nonEmpty(apiKey)) return failed("ZEPTOMAIL_NOT_CONFIGURED", false);
      const token = apiKey.trim();
      const url = `https://api.zeptomail.${channel.config.region as string}/v1.1/email${message.template ? "/template" : ""}`;
      let response: Response;
      let body: Record<string, unknown> | null;
      try {
        ({ response, body } = await guarded(url, {
          method: "POST",
          headers: {
            authorization: token.startsWith(AUTH_PREFIX) ? token : `${AUTH_PREFIX}${token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(requestBody(channel, message)),
        }));
      } catch (error) {
        // Not retried: a timeout or reset may come after ZeptoMail accepted the message.
        return failed(thrownErrorCode("ZEPTOMAIL", error), false);
      }
      if (response.status >= 200 && response.status < 300) {
        // Only an accepted request that names its request_id counts as sent.
        const id = body?.request_id;
        if (nonEmpty(id) && id.length <= 255) return { status: "sent", externalId: id };
        return failed("ZEPTOMAIL_NO_REQUEST_ID", false);
      }
      const errorObject = body?.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : undefined;
      const code = typeof errorObject?.code === "string" && ERROR_CODE.test(errorObject.code) ? `_${errorObject.code}` : "";
      return failed(`ZEPTOMAIL_HTTP_${response.status}${code}`, isRetryableResponse(response), retryAfterMs(response.headers));
    },

    async verifySender() {
      return { method: "code" };
    },
  };
}
