import type { D1Like } from "@poc/sdk";
import { isProductionEnvironment, scoped } from "@poc/sdk";

export interface TemplateRecord {
  id: string;
  workspace_id: string;
  name: string;
  template_text: string;
  default_model: string;
  temperature: number;
  created_at: string;
}

export interface GenerationLogRecord {
  id: string;
  workspace_id: string;
  user_id: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_credits: number;
  latency_ms: number;
  created_at: string;
}

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costCredits: number;
  latencyMs: number;
}

export interface LlmProviderAdapter {
  name: string;
  generate(
    prompt: string,
    model: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<{ text: string; promptTokens: number; completionTokens: number; modelUsed: string }>;
}

/**
 * TEST-ONLY adapter: it returns made-up text. Never registered by default (story 0.9, A5); a test injects
 * it through `customProviders` / `createAiRoutes({ adapters })`.
 */
export class MockLlmAdapter implements LlmProviderAdapter {
  constructor(public readonly name = "mock", public shouldFail = false) {}

  async generate(
    prompt: string,
    model: string
  ): Promise<{ text: string; promptTokens: number; completionTokens: number; modelUsed: string }> {
    if (this.shouldFail) {
      throw new Error(`Provider ${this.name} temporarily unavailable (rate_limit_exceeded)`);
    }
    const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
    const responseText = `[${this.name}:${model}] response to: ${prompt.substring(0, 50)}`;
    const completionTokens = Math.max(1, Math.ceil(responseText.length / 4));

    return {
      text: responseText,
      promptTokens,
      completionTokens,
      modelUsed: model,
    };
  }
}

export class LlmGatewayService {
  private readonly providers: Map<string, LlmProviderAdapter>;

  constructor(
    private readonly db: D1Like,
    customProviders?: LlmProviderAdapter[],
    private readonly defaultProvider?: string,
    options: { environment?: string } = {}
  ) {
    // Story 0.9 (A5): no adapter is registered unless one is passed in. With none, generation answers
    // 503 NOT_CONFIGURED; it never falls back to mock text. In production the test-only mock is refused.
    this.providers = new Map();
    const production = isProductionEnvironment(options.environment);
    for (const p of customProviders ?? []) {
      if (production && p instanceof MockLlmAdapter) continue;
      this.providers.set(p.name, p);
    }
  }

