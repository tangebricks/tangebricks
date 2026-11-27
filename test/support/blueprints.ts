// The blueprints the tests assemble. Plain data, importable from Node and from workerd tests alike.
export const TWO_BRICK_BLUEPRINT = { project: "two-brick", bricks: ["multi-workspace", "credit-wallet"] } as const;

/** The docs' example: invoices for a workspace, beside the two bricks. The second entity (tasks) covers a boolean and a bounded number. */
export const INVOICE_FLOW_BLUEPRINT = {
  project: "invoice-flow",
  bricks: ["multi-workspace", "credit-wallet", "dynamic-entities"],
  entities: [
    {
      name: "invoices",
      workspaceScoped: true,
      fields: [
        { name: "client_name", type: "text", required: true },
        { name: "amount", type: "number" },
        { name: "status", type: "enum", values: ["draft", "paid", "overdue"] },
        { name: "pdf_r2_url", type: "text" },
      ],
    },
  ],
} as const;

/**
 * Quarantined bricks (story 0.11) are left out of max-compatible, so a quarantined brick whose own test drives the
 * assembled shell gets a small project of its own here.
 */
export const WORKFLOW_SHELL_BLUEPRINT = {
  project: "wf-shell",
  bricks: ["multi-workspace", "core-auth", "user-profile", "workflow-dag"],
} as const;

/** realtime-presence is quarantined (story 0.11) and so not in max-compatible; GDPR erasure of its tables is tested here. */
export const PRIVACY_PRESENCE_BLUEPRINT = {
  project: "privacy-presence",
  bricks: ["multi-workspace", "core-auth", "data-privacy-gdpr", "realtime-presence"],
} as const;

/**
 * Story 2.6: platform-admin with its opt-in user approval gate turned on, so the gate the assembler mounts can be tested
 * in a real assembled app (max-compatible keeps the default, off).
 */
export const APPROVAL_GATE_BLUEPRINT = {
  project: "approval-gate",
  bricks: ["multi-workspace", "audit-trail", "credit-wallet", "public-api-keys", { id: "platform-admin", config: { requireUserApproval: true } }],
} as const;

/**
 * Story 1.20: subscription-plans with plan credits configured (free 100, pro 1000 a month), beside credit-wallet, so the
 * grant on read, the per-minute sweep and the cross-workspace rows run against a real assembled app. The MCP test
 * (packages/mcp-server/test/plan-credits-config.test.ts) reaches the same blueprint through apply_ops configure_brick.
 */
export const PLAN_CREDITS_BLUEPRINT = {
  project: "plan-credits",
  bricks: ["multi-workspace", "credit-wallet", { id: "subscription-plans", config: { planCredits: "free:100,pro:1000" } }],
} as const;

/**
 * Story 1.32: an entity graph with required relations (lease -> unit and tenant) and the story 1.18 types (money, date,
 * enum, longtext), plus an entity whose relation is optional (application). The workerd test builds every create from
 * the app's own /openapi.json alone (packages/assembler/src/openapi-sample.ts).
 */
export const ENTITY_GRAPH_BLUEPRINT = {
  project: "entity-graph",
  bricks: ["multi-workspace", "dynamic-entities"],
  entities: [
    {
      name: "unit",
      fields: [
        { name: "label", type: "text", required: true, maxLength: 40 },
        { name: "rent", type: "money", currencies: ["INR"], required: true },
      ],
    },
    {
      name: "tenant",
      fields: [
        { name: "full_name", type: "text", required: true },
        { name: "notes", type: "longtext" },
      ],
    },
    {
      name: "lease",
      fields: [
        { name: "unit_id", type: "relation", relation: "unit", required: true },
        { name: "tenant_id", type: "relation", relation: "tenant", required: true },
        { name: "deposit", type: "money", currencies: ["INR"], required: true },
        { name: "starts_on", type: "date", required: true },
        { name: "status", type: "enum", values: ["draft", "active", "ended"], required: true },
      ],
    },
    {
      name: "application",
      fields: [
        { name: "lease_id", type: "relation", relation: "lease" },
        { name: "amount", type: "money", currencies: ["INR", "USD"], required: true },
        { name: "stage", type: "enum", values: ["new", "review", "won"], required: true },
        { name: "due_on", type: "date" },
      ],
    },
  ],
} as const;
