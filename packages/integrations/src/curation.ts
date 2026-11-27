import { z } from "zod";
import {
  formatIssues,
  IntegrationAuthSchema,
  IntegrationErrorMappingsSchema,
  IntegrationIdempotencySchema,
  IntegrationOperationBodySchema,
  IntegrationOperationParamSchema,
  IntegrationOperationResponseSchema,
  IntegrationPaginationSchema,
  IntegrationRateLimitSchema,
  IntegrationTriggerSchema,
  IntegrationUiSchema,
  PredicateSchema,
} from "@poc/assembler";

export const CurationAcknowledgeSchema = z.strictObject({
  op: z.string().min(1),
  code: z.string().min(1),
  pointer: z.string().optional(),
  reason: z.string().min(10, "Acknowledgement reason must be at least 10 characters"),
});

export type CurationAcknowledge = z.infer<typeof CurationAcknowledgeSchema>;

export const CurationOperationOverlaySchema = z.strictObject({
  operationId: z.string().optional(),
  label: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  path: z.string().optional(),
  params: z.array(IntegrationOperationParamSchema).optional(),
  body: IntegrationOperationBodySchema.optional(),
  response: IntegrationOperationResponseSchema.optional(),
  pagination: IntegrationPaginationSchema.optional(),
  errorWhen: PredicateSchema.optional(),
  successWhen: PredicateSchema.optional(),
  rateLimit: IntegrationRateLimitSchema.optional(),
  idempotency: IntegrationIdempotencySchema.optional(),
  errorMappings: IntegrationErrorMappingsSchema.optional(),
  sideEffects: z.enum(["none", "read", "write"]).optional(),
});

export type CurationOperationOverlay = z.infer<typeof CurationOperationOverlaySchema>;

export const CurationUpstreamSchema = z.strictObject({
  corpusSpec: z.string().min(1),
  operationIds: z.record(z.string().min(1), z.string().min(1)),
});

export type CurationUpstream = z.infer<typeof CurationUpstreamSchema>;

export const CurationConfigSchema = z.strictObject({
  app: z.string().min(1),
  version: z.string().optional(),
  format: z.enum(["openapi3", "google-discovery", "swagger2"]).optional(),
  specProvenance: z.enum(["upstream", "hand-trimmed"]),
  upstream: CurationUpstreamSchema.optional(),
  ui: IntegrationUiSchema,
  auth: IntegrationAuthSchema,
  defaultHeaders: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().max(200)).optional(),
  baseUrl: z.string().min(1),
  allowedHosts: z.array(z.string()),
  includeOperations: z.array(z.string()).optional(),
  operations: z.union([z.record(z.string(), CurationOperationOverlaySchema), z.array(CurationOperationOverlaySchema)]).optional(),
  defaultRateLimit: IntegrationRateLimitSchema.optional(),
  triggers: z.array(IntegrationTriggerSchema).optional(),
  errorWhen: PredicateSchema.optional(),
  successWhen: PredicateSchema.optional(),
  errorMappings: IntegrationErrorMappingsSchema.optional(),
  acknowledge: z.array(CurationAcknowledgeSchema).optional(),
});

export type CurationConfig = z.infer<typeof CurationConfigSchema>;

export function parseCurationConfig(raw: unknown): CurationConfig {
  const parsed = CurationConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = formatIssues(parsed.error);
    const appName = typeof (raw as any)?.app === "string" ? (raw as any).app : "unknown";
    throw new Error(`OPENAPI_IMPORT_CURATION_INVALID (${appName}): Invalid curation configuration:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}
