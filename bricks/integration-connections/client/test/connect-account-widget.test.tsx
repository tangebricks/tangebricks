import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { workspaceMiddleware } from "@poc/multi-workspace";
import type { WorkspaceEnv } from "@poc/multi-workspace";
import { applyMigration } from "@poc/sdk";
import { createSqliteD1 } from "../../../credit-wallet/client/test/support/sqlite-d1.ts";
import mwMigration from "../../../multi-workspace/migrations/0001_multi_workspace.sql?raw";
import { stubIdentity } from "../../../multi-workspace/test/support/stub-identity.ts";
import intMigration from "../../migrations/0001_integration_connections.sql?raw";
import { createIntegrationConnectionsRoutes } from "../../src/index.ts";
import { ConnectAccountWidget, createIntegrationConnectionsClient } from "../index.ts";

const db = createSqliteD1();
const pxConnKey = "widget-test-conn-key-2026";

const app = new Hono<WorkspaceEnv>();
app.use("/api/*", stubIdentity);
app.use("/api/integrations", workspaceMiddleware);
app.use("/api/integrations/*", workspaceMiddleware);
app.use("/api/connect/*", workspaceMiddleware);
// Story 0.9 (A7, A13): no token-exchange fallback and no placeholder client id in the brick; the test
// injects a client id and a deterministic test exchange explicitly.
app.route(
  "/api",
  createIntegrationConnectionsRoutes({
    adapter: {
      providers: { google: { clientId: "test-google-client-id" } },
      exchangeCode: async ({ provider, code, workspaceId }) => ({
        accessToken: `ya29.${provider}.${workspaceId}.${code}`,
        refreshToken: `1//refresh.${provider}.${workspaceId}.${code}`,
        tokenType: "Bearer",
        expiresIn: 3600,
        // Story 1.15 (A10): no provider label here, so the callback's account_label is the (fallback) label shown.
        externalAccountId: `acct_${workspaceId}_${provider}`,
      }),
    },
  }),
);

function clientFor(workspaceId: string, user = "alice") {
  return createIntegrationConnectionsClient({
    baseUrl: "http://app.test/api",
    workspaceId,
    headers: { "x-test-user": user },
    fetch: async (input, init) => app.fetch(new Request(input, init), { DB: db, PX_CONN_KEY: pxConnKey }),
  });
}

beforeEach(async () => {
  for (const table of ["int_connections", "int_oauth_states", "mw_members", "mw_workspaces"]) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await applyMigration(db, mwMigration);
  await applyMigration(db, intMigration);
  for (const [id, user] of [
    ["ws-a", "alice"],
    ["ws-b", "bob"],
  ] as const) {
    await db.prepare("INSERT INTO mw_workspaces (id, name, owner_id) VALUES (?, ?, ?)").bind(id, id, user).run();
    await db.prepare("INSERT INTO mw_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, user).run();
  }
});

afterEach(() => cleanup());

describe("ConnectAccountWidget against bricks/integration-connections routes (AC 4)", () => {
  test("transitions through Not connected -> Connecting -> Connected (account email + Disconnect) -> Expired (Reconnect)", async () => {
    const clientA = clientFor("ws-a", "alice");

    let resolveAuthorizeCallback: (() => void) | undefined;
    const onAuthorizeRedirect = async ({ provider, state }: { provider: string; authorizeUrl: string; state: string }) => {
      await new Promise<void>((resolve) => {
        resolveAuthorizeCallback = resolve;
      });
      await app.fetch(
        new Request(
          `http://app.test/api/integrations/${provider}/callback?code=oauth_code_1&state=${encodeURIComponent(state)}&account_label=alice%40acme.io`,
          {
            headers: {
              "x-test-user": "alice",
              "x-workspace-id": "ws-a",
            },
          },
        ),
        { DB: db, PX_CONN_KEY: pxConnKey },
      );
    };

    render(<ConnectAccountWidget client={clientA} onAuthorizeRedirect={onAuthorizeRedirect} />);

    // 1. Initial state: Not connected
    await waitFor(
      () => {
        expect(screen.getByTestId("provider-status-google").textContent).toBe("Not connected");
      },
      { timeout: 10_000 },
    );
    expect(screen.getByTestId("provider-connect-btn-google")).toBeTruthy();

    // 2. Click Connect Google -> enters Connecting state while OAuth redirect is in flight
    fireEvent.click(screen.getByTestId("provider-connect-btn-google"));
    await waitFor(
      () => {
        expect(screen.getByTestId("provider-status-google").textContent).toBe("Connecting");
        expect(resolveAuthorizeCallback).toBeDefined();
      },
      { timeout: 10_000 },
    );
    expect(screen.getByTestId("provider-connecting-btn-google")).toBeTruthy();

    // 3. Complete OAuth callback -> transitions to Connected showing account label + Disconnect button
    resolveAuthorizeCallback?.();
    await waitFor(
      () => {
        expect(screen.getByTestId("provider-status-google").textContent).toBe("Connected");
      },
      { timeout: 10_000 },
    );
    expect((await screen.findByTestId("provider-account-google", {}, { timeout: 10_000 })).textContent).toContain("alice@acme.io");
    expect(await screen.findByTestId("provider-disconnect-btn-google", {}, { timeout: 10_000 })).toBeTruthy();

    // 4. Mark connection as expired in D1 and re-render -> shows Expired + Reconnect button
    await db.prepare("UPDATE int_connections SET status = 'expired' WHERE workspace_id = 'ws-a' AND provider = 'google'").run();
    cleanup();
    render(
      <ConnectAccountWidget
        client={clientA}
        onAuthorizeRedirect={async ({ provider, state }) => {
          await app.fetch(
            new Request(
              `http://app.test/api/integrations/${provider}/callback?code=oauth_reconn_2&state=${encodeURIComponent(state)}&account_label=alice%40acme.io`,
              {
                headers: {
                  "x-test-user": "alice",
                  "x-workspace-id": "ws-a",
                },
              },
            ),
            { DB: db, PX_CONN_KEY: pxConnKey },
          );
        }}
      />,
    );

    await waitFor(
      () => {
        expect(screen.getByTestId("provider-status-google").textContent).toBe("Expired");
      },
      { timeout: 10_000 },
    );
    expect(await screen.findByTestId("provider-reconnect-btn-google", {}, { timeout: 10_000 })).toBeTruthy();

    // Click Reconnect -> back to Connected
    fireEvent.click(await screen.findByTestId("provider-reconnect-btn-google", {}, { timeout: 10_000 }));
    await waitFor(
      () => {
        expect(screen.getByTestId("provider-status-google").textContent).toBe("Connected");
      },
      { timeout: 10_000 },
    );

    // Click Disconnect -> back to Not connected
    fireEvent.click(await screen.findByTestId("provider-disconnect-btn-google", {}, { timeout: 10_000 }));
    await waitFor(
      () => {
        expect(screen.getByTestId("provider-status-google").textContent).toBe("Not connected");
      },
      { timeout: 10_000 },
    );
  });
});
