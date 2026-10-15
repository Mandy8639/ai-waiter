/**
 * Kitchen busy mode, the part with no database in it: what the stored
 * values mean right now, the choices the kitchen is offered, and the
 * words diners and staff see. See
 * supabase/migrations/20261015090000_kitchen_busy_mode.sql. No
 * `server-only`, per the extract-the-core convention.
 */

export interface KitchenStatus {
  /** New orders are refused right now. */
  paused: boolean;
  /** Paused with no end time: lifts only when someone resumes. */
  pausedIndefinitely: boolean;
  /** When the pause lifts by itself, or null (not paused, or indefinite). */
  pausedUntil: Date | null;
  /** How many minutes longer food is taking; 0 when the kitchen is on time. */
  extraMinutes: number;
}

/** As get_kitchen_status() returns it. */
export interface KitchenStatusRow {
  orders_paused_until: string | null;
  busy_extra_minutes: number;
}

export const KITCHEN_ON_TIME: KitchenStatus = {
  paused: false,
  pausedIndefinitely: false,
  pausedUntil: null,
  extraMinutes: 0,
};

/**
 * From get_kitchen_status()'s row. The function already reads expired
 * values as off; the time is checked again here because a page can sit
 * open past the moment a pause ends.
 */
export function kitchenStatusFrom(
  row: KitchenStatusRow | null,
  now: Date = new Date(),
): KitchenStatus {
  if (!row) return KITCHEN_ON_TIME;
  const raw = row.orders_paused_until;
  // Postgres sends an endless pause as the text "infinity".
  const indefinite = raw === "infinity";
  const until = raw && !indefinite ? new Date(raw) : null;
  const timed = until !== null && until.getTime() > now.getTime();
  return {
    paused: indefinite || timed,
    pausedIndefinitely: indefinite,
    pausedUntil: timed ? until : null,
    extraMinutes: Math.max(0, row.busy_extra_minutes ?? 0),
  };
}

/** The pause lengths offered on the kitchen board; null is "until I resume". */
export const PAUSE_CHOICES: readonly (number | null)[] = [15, 30, 60, null];

/** "Running behind" amounts, each kept on for BUSY_FOR_MINUTES. */
export const BUSY_CHOICES: readonly number[] = [10, 20, 30];
export const BUSY_FOR_MINUTES = 60;

export function pauseChoiceLabel(minutes: number | null): string {
  if (minutes === null) return "Until I resume";
  if (minutes < 60) return `${minutes} min`;
  return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
}

/** Whole minutes until the pause lifts, at least 1, or null if it has no end. */
export function minutesLeft(status: KitchenStatus, now: Date = new Date()) {
  if (!status.pausedUntil) return null;
  return Math.max(
    1,
    Math.ceil((status.pausedUntil.getTime() - now.getTime()) / 60_000),
  );
}

/**
 * What a diner reads, on every page of the restaurant, or null when the
 * kitchen is on time. Minutes rather than a clock time: the diner's phone
 * may not be in the restaurant's time zone, and "about 20 minutes" needs
 * no zone at all.
 */
export function dinerNotice(
  status: KitchenStatus,
  now: Date = new Date(),
): string | null {
  if (status.paused) {
    const left = minutesLeft(status, now);
    return left === null
      ? "The kitchen has paused new orders for now. You can keep browsing the menu, and orders already placed are still being made."
      : `The kitchen has paused new orders for about ${left} more ${left === 1 ? "minute" : "minutes"}. You can keep browsing, and orders already placed are still being made.`;
  }
  if (status.extraMinutes > 0) {
    return `The kitchen is busy right now, so food is taking about ${status.extraMinutes} minutes longer than usual.`;
  }
  return null;
}
