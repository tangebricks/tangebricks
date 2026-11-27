import { describe, expect, it } from "vitest";
import { IntegrationManifestSchema, nodeDefinition, projectIntegrationToNodes } from "../src/index.ts";
import type { IntegrationManifestFile } from "../src/index.ts";

function makeValidIntegrationManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 2,
    kind: "integration",
    app: "stripe",
    version: "1.0.0",
    ui: {
      displayName: "Stripe",
      category: "billing",
      icon: "credit-card",
      docsUrl: "https://docs.stripe.com/api",
      summary: "Stripe payments, customers, and subscriptions integration",
      maturity: "production",
      behaviourTest: "test/stripe.test.ts",
    },
    auth: {
      type: "oauth2",
      scopes: ["read_write"],
      authorizeUrl: "https://connect.stripe.com/oauth/authorize",
      tokenUrl: "https://connect.stripe.com/oauth/token",
      headerName: "Authorization",
      prefix: "Bearer",
    },
    baseUrl: "https://api.stripe.com",
    allowedHosts: ["api.stripe.com", "files.stripe.com"],
    operations: [
      {
        operationId: "create_customer",
        label: "Create Customer",
        summary: "Creates a new Stripe customer record",
        method: "POST",
        path: "/v1/customers",
        params: [
          {
            name: "idempotencyKey",
            in: "header",
            dataType: "string",
            required: false,
            description: "Idempotency key header",
          },
        ],
        body: {
          contentType: "application/x-www-form-urlencoded",
          fields: [
            { name: "email", dataType: "string", required: true },
            { name: "name", dataType: "string", required: false },
          ],
        },
        response: {
          dataPath: "customer",
          outputs: [
            { id: "id", label: "Customer ID", dataType: "string" },
            { id: "email", label: "Customer Email", dataType: "string" },
          ],
        },
        rateLimit: {
          maxRetries: 3,
          initialBackoffMs: 100,
          respectRetryAfter: true,
        },
        sideEffects: "write",
      },
      {
        operationId: "list_customers",
        label: "List Customers",
        summary: "Lists Stripe customers with cursor pagination",
        method: "GET",
        path: "/v1/customers/{accountId}",
        params: [
          {
            name: "accountId",
            in: "path",
            dataType: "string",
            required: true,
          },
          {
            name: "limit",
            in: "query",
            dataType: "number",
            required: false,
          },
        ],
        response: {
          outputs: [{ id: "data", label: "Customers", dataType: "array" }],
        },
        pagination: {
          style: "cursor",
          paramName: "starting_after",
          responsePath: "data",
          nextCursorPath: "next_cursor",
          maxPages: 4,
        },
        sideEffects: "read",
      },
    ],
    triggers: [
      {
        id: "invoice_paid",
        label: "Invoice Paid",
        summary: "Fires when a Stripe invoice is paid",
        verifier: "stripe-signature",
        signatureHeader: "Stripe-Signature",
        eventIdPath: "id",
        eventTypePath: "type",
        eventTypeFilter: ["invoice.paid"],
        outputs: [
          { id: "id", label: "Event ID", dataType: "string" },
          { id: "data", label: "Event Payload", dataType: "object" },
        ],
      },
    ],
    fidelity: {
      specHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      importerVersion: "2.0.0",
      level: "exact",
      unsupported: [],
    },
    ...overrides,
  };
}

