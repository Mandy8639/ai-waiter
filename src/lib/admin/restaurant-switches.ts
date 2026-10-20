import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isRestaurantAiFeature,
  type RestaurantAiFeature,
} from "./restaurant-switches-core";

/**
 * Which AI features Tableside has switched off for a restaurant
 * (restaurant_ai_switches; a row = off). Read with the service role, as the
 * table is server-only, and kept for a minute per restaurant per server
 * instance, so a switch takes effect within a minute and a busy waiter
 * doesn't add a database read per message.
 *
 * A failed read counts as "nothing switched off" for 15 seconds: the
 * switch is a cost and abuse control, and an outage of the store must not
 * take every restaurant's AI down with it.
 */

const CACHE_MS = 60_000;
const ERROR_CACHE_MS = 15_000;

type Store = {
  from: (t: "restaurant_ai_switches") => {
    select: (c: string) => {
      eq: (
        c: string,
        v: string,
      ) => Promise<{ data: unknown[] | null; error: unknown }>;
    };
  };
};

const cache = new Map<
  string,
  { at: number; ttl: number; off: Set<RestaurantAiFeature> }
>();

export function clearRestaurantSwitchCache(restaurantId?: string): void {
  if (restaurantId) cache.delete(restaurantId);
  else cache.clear();
}

export async function getSwitchedOffFeatures(
  restaurantId: string,
): Promise<Set<RestaurantAiFeature>> {
  const hit = cache.get(restaurantId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.off;
  if (!process.env.SUPABASE_SECRET_KEY) return new Set();
  try {
    const store = createAdminClient() as unknown as Store;
    const { data, error } = await store
      .from("restaurant_ai_switches")
      .select("feature")
      .eq("restaurant_id", restaurantId);
    if (error) throw error;
    const off = new Set(
      (data as { feature: unknown }[])
        .map((r) => r.feature)
        .filter(isRestaurantAiFeature),
    );
    cache.set(restaurantId, { at: Date.now(), ttl: CACHE_MS, off });
    return off;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "restaurant_switch_read_failed",
        restaurantId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const off = new Set<RestaurantAiFeature>();
    cache.set(restaurantId, { at: Date.now(), ttl: ERROR_CACHE_MS, off });
    return off;
  }
}

/** True unless Tableside has switched this feature off for this restaurant. */
export async function isAiFeatureAllowed(
  restaurantId: string,
  feature: RestaurantAiFeature,
): Promise<boolean> {
  return !(await getSwitchedOffFeatures(restaurantId)).has(feature);
}
