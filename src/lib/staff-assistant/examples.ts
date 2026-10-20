import "server-only";
import { createClient } from "@/lib/supabase/server";
import { pickExampleDishes } from "./plan-core";

/**
 * A dish from this restaurant's menu for the Waiter's example buttons
 * ("86 the Chilli Baby Corn"), or null for an empty menu. Through RLS: the
 * signed-in staff member's own restaurant only.
 */
export async function getExampleDish(
  restaurantId: string,
): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("menu_items")
    .select("name")
    .eq("restaurant_id", restaurantId)
    .eq("is_available", true)
    .order("display_order", { ascending: true })
    .limit(40);
  return (
    pickExampleDishes(
      (data ?? []).map((d) => d.name),
      1,
    )[0] ?? null
  );
}
