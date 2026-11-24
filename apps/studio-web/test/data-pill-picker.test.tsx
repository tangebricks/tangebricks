import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioApp } from "../src/App.tsx";
import { useStudioStore } from "../src/store.ts";
import { applyStudioOps, semanticHash } from "../src/types.ts";
import type { BlueprintState } from "../src/types.ts";

const invoiceWorkflowBlueprint: BlueprintState = {
  schemaVersion: 2,
  project: "proj-invoice-pills",
  identity: "core-auth",
  bricks: [
    { id: "core-auth", config: { sessionDuration: 7200 } },
    { id: "multi-workspace", config: {} },
    { id: "dynamic-entities", config: {} },
  ],
  entities: [
    {
      name: "invoices",
      workspaceScoped: true,
      fields: [
        { name: "amount", type: "number", required: true },
        {
          name: "status",
          type: "enum",
          values: ["draft", "sent", "paid"],
          required: true,
        },
        { name: "customer_email", type: "text", maxLength: 255, required: true },
      ],
    },
  ],
  workflows: [
    {
      id: "wf-invoice-email",
      name: "Invoice Paid Email Flow",
      trigger: { kind: "event", event: "invoices.record_created" },
      nodes: [
        {
          id: "trig_invoice",
          type: "core.brick_event",
          label: "Invoice Created",
          data: {
            entity: "invoices",
            event: "invoices.record_created",
          },
        },
        {
          id: "if_paid",
          type: "core.if",
          label: "If Invoice Paid",
          data: {
            field: "",
            operator: "eq",
            value: "paid",
          },
        },
        {
          id: "format_email",
          type: "core.format_template",
          label: "Format & Send Email",
          data: {
            to: "",
            subject: "Receipt",
            template: "Invoice {{customer_name}} paid",
          },
        },
      ],
      edges: [
        {
          id: "e-trig-if",
          source: "trig_invoice",
          sourceHandle: "out",
          target: "if_paid",
          targetHandle: "in",
        },
        {
          id: "e-if-email",
          source: "if_paid",
          sourceHandle: "true",
          target: "format_email",
          targetHandle: "in",
        },
      ],
    },
  ],
  secretRefs: [],
};

function installBackendFetchHandler() {
  const dispatchedOps: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/ops") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        baseRevision: number;
        ops: Array<Record<string, unknown>>;
        summary?: string;
      };
      dispatchedOps.push(...body.ops);
      const currentState = useStudioStore.getState().projectState!;
      const nextState = applyStudioOps(currentState, body.ops);
      const nextRev = (body.baseRevision ?? 0) + 1;
      const hash = semanticHash(nextState);
      return new Response(
        JSON.stringify({
          revision: nextRev,
          semanticHash: hash,
          state: nextState,
          author: { type: "human", id: "usr_1" },
          summary: body.summary ?? `Revision r${nextRev}`,
          createdAt: new Date().toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "unexpected request" }), { status: 404 });
  });
  return dispatchedOps;
}

