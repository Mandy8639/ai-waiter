/**
 * Cash recording, kept out of the "use server" module so it is directly
 * testable — the same extract-the-core convention as
 * src/lib/payments/tip.ts and src/lib/payments/refund-reason.ts.
 *
 * Two things arrive from a form and neither can be trusted: which orders
 * are being settled, and (when correcting a mistake) why. The amount is
 * deliberately NOT one of them — record_cash_payment() sums it from the
 * orders themselves, so there is no field here for a staff member to
 * mistype or tamper with.
 */

/** Matches order_payments_reversal_reason_length: 1–500 characters after trimming. */
const REASON_MAX = 500;

export type ParsedOrderIds =
  { ok: true; value: string[] } | { ok: false; message: string };

/**
 * A checkbox group posts one entry per ticked box, so this takes the whole
 * list rather than a single value.
 *
 * Duplicates are collapsed instead of rejected: a repeated id is a form
 * quirk, not a user error, and record_cash_payment() sums each order once
 * regardless (`o.id = any(p_order_ids)`), so accepting them would not
 * double-charge — but passing a clean array keeps the payment_orders rows
 * honest about what was settled.
 */
export function parseOrderIds(raw: unknown[]): ParsedOrderIds {
  const ids = raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  const unique = [...new Set(ids)];

  if (unique.length === 0) {
    return { ok: false, message: "Choose at least one order to settle." };
  }

  return { ok: true, value: unique };
}

export type ParsedReversalReason =
  { ok: true; value: string } | { ok: false; message: string };

/**
 * Why a recorded cash payment is being un-recorded.
 *
 * Required, exactly as reverse_cash_payment() requires it. "Unrecord this
 * cash" is how a till gets skimmed, so the reason is the audit trail that
 * makes the correction accountable — an optional field would be left blank
 * precisely when it mattered most.
 */
export function parseReversalReason(raw: unknown): ParsedReversalReason {
  const text = typeof raw === "string" ? raw.trim() : "";

  if (text.length === 0) {
    return { ok: false, message: "Say why this is being reversed." };
  }

  if (text.length > REASON_MAX) {
    return {
      ok: false,
      message: `Keep the reason under ${REASON_MAX} characters.`,
    };
  }

  return { ok: true, value: text };
}
