import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { requireUser } from "@/lib/auth/session";
import {
  getCurrentRestaurantState,
  type CurrentRestaurantState,
} from "./current-restaurant";
import type { UserRestaurant } from "./get-user-restaurants";

/**
 * De-duplicated per request (React's cache()) — the dashboard layout and
 * whichever page is rendering alongside it both call this, but it only
 * hits the database once per request.
 */
export const getDashboardContext = cache(
  async (): Promise<{ user: User; state: CurrentRestaurantState }> => {
    const user = await requireUser();
    const state = await getCurrentRestaurantState(user.id);
    return { user, state };
  },
);

/**
 * For pages that need one definite, already-selected restaurant to scope
 * their queries to. Redirects (rather than erroring) if onboarding or
 * restaurant selection hasn't happened yet — the dashboard layout is what
 * actually renders those flows.
 */
export async function requireCurrentRestaurant(): Promise<{
  user: User;
  restaurant: UserRestaurant;
}> {
  const { user, state } = await getDashboardContext();

  if (state.status === "none") {
    redirect("/onboarding");
  }
  if (state.status === "needs-selection") {
    redirect("/dashboard");
  }

  return { user, restaurant: state.restaurant };
}