describe("Structured Data-Pill Picker and Dynamic Data-Driven Ports", () => {
  beforeEach(() => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "alice@example.com", name: "Alice" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "proj-invoice-pills",
      projectState: structuredClone(invoiceWorkflowBlueprint),
      activeNav: "workflows",
      activeWorkflowId: "wf-invoice-email",
      rightDockOpen: true,
      rightDockTab: "inspector",
      selection: {
        kind: "node",
        id: "trig_invoice",
        workflowId: "wf-invoice-email",
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("1. exposes dynamic col-* entity column ports and ph-* template placeholder ports in the Inspector and Canvas", async () => {
    installBackendFetchHandler();

    render(<StudioApp />);

    // Trigger node bound to `invoices` entity exposes dynamic `col-*` output ports
    expect(screen.getByTestId("inspector-node-dynamic-ports")).toBeTruthy();
    expect(screen.getByTestId("dynamic-port-out-col-id").textContent).toContain(
      "col-id:string",
    );
    expect(screen.getByTestId("dynamic-port-out-col-amount").textContent).toContain(
      "col-amount:number",
    );
    expect(screen.getByTestId("dynamic-port-out-col-status").textContent).toContain(
      "col-status:string",
    );
    expect(
      screen.getByTestId("dynamic-port-out-col-customer_email").textContent,
    ).toContain("col-customer_email:string");

    // Select `format_email` node to verify dynamic `ph-customer_name` input port from `{{customer_name}}`
    useStudioStore.getState().selectItem({
      kind: "node",
      id: "format_email",
      workflowId: "wf-invoice-email",
    });

    await waitFor(() => {
      expect(screen.getByTestId("inspector-node-id").textContent).toBe("format_email");
    });

    expect(
      screen.getByTestId("dynamic-port-in-ph-customer_name").textContent,
    ).toContain("ph-customer_name:string");
  });

  it("2. maps upstream entity fields in the Data-Pill Picker with zero typed expressions, renders pill chips, and commits update_node", async () => {
    const dispatchedOps = installBackendFetchHandler();

    useStudioStore.getState().selectItem({
      kind: "node",
      id: "if_paid",
      workflowId: "wf-invoice-email",
    });

    render(<StudioApp />);

    // Open Data-Pill Picker for `field` on `if_paid`
    fireEvent.click(screen.getByTestId("open-pill-picker-field"));

    const picker = screen.getByTestId("data-pill-picker-field");
    expect(picker).toBeTruthy();
    expect(screen.getByTestId("pill-group-trig_invoice")).toBeTruthy();

    // Pick `status` from `trig_invoice` via click (zero typed keystrokes)
    fireEvent.click(screen.getByTestId("pill-option-trig_invoice-status"));

    // Verify Data Pill chip is rendered with step title, field name, and type badge
    const statusChip = screen.getByTestId("data-pill-chip-field-status");
    expect(statusChip.textContent).toContain("[Invoice Created → status : string]");
    expect(statusChip.getAttribute("data-pill-expression")).toBe(
      "{{steps.trig_invoice.output.status}}",
    );

    // Save `if_paid` node and verify `update_node` payload
    fireEvent.click(screen.getByTestId("inspector-node-save"));

    await waitFor(() => {
      expect(
        dispatchedOps.some(
          (op) => op.type === "update_node" && op.nodeId === "if_paid",
        ),
      ).toBe(true);
    });

    const updateIfOp = dispatchedOps.find(
      (op) => op.type === "update_node" && op.nodeId === "if_paid",
    );
    expect(updateIfOp?.data).toMatchObject({
      field: "{{steps.trig_invoice.output.status}}",
      operator: "eq",
      value: "paid",
    });
  });

  it("3. supports multi-pill picking, pill chip removal (×), and live Raw Expression ancestor/schema validation", async () => {
    installBackendFetchHandler();

    useStudioStore.getState().selectItem({
      kind: "node",
      id: "format_email",
      workflowId: "wf-invoice-email",
    });

    render(<StudioApp />);

    // Pick `customer_email` into `to`
    fireEvent.click(screen.getByTestId("open-pill-picker-to"));
    fireEvent.click(screen.getByTestId("pill-option-trig_invoice-customer_email"));
    expect(
      screen.getByTestId("data-pill-chip-to-customer_email").textContent,
    ).toContain("[Invoice Created → customer_email : string]");

    // Clear default template and pick `id` and `amount` into `template`
    const templateInput = screen.getByTestId(
      "node-config-input-template",
    ) as HTMLInputElement;
    fireEvent.change(templateInput, { target: { value: "" } });

    fireEvent.click(screen.getByTestId("open-pill-picker-template"));
    fireEvent.click(screen.getByTestId("pill-option-trig_invoice-id"));
    fireEvent.click(screen.getByTestId("pill-option-trig_invoice-amount"));

    expect(screen.getByTestId("data-pill-chip-template-id")).toBeTruthy();
    expect(
      screen.getByTestId("data-pill-chip-template-amount").textContent,
    ).toContain("[Invoice Created → amount : number]");

    // Remove `amount` pill chip via its × button
    fireEvent.click(screen.getByTestId("remove-pill-template-amount"));
    expect(screen.queryByTestId("data-pill-chip-template-amount")).toBeNull();
    expect(screen.getByTestId("data-pill-chip-template-id")).toBeTruthy();

    // Toggle "Advanced: Edit raw expression" on `template`
    fireEvent.click(screen.getByTestId("toggle-raw-expression-template"));
    const rawInput = screen.getByTestId(
      "raw-expression-input-template",
    ) as HTMLInputElement;
    expect(rawInput.value).toContain("{{steps.trig_invoice.output.id}}");

    // Enter a reference to a non-ancestor node -> live validation error
    fireEvent.change(rawInput, {
      target: { value: "{{steps.non_ancestor.output.id}}" },
    });
    expect(
      screen.getByTestId("expression-validation-error-template").textContent,
    ).toContain("Node 'non_ancestor' is not an upstream ancestor");

    // Enter a reference to an unknown field on `trig_invoice` -> live validation error
    fireEvent.change(rawInput, {
      target: { value: "{{steps.trig_invoice.output.missing_col}}" },
    });
    expect(
      screen.getByTestId("expression-validation-error-template").textContent,
    ).toContain("Field 'missing_col' does not exist on upstream node 'trig_invoice'");

    // Fix back to a valid expression -> validation error clears
    fireEvent.change(rawInput, {
      target: {
        value:
          "Invoice {{steps.trig_invoice.output.id}} for {{steps.trig_invoice.output.customer_email}}",
      },
    });
    expect(
      screen.queryByTestId("expression-validation-error-template"),
    ).toBeNull();
  });
});
