/**
 * link_restaurant_payment_account()/sync_restaurant_payment_account_status()
 * raise `CODE: detail` exceptions (see
 * supabase/migrations/20260830090000_payments_phase1.sql), mapped here to
 * user-facing copy — the same shape as src/lib/reservations/errors.ts.
 */
const PAYMENT_MESSAGES: Record<string, string> = {
  PAYMENT_ACCOUNT_UNAUTHENTICATED: "Please sign in again.",
  PAYMENT_ACCOUNT_FORBIDDEN:
    "Only an owner or manager can manage payment settings.",
  PAYMENT_ACCOUNT_INVALID_ID: "That doesn't look like a Stripe account.",
  PAYMENT_ACCOUNT_NOT_FOUND:
    "This restaurant doesn't have a Stripe account connected yet.",

  // Phase 2 — raised by start_order_payment()/attach_payment_checkout_session().
  // Worded for a diner at a table, not for an operator: they can act on
  // "ask your server", not on "charges_enabled is false".
  PAYMENT_ORDER_NOT_FOUND: "We couldn't find that order.",
  PAYMENT_NOT_YOUR_ORDER: "That order belongs to a different table.",
  PAYMENT_ORDER_CANCELLED:
    "This order was cancelled, so there's nothing to pay.",
  PAYMENT_ALREADY_PAID: "This order has already been paid.",
  PAYMENT_CARD_NOT_ACCEPTED:
    "This restaurant isn't taking card payments right now.",
  PAYMENT_TIPPING_DISABLED: "This restaurant isn't accepting tips.",
  PAYMENT_ACCOUNT_NOT_READY:
    "Card payments aren't ready here yet. Please ask your server.",
  PAYMENT_NOT_PENDING: "That payment has already been started.",
};

export function parsePaymentError(rawMessage: string): string {
  const match = /^([A-Z_]+):/.exec(rawMessage);
  if (!match) return "Something went wrong. Please try again.";
  return (
    PAYMENT_MESSAGES[match[1]] ?? "Something went wrong. Please try again."
  );
}
