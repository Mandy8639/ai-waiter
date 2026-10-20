/**
 * What a diner is told when cancelling their own order doesn't go
 * through, from customer_cancel_order()'s error codes
 * (supabase/migrations/20261104090000_customer_cancel_order.sql).
 *
 * No `server-only`, so it is unit-tested directly.
 */
export function customerCancelMessage(error: string): string {
  if (error.includes("ORDER_CANCEL_TOO_LATE")) {
    return "The kitchen has already accepted your order, so it can't be cancelled here. Please ask a member of staff.";
  }
  if (error.includes("ORDER_CANCEL_ALREADY")) {
    return "This order is already cancelled.";
  }
  if (error.includes("ORDER_CANCEL_PAID")) {
    return "This order has been paid by card, so a member of staff needs to cancel it and refund you. Please ask them.";
  }
  if (error.includes("ORDER_IN_SPLIT")) {
    return "This order is part of a bill being split. Cancel the split first, or ask a member of staff.";
  }
  if (error.includes("ORDER_CANCEL_NOT_FOUND")) {
    return "That order wasn't found.";
  }
  return "Couldn't cancel the order just now. Please try again, or ask a member of staff.";
}

/** Whether the order page should offer Cancel / Change at all. */
export function canCustomerCancel(input: {
  status: string;
  paid: boolean;
}): boolean {
  return input.status === "pending" && !input.paid;
}
