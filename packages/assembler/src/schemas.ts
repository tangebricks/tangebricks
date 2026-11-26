import { z } from "zod";
import { isForbiddenIntegrationHost } from "@poc/sdk";
import { compare } from "./semver.ts";

// Everything the assembler reads is checked here first, and everything it writes into source text comes from a value
// that passed one of these patterns. Nothing in this package knows any particular brick: a brick describes itself in
// a brick.manifest.json that has to satisfy ManifestSchema.

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BRICK_ID = /^[a-z][a-z0-9-]{0,39}$/;
const CAPABILITY = /^[a-z][a-z0-9-]{0,39}$/;
const PROVIDES_ITEM = /^[a-z][a-z0-9-]{0,39}(?:@\d+\.\d+\.\d+)?$/;
const REQUIRES_ITEM = /^[a-z][a-z0-9-]{0,39}(?:@(?:\*|\^?\d+\.\d+\.\d+|~?\d+\.\d+\.\d+|>=?\d+\.\d+\.\d+|<=?\d+\.\d+\.\d+|>|\^|~|>=|<=|<))?$/;
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9-]{0,39}\/)?[a-z0-9][a-z0-9-]{0,39}$/;
const MOUNT_PATH = /^\/[A-Za-z0-9/_*-]{0,100}$/;
// A guard path may also contain the token {entity}, which stands for each declared entity's name in turn.
const GUARD_PATH = /^\/(?:[A-Za-z0-9/_*-]|\{entity\}){0,100}$/;
const ROUTE_PREFIX = /^[a-z][a-z0-9_-]{0,39}$/;
const RATE_LIMIT_PATH = /^(?:\/(?:[a-z0-9][a-z0-9_-]{0,39}|:[A-Za-z][A-Za-z0-9_]{0,39})){1,8}$/;
const RATE_LIMIT_BUCKET = /^[a-z][a-z0-9-]{0,63}$/;
const RATE_LIMIT_FIELD_OR_PARAM_KEY = /^(?:field|param):[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const RELATIVE_FILE = /^[a-z0-9][a-z0-9_./-]{0,100}\.sql$/;
const RELATIVE_TEST_FILE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_./-]{0,120}\.test\.ts$/;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9 &(),.:;/_'+=%>@-]{0,199}$/;
/** One `ui.keywords` entry: a lowercase word of 1 to 24 letters, digits or dashes. */
const BRICK_KEYWORD = /^[a-z0-9][a-z0-9-]{0,23}$/;
const CRON_EXPRESSION = /^[0-9*,/-]+(?: [0-9*,/-]+){4}$/;
const CAPABILITY_EXPORT = /^[a-z][a-z0-9-]{0,39}\.[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const identifier = z.string().regex(IDENTIFIER);
export const brickId = z.string().regex(BRICK_ID);
export const capability = z.string().regex(CAPABILITY);
export const providesItem = z.string().regex(PROVIDES_ITEM);
export const requiresItem = z.string().regex(REQUIRES_ITEM);
const mountPath = z.string().regex(MOUNT_PATH);

export const BRICK_CATEGORIES = [
  "identity",
  "billing",
  "data",
  "automation",
  "communication",
  "ai",
  "developer",
  "governance",
] as const;
export const brickCategory = z.enum(BRICK_CATEGORIES);
export type BrickCategory = z.infer<typeof brickCategory>;

export const BRICK_MATURITIES = ["production", "beta", "experimental"] as const;
export const brickMaturity = z.enum(BRICK_MATURITIES);
export type BrickMaturity = z.infer<typeof brickMaturity>;

export const BINDING_TYPES = [
  "d1",
  "r2",
  "kv",
  "queue",
  "service",
  "ai",
  "vectorize",
  "durable_object",
] as const;
export const bindingType = z.enum(BINDING_TYPES);
export type BindingType = z.infer<typeof bindingType>;

/**
 * Story 1.20: a condition on one of the brick's own settings: it holds while the setting `equals` a value, or while it
 * has any value other than `notEquals` (for example `{ "setting": "someSetting", "notEquals": "" }`: "while set").
 */
export const settingCondition = z.union([
  z.strictObject({ setting: z.string().regex(IDENTIFIER), equals: z.union([z.number().finite(), z.string().max(200), z.boolean()]) }),
  z.strictObject({ setting: z.string().regex(IDENTIFIER), notEquals: z.union([z.number().finite(), z.string().max(200), z.boolean()]) }),
]);
export type SettingCondition = z.infer<typeof settingCondition>;

/** A value placed in a route factory's options: a literal, a setting, a call of an imported function with no arguments, or the blueprint's declared entities. */
export const valueExpr = z.union([
  z.number().finite(),
  z.string().max(200),
  z.boolean(),
  /**
   * A setting's resolved value. Story 1.20: with `requiredWhen`, the option is passed only while that condition on the
   * brick's settings holds, and left out otherwise (so turning a feature on adds the option without changing the
   * assembled code of an app that leaves it off).
   */
  z.strictObject({ $setting: z.string().regex(IDENTIFIER), requiredWhen: settingCondition.optional() }),
  z.strictObject({ $call: identifier }),
  /** The entities the owner declared, passed in as data (the assembler writes them to entities.json). */
  z.strictObject({ $entities: z.literal(true) }),
  z.strictObject({ $privacy: z.enum(["exportTenant", "eraseTenant"]) }),
  /**
   * The assembled app's generated workspace-data purge (story 1.10): `purgeWorkspaceData(env, workspaceId)` deletes a
   * workspace's objects under every declared prefix and its rows in every declared table.
   */
  z.strictObject({ $workspaceData: z.literal("purgeWorkspaceData") }),
  /**
   * Story 1.13: a named export of whichever enabled brick provides a capability, written `<capability>.<export>`
   * (for example `some-capability.someExport`). The assembler imports that export from the provider's package, so the
   * brick that takes it never imports the provider itself. With no provider enabled the blueprint is refused, unless
   * `requiredWhen` names a condition on a setting of this brick that does not hold (it differs from `equals`, or story
   * 1.20, it is `notEquals`); then the option is left out.
   */
  z.strictObject({
    $capability: z.string().regex(CAPABILITY_EXPORT),
    /**
     * Story 2.6: `"provided"` makes the option optional on the provider: it is wired whenever an enabled brick provides
     * the capability (and checked like any other `$capability`), and left out, never refused, when none does.
     */
    requiredWhen: z.union([settingCondition, z.literal("provided")]).optional(),
  }),
  /**
   * Story 2.6: the value of a setting of whichever enabled brick provides a capability, written `<capability>.<setting>`
   * (for example `some-capability.someSetting`), so a brick that takes that provider's export can keep the provider's own
   * rule. Left out when no enabled brick provides the capability; refused at assembly when the provider has no such setting.
   */
  z.strictObject({ $capabilitySetting: z.string().regex(CAPABILITY_EXPORT) }),
]);

const JS_RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for function if " +
    "import in instanceof new null return super switch this throw true try typeof var void while with yield let static " +
    "implements interface package private protected public await arguments eval undefined NaN Infinity"
  ).split(" "),
);
/** Names the assembled entry (src/index.ts) binds itself; an imported export with one of these names would clash. */
const ENTRY_BINDINGS = new Set([
  "Hono", "app", "entities", "openapiSpec", "exportTenant", "eraseTenant", "purgeWorkspaceData", "stubIdentity",
  "createHttpGuard", "rateLimit", "tableName", "D1Like", "scheduled", "queue", "suspensionExempt", "BUILD_SHA",
  "MIGRATIONS", "REQUIRED_BINDINGS", "SUSPENSION_EXEMPT", "WORKSPACE_ID_PATTERN", "WORKSPACE_PURGE_SQL",
  "WORKSPACE_PURGE_SHELL_SQL", "WORKSPACE_PURGE_BRICK_SQL", "WORKSPACE_PURGE_OBJECTS",
]);

