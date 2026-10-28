import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { requireUser } from "@/lib/auth/session";
import {
  getCurrentRestaurantState,
  type CurrentRestaurantState,
} from "./current-restaurant";
import type { UserRestaurant } from "./get-user-restaurants";
import {
  PATHNAME_HEADER,
  canOpenDashboardPath,
  dashboardHomeFor,
} from "@/lib/dashboard/access-core";

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
 *
 * Every dashboard page calls this, on every navigation (layouts don't
 * re-render between sibling pages; pages do), so it is also where a role
 * is turned away from a page that isn't theirs — the kitchen account from
 * Payments, say, or anyone from Settle up in a basic restaurant — and sent
 * to its own home instead. See
 * src/lib/dashboard/access-core.ts.
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

  const pathname = (await headers()).get(PATHNAME_HEADER);
  // No header means the request didn't come through the proxy (it always
  // sets it), so there's no path to judge; the database still decides
  // what data the role can reach.
  if (
    pathname &&
    !canOpenDashboardPath(
      state.restaurant.role,
      pathname,
      state.restaurant.basicMode,
    )
  ) {
    redirect(dashboardHomeFor(state.restaurant.role));
  }

  return { user, restaurant: state.restaurant };
}
