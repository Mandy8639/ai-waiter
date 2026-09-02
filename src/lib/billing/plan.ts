import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * The plan a restaurant is on, for showing it what it pays.
 *
 * A restaurant with no `restaurant_plans` row is on the default — the
 * absence is the assignment, not a missing value, which is why this
 * returns a plan rather than null when nothing has been chosen.
 */

export interface RestaurantPlan {
  slug: string;
  name: string;
  monthlyPriceCents: number;
  currency: string;
  feeBps: number;
  /** True when nothing has been chosen and the default applies. */
  isDefault: boolean;
}

export async function getRestaurantPlan(
  restaurantId: string,
): Promise<RestaurantPlan | null> {
  const supabase = await createClient();

  const { data: assigned } = await supabase
    .from("restaurant_plans")
    .select("plan_id")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  const query = supabase
    .from("platform_plans")
    .select("slug, name, monthly_price_cents, currency, fee_bps, is_default");

  const { data: plan } = assigned
    ? await query.eq("id", assigned.plan_id).maybeSingle()
    : await query.eq("is_default", true).maybeSingle();

  if (!plan) return null;

  return {
    slug: plan.slug,
    name: plan.name,
    monthlyPriceCents: plan.monthly_price_cents,
    currency: plan.currency,
    feeBps: plan.fee_bps,
    isDefault: !assigned,
  };
}
