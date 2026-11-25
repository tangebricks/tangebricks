import { scrubValuePatterns, signTelemetryPayload, TELEMETRY_SIGNATURE_HEADER } from "@poc/telemetry";

export interface TailTraceItem {
  outcome: string;
  scriptName?: string;
  exceptions?: Array<{ name: string; message: string; timestamp?: number }>;
  logs?: Array<{ message: string | unknown[]; level: string; timestamp: number }>;
  eventTimestamp?: number;
  event?: {
    request?: { url?: string; method?: string; headers?: Record<string, string> };
    response?: { status?: number };
  };
  response?: { status?: number };
}

export function shouldAlert(event: TailTraceItem): boolean {
  if (event.outcome !== "ok") return true;
  if (Array.isArray(event.exceptions) && event.exceptions.length > 0) return true;
  const status = event.event?.response?.status ?? event.response?.status;
  if (typeof status === "number" && status >= 500) return true;
  return false;
}

export async function handleTail(
  events: TailTraceItem[],
  env: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
  webhookSecretName = "PX_ALERT_WEBHOOK_URL",
  project = "project",
): Promise<void> {
  const alertEvents = events.filter(shouldAlert);
  if (alertEvents.length === 0) return;

  const webhookUrl = (env[webhookSecretName] as string | undefined) ?? (env.PX_ALERT_WEBHOOK_URL as string | undefined);
  if (!webhookUrl || typeof webhookUrl !== "string") return;

  const payload = {
    type: "tail_alert",
    service: project,
    timestamp: new Date().toISOString(),
    batchSize: alertEvents.length,
    events: alertEvents,
  };

  const rawJson = JSON.stringify(payload);
  const bodyText = scrubValuePatterns(rawJson);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  // Story 1.17: alerts are signed with the alert secret only; the control-plane secret is never a fallback.
  const signingSecret =
    (env.PX_ALERT_SIGNING_SECRET as string | undefined) ??
    (env.PX_ALERT_SECRET as string | undefined);

  if (signingSecret && typeof signingSecret === "string") {
    headers[TELEMETRY_SIGNATURE_HEADER] = await signTelemetryPayload(bodyText, signingSecret);
  }

  await fetcher(webhookUrl, {
    method: "POST",
    headers,
    body: bodyText,
  });
}

export function renderTailWorker(project: string, webhookSecretName = "PX_ALERT_WEBHOOK_URL"): string {
  return `import { scrubValuePatterns, signTelemetryPayload, TELEMETRY_SIGNATURE_HEADER } from "@poc/telemetry";

export interface TailTraceItem {
  outcome: string;
  scriptName?: string;
  exceptions?: Array<{ name: string; message: string; timestamp?: number }>;
  logs?: Array<{ message: string | unknown[]; level: string; timestamp: number }>;
  eventTimestamp?: number;
  event?: {
    request?: { url?: string; method?: string; headers?: Record<string, string> };
    response?: { status?: number };
  };
  response?: { status?: number };
}

export function shouldAlert(event: TailTraceItem): boolean {
  if (event.outcome !== "ok") return true;
  if (Array.isArray(event.exceptions) && event.exceptions.length > 0) return true;
  const status = event.event?.response?.status ?? event.response?.status;
  if (typeof status === "number" && status >= 500) return true;
  return false;
}

export async function handleTail(
  events: TailTraceItem[],
  env: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const alertEvents = events.filter(shouldAlert);
  if (alertEvents.length === 0) return;

  const webhookUrl = (env["${webhookSecretName}"] as string | undefined) ?? (env.PX_ALERT_WEBHOOK_URL as string | undefined);
  if (!webhookUrl || typeof webhookUrl !== "string") return;

  const payload = {
    type: "tail_alert",
    service: "${project}",
    timestamp: new Date().toISOString(),
    batchSize: alertEvents.length,
    events: alertEvents,
  };

  const rawJson = JSON.stringify(payload);
  const bodyText = scrubValuePatterns(rawJson);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  // Story 1.17: alerts are signed with the alert secret only; the control-plane secret is never a fallback.
  const signingSecret =
    (env.PX_ALERT_SIGNING_SECRET as string | undefined) ??
    (env.PX_ALERT_SECRET as string | undefined);

  if (signingSecret && typeof signingSecret === "string") {
    headers[TELEMETRY_SIGNATURE_HEADER] = await signTelemetryPayload(bodyText, signingSecret);
  }

  await fetcher(webhookUrl, {
    method: "POST",
    headers,
    body: bodyText,
  });
}

export default {
  async tail(events: TailTraceItem[], env: Record<string, unknown>, ctx?: { waitUntil: (p: Promise<unknown>) => void }): Promise<void> {
    const work = handleTail(events, env);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(work);
    } else {
      await work;
    }
  },
};
`;
}

export function renderTailWrangler(project: string): string {
  return (
    "// Assembled by @poc/assembler.\n" +
    JSON.stringify(
      {
        name: `${project}-tail`,
        main: "src/index.ts",
        compatibility_date: "2026-10-01",
      },
      null,
      2,
    ) +
    "\n"
  );
}
