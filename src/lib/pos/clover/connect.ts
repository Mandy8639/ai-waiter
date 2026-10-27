import "server-only";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { currentOrigin } from "../square/connect";

/** Shared by the Clover server actions and the OAuth callback route. */

export const CLOVER_STATE_COOKIE = "tableside_clover_oauth";
export const CLOVER_COOKIE_PATH = "/api/pos/clover";

/**
 * Clover sends the owner back to the app's Site URL domain, so the round
 * trip starts and ends on one host. CLOVER_REDIRECT_URI names it; without
 * it, the current host is used.
 */
export async function cloverRedirectUri(): Promise<string> {
  return (
    process.env.CLOVER_REDIRECT_URI ??
    `${await currentOrigin()}/api/pos/clover/callback`
  );
}

/**
 * Owner or manager, checked twice, as for Square: the membership row, and
 * the database's own is_restaurant_manager_or_owner() (two-step
 * verification included). Both pass before the token store is touched.
 */
export async function authorizeClover(restaurantId: string) {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return auth;
  const { data } = await auth.context.supabase.rpc(
    "is_restaurant_manager_or_owner",
    { target_restaurant_id: restaurantId },
  );
  if (data !== true) {
    return {
      ok: false as const,
      error: "Finish two-step verification to manage the Clover connection.",
    };
  }
  return auth;
}