/** Why an export name cannot be imported into the assembled entry, or undefined if it can (story 1.13). */
export function entryBindingClash(name: string): string | undefined {
  if (JS_RESERVED.has(name)) return "it is a JavaScript reserved word";
  if (ENTRY_BINDINGS.has(name) || name.startsWith("notSuspended_")) return "the entry already defines that name";
  return undefined;
}

/** Splits a `$capability` reference into the capability name and the provider's export. */
export function capabilityReference(ref: string): { capability: string; export: string } {
  const dot = ref.indexOf(".");
  return { capability: ref.slice(0, dot), export: ref.slice(dot + 1) };
}
export type ValueExpr = z.infer<typeof valueExpr>;

export const settingDeprecated = z.strictObject({
  since: z.string().regex(EXACT_VERSION),
  replacedBy: z.string().regex(IDENTIFIER).optional(),
  removeIn: z.string().regex(EXACT_VERSION).optional(),
});
export type SettingDeprecated = z.infer<typeof settingDeprecated>;

export const settingDefinition = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("integer"),
    min: z.number().int(),
    max: z.number().int(),
    default: z.number().int(),
    since: z.string().regex(EXACT_VERSION).optional(),
    deprecated: settingDeprecated.optional(),
  }),
  z.strictObject({
    type: z.literal("enum"),
    values: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,30}$/)).min(1).max(20),
    default: z.string(),
    since: z.string().regex(EXACT_VERSION).optional(),
    deprecated: settingDeprecated.optional(),
  }),
  z.strictObject({
    type: z.literal("boolean"),
    default: z.boolean(),
    since: z.string().regex(EXACT_VERSION).optional(),
    deprecated: settingDeprecated.optional(),
  }),
  z.strictObject({
    type: z.literal("string"),
    format: z.enum(["url", "identifier", "claim-path"]).optional(),
    /**
     * Story 1.13: a whole-value regular expression (anchor it with ^ and $) the value must match, checked at assembly so
     * a malformed value is refused there rather than at run time. `example` is shown in the refusal.
     */
    pattern: z.string().min(1).max(1000).optional(),
    example: z.string().max(200).optional(),
    maxLength: z.number().int().positive().max(512).default(512),
    default: z.string().max(512),
    since: z.string().regex(EXACT_VERSION).optional(),
    deprecated: settingDeprecated.optional(),
  }),
]);
export type SettingDefinition = z.infer<typeof settingDefinition>;

export const routeDefinition = z.strictObject({
  factory: identifier,
  mountAt: mountPath,
  options: z.record(identifier, valueExpr).default({}),
  /** Paths the guard for `guardWith` is mounted at, in front of this route. `{entity}` expands to each declared entity. */
  guardPaths: z.array(z.string().regex(GUARD_PATH)).default([]),
  guardWith: capability.optional(),
});
export type RouteDefinition = z.infer<typeof routeDefinition>;

const adapterDefinition = z.strictObject({
  default: z.enum(["real", "fake"]),
  reason: z.string().optional(),
});
export type BrickAdapterDefinition = z.infer<typeof adapterDefinition>;

const uiDefinition = z.strictObject({
  displayName: z.string().min(1).max(80).regex(SAFE_TEXT),
  category: brickCategory,
  summary: z.string().min(1).max(140).regex(SAFE_TEXT),
  maturity: brickMaturity.optional(),
  maturityReason: z.string().min(1).max(200).regex(SAFE_TEXT).optional(),
  behaviourTest: z.string().regex(RELATIVE_TEST_FILE).optional(),
  adapters: z.record(identifier, adapterDefinition).optional(),
  /**
   * Plain words agents search with that the summary may not contain ("teams", "database", "payments"). Brick search
   * (MCP `search_bricks` / `list_bricks`) matches a query word that is a keyword or the start of one.
   */
  keywords: z
    .array(z.string().regex(BRICK_KEYWORD))
    .max(12)
    .refine((words) => new Set(words).size === words.length, "ui.keywords must not repeat a word")
    .optional(),
});
export type BrickUiDefinition = z.infer<typeof uiDefinition>;

const scheduleTriggerDefinition = z.strictObject({
  id: z.string().regex(ROUTE_PREFIX),
  cron: z.string().max(64).regex(CRON_EXPRESSION),
  handler: identifier,
  /**
   * Story 1.20: values handed to the handler as `options`, written and resolved exactly like route options (`$setting`,
   * `$capability`, ...). A schedule without options is called exactly as before.
   */
  options: z.record(identifier, valueExpr).optional(),
  /**
   * Story 1.20: the schedule is wired only while this condition on the brick's settings holds. When it does not, the
   * app is assembled as if the brick declared no such schedule (no cron, no handler call).
   */
  enabledWhen: settingCondition.optional(),
});

const queueTriggerDefinition = z.strictObject({
  id: z.string().regex(ROUTE_PREFIX),
  handler: identifier,
  maxBatch: z.number().int().min(1).max(100).optional(),
  dlq: z.boolean().optional(),
});

const triggersDefinition = z.strictObject({
  schedules: z.array(scheduleTriggerDefinition).optional(),
  queues: z.array(queueTriggerDefinition).optional(),
});
export type BrickTriggersDefinition = z.infer<typeof triggersDefinition>;

/**
 * A rate-limited route (story 0.21): `path` is relative to the brick's mount, like `routePrefixes`, and may name route
 * params (`/webhooks/in/:subscriptionId`). The assembler mounts the SDK limiter on it, ahead of the brick's routes.
 */
const rateLimitDefinition = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().regex(RATE_LIMIT_PATH),
  bucket: z.string().regex(RATE_LIMIT_BUCKET),
  limit: z.number().int().positive().max(1_000_000),
  windowSeconds: z.number().int().positive().max(86_400),
  key: z.union([z.enum(["ip", "workspace", "user"]), z.string().regex(RATE_LIMIT_FIELD_OR_PARAM_KEY)]),
  failClosed: z.boolean().optional(),
});
export type BrickRateLimitDefinition = z.infer<typeof rateLimitDefinition>;

const conflictDefinition = z.strictObject({
  brick: brickId,
  reason: z.string().min(1).max(200).regex(SAFE_TEXT),
});
export type BrickConflictDefinition = z.infer<typeof conflictDefinition>;

const globalTableDefinition = z.strictObject({
  table: identifier,
  reason: z.string().min(1).max(200).regex(SAFE_TEXT),
});
export type GlobalTableDefinition = z.infer<typeof globalTableDefinition>;

export const privacyTableDefinition = z.strictObject({
  subject: z.enum(["workspace", "user"]),
  userColumn: identifier.optional(),
  erase: z.enum(["delete", "anonymize", "retain"]),
  anonymize: z.array(identifier).optional(),
  retainReason: z.string().min(1).max(500).optional(),
  export: z.boolean(),
  /**
   * Story 2.6: the table has no workspace_id (a platform-wide record about a user, such as an approval decision). Only
   * `subject: "user"` with a `userColumn` and `erase: "retain"` is accepted: a user's export includes their rows, and
   * an erasure reports the table as retained.
   */
  platformWide: z.literal(true).optional(),
});
export type PrivacyTableDefinition = z.infer<typeof privacyTableDefinition>;

export const privacyDefinition = z.strictObject({
  tables: z.record(identifier, privacyTableDefinition).default({}),
  hookTables: z.array(identifier).optional(),
});
export type PrivacyDefinition = z.infer<typeof privacyDefinition>;

