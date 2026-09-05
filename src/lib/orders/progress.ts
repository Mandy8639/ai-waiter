import type { OrderStatus } from "./status";

/**
 * The order's journey as a diner sees it.
 *
 * Pure and `server-only`-free so it is directly unit testable, like the
 * other decision logic in this folder.
 *
 * Deliberately NOT the same list as the kitchen's. Staff see and act on
 * every transition; a diner watching their phone wants to know one thing —
 * has the kitchen started, and is it nearly here. "Confirmed" is included
 * because on this platform it is the moment a human accepted the order,
 * which is the reassurance a customer is actually waiting for.
 */

export const CUSTOMER_PROGRESS_STEPS: Array<{
  status: OrderStatus;
  label: string;
}> = [
  { status: "pending", label: "Order received" },
  { status: "confirmed", label: "Accepted by the kitchen" },
  { status: "preparing", label: "Being cooked" },
  { status: "ready", label: "Ready" },
  { status: "served", label: "Served" },
];

export type ProgressState = "done" | "current" | "upcoming";

export interface ProgressStep {
  label: string;
  state: ProgressState;
}

/**
 * A cancelled order has no position on this line — it left it. Returning
 * an empty list is what lets the caller render something else entirely
 * rather than drawing a tracker with every step greyed out, which reads
 * like the food is still coming.
 */
export function orderProgress(status: OrderStatus | string): ProgressStep[] {
  if (status === "cancelled") return [];

  const currentIndex = CUSTOMER_PROGRESS_STEPS.findIndex(
    (s) => s.status === status,
  );
  // An unrecognised status is not a reason to invent progress. Showing
  // every step as upcoming says "nothing has happened yet", which is the
  // safe reading when we genuinely do not know.
  const index = currentIndex === -1 ? -1 : currentIndex;

  return CUSTOMER_PROGRESS_STEPS.map((step, i) => ({
    label: step.label,
    state: i < index ? "done" : i === index ? "current" : "upcoming",
  }));
}
