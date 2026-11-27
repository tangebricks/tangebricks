import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioApp } from "../src/App.tsx";
import { useStudioStore } from "../src/store.ts";
import type { BlueprintState } from "../src/types.ts";

const emptyEntitiesBlueprint: BlueprintState = {
  schemaVersion: 2,
  project: "saas-crm",
  identity: "core-auth",
  bricks: [{ id: "core-auth", config: { sessionDuration: 7200 } }],
  entities: [],
  workflows: [],
  secretRefs: [],
};

const existingInvoicesBlueprint: BlueprintState = {
  schemaVersion: 2,
  project: "saas-crm",
  identity: "core-auth",
  bricks: [
    { id: "core-auth", config: {} },
    { id: "multi-workspace", config: {} },
    { id: "dynamic-entities", config: {} },
  ],
  entities: [
    {
      name: "invoices",
      workspaceScoped: true,
      fields: [
        { name: "amount", type: "number", required: true, min: 0 },
        {
          name: "status",
          type: "enum",
          required: true,
          values: ["draft", "paid", "void"],
          default: "draft",
        },
        {
          name: "customer_email",
          type: "string",
          required: true,
          unique: true,
          indexed: true,
        },
        { name: "paid_at", type: "datetime", required: false },
      ],
    },
  ],
  workflows: [
    {
      id: "wf-invoice-notify",
      name: "Notify Customer On Invoice",
      trigger: { kind: "event", event: "invoices.created" },
      nodes: [
        {
          id: "n-trig",
          type: "dynamic-entities.record_created",
          label: "Invoice Created",
          data: { entity: "invoices" },
        },
        {
          id: "n-pick",
          type: "transform.pick",
          label: "Pick Customer Email",
          data: { path: "customer_email" },
        },
      ],
      edges: [
        {
          id: "e1",
          source: "n-trig",
          target: "n-pick",
          sourceHandle: "col-customer_email",
          targetHandle: "in",
        },
      ],
    },
  ],
  secretRefs: [],
};

