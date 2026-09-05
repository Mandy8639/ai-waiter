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
  /** Soonest it could be ready, if the kitchen starts it now. Null if unknown. */
  minutesRemaining: number | null;
  /**
   * Latest it could be ready, if the kitchen works through everything
   * ahead of it first. Equal to minutesRemaining when nothing is queued.
   */
  minutesRemainingAtWorst: number | null;
  /** Active orders placed before this one. 0 when the kitchen is clear. */
  ordersAhead: number;
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
  /** Combined preparation minutes of active orders placed earlier. */
  queueMinutesAhead?: number;
  /** How many those were, for wording rather than arithmetic. */
  ordersAhead?: number;
  now?: Date;
}): PrepEstimate {
  const { itemPrepMinutes, status, placedAt } = params;
  const queueMinutesAhead = Math.max(0, params.queueMinutesAhead ?? 0);
  const ordersAhead = Math.max(0, params.ordersAhead ?? 0);
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
    return {
      totalMinutes,
      minutesRemaining: null,
      minutesRemainingAtWorst: null,
      ordersAhead,
      finished,
    };
  }

  const placed = new Date(placedAt).getTime();
  // An unparseable timestamp means we cannot say how long is left, but the
  // total is still true and worth returning.
  if (!Number.isFinite(placed)) {
    return {
      totalMinutes,
      minutesRemaining: null,
      minutesRemainingAtWorst: null,
      ordersAhead,
      finished,
    };
  }

  const elapsedMinutes = (now.getTime() - placed) / 60_000;
  const remaining = totalMinutes - elapsedMinutes;
  // Clamped at zero rather than going negative: an order that has run over
  // is "any moment now", not "minus four minutes".
  const soonest = Math.max(0, Math.round(remaining));

  // A RANGE, because the truth is between two things we can each state
  // plainly, and a single number would have to invent the bit in between.
  //
  //   soonest — the kitchen picks this order up now.
  //   latest  — the kitchen finishes everything ahead of it first.
  //
  // A real kitchen runs several dishes at once, so it lands between the
  // two. The alternative was a "how parallel is this kitchen" constant,
  // which is a number nobody can measure and everybody would have to
  // tune per restaurant. Two honest bounds beat one invented middle.
  //
  // Queue time is NOT reduced by elapsed time: the orders ahead are being
  // cooked during the same minutes, so their work does not shrink just
  // because this order has been waiting.
  const latest = Math.max(soonest, Math.round(soonest + queueMinutesAhead));

  return {
    totalMinutes,
    minutesRemaining: soonest,
    minutesRemainingAtWorst: latest,
    ordersAhead,
    finished,
  };
}

/**
 * The estimate as a sentence, or null when there is nothing honest to say.
 *
 * Null rather than a cheerful placeholder: a diner told "about 20 minutes"
 * by a kitchen that never recorded a time has been given a number the
 * restaurant never stood behind.
 */
export function etaSentence(estimate: PrepEstimate): string | null {
  if (estimate.finished || estimate.totalMinutes === null) return null;
  const { minutesRemaining: soonest, minutesRemainingAtWorst: latest } =
    estimate;
  if (soonest === null || latest === null) return null;
  if (soonest === 0 && latest === 0) return "Should be any moment now.";
  if (soonest === latest) return `About ${soonest} more minutes.`;
  return `About ${soonest}–${latest} more minutes.`;
}
