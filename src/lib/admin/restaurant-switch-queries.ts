import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isRestaurantAiFeature,
  type RestaurantAiFeature,
} from "./restaurant-switches-core";

/** Every restaurant, for the Restaurants card on /admin, with what Tableside has switched off. */

export interface AdminRestaurantRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  off: Partial<
    Record<RestaurantAiFeature, { reason: string | null; at: string }>
  >;
}

export interface SwitchHistoryRow {
  restaurantName: string;
  feature: RestaurantAiFeature;
  action: "on" | "off";
  reason: string | null;
  changedAt: string;
}

type Select = (c: string) => {
  order: (
    c: string,
    o: { ascending: boolean },
  ) => {
    limit: (n: number) => Promise<{ data: unknown[] | null; error: unknown }>;
  };
};
type Store = { from: (t: string) => { select: Select } };

/** At most this many, newest first; enough until there's a search box. */
const LIMIT = 300;

export async function listRestaurantsForAdmin(): Promise<
  AdminRestaurantRow[] | null
> {
  try {
    const store = createAdminClient() as unknown as Store;
    const [restaurants, switches] = await Promise.all([
      store
        .from("restaurants")
        .select("id, name, slug, is_active, created_at")
        .order("created_at", { ascending: false })
        .limit(LIMIT),
      store
        .from("restaurant_ai_switches")
        .select("restaurant_id, feature, reason, switched_off_at")
        .order("switched_off_at", { ascending: false })
        .limit(LIMIT * 3),
    ]);
    if (restaurants.error || switches.error) return null;
    const off = new Map<string, AdminRestaurantRow["off"]>();
    for (const s of switches.data as Array<{
      restaurant_id: string;
      feature: unknown;
      reason: string | null;
      switched_off_at: string;
    }>) {
      if (!isRestaurantAiFeature(s.feature)) continue;
      const entry = off.get(s.restaurant_id) ?? {};
      entry[s.feature] = { reason: s.reason, at: s.switched_off_at };
      off.set(s.restaurant_id, entry);
    }
    return (
      restaurants.data as Array<{
        id: string;
        name: string;
        slug: string;
        is_active: boolean;
        created_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      isActive: r.is_active,
      createdAt: r.created_at,
      off: off.get(r.id) ?? {},
    }));
  } catch {
    return null;
  }
}

export async function getSwitchHistory(
  names: Map<string, string>,
): Promise<SwitchHistoryRow[]> {
  try {
    const store = createAdminClient() as unknown as Store;
    const { data, error } = await store
      .from("restaurant_ai_switch_history")
      .select("restaurant_id, feature, action, reason, changed_at")
      .order("changed_at", { ascending: false })
      .limit(20);
    if (error || !data) return [];
    return (
      data as Array<{
        restaurant_id: string;
        feature: unknown;
        action: "on" | "off";
        reason: string | null;
        changed_at: string;
      }>
    ).flatMap((r) =>
      isRestaurantAiFeature(r.feature)
        ? [
            {
              restaurantName:
                names.get(r.restaurant_id) ?? "A deleted restaurant",
              feature: r.feature,
              action: r.action,
              reason: r.reason,
              changedAt: r.changed_at,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}
