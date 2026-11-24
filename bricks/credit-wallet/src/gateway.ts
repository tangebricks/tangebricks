/** What the wallet needs from a payment provider. A real provider (Cashfree, Stripe) implements this; the proof uses the fake. */
export interface GatewayOrder {
  /** "PAID" is the only status that credits. Anything else (ACTIVE, EXPIRED, FAILED, ...) does not. */
  status: string;
  amount: number;
}

export interface PaymentGateway {
  createOrder(input: { orderId: string; amount: number; customerId: string }): Promise<{ paymentSessionId: string; orderId: string }>;
  fetchOrder(orderId: string): Promise<GatewayOrder>;
}

/** A gateway whose orders and statuses the test sets directly. It makes no network call. */
export interface FakeGateway extends PaymentGateway {
  /** Sets an order's status and amount, creating it if needed. */
  setOrder(orderId: string, order: GatewayOrder): void;
  /** Makes fetchOrder fail, as a gateway outage would. */
  failFetches(failing: boolean): void;
  /** Makes createOrder fail, as a gateway outage would. */
  failCreates(failing: boolean): void;
}

export function createFakeGateway(): FakeGateway {
  const orders = new Map<string, GatewayOrder>();
  let failing = false;
  let failingCreates = false;
  return {
    async createOrder({ orderId, amount }) {
      if (failingCreates) throw new Error("gateway unavailable");
      orders.set(orderId, { status: "ACTIVE", amount });
      return { paymentSessionId: `session_${orderId}`, orderId };
    },
    async fetchOrder(orderId) {
      if (failing) throw new Error("gateway unavailable");
      const order = orders.get(orderId);
      if (!order) throw new Error(`gateway has no order ${orderId}`);
      return { ...order };
    },
    setOrder(orderId, order) {
      orders.set(orderId, { ...order });
    },
    failFetches(value) {
      failing = value;
    },
    failCreates(value) {
      failingCreates = value;
    },
  };
}
