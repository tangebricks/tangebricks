import { expect, test } from "@playwright/test";
import { assemble } from "@poc/assembler";
import { catalog } from "@poc/assembler/catalog";
import {
  canonicalSemanticPayload,
  semanticHash,
  toAssemblerBlueprint,
} from "@poc/blueprint";
import type { BlueprintState } from "@poc/blueprint";
import { computeBuildHash } from "../../studio-api/src/index.ts";
import { e2eProjectToken } from "./project-token.ts";

test.describe("UI-vs-MCP 'invoice -> email' buildHash & semanticHash Parity Proof (Real Backend)", () => {
  test("builds 'invoice -> email' SaaS backend in Chromium UI vs MCP tools, proves identical normalized semanticHash and assemble() buildHash, and co-authors live credit-wallet step on canvas within 2s", async ({
    page,
    request,
  }) => {
    await page.goto("/?newProject=invoice-ui");

    // Sign in as owner against real Better Auth + STUDIO_DB
    await page.getByTestId("auth-email-input").fill("alice@example.com");
    await page.getByTestId("auth-password-input").fill("password12345");
    await page.getByTestId("auth-submit-button").click();

    await expect(page.getByTestId("studio-shell")).toBeVisible();

    // Create empty project `invoice-ui` via UI button
    await page.getByTestId("new-project-button").click();
    await expect(page.getByTestId("project-selector")).toHaveValue("invoice-ui");
    await expect(page.getByTestId("topbar-revision-badge")).toHaveText("r0");

    // =========================================================================
    // SURFACE 1: Visual UI in Chromium (`invoice-ui`)
    // =========================================================================

    // 1. Enable bricks (`core-auth`, `credit-wallet` auto-enabling `multi-workspace`, `dynamic-entities`, `omnichannel-outbound`) and configure settings
    await page.getByTestId("nav-tab-bricks").click();
    await expect(page.getByTestId("view-bricks")).toBeVisible();

    // Enable `core-auth` (also sets identity to `core-auth`)
    await page.getByTestId("catalog-brick-enable-core-auth").click();
    await page.getByTestId("brick-enable-confirm").click();
    await expect(page.getByTestId("enabled-brick-card-core-auth")).toBeVisible();

    // Enable `credit-wallet` -> Dependency Preview auto-enables `multi-workspace` (`workspace-context`)
    await page.getByTestId("catalog-brick-enable-credit-wallet").click();
    await expect(page.getByTestId("brick-enable-modal")).toBeVisible();
    await expect(page.getByTestId("brick-enable-requires")).toContainText(
      "Also turns on: multi-workspace (required)",
    );
    await expect(page.getByTestId("brick-enable-req-multi-workspace")).toContainText(
      "provides workspace-context",
    );
    await page.getByTestId("brick-enable-confirm").click();
    await expect(page.getByTestId("enabled-brick-card-multi-workspace")).toBeVisible();
    await expect(page.getByTestId("enabled-brick-card-credit-wallet")).toBeVisible();

    // Enable `dynamic-entities`
    await page.getByTestId("catalog-brick-enable-dynamic-entities").click();
    await page.getByTestId("brick-enable-confirm").click();
    await expect(page.getByTestId("enabled-brick-card-dynamic-entities")).toBeVisible();

    // Enable `omnichannel-outbound`
    await page.getByTestId("catalog-brick-enable-omnichannel-outbound").click();
    await page.getByTestId("brick-enable-confirm").click();
    await expect(
      page.getByTestId("enabled-brick-card-omnichannel-outbound"),
    ).toBeVisible();

    // Configure `credit-wallet` settings via Right Dock Inspector form (`creditsPerUnit = 25`, `minOrderAmount = 100`)
    await page.getByTestId("enabled-brick-card-credit-wallet").click();
    await expect(page.getByTestId("inspector-brick-detail")).toBeVisible();
    await page.getByTestId("setting-input-creditsPerUnit").fill("25");
    await page.getByTestId("setting-input-minOrderAmount").fill("100");
    await page.getByTestId("brick-settings-save").click();
    await expect(page.getByTestId("brick-settings-saved-badge")).toBeVisible();

    // 2. Create entity `invoices` (`amount: number`, `status: enum(draft|paid|void)`, `customer_email: string`) in Visual Entity Designer
    await page.getByTestId("nav-tab-data").click();
    await expect(page.getByTestId("view-data")).toBeVisible();

    await page.getByTestId("new-entity-button").click();
    await page.getByTestId("entity-name-input").fill("invoices");

    // Field 0: amount (number, required)
    await page.getByTestId("field-name-input-0").fill("amount");
    await page.getByTestId("field-type-select-0").selectOption("number");

    // Field 1: status (enum: draft, paid, void, required)
    await page.getByTestId("add-field-button").click();
    await page.getByTestId("field-name-input-1").fill("status");
    await page.getByTestId("field-type-select-1").selectOption("enum");
    await page.getByTestId("field-enum-values-input-1").fill("draft, paid, void");
    await page.getByTestId("field-required-toggle-1").check();

    // Field 2: customer_email (text/string, required)
    await page.getByTestId("add-field-button").click();
    await page.getByTestId("field-name-input-2").fill("customer_email");
    await page.getByTestId("field-type-select-2").selectOption("text");
    await page.getByTestId("field-required-toggle-2").check();

    await page.getByTestId("save-entity-button").click();
    await expect(page.getByTestId("entity-saved-badge")).toBeVisible();

    // 3. Create secret `email_api_key` (`sec_email_api_key`) in Connections & Secrets Center and bind via `bind_secret_ref`
    await page.getByTestId("nav-tab-connections").click();
    await expect(page.getByTestId("view-connections")).toBeVisible();

    await page.getByTestId("add-secret-button").click();
    await expect(page.getByTestId("add-secret-modal")).toBeVisible();
    await page.getByTestId("secret-kind-select").selectOption("api_key");
    await page.getByTestId("secret-label-input").fill("email_api_key");
    await page.getByTestId("secret-handle-input").fill("sec_email_api_key");
    await page.getByTestId("secret-app-input").fill("omnichannel-outbound");
    await page.getByTestId("secret-value-input").fill("re_live_invoice_email_key_7788");
    await page
      .getByTestId("secret-bind-target-select")
      .selectOption("brick:core-auth:BETTER_AUTH_SECRET");
    await page.getByTestId("save-secret-submit").click();

    await expect(page.getByTestId("secret-row-sec_email_api_key")).toBeVisible();
    await expect(page.getByTestId("secret-key-hint-sec_email_api_key")).toHaveText(
      "••••7788",
    );

    // 4. Create workflow `"invoice-paid-email"` on the Canvas with zero typed '{{' characters
    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();

    await page.getByTestId("new-workflow-button").click();
    await page.getByTestId("new-workflow-name-input").fill("invoice-paid-email");
    await page.getByTestId("create-workflow-confirm").click();
    await expect(page.getByTestId("workflow-selector")).toHaveValue(
      "wf-invoice-paid-email",
    );

    const trigNodeId = "node-brick-event-1";
    const ifNodeId = "node-if-2";
    const formatNodeId = "node-format-template-3";
    const emailNodeId = "node-omnichannel-outbound-send-message-4";

    await page.getByTestId("palette-add-node-core.brick_event").click();
    await expect(page.getByTestId(`canvas-node-${trigNodeId}`)).toBeVisible();

    await page.getByTestId("palette-add-node-core.if").click();
    await expect(page.getByTestId(`canvas-node-${ifNodeId}`)).toBeVisible();

    await page.getByTestId("palette-add-node-core.format_template").click();
    await expect(page.getByTestId(`canvas-node-${formatNodeId}`)).toBeVisible();

    await page
      .getByTestId("palette-add-node-omnichannel-outbound.send_message")
      .click();
    await expect(page.getByTestId(`canvas-node-${emailNodeId}`)).toBeVisible();

    // Configure Trigger node: bind to `invoices` entity
    await page.getByTestId(`canvas-node-${trigNodeId}`).click();
    await expect(page.getByTestId("inspector-node-id")).toHaveText(trigNodeId);
    await page.getByTestId("node-entity-select").selectOption("invoices");
    await expect(page.getByTestId("dynamic-port-out-col-amount")).toContainText(
      "col-amount:number",
    );
    await expect(page.getByTestId("dynamic-port-out-col-status")).toContainText(
      "col-status:string",
    );
    await expect(page.getByTestId("dynamic-port-out-col-customer_email")).toContainText(
      "col-customer_email:string",
    );
    await page.getByTestId("inspector-node-save").click();
    await expect(page.getByTestId("inspector-node-saved-badge")).toBeVisible();

    // Connect wires: trigNodeId::out -> ifNodeId::in, ifNodeId::true -> formatNodeId::in, formatNodeId::out -> emailNodeId::in
    const wireSource = page.getByTestId("wire-source-select");
    const wireTarget = page.getByTestId("wire-target-select");
    const wireConnectBtn = page.getByTestId("wire-connect-button");

    await wireSource.selectOption(`${trigNodeId}::out`);
    await wireTarget.selectOption(`${ifNodeId}::in`);
    await wireConnectBtn.click();

    await wireSource.selectOption(`${ifNodeId}::true`);
    await wireTarget.selectOption(`${formatNodeId}::in`);
    await wireConnectBtn.click();

    await wireSource.selectOption(`${formatNodeId}::out`);
    await wireTarget.selectOption(`${emailNodeId}::in`);
    await wireConnectBtn.click();

    // Configure `ifNodeId` via Data-Pill Picker (zero typed '{{' characters): status == "paid"
    await page.getByTestId(`canvas-node-${ifNodeId}`).click();
    await expect(page.getByTestId("inspector-node-id")).toHaveText(ifNodeId);
    await page.getByTestId("open-pill-picker-field").click();
    await page.getByTestId(`pill-option-${trigNodeId}-status`).click();
    await expect(page.getByTestId("data-pill-chip-field-status")).toBeVisible();
    await page.getByTestId("node-config-input-value").fill("paid");
    await page.getByTestId("inspector-node-save").click();
    await expect(page.getByTestId("inspector-node-saved-badge")).toBeVisible();

    // Configure `formatNodeId` via Data-Pill Picker (zero typed '{{' characters): to = customer_email, template = amount
    await page.getByTestId(`canvas-node-${formatNodeId}`).click();
    await expect(page.getByTestId("inspector-node-id")).toHaveText(formatNodeId);
    await page.getByTestId("open-pill-picker-to").click();
    await page.getByTestId(`pill-option-${trigNodeId}-customer_email`).click();
    await expect(page.getByTestId("data-pill-chip-to-customer_email")).toBeVisible();

    await page.getByTestId("open-pill-picker-template").click();
    await page.getByTestId(`pill-option-${trigNodeId}-amount`).click();
    await expect(page.getByTestId("data-pill-chip-template-amount")).toBeVisible();

    await page.getByTestId("inspector-node-save").click();
    await expect(page.getByTestId("inspector-node-saved-badge")).toBeVisible();

    // Configure `emailNodeId`: bind `sec_email_api_key` via `bind_secret_ref` and map `customer_email` + formatted `out` via Data-Pill Picker
    await page.getByTestId(`canvas-node-${emailNodeId}`).click();
    await expect(page.getByTestId("inspector-node-id")).toHaveText(emailNodeId);
    await page
      .getByTestId("select-existing-secret-node")
      .selectOption("sec_email_api_key");
    await expect(page.getByTestId("inspector-node-bound-secret-ref")).toContainText(
      "sec_email_api_key",
    );

    await page.getByTestId("open-pill-picker-to").click();
    await page.getByTestId(`pill-option-${trigNodeId}-customer_email`).click();
    await expect(page.getByTestId("data-pill-chip-to-customer_email")).toBeVisible();

    await page.getByTestId("open-pill-picker-body").click();
    await page.getByTestId(`pill-option-${formatNodeId}-out`).click();
    await expect(page.getByTestId("data-pill-chip-body-out")).toBeVisible();

    await page.getByTestId("inspector-node-save").click();
    await expect(page.getByTestId("inspector-node-saved-badge")).toBeVisible();

    // 5. Reload the page (F5) and verify all bricks, entities, secret bindings, and workflow nodes/edges persist from BlueprintDO
    await page.reload();
    await expect(page.getByTestId("studio-shell")).toBeVisible();
    await expect(page.getByTestId("project-selector")).toHaveValue("invoice-ui");

    await page.getByTestId("nav-tab-workflows").click();
    await expect(page.getByTestId("view-workflows")).toBeVisible();
    await expect(page.getByTestId(`canvas-node-${trigNodeId}`)).toBeVisible();
    await expect(page.getByTestId(`canvas-node-${ifNodeId}`)).toBeVisible();
    await expect(page.getByTestId(`canvas-node-${formatNodeId}`)).toBeVisible();
    await expect(page.getByTestId(`canvas-node-${emailNodeId}`)).toBeVisible();

    // 6. Trigger `POST /api/projects/invoice-ui/build`
    const uiBuildRes = await request.post(
      "http://127.0.0.1:8787/api/projects/invoice-ui/build",
      {
        headers: {
          authorization: `Bearer ${await e2eProjectToken("invoice-ui")}`,
        },
      },
    );
    expect(uiBuildRes.status()).toBe(200);
    const uiBuildJson = (await uiBuildRes.json()) as {
      project: string;
      revision: number;
      buildHash: string;
      files: number;
      bytes: number;
    };
    expect(uiBuildJson.project).toBe("invoice-ui");
    expect(uiBuildJson.files).toBeGreaterThan(0);

    // Fetch `invoice-ui` state and persisted build artifacts
    const uiStateRes = await request.get(
      "http://127.0.0.1:8787/api/projects/invoice-ui",
      {
        headers: {
          authorization: `Bearer ${await e2eProjectToken("invoice-ui")}`,
        },
      },
    );
    expect(uiStateRes.status()).toBe(200);
    const uiStatePayload = (await uiStateRes.json()) as {
      project: string;
      revision: number;
      semanticHash: string;
      state: BlueprintState;
    };

    const uiBuildArtifactRes = await request.get(
      "http://127.0.0.1:8787/api/projects/invoice-ui/build",
      {
        headers: {
          authorization: `Bearer ${await e2eProjectToken("invoice-ui")}`,
        },
      },
    );
    expect(uiBuildArtifactRes.status()).toBe(200);
    const uiBuildArtifacts = (await uiBuildArtifactRes.json()) as {
      buildHash: string;
      emittedFiles: Record<string, string>;
    };

    // =========================================================================
    // SURFACE 2: MCP Agent Tools (`invoice-mcp`)
    // =========================================================================
    let rpcId = 100;
    const callMcp = async <T = Record<string, unknown>>(
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<T> => {
      // Story 0.15: an MCP token is bound to one project, so each call uses the token of the project it targets
      // (the MCP surface builds `invoice-mcp`; the co-author step below edits `invoice-ui`).
      const project = typeof args.project === "string" ? args.project : "invoice-mcp";
      const res = await request.post("http://127.0.0.1:8787/mcp", {
        headers: {
          authorization: `Bearer ${await e2eProjectToken(project)}`,
          "content-type": "application/json",
        },
        data: {
          jsonrpc: "2.0",
          id: rpcId++,
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
        },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        result: { isError?: boolean; content: Array<{ type: string; text: string }> };
      };
      expect(body.result.isError ?? false).toBe(false);
      return JSON.parse(body.result.content[0]?.text ?? "{}") as T;
    };

    // MCP Step 1: the bricks `core-auth`, `multi-workspace`, `dynamic-entities`, `credit-wallet` (with settings) and
    // `omnichannel-outbound`. AD-V8: credit-wallet is a money brick, so the agent proposes them with `apply_ops` and Alice,
    // signed in to Studio, accepts the proposal (enable_brick would refuse the money brick for an agent).
    const bricksProposal = await callMcp<{ status: string; proposalId: string }>("apply_ops", {
      project: "invoice-mcp",
      summary: "Enable the invoice bricks",
      ops: [
        { opId: "mcp-brick-auth", type: "enable_brick", brickId: "core-auth" },
        { opId: "mcp-brick-ws", type: "enable_brick", brickId: "multi-workspace" },
        { opId: "mcp-brick-ent", type: "enable_brick", brickId: "dynamic-entities" },
        { opId: "mcp-brick-wallet", type: "enable_brick", brickId: "credit-wallet", config: { creditsPerUnit: 25, minOrderAmount: 100 } },
        { opId: "mcp-brick-out", type: "enable_brick", brickId: "omnichannel-outbound" },
      ],
    });
    expect(bricksProposal.status).toBe("pending");
    const acceptBricks = await page.request.post(
      `/api/projects/invoice-mcp/proposals/${encodeURIComponent(bricksProposal.proposalId)}/accept`,
      { data: {} },
    );
    expect(acceptBricks.status()).toBe(200);

    // MCP Step 2: `define_entity` for `invoices`
    await callMcp("define_entity", {
      project: "invoice-mcp",
      entities: [
        {
          name: "invoices",
          workspaceScoped: true,
          fields: [
            { name: "amount", type: "number", required: true },
            {
              name: "status",
              type: "enum",
              required: true,
              values: ["draft", "paid", "void"],
            },
            {
              name: "customer_email",
              type: "text",
              required: true,
              maxLength: 500,
            },
          ],
        },
      ],
    });

    // MCP Step 3: `apply_ops` for identity, workflow `"invoice-paid-email"` (nodes + edges), and `bind_secret_ref`
    await callMcp("apply_ops", {
      project: "invoice-mcp",
      mode: "apply", // AD-V8: preview-safe edits an agent may apply directly
      summary: "Configure identity, invoice-paid-email workflow, and secretRefs",
      ops: [
        {
          opId: "mcp-id-1",
          type: "set_identity",
          identity: "core-auth",
        },
        {
          opId: "mcp-sec-1",
          type: "bind_secret_ref",
          targetKind: "brick",
          targetId: "core-auth",
          secretName: "BETTER_AUTH_SECRET",
          ref: "sec_email_api_key",
        },
        {
          opId: "mcp-sec-2",
          type: "bind_secret_ref",
          targetKind: "connection",
          targetId: emailNodeId,
          secretName: "AUTHORIZATION_BEARER",
          ref: "sec_email_api_key",
        },
        {
          opId: "mcp-wf-1",
          type: "add_workflow",
          workflow: {
            id: "wf-invoice-paid-email",
            name: "invoice-paid-email",
            trigger: { kind: "manual" },
            nodes: [
              {
                id: trigNodeId,
                type: "core.brick_event",
                label: "Brick Event Trigger",
                data: {
                  entity: "invoices",
                  event: "invoices.record_created",
                },
              },
              {
                id: ifNodeId,
                type: "core.if",
                label: "If Condition",
                data: {
                  field: `{{steps.${trigNodeId}.output.status}}`,
                  operator: "eq",
                  value: "paid",
                },
              },
              {
                id: formatNodeId,
                type: "core.format_template",
                label: "Format Template",
                data: {
                  subject: "",
                  template: `{{steps.${trigNodeId}.output.amount}}`,
                  to: `{{steps.${trigNodeId}.output.customer_email}}`,
                },
              },
              {
                id: emailNodeId,
                type: "omnichannel-outbound.send_message",
                label: "Send Outbound Message",
                data: {
                  body: `{{steps.${formatNodeId}.output.out}}`,
                  channel: "email",
                  subject: "",
                  to: `{{steps.${trigNodeId}.output.customer_email}}`,
                },
              },
            ],
            edges: [
              {
                id: `e-${trigNodeId}-out-${ifNodeId}-in`,
                source: trigNodeId,
                target: ifNodeId,
                sourceHandle: "out",
                targetHandle: "in",
              },
              {
                id: `e-${ifNodeId}-true-${formatNodeId}-in`,
                source: ifNodeId,
                target: formatNodeId,
                sourceHandle: "true",
                targetHandle: "in",
              },
              {
                id: `e-${formatNodeId}-out-${emailNodeId}-in`,
                source: formatNodeId,
                target: emailNodeId,
                sourceHandle: "out",
                targetHandle: "in",
              },
            ],
          },
        },
      ],
    });

    // MCP Step 4: `build_project` on `invoice-mcp`
    const mcpBuildJson = await callMcp<{
      project: string;
      revision: number;
      files: number;
      bytes: number;
      hash: string;
    }>("build_project", {
      project: "invoice-mcp",
    });
    expect(mcpBuildJson.project).toBe("invoice-mcp");
    expect(mcpBuildJson.files).toBe(uiBuildJson.files);

    // Fetch `invoice-mcp` state and persisted build artifacts
    const mcpStateRes = await request.get(
      "http://127.0.0.1:8787/api/projects/invoice-mcp",
      {
        headers: {
          authorization: `Bearer ${await e2eProjectToken("invoice-mcp")}`,
        },
      },
    );
    expect(mcpStateRes.status()).toBe(200);
    const mcpStatePayload = (await mcpStateRes.json()) as {
      project: string;
      revision: number;
      semanticHash: string;
      state: BlueprintState;
    };

    const mcpBuildArtifactRes = await request.get(
      "http://127.0.0.1:8787/api/projects/invoice-mcp/build",
      {
        headers: {
          authorization: `Bearer ${await e2eProjectToken("invoice-mcp")}`,
        },
      },
    );
    expect(mcpBuildArtifactRes.status()).toBe(200);
    const mcpBuildArtifacts = (await mcpBuildArtifactRes.json()) as {
      buildHash: string;
      emittedFiles: Record<string, string>;
    };

    // =========================================================================
    // PARITY ASSERTIONS: Normalized `semanticHash` & `assemble()` `buildHash`
    // =========================================================================
    const uiSemantic = canonicalSemanticPayload(uiStatePayload.state);
    const mcpSemantic = canonicalSemanticPayload(mcpStatePayload.state);

    expect(uiSemantic.identity).toBe(mcpSemantic.identity);
    expect(uiSemantic.bricks).toEqual(mcpSemantic.bricks);
    expect(uiSemantic.entities).toEqual(mcpSemantic.entities);
    expect(uiSemantic.workflows).toEqual(mcpSemantic.workflows);
    expect(uiSemantic.secretRefs).toEqual(mcpSemantic.secretRefs);

    const normalizedUiHash = semanticHash({
      ...uiStatePayload.state,
      project: "invoice-ui",
    });
    const normalizedMcpHash = semanticHash({
      ...mcpStatePayload.state,
      project: "invoice-ui",
    });
    expect(normalizedMcpHash).toBe(normalizedUiHash);
    expect(normalizedUiHash).toBe(uiStatePayload.semanticHash);

    // Verify emitted `src/workflows.json` and `project.json` `secretRefs` are non-empty and byte-identical
    const uiWorkflowsJson = uiBuildArtifacts.emittedFiles["src/workflows.json"];
    const mcpWorkflowsJson = mcpBuildArtifacts.emittedFiles["src/workflows.json"];
    expect(uiWorkflowsJson).toBeDefined();
    expect(uiWorkflowsJson!.length).toBeGreaterThan(20);
    expect(mcpWorkflowsJson).toBe(uiWorkflowsJson);

    const uiProjectMeta = JSON.parse(
      uiBuildArtifacts.emittedFiles["project.json"] ?? "{}",
    ) as {
      secretRefs?: unknown[];
      workflows?: unknown[];
      bricks?: unknown[];
      entities?: unknown[];
    };
    const mcpProjectMeta = JSON.parse(
      mcpBuildArtifacts.emittedFiles["project.json"] ?? "{}",
    ) as {
      secretRefs?: unknown[];
      workflows?: unknown[];
      bricks?: unknown[];
      entities?: unknown[];
    };
    expect(Array.isArray(uiProjectMeta.secretRefs)).toBe(true);
    expect(uiProjectMeta.secretRefs!.length).toBe(2);
    expect(JSON.stringify(mcpProjectMeta.secretRefs)).toBe(
      JSON.stringify(uiProjectMeta.secretRefs),
    );
    expect(JSON.stringify(mcpProjectMeta.workflows)).toBe(
      JSON.stringify(uiProjectMeta.workflows),
    );

    // Verify `assemble()` `buildHash` is identical across UI and MCP
    const assembledUi = assemble(
      toAssemblerBlueprint({ ...uiStatePayload.state, project: "invoice-ui" }),
      catalog,
    );
    const assembledMcp = assemble(
      toAssemblerBlueprint({ ...mcpStatePayload.state, project: "invoice-ui" }),
      catalog,
    );
    expect(assembledUi.ok).toBe(true);
    expect(assembledMcp.ok).toBe(true);
    if (!assembledUi.ok || !assembledMcp.ok) {
      throw new Error("assemble() failed on UI or MCP blueprint");
    }

    const computedUiBuildHash = await computeBuildHash(assembledUi.files);
    const computedMcpBuildHash = await computeBuildHash(assembledMcp.files);
    expect(computedUiBuildHash).toBe(uiBuildJson.buildHash);
    expect(computedMcpBuildHash).toBe(computedUiBuildHash);
    expect(assembledMcp.files).toEqual(assembledUi.files);

    // =========================================================================
    // CO-AUTHOR CONTINUATION: MCP appends `credit-wallet.debit` to `invoice-ui`
    // =========================================================================
    const walletNodeId = "node-wallet-debit-5";
    const tCoAuthorStart = Date.now();
    // AD-V8: a credit-wallet debit node is a money change, so the agent proposes it and Alice accepts in Studio.
    const walletProposal = await callMcp<{ status: string; proposalId: string }>("apply_ops", {
      project: "invoice-ui",
      summary: "Append credit-wallet debit step after email dispatch",
      ops: [
        {
          opId: "coauthor-add-wallet-node",
          type: "add_node",
          workflowId: "wf-invoice-paid-email",
          node: {
            id: walletNodeId,
            type: "credit-wallet.debit",
            label: "Debit Invoice Credits",
            data: { amount: 1 },
          },
        },
        {
          opId: "coauthor-connect-wallet-edge",
          type: "connect_edges",
          workflowId: "wf-invoice-paid-email",
          edges: [
            {
              id: `e-${emailNodeId}-out-${walletNodeId}-in`,
              source: emailNodeId,
              target: walletNodeId,
              sourceHandle: "out",
              targetHandle: "in",
            },
          ],
        },
      ],
    });
    expect(walletProposal.status).toBe("pending");
    const acceptWallet = await page.request.post(
      `/api/projects/invoice-ui/proposals/${encodeURIComponent(walletProposal.proposalId)}/accept`,
      { data: {} },
    );
    expect(acceptWallet.status()).toBe(200);

    await expect(page.getByTestId(`canvas-node-${walletNodeId}`)).toBeVisible({
      timeout: 2_000,
    });
    const coAuthorLatencyMs = Date.now() - tCoAuthorStart;
    expect(coAuthorLatencyMs).toBeLessThanOrEqual(2_000);

    await expect(page.getByTestId(`node-author-badge-${walletNodeId}`)).toContainText(
      "agent:Claude Desktop",
    );
  });
});
