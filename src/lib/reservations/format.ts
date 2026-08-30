/**
 * `reservation_time` is stored as the wall-clock value staff typed,
 * treated as UTC (see schema.ts's reservationTimeSchema comment) — so it
 * must always be displayed back the same way, in UTC, never converted
 * through the viewer's own timezone (which would show a different time
 * than what was actually booked).
 */
export function formatReservationTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** For pre-filling a `<input type="datetime-local">` when editing — inverse of the schema's transform. */
export function toDatetimeLocalValue(isoString: string): string {
  return isoString.slice(0, 16);
}
