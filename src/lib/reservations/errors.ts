/**
 * create_reservation()/update_reservation_details()/
 * transition_reservation_status() (see
 * supabase/migrations/20260829110000_reservations.sql) raise specific,
 * deliberately-worded exceptions as `CODE: detail` — mapped here by code
 * to a canned, user-facing message, mirroring
 * src/lib/orders/errors.ts's parseTicketGroupError() exactly.
 */
const RESERVATION_MESSAGES: Record<string, string> = {
  RESERVATION_UNAUTHENTICATED: "Please sign in again.",
  RESERVATION_FORBIDDEN:
    "You don't have permission to manage reservations for this restaurant.",
  RESERVATION_NOT_FOUND: "That reservation could not be found.",
  RESERVATION_TABLE_NOT_FOUND: "That table could not be found.",
  RESERVATION_INVALID_NAME: "Enter the customer's name.",
  RESERVATION_INVALID_PHONE: "Enter the customer's phone number.",
  RESERVATION_INVALID_PARTY_SIZE: "Party size must be at least 1.",
  RESERVATION_INVALID_TIME: "Choose a reservation date and time.",
  RESERVATION_TABLE_CONFLICT:
    "That table already has a reservation within 90 minutes of this time.",
  RESERVATION_INVALID_STATUS: "That's not a valid reservation status.",
  RESERVATION_INVALID_TRANSITION:
    "That reservation can't move to that status from where it is.",

  // request_reservation()/confirm_reservation_request(), from
  // 20260902190000_customer_reservation_requests.sql. The first five are
  // read by a diner rather than by staff, so they say what to do next
  // instead of naming a rule.
  RESERVATION_RESTAURANT_NOT_FOUND: "We couldn't find that restaurant.",
  RESERVATION_TIME_IN_PAST: "Choose a time in the future.",
  RESERVATION_TIME_TOO_FAR: "Choose a date within the next year.",
  RESERVATION_PARTY_TOO_LARGE:
    "That's a large party — please call the restaurant so they can plan for you.",
  RESERVATION_TOO_MANY_REQUESTS:
    "You've sent several booking requests already. Please call the restaurant instead.",
  RESERVATION_NOT_PENDING:
    "That request has already been dealt with. Reload to see where it stands.",
};

export function parseReservationError(rawMessage: string): string {
  const match = /^([A-Z_]+):/.exec(rawMessage);
  if (!match) {
    return "Something went wrong. Please try again.";
  }
  return (
    RESERVATION_MESSAGES[match[1]] ?? "Something went wrong. Please try again."
  );
}
