import "server-only";
import { createClient } from "@/lib/supabase/server";
import { specialHoursNotice, toPublicMenus, type PublicMenu } from "./core";

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * A restaurant's published menus (phase L): which are on right now — the
 * database decides, in the restaurant's timezone — their hours and their
 * sections.
 *
 * Null means the lookup failed. Callers pass that to onNowFilter, which
 * then shows everything rather than hiding the whole menu over a hiccup —
 * ordering is enforced in the database regardless.
 */
export async function getPublicMenus(
  restaurantId: string,
  client?: Client,
): Promise<PublicMenu[] | null> {
  const supabase = client ?? (await createClient());
  // database.types.ts predates 20261004090000.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  const { data, error } = await rpc("get_public_menus", {
    target_restaurant_id: restaurantId,
  });
  return error ? null : toPublicMenus(data);
}

/**
 * Today's holiday or special hours as a sentence for diners — "Closed
 * today (Thanksgiving)." — or null. A failed read shows nothing: ordering
 * is refused in the database on a closed day whatever a page said.
 */
export async function getSpecialHoursNotice(
  restaurantId: string,
): Promise<string | null> {
  const supabase = await createClient();
  // database.types.ts predates 20261019090000.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  const { data, error } = await rpc("get_special_hours_today", {
    target_restaurant_id: restaurantId,
  });
  return error ? null : specialHoursNotice(data);
}
