/**
 * link_restaurant_payment_account()/sync_restaurant_payment_account_status()
 * raise `CODE: detail` exceptions (see
 * supabase/migrations/20260830090000_payments_phase1.sql), mapped here to
 * user-facing copy — the same shape as src/lib/reservations/errors.ts.
 *
 * Two audiences share this map. Codes raised while a diner is paying are
 * worded for someone at a table; codes only ever raised behind the
 * dashboard are worded for staff. A code reachable from both (an order
 * already paid, say) is worded so it reads sensibly either way.
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
  PAYMENT_IN_PROGRESS:
    "A payment for this order is already open. Finish it, or reload the page to start again.",

  // Phase 3, step 1 — raised by start_tab_payment(). Diner-facing: these
  // are reached from the table, not the dashboard.
  PAYMENT_NOTHING_TO_PAY: "Everything on this tab has already been paid.",
  PAYMENT_ORDER_ALREADY_SETTLED:
    "One of these orders has already been paid, so the tab can't be settled as it stands. Reload and try again.",
  PAYMENT_NO_SESSION:
    "This table's session has ended. Scan the code again to start a new one.",

  // Phase 3, step 2 — raised by record_cash_payment()/reverse_cash_payment().
  // Staff-facing: the reader is holding the notes, so these say what to do
  // rather than apologising.
  PAYMENT_NO_ORDERS: "Choose at least one order to settle.",
  PAYMENT_MIXED_RESTAURANTS:
    "Those orders belong to different restaurants and can't be settled together.",
  PAYMENT_MIXED_CURRENCY:
    "Those orders are in different currencies and can't be settled together.",
  PAYMENT_FORBIDDEN: "You don't have access to this restaurant's payments.",
  PAYMENT_CASH_NOT_ACCEPTED:
    "Cash isn't switched on for this restaurant. Turn it on in Payments settings first.",
  PAYMENT_NOT_FOUND: "We couldn't find that payment.",
  PAYMENT_NOT_CASH:
    "Only a cash payment can be reversed. Refund a card payment instead.",
  PAYMENT_NOT_REVERSIBLE:
    "Only a settled cash payment can be reversed. This one isn't.",
  PAYMENT_REASON_REQUIRED: "Say why this is being reversed.",

  // Phase 3, step 3 — raised by start_refund()/attach_refund_stripe_id()/
  // cancel_pending_refund(). Without these every refund failure fell
  // through to the generic message below, which told the reader nothing
  // about which rule they had hit.
  REFUND_FORBIDDEN: "Only an owner or manager can refund a payment.",
  REFUND_NOT_FOUND: "We couldn't find that refund.",
  REFUND_PAYMENT_NOT_FOUND: "We couldn't find the payment being refunded.",
  REFUND_PAYMENT_NOT_SETTLED:
    "That payment never completed, so there's nothing to refund.",
  REFUND_NOT_CARD:
    "Only a card payment can be refunded. Reverse a cash payment instead.",
  REFUND_EXCEEDS_PAYMENT: "That's more than is left to refund on this payment.",
  REFUND_NOTHING_LEFT: "This payment has already been fully refunded.",
  REFUND_REASON_REQUIRED: "Say why this is being refunded.",
  REFUND_NO_ACCOUNT:
    "This restaurant's Stripe account is no longer connected, so the money can't be sent back.",
  REFUND_NO_PAYMENT_INTENT:
    "That payment has no Stripe charge behind it, so it can't be refunded here.",
  REFUND_ALREADY_LINKED: "That refund has already been recorded.",
  // Raised by cancel_pending_refund() when Stripe did accept the refund
  // after all. Saying "nothing was sent" here would contradict the
  // customer's bank, so it says the opposite.
  REFUND_ALREADY_SENT:
    "That refund has already gone to Stripe and can't be cancelled.",
};

export function parsePaymentError(rawMessage: string): string {
  const match = /^([A-Z_]+):/.exec(rawMessage);
  if (!match) return "Something went wrong. Please try again.";
  return (
    PAYMENT_MESSAGES[match[1]] ?? "Something went wrong. Please try again."
  );
}
