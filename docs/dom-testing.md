# DOM Testing Guidelines & Conventions

Client-side tests (React components mounted in jsdom and run by Node) verify user interfaces across Studio Web and brick client widgets. Because React state updates and database adapters can be asynchronous, dom tests must adhere to strict synchronization contracts.

## The Cardinal Rule: Wait for State; Never Assume Rendering Is Synchronous

Never rely on luck, timer assumptions, or synchronous element lookup immediately after triggering user events.

### 1. Synchronous vs Asynchronous Lookups

- **DO NOT** call synchronous `screen.getBy*` or `screen.queryBy*` immediately after a `fireEvent` or state-dispatch that triggers asynchronous rendering or network requests.
- **DO** use `await screen.findBy*` or `await waitFor(() => { ... })` to wait for observable DOM changes.

```typescript
// BAD: Assumes the modal opens and renders its confirm button synchronously
fireEvent.click(screen.getByTestId("delete-item-button"));
fireEvent.click(screen.getByTestId("confirm-modal-submit")); // FLAKY!

// GOOD: Awaits the confirm button rendered by React
fireEvent.click(screen.getByTestId("delete-item-button"));
const submitBtn = await screen.findByTestId("confirm-modal-submit");
fireEvent.click(submitBtn);
```

### 2. Timeouts and Testing Library Configuration

- The default `asyncUtilTimeout` for Testing Library is configured globally to **10,000 ms** in `test/support/dom-setup.ts` (loaded via `setupFiles` in `vitest.dom.config.ts`).
- Vitest's suite `testTimeout` remains **60,000 ms**.
- Do not introduce `.skip` or `retry:` in vitest configs to mask flakiness. Tests must pass deterministically on busy CI runners and under artificial delays.

### 3. Opt-in Adapter Latency Testing

The test-only SQLite D1 adapters (`test/support/sqlite-d1.ts` and `bricks/credit-wallet/client/test/support/sqlite-d1.ts`) support the `DOM_TEST_ADAPTER_DELAY_MS` environment variable.
Setting `DOM_TEST_ADAPTER_DELAY_MS=300` injects artificial latency into every query, proving that tests properly await state and asynchronous responses rather than racing fast in-memory execution.

### 4. Stress Testing Dom Tests

To verify that dom tests are free from race conditions, run the stress test runner:

```bash
pnpm stress:dom --runs 20
pnpm stress:dom --runs 30 apps/studio-web/test/data-browser.test.tsx bricks/integration-connections/client/test/connect-account-widget.test.tsx
```
