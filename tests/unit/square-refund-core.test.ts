import { describe, expect, it } from "vitest";
import { buildSquareRefund, feeToReturn } from "@/lib/pos/square/refund-core";

const REFUND_ID = "11111111-2222-4333-8444-555555555555";

describe("Square refunds", () => {
  it("returns Tableside's fee in proportion, never more than was taken", () => {
    // $1.00 fee on a $100.00 payment.
    expect(feeToReturn(100, 10_000, 10_000)).toBe(100);
    expect(feeToReturn(100, 2_500, 10_000)).toBe(25);
    expect(feeToReturn(100, 333, 10_000)).toBe(3); // rounded down
    expect(feeToReturn(100, 20_000, 10_000)).toBe(100);
    expect(feeToReturn(0, 5_000, 10_000)).toBe(0);
  });

  it("builds a refund keyed on our row, inside Square's limits", () => {
    const req = buildSquareRefund({
      refundId: REFUND_ID,
      squarePaymentId: "SQPAY1",
      amountMinorUnits: 550,
      currency: "usd",
      paymentTotalMinorUnits: 2_200,
      appFeeMinorUnits: 22,
      reason: "x".repeat(300),
    });
    expect(req.idempotency_key).toBe(`refund-${REFUND_ID}`);
    expect(req.idempotency_key.length).toBeLessThanOrEqual(45);
    expect(req.amount_money).toEqual({ amount: 550, currency: "USD" });
    expect(req.app_fee_money).toEqual({ amount: 5, currency: "USD" });
    expect(req.reason).toHaveLength(192);
  });

  it("leaves the fee out when there wasn't one", () => {
    const req = buildSquareRefund({
      refundId: REFUND_ID,
      squarePaymentId: "SQPAY1",
      amountMinorUnits: 550,
      currency: "USD",
      paymentTotalMinorUnits: 2_200,
      appFeeMinorUnits: 0,
      reason: "Dish returned",
    });
    expect(req.app_fee_money).toBeUndefined();
  });
});
