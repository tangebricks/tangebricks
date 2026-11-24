import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CreditWidget } from "../../../../bricks/credit-wallet/client/CreditWidget.tsx";
import type { WalletClient } from "../../../../bricks/credit-wallet/client/wallet-client.ts";
import type { MountedWidget } from "../../src/h12.ts";

// Mounts the credit widget in the DOM the way a product page would and lets a test do only what a person can do: look at it
// and press Refresh. It contains no network code: the widget reaches the server only through the client it is given.

/** Waits until the widget shows either a balance or an error, which is the end of its "loading" state. */
const settled = () =>
  waitFor(
    () => {
      if (!screen.queryByTestId("balance") && !screen.queryByRole("alert")) throw new Error("the widget is still loading");
    },
    { timeout: 45_000, interval: 25 },
  );

export async function mountCreditWidget(client: WalletClient): Promise<MountedWidget> {
  const view = render(<CreditWidget client={client} />);
  await settled();
  return {
    async shown() {
      await settled();
      return screen.queryByTestId("balance")?.textContent ?? null;
    },
    async alert() {
      await settled();
      return screen.queryByRole("alert")?.textContent ?? null;
    },
    async history() {
      await settled();
      return screen.queryAllByRole("listitem").map((li) => li.textContent ?? "");
    },
    async refresh() {
      const button = screen.queryByRole("button", { name: /refresh|try again/i });
      if (!button) throw new Error("there is no Refresh button to press");
      fireEvent.click(button);
      await settled();
    },
    unmount: () => view.unmount(),
  };
}
