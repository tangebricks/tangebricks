import { Hono } from "hono";
import { z } from "zod";
import type { D1Like, RequestContext } from "@poc/sdk";
import { WORKSPACE_ADMIN_ROLES, refuseApiKeyCaller, workspaceRoleRefusal } from "@poc/sdk";
import { WebhookSignatureSchemeSchema } from "@poc/assembler";
import { WebhookService } from "./gateway.ts";
import type { WebhookGatewayAdapter } from "./gateway.ts";
import { getPreset } from "./presets.ts";

export interface WebhookEnv {
  Bindings: {
    DB: D1Like;
    PX_CONN_KEY?: string;
    PX_WEBHOOK_ALLOW_UNSIGNED?: string;
  };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified workspace, set by the workspace middleware. Handlers read the workspace from here only. */
    ctx?: RequestContext;
  };
}

export interface WebhookRouteOptions {
  rotationGraceHours?: number;
  adapter?: WebhookGatewayAdapter;
  allowUnsignedForDev?: boolean;
}

const CreateEndpointSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(64),
  targetWorkflowId: z.string().max(64).optional(),
});

const PresetOrSchemeSchema = z.union([
  z.string().refine((val) => val === "shared-secret" || Boolean(getPreset(val)), {
    message: "Invalid preset name",
  }),
  WebhookSignatureSchemeSchema,
]);

const PresetOrSchemeDevSchema = z.union([
  z.string().refine((val) => val === "none" || val === "shared-secret" || Boolean(getPreset(val)), {
    message: "Invalid preset name",
  }),
  WebhookSignatureSchemeSchema,
]);

const CreateSubscriptionSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  workflowId: z.string().min(1).max(128),
  connectionRef: z.string().min(1).max(128).optional(),
  app: z.string().min(1).max(64),
  triggerId: z.string().min(1).max(128),
  verifier: PresetOrSchemeSchema,
  signatureHeader: z.string().min(1).max(128).optional(),
  eventIdPath: z.string().min(1).max(128).optional(),
  signingSecret: z.string().min(1).max(512).optional(),
  enabled: z.boolean().optional(),
});

const CreateSubscriptionDevSchema = CreateSubscriptionSchema.extend({
  verifier: PresetOrSchemeDevSchema,
});