/**
 * The brick's per-workspace rows (story 1.10): every table that holds rows for one workspace (each must have a
 * `workspace_id` column). When a workspace is deleted, the assembled app deletes its rows from each declared table, or
 * for a `tombstone` table (kept for audit) sets `deleted_at` when the table has that column and otherwise keeps the
 * rows as they are. A tenant table the brick does not want purged is listed in `exempt` with a reason.
 */
export const workspaceDataDefinition = z.strictObject({
  tables: z.array(z.strictObject({ table: identifier, tombstone: z.boolean().optional() })).default([]),
  exempt: z.array(z.strictObject({ table: identifier, reason: z.string().min(1).max(200).regex(SAFE_TEXT) })).optional(),
  /**
   * Object-store prefixes holding one workspace's objects, in a binding the brick declares. `{workspaceId}` must be
   * followed by "/", so one workspace's prefix never covers another's. Deleted before the rows.
   */
  objectPrefixes: z
    .array(z.strictObject({ binding: identifier, prefix: z.string().max(200).regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/\{workspaceId\}\/(?:[A-Za-z0-9_.-]+\/)*$/) }))
    .optional(),
});
export type WorkspaceDataDefinition = z.infer<typeof workspaceDataDefinition>;

export const workerPrivacyDefinition = z.strictObject({
  exportTenant: identifier.optional(),
  eraseTenant: identifier.optional(),
});
export type WorkerPrivacyDefinition = z.infer<typeof workerPrivacyDefinition>;

const bindingsDefinition = z.union([
  z.array(identifier),
  z.record(identifier, bindingType),
]);

export const NODE_PORT_DATA_TYPES = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "any",
] as const;
export const nodePortDataType = z.enum(NODE_PORT_DATA_TYPES);
export type NodePortDataType = z.infer<typeof nodePortDataType>;

export const nodePortDefinition = z.strictObject({
  id: identifier,
  label: z.string().optional(),
  dataType: nodePortDataType,
  required: z.boolean().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).max(256).optional(),
  default: z.unknown().optional(),
});
export type NodePortDefinition = z.infer<typeof nodePortDefinition>;

export const nodeDefinition = z.strictObject({
  type: z
    .string()
    .regex(
      /^(?:[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*|core\.[a-z][a-z0-9_]*|int:[a-z0-9-]+\.[A-Za-z0-9_]+)$/,
    ),
  label: z.string().min(1).max(80),
  summary: z.string().max(140).optional(),
  role: z.enum(["trigger", "action", "logic"]),
  inputs: z.array(nodePortDefinition),
  outputs: z.array(nodePortDefinition),
  config: z.record(identifier, settingDefinition).default({}),
  secrets: z.array(identifier).optional(),
  bindings: z.array(identifier).optional(),
  executor: z.string().min(1),
  durable: z.boolean().default(true),
  sideEffects: z.enum(["none", "read", "write"]),
  idempotent: z.boolean().optional(),
  retry: z.strictObject({ limit: z.number().int().min(0).max(10).optional() }).optional(),
  availability: z.enum(["available", "unsupported"]).optional(),
});
export type ManifestNodeDefinition = z.infer<typeof nodeDefinition>;

export const NodePackManifestSchema = z.strictObject({
  manifestVersion: z.literal(2),
  kind: z.literal("node-pack"),
  id: brickId,
  version: z.string().regex(EXACT_VERSION),
  package: z.string().regex(PACKAGE_NAME),
  ui: uiDefinition,
  nodes: z.array(nodeDefinition).min(1),
});
export type NodePackManifestFile = z.infer<typeof NodePackManifestSchema>;

// Host rules live in @poc/sdk (egress-guard.ts) so the runtime egress guard and manifest validation share one source.
export { isForbiddenIntegrationHost };

const integrationUiObjectSchema = z.strictObject({
  displayName: z.string().min(1).max(80),
  category: brickCategory.default("communication"),
  icon: z.string().min(1).max(120).optional(),
  docsUrl: z.string().url().startsWith("https://").optional(),
  summary: z.string().min(1).max(200),
  maturity: brickMaturity,
  maturityReason: z.string().min(1).max(200).optional(),
  behaviourTest: z.string().regex(RELATIVE_TEST_FILE).optional(),
});

export const IntegrationUiSchema = z.preprocess((val) => {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return val;
  const raw = { ...(val as Record<string, unknown>) };
  if (raw.displayName === undefined && typeof raw.title === "string") {
    raw.displayName = raw.title;
    delete raw.title;
  }
  if (raw.summary === undefined && typeof raw.description === "string") {
    raw.summary = raw.description;
    delete raw.description;
  }
  return raw;
}, integrationUiObjectSchema);
export type IntegrationUiDefinition = z.infer<typeof IntegrationUiSchema>;

export const IntegrationAuthSchema = z.strictObject({
  type: z.enum(["oauth2", "apiKey", "basic", "none", "headers"]),
  scopes: z.array(z.string().min(1).max(120)).optional(),
  authorizeUrl: z.string().url().startsWith("https://").optional(),
  tokenUrl: z.string().url().startsWith("https://").optional(),
  headerName: z.string().min(1).max(100).optional(),
  prefix: z.string().max(60).optional(),
  in: z.enum(["header", "query"]).optional(),
  queryParam: z.string().min(1).max(100).optional(),
  headers: z
    .record(
      z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
      z
        .string()
        .max(500)
        .regex(/^(?:[^{}]|\{\{conn\.[A-Za-z_][A-Za-z0-9_]{0,63}\}\})*$/),
    )
    .optional(),
  schemes: z
    .record(
      z.string(),
      z.strictObject({
        type: z.enum(["apiKey", "http", "oauth2", "openIdConnect", "mutualTLS"]),
        in: z.enum(["header", "query", "cookie"]).optional(),
        name: z.string().optional(),
        scheme: z.string().optional(),
        bearerFormat: z.string().optional(),
      }),
    )
    .optional(),
  requirements: z
    .array(
      z.array(
        z.strictObject({
          scheme: z.string(),
          scopes: z.array(z.string()).optional(),
        }),
      ),
    )
    .optional(),
  connectionFields: z.array(z.string().regex(IDENTIFIER)).optional(),
});
export type IntegrationAuthDefinition = z.infer<typeof IntegrationAuthSchema>;

export function extractAuthConnectionFields(auth?: IntegrationAuthDefinition | null): string[] {
  if (!auth) return [];
  if (Array.isArray(auth.connectionFields) && auth.connectionFields.length > 0) {
    return [...auth.connectionFields];
  }
  const fields = new Set<string>();
  if (auth.type === "headers" && auth.headers) {
    const regex = /\{\{conn\.([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g;
    for (const val of Object.values(auth.headers)) {
      let m: RegExpExecArray | null;
      while ((m = regex.exec(val)) !== null) {
        if (m[1]) fields.add(m[1]);
      }
    }
  } else if (auth.type === "apiKey") {
    fields.add("apiKey");
  } else if (auth.type === "basic") {
    fields.add("username");
    fields.add("password");
  } else if (auth.type === "oauth2") {
    fields.add("token");
  }
  return [...fields].sort();
}

export const IntegrationOperationParamSchema = z.strictObject({
  name: z.string().regex(IDENTIFIER),
  wireName: z.string().min(1).max(256).optional(),
  in: z.enum(["path", "query", "header", "cookie"]),
  dataType: nodePortDataType,
  required: z.boolean().optional(),
  description: z.string().max(200).optional(),
  sensitive: z.boolean().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).max(256).optional(),
  default: z.unknown().optional(),
  items: z
    .strictObject({
      dataType: nodePortDataType,
      enum: z.array(z.union([z.string(), z.number(), z.boolean()])).max(256).optional(),
    })
    .optional(),
  style: z
    .enum([
      "form",
      "simple",
      "spaceDelimited",
      "pipeDelimited",
      "deepObject",
      "label",
      "matrix",
    ])
    .optional(),
  explode: z.boolean().optional(),
  allowReserved: z.boolean().optional(),
});
export type IntegrationOperationParam = z.infer<typeof IntegrationOperationParamSchema>;

export interface FieldSchema {
  dataType: NodePortDataType;
  required?: string[];
  enum?: (string | number | boolean)[];
  default?: unknown;
  properties?: Record<string, FieldSchema>;
  items?: FieldSchema;
  variants?: FieldSchema[];
  discriminator?: string;
  additionalProperties?: boolean;
}

export const FieldSchemaZod: z.ZodType<FieldSchema> = z
  .lazy(() =>
    z.strictObject({
      dataType: nodePortDataType,
      required: z.array(z.string().min(1).max(256)).optional(),
      enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
      default: z.unknown().optional(),
      properties: z.record(z.string().min(1).max(256), z.lazy(() => FieldSchemaZod)).optional(),
      items: z.lazy(() => FieldSchemaZod).optional(),
      variants: z.array(z.lazy(() => FieldSchemaZod)).optional(),
      discriminator: z.string().min(1).max(120).optional(),
      additionalProperties: z.boolean().optional(),
    }),
  )
  .superRefine((val, ctx) => {
    let totalNodes = 0;
    function checkDepth(node: FieldSchema, depth: number): void {
      totalNodes++;
      if (totalNodes > 200) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "FieldSchema exceeds maximum node count of 200",
        });
        return;
      }
      if (depth > 8) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "FieldSchema exceeds maximum recursion depth of 8",
        });
        return;
      }
      if (node.properties) {
        for (const child of Object.values(node.properties)) {
          checkDepth(child, depth + 1);
        }
      }
      if (node.items) {
        checkDepth(node.items, depth + 1);
      }
      if (node.variants) {
        for (const variant of node.variants) {
          checkDepth(variant, depth + 1);
        }
      }
    }
    checkDepth(val, 1);
  });

