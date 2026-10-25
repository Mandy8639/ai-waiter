import "server-only";
import { headers } from "next/headers";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";

/** Shared by the Square server actions and the OAuth callback route. */

export const STATE_COOKIE = "tableside_square_oauth";
export const SETTINGS_PATH = "/dashboard/settings/pos";

export async function currentOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto =
    h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Square allows one redirect URL per application, so the round trip has
 * to start and end on one host. SQUARE_REDIRECT_URI names it (registered
 * in the Square Developer Console); without it, the current host is used,
 * which is right for local development.
 */
export async function squareRedirectUri(): Promise<string> {
  return (
    process.env.SQUARE_REDIRECT_URI ?? `${await currentOrigin()}/api/pos/square/callback`
  );
}

/**
 * Owner or manager, checked twice: the membership row, and the database's
 * own is_restaurant_manager_or_owner(), which goes through
 * current_restaurant_role() and so also enforces two-step verification.
 * Both pass before anything reads the service-key token store.
 */
export async function authorizeSquare(restaurantId: string) {
  const auth = await authorizeRestaurantAction(restaurantId, ["owner", "manager"]);
  if (!auth.ok) return auth;
  const { data } = await auth.context.supabase.rpc("is_restaurant_manager_or_owner", {
    target_restaurant_id: restaurantId,
  });
  if (data !== true) {
    return {
      ok: false as const,
      error: "Finish two-step verification to manage the Square connection.",
    };
  }
  return auth;
}

