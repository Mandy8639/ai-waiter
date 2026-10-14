import { STATUS_LABELS, type OrderStatus } from "@/lib/orders/status";

/**
 * Undo on the kitchen board: a status tap waits this long before it is
 * sent, with an Undo button on screen. A busy pass mis-taps ("Ready" on
 * the wrong ticket), and the status machine only moves forward, so the
 * one moment a tap can be taken back is before it leaves the tablet.
 *
 * Long enough to notice the wrong ticket moved; short enough that the
 * floor isn't kept waiting for "ready".
 */
export const UNDO_WINDOW_MS = 5_000;

/**
 * Cancelling already asks "are you sure?" in its own dialog, so it goes
 * straight through; every forward move gets the undo window.
 */
export function offersUndo(target: OrderStatus): boolean {
  return target !== "cancelled";
}

export function undoMessage(
  orderNumber: number | undefined,
  target: OrderStatus,
) {
  const order = orderNumber === undefined ? "Order" : `Order #${orderNumber}`;
  return `${order} → ${STATUS_LABELS[target]}`;
}
