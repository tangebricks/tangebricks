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
