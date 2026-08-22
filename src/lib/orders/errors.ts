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
};

/** Prefixes whose full raised message (already customer-safe — see the migration) is shown as-is, not replaced. */
const PASSTHROUGH_PREFIXES = [
  "ORDER_ITEM_UNAVAILABLE",
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
