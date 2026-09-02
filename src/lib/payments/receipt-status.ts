/**
 * What a receipt is allowed to claim.
 *
 * Kept out of any module importing `server-only` so it is directly
 * testable — the same extract-the-core convention as
 * src/lib/payments/tip.ts.
 *
 * A receipt is a claim about money, handed to the person whose money it
 * was. The failure that matters is not a crash but a confident wrong
 * number: showing the full amount for a payment that was half refunded, or
 * the word "Paid" over cash that a manager reversed an hour later. So the
 * state is derived here, once, from the payment's own fields, rather than
 * assembled inline in the page where a missing branch reads as normal.
 */

export type ReceiptState =
  /** Settled, nothing given back. */
  | "paid"
  /** Settled, but some of it has been returned. */
  | "partly_refunded"
  /** Settled, and all of it has been returned. */
  | "fully_refunded"
  /** Cash that was recorded and later un-recorded. No money moved. */
  | "reversed"
  /** Never completed: pending, failed or abandoned. Not a receipt at all. */
  | "unpaid";

export interface ReceiptAmounts {
  status: string;
  /** order_payments.total_amount — what was charged, tip included. */
  total: number;
  /** From payment_refunded_total(): counts pending refunds as committed. */
  refunded: number;
}

/**
 * Reversal is checked before refunds, and that order is deliberate. A
 * reversed cash payment says the money was never taken at all, so a refund
 * figure against it would be describing a return of money that never
 * moved.
 */
export function receiptState({
  status,
  total,
  refunded,
}: ReceiptAmounts): ReceiptState {
  if (status === "reversed") return "reversed";
  if (status !== "succeeded") return "unpaid";

  if (refunded <= 0) return "paid";
  // Rounding: these are numeric(10,2) values arriving as JS numbers, so a
  // full refund can land a hair under the total. Anything within half a
  // cent is the same thing, and calling it "partly refunded" would leave a
  // reader hunting for a penny that does not exist.
  if (refunded >= total - 0.005) return "fully_refunded";
  return "partly_refunded";
}

/**
 * What the payer is actually out of pocket.
 *
 * Never negative: the refund limit is enforced in the database
 * (enforce_refund_within_payment), but a receipt that could render a
 * negative total because of a rounding artefact would undermine the whole
 * document.
 */
export function netPaid({ status, total, refunded }: ReceiptAmounts): number {
  if (status === "reversed") return 0;
  if (status !== "succeeded") return 0;
  return Math.max(0, total - refunded);
}

/** Whether this payment should be presented as a receipt at all. */
export function isReceiptable(state: ReceiptState): boolean {
  return state !== "unpaid";
}
