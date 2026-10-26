/**
 * The Square refund request for a payment_refunds row (20261114090000).
 * No `server-only`, per the extract-the-core convention.
 *
 * Tableside's fee goes back in proportion: refunding a quarter of the
 * payment returns a quarter of the fee (rounded down, so never more than
 * was taken), so a restaurant isn't left paying a fee on money it gave
 * back. Square refunds the fee from Tableside's side via app_fee_money.
 */

export interface SquareRefundInput {
  refundId: string;
  squarePaymentId: string;
  amountMinorUnits: number;
  currency: string;
  /** What the Square payment came to, tip included, and Tableside's fee on it. */
  paymentTotalMinorUnits: number;
  appFeeMinorUnits: number;
  reason: string;
}

export interface SquareRefundRequest {
  idempotency_key: string;
  payment_id: string;
  amount_money: { amount: number; currency: string };
  app_fee_money?: { amount: number; currency: string };
  reason: string;
}

/** Square's limit on a refund's reason. */
const REASON_MAX = 192;

export function feeToReturn(
  appFeeMinorUnits: number,
  amountMinorUnits: number,
  paymentTotalMinorUnits: number,
): number {
  if (appFeeMinorUnits <= 0 || paymentTotalMinorUnits <= 0) return 0;
  const share = Math.floor(
    (appFeeMinorUnits * Math.min(amountMinorUnits, paymentTotalMinorUnits)) /
      paymentTotalMinorUnits,
  );
  return Math.min(share, appFeeMinorUnits);
}

export function buildSquareRefund(
  input: SquareRefundInput,
): SquareRefundRequest {
  const currency = input.currency.toUpperCase();
  const fee = feeToReturn(
    input.appFeeMinorUnits,
    input.amountMinorUnits,
    input.paymentTotalMinorUnits,
  );
  return {
    // Keyed on our row, so a double-submitted form returns the same refund
    // instead of sending the money twice. "refund-" + a UUID is 43
    // characters, inside Square's 45.
    idempotency_key: `refund-${input.refundId}`,
    payment_id: input.squarePaymentId,
    amount_money: { amount: input.amountMinorUnits, currency },
    ...(fee > 0 ? { app_fee_money: { amount: fee, currency } } : {}),
    reason: input.reason.slice(0, REASON_MAX),
  };
}
