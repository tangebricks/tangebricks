import { describe, expect, test } from "vitest";
import {
  ManifestSchema,
  NodePackManifestSchema,
  assemble,
  hashFiles,
} from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import {
  applyOp,
  buildCatalogNodeRegistry,
  createEmptyBlueprint,
  toAssemblerBlueprint,
} from "@poc/blueprint";
import * as coreNodesModule from "../src/index.ts";
import {
  CORE_NODE_TYPES,
  coreNodeDefinitions,
  coreNodeExecutors,
  coreNodesManifest,
} from "../src/index.ts";
import { PLACEHOLDER_BRICK_EXECUTOR_MODULES, buildExecutorsFromCatalog, buildRegistryFromCatalog, runGraph } from "@poc/runtime";
import { GraphWorkflow } from "@poc/sdk";
import * as creditWalletMod from "../../../bricks/credit-wallet/src/index.ts";
import * as dynamicEntitiesMod from "../../../bricks/dynamic-entities/src/index.ts";
import * as inAppNotificationsMod from "../../../bricks/in-app-notifications/src/index.ts";
import * as omnichannelOutboundMod from "../../../bricks/omnichannel-outbound/src/index.ts";
import * as scriptingSandboxMod from "../../../bricks/scripting-sandbox/src/index.ts";
import * as webhookGatewayMod from "../../../bricks/webhook-gateway/src/index.ts";

const coreNodeSources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const EXPECTED_19_CORE_NODES = [
  "core.webhook",
  "core.schedule",
  "core.brick_event",
  "core.if",
  "core.switch",
  "core.loop",
  "core.map",
  "core.merge",
  "core.delay",
  "core.filter",
  "core.noop",
  "core.field_map",
  "core.rename_keys",
  "core.format_template",
  "core.json_transform",
  "core.math",
  "core.date_time",
  "core.http_request",
  "core.batch",
] as const;

const WORKFLOW_BRICKS = [
  "credit-wallet",
  "dynamic-entities",
  "omnichannel-outbound",
  "in-app-notifications",
  "webhook-gateway",
  "scripting-sandbox",
] as const;

const BRICK_EXPORTS: Record<string, Readonly<Record<string, unknown>>> = {
  "@poc/credit-wallet": creditWalletMod,
  "@poc/dynamic-entities": dynamicEntitiesMod,
  "@poc/omnichannel-outbound": omnichannelOutboundMod,
  "@poc/in-app-notifications": inAppNotificationsMod,
  "@poc/webhook-gateway": webhookGatewayMod,
  "@poc/scripting-sandbox": scriptingSandboxMod,
};

