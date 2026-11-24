import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioApp } from "../src/App.tsx";
import { useStudioStore } from "../src/store.ts";
import type { BlueprintState } from "../src/types.ts";

const baseBlueprint: BlueprintState = {
  schemaVersion: 2,
  project: "saas-crm",
  identity: "core-auth",
  bricks: [
    { id: "core-auth", config: { sessionDuration: 7200 } },
    { id: "subscription-plans", config: { defaultTier: "free" } },
    { id: "omnichannel-outbound", config: { defaultChannel: "email" } },
    { id: "rbac-policy", config: { allowCustomRoles: true } },
  ],
  entities: [],
  workflows: [
    {
      id: "wf-checkout",
      name: "Checkout Flow",
      trigger: { kind: "manual" },
      nodes: [
        { id: "n1", type: "trigger.manual", label: "Start", data: {} },
        {
          id: "n2",
          type: "credit-wallet.debit",
          label: "Debit Wallet",
          data: { userId: "usr_1", amount: 10 },
        },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2" }],
    },
  ],
  secretRefs: [],
};

describe("Brick catalog enable/disable & auto-generated JSON-Schema settings inspector", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    useStudioStore.getState().resetStore();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  it("1. opens Dependency & Impact Preview on Turn on, auto-includes transitive requires (multi-workspace for credit-wallet), and commits atomic enable_brick ops", async () => {
    const opsPayloads: Array<{ ops: Array<Record<string, unknown>>; summary?: string }> = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/ops")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        opsPayloads.push(body);
        return new Response(
          JSON.stringify({
            revision: 2,
            semanticHash: "hash-rev-2",
            state: {
              ...baseBlueprint,
              bricks: [
                ...baseBlueprint.bricks,
                { id: "multi-workspace", config: {} },
                { id: "credit-wallet", config: { creditsPerUnit: 1, minOrderAmount: 1 } },
              ],
            },
            readiness: {
              state: "Ready",
              ready: true,
              bricksCount: 6,
              entitiesCount: 0,
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
      projectState: baseBlueprint,
      activeNav: "bricks",
    });

    render(<StudioApp />);

    // Click Turn on on credit-wallet (requires workspace-context provided by multi-workspace)
    fireEvent.click(screen.getByTestId("catalog-brick-enable-credit-wallet"));

    const modal = screen.getByTestId("brick-enable-modal");
    expect(modal).toBeDefined();
    expect(screen.getByTestId("brick-enable-requires").textContent).toContain(
      "Also turns on: multi-workspace (required)",
    );
    expect(screen.getByTestId("brick-enable-req-multi-workspace").textContent).toContain(
      "provides workspace-context",
    );
    expect(screen.getByTestId("brick-enable-adds").textContent).toContain(
      "migrations/0001_credit_wallet.sql",
    );
    expect(screen.getByTestId("brick-enable-adds").textContent).toContain("/api/wallet");
    expect(screen.getByTestId("brick-enable-adds").textContent).toContain(
      "credit-wallet.debit (action)",
    );

    fireEvent.click(screen.getByTestId("brick-enable-confirm"));

    await waitFor(() => {
      expect(opsPayloads).toHaveLength(1);
    });

    expect(opsPayloads[0]?.ops).toHaveLength(2);
    expect(opsPayloads[0]?.ops[0]).toMatchObject({
      type: "enable_brick",
      brickId: "multi-workspace",
    });
    expect(opsPayloads[0]?.ops[1]).toMatchObject({
      type: "enable_brick",
      brickId: "credit-wallet",
    });

    await waitFor(() => {
      expect(screen.getByTestId("enabled-brick-card-credit-wallet")).toBeDefined();
      expect(screen.getByTestId("enabled-brick-card-multi-workspace")).toBeDefined();
    });
  });

  it("2. blocks turning on a conflicting brick (outbound-webhooks vs subscription-plans) and requires explicit checkbox for experimental bricks (scripting-sandbox)", () => {
    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "saas-crm",
      projectState: baseBlueprint,
      activeNav: "bricks",
    });

    render(<StudioApp />);

    // Click Turn on on outbound-webhooks (conflicts with enabled subscription-plans)
    fireEvent.click(screen.getByTestId("catalog-brick-enable-outbound-webhooks"));
    expect(screen.getByTestId("brick-enable-conflicts").textContent).toContain(
      "subscription-plans",
    );
    expect(screen.getByTestId("brick-enable-conflicts").textContent).toContain(
      "Both mount routes under the /api/subscriptions prefix",
    );
    expect(
      (screen.getByTestId("brick-enable-confirm") as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("brick-enable-cancel"));

    // Toggle experimental on and click Turn on on scripting-sandbox
    fireEvent.click(screen.getByTestId("bricks-experimental-toggle"));
    fireEvent.click(screen.getByTestId("catalog-brick-enable-scripting-sandbox"));

    const confirmBtn = screen.getByTestId("brick-enable-confirm") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(screen.getByTestId("experimental-confirm-box").textContent).toContain(
      "I understand this brick is experimental: Executes in isolated Worker",
    );

    fireEvent.click(screen.getByTestId("experimental-confirm-checkbox"));
    expect(confirmBtn.disabled).toBe(false);
  });

  it("3. displays dependent bricks and referencing workflows in Disable Brick Impact modal before dispatching remove_brick", () => {
    const withWallet: BlueprintState = {
      ...baseBlueprint,
      bricks: [
        ...baseBlueprint.bricks,
        { id: "multi-workspace", config: {} },
        { id: "credit-wallet", config: { creditsPerUnit: 1, minOrderAmount: 1 } },
      ],
    };

    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "saas-crm",
      projectState: withWallet,
      activeNav: "bricks",
    });

    render(<StudioApp />);

    // Clicking Turn off on multi-workspace warns that credit-wallet and subscription-plans depend on workspace-context
    fireEvent.click(screen.getByTestId("enabled-brick-disable-multi-workspace"));
    expect(screen.getByTestId("brick-disable-modal")).toBeDefined();
    expect(screen.getByTestId("brick-disable-dep-credit-wallet").textContent).toContain(
      "requires workspace-context",
    );
    fireEvent.click(screen.getByTestId("brick-disable-cancel"));

    // Clicking Turn off on credit-wallet warns that Checkout Flow (wf-checkout) uses credit-wallet.debit
    fireEvent.click(screen.getByTestId("enabled-brick-disable-credit-wallet"));
    expect(screen.getByTestId("brick-disable-wf-wf-checkout").textContent).toContain(
      "Checkout Flow (wf-checkout): nodes [n2]",
    );
  });

  it("4. renders auto-generated Inspector forms for 3 distinct brick settings shapes (integer + slider, enum select, boolean switch), validates live, and dispatches configure_brick + bind_secret_ref", async () => {
    const sentPayloads: Array<{ ops: Array<Record<string, unknown>> }> = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (!String(url).endsWith("/ops")) {
        return new Response(JSON.stringify({}), { status: 404 });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      sentPayloads.push(body);
      const currentState = useStudioStore.getState().projectState!;
      const op = body.ops[0];
      let nextBricks = currentState.bricks;
      let nextSecrets = currentState.secretRefs;
      if (op.type === "configure_brick") {
        nextBricks = currentState.bricks.map((b) =>
          b.id === op.brickId ? { ...b, config: op.config } : b,
        );
      } else if (op.type === "bind_secret_ref") {
        nextSecrets = [
          ...currentState.secretRefs,
          {
            targetKind: op.targetKind,
            targetId: op.targetId,
            secretName: op.secretName,
            ref: op.ref,
          },
        ];
      }
      return new Response(
        JSON.stringify({
          revision: sentPayloads.length + 1,
          semanticHash: `hash-${sentPayloads.length + 1}`,
          state: {
            ...currentState,
            bricks: nextBricks,
            secretRefs: nextSecrets,
          },
          readiness: {
            state: "Ready",
            ready: true,
            bricksCount: nextBricks.length,
            entitiesCount: 0,
            workflowsCount: 1,
            needs: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const stateWith3Bricks: BlueprintState = {
      ...baseBlueprint,
      bricks: [
        ...baseBlueprint.bricks,
        { id: "multi-workspace", config: {} },
        { id: "credit-wallet", config: { creditsPerUnit: 1, minOrderAmount: 1 } },
      ],
    };

    useStudioStore.getState().resetStore({
      user: { id: "usr_1", email: "asha@example.com", name: "Asha" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme", role: "owner" }],
      activeOrgId: "org_1",
      activeProjectId: "saas-crm",
      projectState: stateWith3Bricks,
      activeNav: "bricks",
    });

    render(<StudioApp />);

    // Brick 1: credit-wallet (integer input + slider + live min/max validation)
    fireEvent.click(screen.getByTestId("enabled-brick-card-credit-wallet"));
    const creditsInput = screen.getByTestId(
      "setting-input-creditsPerUnit",
    ) as HTMLInputElement;
    const creditsSlider = screen.getByTestId(
      "setting-slider-creditsPerUnit",
    ) as HTMLInputElement;
    expect(creditsInput.value).toBe("1");
    expect(creditsSlider.value).toBe("1");

    // Out-of-bounds value (0 < min 1) shows field error immediately and disables Save
    fireEvent.change(creditsInput, { target: { value: "0" } });
    expect(screen.getByTestId("setting-error-creditsPerUnit").textContent).toContain(
      "between 1 and 1000000",
    );
    expect(
      (screen.getByTestId("brick-settings-save") as HTMLButtonElement).disabled,
    ).toBe(true);

    // Valid integer (25) clears error and enables Save
    fireEvent.change(creditsInput, { target: { value: "25" } });
    expect(screen.queryByTestId("setting-error-creditsPerUnit")).toBeNull();
    const saveBtn = screen.getByTestId("brick-settings-save") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(sentPayloads).toHaveLength(1);
    });
    expect(sentPayloads[0]?.ops[0]).toMatchObject({
      type: "configure_brick",
      brickId: "credit-wallet",
      config: { creditsPerUnit: 25, minOrderAmount: 1 },
    });

    // Brick 2: omnichannel-outbound (enum select dropdown)
    fireEvent.click(screen.getByTestId("enabled-brick-card-omnichannel-outbound"));
    const channelSelect = screen.getByTestId(
      "setting-select-defaultChannel",
    ) as HTMLSelectElement;
    expect(channelSelect.value).toBe("email");
    fireEvent.change(channelSelect, { target: { value: "slack" } });
    fireEvent.click(screen.getByTestId("brick-settings-save"));

    await waitFor(() => {
      expect(sentPayloads).toHaveLength(2);
    });
    expect(sentPayloads[1]?.ops[0]).toMatchObject({
      type: "configure_brick",
      brickId: "omnichannel-outbound",
      config: { defaultChannel: "slack" },
    });

    // Brick 3: rbac-policy (boolean toggle switch)
    fireEvent.click(screen.getByTestId("enabled-brick-card-rbac-policy"));
    const roleToggle = screen.getByTestId("setting-toggle-allowCustomRoles");
    expect(roleToggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(roleToggle);
    expect(roleToggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("brick-settings-save"));

    await waitFor(() => {
      expect(sentPayloads).toHaveLength(3);
    });
    expect(sentPayloads[2]?.ops[0]).toMatchObject({
      type: "configure_brick",
      brickId: "rbac-policy",
      config: { allowCustomRoles: false },
    });

    // Secret reference binding on core-auth: rejects raw plaintext and binds sec_* handle
    fireEvent.click(screen.getByTestId("enabled-brick-card-core-auth"));
    const secretInput = screen.getByTestId(
      "secret-ref-input-BETTER_AUTH_SECRET",
    ) as HTMLInputElement;
    fireEvent.change(secretInput, { target: { value: "sk_" + "live_plaintext_secret" } });
    expect(screen.getByTestId("secret-ref-error-BETTER_AUTH_SECRET").textContent).toContain(
      "opaque handle matching sec_*",
    );
    expect(
      (screen.getByTestId("secret-ref-bind-BETTER_AUTH_SECRET") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.change(secretInput, { target: { value: "sec_better_auth_prod" } });
    expect(screen.queryByTestId("secret-ref-error-BETTER_AUTH_SECRET")).toBeNull();
    fireEvent.click(screen.getByTestId("secret-ref-bind-BETTER_AUTH_SECRET"));

    await waitFor(() => {
      expect(sentPayloads).toHaveLength(4);
    });
    expect(sentPayloads[3]?.ops[0]).toMatchObject({
      type: "bind_secret_ref",
      targetKind: "brick",
      targetId: "core-auth",
      secretName: "BETTER_AUTH_SECRET",
      ref: "sec_better_auth_prod",
    });
  });

  it("5. surfaces server 403/422 errors in role='alert' banner with zero silent fake-state fallbacks (AD-S2)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/ops")) {
        return new Response(
          JSON.stringify({
            error: "Unprocessable Entity: Brick config failed schema validation",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
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
      projectState: baseBlueprint,
      activeNav: "bricks",
    });

    render(<StudioApp />);

    // Attempt to enable cron-alarms when server returns 422
    fireEvent.click(screen.getByTestId("catalog-brick-enable-cron-alarms"));
    fireEvent.click(screen.getByTestId("brick-enable-confirm"));

    await waitFor(() => {
      expect(screen.getByTestId("mutation-error-alert")).toBeDefined();
    });
    expect(screen.getByTestId("mutation-error-alert").textContent).toContain(
      "422",
    );
    // Server state is preserved — cron-alarms was NOT fake-enabled locally
    expect(
      useStudioStore.getState().projectState?.bricks.some((b) => b.id === "cron-alarms"),
    ).toBe(false);
  });
});
