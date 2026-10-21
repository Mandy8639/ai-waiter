import "server-only";

import { createClient } from "@/lib/supabase/server";

/** A restaurant's subscription, as Stripe last reported it. */
export interface RestaurantSubscription {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  planSlug: string;
  stripeSubscriptionId: string;
}

export async function getRestaurantSubscription(
  restaurantId: string,
): Promise<RestaurantSubscription | null> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("restaurant_subscriptions")
    .select(
      "status, current_period_end, cancel_at_period_end, plan_id, stripe_subscription_id",
    )
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (!data) return null;

  const { data: plan } = await supabase
    .from("platform_plans")
    .select("slug")
    .eq("id", data.plan_id)
    .maybeSingle();

  return {
    status: data.status,
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end,
    planSlug: plan?.slug ?? "unknown",
    stripeSubscriptionId: data.stripe_subscription_id,
  };
}

/**
 * How a subscription status should read to a restaurant.
 *
 * Stripe's vocabulary is stored verbatim, but `incomplete_expired` is not
 * a sentence anyone should be shown. Nothing here gates access — these are
 * words, not permissions.
 */
export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  trialing: "Trial",
  active: "Active",
  past_due: "Payment overdue",
  canceled: "Cancelled",
  incomplete: "Awaiting payment",
  incomplete_expired: "Never completed",
  unpaid: "Unpaid",
  paused: "Paused",
};
