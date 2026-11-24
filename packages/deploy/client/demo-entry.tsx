import { createRoot } from "react-dom/client";
import { CreditWidget } from "../../../bricks/credit-wallet/client/CreditWidget.tsx";
import { createWalletClient } from "../../../bricks/credit-wallet/client/wallet-client.ts";

// The demo page's script: it shows the credit widget for one workspace, through the credit-wallet brick's own client.
// There is deliberately no network code here (no fetch, no XMLHttpRequest): everything the page asks of the server goes
// through createWalletClient, which is what story 7's H12 check scans this file for.
//
// The access key, the user and the workspace come from the address fragment (#key=...&user=...&workspace=...). A
// fragment is never sent to a server, so the key does not appear in a request line or a server log. It is removed from
// the address bar as soon as it has been read.

const root = document.getElementById("root");
if (root) {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const key = params.get("key");
  const user = params.get("user");
  const workspace = params.get("workspace");
  if (!key || !user || !workspace) {
    root.textContent = "Open this page with #key=...&user=...&workspace=... added to its address.";
  } else {
    window.history.replaceState(null, "", window.location.pathname);
    const client = createWalletClient({
      baseUrl: `${window.location.origin}/api`,
      workspaceId: workspace,
      headers: { "x-poc-key": key, "x-test-user": user },
    });
    createRoot(root).render(<CreditWidget client={client} />);
  }
}
