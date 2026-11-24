import { Hono } from "hono";
import { z } from "zod";
import type { D1Like, RequestContext } from "@poc/sdk";
import { WORKSPACE_ADMIN_ROLES, pxEnvironment, workspaceRoleRefusal } from "@poc/sdk";
import { LlmGatewayService } from "./gateway.ts";
import type { LlmProviderAdapter } from "./gateway.ts";

export interface AiEnv {
  Bindings: { DB: D1Like };
  Variables: {
    user?: { uid: string; email?: string };
    workspace?: { id: string; role?: string; suspended?: boolean };
    /** The verified request context set by the workspace middleware; the only source of the caller's role. */
    ctx?: RequestContext;
  };
}

export interface AiRouteOptions {
  provider?: string;
  maxTokens?: number;
  adapters?: LlmProviderAdapter[];
}

const GenerateSchema = z.object({
  prompt: z.string().max(65536).optional(),
  templateId: z.string().max(64).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  model: z.string().max(64).optional(),
  temperature: z.number().min(0).max(2).optional(),
  fallbackProviders: z.array(z.string()).optional(),
});

const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  templateText: z.string().min(1).max(65536),
  defaultModel: z.string().max(64).default("gpt-4o-mini"),
  temperature: z.number().min(0).max(2).default(0.7),
});

export function createAiRoutes(options: AiRouteOptions = {}): Hono<AiEnv> {
  const app = new Hono<AiEnv>();

  // Generate text
  app.post("/ai/generate", async (c) => {
    const user = c.get("user");
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);
    const userId = user?.uid || "system";

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = GenerateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = new LlmGatewayService(c.env.DB, options.adapters, options.provider, { environment: pxEnvironment(c.env) });
    const result = await service.complete(workspace.id, userId, {
      ...parsed.data,
      provider: options.provider,
    });

    if (!result.ok) {
      return c.json(
        { error: result.error, ...(result.errorCode ? { code: result.errorCode } : {}) },
        result.code as 400 | 404 | 502 | 503,
      );
    }

    return c.json({ result: result.result }, 200);
  });

  // List templates
  app.get("/ai/templates", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new LlmGatewayService(c.env.DB, options.adapters, options.provider, { environment: pxEnvironment(c.env) });
    const templates = await service.listTemplates(workspace.id);
    return c.json({ templates }, 200);
  });

  // Create template. Templates are shared by every member's generations, so creating one needs owner or admin (sweep A6).
  app.post("/ai/templates", async (c) => {
    const denied = workspaceRoleRefusal(c.get("user"), c.get("ctx"), WORKSPACE_ADMIN_ROLES);
    if (denied) return c.json(denied.body, denied.status);
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateTemplateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }

    const service = new LlmGatewayService(c.env.DB, options.adapters, options.provider, { environment: pxEnvironment(c.env) });
    const result = await service.createTemplate(
      workspace.id,
      parsed.data.name,
      parsed.data.templateText,
      parsed.data.defaultModel,
      parsed.data.temperature
    );

    if (!result.ok) {
      return c.json({ error: result.error }, result.code as 400 | 500);
    }

    return c.json({ template: result.template }, 201);
  });

  // Get usage telemetry
  app.get("/ai/usage", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = new LlmGatewayService(c.env.DB, options.adapters, options.provider, { environment: pxEnvironment(c.env) });
    const usage = await service.getUsageStats(workspace.id);
    return c.json({ usage }, 200);
  });

  return app;
}
