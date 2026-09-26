/**
 * What a kitchen station sees (phase I). Pure, so the routing rules are
 * unit-tested without a board or a database.
 *
 * The rules:
 *   1. A station sees the lines sent to it, plus every line with NO
 *      station. An unassigned dish shows everywhere, labelled, rather than
 *      nowhere: a forgotten assignment should cost a glance, not a meal.
 *   2. An order with nothing for this station is not on its screen.
 *   3. A station marks ITS part done; the order's status is the pass's
 *      call. So on a station screen the order-level "Mark ready" and
 *      "Served" steps, and split/merge, are not offered.
 *   4. Once this station's part is done, the order drops to the bottom of
 *      its column, where it can still be undone.
 */
import type {
  KitchenOrder,
  KitchenOrderItem,
  KitchenStation,
} from "@/lib/orders/kitchen";
import type { OrderStatus } from "@/lib/orders/status";

/** The order as this station should see it, or null when it has nothing here. */
export function viewForStation(
  order: KitchenOrder,
  stationId: string,
): KitchenOrder | null {
  const items = order.items.filter(
    (item) => item.stationId === stationId || item.stationId === null,
  );
  if (items.length === 0) return null;
  const groupIds = new Set(items.map((i) => i.ticketGroupId));
  return {
    ...order,
    items,
    ticketGroups: order.ticketGroups.filter((g) => groupIds.has(g.id)),
  };
}

/** Does this station have lines of its own in the order (not just unassigned ones)? */
export function hasOwnLines(order: KitchenOrder, stationId: string): boolean {
  return order.items.some((item) => item.stationId === stationId);
}

/** Orders for one station's screen: its own and unassigned lines only, finished ones last. */
export function ordersForStation(
  orders: KitchenOrder[],
  stationId: string,
): KitchenOrder[] {
  const visible = orders
    .map((o) => viewForStation(o, stationId))
    .filter((o): o is KitchenOrder => o !== null);
  const done = (o: KitchenOrder) => o.stationsDone.includes(stationId);
  // Stable: keeps the board's own order within each half.
  return [...visible.filter((o) => !done(o)), ...visible.filter(done)];
}

export interface StationProgress {
  id: string;
  name: string;
  done: boolean;
}

/** For the all-stations view: which stations this order needs, and which have finished. */
export function stationProgress(
  order: KitchenOrder,
  stations: KitchenStation[],
): StationProgress[] {
  const needed = new Set(
    order.items
      .map((i) => i.stationId)
      .filter((id): id is string => id !== null),
  );
  return stations
    .filter((s) => needed.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      done: order.stationsDone.includes(s.id),
    }));
}

/** Rule 3: order-level steps a station screen offers. */
export function stationMayTransition(target: OrderStatus): boolean {
  return target === "confirmed" || target === "preparing";
}

/** A station can mark its part done only once the order has been accepted. */
export function canMarkStationDone(status: OrderStatus): boolean {
  return status === "confirmed" || status === "preparing" || status === "ready";
}

export function unassignedLines(items: KitchenOrderItem[]): number {
  return items.filter((i) => i.stationId === null).length;
}
