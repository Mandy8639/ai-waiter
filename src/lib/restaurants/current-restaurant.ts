import "server-only";
import { cookies } from "next/headers";
import {
  getUserRestaurants,
  type UserRestaurant,
} from "./get-user-restaurants";

export const CURRENT_RESTAURANT_COOKIE = "current_restaurant_id";

export type CurrentRestaurantState =
  | { status: "none" } // user has zero restaurants — needs onboarding
  | { status: "selected"; restaurant: UserRestaurant; all: UserRestaurant[] }
  | { status: "needs-selection"; all: UserRestaurant[] }; // multiple restaurants, none chosen yet

/**
 * Determines which restaurant the dashboard should show for this request.
 *
 * The cookie is a UX convenience only — which restaurant to default to,
 * nothing more. It's re-validated against the user's real memberships on
 * every call (never trusted blindly): if it names a restaurant the user
 * doesn't actually belong to, it's treated as if nothing were selected.
 * RLS remains the actual authorization boundary regardless of this value.
 */
export async function getCurrentRestaurantState(
  userId: string,
): Promise<CurrentRestaurantState> {
  const all = await getUserRestaurants(userId);

  if (all.length === 0) {
    return { status: "none" };
  }
  if (all.length === 1) {
    return { status: "selected", restaurant: all[0], all };
  }

  const cookieStore = await cookies();
  const selectedId = cookieStore.get(CURRENT_RESTAURANT_COOKIE)?.value;
  const selected = all.find((r) => r.id === selectedId);

  if (!selected) {
    return { status: "needs-selection", all };
  }
  return { status: "selected", restaurant: selected, all };
}
