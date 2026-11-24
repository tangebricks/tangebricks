import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudioApp } from "../src/App.tsx";
import { MaturityBadge } from "../src/components/Badges.tsx";
import { useStudioStore } from "../src/store.ts";
import { DEFAULT_INTEGRATIONS, type BlueprintState } from "../src/types.ts";

const sampleBlueprint: BlueprintState = {
  schemaVersion: 2,
  project: "saas-crm",
  identity: "core-auth",
  bricks: [
    { id: "core-auth", config: { sessionDuration: 7200 } },
    { id: "multi-workspace", config: {} },
    { id: "dynamic-entities", config: {} },
    { id: "llm-gateway", config: {} },
    { id: "cron-alarms", config: {} },
  ],
  entities: [
    {
      name: "deals",
      workspaceScoped: true,
      fields: [
        { name: "title", type: "text", required: true, maxLength: 160 },
        { name: "value_cents", type: "number", required: true, min: 0, max: 100_000_000 },
        { name: "stage", type: "enum", required: true, values: ["lead", "qualified", "won", "lost"] },
        { name: "account_id", type: "text", required: false, unique: false, relation: "accounts.id" },
      ],
    },
    {
      name: "accounts",
      workspaceScoped: true,
      fields: [
        { name: "company_name", type: "text", required: true, unique: true, maxLength: 120 },
        { name: "is_enterprise", type: "boolean", required: false },
      ],
    },
  ],
  workflows: [
    {
      id: "wf-deal-won",
      name: "When Deal Won Notify Team",
      trigger: { kind: "event", event: "deals.updated" },
      nodes: [
        { id: "n1", type: "trigger.manual", label: "Deal Event", data: { entity: "deals" } },
      ],
      edges: [],
    },
  ],
  secretRefs: [],
};