describe("ManifestSchema v2 and @poc/core-nodes conformance", () => {
  test("core-nodes.manifest.json validates against NodePackManifestSchema v2 with all 19 core nodes and production maturity", () => {
    const parsed = NodePackManifestSchema.safeParse(coreNodesManifest);
    expect(parsed.success).toBe(true);
    expect(coreNodesManifest.manifestVersion).toBe(2);
    expect(coreNodesManifest.kind).toBe("node-pack");
    expect(coreNodesManifest.ui.maturity).toBe("production");

    const declaredTypes = coreNodeDefinitions.map((n) => n.type);
    expect(declaredTypes).toEqual([...EXPECTED_19_CORE_NODES]);
    expect(CORE_NODE_TYPES).toEqual([...EXPECTED_19_CORE_NODES]);

    for (const node of coreNodeDefinitions) {
      const fn = (coreNodesModule as Record<string, unknown>)[node.executor];
      expect(typeof fn, `executor ${node.executor} for ${node.type}`).toBe("function");
      expect(typeof coreNodeExecutors.get(node.type)).toBe("function");
    }
  });

  test("packages/core-nodes contains zero eval/new Function and zero legacy adapter references", () => {
    const legacyAdapterToken = ["daf", "thunk"].join("");
    const sourceEntries = Object.entries(coreNodeSources);
    expect(sourceEntries.length).toBeGreaterThan(0);
    for (const [path, sourceText] of sourceEntries) {
      expect(sourceText, path).not.toMatch(/\beval\s*\(/);
      expect(sourceText, path).not.toMatch(/\bnew\s+Function\b/);
      expect(sourceText.toLowerCase(), path).not.toContain(legacyAdapterToken);
    }

    const catalogJsonText = JSON.stringify(catalog);
    expect(catalogJsonText.toLowerCase()).not.toContain(legacyAdapterToken);
    expect(catalog.catalogVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.nodePacks?.["core-nodes"]?.manifest.nodes.length).toBe(19);
  });

  test("workflow-participating bricks declare valid ManifestSchema v2 nodes[] and export matching executors", () => {
    for (const brickId of WORKFLOW_BRICKS) {
      const entry = catalog.bricks[brickId];
      expect(entry, `brick ${brickId} in catalog`).toBeDefined();
      const parsed = ManifestSchema.safeParse(entry!.manifest);
      expect(parsed.success, `${brickId} ManifestSchema v2`).toBe(true);
      expect(entry!.manifest.ui?.maturity).toMatch(/^(production|beta|experimental)$/);
      expect((entry!.manifest.nodes ?? []).length, `${brickId} nodes count`).toBeGreaterThan(0);

      const pkgExports = BRICK_EXPORTS[entry!.manifest.worker.package];
      expect(pkgExports, `exports for ${entry!.manifest.worker.package}`).toBeDefined();
      for (const node of entry!.manifest.nodes ?? []) {
        expect(
          typeof pkgExports![node.executor],
          `${brickId} node ${node.type} executor ${node.executor}`,
        ).toBe("function");
      }
    }
  });

  test("blueprint applyOp validates add_node, update_node, and connect_edges against catalog nodes[] port definitions", () => {
    const registry = buildCatalogNodeRegistry(catalog);
    expect(registry.has("core.webhook")).toBe(true);
    expect(registry.has("core.math")).toBe(true);
    expect(registry.has("core.loop")).toBe(true);
    expect(registry.has("credit-wallet.debit")).toBe(true);

    let state = createEmptyBlueprint("wf-port-test");
    const addWf = applyOp(
      state,
      {
        opId: "op-1",
        type: "add_workflow",
        workflow: { id: "wf-main", name: "Port Validation Workflow", nodes: [], edges: [] },
      },
      catalog,
    );
    expect(addWf.ok).toBe(true);
    if (!addWf.ok) return;
    state = addWf.state;

    // Adding a node with an invalid config value is rejected by applyOp
    const badConfigNode = applyOp(
      state,
      {
        opId: "op-bad-cfg",
        type: "add_node",
        workflowId: "wf-main",
        node: {
          id: "bad-http",
          type: "core.http_request",
          data: { method: "INVALID_VERB" },
        },
      },
      catalog,
    );
    expect(badConfigNode.ok).toBe(false);
    if (!badConfigNode.ok) {
      expect(badConfigNode.errors[0]?.code).toBe("invalid_config");
    }

    // Add valid trigger, math node (outputs number), and loop node (requires array input on port 'in')
    for (const op of [
      {
        opId: "op-n1",
        type: "add_node",
        workflowId: "wf-main",
        node: { id: "trig", type: "core.webhook", data: { path: "/hook", method: "post" } },
      },
      {
        opId: "op-n2",
        type: "add_node",
        workflowId: "wf-main",
        node: { id: "math1", type: "core.math", data: { operation: "add", a: 10, b: 5 } },
      },
      {
        opId: "op-n3",
        type: "add_node",
        workflowId: "wf-main",
        node: { id: "loop1", type: "core.loop", data: { maxIterations: 10 } },
      },
    ]) {
      const res = applyOp(state, op, catalog);
      expect(res.ok).toBe(true);
      if (res.ok) state = res.state;
    }

    // update_node with invalid config is rejected
    const badUpdate = applyOp(
      state,
      {
        opId: "op-upd-bad",
        type: "update_node",
        workflowId: "wf-main",
        nodeId: "math1",
        data: { operation: "not_an_op" },
      },
      catalog,
    );
    expect(badUpdate.ok).toBe(false);

    // Connecting core.math.out (number) -> core.loop.in (array) is rejected with incompatible_wire
    const badEdge = applyOp(
      state,
      {
        opId: "op-edge-bad",
        type: "connect_edges",
        workflowId: "wf-main",
        edges: [
          {
            id: "e-trig-math",
            source: "trig",
            sourceHandle: "out",
            target: "math1",
            targetHandle: "in",
          },
          {
            id: "e-math-loop",
            source: "math1",
            sourceHandle: "out",
            target: "loop1",
            targetHandle: "in",
          },
        ],
      },
      catalog,
    );
    expect(badEdge.ok).toBe(false);
    if (!badEdge.ok) {
      expect(badEdge.errors.some((e) => e.code === "incompatible_wire")).toBe(true);
    }
  });

  test("executes all 19 core nodes and brick nodes inside GraphWorkflow (runGraph) with deterministic outputs", async () => {
    const registry = buildRegistryFromCatalog(catalog);
    const executors = buildExecutorsFromCatalog(catalog, BRICK_EXPORTS);

    // 1. Trigger core.webhook -> core.field_map -> core.rename_keys -> core.format_template -> core.json_transform -> core.noop
    const wf1Runner = new GraphWorkflow(registry, executors);
    const res1 = await wf1Runner.start({
      graph: {
        nodes: [
          { id: "t1", type: "core.webhook", data: { method: "post" } },
          {
            id: "fm",
            type: "core.field_map",
            data: { mappings: { userName: "user.name", baseScore: "score" } },
          },
          {
            id: "rk",
            type: "core.rename_keys",
            data: { rename: { userName: "customer" } },
          },
          {
            id: "ft",
            type: "core.format_template",
            data: { template: "Hello {{customer}} ({{baseScore}})" },
          },
          {
            id: "jt",
            type: "core.json_transform",
            data: { path: "customer", wrapKey: "selectedCustomer" },
          },
          { id: "np", type: "core.noop", data: {} },
        ],
        edges: [
          { id: "e1", source: "t1", sourceHandle: "out", target: "fm", targetHandle: "in" },
          { id: "e2", source: "fm", sourceHandle: "out", target: "rk", targetHandle: "in" },
          { id: "e3", source: "rk", sourceHandle: "out", target: "ft", targetHandle: "in" },
          { id: "e4", source: "rk", sourceHandle: "out", target: "jt", targetHandle: "in" },
          { id: "e5", source: "ft", sourceHandle: "out", target: "np", targetHandle: "in" },
        ],
      },
      payload: { user: { name: "Ada" }, score: 42 },
    });
    expect(res1.ok).toBe(true);
    expect(res1.outputs.fm?.out).toEqual({ userName: "Ada", baseScore: 42 });
    expect(res1.outputs.rk?.out).toEqual({ customer: "Ada", baseScore: 42 });
    expect(res1.outputs.ft?.out).toBe("Hello Ada (42)");
    expect(res1.outputs.jt?.out).toEqual({ selectedCustomer: "Ada" });
    expect(res1.outputs.np?.out).toBe("Hello Ada (42)");

    // 2. Trigger core.schedule -> core.json_transform (extracts array) -> core.loop -> core.filter -> core.map -> core.math -> core.date_time -> core.delay
    const wf2 = await runGraph(
      {
        nodes: [
          { id: "sched", type: "core.schedule", data: { intervalMinutes: 60 } },
          { id: "extract", type: "core.json_transform", data: { path: "items" } },
          { id: "loop", type: "core.loop", data: { maxIterations: 3 } },
          { id: "filt", type: "core.filter", data: { field: "active", equals: true } },
          { id: "map", type: "core.map", data: { field: "points" } },
          { id: "math", type: "core.math", data: { operation: "add", a: 3, b: 5 } },
          {
            id: "dt",
            type: "core.date_time",
            data: { iso: "2026-01-01T00:00:00.000Z", addSeconds: 60 },
          },
          { id: "dly", type: "core.delay", data: { delayMs: 10 } },
        ],
        edges: [
          { id: "e1", source: "sched", sourceHandle: "out", target: "extract", targetHandle: "in" },
          { id: "e2", source: "extract", sourceHandle: "out", target: "loop", targetHandle: "in" },
          { id: "e3", source: "loop", sourceHandle: "out", target: "filt", targetHandle: "in" },
          { id: "e4", source: "filt", sourceHandle: "out", target: "map", targetHandle: "in" },
          { id: "e5", source: "map", sourceHandle: "out", target: "math", targetHandle: "in" },
          { id: "e6", source: "sched", sourceHandle: "out", target: "dt", targetHandle: "in" },
          { id: "e7", source: "math", sourceHandle: "out", target: "dly", targetHandle: "in" },
        ],
      },
      registry,
      executors,
      {
        payload: {
          items: [
            { active: true, points: 10 },
            { active: false, points: 20 },
            { active: true, points: 30 },
            { active: true, points: 40 },
          ],
        },
      },
    );
    expect(wf2.ok).toBe(true);
    expect(wf2.outputs.loop?.out).toEqual([
      { active: true, points: 10, _index: 0 },
      { active: false, points: 20, _index: 1 },
      { active: true, points: 30, _index: 2 },
    ]);
    expect(wf2.outputs.filt?.out).toEqual([
      { active: true, points: 10, _index: 0 },
      { active: true, points: 30, _index: 2 },
    ]);
    expect(wf2.outputs.map?.out).toEqual([10, 30]);
    expect(wf2.outputs.math?.out).toBe(8);
    expect(wf2.outputs.dt?.out).toBe("2026-01-01T00:01:00.000Z");
    expect(wf2.outputs.dly?.out).toBe(8);

    // 3. Trigger core.brick_event -> core.if + core.switch + core.merge + core.http_request
    const wf3 = await runGraph(
      {
        nodes: [
          {
            id: "be",
            type: "core.brick_event",
            data: { event: "wallet.low_balance" },
          },
          {
            id: "if1",
            type: "core.if",
            data: { field: "severity", operator: "eq", value: "high" },
          },
          {
            id: "sw1",
            type: "core.switch",
            data: { field: "channel", cases: { email: "email_route" } },
          },
          { id: "mrg", type: "core.merge", data: { mode: "combine" } },
          {
            id: "http",
            type: "core.http_request",
            data: { url: "https://api.example.com/hook", method: "post", timeoutMs: 2000 },
          },
        ],
        edges: [
          { id: "e1", source: "be", sourceHandle: "out", target: "if1", targetHandle: "in" },
          { id: "e2", source: "be", sourceHandle: "out", target: "sw1", targetHandle: "in" },
          { id: "e3", source: "if1", sourceHandle: "true", target: "mrg", targetHandle: "a" },
          { id: "e4", source: "sw1", sourceHandle: "out", target: "mrg", targetHandle: "b" },
          { id: "e5", source: "mrg", sourceHandle: "out", target: "http", targetHandle: "in" },
        ],
      },
      registry,
      executors,
      {
        payload: { severity: "high", channel: "email" },
      },
    );
    // Story 0.9 (R-B): live fetch is off and no fixture is injected, so the HTTP step fails with
    // NOT_CONFIGURED instead of reporting a fabricated 200.
    expect(wf3.ok).toBe(false);
    expect(wf3.outputs.if1?.out).toMatchObject({ matched: true, branch: "true" });
    expect(wf3.outputs.sw1?.out).toMatchObject({ branch: "email_route" });
    expect(wf3.outputs.http).toBeUndefined();
    expect(wf3.failed.http).toMatch(/^NOT_CONFIGURED: core\.http_request/);

    // 4. Execute brick workflow nodes (webhook-gateway, dynamic-entities, credit-wallet, omnichannel-outbound, in-app-notifications, scripting-sandbox)
    const wfBricks = await runGraph(
      {
        nodes: [
          { id: "wh", type: "webhook-gateway.inbound_webhook", data: {} },
          { id: "de", type: "dynamic-entities.create_record", data: { entity: "invoices" } },
          { id: "cw1", type: "credit-wallet.credit", data: { amount: 50 } },
          { id: "cw2", type: "credit-wallet.debit", data: { amount: 20 } },
          { id: "oo", type: "omnichannel-outbound.send_message", data: { channel: "slack" } },
          { id: "ian", type: "in-app-notifications.send", data: {} },
          { id: "ss", type: "scripting-sandbox.run_script", data: { scriptId: "enrich" } },
        ],
        edges: [
          { id: "e1", source: "wh", sourceHandle: "out", target: "de", targetHandle: "in" },
          { id: "e2", source: "de", sourceHandle: "out", target: "cw1", targetHandle: "in" },
          { id: "e3", source: "cw1", sourceHandle: "out", target: "cw2", targetHandle: "in" },
          { id: "e4", source: "cw2", sourceHandle: "out", target: "oo", targetHandle: "in" },
          { id: "e5", source: "oo", sourceHandle: "out", target: "ian", targetHandle: "in" },
          { id: "e6", source: "ian", sourceHandle: "out", target: "ss", targetHandle: "in" },
        ],
      },
      registry,
      // Story 0.9: the real credit-wallet exports are D1-backed (debit) or NOT_CONFIGURED (credit); this pure
      // chain injects the test-only placeholders for them explicitly.
      buildExecutorsFromCatalog(catalog, {
        ...BRICK_EXPORTS,
        "@poc/credit-wallet": PLACEHOLDER_BRICK_EXECUTOR_MODULES["@poc/credit-wallet"]!,
      }),
      {
        payload: { invoiceId: "inv_1" },
      },
    );
    // Story 0.9 (B11): the real omnichannel-outbound export has no delivery adapter, so the send step fails
    // NOT_CONFIGURED and nothing downstream runs. It never reports dispatched: true.
    expect(wfBricks.ok).toBe(false);
    expect(wfBricks.outputs.cw1?.out).toMatchObject({ operation: "credit", credited: 50 });
    expect(wfBricks.outputs.cw2?.out).toMatchObject({ operation: "debit", debited: 20 });
    expect(wfBricks.outputs.oo).toBeUndefined();
    // The real credit export never fakes a balance.
    await expect(
      (BRICK_EXPORTS["@poc/credit-wallet"]!.executeWalletCredit as (ctx: unknown) => Promise<unknown>)({ nodeId: "cw", data: { amount: 5 }, inputs: { in: {} } }),
    ).rejects.toThrow(/^NOT_CONFIGURED: credit-wallet\.credit/);
    expect(wfBricks.failed.oo).toMatch(/^NOT_CONFIGURED: omnichannel-outbound\.send_message/);

    // With the test-only placeholder send injected explicitly, the rest of the chain runs.
    const wfBricksFake = await runGraph(
      {
        nodes: [
          { id: "wh", type: "webhook-gateway.inbound_webhook", data: {} },
          { id: "oo", type: "omnichannel-outbound.send_message", data: { channel: "slack" } },
          { id: "ian", type: "in-app-notifications.send", data: {} },
          { id: "ss", type: "scripting-sandbox.run_script", data: { scriptId: "enrich" } },
        ],
        edges: [
          { id: "e4", source: "wh", sourceHandle: "out", target: "oo", targetHandle: "in" },
          { id: "e5", source: "oo", sourceHandle: "out", target: "ian", targetHandle: "in" },
          { id: "e6", source: "ian", sourceHandle: "out", target: "ss", targetHandle: "in" },
        ],
      },
      registry,
      buildExecutorsFromCatalog(catalog, {
        ...BRICK_EXPORTS,
        "@poc/omnichannel-outbound": PLACEHOLDER_BRICK_EXECUTOR_MODULES["@poc/omnichannel-outbound"]!,
      }),
      { payload: { invoiceId: "inv_1" } },
    );
    expect(wfBricksFake.ok).toBe(true);
    expect(wfBricksFake.outputs.oo?.out).toMatchObject({ dispatched: true, channel: "slack" });
    expect(wfBricksFake.outputs.ian?.out).toMatchObject({ delivered: true });
    expect(wfBricksFake.outputs.ss?.out).toMatchObject({ scriptId: "enrich" });

    // Also test dynamic-entities.record_created trigger node
    const wfEntityTrigger = await runGraph(
      {
        nodes: [
          { id: "tr", type: "dynamic-entities.record_created", data: { entity: "tasks" } },
          { id: "np", type: "core.noop", data: {} },
        ],
        edges: [{ id: "e1", source: "tr", sourceHandle: "out", target: "np", targetHandle: "in" }],
      },
      registry,
      executors,
      {
        payload: { id: "rec_1", title: "Ship CP3" },
      },
    );
    expect(wfEntityTrigger.ok).toBe(true);
    expect(wfEntityTrigger.outputs.np?.out).toEqual({
      entity: "tasks",
      record: { id: "rec_1", title: "Ship CP3" },
    });
  });

  test("modifying a workflow node config or secretRefs binding deterministically updates src/workflows.json, project.json, and assemble() buildHash", async () => {
    let stateA = createEmptyBlueprint("wf-hash-project");
    for (const op of [
      { opId: "1", type: "enable_brick", brickId: "multi-workspace", config: {} },
      { opId: "2", type: "enable_brick", brickId: "credit-wallet", config: {} },
      {
        opId: "3",
        type: "add_workflow",
        workflow: {
          id: "wf-billing",
          name: "Billing Flow",
          nodes: [
            { id: "trig", type: "core.webhook", data: { method: "post" } },
            { id: "debit", type: "credit-wallet.debit", data: { amount: 10 } },
          ],
          edges: [
            {
              id: "e1",
              source: "trig",
              sourceHandle: "out",
              target: "debit",
              targetHandle: "in",
            },
          ],
        },
      },
      {
        opId: "4",
        type: "bind_secret_ref",
        ref: "sec_webhook_key_v1",
        targetKind: "connection",
        targetId: "wf-billing-trig",
        secretName: "WEBHOOK_SECRET",
      },
    ]) {
      const res = applyOp(stateA, op, catalog);
      expect(res.ok).toBe(true);
      if (res.ok) stateA = res.state;
    }

    const assembledA = assemble(toAssemblerBlueprint(stateA), catalog);
    expect(assembledA.ok).toBe(true);
    if (!assembledA.ok) return;
    expect(assembledA.files["src/workflows.json"]).toBeDefined();
    expect(JSON.parse(assembledA.files["project.json"]!).secretRefs).toEqual([
      {
        ref: "sec_webhook_key_v1",
        secretName: "WEBHOOK_SECRET",
        targetId: "wf-billing-trig",
        targetKind: "connection",
      },
    ]);
    const hashA = await hashFiles(assembledA.files);

    // Modify workflow node config (amount: 10 -> 25)
    const modNode = applyOp(
      stateA,
      {
        opId: "5",
        type: "update_node",
        workflowId: "wf-billing",
        nodeId: "debit",
        data: { amount: 25 },
      },
      catalog,
    );
    expect(modNode.ok).toBe(true);
    if (!modNode.ok) return;
    const assembledB = assemble(toAssemblerBlueprint(modNode.state), catalog);
    expect(assembledB.ok).toBe(true);
    if (!assembledB.ok) return;
    const hashB = await hashFiles(assembledB.files);
    expect(hashB).not.toBe(hashA);

    // Modify secretRefs handle (sec_webhook_key_v1 -> sec_webhook_key_v2)
    const modSecret = applyOp(
      stateA,
      {
        opId: "6",
        type: "bind_secret_ref",
        ref: "sec_webhook_key_v2",
        targetKind: "connection",
        targetId: "wf-billing-trig",
        secretName: "WEBHOOK_SECRET",
      },
      catalog,
    );
    expect(modSecret.ok).toBe(true);
    if (!modSecret.ok) return;
    const assembledC = assemble(toAssemblerBlueprint(modSecret.state), catalog);
    expect(assembledC.ok).toBe(true);
    if (!assembledC.ok) return;
    const hashC = await hashFiles(assembledC.files);
    expect(hashC).not.toBe(hashA);
    expect(hashC).not.toBe(hashB);
  });
});
