import { useCallback, useEffect, useState } from "react";
import type { IntegrationConnectionsClient, WorkspaceIntegrationRecord } from "./connections-client.ts";

export interface ProviderDescriptor {
  provider: string;
  displayName: string;
  description?: string;
}

const DEFAULT_PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  {
    provider: "google",
    displayName: "Google Workspace",
    description: "Connect your Google Calendar and Gmail workspace account",
  },
  {
    provider: "slack",
    displayName: "Slack",
    description: "Send messages and receive workspace channel notifications",
  },
  {
    provider: "github",
    displayName: "GitHub",
    description: "Sync repositories, pull requests, and issue events",
  },
];

export interface ConnectAccountWidgetProps {
  client: IntegrationConnectionsClient;
  providers?: ProviderDescriptor[];
  onAuthorizeRedirect?: (params: { provider: string; authorizeUrl: string; state: string }) => void | Promise<void>;
}

type LoadState = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; recordsByProvider: Record<string, WorkspaceIntegrationRecord> };

export function ConnectAccountWidget({ client, providers = DEFAULT_PROVIDER_DESCRIPTORS, onAuthorizeRedirect }: ConnectAccountWidgetProps) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    setActionError(null);
    try {
      const list = await client.listIntegrations();
      const byProvider: Record<string, WorkspaceIntegrationRecord> = {};
      for (const item of list) {
        byProvider[item.provider.toLowerCase()] = item;
      }
      setState({ phase: "ready", recordsByProvider: byProvider });
    } catch (error) {
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : "Could not load workspace connections",
      });
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleConnect = async (providerSlug: string) => {
    setConnectingProvider(providerSlug);
    setActionError(null);
    try {
      const started = await client.startConnect(providerSlug);
      if (onAuthorizeRedirect) {
        await onAuthorizeRedirect({
          provider: started.provider,
          authorizeUrl: started.authorizeUrl,
          state: started.state,
        });
        await load();
        setConnectingProvider(null);
      }
    } catch (error) {
      setConnectingProvider(null);
      setActionError(error instanceof Error ? error.message : `Failed to start ${providerSlug} connection`);
    }
  };

  const handleDisconnect = async (providerSlug: string) => {
    setActionError(null);
    try {
      await client.disconnect(providerSlug);
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Failed to disconnect ${providerSlug}`);
    }
  };

  return (
    <section aria-label="Connect your account" data-testid="connect-account-widget">
      <h3>Connect your account</h3>
      {state.phase === "loading" && <p role="status">Loading workspace connections…</p>}
      {state.phase === "error" && (
        <div role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {actionError && (
        <div role="alert" data-testid="connect-account-error">
          {actionError}
        </div>
      )}
      {state.phase === "ready" && (
        <ul aria-label="Workspace integration providers">
          {providers.map((item) => {
            const slug = item.provider.toLowerCase();
            const record = state.recordsByProvider[slug];
            const isConnecting = connectingProvider === slug;
            const isConnected = !isConnecting && record?.status === "connected";
            const isExpired = !isConnecting && Boolean(record && (record.status === "expired" || record.status === "error"));

            const statusLabel = isConnecting ? "Connecting" : isConnected ? "Connected" : isExpired ? "Expired" : "Not connected";

            return (
              <li key={slug} data-testid={`provider-row-${slug}`} data-status={statusLabel.toLowerCase().replace(/\s+/g, "_")}>
                <div>
                  <strong>{item.displayName}</strong> <span data-testid={`provider-status-${slug}`}>{statusLabel}</span>
                  {item.description && <p>{item.description}</p>}
                  {isConnected && record?.accountLabel && <p data-testid={`provider-account-${slug}`}>Account: {record.accountLabel}</p>}
                </div>
                <div>
                  {isConnecting && (
                    <button type="button" disabled data-testid={`provider-connecting-btn-${slug}`}>
                      Connecting…
                    </button>
                  )}
                  {!isConnecting && !record && (
                    <button type="button" data-testid={`provider-connect-btn-${slug}`} onClick={() => void handleConnect(slug)}>
                      Connect {item.displayName}
                    </button>
                  )}
                  {isConnected && (
                    <button type="button" data-testid={`provider-disconnect-btn-${slug}`} onClick={() => void handleDisconnect(slug)}>
                      Disconnect
                    </button>
                  )}
                  {isExpired && (
                    <button type="button" data-testid={`provider-reconnect-btn-${slug}`} onClick={() => void handleConnect(slug)}>
                      Reconnect
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
