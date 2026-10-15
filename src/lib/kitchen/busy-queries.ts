import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  kitchenStatusFrom,
  type KitchenStatus,
  type KitchenStatusRow,
} from "./busy-core";

/**
 * The kitchen's busy mode as anyone may see it, staff or diner: through
 * get_kitchen_status(), which returns only whether new orders are paused
 * and how much longer food is taking. A failed read counts as "on time"
 * rather than breaking the page: submit_order() still refuses orders
 * during a pause, whatever a page showed.
 */
export async function getKitchenStatus(
  restaurantId: string,
): Promise<KitchenStatus> {
  return kitchenStatusFrom(await getKitchenStatusRow(restaurantId));
}

/**
 * The raw row, for a client component that re-reads it against its own
 * clock (a pause can end while the page is open). Plain strings cross
 * the server/client boundary where a Date might not.
 */
export async function getKitchenStatusRow(
  restaurantId: string,
): Promise<KitchenStatusRow | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .rpc("get_kitchen_status", { target_restaurant_id: restaurantId })
    .maybeSingle();
  return data ?? null;
}
