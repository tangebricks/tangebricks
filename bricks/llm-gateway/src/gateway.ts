import type { D1Like } from "@poc/sdk";
import { MILLI_PER_CREDIT, isProductionEnvironment, scoped } from "@poc/sdk";

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
  /** Story 1.13 (migration 0002); see BillingStatus. */
  billing_status: BillingStatus;
  created_at: string;
}

/**
 * Story 1.13: what happened to a generation's money (billing "wallet"), or not_billed.
 *   reserved        the call's maximum is held and the call has not finished. A row still reserved well after the
 *                   request time limit is a cancelled or crashed call: cost_credits is held and must be reconciled;
 *   charged         the text was returned; the wallet paid the actual cost (cost_credits) and got the rest back;
 *   refund_failed   the text was returned, but returning the unused part failed; cost_credits is the whole reservation;
 *   refunded        no text (every provider failed); the whole reservation was returned, cost_credits is 0;
 *   billing_failed  no text, and money may still be held: the reservation could not be returned, or it is unknown
 *                   whether it was taken. cost_credits is what is held as far as is known;
 *   not_billed      billing "none", and rows written before 1.13.
 * getUsageStats counts charged, refund_failed and not_billed rows only.
 */
export type BillingStatus = "reserved" | "charged" | "refund_failed" | "refunded" | "billing_failed" | "not_billed";

/** Story 1.13: a model the app allows, with its price in credits per 1000 prompt and completion tokens. */
export interface ModelRate {
  id: string;
  promptCreditsPer1k: number;
  completionCreditsPer1k: number;
}

export type ChargeOutcome = { ok: true } | { ok: false; code: string };

/**
 * Story 1.13: how a generation is paid for. The assembler hands llm-gateway credit-wallet's `walletCharger` through a
 * `$capability` route option; llm-gateway never imports credit-wallet. Structurally compatible with credit-wallet's
 * `WalletCharger`. `debit` and `refund` are atomic and idempotent per (workspace, key). Story 2.5: the charger speaks
 * thousandths of a credit (`milli`); this gateway prices in whole credits and multiplies by 1000 at the call. `refund`
 * returns at most what the debit under `againstKey` took, and nothing (code NOTHING_TO_REFUND) if that debit is not
 * recorded. `settled` reports the ledger entry under a key, or null.
 */
export interface CreditCharger {
  balanceMilli(db: D1Like, workspaceId: string): Promise<number>;
  debit(db: D1Like, workspaceId: string, milli: number, idempotencyKey: string, reason: string, userId?: string): Promise<ChargeOutcome>;
  refund(
    db: D1Like,
    workspaceId: string,
    milli: number,
    idempotencyKey: string,
    againstKey: string,
    reason: string,
    userId?: string,
  ): Promise<ChargeOutcome>;
  settled(db: D1Like, workspaceId: string, idempotencyKey: string): Promise<{ milli: number } | null>;
}

export type BillingMode = "wallet" | "none";

/** The default model allowlist: gpt-4o-mini at the gateway's original rates (1 and 2 credits per 1k tokens). */
export const DEFAULT_MODELS = "gpt-4o-mini:1:2";
/** The default ceiling for a request's maxTokens. */
export const DEFAULT_MAX_TOKENS_CAP = 4096;
/** The longest prompt, typed or hydrated from a template, in characters. */
export const MAX_PROMPT_CHARS = 65536;
/** The most {{placeholders}} a template may contain. */
export const MAX_TEMPLATE_PLACEHOLDERS = 256;
/** Tokens added to every prompt's estimate for the provider's own framing (role markers, BOS/EOS and the like). */
export const PROMPT_TOKEN_OVERHEAD = 16;
/** At most this many configured fallback providers after the primary one. */
export const MAX_FALLBACK_PROVIDERS = 3;
/** What a client is told when every provider failed. The provider's own message is only logged, with the correlation id. */
export const PROVIDER_ERROR_MESSAGE = "The AI provider could not complete the request";

