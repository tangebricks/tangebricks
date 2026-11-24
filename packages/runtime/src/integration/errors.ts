export class IntegrationCallError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  readonly retryAfterMs?: number;
  /** Redacted provider error body (UC3.2), capped by the egress response size cap. */
  readonly body?: unknown;

  constructor(
    message: string,
    details: {
      code: string;
      status?: number;
      retryable?: boolean;
      providerCode?: string;
      providerMessage?: string;
      retryAfterMs?: number;
      body?: unknown;
    },
  ) {
    super(message);
    this.name = "IntegrationCallError";
    this.code = details.code;
    this.status = details.status;
    this.retryable = details.retryable;
    this.providerCode = details.providerCode;
    this.providerMessage = details.providerMessage;
    this.retryAfterMs = details.retryAfterMs;
    if (details.body !== undefined) this.body = details.body;
  }
}
