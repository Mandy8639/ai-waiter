import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import type { RestaurantRole } from "./get-user-restaurants";

export interface AuthorizedContext {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  role: RestaurantRole;
}

export type AuthorizeResult =
  { ok: true; context: AuthorizedContext } | { ok: false; error: string };

/**
 * The step every mutation in this app runs before touching data:
 * authenticate -> confirm restaurant membership -> confirm role. This is
 * NOT the actual security boundary — RLS is (see docs/multi-tenancy.md) —
 * this exists so unauthorized attempts get a clear, specific message
 * ("you don't have permission") instead of a raw RLS-violation error
 * surfaced from Postgres. If this check were ever wrong or skipped, RLS
 * still blocks the write; this only improves the error the user sees.
 *
 * Returns the RLS-respecting per-request client (never the admin client)
 * so every subsequent query still goes through Row Level Security
 * regardless of what this function decided.
 */
export async function authorizeRestaurantAction(
  restaurantId: string,
  allowedRoles: RestaurantRole[],
): Promise<AuthorizeResult> {
  const user = await requireUser();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("restaurant_users")
    .select("role")
    .eq("restaurant_id", restaurantId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      error: "Could not verify your permissions. Please try again.",
    };
  }
  if (!data) {
    return { ok: false, error: "You don't have access to this restaurant." };
  }
  if (!allowedRoles.includes(data.role)) {
    return {
      ok: false,
      error: "You don't have permission to perform this action.",
    };
  }

  return { ok: true, context: { supabase, userId: user.id, role: data.role } };
}