export const IntegrationOperationBodyFieldSchema = z.strictObject({
  name: z.string().regex(IDENTIFIER),
  wireName: z.string().min(1).max(256).optional(),
  dataType: nodePortDataType,
  required: z.boolean().optional(),
  description: z.string().max(200).optional(),
  sensitive: z.boolean().optional(),
  binary: z.boolean().optional(),
  schema: FieldSchemaZod.optional(),
});
export type IntegrationOperationBodyField = z.infer<typeof IntegrationOperationBodyFieldSchema>;

const integrationOperationBodyObjectSchema = z.strictObject({
  contentType: z
    .enum([
      "application/json",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "multipart/related",
      "application/octet-stream",
      "text/plain",
    ])
    .optional(),
  fields: z.array(IntegrationOperationBodyFieldSchema).optional(),
  root: z
    .strictObject({
      dataType: z.enum(["array", "object", "any", "string"]),
      schema: FieldSchemaZod.optional(),
    })
    .optional(),
  encoding: z
    .record(
      z.string(),
      z.strictObject({
        style: z.enum(["form", "deepObject"]),
        explode: z.boolean().optional(),
      }),
    )
    .optional(),
});

export const IntegrationOperationBodySchema = integrationOperationBodyObjectSchema.superRefine(
  (data, ctx) => {
    const hasFields = Array.isArray(data.fields) && data.fields.length > 0;
    const hasRoot = Boolean(data.root);
    if (!((hasFields && !hasRoot) || (!hasFields && hasRoot))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "IntegrationOperationBody must specify exactly one of non-empty 'fields' or 'root'",
      });
    }
  },
);
export type IntegrationOperationBody = z.infer<typeof IntegrationOperationBodySchema>;

export const IntegrationOperationResponseSchema = z.strictObject({
  dataPath: z.string().max(120).optional(),
  status: z.number().int().min(100).max(599).optional(),
  contentType: z.string().min(1).max(120).optional(),
  binary: z.boolean().optional(),
  maxBytes: z.number().int().min(1).max(100 * 1024 * 1024).optional(),
  outputs: z.array(nodePortDefinition).optional(),
  errorShape: z
    .strictObject({
      codePath: z.string().max(120).optional(),
      messagePath: z.string().max(120).optional(),
      typePath: z.string().max(120).optional(),
    })
    .optional(),
});
export type IntegrationOperationResponse = z.infer<typeof IntegrationOperationResponseSchema>;

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const DOT_PATH_IDENTIFIER = /^[A-Za-z0-9_$-]+$/;

function isValidDotPath(p: string): boolean {
  if (typeof p !== "string" || p.trim().length === 0 || p.length > 120) return false;
  const segments = p.split(".");
  for (const seg of segments) {
    if (seg.length === 0 || FORBIDDEN_PATH_SEGMENTS.has(seg) || !DOT_PATH_IDENTIFIER.test(seg)) {
      return false;
    }
  }
  return true;
}

const PredicateDotPathSchema = z.string().min(1).max(120).refine(isValidDotPath, {
  message: "Invalid dot path: must contain valid segments and not access __proto__, constructor, or prototype",
});

const PredicatePrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const PredicateLeafEqualsSchema = z.strictObject({
  path: PredicateDotPathSchema,
  equals: PredicatePrimitiveSchema,
});

const PredicateLeafInSchema = z.strictObject({
  path: PredicateDotPathSchema,
  in: z.array(PredicatePrimitiveSchema).min(1),
});

const PredicateLeafExistsSchema = z.strictObject({
  path: PredicateDotPathSchema,
  exists: z.boolean(),
});

export type Predicate =
  | { path: string; equals: string | number | boolean | null }
  | { path: string; in: (string | number | boolean | null)[] }
  | { path: string; exists: boolean }
  | { all: Predicate[] }
  | { any: Predicate[] };

export const PredicateSchema: z.ZodType<Predicate> = z
  .lazy(() =>
    z.union([
      PredicateLeafEqualsSchema,
      PredicateLeafInSchema,
      PredicateLeafExistsSchema,
      z.strictObject({
        all: z.array(PredicateSchema).min(1),
      }),
      z.strictObject({
        any: z.array(PredicateSchema).min(1),
      }),
    ]),
  )
  .superRefine((val, ctx) => {
    function getDepth(p: Predicate): number {
      if ("all" in p) {
        return 1 + Math.max(0, ...p.all.map(getDepth));
      }
      if ("any" in p) {
        return 1 + Math.max(0, ...p.any.map(getDepth));
      }
      return 0;
    }
    if (getDepth(val) > 2) {
      ctx.addIssue({
        code: "custom",
        message: "Predicate depth must not exceed 2",
      });
    }
  });

export const IntegrationPaginationSchema = z.strictObject({
  style: z.enum([
    "cursor",
    "page",
    "link",
    "offset",
    "bodyNextUrl",
    "headerToken",
    "lastItemCursor",
  ]),
  paramName: z.string().regex(IDENTIFIER).optional(),
  responsePath: z.string().min(1).max(120),
  nextCursorPath: z.string().min(1).max(120).optional(),
  maxPages: z.number().int().min(1).max(100).default(5),
  limitParam: z.string().regex(IDENTIFIER).optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
  nextUrlPath: z.string().min(1).max(120).optional(),
  tokenHeader: z.string().min(1).max(100).optional(),
  itemIdPath: z.string().min(1).max(120).optional(),
  hasMorePath: z.string().min(1).max(120).optional(),
});
export type IntegrationPagination = z.infer<typeof IntegrationPaginationSchema>;

