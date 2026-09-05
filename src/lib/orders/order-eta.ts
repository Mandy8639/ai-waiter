import "server-only";
import { createClient } from "@/lib/supabase/server";
import { estimateOrderPrep, type PrepEstimate } from "./prep-estimate";
import type { OrderView } from "./queries";

/**
 * One place that answers "how long?", so the diner's screen and the AI
 * waiter cannot drift apart and tell them different things.
 *
 * The kitchen queue comes from get_kitchen_queue_ahead(), a SECURITY
 * DEFINER aggregate returning two integers — a diner cannot read other
 * tables' orders and must not be able to.
 */
export async function getOrderEta(order: OrderView): Promise<PrepEstimate> {
  const supabase = await createClient();
  const { data: queue } = await supabase
    .rpc("get_kitchen_queue_ahead", {
      target_restaurant_id: order.restaurantId,
      placed_before: order.createdAt,
    })
    .maybeSingle();

  return estimateOrderPrep({
    itemPrepMinutes: order.items.map((i) => i.prepMinutes),
    status: order.status,
    placedAt: order.createdAt,
    queueMinutesAhead: queue?.prep_minutes_ahead ?? 0,
    ordersAhead: queue?.orders_ahead ?? 0,
  });
}
