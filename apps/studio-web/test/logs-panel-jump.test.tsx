// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REDACTED_PLACEHOLDER,
  ensureTelemetryTables,
  getRunRecord,
  insertStepEvent,
  insertStructuredLog,
  listStepEventsForRun,
  upsertRunRecord,
} from "@poc/telemetry";
import { sqliteD1 } from "../../../test/support/sqlite-d1.ts";
import { readProjectLogs } from "../../studio-api/src/telemetry-reads.ts";
import { StructuredLogsPanel } from "../src/components/StructuredLogsPanel.tsx";
import { useStudioStore } from "../src/store.ts";

/** The project every seeded row is stamped with, as Studio's ingest stamps them (story 1.4). */
const PROJECT = "proj-logs-ui";

describe("Story 6.3 — Studio Web Structured Logs & Errors Panel & Jump-to-Replay", () => {
  const originalFetch = globalThis.fetch;
  const TELEMETRY_SECRET = "test_logs_panel_hmac_secret_0123456789";
  const CANARY_SECRET = "sk_live_canary_secret_987654";
  let world: ReturnType<typeof sqliteD1>;

  beforeEach(async () => {
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/?nav=workflows");
    world = sqliteD1();
    await ensureTelemetryTables(world.d1);

    // Seed a failed workflow run + step events in sqliteD1 so startRunReplay resolves real run telemetry
    await upsertRunRecord(world.d1, {
      runId: "run_charge_fail_01",
      workflowId: "wf_payment",
      revision: 2,
      triggerType: "manual",
      workspaceId: "ws_alpha",
      status: "failed",
      durationMs: 42,
      retries: 1,
      errorStack: "Error: credit-wallet.debit (node_charge_wallet): insufficient balance (40 < 250)",
      startedAt: "2026-10-31T10:00:00.000Z",
      endedAt: "2026-10-31T10:00:00.042Z",
    }, { projectId: PROJECT });

    await insertStepEvent(world.d1, {
      workspaceId: "ws_alpha",
      eventId: "ev_step_01",
      runId: "run_charge_fail_01",
      workflowId: "wf_payment",
      revision: 2,
      nodeId: "node_trigger",
      status: "succeeded",
      durationMs: 5,
      retries: 0,
      inputPreview: "{}",
      outputPreview: '{"out":{"balance":40,"workspaceId":"ws_alpha"}}',
      errorStack: null,
      createdAt: "2026-10-31T10:00:00.005Z",
    }, { projectId: PROJECT });

    await insertStepEvent(world.d1, {
      workspaceId: "ws_alpha",
      eventId: "ev_step_02",
      runId: "run_charge_fail_01",
      workflowId: "wf_payment",
      revision: 2,
      nodeId: "node_charge_wallet",
      status: "failed",
      durationMs: 37,
      retries: 1,
      inputPreview: '{"in":{"balance":40,"workspaceId":"ws_alpha"}}',
      outputPreview: "{}",
      errorStack: "Error: credit-wallet.debit (node_charge_wallet): insufficient balance (40 < 250)",
      createdAt: "2026-10-31T10:00:00.042Z",
    }, { projectId: PROJECT });

    // Seed structured log rows across levels (debug, info, warn, error) with canary secrets
    await insertStructuredLog(
      world.d1,
      {
        logId: "log_debug_01",
        ts: "2026-10-31T10:00:00.002Z",
        level: "debug",
        message: "Validating inbound payment trigger payload",
        runId: "run_charge_fail_01",
        workflowId: "wf_payment",
        revision: 2,
        nodeId: "node_trigger",
        brickId: "webhook-gateway",
        workspaceId: "ws_alpha",
        fields: { payloadKeys: ["balance", "workspaceId"] },
        envName: "preview",
      },
      { secretValues: [CANARY_SECRET] }, { projectId: PROJECT },
    );

    await insertStructuredLog(
      world.d1,
      {
        logId: "log_info_01",
        ts: "2026-10-31T10:00:00.006Z",
        level: "info",
        message: "Starting wallet debit step for ws_alpha",
        runId: "run_charge_fail_01",
        workflowId: "wf_payment",
        revision: 2,
        nodeId: "node_charge_wallet",
        brickId: "credit-wallet",
        workspaceId: "ws_alpha",
        fields: { requestedAmount: 250, currentBalance: 40 },
        envName: "preview",
      },
      { secretValues: [CANARY_SECRET] }, { projectId: PROJECT },
    );

    await insertStructuredLog(
      world.d1,
      {
        logId: "log_warn_01",
        ts: "2026-10-31T10:00:00.020Z",
        level: "warn",
        message: "Workspace ws_beta wallet balance below threshold",
        runId: null,
        workflowId: null,
        revision: 2,
        nodeId: null,
        brickId: "credit-wallet",
        workspaceId: "ws_beta",
        requestId: "req_wallet_beta_01",
        fields: { balance: 15, threshold: 50 },
        envName: "preview",
      },
      { secretValues: [CANARY_SECRET] }, { projectId: PROJECT },
    );

    await insertStructuredLog(
      world.d1,
      {
        logId: "log_error_01",
        ts: "2026-10-31T10:00:00.041Z",
        level: "error",
        message: `credit-wallet.debit failed with key ${CANARY_SECRET}: insufficient balance (40 < 250)`,
        runId: "run_charge_fail_01",
        workflowId: "wf_payment",
        revision: 2,
        nodeId: "node_charge_wallet",
        brickId: "credit-wallet",
        workspaceId: "ws_alpha",
        fields: {
          apiKey: CANARY_SECRET,
          authorization: "Bearer eyJ_secret_jwt_token_value",
          amount: 250,
          balance: 40,
        },
        errorStack: `Error: insufficient balance (${CANARY_SECRET})\n    at executeWalletDebit (credit-wallet.ts:42:9)`,
        envName: "preview",
      },
      { secretValues: [CANARY_SECRET] }, { projectId: PROJECT },
    );

    useStudioStore.getState().resetStore({
      user: {
        id: "user_owner",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
      orgs: [
        {
          id: "org_1",
          name: "Acme Org",
          slug: "acme-org",
          role: "owner",
        },
      ],
      activeOrgId: "org_1",
      activeProjectId: "proj-logs-ui",
      currentRevision: 2,
      activeNav: "workflows",
      activeWorkflowId: "wf_payment",
      rightDockOpen: false,
      rightDockTab: "inspector",
      selection: null,
      projectState: {
        schemaVersion: 2,
        project: "proj-logs-ui",
        identity: "stub",
        bricks: [
          { id: "multi-workspace", config: {} },
          { id: "credit-wallet", config: {} },
        ],
        entities: [],
        workflows: [
          {
            id: "wf_payment",
            name: "Payment Flow",
            trigger: { kind: "manual" },
            nodes: [
              {
                id: "node_trigger",
                type: "trigger.manual",
                label: "Manual Trigger",
                data: {},
              },
              {
                id: "node_charge_wallet",
                type: "credit-wallet.debit",
                label: "Charge Wallet",
                data: { amount: 250 },
              },
            ],
            edges: [
              {
                id: "edge_1",
                source: "node_trigger",
                target: "node_charge_wallet",
              },
            ],
          },
        ],
        secretRefs: [],
        metadata: {},
      },
    });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const u = new URL(urlStr, "http://localhost");

      if (
        u.pathname ===
        "/api/projects/proj-logs-ui/environments/preview/logs"
      ) {
        // The same read studio-api's logs route makes (story 1.4: signed, confined to the project).
        const res = await readProjectLogs({
          db: world.d1,
          project: PROJECT,
          envName: "preview",
          search: u.search,
          telemetrySecret: TELEMETRY_SECRET,
        });
        return res!;
      }

      if (u.pathname === "/api/projects/proj-logs-ui/runs/run_charge_fail_01") {
        const run = await getRunRecord(world.d1, "run_charge_fail_01", { projectId: PROJECT });
        const stepEvents = await listStepEventsForRun(
          world.d1,
          "run_charge_fail_01",
          { projectId: PROJECT },
        );
        const wf =
          useStudioStore.getState().projectState?.workflows[0] ?? null;
        return Response.json({
          project: "proj-logs-ui",
          env: "preview",
          run: {
            ...run!,
            failedNodeId: "node_charge_wallet",
            stepCount: stepEvents.length,
            resolvedByRunId: null,
          },
          stepEvents,
          currentRevision: 2,
          historicalRevision: 2,
          isHistoricalRevision: false,
          historicalState: useStudioStore.getState().projectState,
          historicalWorkflow: wf,
        });
      }

      return Response.json({ ok: true });
    }) as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    world.db.close();
  });

  it("renders structured logs with distinct level badges, redacts secrets, filters by level/workspace/brick/node/search, and jumps to CP4 Run Replay selecting the failed node", async () => {
    render(<StructuredLogsPanel project="proj-logs-ui" />);

    // Wait for all 4 seeded logs to render
    await waitFor(() => {
      expect(screen.getByTestId("log-row-log_error_01")).toBeTruthy();
      expect(screen.getByTestId("log-row-log_warn_01")).toBeTruthy();
      expect(screen.getByTestId("log-row-log_info_01")).toBeTruthy();
      expect(screen.getByTestId("log-row-log_debug_01")).toBeTruthy();
    });

    // Verify level badges have icon + text and distinct computed styles
    const errBadge = screen.getByTestId("log-level-badge-log_error_01");
    const warnBadge = screen.getByTestId("log-level-badge-log_warn_01");
    const infoBadge = screen.getByTestId("log-level-badge-log_info_01");
    const debugBadge = screen.getByTestId("log-level-badge-log_debug_01");

    expect(errBadge.textContent).toContain("ERROR");
    expect(warnBadge.textContent).toContain("WARN");
    expect(infoBadge.textContent).toContain("INFO");
    expect(debugBadge.textContent).toContain("DEBUG");

    const errColor = window.getComputedStyle(errBadge).color;
    const warnColor = window.getComputedStyle(warnBadge).color;
    const infoColor = window.getComputedStyle(infoBadge).color;
    const debugColor = window.getComputedStyle(debugBadge).color;
    expect(new Set([errColor, warnColor, infoColor, debugColor]).size).toBe(4);

    // Verify secret redaction in message and expandable JSON details
    const errMessage = screen.getByTestId("log-message-log_error_01");
    expect(errMessage.textContent).toContain(REDACTED_PLACEHOLDER);
    expect(errMessage.textContent).not.toContain(CANARY_SECRET);

    fireEvent.click(screen.getByTestId("log-expand-button-log_error_01"));
    const fieldsPre = screen.getByTestId("log-fields-json-log_error_01");
    const stackPre = screen.getByTestId("log-error-stack-log_error_01");
    expect(fieldsPre.textContent).toContain(REDACTED_PLACEHOLDER);
    expect(fieldsPre.textContent).not.toContain(CANARY_SECRET);
    expect(fieldsPre.textContent).not.toContain("eyJ_secret_jwt_token_value");
    expect(stackPre.textContent).toContain(REDACTED_PLACEHOLDER);
    expect(stackPre.textContent).not.toContain(CANARY_SECRET);

    // Filter by level = error via pill
    fireEvent.click(screen.getByTestId("logs-level-pill-error"));
    await waitFor(() => {
      expect(screen.getByTestId("log-row-log_error_01")).toBeTruthy();
      expect(screen.queryByTestId("log-row-log_info_01")).toBeNull();
      expect(screen.queryByTestId("log-row-log_warn_01")).toBeNull();
    });

    // Verify URL & sessionStorage persisted the level filter
    expect(window.location.search).toContain("logLevel=error");
    const savedSession = JSON.parse(
      window.sessionStorage.getItem(
        "px_studio_structured_logs_state:proj-logs-ui",
      ) ?? "{}",
    );
    expect(savedSession.level).toBe("error");

    // Click the node correlation chip (`node:node_charge_wallet`) to jump to CP4 Run Replay
    fireEvent.click(screen.getByTestId("log-chip-node-log_error_01"));

    await waitFor(() => {
      const state = useStudioStore.getState();
      expect(state.activeReplayRun).not.toBeNull();
      expect(state.activeReplayRun?.run.runId).toBe("run_charge_fail_01");
      expect(state.selection).toEqual({
        kind: "node",
        id: "node_charge_wallet",
        workflowId: "wf_payment",
      });
      expect(state.rightDockOpen).toBe(true);
      expect(state.rightDockTab).toBe("inspector");
    });

    // Clear filters and verify Live Tail appends incoming WebSocket log frames
    fireEvent.click(screen.getByTestId("logs-clear-filters-button"));
    await waitFor(() => {
      expect(screen.getByTestId("log-row-log_info_01")).toBeTruthy();
    });

    window.dispatchEvent(
      new CustomEvent("px-studio-log-frame", {
        detail: {
          type: "log",
          project: "proj-logs-ui",
          envName: "preview",
          entry: {
            seq: 99,
            logId: "log_live_ws_01",
            ts: "2026-10-31T10:01:00.000Z",
            level: "error",
            message: "Live streamed error from BlueprintDO WebSocket",
            runId: "run_charge_fail_01",
            workflowId: "wf_payment",
            revision: 2,
            nodeId: "node_charge_wallet",
            brickId: "credit-wallet",
            workspaceId: "ws_alpha",
            requestId: null,
            fields: { live: true },
            fieldsJson: '{"live":true}',
            errorStack: null,
            envName: "preview",
          },
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("log-row-log_live_ws_01")).toBeTruthy();
      expect(
        screen.getByTestId("log-message-log_live_ws_01").textContent,
      ).toContain("Live streamed error from BlueprintDO WebSocket");
    });
  });
});
