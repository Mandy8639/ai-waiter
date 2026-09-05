import type { CartSummary } from "@/lib/cart/get-cart";

/**
 * Pure confirmation-gate logic for submit_order — deliberately has no
 * `server-only` import (no DB access here at all) so it's directly
 * unit-testable, mirroring providers/*-mapping.ts's split between pure
 * logic and the server-only file that calls it (order.ts).
 *
 * The gate exists because the system prompt alone ("wait for a clear
 * yes") isn't reliable: a live test showed a model treating "Place the
 * order" itself as sufficient confirmation and calling submit_order
 * immediately. This makes confirmation a server-enforced precondition
 * instead of a behavioral suggestion — see order.ts for how the two
 * database reads that feed this function are done.
 */

/**
 * Content-based, not row-ID-based: two carts with the same
 * items/quantities/modifiers/requests fingerprint identically regardless
 * of cart_item row churn.
 *
 * The per-line spice request and note are part of the content on purpose.
 * They cost nothing and change nothing about the price, which is exactly
 * why leaving them out would be easy to justify and wrong: the customer
 * confirmed a summary that said "cooked hot", and a cart whose line is
 * now cooked mild is not the cart they agreed to. Without them, removing
 * a line and re-adding the same dish with different cooking instructions
 * produces an identical fingerprint and sails through the gate.
 */
export function computeCartFingerprint(lines: CartSummary["lines"]): string {
  return lines
    .map((line) => {
      const modifiers = line.modifiers
        .map((m) => `${m.name}:${m.priceAdjustment}`)
        .sort()
        .join(",");
      const request = `${line.spicePreference ?? ""}:${line.notes ?? ""}`;
      return `${line.menuItemId}:${line.quantity}:${modifiers}:${request}`;
    })
    .sort()
    .join("|");
}

export interface PendingConfirmation {
  fingerprint: string;
  /** ISO timestamp of the request_order_confirmation call that established this. */
  requestedAt: string;
}

export interface ConfirmationCheckResult {
  confirmed: boolean;
  /** Customer-safe explanation when not confirmed — never a raw internal detail. */
  reason?: string;
}

/**
 * The single decision point submit_order defers to. `pending` must be the
 * MOST RECENT successful request_order_confirmation call for this
 * session, however long ago — there's no separate "expiry" beyond the
 * fingerprint no longer matching the live cart (a customer taking a long
 * detour before saying "yes" is still fine, as long as they haven't
 * changed the cart since).
 */
export function checkOrderConfirmation(params: {
  pending: PendingConfirmation | null;
  currentFingerprint: string;
  /** ISO timestamp of the user message that triggered the CURRENT turn — null only if no user message exists yet, which shouldn't happen in practice. */
  currentTurnUserMessageAt: string | null;
}): ConfirmationCheckResult {
  const { pending, currentFingerprint, currentTurnUserMessageAt } = params;

  if (!currentTurnUserMessageAt || !pending) {
    return {
      confirmed: false,
      reason:
        "I haven't shown you an order summary to confirm yet — let me do that first, then just say the word to place it.",
    };
  }

  // Strictly earlier, not "earlier or equal": a confirmation call and a
  // submit_order call both happening within the same turn (e.g. the model
  // chaining both tools in response to a single ambiguous message,
  // without a real customer message in between) must never count — this
  // is the specific bypass this gate exists to close.
  if (
    !(
      new Date(pending.requestedAt).getTime() <
      new Date(currentTurnUserMessageAt).getTime()
    )
  ) {
    return {
      confirmed: false,
      reason:
        "I need you to confirm the order summary in a separate message before I can place it.",
    };
  }

  if (pending.fingerprint !== currentFingerprint) {
    return {
      confirmed: false,
      reason:
        "The cart has changed since I last confirmed it with you — let me show you the updated summary first.",
    };
  }

  return { confirmed: true };
}