describe("Visual Entity Designer with SQL migration, route, and workspace_id isolation preview", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useStudioStore.getState().resetStore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  it("1. renders missing handler banner when dynamic-entities is off and enables multi-workspace + dynamic-entities on one-click Turn on", async () => {
    const opsPayloads: Array<{ ops: Array<Record<string, unknown>> }> = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/ops")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        opsPayloads.push(body);
        return new Response(
          JSON.stringify({
            revision: 2,
            semanticHash: "hash-rev-2",
            state: {
              ...emptyEntitiesBlueprint,
              bricks: [...emptyEntitiesBlueprint.bricks, { id: "multi-workspace", config: {} }, { id: "dynamic-entities", config: {} }],
            },
            readiness: {
              state: "Ready",
              ready: true,
              bricksCount: 3,
              entitiesCount: 0,
              workflowsCount: 0,
              needs: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "saas-crm",
      projectState: emptyEntitiesBlueprint,
      activeNav: "data",
    });

    render(<StudioApp />);

    expect(screen.getByTestId("entity-missing-handler-banner")).toBeDefined();
    fireEvent.click(screen.getByTestId("turn-on-dynamic-entities-button"));

    await waitFor(() => {
      expect(opsPayloads).toHaveLength(1);
    });

    expect(opsPayloads[0]?.ops).toEqual([
      expect.objectContaining({ type: "enable_brick", brickId: "multi-workspace" }),
      expect.objectContaining({ type: "enable_brick", brickId: "dynamic-entities" }),
    ]);

    await waitFor(() => {
      expect(screen.queryByTestId("entity-missing-handler-banner")).toBeNull();
    });
  });

  it("2. rejects reserved brick route prefixes (wallet) and system column names (workspace_id), creates invoices entity with 4 typed fields, and updates live SQL DDL, CRUD routes, and workspace_id isolation previews", async () => {
    const opsPayloads: Array<{ ops: Array<Record<string, unknown>> }> = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/ops")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        opsPayloads.push(body);
        const createdEntity = body.ops[0].entity;
        return new Response(
          JSON.stringify({
            revision: 3,
            semanticHash: "hash-rev-3",
            state: {
              ...emptyEntitiesBlueprint,
              bricks: [...emptyEntitiesBlueprint.bricks, { id: "multi-workspace", config: {} }, { id: "dynamic-entities", config: {} }],
              entities: [createdEntity],
            },
            readiness: {
              state: "Ready",
              ready: true,
              bricksCount: 3,
              entitiesCount: 1,
              workflowsCount: 0,
              needs: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "saas-crm",
      projectState: {
        ...emptyEntitiesBlueprint,
        bricks: [...emptyEntitiesBlueprint.bricks, { id: "multi-workspace", config: {} }, { id: "dynamic-entities", config: {} }],
      },
      activeNav: "data",
    });

    render(<StudioApp />);

    // Click + New Entity
    fireEvent.click(screen.getByTestId("new-entity-button"));

    // Reserved route prefix "wallet" is rejected immediately
    const nameInput = screen.getByTestId("entity-name-input") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "wallet" } });
    expect(screen.getByTestId("entity-name-error").textContent).toContain("collides with a reserved brick route prefix (/api/wallet)");
    expect((screen.getByTestId("save-entity-button") as HTMLButtonElement).disabled).toBe(true);

    // Valid name "invoices" clears entity name error
    fireEvent.change(nameInput, { target: { value: "invoices" } });
    expect(screen.queryByTestId("entity-name-error")).toBeNull();

    // Reserved system column "workspace_id" is rejected immediately
    fireEvent.change(screen.getByTestId("field-name-input-0"), {
      target: { value: "workspace_id" },
    });
    expect(screen.getByTestId("field-error-0").textContent).toContain("reserved by the system");

    // Configure Field 0: amount (number, required)
    fireEvent.change(screen.getByTestId("field-name-input-0"), {
      target: { value: "amount" },
    });
    fireEvent.change(screen.getByTestId("field-type-select-0"), {
      target: { value: "number" },
    });

    // Add Field 1: status (enum: draft, paid, void)
    fireEvent.click(screen.getByTestId("add-field-button"));
    fireEvent.change(screen.getByTestId("field-name-input-1"), {
      target: { value: "status" },
    });
    fireEvent.change(screen.getByTestId("field-type-select-1"), {
      target: { value: "enum" },
    });
    fireEvent.change(screen.getByTestId("field-enum-values-input-1"), {
      target: { value: "draft, paid, void" },
    });
    fireEvent.click(screen.getByTestId("field-required-toggle-1"));

    // Add Field 2: customer_email (string, required, unique, indexed)
    fireEvent.click(screen.getByTestId("add-field-button"));
    fireEvent.change(screen.getByTestId("field-name-input-2"), {
      target: { value: "customer_email" },
    });
    fireEvent.change(screen.getByTestId("field-type-select-2"), {
      target: { value: "string" },
    });
    fireEvent.click(screen.getByTestId("field-required-toggle-2"));
    fireEvent.click(screen.getByTestId("field-unique-toggle-2"));
    fireEvent.click(screen.getByTestId("field-indexed-toggle-2"));

    // Add Field 3: paid_at (datetime, optional)
    fireEvent.click(screen.getByTestId("add-field-button"));
    fireEvent.change(screen.getByTestId("field-name-input-3"), {
      target: { value: "paid_at" },
    });
    fireEvent.change(screen.getByTestId("field-type-select-3"), {
      target: { value: "datetime" },
    });

    // Verify live SQLite DDL, CRUD route, and workspace_id isolation previews before saving
    const ddlText = screen.getByTestId("entity-sql-ddl-code").textContent ?? "";
    expect(ddlText).toContain('CREATE TABLE IF NOT EXISTS "ent_invoices"');
    expect(ddlText).toContain('"workspace_id" TEXT NOT NULL');
    expect(ddlText).toContain(`"status" TEXT NOT NULL CHECK ("status" IN ('draft', 'paid', 'void'))`);
    expect(ddlText).toContain('UNIQUE("workspace_id", "customer_email")');
    expect(ddlText).toContain('CREATE INDEX IF NOT EXISTS "idx_ent_invoices_workspace_customer_email" ON "ent_invoices"("workspace_id", "customer_email")');

    const crudText = screen.getByTestId("entity-crud-routes-preview").textContent ?? "";
    expect(crudText).toContain("POST /api/entities/invoices");
    expect(crudText).toContain("PATCH /api/entities/invoices/:id");

    const isoText = screen.getByTestId("entity-isolation-sql-code").textContent ?? "";
    expect(isoText).toContain('WHERE "workspace_id" = :ctx.workspaceId');

    // Save entity -> dispatches add_entity
    fireEvent.click(screen.getByTestId("save-entity-button"));

    await waitFor(() => {
      expect(opsPayloads).toHaveLength(1);
    });
    expect(opsPayloads[0]?.ops[0]).toMatchObject({
      type: "add_entity",
      entity: {
        name: "invoices",
        workspaceScoped: true,
        fields: [
          expect.objectContaining({ name: "amount", type: "number", required: true }),
          expect.objectContaining({
            name: "status",
            type: "enum",
            required: true,
            values: ["draft", "paid", "void"],
          }),
          expect.objectContaining({
            name: "customer_email",
            type: "string",
            required: true,
            unique: true,
            indexed: true,
          }),
          expect.objectContaining({
            name: "paid_at",
            type: "datetime",
            required: false,
          }),
        ],
      },
    });
  });

  it("3. opens Destructive Migration Confirmation modal when dropping a committed field or deleting an entity, listing affected workflows and col-* ports before dispatching update_entity / remove_entity", async () => {
    const opsPayloads: Array<{ ops: Array<Record<string, unknown>> }> = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/ops")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        opsPayloads.push(body);
        const op = body.ops[0];
        const nextEntities = op.type === "remove_entity" ? [] : [op.entity];
        return new Response(
          JSON.stringify({
            revision: opsPayloads.length + 1,
            semanticHash: `hash-${opsPayloads.length + 1}`,
            state: {
              ...existingInvoicesBlueprint,
              entities: nextEntities,
            },
            readiness: {
              state: "Ready",
              ready: true,
              bricksCount: 3,
              entitiesCount: nextEntities.length,
              workflowsCount: 1,
              needs: [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "saas-crm",
      projectState: existingInvoicesBlueprint,
      activeNav: "data",
    });

    render(<StudioApp />);

    // Drop field 2 (customer_email, referenced by wf-invoice-notify via col-customer_email)
    fireEvent.click(screen.getByTestId("field-remove-button-2"));

    // Verify live ALTER TABLE DROP COLUMN preview appears in SQL DDL preview
    expect(screen.getByTestId("entity-sql-ddl-code").textContent).toContain('ALTER TABLE "ent_invoices" DROP COLUMN "customer_email";');

    // Clicking Save Entity opens Destructive Migration Confirmation modal instead of immediately committing
    fireEvent.click(screen.getByTestId("save-entity-button"));
    expect(opsPayloads).toHaveLength(0);

    const modal = screen.getByTestId("destructive-entity-modal");
    expect(modal).toBeDefined();
    expect(screen.getByTestId("destructive-entity-reasons").textContent).toContain('Drops column "customer_email"');
    expect(screen.getByTestId("destructive-entity-wf-wf-invoice-notify").textContent).toContain("Notify Customer On Invoice (wf-invoice-notify)");

    // Confirm destructive update -> dispatches update_entity
    fireEvent.click(screen.getByTestId("destructive-entity-confirm"));

    await waitFor(() => {
      expect(opsPayloads).toHaveLength(1);
    });
    expect(opsPayloads[0]?.ops[0]?.type).toBe("update_entity");

    // Clicking Delete Entity opens Destructive Migration Confirmation modal for remove_entity
    fireEvent.click(screen.getByTestId("delete-entity-button-invoices"));
    expect(screen.getByTestId("destructive-entity-reasons").textContent).toContain('Drops table "ent_invoices"');
    fireEvent.click(screen.getByTestId("destructive-entity-confirm"));

    await waitFor(() => {
      expect(opsPayloads).toHaveLength(2);
    });
    expect(opsPayloads[1]?.ops[0]).toMatchObject({
      type: "remove_entity",
      name: "invoices",
    });
  });
});
