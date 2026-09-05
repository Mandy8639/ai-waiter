import type { OrderStatus } from "./status";

/**
 * How long an order takes, and how much of that is left.
 *
 * Pure and `server-only`-free so it is directly unit testable, like
 * order-confirmation.ts and menu-fact-detection.ts.
 *
 * Exists because a diner who has just ordered asks "how long?" every
 * single time, and the waiter had no way to answer: get_order_status
 * returned the status, the total and the items, and nothing about time.
 * Live, that produced the factuality guard's fallback — "I wasn't able to
 * pull that up from the menu just now" — and then, on a retry, an answer
 * about one drink's preparation time instead of the order's.
 */

export interface PrepEstimate {
  /** Minutes the whole order takes from placement, or null if unknown. */
  totalMinutes: number | null;
  /** Minutes still to wait, or null when unknown or no longer waiting. */
  minutesRemaining: number | null;
  /** True once the kitchen says it's ready or served — no estimate applies. */
  finished: boolean;
}

/**
 * MAX, not SUM.
 *
 * A kitchen cooks in parallel. A 3-minute lassi alongside a 15-minute
 * thali is a 15-minute order, not an 18-minute one, and summing would
 * make every large table look hours away. The longest dish gates the
 * plate going out.
 *
 * This is an underestimate for a kitchen with one cook and a queue, and
 * that is the right direction to be wrong in only because the prompt
 * requires the waiter to give it as an approximation that can run longer
 * when the kitchen is busy — never as a promise.
 */
export function estimateOrderPrep(params: {
  itemPrepMinutes: Array<number | null>;
  status: OrderStatus | string;
  placedAt: string;
  now?: Date;
}): PrepEstimate {
  const { itemPrepMinutes, status, placedAt } = params;
  const now = params.now ?? new Date();

  const finished =
    status === "ready" || status === "served" || status === "cancelled";

  const known = itemPrepMinutes.filter(
    (m): m is number => typeof m === "number" && Number.isFinite(m) && m > 0,
  );
  // No dish on the order has a recorded preparation time. Null, not zero:
  // "we don't know" and "it's instant" are different answers, and the
  // waiter must say the first rather than imply the second.
  const totalMinutes = known.length > 0 ? Math.max(...known) : null;

  if (finished || totalMinutes === null) {
    return { totalMinutes, minutesRemaining: null, finished };
  }

  const placed = new Date(placedAt).getTime();
  // An unparseable timestamp means we cannot say how long is left, but the
  // total is still true and worth returning.
  if (!Number.isFinite(placed)) {
    return { totalMinutes, minutesRemaining: null, finished };
  }

  const elapsedMinutes = (now.getTime() - placed) / 60_000;
  const remaining = totalMinutes - elapsedMinutes;
  // Clamped at zero rather than going negative: an order that has run over
  // is "any moment now", not "minus four minutes".
  return {
    totalMinutes,
    minutesRemaining: Math.max(0, Math.round(remaining)),
    finished,
  };
}
