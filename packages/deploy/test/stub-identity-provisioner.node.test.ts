import { describe, expect, test } from "vitest";
import { createClient, deploy, DeployError, memoryStore, openLedger, resourceNames, uploadMetadata } from "../src/provisioner/index.ts";
import type { DeployInput } from "../src/provisioner/index.ts";
import { createFakeCloudflare } from "./support/fake-cloudflare.ts";

const TOKEN = "cfut_Zq8rLm3VxN2pTb7YkWd4HsJc9GaE5uRo6QiXf1BvPn0AyMt";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

function setup(lockIdentity: string, environment: "dev" | "preview" | "production") {
  const fake = createFakeCloudflare({ token: TOKEN, accountId: ACCOUNT });
  const client = createClient({ credentials: { token: TOKEN, accountId: ACCOUNT }, fetch: fake.fetch });
  const ledger = openLedger(memoryStore(), () => "0a1b2c3d", () => new Date("2026-10-21T00:00:00Z"));
  const input: DeployInput = {
    client,
    ledger,
    names: resourceNames("0a1b2c3d"),
    accessKey: "9f".repeat(32),
    bundle: { code: "export default { fetch() { return new Response('ok'); } }", sha256: "deadbeef" },
    migrations: [],
    compatibilityDate: "2026-10-01",
    environment,
    lock: { identity: lockIdentity },
  };
  return { fake, input };
}

describe("UC9.8 — provisioner refuses stub identity in production", () => {
  test("production + stub throws DeployError before any write call", async () => {
    const { fake, input } = setup("stub", "production");
    await expect(deploy(input)).rejects.toBeInstanceOf(DeployError);
    expect(fake.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  test("production + a real identity deploys", async () => {
    const { input } = setup("core-auth", "production");
    await expect(deploy(input)).resolves.toBeDefined();
  });

  test("preview + stub deploys", async () => {
    const { input } = setup("stub", "preview");
    await expect(deploy(input)).resolves.toBeDefined();
  });

  test("the Worker gets PX_ENVIRONMENT as a plain-text binding", () => {
    const { input } = setup("core-auth", "production");
    const metadata = uploadMetadata(input, "db-id", false);
    expect(metadata.bindings).toContainEqual({ type: "plain_text", name: "PX_ENVIRONMENT", text: "production" });
  });
});