// A model id may look like gpt-4o-mini, @cf/meta/llama-3.1-8b-instruct or vendor:model:tag.
const MODEL_ID = /^[A-Za-z0-9@][A-Za-z0-9@._/:-]{0,63}$/;
// At most 999999 credits per 1000 tokens, with up to six decimals.
const RATE = /^\d{1,6}(?:\.\d{1,6})?$/;
const MAX_RATE = 999_999.999999;
const PROVIDER_NAME = /^[A-Za-z0-9_-]{1,30}$/;

/**
 * Parses the `models` setting: comma-separated `id:promptCreditsPer1k:completionCreditsPer1k` entries, for example
 * `gpt-4o-mini:1:2,@cf/meta/llama-3.1-8b-instruct:0.5:1`. Each entry is read from the right: the last two fields are
 * the rates and everything before them is the id, so an id may contain ":". The first entry is the default model. A
 * model listed twice keeps its first price. An array of ModelRate is checked the same way. Throws on anything else; in
 * an assembled app the manifest's setting pattern refuses a malformed value at assembly, before this runs.
 */
export function parseModelRates(spec: string | readonly ModelRate[]): ModelRate[] {
  const entries: ModelRate[] =
    typeof spec === "string"
      ? spec
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .map((part) => {
            const fields = part.split(":");
            const completion = fields.pop();
            const prompt = fields.pop();
            const id = fields.join(":");
            if (fields.length === 0 || prompt === undefined || completion === undefined || !RATE.test(prompt) || !RATE.test(completion)) {
              throw new Error(`llm-gateway: models entry "${part}" must be id:promptCreditsPer1k:completionCreditsPer1k`);
            }
            return { id, promptCreditsPer1k: Number(prompt), completionCreditsPer1k: Number(completion) };
          })
      : spec.map((m) => ({ id: m.id, promptCreditsPer1k: m.promptCreditsPer1k, completionCreditsPer1k: m.completionCreditsPer1k }));
  if (entries.length === 0) throw new Error("llm-gateway: models must list at least one model");
  const unique: ModelRate[] = [];
  for (const m of entries) {
    if (typeof m.id !== "string" || !MODEL_ID.test(m.id)) throw new Error(`llm-gateway: model id "${String(m.id)}" is not allowed`);
    for (const rate of [m.promptCreditsPer1k, m.completionCreditsPer1k]) {
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > MAX_RATE) {
        throw new Error(`llm-gateway: model "${m.id}" needs credit rates from 0 to 999999`);
      }
    }
    if (!unique.some((u) => u.id === m.id)) unique.push(m);
  }
  return unique;
}

/**
 * The app-configured fallback providers: comma-separated (or a list), trimmed, without the primary provider or
 * repeats, at most MAX_FALLBACK_PROVIDERS. Throws on a bad name or too many. Requests can never add one (story 1.13).
 */
export function parseFallbackProviders(spec: string | readonly string[] | undefined, primary: string | undefined): string[] {
  const names = (typeof spec === "string" ? spec.split(",") : [...(spec ?? [])]).map((n) => String(n).trim()).filter((n) => n.length > 0);
  const chain: string[] = [];
  for (const name of names) {
    if (!PROVIDER_NAME.test(name)) throw new Error(`llm-gateway: fallback provider "${name}" is not a valid provider name`);
    if (name !== primary && !chain.includes(name)) chain.push(name);
  }
  if (chain.length > MAX_FALLBACK_PROVIDERS) throw new Error(`llm-gateway: at most ${MAX_FALLBACK_PROVIDERS} fallback providers`);
  return chain;
}

const utf8 = new TextEncoder();
const PLACEHOLDER = /\{\{?\$?([\w.-]+)\}?\}/g;

/**
 * The reservation's prompt-token estimate: the prompt's UTF-8 length in bytes plus PROMPT_TOKEN_OVERHEAD. A byte-level
 * BPE token covers at least one byte, so this is meant as an upper estimate. Billing is capped at it: prompt tokens a
 * provider reports beyond it are not billed.
 */
export function maxPromptTokens(text: string): number {
  return utf8.encode(text).length + PROMPT_TOKEN_OVERHEAD;
}

/**
 * Fills {{key}} / {{$key}} placeholders, stopping (null) as soon as the result would pass `maxChars`, before the long
 * string is built.
 */
