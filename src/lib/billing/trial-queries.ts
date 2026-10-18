import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { BillingState, RestaurantBilling } from "./trial-core";

// database.types.ts predates 20261018120000, so the function is reached
// through an untyped handle (the same approach as src/lib/account/queries.ts).
type Rpc = (
  fn: string,
  args?: Record<string, unknown>,
) => {
  maybeSingle: () => Promise<{
    data: {
      state: BillingState;
      trial_ends_at: string | null;
      grace_ends_at: string | null;
    } | null;
    error: { message: string } | null;
  }>;
};

/**
 * The restaurant's billing state, for its own staff. A failed read shows
 * no banner rather than breaking the dashboard: the database, not this,
 * decides whether orders are taken.
 */
export async function getRestaurantBilling(
  restaurantId: string,
): Promise<RestaurantBilling | null> {
  const supabase = await createClient();
  const { data, error } = await (supabase.rpc.bind(supabase) as unknown as Rpc)(
    "get_restaurant_billing",
    { target_restaurant_id: restaurantId },
  ).maybeSingle();
  if (error || !data) return null;
  return {
    state: data.state,
    trialEndsAt: data.trial_ends_at ? new Date(data.trial_ends_at) : null,
    graceEndsAt: data.grace_ends_at ? new Date(data.grace_ends_at) : null,
  };
}