  /**
   * Registers a prompt template for a workspace.
   */
  async createTemplate(
    workspaceId: string,
    nameRaw: string,
    templateTextRaw: string,
    defaultModel = "gpt-4o-mini",
    temperature = 0.7
  ): Promise<{ ok: true; template: TemplateRecord } | { ok: false; error: string; code: number }> {
    const name = nameRaw.trim();
    if (!name || name.length > 100) {
      return { ok: false, error: "Template name must be between 1 and 100 characters", code: 400 };
    }

    const templateText = templateTextRaw.trim();
    if (!templateText || templateText.length > 65536) {
      return { ok: false, error: "Template text must be between 1 and 65536 characters", code: 400 };
    }

    const id = `tmpl_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    await scoped(this.db, workspaceId).insert("ai_prompt_templates", {
      id,
      name,
      template_text: templateText,
      default_model: defaultModel,
      temperature,
      created_at: now,
    });

    return {
      ok: true,
      template: {
        id,
        workspace_id: workspaceId,
        name,
        template_text: templateText,
        default_model: defaultModel,
        temperature,
        created_at: now,
      },
    };
  }

  /**
   * Retrieves a template by ID scoped to workspace.
   */
  async getTemplate(workspaceId: string, templateId: string): Promise<TemplateRecord | null> {
    return scoped(this.db, workspaceId).first<TemplateRecord>(
      "ai_prompt_templates",
      "id = ?",
      [templateId],
    );
  }

  /**
   * Lists prompt templates in a workspace.
   */
  async listTemplates(workspaceId: string): Promise<TemplateRecord[]> {
    return scoped(this.db, workspaceId).select<TemplateRecord>(
      "ai_prompt_templates",
      undefined,
      [],
      { orderBy: "created_at DESC" },
    );
  }

  /**
   * Hydrates template placeholders {{key}} or {{$key}} with variable values.
   */
  hydrateTemplate(templateText: string, variables: Record<string, string> = {}): string {
    return templateText.replace(/\{\{?\$?([\w.-]+)\}?\}/g, (match, key) => {
      return Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match;
    });
  }

  /**
   * Executes LLM generation with multi-provider fallback, token calculation, and D1 telemetry logging.
   */
  async complete(
    workspaceId: string,
    userId: string,
    options: {
      prompt?: string;
      templateId?: string;
      variables?: Record<string, string>;
      provider?: string;
      model?: string;
      temperature?: number;
      fallbackProviders?: string[];
    }
  ): Promise<{ ok: true; result: LlmResult } | { ok: false; error: string; code: number; errorCode?: "NOT_CONFIGURED" | "PROVIDER_ERROR" }> {
    let finalPrompt = options.prompt || "";
    let model = options.model || "gpt-4o-mini";
    let temperature = options.temperature ?? 0.7;

    // Hydrate template if requested
    if (options.templateId) {
      const tmpl = await this.getTemplate(workspaceId, options.templateId);
      if (!tmpl) return { ok: false, error: "Prompt template not found", code: 404 };
      finalPrompt = this.hydrateTemplate(tmpl.template_text, options.variables);
      model = options.model || tmpl.default_model;
      temperature = options.temperature ?? tmpl.temperature;
    }

    if (!finalPrompt.trim()) {
      return { ok: false, error: "Prompt cannot be empty", code: 400 };
    }

    const primaryProviderName = options.provider || this.defaultProvider;
    const providerChain = [
      ...(primaryProviderName ? [primaryProviderName] : []),
      ...(options.fallbackProviders || []),
    ];
    if (!providerChain.some((name) => this.providers.has(name))) {
      const asked = providerChain.length > 0 ? providerChain.map((n) => `"${n}"`).join(", ") : "none";
      return {
        ok: false,
        error: `NOT_CONFIGURED: no LLM provider adapter is configured (requested: ${asked}). Connect a provider before generating.`,
        code: 503,
        errorCode: "NOT_CONFIGURED",
      };
    }

    let lastError: Error | null = null;
    let successfulProvider: LlmProviderAdapter | null = null;
    let completionOutput: { text: string; promptTokens: number; completionTokens: number; modelUsed: string } | null = null;
    const startTime = Date.now();

    for (const provName of providerChain) {
      const adapter = this.providers.get(provName);
      if (!adapter) continue;
      try {
        completionOutput = await adapter.generate(finalPrompt, model, { temperature });
        successfulProvider = adapter;
        break; // Successfully generated!
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Fallback to next provider in chain
      }
    }

    if (!successfulProvider || !completionOutput) {
      return {
        ok: false,
        error: `All LLM providers failed: ${lastError?.message || "No available provider"}`,
        code: 502,
        errorCode: "PROVIDER_ERROR",
      };
    }

    const latencyMs = Date.now() - startTime;
    // Credit cost rule: 1 credit per 1000 prompt tokens + 2 credits per 1000 completion tokens
    const costCredits = Math.ceil(
      (completionOutput.promptTokens * 1 + completionOutput.completionTokens * 2) / 1000
    );

    const logId = `ail_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();

    // Log telemetry in D1
    await scoped(this.db, workspaceId).insert("ai_generation_logs", {
      id: logId,
      user_id: userId,
      provider: successfulProvider.name,
      model: completionOutput.modelUsed,
      prompt_tokens: completionOutput.promptTokens,
      completion_tokens: completionOutput.completionTokens,
      cost_credits: costCredits,
      latency_ms: latencyMs,
      created_at: now,
    });

    const result: LlmResult = {
      text: completionOutput.text,
      provider: successfulProvider.name,
      model: completionOutput.modelUsed,
      promptTokens: completionOutput.promptTokens,
      completionTokens: completionOutput.completionTokens,
      costCredits,
      latencyMs,
    };

    return { ok: true, result };
  }

  /**
   * Computes aggregated usage telemetry for a workspace.
   */
  async getUsageStats(workspaceId: string): Promise<{
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCostCredits: number;
    requestCount: number;
  }> {
    interface StatsRow {
      total_prompt: number | null;
      total_comp: number | null;
      total_cost: number | null;
      req_count: number;
    }

    const row = await scoped(this.db, workspaceId).raw(`
      SELECT SUM(prompt_tokens) as total_prompt,
             SUM(completion_tokens) as total_comp,
             SUM(cost_credits) as total_cost,
             COUNT(*) as req_count
      FROM ai_generation_logs
      WHERE workspace_id = ?
    `, [workspaceId]).first<StatsRow>();

    return {
      totalPromptTokens: row?.total_prompt ?? 0,
      totalCompletionTokens: row?.total_comp ?? 0,
      totalCostCredits: row?.total_cost ?? 0,
      requestCount: row?.req_count ?? 0,
    };
  }
}