describe("Story 2.4: Read-only Bricks and Entities views with maturity badges", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore();
  });

  afterEach(() => {
    cleanup();
  });

  it("1. renders maturity badges (Production ✓, Beta ◆, Experimental ⚠) with icon + text, maturityReason, and 'Needs scheduling / queues' markers (AC 1, AC 3)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: sampleBlueprint,
      activeNav: "bricks",
    });

    render(<StudioApp />);

    // Production badge on dynamic-entities, Beta on core-auth
    expect(screen.getByTestId("enabled-brick-maturity-dynamic-entities").textContent).toBe(
      "Production ✓",
    );
    expect(screen.getByTestId("enabled-brick-maturity-core-auth").textContent).toBe(
      "Beta ◆",
    );

    // Beta badge + maturityReason on llm-gateway (agent-sandbox, used here before, is quarantined since story 0.11)
    expect(screen.getByTestId("enabled-brick-maturity-llm-gateway").textContent).toBe(
      "Beta ◆",
    );
    expect(screen.getByTestId("enabled-brick-reason-llm-gateway").textContent).toContain(
      "Persists prompt templates and token usage logs in D1",
    );

    // "Needs scheduling / queues" marker on cron-alarms and queue-jobs
    expect(screen.getByTestId("enabled-brick-scheduling-cron-alarms").textContent).toContain(
      "Needs scheduling / queues",
    );
    expect(screen.getByTestId("catalog-brick-scheduling-queue-jobs").textContent).toContain(
      "Needs scheduling / queues",
    );

    // Enable experimental toggle to verify Experimental ⚠ badge and maturityReason
    fireEvent.click(screen.getByTestId("bricks-experimental-toggle"));
    expect(screen.getByTestId("catalog-brick-maturity-scripting-sandbox").textContent).toBe(
      "Experimental ⚠",
    );
    expect(screen.getByTestId("catalog-brick-reason-scripting-sandbox").textContent).toContain(
      "Executes in isolated Worker",
    );
    expect(screen.getByTestId("catalog-brick-scheduling-workflow-dag").textContent).toContain(
      "Needs scheduling / queues",
    );
  });

  it("2. hides experimental bricks in the Brick Catalog by default until toggled on, and filters by search and category (AC 1, AC 3)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: {
        ...sampleBlueprint,
        // Even if an experimental brick is enabled in the project, it remains visible in Enabled in Project
        bricks: [...sampleBlueprint.bricks, { id: "scripting-sandbox", config: {} }],
      },
      activeNav: "bricks",
    });

    render(<StudioApp />);

    // Enabled in Project always shows scripting-sandbox even when Include experimental is off
    expect(screen.getByTestId("enabled-brick-card-scripting-sandbox")).toBeDefined();

    // Brick Catalog hides experimental bricks (scripting-sandbox, workflow-dag) by default
    expect(screen.queryByTestId("catalog-brick-card-scripting-sandbox")).toBeNull();
    expect(screen.queryByTestId("catalog-brick-card-workflow-dag")).toBeNull();

    // Toggle "Include experimental" on -> experimental bricks appear in catalog
    fireEvent.click(screen.getByTestId("bricks-experimental-toggle"));
    expect(screen.getByTestId("catalog-brick-card-scripting-sandbox")).toBeDefined();
    expect(screen.getByTestId("catalog-brick-card-workflow-dag")).toBeDefined();

    // Category filter: filter to "billing"
    fireEvent.change(screen.getByTestId("bricks-category-filter"), {
      target: { value: "billing" },
    });
    expect(screen.getByTestId("catalog-brick-card-credit-wallet")).toBeDefined();
    expect(screen.queryByTestId("catalog-brick-card-core-auth")).toBeNull();

    // Search filter: search for "subscription"
    fireEvent.change(screen.getByTestId("bricks-search-input"), {
      target: { value: "subscription" },
    });
    expect(screen.getByTestId("catalog-brick-card-subscription-plans")).toBeDefined();
    expect(screen.queryByTestId("catalog-brick-card-credit-wallet")).toBeNull();
  });

  it("3. opens the Right Dock Inspector when a brick is clicked, displaying capabilities, routes, migrations, secrets, and read-only config settings (AC 1, AC 3)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: sampleBlueprint,
      activeNav: "bricks",
    });

    render(<StudioApp />);

    // Click core-auth (which has configured sessionDuration = 7200 vs default 86400)
    fireEvent.click(screen.getByTestId("enabled-brick-card-core-auth"));

    expect(screen.getByTestId("inspector-brick-detail")).toBeDefined();
    expect(screen.getByTestId("inspector-brick-provides").textContent).toContain("user-identity");
    expect(screen.getByTestId("inspector-brick-routes").textContent).toContain("/api/auth");
    expect(screen.getByTestId("inspector-brick-migrations").textContent).toContain(
      "migrations/0001_core_auth.sql",
    );
    expect(screen.getByTestId("inspector-brick-secrets").textContent).toContain(
      "BETTER_AUTH_SECRET",
    );

    // Verify read-only setting value (7200) and schema constraints (300..2592000, default 86400)
    expect(screen.getByTestId("inspector-setting-value-sessionDuration").textContent).toBe(
      "7200",
    );
    expect(screen.getByTestId("inspector-setting-sessionDuration").textContent).toContain(
      "integer (300..2592000, default 86400)",
    );
  });

  it("4. renders declared entities, field table with constraints/relations, 'Used by' references, and workspace_id-scoped SQLite DDL + REST route preview in Data view (AC 2, AC 3)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      projectState: sampleBlueprint,
      activeNav: "data",
    });

    render(<StudioApp />);

    // Both entities ("deals" and "accounts") are listed
    expect(screen.getByTestId("entity-list-item-deals")).toBeDefined();
    expect(screen.getByTestId("entity-list-item-accounts")).toBeDefined();

    // First entity ("deals") is selected by default; verify its fields and constraints
    expect(screen.getByTestId("entity-field-row-title").textContent).toContain("maxLength: 160");
    expect(screen.getByTestId("entity-field-row-value_cents").textContent).toContain(
      "min: 0 · max: 100000000",
    );
    expect(screen.getByTestId("entity-field-row-stage").textContent).toContain(
      "values: [lead, qualified, won, lost]",
    );
    expect(screen.getByTestId("entity-field-row-account_id").textContent).toContain(
      "relation: accounts.id",
    );

    // Verify "Used by" panel lists dynamic-entities brick and wf-deal-won workflow
    expect(screen.getByTestId("entity-used-by-brick-dynamic-entities")).toBeDefined();
    expect(screen.getByTestId("entity-used-by-workflow-wf-deal-won")).toBeDefined();

    // Verify Inspector REST CRUD route paths and deterministic workspace_id-scoped SQLite CREATE TABLE DDL
    const routesText = screen.getByTestId("inspector-entity-routes").textContent ?? "";
    expect(routesText).toContain("GET /api/entities/deals");
    expect(routesText).toContain("POST /api/entities/deals");
    expect(routesText).toContain("PATCH /api/entities/deals/:id");

    const ddlText = screen.getByTestId("inspector-entity-ddl").textContent ?? "";
    expect(ddlText).toContain('CREATE TABLE IF NOT EXISTS "ent_deals"');
    expect(ddlText).toContain('"workspace_id" TEXT NOT NULL');
    expect(ddlText).toContain(
      'CREATE INDEX IF NOT EXISTS "ent_deals_workspace_idx" ON "ent_deals"("workspace_id", "created_at")',
    );

    // Switch to "accounts" entity and verify its unique constraint and DDL
    fireEvent.click(screen.getByTestId("entity-list-item-accounts"));
    expect(screen.getByTestId("entity-field-row-company_name").textContent).toContain(
      "✓ Unique",
    );
    expect(screen.getByTestId("inspector-entity-ddl").textContent).toContain(
      'CREATE TABLE IF NOT EXISTS "ent_accounts"',
    );
  });

  it("5. renders integration beta badge with maturityReason as tooltip (Story UC5.1 AC 3)", () => {
    const reason =
      "Verified only against recorded fixtures; promotion requires a passing live canary within the freshness window (UC5.5) and fidelity gate (UC2).";

    for (const app of ["discord", "github", "google", "slack", "stripe"]) {
      const integration = DEFAULT_INTEGRATIONS[app]?.manifest;
      expect(integration).toBeDefined();
      expect(integration?.ui.maturity).toBe("beta");
      expect(integration?.ui.maturityReason).toBe(reason);

      render(
        <MaturityBadge
          testId={`integration-maturity-badge-${app}`}
          tier={integration?.ui.maturity}
          reason={integration?.ui.maturityReason}
        />,
      );

      const badge = screen.getByTestId(`integration-maturity-badge-${app}`);
      expect(badge.textContent).toBe("Beta ◆");
      expect(badge.getAttribute("title")).toBe(reason);
    }
  });
});
