/**
 * submit_order() raises exceptions prefixed with a stable code (see
 * supabase/migrations/20260823100600_submit_order_function.sql) so this
 * layer can map them to a message safe to show a customer — never
 * error.message verbatim, which can include SQL/internal detail for
 * anything that doesn't match a known prefix.
 */
const PREFIXED_MESSAGES: Record<string, string> = {
  ORDER_NO_SESSION:
    "Your session has expired. Please scan the table's QR code again.",
  ORDER_RESTAURANT_UNAVAILABLE:
    "This restaurant isn't accepting orders right now. Please check with your server.",
  ORDER_CART_EMPTY: "Your cart is empty — add something before ordering.",
  // Kitchen busy mode (20261015090000_kitchen_busy_mode.sql).
  ORDER_PAUSED:
    "The kitchen has paused new orders for a little while. Your order is saved, so please try again in a few minutes.",
};

/** Prefixes whose full raised message (already customer-safe — see the migration) is shown as-is, not replaced. */
const PASSTHROUGH_PREFIXES = [
  "ORDER_ITEM_UNAVAILABLE",
  // Phase L: names the dish whose menu isn't on right now.
  "ORDER_ITEM_NOT_SERVED_NOW",
  "ORDER_MODIFIER_UNAVAILABLE",
  "ORDER_MODIFIER_INVALID",
  "ORDER_INVALID_INPUT",
];

export function parseOrderError(rawMessage: string): string {
  const match = /^([A-Z_]+):\s*(.*)$/.exec(rawMessage);
  if (!match) {
    return "Something went wrong placing your order. Please try again.";
  }
  const [, code, rest] = match;

  if (code in PREFIXED_MESSAGES) {
    return PREFIXED_MESSAGES[code];
  }
  if (PASSTHROUGH_PREFIXES.includes(code)) {
    return rest;
  }
  return "Something went wrong placing your order. Please try again.";
}

/**
 * transition_order_status() (Batch 6) raises its own prefixed codes — see
 * supabase/migrations/20260824090200_transition_order_status_function.sql.
 * Staff-facing, so the audience/tone differs from parseOrderError() above,
 * but the shape (stable prefix -> safe message, never raw error.message) is
 * the same.
 */
const TRANSITION_MESSAGES: Record<string, string> = {
  ORDER_TRANSITION_UNAUTHENTICATED: "Please sign in again.",
  ORDER_TRANSITION_INVALID_STATUS: "That's not a valid order status.",
  ORDER_TRANSITION_NOT_FOUND: "That order could not be found.",
};

/** These raised suffixes already name only role/status values — safe to show as-is. */
const TRANSITION_PASSTHROUGH_PREFIXES = [
  "ORDER_TRANSITION_FORBIDDEN",
  "ORDER_TRANSITION_INVALID_TRANSITION",
];

export function parseTransitionError(rawMessage: string): string {
  const match = /^([A-Z_]+):\s*(.*)$/.exec(rawMessage);
  if (!match) {
    return "Something went wrong updating that order. Please try again.";
  }
  const [, code, rest] = match;

  if (code in TRANSITION_MESSAGES) {
    return TRANSITION_MESSAGES[code];
  }
  if (TRANSITION_PASSTHROUGH_PREFIXES.includes(code)) {
    return rest;
  }
  return "Something went wrong updating that order. Please try again.";
}

/**
 * transition_ticket_group_status()/split_order_into_tickets()/
 * merge_orders_into_ticket() (see
 * supabase/migrations/20260829100000_order_ticket_groups.sql) — same
 * stable-prefix convention as parseTransitionError() above. Every code
 * maps to a canned message rather than passing raw detail through: unlike
 * ORDER_TRANSITION_FORBIDDEN's role/status text (already meant to be
 * shown), these raised messages carry item ids/counts that aren't good
 * user-facing copy.
 */
const TICKET_GROUP_MESSAGES: Record<string, string> = {
  TICKET_GROUP_UNAUTHENTICATED: "Please sign in again.",
  TICKET_GROUP_INVALID_STATUS: "That's not a valid ticket status.",
  TICKET_GROUP_NOT_FOUND: "That ticket could not be found.",
  TICKET_GROUP_FORBIDDEN: "You don't have permission to update this ticket.",
  TICKET_GROUP_INVALID_TRANSITION:
    "That ticket can't move to that status from where it is.",
  TICKET_SPLIT_UNAUTHENTICATED: "Please sign in again.",
  TICKET_SPLIT_ORDER_NOT_FOUND: "That order could not be found.",
  TICKET_SPLIT_FORBIDDEN: "You don't have permission to split this order.",
  TICKET_SPLIT_ORDER_FINALIZED:
    "This order is already served or cancelled and can't be split.",
  TICKET_SPLIT_NEEDS_TWO_GROUPS: "Split the order into at least two groups.",
  TICKET_SPLIT_ITEM_NOT_IN_ORDER:
    "One of the selected items isn't part of this order.",
  TICKET_SPLIT_INCOMPLETE_COVERAGE:
    "Every item on the order must be assigned to a group.",
  TICKET_MERGE_UNAUTHENTICATED: "Please sign in again.",
  TICKET_MERGE_NEEDS_TWO_ORDERS: "Select at least two orders to merge.",
  TICKET_MERGE_ORDER_NOT_FOUND: "One of those orders could not be found.",
  TICKET_MERGE_CROSS_RESTAURANT:
    "Orders from different restaurants can't be merged.",
  TICKET_MERGE_FORBIDDEN: "You don't have permission to merge these orders.",
  TICKET_MERGE_ORDER_FINALIZED:
    "An order is already served or cancelled and can't be merged.",
  TICKET_MERGE_STATUS_MISMATCH:
    "Orders can only be merged while they're all at the same status.",
  TICKET_MERGE_ALREADY_SPLIT:
    "An order that's already been split can't be merged — un-split it first.",
};

export function parseTicketGroupError(rawMessage: string): string {
  const match = /^([A-Z_]+):/.exec(rawMessage);
  if (!match) {
    return "Something went wrong. Please try again.";
  }
  return (
    TICKET_GROUP_MESSAGES[match[1]] ?? "Something went wrong. Please try again."
  );
}
