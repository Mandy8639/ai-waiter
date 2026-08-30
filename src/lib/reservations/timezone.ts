/**
 * Reservation times are wall-clock values in the restaurant's own
 * timezone ("book table 4 for 7pm"), but `reservations.reservation_time`
 * is a `timestamptz` — a real instant. These two functions are the
 * boundary between those worlds, and the only place the conversion
 * happens.
 *
 * Why this matters beyond display: the 90-minute double-booking check in
 * create_reservation() compares real instants. Storing a wall-clock value
 * as if it were UTC is self-consistent (everything shifts by the same
 * offset, so conflicts still resolve correctly against each other) right
 * up until two restaurants sit in different zones, or a reservation is
 * compared against actual clock time — at which point it is silently
 * wrong. Hence: convert on the way in, format on the way out, never
 * store a naive value.
 *
 * Deliberately dependency-free (Intl, which ships with Node and every
 * browser) rather than pulling in a date library for two functions.
 * No `server-only` import: these are pure, so they stay unit-testable —
 * see tests/unit/reservation-timezone.test.ts and the convention in
 * docs/development.md.
 */

/** Accepts what `<input type="datetime-local">` produces, with or without seconds. */
export const WALL_CLOCK_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * `restaurants.timezone` is free text (see src/lib/settings/schema.ts), so
 * it can hold something Intl rejects. Falling back to UTC keeps the
 * reservations page rendering instead of throwing a RangeError at the
 * whole route — a wrong-looking time is recoverable, a crashed page is not.
 */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** How far `timeZone` is from UTC at a specific instant (DST-aware). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const field: Record<string, string> = {};
  for (const { type, value } of parts) field[type] = value;

  // Some ICU versions render midnight as hour "24" under hour12:false.
  const hour = field.hour === "24" ? 0 : Number(field.hour);

  const asIfUtc = Date.UTC(
    Number(field.year),
    Number(field.month) - 1,
    Number(field.day),
    hour,
    Number(field.minute),
    Number(field.second),
  );
  return asIfUtc - instant.getTime();
}

/**
 * "2027-03-01T19:00" typed by staff in a restaurant on America/New_York
 * becomes the ISO instant 2027-03-02T00:00:00.000Z.
 *
 * Two passes, because the offset itself depends on the instant: the first
 * guess uses the offset at the provisional time, then re-derives it at the
 * corrected time so a value on a DST changeover day lands correctly.
 *
 * DST edge cases resolve deterministically rather than erroring: a time in
 * the spring-forward gap (which never happens) snaps to a real adjacent
 * instant, and an ambiguous fall-back time picks one of its two
 * occurrences. Both are acceptable for booking a table; neither should
 * throw at a member of staff.
 *
 * Returns null if the wall-clock string is malformed, so callers surface a
 * field error rather than storing something wrong.
 */
export function zonedWallClockToUtc(
  wallClock: string,
  timeZone: string,
): string | null {
  if (!WALL_CLOCK_PATTERN.test(wallClock)) return null;

  const zone = resolveTimeZone(timeZone);
  const withSeconds = wallClock.length === 16 ? `${wallClock}:00` : wallClock;
  const provisional = new Date(`${withSeconds}Z`);
  if (Number.isNaN(provisional.getTime())) return null;

  const firstOffset = zoneOffsetMs(provisional, zone);
  let instant = new Date(provisional.getTime() - firstOffset);

  const secondOffset = zoneOffsetMs(instant, zone);
  if (secondOffset !== firstOffset) {
    instant = new Date(provisional.getTime() - secondOffset);
  }

  return instant.toISOString();
}

/**
 * The inverse, for display: a stored instant rendered as the wall-clock
 * time staff would recognise, in the restaurant's zone, with the zone
 * abbreviation so there is no ambiguity about which clock is meant.
 */
export function formatReservationTime(
  isoString: string,
  timeZone: string,
): string {
  const instant = new Date(isoString);
  if (Number.isNaN(instant.getTime())) return "—";

  return instant.toLocaleString("en-US", {
    timeZone: resolveTimeZone(timeZone),
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
