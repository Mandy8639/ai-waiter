import { beforeEach, describe, expect, it, vi } from "vitest";

// refundDoubleCharge (src/lib/payments/double-charge.ts): a guest who paid
// for a bill that was already settled gets the whole charge back, once,
// and how that went is recorded for Settle up.
vi.mock("server-only", () => ({}));

const { state, stripeRefund, squareRefund, getPayment, rpc, report } =
  vi.hoisted(() => ({
    state: {
      conflict: null as Record<string, unknown> | null,
      account: { stripe_account_id: "acct_123" } as Record<
        string,
        unknown
      > | null,
    },
    stripeRefund: vi.fn(),
    squareRefund: vi.fn(),
    getPayment: vi.fn(),
    rpc: vi.fn(async () => ({ error: null })),
    report: vi.fn(),
  }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data: table === "payment_conflicts" ? state.conflict : state.account,
        }),
      };
      return chain;
    },
    rpc,
  }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  isStripeConfigured: () => true,
  getStripe: () => ({ refunds: { create: stripeRefund } }),
}));
vi.mock("@/lib/pos/square/api", () => ({
  getPayment,
  refundSquarePayment: squareRefund,
}));
vi.mock("@/lib/observability/report", () => ({ reportError: report }));

import { refundDoubleCharge } from "@/lib/payments/double-charge";

const conflict = (overrides: Record<string, unknown> = {}) => ({
  id: "c0ffee00-0000-4000-8000-000000000001",
  restaurant_id: "r1",
  amount: "42.50",
  currency: "USD",
  refund_status: "pending",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.conflict = conflict();
  state.account = { stripe_account_id: "acct_123" };
});

describe("refunding a guest who paid twice", () => {
  it("refunds the whole Stripe charge, fee included, keyed on the conflict", async () => {
    stripeRefund.mockResolvedValue({ id: "re_1" });
    await refundDoubleCharge("stripe", "pi_late");

    expect(stripeRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_late",
        reason: "duplicate",
        refund_application_fee: true,
      }),
      {
        stripeAccount: "acct_123",
        idempotencyKey: `double-charge:${conflict().id}`,
      },
    );
    expect(rpc).toHaveBeenCalledWith("record_payment_conflict_refund", {
      p_conflict_id: conflict().id,
      p_refund_id: "re_1",
      p_error: null,
    });
  });

  it("refunds the whole Square payment and Tableside's fee", async () => {
    getPayment.mockResolvedValue({
      totalMinorUnits: 4250,
      appFeeMinorUnits: 43,
      currency: "USD",
    });
    squareRefund.mockResolvedValue({ id: "sq_re_1", status: "PENDING" });
    await refundDoubleCharge("square", "PAY_1");

    expect(squareRefund).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({
        payment_id: "PAY_1",
        amount_money: { amount: 4250, currency: "USD" },
        app_fee_money: { amount: 43, currency: "USD" },
        idempotency_key: `refund-${conflict().id}`,
      }),
    );
    expect(rpc).toHaveBeenCalledWith(
      "record_payment_conflict_refund",
      expect.objectContaining({ p_refund_id: "sq_re_1" }),
    );
  });

  it("never refunds twice", async () => {
    state.conflict = conflict({ refund_status: "refunded" });
    await refundDoubleCharge("stripe", "pi_late");

    expect(stripeRefund).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("records a refund that failed, without throwing", async () => {
    stripeRefund.mockRejectedValue(new Error("Stripe is down"));
    await expect(
      refundDoubleCharge("stripe", "pi_late"),
    ).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledWith("record_payment_conflict_refund", {
      p_conflict_id: conflict().id,
      p_refund_id: null,
      p_error: "Stripe is down",
    });
  });

  it("can't refund without knowing which Stripe payment it was", async () => {
    await refundDoubleCharge("stripe", "cs_only_a_session");

    expect(stripeRefund).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "record_payment_conflict_refund",
      expect.objectContaining({ p_refund_id: null }),
    );
  });

  it("always tells the team", async () => {
    state.conflict = null;
    await refundDoubleCharge("square", "PAY_unknown");

    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ scope: "payments.double_charge" }),
    );
    expect(squareRefund).not.toHaveBeenCalled();
  });
});
