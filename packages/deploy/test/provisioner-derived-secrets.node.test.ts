// Story 1.17: a deployed Worker holds only its project's derived secrets. The provisioner binds PX_TELEMETRY_SECRET (the
// derived control-plane value, keeping the binding name), PX_TELEMETRY_WEBHOOK_SECRET (the derived webhook value) and
// PX_PROJECT_ID; Studio's root secret is never bound, and nothing signed with project A's values verifies for project B.
import { describe, expect, test } from "vitest";
import { checkControlPlaneSignature, deriveProjectSecret, signControlPlaneRequest } from "@poc/telemetry";
import {
  createClient,
  deploy,
  memoryStore,
  openLedger,
  resourceNames,
  telemetryWebhookBindings,
  telemetryWebhookConfig,
  uploadMetadata,
} from "../src/provisioner/index.ts";
import type { DeployInput } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";

const ROOT = "story-1-17-provisioner-root-secret-0123456789";
const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY = "9f".repeat(32);
const SUFFIX = "1a2b3c4d";

describe("story 1.17: provisioner bindings are derived per project, never the root", () => {
  test("telemetryWebhookConfig derives both purposes; the bindings carry them and the project id only", async () => {
    const config = await telemetryWebhookConfig("https://studio.invalid/api/projects/proj-a/telemetry/webhook", "proj-a", ROOT);
    expect(config.controlPlaneSecret).toBe(await deriveProjectSecret(ROOT, "proj-a", "control-plane"));
    expect(config.signingSecret).toBe(await deriveProjectSecret(ROOT, "proj-a", "telemetry-webhook"));
    const byName = Object.fromEntries(telemetryWebhookBindings(config).map((b) => [b.name, b]));
    expect(byName.PX_TELEMETRY_SECRET).toEqual({ type: "secret_text", name: "PX_TELEMETRY_SECRET", text: config.controlPlaneSecret });
    expect(byName.PX_TELEMETRY_WEBHOOK_SECRET).toEqual({ type: "secret_text", name: "PX_TELEMETRY_WEBHOOK_SECRET", text: config.signingSecret });
    expect(byName.PX_PROJECT_ID).toEqual({ type: "plain_text", name: "PX_PROJECT_ID", text: "proj-a" });
    expect(byName.PX_TELEMETRY_WEBHOOK_URL?.text).toBe(config.url);
    expect(JSON.stringify(telemetryWebhookBindings(config))).not.toContain(ROOT);

    // Without a webhook URL the Worker still gets its derived control-plane secret and project id.
    const noUrl = await telemetryWebhookConfig(undefined, "proj-a", ROOT);
    expect(
      telemetryWebhookBindings(noUrl)
        .map((b) => b.name)
        .sort(),
    ).toEqual(["PX_PROJECT_ID", "PX_TELEMETRY_SECRET", "PX_TELEMETRY_WEBHOOK_SECRET"]);
    await expect(telemetryWebhookConfig(undefined, "proj-a", "")).rejects.toThrow();
  });

  test("a deploy uploads the derived values and never the root secret", async () => {
    const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
    const sentBodies: string[] = [];
    const client = createClient({
      credentials: { token: TOKEN, accountId: ACCOUNT },
      fetch: async (request: Request) => {
        sentBodies.push(
          await request
            .clone()
            .text()
            .catch(() => ""),
        );
        return fake.fetch(request);
      },
    });
    const ledger = openLedger(
      memoryStore(),
      () => SUFFIX,
      () => new Date("2026-11-25T00:00:00Z"),
    );
    const config = await telemetryWebhookConfig(undefined, "proj-a", ROOT);
    const input: DeployInput = {
      client,
      ledger,
      names: resourceNames(SUFFIX),
      accessKey: KEY,
      bundle: { code: "export default { fetch() { return new Response('ok'); } }", sha256: "deadbeef" },
      migrations: [],
      compatibilityDate: "2026-10-01",
      nowIso: () => "2026-11-25T00:00:00.000Z",
      telemetryWebhook: config,
    };
    const metadata = uploadMetadata(input, "db-id", false);
    const names = metadata.bindings.map((b) => b.name);
    expect(names).toContain("PX_TELEMETRY_SECRET");
    expect(JSON.stringify(metadata)).not.toContain(ROOT);

    await deploy(input);
    const sent = sentBodies.join(" ");
    expect(sent).toContain(config.controlPlaneSecret);
    expect(sent).toContain(config.signingSecret);
    expect(sent).not.toContain(ROOT);
  });

  test("a signature made with project A's derived control-plane secret is refused by project B's worker", async () => {
    const a = await telemetryWebhookConfig(undefined, "proj-a", ROOT);
    const b = await telemetryWebhookConfig(undefined, "proj-b", ROOT);
    const body = JSON.stringify({ requestId: crypto.randomUUID(), workspaceId: "ws_1" });
    const headers = await signControlPlaneRequest(a.controlPlaneSecret, "POST", "/__px/runs", body);
    const request = new Request("http://w.invalid/__px/runs", { method: "POST", headers, body });
    expect(await checkControlPlaneSignature(request, { secret: a.controlPlaneSecret, body })).toBeNull();
    expect(await checkControlPlaneSignature(request, { secret: b.controlPlaneSecret, body })).not.toBeNull();
  });
});