export const IntegrationRateLimitSchema = z.strictObject({
  maxRetries: z.number().int().min(0).max(5).default(3),
  initialBackoffMs: z.number().int().min(0).max(60000).default(250),
  baseBackoffMs: z.number().int().min(0).max(60000).optional(),
  respectRetryAfter: z.boolean().default(true),
  retryAfterHeader: z.string().min(1).max(100).optional(),
  maxRetryAfterMs: z.number().int().min(0).max(300000).optional(),
});
export type IntegrationRateLimit = z.infer<typeof IntegrationRateLimitSchema>;

export const IntegrationIdempotencySchema = z.strictObject({
  header: z.string().min(1).max(100),
});
export type IntegrationIdempotency = z.infer<typeof IntegrationIdempotencySchema>;

export const IntegrationErrorMappingSchema = z.strictObject({
  status: z.number().int().min(100).max(599).optional(),
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(200).optional(),
  hint: z.string().min(1).max(240).optional(),
  retryable: z.boolean().optional(),
  retryAfterHeader: z.string().min(1).max(100).optional(),
});
export type IntegrationErrorMapping = z.infer<typeof IntegrationErrorMappingSchema>;

export const IntegrationErrorMappingsSchema = z.union([
  z.array(IntegrationErrorMappingSchema),
  z.record(z.string().regex(/^\d{3}$/), IntegrationErrorMappingSchema),
]);
export type IntegrationErrorMappings = z.infer<typeof IntegrationErrorMappingsSchema>;

const integrationOperationObjectSchema = z.strictObject({
  operationId: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  label: z.string().min(1).max(80),
  summary: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(240),
  security: z
    .array(
      z.array(
        z.strictObject({
          scheme: z.string(),
          scopes: z.array(z.string()).optional(),
        }),
      ),
    )
    .optional(),
  params: z.array(IntegrationOperationParamSchema).optional(),
  body: IntegrationOperationBodySchema.optional(),
  response: IntegrationOperationResponseSchema.default({}),
  pagination: IntegrationPaginationSchema.optional(),
  errorWhen: PredicateSchema.optional(),
  successWhen: PredicateSchema.optional(),
  rateLimit: IntegrationRateLimitSchema.optional(),
  idempotency: IntegrationIdempotencySchema.optional(),
  errorMappings: IntegrationErrorMappingsSchema.optional(),
  sideEffects: z.enum(["none", "read", "write"]),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  maxResponseBytes: z.number().int().min(1).max(50 * 1024 * 1024).optional(),
});

export const IntegrationOperationSchema = z.preprocess((val) => {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return val;
  const raw = { ...(val as Record<string, unknown>) };
  if (raw.operationId === undefined && typeof raw.id === "string") {
    raw.operationId = raw.id;
    delete raw.id;
  }
  if (raw.label === undefined && typeof raw.summary === "string") {
    raw.label = raw.summary.slice(0, 80);
  }
  if (raw.sideEffects === undefined && typeof raw.method === "string") {
    raw.sideEffects = raw.method === "GET" ? "read" : "write";
  }
  if (raw.response === undefined) {
    raw.response = {};
  }
  return raw;
}, integrationOperationObjectSchema);
export type IntegrationOperation = z.infer<typeof IntegrationOperationSchema>;

export const WebhookSignatureSchemeSchema = z
  .strictObject({
    algorithm: z.enum(["hmac-sha256", "hmac-sha1", "hmac-sha512", "ed25519"]),
    signedPayload: z.string().min(1),
    signatureHeader: z.string().min(1).max(100),
    timestampHeader: z.string().min(1).max(100).optional(),
    idHeader: z.string().min(1).max(100).optional(),
    encoding: z.enum(["hex", "base64"]),
    prefix: z.string().optional(),
    signatureFormat: z
      .strictObject({
        kind: z.literal("kv-list"),
        pairSeparator: z.string().min(1),
        kvSeparator: z.string().min(1),
        timestampKey: z.string().min(1).optional(),
        signatureKey: z.string().min(1),
      })
      .optional(),
    toleranceSec: z.number().int().min(0).max(3600).optional(),
    secretEncoding: z.enum(["utf8", "base64", "hex"]).optional(),
    publicKey: z.string().min(1).max(128).optional(),
  })
  .superRefine((val, ctx) => {
    const allowedTokens = new Set(["body", "timestamp", "id", "url"]);
    const tokenRegex = /\{([^}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(val.signedPayload)) !== null) {
      const token = match[1];
      if (!token || !allowedTokens.has(token)) {
        ctx.addIssue({
          code: "custom",
          path: ["signedPayload"],
          message: `WEBHOOK_SCHEME_UNKNOWN_TOKEN: unknown token "{${token ?? ""}}" in signedPayload template`,
        });
      }
    }
    const literalsOnly = val.signedPayload.replace(/\{[^}]+\}/g, "");
    if (literalsOnly.length > 0 && !/^[A-Za-z0-9:._-]*$/.test(literalsOnly)) {
      ctx.addIssue({
        code: "custom",
        path: ["signedPayload"],
        message: "signedPayload template contains invalid literal characters: must match [A-Za-z0-9:._-]",
      });
    }
  });
export type WebhookSignatureScheme = z.infer<typeof WebhookSignatureSchemeSchema>;

export const WebhookVerifierPresetSchema = z.enum([
  "hmac-sha256",
  "stripe-signature",
  "stripe-v1",
  "shared-secret",
  "ed25519",
  "slack-v0",
  "github-hmac-sha256",
  "meta-hub-signature-256",
  "meta-sha256",
  "discord-ed25519",
  "hmac-sha256-timestamp-body-base64",
  "timestamp-body-base64",
]);
export type WebhookVerifierPreset = z.infer<typeof WebhookVerifierPresetSchema>;

export const IntegrationTriggerSchema = z.preprocess(
  (val) => {
    if (val && typeof val === "object" && !("signatureHeader" in val)) {
      const v = val as { verifier?: unknown };
      if (
        v.verifier &&
        typeof v.verifier === "object" &&
        "signatureHeader" in v.verifier &&
        typeof (v.verifier as { signatureHeader?: unknown }).signatureHeader === "string"
      ) {
        return {
          ...val,
          signatureHeader: (v.verifier as { signatureHeader: string }).signatureHeader,
        };
      }
    }
    return val;
  },
  z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    label: z.string().min(1).max(80),
    summary: z.string().max(200).optional(),
    verifier: z.union([WebhookVerifierPresetSchema, WebhookSignatureSchemeSchema]),
    signatureHeader: z.string().min(1).max(100),
    eventIdPath: z.string().min(1).max(120),
    eventTypePath: z.string().min(1).max(120).optional(),
    eventTypeFilter: z.array(z.string().min(1)).optional(),
    outputs: z.array(nodePortDefinition),
  }),
);
export type IntegrationTrigger = z.infer<typeof IntegrationTriggerSchema>;

export const IntegrationFidelitySchema = z.strictObject({
  specHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  importerVersion: z.string().regex(EXACT_VERSION),
  level: z.enum(["exact", "curated", "partial"]),
  unsupported: z
    .array(
      z.strictObject({
        op: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).nullable(),
        code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
        pointer: z.string().max(512),
        blocking: z.boolean(),
      }),
    )
    .max(500),
});
export type IntegrationFidelity = z.infer<typeof IntegrationFidelitySchema>;

