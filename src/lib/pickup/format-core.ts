/**
 * Pickup times, as people at the restaurant read them.
 *
 * Always in the RESTAURANT's timezone, never the device's: a diner whose
 * phone is still on home time after a flight, and a server rendering in
 * UTC, must both see "12:30" for the slot the kitchen calls 12:30. No
 * `server-only` import, so the cart's client component and the unit tests
 * use the same functions.
 */

function parts(at: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const get = (type: string) =>
    fmt.formatToParts(at).find((p) => p.type === type)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/** "12:30", or "Tomorrow 00:15" when the slot falls on the restaurant's next day. */
export function formatPickupTime(
  at: string | Date,
  timeZone: string,
  now: Date = new Date(),
): string {
  const slot = parts(new Date(at), timeZone);
  const today = parts(now, timeZone);
  return slot.day === today.day ? slot.time : `Tomorrow ${slot.time}`;
}

/** The order's label wherever a table's name would go: "Pickup 12:30 · Priya". */
export function pickupLabel(
  at: string | Date,
  name: string,
  timeZone: string,
  now: Date = new Date(),
): string {
  return `Pickup ${formatPickupTime(at, timeZone, now)} · ${name}`;
}

export interface PickupSlot {
  at: string;
  placesLeft: number;
}

/** What get_pickup_options() returns, in this codebase's casing. */
export type PickupOptions =
  | { isCounter: false }
  | {
      isCounter: true;
      timeZone: string;
      chosenAt: string | null;
      chosenName: string | null;
      slots: PickupSlot[];
    };

export function parsePickupOptions(raw: unknown): PickupOptions {
  const r = (raw ?? {}) as {
    is_counter?: boolean;
    timezone?: string;
    chosen_at?: string | null;
    chosen_name?: string | null;
    slots?: { at: string; places_left: number }[];
  };
  if (!r.is_counter) return { isCounter: false };
  return {
    isCounter: true,
    timeZone: r.timezone ?? "UTC",
    chosenAt: r.chosen_at ? new Date(r.chosen_at).toISOString() : null,
    chosenName: r.chosen_name ?? null,
    slots: (r.slots ?? []).map((s) => ({
      // jsonb renders a timestamptz in the database's own format; one ISO
      // form here lets a slot be matched against the cart's choice.
      at: new Date(s.at).toISOString(),
      placesLeft: s.places_left,
    })),
  };
}