export function hydrateBounded(templateText: string, variables: Record<string, string>, maxChars: number): string | null {
  const parts: string[] = [];
  let length = 0;
  let last = 0;
  for (const match of templateText.matchAll(PLACEHOLDER)) {
    const key = match[1]!;
    const value = Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match[0];
    const literal = templateText.slice(last, match.index);
    length += literal.length + value.length;
    if (length > maxChars) return null;
    parts.push(literal, value);
    last = match.index! + match[0].length;
  }
  const tail = templateText.slice(last);
  if (length + tail.length > maxChars) return null;
  parts.push(tail);
  return parts.join("");
}

/** Credits for a call: ceil(prompt*p/1000 + completion*c/1000), at least 1. Rounded to 6 places first, so 2.0000000001 is 2. */
export function costInCredits(rate: ModelRate, promptTokens: number, completionTokens: number): number {
  const exact = (promptTokens * rate.promptCreditsPer1k + completionTokens * rate.completionCreditsPer1k) / 1000;
  return Math.max(1, Math.ceil(Math.round(exact * 1e6) / 1e6));
}

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costCredits: number;
  latencyMs: number;
  /** True when costCredits was taken from the workspace wallet; false with billing "none". */
  billed: boolean;
}

export type CompleteErrorCode =
  | "NOT_CONFIGURED"
  | "PROVIDER_ERROR"
  | "BILLING_NOT_CONFIGURED"
  | "INSUFFICIENT_CREDITS"
  | "MODEL_NOT_ALLOWED"
  | "INVALID_MAX_TOKENS"
  | "PROMPT_TOO_LONG"
  | "TOO_MANY_PLACEHOLDERS"
  | "INTERNAL_ERROR";

export interface LlmGatewayOptions {
  environment?: string;
  /** Default "wallet": every generation is paid for through `charger`, and without one generation answers 503. */
  billing?: BillingMode;
  charger?: CreditCharger;
  /** The model allowlist with prices (see parseModelRates); the first is the default model. Default DEFAULT_MODELS. */
  models?: string | readonly ModelRate[];
  /** The largest maxTokens a request may ask for, and what is sent when it asks for none. Default 4096. */
  maxTokensCap?: number;
  /** Providers tried, in order, after the primary one fails (see parseFallbackProviders). */
  fallbackProviders?: string | readonly string[];
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
  readonly name: string;
  shouldFail: boolean;

  constructor(name = "mock", shouldFail = false) {
    this.name = name;
    this.shouldFail = shouldFail;
  }

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
  private readonly billing: BillingMode;
  private readonly charger: CreditCharger | undefined;
  private readonly models: ModelRate[];
  private readonly maxTokensCap: number;
  private readonly db: D1Like;
  private readonly defaultProvider: string | undefined;
  private readonly fallbackProviders: string[];

  constructor(
    db: D1Like,
    customProviders?: LlmProviderAdapter[],
    defaultProvider?: string,
    options: LlmGatewayOptions = {}
  ) {
    this.db = db;
    this.defaultProvider = defaultProvider;
    const billing = options.billing ?? "wallet";
    if (billing !== "wallet" && billing !== "none") throw new Error(`llm-gateway: billing must be "wallet" or "none"`);
    this.billing = billing;
    this.charger = options.charger;
    this.models = parseModelRates(options.models ?? DEFAULT_MODELS);
    const cap = options.maxTokensCap ?? DEFAULT_MAX_TOKENS_CAP;
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("llm-gateway: maxTokens must be a whole number of 1 or more");
    this.maxTokensCap = cap;
    this.fallbackProviders = parseFallbackProviders(options.fallbackProviders, defaultProvider);
    // Story 0.9 (A5): no adapter is registered unless one is passed in. With none, generation answers
    // 503 NOT_CONFIGURED; it never falls back to mock text. In production the test-only mock is refused.
    this.providers = new Map();
    const production = isProductionEnvironment(options.environment);
    for (const p of customProviders ?? []) {
      if (production && p instanceof MockLlmAdapter) continue;
      this.providers.set(p.name, p);
    }
  }

  /** The default model: the first one on the allowlist. */
  get defaultModel(): string {
    return this.models[0]!.id;
  }