export const IntegrationManifestSchema = z
  .strictObject({
    manifestVersion: z.literal(2),
    kind: z.literal("integration"),
    app: brickId,
    version: z.string().regex(EXACT_VERSION),
    ui: IntegrationUiSchema,
    auth: IntegrationAuthSchema,
    defaultHeaders: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), z.string().max(200)).optional(),
    baseUrl: z.string().min(1),
    allowedHosts: z.array(z.string().min(1)).min(1),
    operations: z.array(IntegrationOperationSchema).min(1).max(30),
    triggers: z.array(IntegrationTriggerSchema).optional(),
    errorWhen: PredicateSchema.optional(),
    successWhen: PredicateSchema.optional(),
    errorMappings: IntegrationErrorMappingsSchema.optional(),
    fidelity: IntegrationFidelitySchema,
  })
  .superRefine((m, ctx) => {
    let parsedBaseUrl: URL | null = null;
    try {
      parsedBaseUrl = new URL(m.baseUrl);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "baseUrl must be a valid URL",
      });
    }

    if (parsedBaseUrl) {
      if (parsedBaseUrl.protocol !== "https:") {
        ctx.addIssue({
          code: "custom",
          path: ["baseUrl"],
          message: "baseUrl must use https://",
        });
      }
      if (parsedBaseUrl.username || parsedBaseUrl.password) {
        ctx.addIssue({
          code: "custom",
          path: ["baseUrl"],
          message: "baseUrl must not include credentials",
        });
      }
      if (isForbiddenIntegrationHost(parsedBaseUrl.hostname)) {
        ctx.addIssue({
          code: "custom",
          path: ["baseUrl"],
          message: `baseUrl hostname "${parsedBaseUrl.hostname}" is not a valid public HTTPS hostname`,
        });
      } else if (!m.allowedHosts.includes(parsedBaseUrl.hostname)) {
        ctx.addIssue({
          code: "custom",
          path: ["allowedHosts"],
          message: `baseUrl hostname "${parsedBaseUrl.hostname}" must be listed in allowedHosts`,
        });
      }
    }

    m.allowedHosts.forEach((host, idx) => {
      if (isForbiddenIntegrationHost(host)) {
        ctx.addIssue({
          code: "custom",
          path: ["allowedHosts", idx],
          message: `allowedHosts[${idx}] "${host}" must be an exact public HTTPS hostname (no wildcards, schemes, paths, localhost, or IP literals)`,
        });
      }
    });

    if (m.ui.maturity !== "production" && !m.ui.maturityReason?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["ui", "maturityReason"],
        message: `ui.maturityReason is required when ui.maturity is "${m.ui.maturity}"`,
      });
    }

    if (m.defaultHeaders) {
      for (const [k, v] of Object.entries(m.defaultHeaders)) {
        const lower = k.toLowerCase();
        if (
          lower === "authorization" ||
          lower === "cookie" ||
          lower === "host" ||
          lower === "content-length"
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["defaultHeaders", k],
            message: `header "${k}" is forbidden in defaultHeaders`,
          });
        }
        if (v.includes("{{")) {
          ctx.addIssue({
            code: "custom",
            path: ["defaultHeaders", k],
            message: `defaultHeaders value for "${k}" cannot contain "{{" templates`,
          });
        }
      }
    }

    const seenOpIds = new Set<string>();
    m.operations.forEach((op, idx) => {
      if (seenOpIds.has(op.operationId)) {
        ctx.addIssue({
          code: "custom",
          path: ["operations", idx, "operationId"],
          message: `duplicate operationId "${op.operationId}"`,
        });
      }
      seenOpIds.add(op.operationId);

      if (!op.path.startsWith("/") || op.path.startsWith("//") || /(?:^|\/)\.\.(?:\/|$)/.test(op.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["operations", idx, "path"],
          message: `operation "${op.operationId}" path "${op.path}" must start with a single "/" and contain no ".." segments`,
        });
      }

      op.params?.forEach((p, pIdx) => {
        if (p.wireName !== undefined && p.wireName === p.name) {
          ctx.addIssue({
            code: "custom",
            path: ["operations", idx, "params", pIdx, "wireName"],
            message: `param "${p.name}" wireName must not equal name`,
          });
        }
      });

      op.body?.fields?.forEach((f, fIdx) => {
        if (f.wireName !== undefined && f.wireName === f.name) {
          ctx.addIssue({
            code: "custom",
            path: ["operations", idx, "body", "fields", fIdx, "wireName"],
            message: `body field "${f.name}" wireName must not equal name`,
          });
        }
      });
    });

    if (m.fidelity) {
      const opIds = new Set(m.operations.map((op) => op.operationId));
      m.fidelity.unsupported.forEach((item, idx) => {
        if (item.op !== null && !opIds.has(item.op)) {
          ctx.addIssue({
            code: "custom",
            path: ["fidelity", "unsupported", idx, "op"],
            message: `unsupported op "${item.op}" is not an operation of the manifest`,
          });
        }
      });
    }
  });
export type IntegrationManifestFile = z.infer<typeof IntegrationManifestSchema>;

export function projectIntegrationToNodes(
  manifest: IntegrationManifestFile,
): ManifestNodeDefinition[] {
  return manifest.operations.map((op) => {
    const inputs: NodePortDefinition[] = [];
    const seenInputIds = new Set<string>();

    for (const param of op.params ?? []) {
      if (seenInputIds.has(param.name)) continue;
      seenInputIds.add(param.name);
      inputs.push({
        id: param.name,
        ...(param.description ? { label: param.description } : { label: param.name }),
        dataType: param.dataType,
        ...(param.required !== undefined ? { required: param.required } : {}),
        ...(param.enum !== undefined ? { enum: param.enum } : {}),
        ...(param.default !== undefined ? { default: param.default } : {}),
      });
    }

    if (op.body?.fields) {
      const requiredFields = op.body.fields.filter((f) => f.required);
      const optionalFields = op.body.fields.filter((f) => !f.required);
      const projectedFields = [...requiredFields, ...optionalFields.slice(0, 12)];
      for (const field of projectedFields) {
        if (seenInputIds.has(field.name)) continue;
        seenInputIds.add(field.name);
        inputs.push({
          id: field.name,
          ...(field.description ? { label: field.description } : { label: field.name }),
          dataType: field.dataType,
          ...(field.required !== undefined ? { required: field.required } : {}),
        });
      }
    } else if (op.body?.root) {
      if (!seenInputIds.has("body")) {
        inputs.push({
          id: "body",
          label: "Body",
          dataType:
            op.body.root.dataType === "array"
              ? "array"
              : op.body.root.dataType === "object"
                ? "object"
                : "any",
        });
        seenInputIds.add("body");
      }
    }

    if (!seenInputIds.has("in")) {
      inputs.push({
        id: "in",
        label: "Input",
        dataType: "any",
      });
    }

    const outputs: NodePortDefinition[] = [];
    const seenOutputIds = new Set<string>();
    for (const outPort of op.response?.outputs ?? []) {
      if (seenOutputIds.has(outPort.id)) continue;
      seenOutputIds.add(outPort.id);
      outputs.push({
        id: outPort.id,
        ...(outPort.label !== undefined ? { label: outPort.label } : {}),
        dataType: outPort.dataType,
        ...(outPort.required !== undefined ? { required: outPort.required } : {}),
      });
    }
    if (!seenOutputIds.has("out")) {
      outputs.push({
        id: "out",
        label: "Output",
        dataType: "object",
      });
    }
    if (!seenOutputIds.has("status")) {
      outputs.push({
        id: "status",
        label: "Status",
        dataType: "number",
      });
    }
    if (!seenOutputIds.has("body")) {
      outputs.push({
        id: "body",
        label: "Body",
        dataType: "any",
      });
    }
    if (op.pagination) {
      if (!seenOutputIds.has("truncated")) {
        outputs.push({
          id: "truncated",
          label: "Truncated",
          dataType: "boolean",
        });
      }
      if (!seenOutputIds.has("nextCursor")) {
        outputs.push({
          id: "nextCursor",
          label: "Next Cursor",
          dataType: "string",
        });
      }
    }

    const summaryText = (op.summary ?? `${manifest.ui.displayName}: ${op.label}`).slice(0, 140);
    const hasBlockingLoss = (manifest.fidelity?.unsupported ?? []).some(
      (e) => (e.op === op.operationId || e.op === null || e.op === "*") && e.blocking,
    );

    return {
      type: `int:${manifest.app}.${op.operationId}`,
      label: op.label,
      summary: summaryText,
      role: "action" as const,
      inputs,
      outputs,
      config: {},
      executor: "integration.operation",
      durable: true,
      sideEffects: op.sideEffects,
      ...(op.idempotency !== undefined ? { idempotent: true } : {}),
      availability: hasBlockingLoss ? ("unsupported" as const) : ("available" as const),
    };
  });
}

