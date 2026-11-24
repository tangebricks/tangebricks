import { createEmptyBlueprint } from "@poc/blueprint";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioShell } from "../src/components/StudioShell.tsx";
import { useStudioStore } from "../src/store.ts";
import { DEFAULT_CATALOG, applyStudioOps } from "../src/types.ts";

describe("Connections & Secrets Center UI & Inline Inspector Secret Creation", () => {
  beforeEach(() => {
    const initialBp = applyStudioOps(
      createEmptyBlueprint("vault-ui-proj"),
      [
        {
          opId: "op-auth",
          type: "enable_brick",
          brickId: "core-auth",
          config: {},
        },
        {
          opId: "op-wh",
          type: "enable_brick",
          brickId: "webhook-gateway",
          config: {},
        },
        {
          opId: "op-wf",
          type: "add_workflow",
          workflow: {
            id: "wf-billing",
            name: "Billing Flow",
            trigger: { kind: "webhook", path: "/webhooks/stripe" },
            nodes: [
              {
                id: "node_trig_1",
                type: "core.webhook",
                label: "Webhook Trigger",
                data: { method: "post" },
              },
              {
                id: "node_http_1",
                type: "core.http_request",
                label: "Charge Customer API",
                data: { method: "post", timeoutMs: 5000 },
              },
            ],
            edges: [
              {
                id: "e-1",
                source: "node_trig_1",
                sourceHandle: "out",
                target: "node_http_1",
                targetHandle: "in",
              },
            ],
          },
        },
        {
          opId: "op-bind-wh",
          type: "bind_secret_ref",
          targetKind: "brick",
          targetId: "webhook-gateway",
          secretName: "WEBHOOK_SIGNING_SECRET",
          ref: "sec_stripe_wh",
        },
        {
          opId: "op-bind-http",
          type: "bind_secret_ref",
          targetKind: "connection",
          targetId: "node_http_1",
          secretName: "AUTHORIZATION_BEARER",
          ref: "sec_billing_api",
        },
      ],
      DEFAULT_CATALOG,
    );

    useStudioStore.getState().resetStore({
      user: { id: "u_owner", email: "owner@studio.dev", name: "Owner" },
      orgs: [{ id: "org_1", slug: "acme", name: "Acme Org", role: "owner" }],
      activeOrgId: "org_1",
      projects: [
        {
          project: "vault-ui-proj",
          orgId: "org_1",
          revision: 1,
          semanticHash: "h1",
          updatedAt: "2026-04-18T00:00:00Z",
        },
      ],
      activeProjectId: "vault-ui-proj",
      currentRevision: 1,
      projectState: initialBp,
      activeNav: "connections",
      secrets: [
        {
          id: "vault_vault-ui-proj_sec_stripe_wh",
          ref: "sec_stripe_wh",
          kind: "webhook_secret",
          label: "Stripe Webhook Signing Secret",
          appOrBrick: "webhook-gateway",
          envScope: "all",
          keyHint: "••••9182",
          status: "valid",
          usedBy: [
            {
              targetKind: "brick",
              targetId: "webhook-gateway",
              secretName: "WEBHOOK_SIGNING_SECRET",
            },
          ],
          updatedAt: "2026-04-18T00:00:00Z",
        },
        {
          id: "vault_vault-ui-proj_sec_billing_api",
          ref: "sec_billing_api",
          kind: "api_key",
          label: "Billing HTTP Bearer Key",
          appOrBrick: "core.http_request",
          envScope: "all",
          keyHint: "••••7341",
          status: "valid",
          usedBy: [
            {
              targetKind: "node",
              targetId: "node_http_1",
              secretName: "AUTHORIZATION_BEARER",
            },
          ],
          updatedAt: "2026-04-18T00:00:00Z",
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders ConnectionsView with status chips, 4-char key hints, and clickable Used-by targets that jump to Bricks and Workflows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ secrets: useStudioStore.getState().secrets }), {
          status: 200,
        }),
      ),
    );

    render(<StudioShell />);

    expect(screen.getByTestId("view-connections")).toBeTruthy();
    expect(screen.getByTestId("secret-row-sec_stripe_wh")).toBeTruthy();
    expect(
      screen.getByTestId("secret-key-hint-sec_stripe_wh").textContent,
    ).toBe("••••9182");
    expect(
      screen.getByTestId("secret-status-sec_stripe_wh").textContent,
    ).toContain("Valid · Connected");

    // Click "Used by" target for brick webhook-gateway -> jumps to Bricks view & selects brick
    fireEvent.click(
      screen.getByTestId("secret-used-by-target-sec_stripe_wh-webhook-gateway"),
    );
    expect(useStudioStore.getState().activeNav).toBe("bricks");
    expect(useStudioStore.getState().selection).toEqual({
      kind: "brick",
      id: "webhook-gateway",
    });

    // Switch back to Connections and click "Used by" target for node_http_1 -> jumps to Workflows view & selects node
    fireEvent.click(screen.getByTestId("nav-tab-connections"));
    fireEvent.click(
      screen.getByTestId("secret-used-by-target-sec_billing_api-node_http_1"),
    );
    expect(useStudioStore.getState().activeNav).toBe("workflows");
    expect(useStudioStore.getState().selection).toEqual({
      kind: "node",
      id: "node_http_1",
      workflowId: "wf-billing",
    });
  });

  it("adds, rotates, and deletes a secret with impact warning against the backend vault API without leaking plaintext", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/secrets") && (!init?.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({ secrets: useStudioStore.getState().secrets }),
          { status: 200 },
        );
      }
      if (url.endsWith("/secrets") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          ref: string;
          kind: "api_key" | "webhook_secret" | "brick_secret";
          label: string;
          appOrBrick: string;
          value: string;
        };
        const suffix = body.value.slice(-4);
        return new Response(
          JSON.stringify({
            secret: {
              id: `vault_vault-ui-proj_${body.ref}`,
              ref: body.ref,
              kind: body.kind,
              label: body.label,
              appOrBrick: body.appOrBrick,
              envScope: "all",
              keyHint: `••••${suffix}`,
              status: "valid",
              usedBy: [],
              updatedAt: "2026-04-18T01:00:00Z",
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/secrets/sec_stripe_wh") && init?.method === "DELETE") {
        const currentBp = useStudioStore.getState().projectState!;
        const nextBp = applyStudioOps(
          currentBp,
          [
            {
              opId: "unbind-1",
              type: "unbind_secret_ref",
              targetKind: "brick",
              targetId: "webhook-gateway",
              secretName: "WEBHOOK_SIGNING_SECRET",
            },
          ],
          DEFAULT_CATALOG,
        );
        return new Response(
          JSON.stringify({
            deleted: true,
            ref: "sec_stripe_wh",
            revision: 2,
            state: nextBp,
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<StudioShell />);

    // 1. Add a new secret via modal
    fireEvent.click(screen.getByTestId("add-secret-button"));
    expect(screen.getByTestId("add-secret-modal")).toBeTruthy();

    fireEvent.change(screen.getByTestId("secret-label-input"), {
      target: { value: "Resend API Key" },
    });
    expect(
      (screen.getByTestId("secret-handle-input") as HTMLInputElement).value,
    ).toBe("sec_resend_api_key");
    fireEvent.change(screen.getByTestId("secret-value-input"), {
      target: { value: "re_live_secret_value_8842" },
    });
    fireEvent.click(screen.getByTestId("save-secret-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("secret-row-sec_resend_api_key")).toBeTruthy();
    });
    expect(
      screen.getByTestId("secret-key-hint-sec_resend_api_key").textContent,
    ).toBe("••••8842");
    // Plaintext must never appear in the rendered DOM
    expect(document.body.innerHTML).not.toContain("re_live_secret_value_8842");

    // 2. Rotate existing secret value
    fireEvent.click(screen.getByTestId("rotate-secret-button-sec_resend_api_key"));
    fireEvent.change(screen.getByTestId("secret-value-input"), {
      target: { value: "re_live_rotated_value_1199" },
    });
    fireEvent.click(screen.getByTestId("save-secret-submit"));

    await waitFor(() => {
      expect(
        screen.getByTestId("secret-key-hint-sec_resend_api_key").textContent,
      ).toBe("••••1199");
    });
    expect(document.body.innerHTML).not.toContain("re_live_rotated_value_1199");

    // 3. Delete bound secret -> shows impact warning modal and unbinds on confirm
    fireEvent.click(screen.getByTestId("delete-secret-button-sec_stripe_wh"));
    expect(screen.getByTestId("delete-secret-modal")).toBeTruthy();
    expect(
      screen.getByTestId("delete-secret-impact-warning").textContent,
    ).toContain("webhook-gateway (WEBHOOK_SIGNING_SECRET)");

    fireEvent.click(screen.getByTestId("confirm-delete-secret"));
    await waitFor(() => {
      expect(screen.queryByTestId("secret-row-sec_stripe_wh")).toBeNull();
    });
  });

  it("supports inline secret creation and existing secret selection directly from the RightDock Inspector", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/secrets") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          ref: string;
          kind: "api_key" | "webhook_secret" | "brick_secret";
          label: string;
          appOrBrick: string;
          value: string;
          bindTarget?: {
            targetKind: "brick" | "node";
            targetId: string;
            secretName: string;
          };
        };
        const currentBp = useStudioStore.getState().projectState!;
        const nextBp = body.bindTarget
          ? applyStudioOps(
              currentBp,
              [
                {
                  opId: "bind-inline-1",
                  type: "bind_secret_ref",
                  targetKind:
                    body.bindTarget.targetKind === "node"
                      ? "connection"
                      : "brick",
                  targetId: body.bindTarget.targetId,
                  secretName: body.bindTarget.secretName,
                  ref: body.ref,
                },
              ],
              DEFAULT_CATALOG,
            )
          : currentBp;
        return new Response(
          JSON.stringify({
            secret: {
              id: `vault_vault-ui-proj_${body.ref}`,
              ref: body.ref,
              kind: body.kind,
              label: body.label,
              appOrBrick: body.appOrBrick,
              envScope: "all",
              keyHint: `••••${body.value.slice(-4)}`,
              status: "valid",
              usedBy: [],
              updatedAt: "2026-04-18T02:00:00Z",
            },
            revision: 3,
            state: nextBp,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ secrets: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Select brick `core-auth` in Inspector (which declares BETTER_AUTH_SECRET)
    useStudioStore
      .getState()
      .selectItem({ kind: "brick", id: "core-auth" }, "bricks");

    render(<StudioShell />);

    const inlineBtn = screen.getByTestId(
      "inline-add-secret-button-BETTER_AUTH_SECRET",
    );
    fireEvent.click(inlineBtn);

    fireEvent.change(
      screen.getByTestId("inline-secret-handle-BETTER_AUTH_SECRET"),
      { target: { value: "sec_inline_auth_key" } },
    );
    fireEvent.change(
      screen.getByTestId("inline-secret-value-BETTER_AUTH_SECRET"),
      { target: { value: "whsec_inline_secret_4455" } },
    );
    fireEvent.click(
      screen.getByTestId("inline-secret-submit-BETTER_AUTH_SECRET"),
    );

    await waitFor(() => {
      expect(
        useStudioStore
          .getState()
          .secrets.some((s) => s.ref === "sec_inline_auth_key"),
      ).toBe(true);
    });
    expect(document.body.innerHTML).not.toContain("whsec_inline_secret_4455");
  });

  it("renders Case A status chips (Connected/Expired/Revoked/Error), Test & Re-authorize actions, Agent Connection Consent Banner, and inline Connect {app} modal on canvas", async () => {
    useStudioStore.getState().setSecrets([
      {
        id: "conn_1",
        ref: "sec_slack_oauth",
        kind: "oauth2",
        label: "Slack OAuth2 Connection",
        appOrBrick: "slack",
        envScope: "all",
        keyHint: "••••5511",
        status: "expired",
        usedBy: [],
        updatedAt: "2026-04-18T00:00:00Z",
      },
      {
        id: "conn_2",
        ref: "sec_revoked_key",
        kind: "api_key",
        label: "Revoked Key",
        appOrBrick: "stripe",
        envScope: "all",
        keyHint: "••••2200",
        status: "revoked",
        usedBy: [],
        updatedAt: "2026-04-18T00:00:00Z",
      },
      {
        id: "conn_3",
        ref: "sec_error_key",
        kind: "api_key",
        label: "Error Key",
        appOrBrick: "resend",
        envScope: "all",
        keyHint: "••••3300",
        status: "error",
        usedBy: [],
        updatedAt: "2026-04-18T00:00:00Z",
      },
    ]);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/connections") && (!init?.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            connections: useStudioStore.getState().secrets,
            connectionRequests: [
              {
                requestId: "req_slack_1",
                app: "slack",
                reason: "Needed to post invoice alerts to #finance",
                scopes: ["chat:write"],
                suggestedRef: "sec_slack",
                connectUrl: "/?project=vault-ui-proj&nav=connections",
                status: "pending",
                requestedBy: "agent:claude-code",
                createdAt: "2026-04-18T00:00:00Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/connections/sec_slack_oauth/test") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            ref: "sec_slack_oauth",
            status: "connected",
            lastCheckedAt: "2026-04-18T03:00:00Z",
          }),
          { status: 200 },
        );
      }
      if (
        url.endsWith("/connections/sec_slack_oauth/reauthorize") &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            ok: true,
            ref: "sec_slack_oauth",
            status: "connected",
            authorizeUrl: "https://slack.com/oauth/v2/authorize?state=st_1",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/secrets") && (!init?.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({ secrets: useStudioStore.getState().secrets }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<StudioShell />);

    expect(
      screen.getByTestId("secret-status-sec_slack_oauth").textContent,
    ).toContain("Expired");
    expect(
      screen.getByTestId("secret-status-sec_revoked_key").textContent,
    ).toContain("Revoked");
    expect(
      screen.getByTestId("secret-status-sec_error_key").textContent,
    ).toContain("Error");

    // Agent Connection Consent Banner renders and opens pre-filled modal on click
    await waitFor(() => {
      expect(screen.getByTestId("agent-connection-consent-banner")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("consent-banner-connect-req_slack_1"));
    expect(screen.getByTestId("add-secret-modal")).toBeTruthy();
    expect(
      (screen.getByTestId("secret-handle-input") as HTMLInputElement).value,
    ).toBe("sec_slack");
    fireEvent.click(screen.getByTestId("close-secret-modal"));

    // Test button transitions status to Connected
    fireEvent.click(screen.getByTestId("test-connection-button-sec_slack_oauth"));
    await waitFor(() => {
      expect(
        screen.getByTestId("secret-status-sec_slack_oauth").textContent,
      ).toContain("Connected");
    });

    // Re-authorize button works
    fireEvent.click(
      screen.getByTestId("reauthorize-connection-button-sec_slack_oauth"),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("connections-action-message").textContent,
      ).toContain("Re-authorization ready");
    });

    // Case B — Connect your account widget preview renders Not connected, Connected, and Expired states
    expect(screen.getByTestId("case-b-widget-preview")).toBeTruthy();
    expect(screen.getByTestId("case-b-provider-status-google").textContent).toBe(
      "Not connected",
    );
    expect(screen.getByTestId("case-b-provider-status-slack").textContent).toBe(
      "Connected",
    );
    expect(screen.getByTestId("case-b-provider-status-github").textContent).toBe(
      "Expired",
    );

    fireEvent.click(screen.getByTestId("case-b-connect-btn-google"));
    await waitFor(() => {
      expect(screen.getByTestId("case-b-provider-status-google").textContent).toBe(
        "Connected",
      );
    });
    fireEvent.click(screen.getByTestId("case-b-reconnect-btn-github"));
    expect(screen.getByTestId("case-b-provider-status-github").textContent).toBe(
      "Connected",
    );
    fireEvent.click(screen.getByTestId("case-b-disconnect-btn-slack"));
    expect(screen.getByTestId("case-b-provider-status-slack").textContent).toBe(
      "Not connected",
    );
  });
});
