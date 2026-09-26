"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

/**
 * "This visit opened this dish" (phase H). Called once when a dish page
 * mounts. record_dish_view() decides everything that matters — whether the
 * caller is a diner seated at this dish's restaurant, and whether this
 * visit has been counted already — and never raises. This returns nothing
 * and swallows everything: a diner must never see an analytics error.
 */
export async function recordDishView(menuItemId: string): Promise<void> {
  if (!z.uuid().safeParse(menuItemId).success) return;
  try {
    const supabase = await createClient();
    // database.types.ts predates 20260930090000.
    const rpc = supabase.rpc.bind(supabase) as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    await rpc("record_dish_view", { p_menu_item_id: menuItemId });
  } catch {
    // Counting is never worth an error.
  }
}
