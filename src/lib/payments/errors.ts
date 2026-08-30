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
};

export function parsePaymentError(rawMessage: string): string {
  const match = /^([A-Z_]+):/.exec(rawMessage);
  if (!match) return "Something went wrong. Please try again.";
  return (
    PAYMENT_MESSAGES[match[1]] ?? "Something went wrong. Please try again."
  );
}
