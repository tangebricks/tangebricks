import { createPublicUrlFetch, isEgressForbiddenError, scoped, type D1Like, type HostResolver, type PublicUrlFetcher } from "@poc/sdk";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface WebhookEndpoint {
  id: string;
  workspace_id: string;
  target_url: string;
  description: string | null;
  events: string[];
  secret: string;
  is_active: boolean;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  workspace_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status_code: number | null;
  response_body: string | null;
  success: boolean;
  attempt_number: number;
  duration_ms: number;
  created_at: string;
}

export interface CreateEndpointInput {
  workspaceId: string;
  targetUrl: string;
  description?: string;
  events?: string[];
}

interface RawEndpointRow {
  id: string;
  workspace_id: string;
  target_url: string;
  description: string | null;
  events_json: string;
  secret: string;
  is_active: number;
  created_at: string;
}

interface RawDeliveryRow {
  id: string;
  endpoint_id: string;
  workspace_id: string;
  event_type: string;
  payload_json: string;
  status_code: number | null;
  response_body: string | null;
  success: number;
  attempt_number: number;
  duration_ms: number;
  created_at: string;
}

/**
 * Computes standard HMAC-SHA256 signature for outgoing webhook payload.
 */
export async function signWebhookPayload(
  secret: string,
  timestamp: number,
  payloadString: string
): Promise<string> {
  const encoder = new TextEncoder();
  const signatureData = encoder.encode(`${timestamp}.${payloadString}`);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, signatureData);
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

export interface OutboundWebhookServiceOptions {
  /** Host resolver for the SSRF guard; tests inject one to stay offline. Defaults to DNS-over-HTTPS. */
  resolveHost?: HostResolver | null;
}

export class OutboundWebhookService {
  /** Every delivery goes through the public-URL guard: tenant-supplied target URLs may not reach internal addresses. */
  private readonly guardedFetch: PublicUrlFetcher;
  private readonly db: D1Like;

  constructor(
    db: D1Like,
    customFetch: Fetcher = (url, init) => fetch(url, init),
    options: OutboundWebhookServiceOptions = {}
  ) {
    this.db = db;
    this.guardedFetch = createPublicUrlFetch(customFetch, {
      ...(options.resolveHost !== undefined ? { resolveHost: options.resolveHost } : {}),
    });
  }

  private parseEndpoint(row: RawEndpointRow): WebhookEndpoint {
    let events: string[] = ["*"];
    try {
      events = JSON.parse(row.events_json);
    } catch {
      events = ["*"];
    }

    return {
      id: row.id,
      workspace_id: row.workspace_id,
      target_url: row.target_url,
      description: row.description,
      events,
      secret: row.secret,
      is_active: row.is_active === 1,
      created_at: row.created_at,
    };
  }

  private parseDelivery(row: RawDeliveryRow): WebhookDelivery {
    let payload = {};
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = {};
    }

