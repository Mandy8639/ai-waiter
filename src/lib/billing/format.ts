/**
 * Plan formatting, kept free of `server-only` so it is directly testable —
 * the same extract-the-core convention as src/lib/payments/tip.ts.
 */

/**
 * Basis points as a percentage. 100 -> "1%", 50 -> "0.5%", 25 -> "0.25%".
 *
 * Trailing zeros are trimmed rather than fixed at two places: "0.50%"
 * reads like a precision claim nobody made, and this number appears next
 * to a real charge.
 */
export function formatFeeBps(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/**
 * A monthly price from integer cents. Zero is rendered as "Free" rather
 * than "$0.00", because a plan that costs nothing is a different fact from
 * one priced at zero.
 */
export function formatMonthlyPrice(cents: number, currency: string): string {
  if (cents === 0) return "Free";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}
