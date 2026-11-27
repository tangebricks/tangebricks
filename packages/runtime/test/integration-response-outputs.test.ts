import { describe, expect, it } from "vitest";
import { IntegrationManifestSchema } from "@poc/assembler";
import { callOperation, IntegrationCallError } from "../src/index.ts";
import type { IntegrationFetcher } from "../src/index.ts";

const SECRET = "sk_test_secret_value_123";

const manifest = IntegrationManifestSchema.parse({
  manifestVersion: 2,
  kind: "integration",
  app: "stripe",
  version: "1.0.0",
  ui: {
    displayName: "Stripe",
    category: "billing",
    summary: "Stripe billing and payments",
    maturity: "beta",
    maturityReason: "Verified against recorded fixtures",
    behaviourTest: "packages/runtime/test/integration-response-outputs.test.ts",
  },
  auth: { type: "apiKey", headerName: "Authorization", prefix: "Bearer" },
  baseUrl: "https://api.stripe.com",
  allowedHosts: ["api.stripe.com"],
  operations: [
    {
      operationId: "createCharge",
      label: "Create charge",
      summary: "Create a charge",
      method: "POST",
      path: "/v1/charges",
      response: {
        outputs: [{ id: "id", dataType: "string" }],
        errorShape: { codePath: "error.code", messagePath: "error.message" },
      },
      sideEffects: "write",
    },
  ],
  fidelity: {
    specHash: "sha256:" + "0".repeat(64),
    importerVersion: "1.0.0",
    level: "curated",
    unsupported: [],
  },
});

async function run(status: number, payload: unknown): Promise<IntegrationCallError & { body?: unknown }> {
  const fetcher: IntegrationFetcher = async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  try {
    await callOperation(
      manifest,
      "createCharge",
      {},
      {
        connection: { apiKey: SECRET },
        fetcher,
        resolveHost: async () => ["93.184.216.34"],
      },
    );
  } catch (err) {
    expect(err).toBeInstanceOf(IntegrationCallError);
    return err as IntegrationCallError & { body?: unknown };
  }
  throw new Error("expected callOperation to reject");
}

describe("UC3.2 — provider error shape at runtime", () => {
  it("402 with errorShape rejects with providerCode, providerMessage and the error body", async () => {
    const err = await run(402, {
      error: { code: "card_declined", message: "Your card was declined." },
    });
    expect(err.code).toBe("INTEGRATION_HTTP_ERROR");
    expect(err.status).toBe(402);
    expect(err.providerCode).toBe("card_declined");
    expect(err.providerMessage).toBe("Your card was declined.");
    expect(err.message).toContain("card_declined");
    expect(err.message).toContain("Your card was declined.");
    expect(err.body).toEqual({
      error: { code: "card_declined", message: "Your card was declined." },
    });
  });

  it("redacts secrets echoed in the provider code, message and body", async () => {
    const err = await run(400, {
      error: { code: "invalid_key", message: `Bad key ${SECRET}` },
    });
    expect(err.providerCode).toBe("invalid_key");
    expect(err.message).not.toContain(SECRET);
    expect(err.providerMessage ?? "").not.toContain(SECRET);
    expect(JSON.stringify(err.body)).not.toContain(SECRET);
  });

  it("caps the redacted error body explicitly (not only by the 10 MB egress cap)", async () => {
    const err = await run(500, {
      error: { code: "boom", message: "x" },
      filler: "y".repeat(200_000),
    });
    expect(err.providerCode).toBe("boom");
    const serialized = JSON.stringify(err.body);
    expect(serialized.length).toBeLessThan(40_000);
    expect(err.body).toMatchObject({ truncated: true });
  });
});
