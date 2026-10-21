/**
 * What the Payments page offers for a restaurant's own Tableside plan:
 * cancel it, undo a cancellation, or nothing. Pure, so it's unit-tested.
 *
 * Cancelling is always "at the end of the period": the restaurant keeps
 * what it paid for, and the Terms of Service promise no part-month refunds.
 */
export type CancelControls =
  | { kind: "none" }
  | { kind: "can_cancel"; activeUntil: string | null }
  | { kind: "ending"; endsOn: string | null };

/** Stripe statuses that are still a live subscription Stripe will renew. */
const LIVE = new Set(["active", "trialing", "past_due"]);

export function cancelControlsFor(
  subscription: {
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null,
): CancelControls {
  if (!subscription || !LIVE.has(subscription.status)) return { kind: "none" };
  return subscription.cancelAtPeriodEnd
    ? { kind: "ending", endsOn: subscription.currentPeriodEnd }
    : { kind: "can_cancel", activeUntil: subscription.currentPeriodEnd };
}
