import type { IntegrationManifestFile } from "@poc/assembler";

// Minimal valid stripe manifest fixture matching Stripe pack createPaymentIntent & getPaymentIntent
export const stripeManifest: IntegrationManifestFile = {
  manifestVersion: 2,
  kind: "integration",
  app: "stripe",
  version: "1.0.0",
  baseUrl: "https://api.stripe.com",
  allowedHosts: ["api.stripe.com"],
  auth: {
    type: "apiKey",
    headerName: "Authorization",
    prefix: "Bearer",
  },
  ui: {
    displayName: "Stripe",
    category: "billing",
    summary: "Stripe payment integration",
    maturity: "beta",
    maturityReason: "Stripe payment gateway adapter verification",
  },
  fidelity: {
    specHash: `sha256:${"0".repeat(64)}`,
    importerVersion: "2.0.0",
    level: "curated",
    unsupported: [],
  },
  operations: [
    {
      operationId: "createPaymentIntent",
      label: "Create payment intent",
      summary: "Create payment intent",
      method: "POST",
      path: "/v1/payment_intents",
      body: {
        contentType: "application/x-www-form-urlencoded",
        fields: [
          { name: "amount", dataType: "number", required: true },
          { name: "currency", dataType: "string", required: true },
          { name: "customer", dataType: "string" },
          { name: "metadata", dataType: "object" },
        ],
      },
      response: {
        status: 200,
        outputs: [
          { id: "id", dataType: "string" },
          { id: "client_secret", dataType: "string" },
          { id: "status", dataType: "string" },
          { id: "amount", dataType: "number" },
        ],
        errorShape: {
          codePath: "error.code",
          messagePath: "error.message",
          typePath: "error.type",
        },
      },
      idempotency: {
        header: "Idempotency-Key",
      },
      sideEffects: "write",
    },
    {
      operationId: "getPaymentIntent",
      label: "Retrieve payment intent",
      summary: "Retrieve payment intent",
      method: "GET",
      path: "/v1/payment_intents/{intentId}",
      params: [{ name: "intentId", in: "path", dataType: "string", required: true }],
      response: {
        status: 200,
        outputs: [
          { id: "id", dataType: "string" },
          { id: "status", dataType: "string" },
          { id: "amount", dataType: "number" },
        ],
        errorShape: {
          codePath: "error.code",
          messagePath: "error.message",
          typePath: "error.type",
        },
      },
      sideEffects: "read",
    },
  ],
};
