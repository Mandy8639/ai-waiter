/**
 * Confirmation gate for cancel_order, the same shape as submit_order's
 * (order-confirmation.ts): the model must have shown the customer which
 * order it would cancel (request_order_cancellation) in an EARLIER turn,
 * and the customer must have answered in a new message since. A model
 * reading "cancel" into "can I see the menu?" can't cancel a real order.
 *
 * No `server-only`, so it is unit-tested directly.
 */

export interface PendingCancellation {
  orderId: string;
  /** When the request_order_cancellation call was logged. */
  requestedAt: string;
}

export function parsePendingCancellation(
  row: { content: string; createdAt: string } | null,
): PendingCancellation | null {
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.content) as { data?: { orderId?: unknown } };
    const orderId = parsed.data?.orderId;
    return typeof orderId === "string"
      ? { orderId, requestedAt: row.createdAt }
      : null;
  } catch {
    return null;
  }
}

export function checkCancelConfirmation(params: {
  pending: PendingCancellation | null;
  /** The order cancel_order would act on now: the session's latest. */
  currentOrderId: string | null;
  currentTurnUserMessageAt: string | null;
}): { confirmed: boolean; reason?: string } {
  const { pending, currentOrderId, currentTurnUserMessageAt } = params;
  if (!currentOrderId) {
    return { confirmed: false, reason: "There's no order to cancel." };
  }
  if (
    !pending ||
    !currentTurnUserMessageAt ||
    !(
      new Date(pending.requestedAt).getTime() <
      new Date(currentTurnUserMessageAt).getTime()
    )
  ) {
    return {
      confirmed: false,
      reason:
        "I need you to confirm which order to cancel in a separate message first.",
    };
  }
  if (pending.orderId !== currentOrderId) {
    return {
      confirmed: false,
      reason:
        "A newer order has been placed since — let me check which one you mean first.",
    };
  }
  return { confirmed: true };
}