describe("Story 10.1 — IntegrationManifestSchema and projectIntegrationToNodes", () => {
  it("validates a compliant integration manifest with operations, pagination, rateLimit, and triggers", () => {
    const raw = makeValidIntegrationManifest();
    const parsed = IntegrationManifestSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.app).toBe("stripe");
    expect(parsed.data.operations).toHaveLength(2);
    expect(parsed.data.triggers).toHaveLength(1);
  });

  it("enforces the hard ceiling of <= 30 operations per integration manifest", () => {
    const thirtyOps = Array.from({ length: 30 }, (_, idx) => ({
      operationId: `op_${idx + 1}`,
      label: `Operation ${idx + 1}`,
      method: "GET",
      path: `/v1/items/${idx + 1}`,
      response: {},
      sideEffects: "read",
    }));
    const atLimit = IntegrationManifestSchema.safeParse(makeValidIntegrationManifest({ operations: thirtyOps }));
    expect(atLimit.success).toBe(true);

    const thirtyOneOps = [
      ...thirtyOps,
      {
        operationId: "op_31",
        label: "Operation 31",
        method: "GET",
        path: "/v1/items/31",
        response: {},
        sideEffects: "read",
      },
    ];
    const overLimit = IntegrationManifestSchema.safeParse(makeValidIntegrationManifest({ operations: thirtyOneOps }));
    expect(overLimit.success).toBe(false);
    if (!overLimit.success) {
      expect(overLimit.error.issues.some((i) => i.path.includes("operations"))).toBe(true);
    }
  });

  it("rejects non-HTTPS baseUrl, empty allowedHosts, wildcard hosts, localhost, and private IP literals", () => {
    const httpBase = IntegrationManifestSchema.safeParse(makeValidIntegrationManifest({ baseUrl: "http://api.stripe.com" }));
    expect(httpBase.success).toBe(false);

    const emptyHosts = IntegrationManifestSchema.safeParse(makeValidIntegrationManifest({ allowedHosts: [] }));
    expect(emptyHosts.success).toBe(false);

    const wildcardHost = IntegrationManifestSchema.safeParse(
      makeValidIntegrationManifest({
        allowedHosts: ["api.stripe.com", "*.stripe.com"],
      }),
    );
    expect(wildcardHost.success).toBe(false);

    const ipLiteralHost = IntegrationManifestSchema.safeParse(
      makeValidIntegrationManifest({
        baseUrl: "https://169.254.169.254",
        allowedHosts: ["169.254.169.254"],
      }),
    );
    expect(ipLiteralHost.success).toBe(false);

    const localhostHost = IntegrationManifestSchema.safeParse(
      makeValidIntegrationManifest({
        baseUrl: "https://localhost",
        allowedHosts: ["localhost"],
      }),
    );
    expect(localhostHost.success).toBe(false);

    const unallowedBaseHost = IntegrationManifestSchema.safeParse(
      makeValidIntegrationManifest({
        baseUrl: "https://api.stripe.com",
        allowedHosts: ["files.stripe.com"],
      }),
    );
    expect(unallowedBaseHost.success).toBe(false);
  });

  it("enforces D7 maturity rules requiring maturityReason when maturity is beta or experimental", () => {
    const betaMissingReason = IntegrationManifestSchema.safeParse(
      makeValidIntegrationManifest({
        ui: {
          displayName: "Stripe Beta",
          category: "billing",
          summary: "Beta integration without maturityReason",
          maturity: "beta",
          behaviourTest: "test/stripe.test.ts",
        },
      }),
    );
    expect(betaMissingReason.success).toBe(false);
    if (!betaMissingReason.success) {
      expect(betaMissingReason.error.issues.some((i) => i.path.join(".").includes("ui.maturityReason"))).toBe(true);
    }

    const experimentalWithReason = IntegrationManifestSchema.safeParse(
      makeValidIntegrationManifest({
        ui: {
          displayName: "Stripe Experimental",
          category: "billing",
          summary: "Experimental integration with reason",
          maturity: "experimental",
          maturityReason: "Sandbox testing only",
        },
      }),
    );
    expect(experimentalWithReason.success).toBe(true);
  });

  it("projects integration operations into valid ManifestNodeDefinition[] with type int:<app>.<operationId> and executor integration.operation", () => {
    const manifest: IntegrationManifestFile = IntegrationManifestSchema.parse(makeValidIntegrationManifest());
    const nodes = projectIntegrationToNodes(manifest);
    expect(nodes).toHaveLength(2);

    const createNode = nodes[0]!;
    expect(createNode.type).toBe("int:stripe.create_customer");
    expect(createNode.executor).toBe("integration.operation");
    expect(createNode.role).toBe("action");
    expect(createNode.sideEffects).toBe("write");
    expect(createNode.durable).toBe(true);
    expect(createNode.inputs.map((p) => p.id)).toEqual(expect.arrayContaining(["idempotencyKey", "email", "name", "in"]));
    expect(createNode.outputs.map((p) => p.id)).toEqual(expect.arrayContaining(["id", "email", "out", "status", "body"]));

    const listNode = nodes[1]!;
    expect(listNode.type).toBe("int:stripe.list_customers");
    expect(listNode.executor).toBe("integration.operation");
    expect(listNode.sideEffects).toBe("read");
    expect(listNode.inputs.map((p) => p.id)).toEqual(expect.arrayContaining(["accountId", "limit", "in"]));

    for (const n of nodes) {
      const validated = nodeDefinition.safeParse(n);
      expect(validated.success).toBe(true);
    }
  });
});
