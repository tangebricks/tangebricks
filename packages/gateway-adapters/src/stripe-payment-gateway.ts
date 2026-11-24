import type { IntegrationManifestFile } from "@poc/assembler";
import type { GatewayOrder, PaymentGateway } from "@poc/credit-wallet";
import { IntegrationCallError, callOperation, type IntegrationFetcher } from "@poc/runtime";

export interface StripePaymentGatewayOptions {
  manifest: IntegrationManifestFile;
  connection?: Record<string, unknown> | null;
  fetcher: IntegrationFetcher;
  currency?: string;
}

export function createStripePaymentGateway(options: StripePaymentGatewayOptions): PaymentGateway {
  const { manifest, connection = null, fetcher, currency = "usd" } = options;

  return {
    async createOrder(input: {
      orderId: string;
      amount: number;
      customerId: string;
    }): Promise<{ paymentSessionId: string; orderId: string }> {
      const res = await callOperation(
        manifest,
        "createPaymentIntent",
        {
          amount: input.amount,
          currency,
          customer: input.customerId,
          metadata: {
            order_id: input.orderId,
            customer_id: input.customerId,
          },
          "metadata[order_id]": input.orderId,
          "metadata[customer_id]": input.customerId,
        },
        {
          connection,
          fetcher,
          idempotencyKey: `wallet:${input.orderId}`,
        },
      );

      // Story 0.9 (A21): only a 2xx answer that names a session counts as created. Anything else is a
      // provider error, so the wallet records no order.
      if (res.status < 200 || res.status >= 300) {
        throw new IntegrationCallError(
          `PROVIDER_ERROR: Stripe createPaymentIntent answered HTTP ${res.status}; no order was created`,
          { code: "PROVIDER_ERROR", status: res.status },
        );
      }
      const body = (res.body ?? res.data ?? {}) as Record<string, unknown>;
      const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);
      const paymentSessionId = nonEmpty(body.client_secret) ?? nonEmpty(body.id);
      if (!paymentSessionId) {
        throw new IntegrationCallError(
          "PROVIDER_ERROR: Stripe createPaymentIntent returned no payment intent id or client secret; no order was created",
          { code: "PROVIDER_ERROR", status: res.status },
        );
      }
      return {
        paymentSessionId,
        orderId: input.orderId,
      };
    },

    async fetchOrder(orderId: string): Promise<GatewayOrder> {
      const res = await callOperation(
        manifest,
        "getPaymentIntent",
        {
          intentId: orderId,
        },
        {
          connection,
          fetcher,
        },
      );

      const body = (res.body ?? res.data ?? {}) as Record<string, unknown>;
      const rawStatus = (body.status as string) ?? "";
      const status = rawStatus === "succeeded" ? "PAID" : rawStatus;
      const amount = typeof body.amount === "number" ? body.amount : 0;
      return {
        status,
        amount,
      };
    },
  };
}
