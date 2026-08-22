"use server";

import { requireUser } from "@/lib/auth/session";
import {
  getActiveOrdersForRestaurant,
  getOrderStatusHistory,
  type KitchenOrder,
  type OrderStatusHistoryEntry,
} from "./kitchen";

/**
 * Client-callable wrapper the kitchen board calls on every Realtime event
 * (and on reconnect) to resync to authoritative state — see
 * src/components/kitchen/kitchen-board.tsx. `restaurantId` is not a trust
 * boundary here: getActiveOrdersForRestaurant() runs through the
 * RLS-respecting client, so a mismatched id simply returns nothing (RLS
 * denies it), the same way every other restaurant-scoped read in this
 * codebase works.
 */
export async function fetchActiveOrders(
  restaurantId: string,
): Promise<KitchenOrder[]> {
  await requireUser();
  return getActiveOrdersForRestaurant(restaurantId);
}

/**
 * Client-callable wrapper for the detail panel's status-history fetch —
 * getOrderStatusHistory() itself is server-only. RLS
 * (order_status_history's own SELECT policy, unchanged since Batch 5)
 * still scopes this to orders the caller can actually see; requireUser()
 * here only produces a friendlier failure for a signed-out caller, the
 * same non-security-boundary role authorizeRestaurantAction() documents
 * for dashboard mutations.
 */
export async function fetchOrderStatusHistory(
  orderId: string,
): Promise<OrderStatusHistoryEntry[]> {
  await requireUser();
  return getOrderStatusHistory(orderId);
}
