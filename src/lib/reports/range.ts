import { zonedWallClockToUtc } from "@/lib/reservations/timezone";

/**
 * Turning "today" into two absolute instants.
 *
 * The reporting functions take timestamptz bounds; a person asking for
 * today means today *where the restaurant is*. A London owner checking
 * takings at 00:30 must not be shown yesterday's figures because the
 * server happens to be on UTC, and an owner in New York must not see a day
 * that starts at 19:00 local.
 *
 * So the day boundary is computed in the restaurant's own zone and then
 * converted to instants with the same DST-aware helper reservations use.
 * Doing this in SQL would mean reimplementing that conversion in Postgres.
 *
 * No `server-only` import: this is pure date arithmetic and is worth
 * testing directly, following the codebase's extract-the-core convention.
 */

export const RANGE_PRESETS = ["today", "7d", "30d"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_LABELS: Record<RangePreset, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

export function isRangePreset(value: unknown): value is RangePreset {
  return (
    typeof value === "string" && RANGE_PRESETS.includes(value as RangePreset)
  );
}

/** The calendar date in a given zone, as YYYY-MM-DD. */
export function localDate(instant: Date, timeZone: string): string {
  // en-CA gives ISO-ordered parts, which is what we want to reassemble.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Shifts a YYYY-MM-DD by whole days without touching timezones. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  // UTC arithmetic on a date-only value: no zone is involved, so DST
  // cannot shift the result by an hour and roll it into the wrong day.
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

export interface ReportRange {
  /** Inclusive lower bound, as an absolute instant. */
  from: string;
  /** EXCLUSIVE upper bound — the reporting functions are half-open. */
  to: string;
  preset: RangePreset;
}

/**
 * Bounds for a preset, in the restaurant's zone.
 *
 * The upper bound is tomorrow's midnight rather than tonight's, so
 * payments taken later today are included: a range ending at "now" would
 * make the page change meaning depending on when it was loaded.
 */
export function rangeBounds(
  preset: RangePreset,
  timeZone: string,
  now: Date = new Date(),
): ReportRange {
  const today = localDate(now, timeZone);
  const startDate =
    preset === "today" ? today : shiftDate(today, preset === "7d" ? -6 : -29);

  const from = zonedWallClockToUtc(`${startDate}T00:00`, timeZone);
  const to = zonedWallClockToUtc(`${shiftDate(today, 1)}T00:00`, timeZone);

  // zonedWallClockToUtc only returns null for a malformed wall clock, and
  // these are built from formatted output — but falling back to the raw
  // instant is safer than asserting non-null and rendering nothing.
  return {
    from: from ?? new Date(0).toISOString(),
    to: to ?? now.toISOString(),
    preset,
  };
}
