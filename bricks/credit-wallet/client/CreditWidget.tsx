import { useCallback, useEffect, useState } from "react";
import type { LedgerEntry, WalletClient } from "./wallet-client.ts";

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; balance: number; history: LedgerEntry[] };

/**
 * Shows a workspace's credit balance and its recent ledger, through the brick's own client. React escapes the text it
 * renders, so a ledger description from the server cannot inject markup.
 */
export function CreditWidget({ client, historyLimit = 5 }: { client: WalletClient; historyLimit?: number }) {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const [balance, history] = await Promise.all([client.getBalance(), client.getHistory()]);
      setState({ phase: "ready", balance: balance.currentBalance, history: history.slice(0, historyLimit) });
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "Something went wrong" });
    }
  }, [client, historyLimit]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-label="Credit balance">
      {state.phase === "loading" && <p role="status">Loading balance…</p>}
      {state.phase === "error" && (
        <div role="alert">
          <p>Could not load your balance: {state.message}</p>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {state.phase === "ready" && (
        <>
          <p>
            Balance: <strong data-testid="balance">{state.balance.toLocaleString("en-US")}</strong> credits
          </p>
          {state.history.length === 0 ? (
            <p>No transactions yet.</p>
          ) : (
            <ul aria-label="Recent transactions">
              {state.history.map((entry) => (
                <li key={entry.id}>
                  {entry.description}: {entry.amount > 0 ? "+" : ""}
                  {entry.amount.toLocaleString("en-US")} (balance {entry.balanceAfter.toLocaleString("en-US")})
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        </>
      )}
    </section>
  );
}
