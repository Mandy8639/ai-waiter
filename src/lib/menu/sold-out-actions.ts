"use server";

import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { reportError } from "@/lib/observability/report";

/**
 * The kitchen's sold-out switches: a dish, or one add-on, off the menu and
 * back. Each calls a database function that changes is_available and
 * nothing else, and allows owner, manager or kitchen — see
 * supabase/migrations/20261013120000_kitchen_sold_out.sql. The role check
 * here only saves a round trip; the function is the rule.
 */

export interface SoldOutResult {
  error?: string;
  /** For "sold out until tomorrow": when it comes back (ISO). */
  backAt?: string;
}

const KITCHEN_SIDE = ["owner", "manager", "kitchen"] as const;

function done(): SoldOutResult {
  revalidatePath("/dashboard/kitchen/sold-out");
  revalidatePath("/dashboard/menu");
  revalidatePath("/dashboard/modifiers");
  return {};
}

export async function setDishAvailability(
  restaurantId: string,
  menuItemId: string,
  available: boolean,
): Promise<SoldOutResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [...KITCHEN_SIDE]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.context.supabase.rpc(
    "set_menu_item_availability",
    { p_menu_item_id: menuItemId, p_available: available },
  );
  if (error) {
    reportError(error, {
      scope: "menu.sold_out.dish",
      extra: { menuItemId, available },
    });
    return { error: "Couldn't change that dish. Please try again." };
  }
  return done();
}

/**
 * Sold out until the restaurant's next opening, when it comes back by
 * itself — see supabase/migrations/20261019090000_service_features.sql.
 */
export async function setDishSoldOutUntilTomorrow(
  restaurantId: string,
  menuItemId: string,
): Promise<SoldOutResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [...KITCHEN_SIDE]);
  if (!auth.ok) return { error: auth.error };

  // database.types.ts predates 20261019090000.
  const db = auth.context.supabase as unknown as {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const { data, error } = await db.rpc(
    "set_menu_item_sold_out_until_next_opening",
    { p_menu_item_id: menuItemId },
  );
  if (error || typeof data !== "string") {
    reportError(error ?? new Error("no return time"), {
      scope: "menu.sold_out.dish_until_tomorrow",
      extra: { menuItemId },
    });
    return { error: "Couldn't change that dish. Please try again." };
  }
  return { ...done(), backAt: new Date(data).toISOString() };
}

export async function setOptionAvailability(
  restaurantId: string,
  optionId: string,
  available: boolean,
): Promise<SoldOutResult> {
  const auth = await authorizeRestaurantAction(restaurantId, [...KITCHEN_SIDE]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.context.supabase.rpc(
    "set_modifier_option_availability",
    { p_option_id: optionId, p_available: available },
  );
  if (error) {
    reportError(error, {
      scope: "menu.sold_out.option",
      extra: { optionId, available },
    });
    return { error: "Couldn't change that option. Please try again." };
  }
  return done();
}
