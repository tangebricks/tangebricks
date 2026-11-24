import { parseEntities } from "@poc/sdk";
import type { Entity, EntityField } from "@poc/sdk";
import type { Blueprint, BrickManifestFile, Catalog } from "./schemas.ts";

// Builds a deterministic OpenAPI 3.1.0 specification from a blueprint and its enabled bricks.
// All keys are sorted canonically so repeated assemblies produce byte-identical JSON.

const IDENTITY_CAPABILITY = ["user", "identity"].join("-");

export interface OrderedBrickInput {
  id: string;
  manifest: BrickManifestFile;
  config?: Record<string, number | string | boolean>;
}

export interface OpenApiSpec {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
  };
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, Record<string, unknown>>;
    securitySchemes: Record<string, Record<string, unknown>>;
  };
}

function takesEntities(manifest: BrickManifestFile): boolean {
  return manifest.worker.routes.some((r) =>
    Object.values(r.options).some((v) => typeof v === "object" && v !== null && "$entities" in v),
  );
}

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function canonicalize<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        out[key] = canonicalize(entry);
      }
    }
    return out as T;
  }
  return value;
}

interface RawFieldShape {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  values?: string[];
  target?: string;
}

interface RawEntityShape {
  name: string;
  fields: RawFieldShape[];
}

function mapFieldToJsonSchema(field: RawFieldShape | EntityField): Record<string, unknown> {
  const f = field as RawFieldShape;
  switch (f.type) {
    case "text":
    case "string":
      return {
        type: "string",
        ...(typeof f.maxLength === "number" ? { maxLength: f.maxLength } : {}),
      };
    case "number":
    case "integer":
      return {
        type: "integer",
        ...(typeof f.min === "number" ? { minimum: f.min } : {}),
        ...(typeof f.max === "number" ? { maximum: f.max } : {}),
      };
    case "boolean":
      return {
        type: "boolean",
      };
    case "datetime":
      return {
        type: "string",
        format: "date-time",
      };
    case "json":
      return {
        type: "object",
        additionalProperties: true,
      };
    case "enum":
      return {
        type: "string",
        enum: Array.isArray(f.values) ? [...f.values] : [],
      };
    case "relation":
      return {
        type: "string",
        description: typeof f.target === "string" ? `Relation to ${f.target}` : "Relation identifier",
      };
    default:
      return {
        type: "string",
      };
  }
}

function normalizeOrderedBricks(
  blueprint: Pick<Blueprint, "bricks">,
  orderedOrCatalog: ReadonlyArray<OrderedBrickInput> | Catalog | undefined,
): OrderedBrickInput[] {
  if (!orderedOrCatalog) return [];
  if (Array.isArray(orderedOrCatalog)) {
    return [...orderedOrCatalog];
  }
  const catalog = orderedOrCatalog as Catalog;
  const resolved: OrderedBrickInput[] = [];
  for (const entry of blueprint.bricks ?? []) {
    const id = typeof entry === "string" ? entry : (entry as { id: string }).id;
    const found = catalog.bricks?.[id];
    if (found) {
      resolved.push({
        id,
        manifest: found.manifest,
      });
    }
  }
  return resolved;
}