  /**
   * Registers a prompt template for a workspace. Without a default model it gets the app's default model.
   */
  async createTemplate(
    workspaceId: string,
    nameRaw: string,
    templateTextRaw: string,
    defaultModelRaw?: string,
    temperature = 0.7
  ): Promise<
    | { ok: true; template: TemplateRecord }
    | { ok: false; error: string; code: number; errorCode?: "MODEL_NOT_ALLOWED" | "TOO_MANY_PLACEHOLDERS" }
  > {
    const name = nameRaw.trim();
    if (!name || name.length > 100) {
      return { ok: false, error: "Template name must be between 1 and 100 characters", code: 400 };
    }

    const templateText = templateTextRaw.trim();
    if (!templateText || templateText.length > MAX_PROMPT_CHARS) {
      return { ok: false, error: `Template text must be between 1 and ${MAX_PROMPT_CHARS} characters`, code: 400 };
    }
    // Story 1.13: each placeholder can be filled with a long value, so their number is bounded too.
    let placeholders = 0;
    for (const _ of templateText.matchAll(PLACEHOLDER)) {
      placeholders += 1;
      if (placeholders > MAX_TEMPLATE_PLACEHOLDERS) {
        return { ok: false, error: `A template may contain at most ${MAX_TEMPLATE_PLACEHOLDERS} placeholders`, code: 400, errorCode: "TOO_MANY_PLACEHOLDERS" };
      }
    }

    // Story 1.13: a template's default model must be on the allowlist (it is checked again when the template is used).
    const defaultModel = defaultModelRaw ?? this.defaultModel;
    if (!this.rateFor(defaultModel)) {
      return { ok: false, error: `Model "${defaultModel}" is not allowed`, code: 400, errorCode: "MODEL_NOT_ALLOWED" };
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
   * Hydrates template placeholders {{key}} or {{$key}} with variable values (no length bound; generation uses
   * hydrateBounded).
   */
  hydrateTemplate(templateText: string, variables: Record<string, string> = {}): string {
    return hydrateBounded(templateText, variables, Number.POSITIVE_INFINITY)!;
  }

  /** The allowlisted model with this id, if any. */
  rateFor(model: string): ModelRate | undefined {
    return this.models.find((m) => m.id === model);
  }

  /** The adapter registered under a provider name. A method, not an inline map lookup, so a test can stand in a fake provider. */
  adapterFor(name: string): LlmProviderAdapter | undefined {
    return this.providers.get(name);
  }

  /**
   * Executes LLM generation with multi-provider fallback, billing, and D1 telemetry logging.
   *
   * Story 1.13, in this order:
   *   1. the model must be on the allowlist (400 MODEL_NOT_ALLOWED), maxTokens in range (400) and the prompt, typed or
   *      hydrated, at most MAX_PROMPT_CHARS (400 PROMPT_TOO_LONG; hydration stops as soon as it passes the limit);
   *   2. one of the app-configured providers (the primary, then its configured fallbacks) must be connected
   *      (503 NOT_CONFIGURED); a request cannot name providers;
   *   3. with billing "wallet" a charger must be wired (503 BILLING_NOT_CONFIGURED);
   *   4. RESERVE: the call's maximum (maxPromptTokens + maxTokens at the model's rates) is debited atomically under
   *      `ai:<logId>` before anything is generated; a refusal answers 402 INSUFFICIENT_CREDITS. The debit is the balance
   *      check, so parallel calls cannot all pass on one balance. A debit that throws is retried once with the same
   *      key; a refusal after a throw is checked against the ledger (the throw may have committed). If it is still
   *      unknown, the reservation is released (a refund that only pays back what the debit actually took), a
   *      billing_failed row is written, and the call answers 500 without generating;
   *   5. a `reserved` log row is written, so a call cancelled from here on leaves a record of the held credits;
   *   6. generate. If every provider fails, the reservation is refunded (row `refunded`) and the call answers 502;
   *   7. SETTLE: the actual cost (prompt tokens capped at the estimate, completion tokens at maxTokens, so never above the
   *      reservation) is kept and the rest refunded under `ai:<logId>:refund`; the row is updated.
   * A refund that throws is retried once with the same key, and if it throws again the ledger decides whether it
   * happened. A failed refund does not withhold the text (row refund_failed); neither does a failed log write.
   */
  async complete(
    workspaceId: string,
    userId: string,
    options: {
      prompt?: string;
      templateId?: string;
      variables?: Record<string, string>;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    }
  ): Promise<
    | { ok: true; result: LlmResult }
    | { ok: false; error: string; code: number; errorCode?: CompleteErrorCode; correlationId?: string }
  > {
    let finalPrompt = options.prompt || "";
    let model = options.model || this.defaultModel;
    let temperature = options.temperature ?? 0.7;
    const tooLong = { ok: false as const, error: `The prompt is longer than ${MAX_PROMPT_CHARS} characters`, code: 400, errorCode: "PROMPT_TOO_LONG" as const };

    // Hydrate template if requested
    if (options.templateId) {
      const tmpl = await this.getTemplate(workspaceId, options.templateId);
      if (!tmpl) return { ok: false, error: "Prompt template not found", code: 404 };
      const hydrated = hydrateBounded(tmpl.template_text, options.variables ?? {}, MAX_PROMPT_CHARS);
      if (hydrated === null) return tooLong;
      finalPrompt = hydrated;
      model = options.model || tmpl.default_model;
      temperature = options.temperature ?? tmpl.temperature;
    }

    if (!finalPrompt.trim()) {
      return { ok: false, error: "Prompt cannot be empty", code: 400 };
    }
    if (finalPrompt.length > MAX_PROMPT_CHARS) return tooLong;

    const rate = this.rateFor(model);
    if (!rate) {
      return {
        ok: false,
        error: `Model "${model}" is not allowed (allowed: ${this.models.map((m) => m.id).join(", ")})`,
        code: 400,
        errorCode: "MODEL_NOT_ALLOWED",
      };
    }

    const maxTokens = options.maxTokens ?? this.maxTokensCap;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > this.maxTokensCap) {
      return { ok: false, error: `maxTokens must be a whole number from 1 to ${this.maxTokensCap}`, code: 400, errorCode: "INVALID_MAX_TOKENS" };
    }

    const providerChain = [...(this.defaultProvider ? [this.defaultProvider] : []), ...this.fallbackProviders];
    if (!providerChain.some((name) => this.adapterFor(name))) {
      const asked = providerChain.length > 0 ? providerChain.map((n) => `"${n}"`).join(", ") : "none";
      return {
        ok: false,
        error: `NOT_CONFIGURED: no LLM provider adapter is configured (requested: ${asked}). Connect a provider before generating.`,
        code: 503,
        errorCode: "NOT_CONFIGURED",
      };
    }

    const charger = this.billing === "wallet" ? this.charger : undefined;
    if (this.billing === "wallet" && !charger) {
      return {
        ok: false,
        error: 'BILLING_NOT_CONFIGURED: billing is "wallet" but no wallet is wired; add credit-wallet or set the billingMode setting to "none"',
        code: 503,
        errorCode: "BILLING_NOT_CONFIGURED",
      };
    }

    const logId = `ail_${crypto.randomUUID().replace(/-/g, "")}`;
    const promptCap = maxPromptTokens(finalPrompt);
    const reserved = costInCredits(rate, promptCap, maxTokens);
    const money: Money | undefined = charger
      ? { charger, workspaceId, userId, reserveKey: `ai:${logId}`, refundKey: `ai:${logId}:refund` }
      : undefined;
    const baseRow = {
      id: logId,
      user_id: userId,
      provider: providerChain[0]!.slice(0, 64),
      model: model.slice(0, 64),
      prompt_tokens: 0,
      completion_tokens: 0,
      latency_ms: 0,
    };

    // 4. Reserve the most the call can cost. The atomic debit is the balance check.
    let rowWritten = false;
    if (money) {
      const reservation = await this.reserve(money, reserved);
      if (reservation === "refused") {
        return { ok: false, error: `Insufficient credits: this call can cost up to ${reserved} credits`, code: 402, errorCode: "INSUFFICIENT_CREDITS" };
      }
      if (reservation === "unknown") {
        const correlationId = newCorrelationId();
        // Release whatever was taken: the refund pays back only what the debit under the reservation key took.
        const released = await this.release(money, reserved, correlationId);
        const held = released === "failed" ? reserved : 0;
        console.error(
          `llm-gateway: reserving credits failed [${correlationId}] log ${logId} workspace ${workspaceId} reserved ${reserved}; ` +
            (held > 0 ? `${held} may still be held` : "nothing is held"),
        );
        await this.insertLog(correlationId, workspaceId, { ...baseRow, cost_credits: held, billing_status: "billing_failed" });
        return { ok: false, error: "The generation could not be billed", code: 500, errorCode: "INTERNAL_ERROR", correlationId };
      }
      // 5. A record of the held credits exists before generation, so a cancelled call can be reconciled.
      rowWritten = await this.insertLog(newCorrelationId(), workspaceId, { ...baseRow, cost_credits: reserved, billing_status: "reserved" });
    }

    let lastError: unknown = null;
    let successfulProvider: LlmProviderAdapter | null = null;
    let completionOutput: { text: string; promptTokens: number; completionTokens: number; modelUsed: string } | null = null;
    const startTime = Date.now();

    for (const provName of providerChain) {
      const adapter = this.adapterFor(provName);
      if (!adapter) continue;
      try {
        completionOutput = await adapter.generate(finalPrompt, model, { temperature, maxTokens });
        successfulProvider = adapter;
        break; // Successfully generated!
      } catch (err: unknown) {
        lastError = err;
        // Fallback to next provider in chain
      }
    }

    if (!successfulProvider || !completionOutput) {
      const correlationId = newCorrelationId();
      // The provider's message can carry request details or a key; it goes to the log only, never to the caller.
      console.error(`llm-gateway: all providers failed [${correlationId}]`, errorText(lastError));
      if (money) {
        const released = (await this.release(money, reserved, correlationId)) === "refunded";
        await this.finishLog(correlationId, workspaceId, rowWritten, {
          ...baseRow,
          latency_ms: Date.now() - startTime,
          cost_credits: released ? 0 : reserved,
          billing_status: released ? "refunded" : "billing_failed",
        });
      }
      return { ok: false, error: PROVIDER_ERROR_MESSAGE, code: 502, errorCode: "PROVIDER_ERROR", correlationId };
    }

    const latencyMs = Date.now() - startTime;
    const promptTokens = wholeTokens(completionOutput.promptTokens);
    const completionTokens = wholeTokens(completionOutput.completionTokens);
    // 7. Priced at the allowlisted model the caller asked for, whatever name the provider reports back, and never above
    // the reservation: the billed tokens are capped at the estimate and at maxTokens.
    const costCredits = costInCredits(rate, Math.min(promptTokens, promptCap), Math.min(completionTokens, maxTokens));

    let billingStatus: BillingStatus = "not_billed";
    let costTaken = costCredits;
    const correlationId = newCorrelationId();
    if (money) {
      billingStatus = "charged";
      if (reserved > costCredits && (await this.release(money, reserved - costCredits, correlationId)) !== "refunded") {
        billingStatus = "refund_failed";
        costTaken = reserved;
      }
    }

    // A failed log write is logged but does not withhold the text the caller has paid for.
    await this.finishLog(correlationId, workspaceId, rowWritten, {
      ...baseRow,
      provider: successfulProvider.name.slice(0, 64),
      model: String(completionOutput.modelUsed).slice(0, 64),
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cost_credits: costTaken,
      latency_ms: latencyMs,
      billing_status: billingStatus,
    });

    const result: LlmResult = {
      text: completionOutput.text,
      provider: successfulProvider.name,
      model: completionOutput.modelUsed,
      promptTokens,
      completionTokens,
      costCredits: costTaken,
      latencyMs,
      billed: billingStatus !== "not_billed",
    };

    return { ok: true, result };
  }

  /**
   * Debits the reservation: "taken", "refused" (the wallet cannot cover it), or "unknown" (it may or may not have
   * committed). A throw is retried once with the same key; a refusal that follows a throw is checked on the ledger,
   * because the wallet checks the balance before the key and the thrown attempt may have committed.
   */
  private async reserve(money: Money, credits: number): Promise<"taken" | "refused" | "unknown"> {
    const errors: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let outcome: ChargeOutcome;
      try {
        outcome = await money.charger.debit(this.db, money.workspaceId, credits * MILLI_PER_CREDIT, money.reserveKey, "AI generation (reserved)", money.userId);
      } catch (err: unknown) {
        errors.push(err);
        continue;
      }
      if (outcome.ok) return "taken";
      if (errors.length === 0) return "refused";
      try {
        return (await money.charger.settled(this.db, money.workspaceId, money.reserveKey)) ? "taken" : "refused";
      } catch (err: unknown) {
        errors.push(err);
        return "unknown";
      }
    }
    console.error(`llm-gateway: reservation ${money.reserveKey} threw twice`, ...errors.map(errorText));
    return "unknown";
  }