    return {
      id: row.id,
      endpoint_id: row.endpoint_id,
      workspace_id: row.workspace_id,
      event_type: row.event_type,
      payload,
      status_code: row.status_code,
      response_body: row.response_body,
      success: row.success === 1,
      attempt_number: row.attempt_number,
      duration_ms: row.duration_ms,
      created_at: row.created_at,
    };
  }

  /**
   * Registers a customer webhook subscription endpoint.
   */
  async createEndpoint(input: CreateEndpointInput): Promise<WebhookEndpoint> {
    const id = `whep_${crypto.randomUUID().replace(/-/g, "")}`;
    const secretBytes = new Uint8Array(24);
    crypto.getRandomValues(secretBytes);
    const secretHex = Array.from(secretBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    const secret = `whsec_${secretHex}`;

    const events = input.events && input.events.length > 0 ? input.events : ["*"];
    const now = new Date().toISOString();

    await scoped(this.db, input.workspaceId).insert("owh_endpoints", {
      id,
      target_url: input.targetUrl.trim(),
      description: input.description?.trim().slice(0, 255) || null,
      events_json: JSON.stringify(events),
      secret,
      is_active: 1,
      created_at: now,
    });

    return {
      id,
      workspace_id: input.workspaceId,
      target_url: input.targetUrl.trim(),
      description: input.description?.trim().slice(0, 255) || null,
      events,
      secret,
      is_active: true,
      created_at: now,
    };
  }

  /**
   * Retrieves an endpoint by ID.
   */
  async getEndpoint(endpointId: string, workspaceId?: string): Promise<WebhookEndpoint | null> {
    if (!workspaceId) return null;
    const row = await scoped(this.db, workspaceId).first<RawEndpointRow>(
      "owh_endpoints",
      "id = ?",
      [endpointId]
    );
    if (!row) return null;
    return this.parseEndpoint(row);
  }

  /**
   * Lists endpoints for a workspace.
   */
  async listEndpoints(workspaceId: string): Promise<WebhookEndpoint[]> {
    const rows = await scoped(this.db, workspaceId).select<RawEndpointRow>(
      "owh_endpoints",
      undefined,
      [],
      { orderBy: "created_at DESC" }
    );

    return rows.map((r) => this.parseEndpoint(r));
  }

  /**
   * Deletes a webhook subscription endpoint.
   */
  async deleteEndpoint(endpointId: string, workspaceId: string): Promise<boolean> {
    const res = await scoped(this.db, workspaceId).delete(
      "owh_endpoints",
      "id = ?",
      [endpointId]
    );

    return res.meta.changes > 0;
  }

  /**
   * Dispatches an event to all matching subscribed endpoints in the workspace.
   */
  async dispatchEvent(
    workspaceId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<WebhookDelivery[]> {
    const endpoints = await this.listEndpoints(workspaceId);
    const activeMatching = endpoints.filter(
      (ep) => ep.is_active && (ep.events.includes("*") || ep.events.includes(eventType))
    );

    const deliveries: WebhookDelivery[] = [];
    const payloadStr = JSON.stringify(payload);

    for (const ep of activeMatching) {
      const delivery = await this.sendDelivery(ep, eventType, payload, payloadStr, 1);
      deliveries.push(delivery);
    }

    return deliveries;
  }

  /**
   * Performs the HTTP request and logs delivery.
   */
  private async sendDelivery(
    endpoint: WebhookEndpoint,
    eventType: string,
    payload: Record<string, unknown>,
    payloadStr: string,
    attemptNumber = 1
  ): Promise<WebhookDelivery> {
    const deliveryId = `wdel_${crypto.randomUUID().replace(/-/g, "")}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signWebhookPayload(endpoint.secret, timestamp, payloadStr);

    const startTime = Date.now();
    let statusCode: number | null = null;
    // The endpoint's response body is never stored: it is upstream content a tenant could use to read internal
    // services through the dispatcher. Only the status code is kept; on a refusal the guard's own code is recorded.
    let responseBody: string | null = null;
    let success = false;

    try {
      const res = await this.guardedFetch(endpoint.target_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ProjectX-Event": eventType,
          "X-ProjectX-Signature": signature,
          "User-Agent": "ProjectX-Webhook-Dispatcher/1.0",
        },
        body: payloadStr,
      });

      statusCode = res.status;
      try {
        await res.body?.cancel();
      } catch {
        // ignore: the body is discarded either way
      }
      success = res.status >= 200 && res.status < 300;
    } catch (err: unknown) {
      statusCode = 0;
      responseBody = isEgressForbiddenError(err) ? err.code : "DELIVERY_FAILED";
      success = false;
    }

    const durationMs = Date.now() - startTime;
    const now = new Date().toISOString();

    await scoped(this.db, endpoint.workspace_id).insert("owh_deliveries", {
      id: deliveryId,
      endpoint_id: endpoint.id,
      event_type: eventType,
      payload_json: payloadStr,
      status_code: statusCode,
      response_body: responseBody,
      success: success ? 1 : 0,
      attempt_number: attemptNumber,
      duration_ms: durationMs,
      created_at: now,
    });

    return {
      id: deliveryId,
      endpoint_id: endpoint.id,
      workspace_id: endpoint.workspace_id,
      event_type: eventType,
      payload,
      status_code: statusCode,
      response_body: responseBody,
      success,
      attempt_number: attemptNumber,
      duration_ms: durationMs,
      created_at: now,
    };
  }

  /**
   * Replays an existing delivery attempt.
   */
  async replayDelivery(deliveryId: string, workspaceId: string): Promise<WebhookDelivery | null> {
    const row = await scoped(this.db, workspaceId).first<RawDeliveryRow>(
      "owh_deliveries",
      "id = ?",
      [deliveryId]
    );

    if (!row) return null;

    const endpoint = await this.getEndpoint(row.endpoint_id, workspaceId);
    if (!endpoint) return null;

    const payload = JSON.parse(row.payload_json || "{}");
    const nextAttempt = row.attempt_number + 1;

    return await this.sendDelivery(endpoint, row.event_type, payload, row.payload_json, nextAttempt);
  }

  /**
   * Lists past delivery logs.
   */
  async listDeliveries(workspaceId: string, endpointId?: string): Promise<WebhookDelivery[]> {
    const rows = await scoped(this.db, workspaceId).select<RawDeliveryRow>(
      "owh_deliveries",
      endpointId ? "endpoint_id = ?" : undefined,
      endpointId ? [endpointId] : [],
      { orderBy: "created_at DESC", limit: 50 }
    );
    return rows.map((r) => this.parseDelivery(r));
  }
}
