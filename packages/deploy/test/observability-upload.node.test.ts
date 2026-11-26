import { describe, expect, test } from "vitest";
import {
  createClient,
  deploy,
  memoryStore,
  openLedger,
  resourceNames,
  teardown,
  uploadMetadata,
} from "../src/provisioner/index.ts";
import type { DeployInput } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";

describe("UC9.4 — Observability provisioner and upload metadata", () => {
  const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
  const ACCOUNT = "0123456789abcdef0123456789abcdef";
  const KEY = "9f".repeat(32);
  const SUFFIX = "0a1b2c3d";

  function setup() {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
    const client = createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch });
    const store = memoryStore();
    const ledger = openLedger(store, () => SUFFIX, () => new Date("2026-10-21T00:00:00Z"));
    const names = resourceNames(SUFFIX);
    const input: DeployInput = {
      client,
      ledger,
      names,
      accessKey: KEY,
      bundle: { code: "export default { fetch() { return new Response('ok'); } }", sha256: "deadbeef" },
      migrations: [],
      compatibilityDate: "2026-10-01",
      nowIso: () => "2026-10-21T00:00:00.000Z",
    };
    return { fake, client, store, ledger, names, input };
  }

  test("uploadMetadata includes observability, logpush, and tail_consumers when configured", () => {
    const { names, input } = setup();

    (input as any).observability = {
      logs: true,
      logpush: true,
      alerts: { webhookSecret: "PX_ALERT_WEBHOOK_URL" },
    };

    const metadata = (uploadMetadata as any)(input, "test-db-id", false);

    expect(metadata.observability).toEqual({ enabled: true });
    expect(metadata.logpush).toBe(true);
    expect(metadata.tail_consumers).toEqual([{ service: `${names.script}-tail` }]);
  });

  test("deploy uploads the tail Worker before the main Worker and teardown removes it", async () => {
    const { client, ledger, names, input } = setup();

    (input as any).observability = {
      logs: true,
      logpush: true,
      alerts: { webhookSecret: "PX_ALERT_WEBHOOK_URL" },
      tailBundle: {
        code: "export default { async tail() {} }",
        sha256: "feedbeef",
      },
    };

    const result = await deploy(input);
    expect(result.changes.length).toBeGreaterThan(0);

    // Assert tail Worker was uploaded first
    const uploadCalls = client.calls.filter((c) => c.method === "PUT" && c.path.includes("/workers/scripts/"));
    expect(uploadCalls.length).toBeGreaterThanOrEqual(2);

    const tailScriptName = `${names.script}-tail`;
    const firstUpload = uploadCalls[0]!;
    const secondUpload = uploadCalls[1]!;

    expect(firstUpload.path).toContain(tailScriptName);
    expect(secondUpload.path).toContain(names.script);

    // Ledger must record the tail Worker script
    const tailLedgerEntry = ledger.entries().find((e) => e.kind === "worker_script" && e.name === tailScriptName);
    expect(tailLedgerEntry).toBeDefined();
    expect(tailLedgerEntry?.status).toBe("created");

    // AC3: Teardown removes the tail Worker
    const teardownResult = await teardown(client, ledger);
    const removedTail = teardownResult.removed.find((r) => r.kind === "worker_script" && r.name === tailScriptName);
    expect(removedTail).toBeDefined();
  });
});