/**
 * One brick secret: its name, or { name, optional, generate } (story 1.19). `optional: true` means the brick runs without it
 * (a missing value never blocks readiness or a deploy). `generate: "random-32-bytes"` means it is internal to the brick, so
 * the platform can make the value itself: Studio generates it on an approved preview deploy, never on production. A secret
 * is one or the other, never both; a third-party credential is never `generate`.
 */
export const secretDeclaration = z.union([
  identifier,
  z
    .strictObject({
      name: identifier,
      optional: z.literal(true).optional(),
      generate: z.literal("random-32-bytes").optional(),
    })
    .refine((d) => !(d.optional && d.generate), { message: "a secret is either optional or generated, not both" }),
]);
export type SecretDeclaration = z.infer<typeof secretDeclaration>;

/** A secret declaration with its flags spelled out. */
export interface NormalizedSecretDeclaration {
  name: string;
  optional: boolean;
  generate?: "random-32-bytes";
}

/** Each of a manifest's secrets as { name, optional, generate }, in declaration order. */
export function secretDeclarations(manifest: { secrets?: readonly SecretDeclaration[] | undefined }): NormalizedSecretDeclaration[] {
  return (manifest.secrets ?? []).map((d) =>
    typeof d === "string" ? { name: d, optional: false } : { name: d.name, optional: d.optional === true, ...(d.generate ? { generate: d.generate } : {}) },
  );
}

/** The names of a manifest's secrets, in declaration order. */
export function secretNames(manifest: { secrets?: readonly SecretDeclaration[] | undefined }): string[] {
  return secretDeclarations(manifest).map((d) => d.name);
}