function normalizeEntities(
  blueprint: Pick<Blueprint, "entities">,
  explicitEntities?: ReadonlyArray<Entity | RawEntityShape>,
): RawEntityShape[] {
  const source = explicitEntities ?? (Array.isArray(blueprint.entities) ? blueprint.entities : []);
  if (source.length === 0) return [];

  const parsed = parseEntities(source);
  if (parsed.ok) {
    return parsed.entities.map((e) => ({
      name: e.name,
      fields: e.fields.map((f) => ({ ...f })),
    }));
  }

  const fallback: RawEntityShape[] = [];
  for (const item of source) {
    if (typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string") {
      const raw = item as { name: string; fields?: unknown[] };
      const fields: RawFieldShape[] = [];
      for (const rf of Array.isArray(raw.fields) ? raw.fields : []) {
        if (typeof rf === "object" && rf !== null && typeof (rf as { name?: unknown }).name === "string") {
          fields.push({
            name: (rf as { name: string }).name,
            type: typeof (rf as { type?: unknown }).type === "string" ? (rf as { type: string }).type : "text",
            required: Boolean((rf as { required?: unknown }).required),
            ...(typeof (rf as { maxLength?: unknown }).maxLength === "number"
              ? { maxLength: (rf as { maxLength: number }).maxLength }
              : {}),
            ...(typeof (rf as { min?: unknown }).min === "number" ? { min: (rf as { min: number }).min } : {}),
            ...(typeof (rf as { max?: unknown }).max === "number" ? { max: (rf as { max: number }).max } : {}),
            ...(Array.isArray((rf as { values?: unknown }).values)
              ? { values: (rf as { values: string[] }).values }
              : {}),
            ...(typeof (rf as { target?: unknown }).target === "string"
              ? { target: (rf as { target: string }).target }
              : {}),
          });
        }
      }
      fallback.push({ name: raw.name, fields });
    }
  }
  return fallback.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function hasWebhookTriggerInWorkflows(workflows: unknown[] | undefined): boolean {
  if (!Array.isArray(workflows)) return false;
  for (const wf of workflows) {
    if (typeof wf !== "object" || wf === null) continue;
    const record = wf as {
      trigger?: unknown;
      nodes?: Array<{ type?: unknown; role?: unknown; data?: Record<string, unknown> }>;
    };
    if (record.trigger === "webhook") return true;
    if (typeof record.trigger === "object" && record.trigger !== null) {
      const kind = (record.trigger as { kind?: unknown }).kind;
      if (kind === "webhook" || kind === "integration") return true;
    }
    if (Array.isArray(record.nodes)) {
      for (const node of record.nodes) {
        const nodeType = typeof node?.type === "string" ? node.type : "";
        if (
          nodeType.includes("webhook") ||
          (node?.role === "trigger" && (nodeType.startsWith("int:") || nodeType.includes("trigger")))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function generateOpenApiSpec(
  blueprint: Pick<Blueprint, "project"> & Partial<Pick<Blueprint, "identity" | "bricks" | "entities" | "workflows">>,
  orderedBricks?: ReadonlyArray<OrderedBrickInput> | Catalog,
  explicitEntities?: ReadonlyArray<Entity | RawEntityShape>,
): OpenApiSpec {
  const ordered = normalizeOrderedBricks(
    { bricks: blueprint.bricks ?? [] },
    orderedBricks,
  );
  const entities = normalizeEntities(
    { entities: blueprint.entities ?? [] },
    explicitEntities,
  );

  const hasNonIdentityGuard = ordered.some((b) =>
    b.manifest.worker.routes.some(
      (r) => Boolean(r.guardWith) && r.guardWith !== IDENTITY_CAPABILITY,
    ),
  );

  const securitySchemes: Record<string, Record<string, unknown>> = {
    BearerAuth: {
      type: "http",
      scheme: "bearer",
      description: "Bearer token authentication",
    },
    SessionCookie: {
      type: "apiKey",
      in: "cookie",
      name: "px_session",
      description: "Session cookie authentication",
    },
  };

  if (hasNonIdentityGuard) {
    securitySchemes.WorkspaceHeader = {
      type: "apiKey",
      in: "header",
      name: "X-Workspace-Id",
      description: "Active workspace identifier header",
    };
  }

  const schemas: Record<string, Record<string, unknown>> = {};
  const paths: Record<string, Record<string, unknown>> = {};

  // 1. Emit path items for every enabled brick's routePrefixes
  for (const brick of ordered) {
    const mountAt = (brick.manifest.worker.routes[0]?.mountAt ?? "/api").replace(/\/+$/, "");
    const requiresTenancyGuard = brick.manifest.worker.routes.some(
      (r) => Boolean(r.guardWith) && r.guardWith !== IDENTITY_CAPABILITY,
    );
    const security: Array<Record<string, string[]>> = requiresTenancyGuard
      ? [
          { BearerAuth: [], WorkspaceHeader: [] },
          { SessionCookie: [], WorkspaceHeader: [] },
        ]
      : [{ BearerAuth: [] }, { SessionCookie: [] }];

    const headerParameters = requiresTenancyGuard
      ? [
          {
            name: "X-Workspace-Id",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "Workspace context identifier",
          },
        ]
      : [];

    for (const prefix of brick.manifest.routePrefixes) {
      const routePath = `${mountAt}/${prefix}`;
      if (paths[routePath]) continue;
      const safeOpSuffix = `${brick.id}_${prefix}`.replace(/[^a-zA-Z0-9_]/g, "_");
      paths[routePath] = {
        "x-px-brick": brick.id,
        get: {
          operationId: `get_${safeOpSuffix}`,
          summary: `${brick.manifest.ui?.displayName ?? brick.id} (${prefix})`,
          tags: [brick.id],
          "x-px-brick": brick.id,
          security,
          ...(headerParameters.length > 0 ? { parameters: headerParameters } : {}),
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: `post_${safeOpSuffix}`,
          summary: `${brick.manifest.ui?.displayName ?? brick.id} action (${prefix})`,
          tags: [brick.id],
          "x-px-brick": brick.id,
          security,
          ...(headerParameters.length > 0 ? { parameters: headerParameters } : {}),
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: true,
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
      };
    }
  }

  // 2. Emit JSON Schema components & CRUD paths for declared entities
  const entityBrick = ordered.find((b) => takesEntities(b.manifest));
  const shouldEmitEntities = entities.length > 0 && (Boolean(entityBrick) || ordered.length === 0);
  if (shouldEmitEntities) {
    const entityMountAt = (entityBrick?.manifest.worker.routes[0]?.mountAt ?? "/api").replace(/\/+$/, "");
    const entityTag = entityBrick?.id ?? "entities";
    const entityRequiresTenancy = entityBrick
      ? entityBrick.manifest.worker.routes.some(
          (r) => Boolean(r.guardWith) && r.guardWith !== IDENTITY_CAPABILITY,
        )
      : hasNonIdentityGuard;

    if (entityRequiresTenancy && !securitySchemes.WorkspaceHeader) {
      securitySchemes.WorkspaceHeader = {
        type: "apiKey",
        in: "header",
        name: "X-Workspace-Id",
        description: "Active workspace identifier header",
      };
    }

    const entitySecurity: Array<Record<string, string[]>> = entityRequiresTenancy
      ? [
          { BearerAuth: [], WorkspaceHeader: [] },
          { SessionCookie: [], WorkspaceHeader: [] },
        ]
      : [{ BearerAuth: [] }, { SessionCookie: [] }];

    const workspaceHeaderParam = entityRequiresTenancy
      ? [
          {
            name: "X-Workspace-Id",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "Workspace context identifier",
          },
        ]
      : [];

    for (const entity of entities) {
      const pascalName = toPascalCase(entity.name) || entity.name;
      const fieldProps: Record<string, Record<string, unknown>> = {};
      const requiredInputFields: string[] = [];

      for (const field of entity.fields) {
        fieldProps[field.name] = mapFieldToJsonSchema(field);
        if (field.required) {
          requiredInputFields.push(field.name);
        }
      }

      const fullEntitySchema: Record<string, unknown> = {
        type: "object",
        properties: {
          id: { type: "string" },
          workspace_id: { type: "string" },
          ...fieldProps,
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
        required: ["id", "workspace_id", ...requiredInputFields, "created_at", "updated_at"],
      };

      const createEntitySchema: Record<string, unknown> = {
        type: "object",
        properties: { ...fieldProps },
        ...(requiredInputFields.length > 0 ? { required: requiredInputFields } : {}),
      };

      const updateEntitySchema: Record<string, unknown> = {
        type: "object",
        properties: { ...fieldProps },
      };

      schemas[pascalName] = fullEntitySchema;
      schemas[`${pascalName}Create`] = createEntitySchema;
      schemas[`${pascalName}Update`] = updateEntitySchema;
      if (entity.name !== pascalName) {
        schemas[entity.name] = fullEntitySchema;
        schemas[`${entity.name}Create`] = createEntitySchema;
        schemas[`${entity.name}Update`] = updateEntitySchema;
      }

      const collectionPath = `${entityMountAt}/${entity.name}`;
      const itemPath = `${entityMountAt}/${entity.name}/{id}`;

      paths[collectionPath] = {
        ...(entityBrick ? { "x-px-brick": entityBrick.id } : {}),
        get: {
          operationId: `list_${entity.name}`,
          summary: `List ${entity.name}`,
          tags: [entityTag, entity.name],
          ...(entityBrick ? { "x-px-brick": entityBrick.id } : {}),
          security: entitySecurity,
          ...(workspaceHeaderParam.length > 0 ? { parameters: workspaceHeaderParam } : {}),
          responses: {
            "200": {
              description: `List of ${entity.name}`,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: { $ref: `#/components/schemas/${pascalName}` },
                      },
                    },
                    required: ["items"],
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: `create_${entity.name}`,
          summary: `Create ${entity.name}`,
          tags: [entityTag, entity.name],
          ...(entityBrick ? { "x-px-brick": entityBrick.id } : {}),
          security: entitySecurity,
          ...(workspaceHeaderParam.length > 0 ? { parameters: workspaceHeaderParam } : {}),
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${pascalName}Create` },
              },
            },
          },
          responses: {
            "201": {
              description: `Created ${entity.name}`,
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${pascalName}` },
                },
              },
            },
          },
        },
      };

      const idPathParam = {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: `${entity.name} record ID`,
      };
      const itemParameters = [...workspaceHeaderParam, idPathParam];

      paths[itemPath] = {
        ...(entityBrick ? { "x-px-brick": entityBrick.id } : {}),
        get: {
          operationId: `get_${entity.name}`,
          summary: `Get ${entity.name} by ID`,
          tags: [entityTag, entity.name],
          ...(entityBrick ? { "x-px-brick": entityBrick.id } : {}),
          security: entitySecurity,
          parameters: itemParameters,
          responses: {
            "200": {
              description: `${entity.name} record`,
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${pascalName}` },
                },
              },
            },
            "404": {
              description: "Record not found",
            },
          },
        },
        patch: {
          operationId: `update_${entity.name}`,
          summary: `Update ${entity.name}`,
          tags: [entityTag, entity.name],
          ...(entityBrick ? { "x-px-brick": entityBrick.id } : {}),
          security: entitySecurity,
          parameters: itemParameters,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${pascalName}Update` },
              },
            },
          },
          responses: {
            "200": {
              description: `Updated ${entity.name}`,
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${pascalName}` },
                },
              },
            },
            "404": {
              description: "Record not found",
            },
          },
        },
        delete: {
          operationId: `delete_${entity.name}`,
          summary: `Delete ${entity.name}`,
          tags: [entityTag, entity.name],
          ...(entityBrick ? { "x-px-brick": entityBrick.id } : {}),
          security: entitySecurity,
          parameters: itemParameters,
          responses: {
            "200": {
              description: `Deleted ${entity.name}`,
            },
            "404": {
              description: "Record not found",
            },
          },
        },
      };
    }
  }

  // 3. Emit inbound webhook endpoint when a webhook brick is enabled or a workflow has a webhook trigger
  const webhookBrick = ordered.find((b) =>
    b.manifest.routePrefixes.some((p) => p === "webhooks" || p.startsWith("webhooks/")),
  );
  if (webhookBrick || hasWebhookTriggerInWorkflows(blueprint.workflows)) {
    const webhookTag = webhookBrick?.id ?? "webhooks";
    paths["/api/webhooks/in/{subscriptionId}"] = {
      ...(webhookBrick ? { "x-px-brick": webhookBrick.id } : {}),
      post: {
        operationId: "receive_inbound_webhook",
        summary: "Receive signed inbound webhook delivery",
        tags: [webhookTag],
        ...(webhookBrick ? { "x-px-brick": webhookBrick.id } : {}),
        parameters: [
          {
            name: "subscriptionId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Inbound webhook subscription identifier",
          },
          {
            name: "X-Hub-Signature-256",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "HMAC-SHA256 webhook signature header",
          },
          {
            name: "Stripe-Signature",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Timestamped HMAC webhook signature header",
          },
          {
            name: "X-Slack-Signature",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Slack v0 HMAC signature header",
          },
          {
            name: "X-Slack-Request-Timestamp",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "Slack request timestamp header",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Webhook verified and accepted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    deduplicated: { type: "boolean" },
                    deliveryId: { type: "string" },
                  },
                },
              },
            },
          },
          "401": {
            description: "Invalid webhook signature",
          },
        },
      },
    };
  }

  return canonicalize<OpenApiSpec>({
    openapi: "3.1.0",
    info: {
      title: blueprint.project,
      version: "0.0.0",
    },
    paths,
    components: {
      schemas,
      securitySchemes,
    },
  });
}
