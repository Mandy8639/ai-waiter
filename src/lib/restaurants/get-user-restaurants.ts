import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

export type RestaurantRole =
  Database["public"]["Tables"]["restaurant_users"]["Row"]["role"];

export interface UserRestaurant {
  id: string;
  name: string;
  slug: string;
  /** IANA zone from restaurants.timezone — anything rendering a time for staff must format through it, never the viewer's own zone. */
  timezone: string;
  role: RestaurantRole;
}

/**
 * Restaurants the given user belongs to, with their role in each. Runs
 * through the per-request (RLS-respecting) client — a user only ever sees
 * their own memberships, so `userId` here is a filter, not an
 * authorization decision.
 */
export async function getUserRestaurants(
  userId: string,
): Promise<UserRestaurant[]> {
  const supabase = await createClient();

  const { data: memberships, error: membershipError } = await supabase
    .from("restaurant_users")
    .select("restaurant_id, role")
    .eq("user_id", userId);

  if (membershipError) {
    throw new Error(
      `Failed to load restaurant memberships: ${membershipError.message}`,
    );
  }
  if (!memberships || memberships.length === 0) {
    return [];
  }

  const restaurantIds = memberships.map((m) => m.restaurant_id);
  const { data: restaurants, error: restaurantsError } = await supabase
    .from("restaurants")
    .select("id, name, slug, timezone")
    .in("id", restaurantIds);

  if (restaurantsError) {
    throw new Error(`Failed to load restaurants: ${restaurantsError.message}`);
  }

  const roleByRestaurantId = new Map(
    memberships.map((m) => [m.restaurant_id, m.role]),
  );

  return (restaurants ?? [])
    .map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      timezone: r.timezone,
      role: roleByRestaurantId.get(r.id) ?? "staff",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
