import { Hono } from "hono";
import { z } from "zod";
import type { D1Like, RequestContext } from "@poc/sdk";
import { WORKSPACE_ADMIN_ROLES, pxEnvironment, workspaceRoleRefusal } from "@poc/sdk";
import {
  DEFAULT_MAX_TOKENS_CAP,
  DEFAULT_MODELS,
  LlmGatewayService,
  MAX_PROMPT_CHARS,
  newCorrelationId,
  parseFallbackProviders,
  parseModelRates,
} from "./gateway.ts";
import type { BillingMode, CreditCharger, LlmProviderAdapter, ModelRate } from "./gateway.ts";

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
  /** Story 1.13: the largest maxTokens a request may ask for (default 4096); also what is sent when it asks for none. */
  maxTokens?: number;
  adapters?: LlmProviderAdapter[];
  /** Story 1.13: "wallet" (default) charges every generation through `charger`; "none" never charges. */
  billing?: BillingMode;
  /** Story 1.13: the wallet charger; the assembler wires credit-wallet's walletCharger here (`$capability`). */
  charger?: CreditCharger;
  /** Story 1.13: the model allowlist with prices, "id:promptCreditsPer1k:completionCreditsPer1k,..." or a list. */
  models?: string | readonly ModelRate[];
  /**
   * Story 1.13: providers tried after `provider` fails, comma-separated or a list (deduplicated, at most 3). Only the
   * app configures these; a request cannot name a provider.
   */
  fallbackProviders?: string | readonly string[];
}

/** Template variables: at most 64 of them, names up to 64 characters, values up to 16384 characters. */
const VariablesSchema = z
  .record(z.string().max(64), z.string().max(16384))
  .refine((v) => Object.keys(v).length <= 64, { message: "at most 64 template variables" });

const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  templateText: z.string().min(1).max(MAX_PROMPT_CHARS),
  // Without one, the template gets the app's default model (the first on the allowlist).
  defaultModel: z.string().max(64).optional(),
  temperature: z.number().min(0).max(2).default(0.7),
});

export function createAiRoutes(options: AiRouteOptions = {}): Hono<AiEnv> {
  const app = new Hono<AiEnv>();
  // Checked once, when the app starts: a bad billing mode, model list or token cap stops it rather than letting an
  // unpriced or unbilled call through.
  const billing = options.billing ?? "wallet";
  if (billing !== "wallet" && billing !== "none") throw new Error(`llm-gateway: billing must be "wallet" or "none"`);
  const models = parseModelRates(options.models ?? DEFAULT_MODELS);
  const maxTokensCap = options.maxTokens ?? DEFAULT_MAX_TOKENS_CAP;
  if (!Number.isSafeInteger(maxTokensCap) || maxTokensCap < 1) throw new Error("llm-gateway: maxTokens must be a whole number of 1 or more");
  const fallbackProviders = parseFallbackProviders(options.fallbackProviders, options.provider);
  const serviceFor = (db: D1Like, environment: string | undefined) =>
    new LlmGatewayService(db, options.adapters, options.provider, {
      environment,
      billing,
      ...(options.charger ? { charger: options.charger } : {}),
      models,
      maxTokensCap,
      fallbackProviders,
    });

  const GenerateSchema = z.object({
    prompt: z.string().max(MAX_PROMPT_CHARS).optional(),
    templateId: z.string().max(64).optional(),
    variables: VariablesSchema.optional(),
    model: z.string().max(64).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(maxTokensCap).optional(),
    // Story 1.13: no provider or fallbackProviders here. Unknown keys are dropped, so a body naming a provider is ignored.
  });

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

    let result: Awaited<ReturnType<LlmGatewayService["complete"]>>;
    try {
      result = await serviceFor(c.env.DB, pxEnvironment(c.env)).complete(workspace.id, userId, parsed.data);
    } catch (err: unknown) {
      // No raw error reaches the caller; the details are logged with the correlation id it is given.
      const correlationId = newCorrelationId();
      console.error(`llm-gateway: POST /ai/generate failed [${correlationId}]`, err instanceof Error ? err.message : String(err));
      return c.json({ error: "Internal error", code: "INTERNAL_ERROR", correlationId }, 500);
    }

    if (!result.ok) {
      return c.json(
        {
          error: result.error,
          ...(result.errorCode ? { code: result.errorCode } : {}),
          ...(result.correlationId ? { correlationId: result.correlationId } : {}),
        },
        result.code as 400 | 402 | 404 | 500 | 502 | 503,
      );
    }

    return c.json({ result: result.result }, 200);
  });

  // List templates
  app.get("/ai/templates", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = serviceFor(c.env.DB, pxEnvironment(c.env));
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

    const service = serviceFor(c.env.DB, pxEnvironment(c.env));
    const result = await service.createTemplate(
      workspace.id,
      parsed.data.name,
      parsed.data.templateText,
      parsed.data.defaultModel,
      parsed.data.temperature
    );

    if (!result.ok) {
      return c.json({ error: result.error, ...(result.errorCode ? { code: result.errorCode } : {}) }, result.code as 400 | 500);
    }

    return c.json({ template: result.template }, 201);
  });

  // Get usage telemetry
  app.get("/ai/usage", async (c) => {
    const workspace = c.get("workspace");
    if (!workspace) return c.json({ error: "Missing workspace context" }, 400);

    const service = serviceFor(c.env.DB, pxEnvironment(c.env));
    const usage = await service.getUsageStats(workspace.id);
    return c.json({ usage }, 200);
  });

  return app;
}
