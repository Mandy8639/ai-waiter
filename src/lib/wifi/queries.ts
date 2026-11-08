import "server-only";
import { createClient } from "@/lib/supabase/server";
import { parseWifiRow, type GuestWifi } from "./core";

/** The Wi-Fi functions (20261201090000) postdate database.types.ts. */
async function call(fn: string, args?: Record<string, unknown>) {
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  const { data, error } = await rpc(fn, args);
  // Any error reads as "no Wi-Fi": a menu or a print sheet never breaks
  // over it (for instance in the minute between a deploy and its migration).
  if (error || !Array.isArray(data)) return null;
  return parseWifiRow(data[0]);
}

/** For the dashboard: settings and the printed table cards. */
export function getRestaurantWifiForStaff(
  restaurantId: string,
): Promise<GuestWifi | null> {
  return call("restaurant_wifi_for_staff", { p_restaurant_id: restaurantId });
}

/** For a guest seated at a table; null for anyone else. */
export function getRestaurantWifiForGuest(): Promise<GuestWifi | null> {
  return call("restaurant_wifi_for_guest");
}
