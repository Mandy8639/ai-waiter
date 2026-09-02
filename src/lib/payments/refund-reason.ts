/**
 * Refund reasons, kept out of the "use server" module so they are directly
 * testable — the same extract-the-core convention as src/lib/payments/tip.ts.
 *
 * There are two different "reasons" in play and conflating them loses
 * information in both directions:
 *
 *   Stripe's `reason`   a fixed enum — 'duplicate', 'fraudulent',
 *                       'requested_by_customer'. It categorises the refund
 *                       for Stripe's own reporting and dispute handling,
 *                       and Stripe rejects anything outside the set.
 *
 *   Our `reason`        free text, required, stored on payment_refunds.
 *                       This is the audit trail: what actually happened,
 *                       in a person's words, for whoever asks in a month.
 *
 * So the UI collects both, and this module keeps them straight: a category
 * that Stripe will accept, and a note that a human wrote.
 */

/** The only values Stripe accepts. Anything else is rejected by the API. */
export const REFUND_CATEGORIES = [
  "duplicate",
  "fraudulent",
  "requested_by_customer",
] as const;

export type RefundCategory = (typeof REFUND_CATEGORIES)[number];

/** Wording staff see, and what gets written into the stored audit text. */
export const REFUND_CATEGORY_LABELS: Record<RefundCategory, string> = {
  duplicate: "Charged twice",
  fraudulent: "Fraudulent",
  requested_by_customer: "Customer asked",
};

/** Matches payment_refunds_reason_length: 1–500 characters after trimming. */
const NOTE_MAX = 500;

export type ParsedRefundReason =
  | { ok: true; category: RefundCategory; note: string; storedReason: string }
  | { ok: false; message: string };

export function isRefundCategory(value: unknown): value is RefundCategory {
  return (
    typeof value === "string" &&
    (REFUND_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Validates what the form supplied and produces the two forms needed
 * downstream: the enum Stripe will accept, and the text stored against the
 * refund.
 *
 * The stored text leads with the category label so the audit trail reads
 * as a sentence — "Charged twice — duplicate of order #12" — rather than
 * making a reader join two fields in their head. The category is not
 * stored separately because Stripe's enum is Stripe's vocabulary; ours is
 * the record of what happened.
 */
export function parseRefundReason(
  rawCategory: unknown,
  rawNote: unknown,
): ParsedRefundReason {
  if (!isRefundCategory(rawCategory)) {
    return { ok: false, message: "Choose why this is being refunded." };
  }

  const note = typeof rawNote === "string" ? rawNote.trim() : "";
  if (note.length === 0) {
    // Required rather than optional: a refund with no explanation is the
    // one you cannot account for later, and start_refund() refuses it
    // anyway. Failing here gives a better message than a database error.
    return { ok: false, message: "Say why this is being refunded." };
  }

  const label = REFUND_CATEGORY_LABELS[rawCategory];
  const storedReason = `${label} — ${note}`;

  if (storedReason.length > NOTE_MAX) {
    return {
      ok: false,
      message: `Keep the reason under ${NOTE_MAX - label.length - 3} characters.`,
    };
  }

  return { ok: true, category: rawCategory, note, storedReason };
}

/**
 * A refund amount from a form.
 *
 * Empty means "refund whatever is left", which is what a full refund means
 * once partial ones exist — start_refund() treats null that way. An amount
 * that is present must look like money, and is rejected rather than
 * rounded for the same reason a tip is: charging or returning a number
 * nobody typed is its own bug.
 */
const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

export type ParsedRefundAmount =
  { ok: true; value: number | null } | { ok: false; message: string };

export function parseRefundAmount(raw: unknown): ParsedRefundAmount {
  if (raw === null || raw === undefined) return { ok: true, value: null };

  const text = String(raw).trim();
  if (text === "") return { ok: true, value: null };

  if (!AMOUNT_PATTERN.test(text)) {
    return { ok: false, message: "Enter an amount like 5 or 5.50." };
  }

  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, message: "A refund must be more than zero." };
  }

  return { ok: true, value };
}
