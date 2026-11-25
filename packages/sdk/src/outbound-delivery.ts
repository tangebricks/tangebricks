/**
 * The provider-neutral outbound delivery contract (story 2.4). The omnichannel-outbound brick depends on this shape
 * only; each provider (ZeptoMail, the WhatsApp Cloud API, ...) is an adapter outside the brick, selected per channel by
 * the channel's `provider` string. Nothing here names a provider.
 */

/** What an adapter is told about the channel it sends through. Never holds a credential. */
export interface DeliveryChannel {
  id: string;
  workspace_id: string;
  channel_type: string;
  provider: string;
  /** The sender identity: an email address, a provider's phone-number id, ... */
  sender_address: string;
  /** Non-secret settings only (region, API version, ...). Secrets travel in `credentials`. */
  config: Record<string, unknown>;
}

/** A channel's secrets (API keys, tokens, app secrets), decrypted for the duration of one call. Never stored in clear. */
export type ChannelCredentials = Readonly<Record<string, string>>;

export interface OutboundTemplate {
  /** The provider's template name or key. */
  name: string;
  /** The template language (e.g. "en_US"), where the provider needs one. */
  language?: string;
  /** Values merged into the template. Numeric keys ("1", "2") are positional where the provider is positional. */
  variables?: Record<string, string>;
}

export interface OutboundMessage {
  /** Exactly one address or number. */
  recipient: string;
  subject?: string;
  body: string;
  template?: OutboundTemplate;
}

/**
 * What one send attempt came to. `sent` only when the provider accepted the message and returned its id; anything
 * else is `failed`. `error` is a short code (no credential, no provider text). `retryable` is true only when the
 * provider said the message was NOT processed: an explicit 429, a 503 that says so (Retry-After), or a provider
 * throttling code. A network error or timeout after the request may have left is never retryable (it may have been
 * delivered): it is `failed` with an error ending in `UNKNOWN_OUTCOME`. `retryAfterMs` passes on a Retry-After.
 */
export type DeliveryResult =
  | { status: "sent"; externalId: string }
  | { status: "failed"; error: string; retryable: boolean; retryAfterMs?: number };

/**
 * How a sender is proven to belong to the channel. `credential`: the provider itself confirmed it for these
 * credentials (`verified` says whether it did). `code`: the provider cannot; the brick sends a one-time code to the
 * sender address and an admin confirms it. `unavailable`: the provider could not answer (429, 5xx, network): not a
 * "no", so the brick leaves the channel's verified state as it was.
 */
export type SenderVerification =
  | { method: "credential"; verified: boolean }
  | { method: "code" }
  | { method: "unavailable"; error: string };

export type DeliveryStatus = "delivered" | "read" | "failed";

/** What a provider's delivery-status webhook said, after its signature was checked. */
export type StatusWebhookResult =
  /** Missing or forged signature (or no signing secret configured): the route answers 401 and changes nothing. */
  | { kind: "invalid" }
  /** Correctly signed, but nothing this brick records: answered 200. */
  | { kind: "ignored" }
  /** Correctly signed status updates, each naming the provider's message id (the dispatch's `external_id`). */
  | { kind: "status"; updates: Array<{ externalId: string; status: DeliveryStatus; error?: string }> };

export interface DeliveryAdapter {
  /** One attempt; the brick retries a `retryable` failure. Must not throw for a provider failure. */
  send(channel: DeliveryChannel, message: OutboundMessage, credentials: ChannelCredentials): Promise<DeliveryResult>;
  /** How (and, for `credential`, whether) the channel's sender belongs to these credentials. */
  verifySender(channel: DeliveryChannel, credentials: ChannelCredentials): Promise<SenderVerification>;
  /**
   * Refuses a channel whose non-secret config this adapter cannot use (a missing region or API version): a short
   * message, or null when it is fine. Optional.
   */
  checkConfig?(channel: Pick<DeliveryChannel, "channel_type" | "sender_address" | "config">): string | null;
  /**
   * Only for a provider that documents a webhook signature scheme. Checks the signature over the exact raw body with
   * the channel's credentials before reading anything. An adapter without a signing secret answers `invalid`.
   */
  parseStatusWebhook?(rawBody: string, headers: Headers, credentials: ChannelCredentials, channel: DeliveryChannel): Promise<StatusWebhookResult>;
  /** A provider's GET subscription check: the text to echo back, or null to refuse. Optional. */
  answerWebhookChallenge?(query: URLSearchParams, credentials: ChannelCredentials, channel: DeliveryChannel): string | null;
}
