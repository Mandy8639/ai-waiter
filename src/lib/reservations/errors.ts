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