export const ManifestSchema = z
  .strictObject({
    manifestVersion: z.literal(2),
    kind: z.literal("brick"),
    id: brickId,
    version: z.string().regex(EXACT_VERSION),
    trust: z.enum(["first-party", "untrusted"]).default("untrusted"),
    isolation: z.enum(["none", "dispatch"]).default("none"),
    /** What this brick offers other bricks (for example a way to know which workspace a request is for). */
    provides: z.array(providesItem).default([]),
    /** What this brick needs another enabled brick to offer. */
    requires: z.array(requiresItem).default([]),
    /** SQL files, relative to the brick's folder, applied in this order. */
    migrations: z.array(z.string().regex(RELATIVE_FILE)).default([]),
    /** The first URL segments this brick's routes use (for example "wallet"). A declared entity may not take one. */
    routePrefixes: z.array(z.string().regex(ROUTE_PREFIX)).default([]),
    /** Third-party packages the emitted project needs, at exact versions. */
    npmDependencies: z.record(z.string().regex(PACKAGE_NAME), z.string().regex(EXACT_VERSION)).default({}),
    settings: z.record(z.string().regex(IDENTIFIER), settingDefinition).default({}),
    nodes: z.array(nodeDefinition).default([]),
    ui: uiDefinition.optional(),
    triggers: triggersDefinition.optional(),
    conflicts: z.array(conflictDefinition).optional(),
    bindings: bindingsDefinition.optional(),
    secrets: z.array(secretDeclaration).optional(),
    globalTables: z.array(globalTableDefinition).optional(),
    /** Routes the assembler mounts the SDK rate limiter on, with their default limits (story 0.21). */
    rateLimits: z.array(rateLimitDefinition).optional(),
    adapters: z.record(identifier, adapterDefinition).optional(),
    privacy: privacyDefinition.optional(),
    /** Tables holding per-workspace rows, removed when a workspace is deleted (story 1.10). */
    workspaceData: workspaceDataDefinition.optional(),
    worker: z.strictObject({
      package: z.string().regex(PACKAGE_NAME),
      /**
       * `suspension` (story 1.10) names an export that refuses a suspended workspace. The assembler mounts it right
       * after this guard on every path the guard is mounted at, apart from a short allowlist kept in the assembler.
       */
      guard: z.strictObject({ export: identifier, capability, suspension: identifier.optional() }).optional(),
      /**
       * Story 1.11: a middleware export that resolves an alternative credential (for example an API key) into the
       * verified identity and workspace context. The assembler mounts it on the API routes before the session identity;
       * a request without that credential passes through it unchanged, and the session identity then runs as before.
       */
      identityAlternative: z.strictObject({ export: identifier }).optional(),
      /**
       * Story 2.6: a middleware export that refuses a signed-in user the brick has not approved. The assembler mounts it
       * on every workspace-guarded path, after the identity steps and before the workspace guard, and only while the
       * boolean `setting` of this brick is true; with it false nothing is mounted and the assembled app is unchanged.
       */
      approvalGuard: z.strictObject({ export: identifier, setting: identifier }).optional(),
      /**
       * Story 1.13: the exports this brick offers other bricks through a `$capability` route option, by capability (one
       * it provides). A reference to an export not listed here is refused at assembly.
       */
      capabilityExports: z.record(capability, z.array(identifier).min(1).max(20)).optional(),
      routes: z.array(routeDefinition).default([]),
      privacy: workerPrivacyDefinition.optional(),
    }),
  })
  .superRefine((m, ctx) => {
    const problem = (message: string, path?: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
    if (m.privacy?.tables) {
      for (const [table, rule] of Object.entries(m.privacy.tables)) {
        if (rule.platformWide && (rule.subject !== "user" || !rule.userColumn || rule.erase !== "retain")) {
          problem(`privacy table "${table}" is platformWide, so it must be subject "user" with a userColumn and erase "retain"`, ["privacy", "tables", table]);
        }
        if (rule.platformWide && (m.trust !== "first-party" || m.isolation !== "none")) {
          problem(`privacy table "${table}" is platformWide, which only a first-party, non-isolated brick may declare`, ["privacy", "tables", table]);
        }
        if (rule.platformWide && !(m.globalTables ?? []).some((g) => g.table === table)) {
          problem(`privacy table "${table}" is platformWide but is not one of this brick's globalTables`, ["privacy", "tables", table]);
        }
        if (rule.erase === "retain" && (!rule.retainReason || rule.retainReason.trim().length === 0)) {
          problem(`privacy table "${table}" erase "retain" requires retainReason`, ["privacy", "tables", table, "retainReason"]);
        }
      }
    }
    if (m.workspaceData) {
      const seenTables = new Set<string>();
      for (const entry of [...m.workspaceData.tables, ...(m.workspaceData.exempt ?? [])]) {
        if (seenTables.has(entry.table)) problem(`workspaceData lists table "${entry.table}" more than once`, ["workspaceData"]);
        seenTables.add(entry.table);
      }
      for (const o of m.workspaceData.objectPrefixes ?? []) {
        const type = m.bindings && !Array.isArray(m.bindings) ? m.bindings[o.binding] : undefined;
        if (type !== "r2") problem(`workspaceData objectPrefixes binding "${o.binding}" must be declared as an R2 binding ("r2") in bindings`, ["workspaceData", "objectPrefixes"]);
      }
      const globals = new Set((m.globalTables ?? []).map((g) => g.table));
      for (const entry of m.workspaceData.tables) {
        if (globals.has(entry.table)) problem(`workspaceData table "${entry.table}" is a global table; global tables are never purged`, ["workspaceData"]);
      }
    }
    if (m.trust === "untrusted" && m.isolation !== "dispatch") problem('untrusted requires isolation: "dispatch"', ["trust"]);
    for (const [cap, names] of Object.entries(m.worker.capabilityExports ?? {})) {
      if (!m.provides.some((p) => (p.includes("@") ? p.slice(0, p.indexOf("@")) : p) === cap)) {
        problem(`worker.capabilityExports names "${cap}", which this brick does not provide`, ["worker", "capabilityExports", cap]);
      }
      for (const name of names) {
        const clash = entryBindingClash(name);
        if (clash) problem(`worker.capabilityExports "${name}" cannot be imported into the assembled entry: ${clash}`, ["worker", "capabilityExports", cap]);
      }
    }
    for (const [name, sDef] of Object.entries(m.settings)) {
      if (sDef.type !== "string" || sDef.pattern === undefined) continue;
      // A pattern is a regular expression the assembler runs: only a first-party manifest may declare one.
      if (m.trust !== "first-party") {
        problem(`setting "${name}" declares a pattern, which only a first-party brick may do`, ["settings", name, "pattern"]);
        continue;
      }
      let compiled: RegExp | undefined;
      try {
        compiled = new RegExp(sDef.pattern);
      } catch {
        problem(`setting "${name}" pattern is not a valid regular expression`, ["settings", name, "pattern"]);
      }
      if (compiled && !compiled.test(sDef.default)) problem(`setting "${name}" default does not match its pattern`, ["settings", name, "default"]);
    }
    if (m.worker.approvalGuard) {
      const gate = m.worker.approvalGuard;
      if (m.settings[gate.setting]?.type !== "boolean") problem(`worker.approvalGuard setting "${gate.setting}" must be a boolean setting of this brick`, ["worker", "approvalGuard", "setting"]);
      const clash = entryBindingClash(gate.export);
      if (clash) problem(`worker.approvalGuard "${gate.export}" cannot be imported into the assembled entry: ${clash}`, ["worker", "approvalGuard", "export"]);
    }
    if (m.worker.guard) {
      const guardCap = m.worker.guard.capability;
      const providesGuard = m.provides.some((p) => (p.includes("@") ? p.slice(0, p.indexOf("@")) : p) === guardCap);
      if (!providesGuard) problem(`guard capability "${guardCap}" is not listed in provides`);
    }
    for (const [name, sDef] of Object.entries(m.settings)) {
      if (sDef.since && compare(sDef.since, m.version) > 0) {
        problem(`setting "${name}" since "${sDef.since}" is greater than brick version "${m.version}"`, ["settings", name, "since"]);
      }
      if (sDef.deprecated?.since && compare(sDef.deprecated.since, m.version) > 0) {
        problem(`setting "${name}" deprecated.since "${sDef.deprecated.since}" is greater than brick version "${m.version}"`, ["settings", name, "deprecated", "since"]);
      }
    }
    const checkOptions = (owner: string, options: Record<string, z.infer<typeof valueExpr>>): void => {
      for (const [name, value] of Object.entries(options)) {
        if (typeof value === "object" && "$setting" in value && !(value.$setting in m.settings)) problem(`${owner} option ${name} uses unknown setting "${value.$setting}"`);
        if (typeof value === "object" && ("$capability" in value || "$setting" in value) && typeof value.requiredWhen === "object" && !(value.requiredWhen.setting in m.settings)) {
          problem(`${owner} option ${name} is required when unknown setting "${value.requiredWhen.setting}" is set`);
        }
      }
    };
    for (const route of m.worker.routes) {
      if (route.guardPaths.length > 0 && !route.guardWith) problem(`route ${route.factory} has guardPaths but no guardWith`);
      if (route.guardWith) {
        const requiresGuard = m.requires.some((r) => (r.includes("@") ? r.slice(0, r.indexOf("@")) : r) === route.guardWith);
        if (!requiresGuard) problem(`route ${route.factory} is guarded with "${route.guardWith}", which is not listed in requires`);
      }
      checkOptions(`route ${route.factory}`, route.options);
    }
    // Story 1.20: schedule options follow the route option rules; enabledWhen names one of the brick's own settings.
    for (const sched of m.triggers?.schedules ?? []) {
      checkOptions(`schedule ${sched.id}`, sched.options ?? {});
      if (sched.enabledWhen && !(sched.enabledWhen.setting in m.settings)) {
        problem(`schedule ${sched.id} is enabled when unknown setting "${sched.enabledWhen.setting}" is set`);
      }
    }
  });

export type BrickManifestFile = Omit<z.infer<typeof ManifestSchema>, "nodes"> & {
  nodes?: ManifestNodeDefinition[];
};

export interface ProjectLock {
  project?: string;
  identity?: string;
  environment?: "dev" | "preview" | "production";
  bricks?: Array<{
    id: string;
    version: string;
    capabilities?: Record<string, string>;
    settings?: Record<string, unknown>;
    defaults?: Record<string, unknown>;
  }>;
  capabilities?: Record<string, string>;
  migrations?: string[];
  entities?: string[];
  workflows?: unknown;
  secretRefs?: unknown;
}

/** The bricks the assembler may choose from: each manifest and the text of the files it lists. */
export interface Catalog {
  catalogVersion?: string;
  bricks: Record<string, { manifest: BrickManifestFile; files: Record<string, string> }>;
  nodePacks?: Record<string, { manifest: NodePackManifestFile }>;
  integrations?: Record<string, { manifest: IntegrationManifestFile; nodes: ManifestNodeDefinition[] }>;
}

const brickEntry = z.union([
  brickId,
  z.strictObject({ id: brickId, config: z.record(z.string().regex(IDENTIFIER), z.union([z.number(), z.string(), z.boolean()])).optional() }),
]);

export const ObservabilityAlertsSchema = z.strictObject({
  webhookSecret: z.string().optional(),
  signingSecret: z.string().optional(),
});
export type ObservabilityAlertsConfig = z.infer<typeof ObservabilityAlertsSchema>;

export const ObservabilitySchema = z.strictObject({
  logs: z.boolean().optional(),
  logpush: z.boolean().optional(),
  alerts: ObservabilityAlertsSchema.optional(),
});
export type ObservabilityConfig = z.infer<typeof ObservabilitySchema>;

export const BlueprintSchema = z.strictObject({
  schemaVersion: z.literal(2).optional(),
  /** Becomes the project's folder and package name. */
  project: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  bricks: z.array(brickEntry).min(1).max(50),
  /** Either "stub" or the id of an enabled brick that provides user identity. */
  identity: brickId.default("stub"),
  /** Declared entities, checked in full by parseEntities (@poc/sdk); here only that it is a list. */
  entities: z.array(z.unknown()).max(20).default([]),
  /** Optional v2 blueprint sections; worker assembly reads only project, identity, bricks, and entities. */
  workflows: z.array(z.unknown()).optional(),
  secretRefs: z.array(z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Optional observability preset (Workers Logs, Logpush, Tail Worker alerts). */
  observability: ObservabilitySchema.optional(),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

/** Formats Zod issues as short readable lines. */
export function formatIssues(error: z.ZodError, label = ""): string[] {
  return error.issues.map((i) => `${label}${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`);
}
