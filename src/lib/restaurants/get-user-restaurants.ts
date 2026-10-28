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
  /**
   * QR menu, AI waiter and kitchen only: no payments, POS, Settle up,
   * reservations or takings reports (20261125090000_basic_mode.sql). The
   * pages for those are hidden and closed (src/components/dashboard/nav-items.ts).
   */
  basicMode: boolean;
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
  // basic_mode postdates database.types.ts, so the rows are typed by hand
  // here (as in src/lib/customer/restaurant.ts) until the types are
  // regenerated. If the column isn't there yet (the app deployed before
  // its migration landed: 42703), every dashboard would fail to load, so
  // read without it and treat the restaurant as basic.
  type Row = {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    basic_mode?: boolean | null;
  };
  const select = async (columns: string) => {
    const result = await supabase
      .from("restaurants")
      .select(columns)
      .in("id", restaurantIds);
    return {
      data: result.data as unknown as Row[] | null,
      error: result.error,
    };
  };
  let { data: restaurants, error: restaurantsError } = await select(
    "id, name, slug, timezone, basic_mode",
  );
  if (restaurantsError?.code === "42703") {
    ({ data: restaurants, error: restaurantsError } = await select(
      "id, name, slug, timezone",
    ));
  }

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
      basicMode: r.basic_mode ?? true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