  /**
   * Gives back up to `credits` of the reservation under the refund key: "refunded", "nothing" (no reservation was
   * recorded, so nothing is held) or "failed". A throw is retried once with the same key; after a second throw the
   * ledger says whether the refund happened.
   */
  private async release(money: Money, credits: number, correlationId: string): Promise<"refunded" | "nothing" | "failed"> {
    const errors: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const refunded = await money.charger.refund(
          this.db,
          money.workspaceId,
          credits * MILLI_PER_CREDIT,
          money.refundKey,
          money.reserveKey,
          "AI generation (unused reservation)",
          money.userId,
        );
        if (refunded.ok) return "refunded";
        if (refunded.code === "NOTHING_TO_REFUND") return "nothing";
        console.error(`llm-gateway: refunding ${credits} credits under ${money.refundKey} was refused [${correlationId}]`, refunded.code);
        return "failed";
      } catch (err: unknown) {
        errors.push(err);
      }
    }
    try {
      if (await money.charger.settled(this.db, money.workspaceId, money.refundKey)) return "refunded";
    } catch (err: unknown) {
      errors.push(err);
    }
    console.error(`llm-gateway: refunding ${credits} credits under ${money.refundKey} failed [${correlationId}]`, ...errors.map(errorText));
    return "failed";
  }

  /** Inserts a generation log row. True if written; a failure is logged with the correlation id and never thrown. */
  private async insertLog(correlationId: string, workspaceId: string, row: Omit<GenerationLogRecord, "workspace_id" | "created_at">): Promise<boolean> {
    try {
      await scoped(this.db, workspaceId).insert("ai_generation_logs", { ...row, created_at: new Date().toISOString() });
      return true;
    } catch (err: unknown) {
      console.error(`llm-gateway: writing generation log ${row.id} failed [${correlationId}]`, errorText(err));
      return false;
    }
  }

  /** Updates the reserved row (or inserts the row when it was never written). Failures are logged, never thrown. */
  private async finishLog(
    correlationId: string,
    workspaceId: string,
    rowWritten: boolean,
    row: Omit<GenerationLogRecord, "workspace_id" | "created_at">,
  ): Promise<void> {
    if (!rowWritten) {
      await this.insertLog(correlationId, workspaceId, row);
      return;
    }
    try {
      const { id, ...rest } = row;
      await scoped(this.db, workspaceId).update("ai_generation_logs", rest, "id = ?", [id]);
    } catch (err: unknown) {
      console.error(`llm-gateway: updating generation log ${row.id} to ${row.billing_status} failed [${correlationId}]`, errorText(err));
    }
  }

  /**
   * Computes aggregated usage telemetry for a workspace. Story 1.13: only generations that were delivered count
   * (charged, refund_failed and not_billed rows); reserved, refunded and billing_failed rows are left out of the totals
   * and the count.
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
      WHERE workspace_id = ? AND billing_status IN ('charged', 'refund_failed', 'not_billed')
    `, [workspaceId]).first<StatsRow>();

    return {
      totalPromptTokens: row?.total_prompt ?? 0,
      totalCompletionTokens: row?.total_comp ?? 0,
      totalCostCredits: row?.total_cost ?? 0,
      requestCount: row?.req_count ?? 0,
    };
  }
}

/** The money side of one call: the charger, whose wallet, and the call's two idempotency keys. */
interface Money {
  charger: CreditCharger;
  workspaceId: string;
  userId: string;
  reserveKey: string;
  refundKey: string;
}

/** A short id that ties a client's error answer to the server log line that has the details. */
export function newCorrelationId(): string {
  return `err_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** A provider's token count as a whole number of zero or more (a misbehaving adapter cannot make the cost negative). */
function wholeTokens(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
