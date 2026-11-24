import { describe, expect, it } from "vitest";
import {
  buildExecutorsFromCatalog,
  buildRegistryFromCatalog,
  extractStepExpressionPills,
  extractTemplatePlaceholders,
  resolveStepExpressions,
  runGraph,
  validateStepExpression,
} from "../src/index.ts";

describe("packages/runtime step-output expression resolver & validator", () => {
  const sampleStepOutputs = {
    trig_invoice: {
      out: {
        id: "inv_9001",
        amount: 249.5,
        paid: true,
        status: "paid",
        customer_email: "billing@acme.example",
        customer: {
          name: "Acme Corp",
          address: { city: "Austin", zip: "78701" },
        },
        line_items: [
          { sku: "PRO-PLAN", qty: 2 },
          { sku: "ADDON-AI", qty: 1 },
        ],
      },
    },
    step_math: {
      output: {
        total_with_tax: 274.45,
      },
    },
  };

  it("1. preserves primitive, object, and array types when input is a single exact pill", () => {
    expect(
      resolveStepExpressions("{{steps.trig_invoice.output.amount}}", sampleStepOutputs),
    ).toBe(249.5);
    expect(
      typeof resolveStepExpressions("{{steps.trig_invoice.output.amount}}", sampleStepOutputs),
    ).toBe("number");

    expect(
      resolveStepExpressions("{{steps.trig_invoice.output.paid}}", sampleStepOutputs),
    ).toBe(true);
    expect(
      typeof resolveStepExpressions("{{steps.trig_invoice.output.paid}}", sampleStepOutputs),
    ).toBe("boolean");

    expect(
      resolveStepExpressions("{{steps.trig_invoice.output.customer}}", sampleStepOutputs),
    ).toEqual({
      name: "Acme Corp",
      address: { city: "Austin", zip: "78701" },
    });

    expect(
      resolveStepExpressions("{{steps.trig_invoice.output.line_items}}", sampleStepOutputs),
    ).toEqual([
      { sku: "PRO-PLAN", qty: 2 },
      { sku: "ADDON-AI", qty: 1 },
    ]);

    expect(
      resolveStepExpressions(
        "{{steps.trig_invoice.output.customer.address.city}}",
        sampleStepOutputs,
      ),
    ).toBe("Austin");

    expect(
      resolveStepExpressions(
        "{{steps.trig_invoice.output.line_items.0.sku}}",
        sampleStepOutputs,
      ),
    ).toBe("PRO-PLAN");
  });

  it("2. interpolates multiple pills as strings when embedded in text and resolves trigger.output", () => {
    const rendered = resolveStepExpressions(
      "Invoice {{steps.trig_invoice.output.id}} ({{steps.step_math.output.total_with_tax}}) for {{steps.trig_invoice.output.customer_email}}",
      sampleStepOutputs,
    );
    expect(rendered).toBe("Invoice inv_9001 (274.45) for billing@acme.example");

    const fromTrigger = resolveStepExpressions(
      "Customer: {{trigger.output.customer_email}}",
      sampleStepOutputs,
      sampleStepOutputs.trig_invoice.out,
    );
    expect(fromTrigger).toBe("Customer: billing@acme.example");

    // Non-step template placeholders remain untouched for core.format_template
    expect(resolveStepExpressions("Hello {{value}}", sampleStepOutputs)).toBe("Hello {{value}}");
  });

  it("3. rejects __proto__, constructor, and prototype segments without ever calling eval", () => {
    expect(
      resolveStepExpressions("{{steps.trig_invoice.output.__proto__.polluted}}", sampleStepOutputs),
    ).toBeUndefined();
    expect(
      resolveStepExpressions(
        "{{steps.trig_invoice.output.constructor.prototype}}",
        sampleStepOutputs,
      ),
    ).toBeUndefined();
    expect(
      resolveStepExpressions(
        "Prefix {{steps.trig_invoice.output.__proto__.toString}} Suffix",
        sampleStepOutputs,
      ),
    ).toBe("Prefix  Suffix");
  });

  it("4. validates ancestor membership, output schema fields, balanced delimiters, and extracts pills/placeholders", () => {
    const ancestors = {
      trig_invoice: ["id", "amount", "status", "customer_email"],
      step_if: ["matched", "branch", "value"],
    };

    expect(
      validateStepExpression(
        "Send to {{steps.trig_invoice.output.customer_email}} for {{steps.trig_invoice.output.id}}",
        ancestors,
      ),
    ).toEqual({ ok: true, errors: [] });

    const nonAncestor = validateStepExpression(
      "{{steps.downstream_node.output.customer_email}}",
      ancestors,
    );
    expect(nonAncestor.ok).toBe(false);
    expect(nonAncestor.reason).toContain(
      "Node 'downstream_node' is not an upstream ancestor of this step",
    );

    const unknownField = validateStepExpression(
      "{{steps.trig_invoice.output.non_existent_column}}",
      ancestors,
    );
    expect(unknownField.ok).toBe(false);
    expect(unknownField.reason).toContain(
      "Field 'non_existent_column' does not exist on upstream node 'trig_invoice'",
    );

    const unsafeProp = validateStepExpression(
      "{{steps.trig_invoice.output.__proto__.hack}}",
      ancestors,
    );
    expect(unsafeProp.ok).toBe(false);
    expect(unsafeProp.reason).toContain("Unsafe property segment '__proto__' is forbidden");

    const unbalanced = validateStepExpression("Hello {{steps.trig_invoice.output.id", ancestors);
    expect(unbalanced.ok).toBe(false);
    expect(unbalanced.reason).toContain("Unbalanced");

    const pills = extractStepExpressionPills(
      "To: {{steps.trig_invoice.output.customer_email}} (#{{steps.trig_invoice.output.id}})",
    );
    expect(pills.map((p) => p.fieldPath)).toEqual(["customer_email", "id"]);

    expect(
      extractTemplatePlaceholders(
        "Hello {{customer_name}}, invoice {invoice_id} via {{steps.trig_invoice.output.id}}",
      ),
    ).toEqual(["customer_name", "invoice_id"]);
  });

  it("5. resolves {{steps.<nodeId>.output.<field>}} pills automatically inside runGraph()", async () => {
    const registry = buildRegistryFromCatalog();
    const executors = buildExecutorsFromCatalog();

    const graph = {
      nodes: [
        {
          id: "trig_1",
          type: "core.brick_event",
          data: { event: "invoices.record_created", entity: "invoices" },
        },
        {
          id: "if_paid",
          type: "core.if",
          data: {
            field: "{{steps.trig_1.output.status}}",
            operator: "eq",
            value: "paid",
          },
        },
        {
          id: "format_email",
          type: "core.format_template",
          data: {
            template:
              "Receipt for invoice {{steps.trig_1.output.id}} (${{steps.trig_1.output.amount}}) sent to {{steps.trig_1.output.customer_email}}",
          },
        },
      ],
      edges: [
        { id: "e1", source: "trig_1", sourceHandle: "out", target: "if_paid", targetHandle: "in" },
        {
          id: "e2",
          source: "if_paid",
          sourceHandle: "true",
          target: "format_email",
          targetHandle: "in",
        },
      ],
    };

    const res = await runGraph(graph, registry, executors, { workspaceId: "ws_test",
      payload: {
        id: "inv_42",
        amount: 99,
        status: "paid",
        customer_email: "buyer@example.com",
      },
    });

    expect(res.ok).toBe(true);
    expect(res.outputs.if_paid?.out).toMatchObject({ matched: true, branch: "true" });
    expect(res.outputs.format_email?.out).toBe(
      "Receipt for invoice inv_42 ($99) sent to buyer@example.com",
    );
  });
});