export function createWebhookRoutes(options: WebhookRouteOptions = {}): Hono<WebhookEnv> {
  const app = new Hono<WebhookEnv>();

  // Public Case A ingress endpoint for inbound webhooks (AD-S20):
  // Mounted at /api/webhooks/in/:subscriptionId
  app.post("/webhooks/in/:subscriptionId", async (c) => {
    const subscriptionId = c.req.param("subscriptionId");
    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.header())) {
      if (typeof v === "string") headers[k] = v;
    }

    const allowUnsigned =
      Boolean((options as { allowUnsignedForDev?: boolean })["allowUnsignedForDev"]) ||
      c.env.PX_WEBHOOK_ALLOW_UNSIGNED === "dev";
    const service = new WebhookService(c.env.DB, {
      rotationGraceHours: options.rotationGraceHours,
      allowUnsignedForDev: allowUnsigned,
    });
    const result = await service.ingestSubscriptionWebhook(
      subscriptionId,
      rawBody,
      headers,
      {
        connKey: c.env.PX_CONN_KEY,
        adapter: options.adapter,
      },
    );

    if (!result.ok) {
      return c.json(
        {
          error: result.error,
          ...(result.reason ? { reason: result.reason } : {}),
        },
        result.status,
      );
    }

    return c.json(
      {
        received: true,
        deduplicated: result.deduplicated,
        subscriptionId: result.subscriptionId,
        eventId: result.eventId,
        providerEventId: result.eventId,
        workflowId: result.workflowId,
        ...(result.deduplicated ? {} : { runId: result.runId }),
      },
      200,
    );
  });

  // Register a Case A webhook subscription. Owner/admin only, checked before the body is read (audit risk 8).
  app.post("/webhooks/subscriptions", async (c) => {
    // Story 1.11: an API key never mints credentials that would outlive it.
    const keyRefused = refuseApiKeyCaller(c);
    if (keyRefused) return keyRefused;
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const allowUnsigned =
      Boolean((options as { allowUnsignedForDev?: boolean })["allowUnsignedForDev"]) ||
      c.env.PX_WEBHOOK_ALLOW_UNSIGNED === "dev";

    if (
      typeof body === "object" &&
      body !== null &&
      (body as { verifier?: unknown }).verifier === "none" &&
      !allowUnsigned
    ) {
      return c.json({ error: "WEBHOOK_VERIFIER_NONE_FORBIDDEN" }, 400);
    }

    if (
      typeof body === "object" &&
      body !== null &&
      typeof (body as { verifier?: unknown }).verifier === "object"
    ) {
      const schemeParsed = WebhookSignatureSchemeSchema.safeParse(
        (body as { verifier: unknown }).verifier,
      );
      if (!schemeParsed.success) {
        const firstIssue = schemeParsed.error.issues[0];
        const path = firstIssue ? firstIssue.path.join(".") : "verifier";
        return c.json(
          {
            error: "WEBHOOK_SCHEME_INVALID",
            message: `WEBHOOK_SCHEME_INVALID: ${path}`,
            path,
            issues: schemeParsed.error.issues,
          },
          400,
        );
      }
    }

    const schema = allowUnsigned
      ? CreateSubscriptionDevSchema
      : CreateSubscriptionSchema;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join(", ") },
        400,
      );
    }

    const service = new WebhookService(c.env.DB, {
      rotationGraceHours: options.rotationGraceHours,
      allowUnsignedForDev: allowUnsigned,
    });
    try {
      const subscription = await service.registerSubscription({
        ...parsed.data,
        workspaceId: ctx.workspaceId,
      });

      return c.json({ subscription }, 201);
    } catch (err: any) {
      if (err?.code === "WEBHOOK_SCHEME_INVALID") {
        return c.json(
          {
            error: "WEBHOOK_SCHEME_INVALID",
            message: err.message,
            path: err.path,
          },
          400,
        );
      }
      throw err;
    }
  });

  // Public ingress endpoint for inbound webhooks by slug
  app.post("/webhooks/ingress/:slug", async (c) => {
    const slug = c.req.param("slug");
    const signature =
      c.req.header("X-Signature-SHA256") ||
      c.req.header("X-Hub-Signature-256") ||
      c.req.header("Stripe-Signature") ||
      "";

    const text = await c.req.text();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.header())) {
      if (typeof v === "string") headers[k] = v;
    }

    const allowUnsigned =
      Boolean((options as { allowUnsignedForDev?: boolean })["allowUnsignedForDev"]) ||
      c.env.PX_WEBHOOK_ALLOW_UNSIGNED === "dev";
    const service = new WebhookService(c.env.DB, {
      rotationGraceHours: options.rotationGraceHours,
      allowUnsignedForDev: allowUnsigned,
    });
    const result = await service.ingestWebhook(slug, text, headers, signature);

    if (!result.ok) {
      return c.json({ error: result.error }, result.status as 401 | 404 | 500);
    }

    return c.json({ received: true, deliveryId: result.deliveryId }, 200);
  });

  // List endpoints in caller's workspace
  app.get("/webhooks/endpoints", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    const allowUnsigned =
      Boolean((options as { allowUnsignedForDev?: boolean })["allowUnsignedForDev"]) ||
      c.env.PX_WEBHOOK_ALLOW_UNSIGNED === "dev";
    const service = new WebhookService(c.env.DB, {
      rotationGraceHours: options.rotationGraceHours,
      allowUnsignedForDev: allowUnsigned,
    });
    const endpoints = await service.listEndpoints(ctx.workspaceId);
    return c.json({ endpoints }, 200);
  });

  // Create endpoint. Owner/admin only (story 0.6).
  app.post("/webhooks/endpoints", async (c) => {
    // Story 1.11: an API key never mints credentials that would outlive it.
    const keyRefused = refuseApiKeyCaller(c);
    if (keyRefused) return keyRefused;
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const allowUnsigned =
      Boolean((options as { allowUnsignedForDev?: boolean })["allowUnsignedForDev"]) ||
      c.env.PX_WEBHOOK_ALLOW_UNSIGNED === "dev";

    if (
      typeof body === "object" &&
      body !== null &&
      (body as { verifier?: unknown }).verifier === "none" &&
      !allowUnsigned
    ) {
      return c.json({ error: "WEBHOOK_VERIFIER_NONE_FORBIDDEN" }, 400);
    }

    const parsed = CreateEndpointSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = new WebhookService(c.env.DB, {
      rotationGraceHours: options.rotationGraceHours,
      allowUnsignedForDev: allowUnsigned,
    });
    const result = await service.createEndpoint(ctx.workspaceId, parsed.data.name, parsed.data.slug, {
      targetWorkflowId: parsed.data.targetWorkflowId,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, result.code as 400 | 409 | 500);
    }

    return c.json({ endpoint: result.endpoint }, 201);
  });

  // Rotate signing secret. Owner/admin only (story 0.6).
  app.post("/webhooks/endpoints/:id/rotate", async (c) => {
    // Story 1.11: an API key never mints credentials that would outlive it.
    const keyRefused = refuseApiKeyCaller(c);
    if (keyRefused) return keyRefused;
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    const service = new WebhookService(c.env.DB, options.rotationGraceHours);
    const result = await service.rotateSecret(ctx.workspaceId, c.req.param("id"));

    if (!result.ok) {
      return c.json({ error: result.error }, 404);
    }

    return c.json(result, 200);
  });

  // Get delivery logs
  app.get("/webhooks/endpoints/:id/deliveries", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) return c.json({ error: "Missing workspace context" }, 400);

    const service = new WebhookService(c.env.DB, options.rotationGraceHours);
    // An endpoint id outside the caller's workspace is not found, not an empty delivery log.
    const endpoint = await service.getEndpoint(ctx.workspaceId, c.req.param("id"));
    if (!endpoint) return c.json({ error: "Endpoint not found" }, 404);
    const deliveries = await service.listDeliveries(ctx.workspaceId, endpoint.id);
    return c.json({ deliveries }, 200);
  });

  return app;
}
