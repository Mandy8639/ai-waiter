import type { KitchenOrder } from "@/lib/orders/kitchen";

/**
 * An accepted pickup order whose cooking time hasn't come yet.
 *
 * Only `confirmed` counts. A `pending` one still needs someone to accept
 * it, so it stays where the chime is pointing; once cooking has begun the
 * start time no longer matters.
 */
export function startsLater(order: KitchenOrder, now: number): boolean {
  return (
    order.status === "confirmed" &&
    order.pickup !== null &&
    new Date(order.pickup.startAt).getTime() > now
  );
}

/**
 * One board column's running order: everything due now keeps its place
 * (oldest first, as the board has always shown it), then the pickup orders
 * that start later, soonest start first. The cook reads down the column
 * and reaches tonight's 18:00 pickup only after the work that is due.
 */
export function orderColumn(
  orders: KitchenOrder[],
  now: number,
): KitchenOrder[] {
  const due = orders.filter((o) => !startsLater(o, now));
  const later = orders
    .filter((o) => startsLater(o, now))
    .sort(
      (a, b) =>
        new Date(a.pickup!.startAt).getTime() -
        new Date(b.pickup!.startAt).getTime(),
    );
  return [...due, ...later];
}
