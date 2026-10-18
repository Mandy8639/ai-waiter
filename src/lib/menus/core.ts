/**
 * Multiple menus (phase L), the parts with no database: which sections are
 * on right now, and opening hours as words. Pure, so it is unit-tested.
 * Whether a menu is on is decided by the database (menu_on_now(), in the
 * restaurant's own timezone); this only reads its answer.
 */

export interface MenuHoursWindow {
  /** 0 = Sunday ... 6 = Saturday. */
  day: number;
  /** "11:00" */
  opens: string;
  /** "15:00", or "24:00" for end of day. */
  closes: string;
}

export interface PublicMenu {
  id: string;
  name: string;
  sort: number;
  onNow: boolean;
  hours: MenuHoursWindow[];
  categoryIds: string[];
}

/**
 * get_public_menus() rows, typed — without menus that have no (active)
 * sections. An empty menu serves nothing, so naming it to a diner ("Menu:
 * Always") would contradict "nothing is being served right now".
 */
export function toPublicMenus(data: unknown): PublicMenu[] {
  if (!Array.isArray(data)) return [];
  return parseMenus(data).filter((m) => m.categoryIds.length > 0);
}

function parseMenus(data: unknown[]): PublicMenu[] {
  return data
    .map((r) => r as Record<string, unknown>)
    .map((r) => ({
      id: String(r.public_menu_id),
      name: String(r.public_menu_name),
      sort: Number(r.public_menu_sort ?? 0),
      onNow: r.public_menu_on_now === true,
      hours: Array.isArray(r.public_menu_hours)
        ? (r.public_menu_hours as MenuHoursWindow[])
        : [],
      categoryIds: Array.isArray(r.public_menu_category_ids)
        ? (r.public_menu_category_ids as string[]).map(String)
        : [],
    }));
}

/** Every section that is on a menu that's on right now. */
export function categoriesOnNow(menus: PublicMenu[]): Set<string> {
  return new Set(menus.filter((m) => m.onNow).flatMap((m) => m.categoryIds));
}

/**
 * The sections to show right now, or null for "show everything" — only
 * when the lookup itself failed (getPublicMenus returned null). A failed
 * lookup must not empty the menu; ordering is enforced in the database
 * either way. An empty list is not a failure: it means nothing is on.
 */
export function onNowFilter(menus: PublicMenu[] | null): Set<string> | null {
  return menus === null ? null : categoriesOnNow(menus);
}

/** The published menus a section is on — for "served at Dinner, 17:00–22:00". */
export function menusForCategory(
  menus: PublicMenu[],
  categoryId: string,
): PublicMenu[] {
  return menus.filter((m) => m.categoryIds.includes(categoryId));
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayRange(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "Daily";
  // Runs of consecutive days ("Mon–Fri"); Monday-first reads naturally.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const present = order.filter((d) => sorted.includes(d));
  const runs: number[][] = [];
  for (const d of present) {
    const last = runs.at(-1);
    if (last && order.indexOf(d) === order.indexOf(last.at(-1)!) + 1) {
      last.push(d);
    } else {
      runs.push([d]);
    }
  }
  return runs
    .map((run) =>
      run.length >= 3
        ? `${DAY_SHORT[run[0]]}–${DAY_SHORT[run.at(-1)!]}`
        : run.map((d) => DAY_SHORT[d]).join(", "),
    )
    .join(", ");
}

/**
 * "Mon–Fri 11:00–15:00 · Sat, Sun 12:00–16:00", or "Always" for a menu
 * with no hours. Days sharing the same window are grouped.
 */
export function hoursLabel(hours: MenuHoursWindow[]): string {
  if (hours.length === 0) return "Always";
  const byWindow = new Map<string, number[]>();
  for (const h of hours) {
    const closes = h.closes === "00:00" ? "24:00" : h.closes;
    const key = `${h.opens}–${closes}`;
    byWindow.set(key, [...(byWindow.get(key) ?? []), h.day]);
  }
  return [...byWindow.entries()]
    .map(([window, days]) => `${dayRange(days)} ${window}`)
    .join(" · ");
}

/** "Lunch (Mon–Fri 11:00–15:00)" for each menu a dish is on. */
export function servedWhen(menus: PublicMenu[]): string {
  return menus.map((m) => `${m.name} (${hoursLabel(m.hours)})`).join(" or ");
}

// Editing hours -----------------------------------------------------------------

/** How the owner edits hours: one window, many days. Stored as one row per day. */
export interface HoursRule {
  days: number[];
  opens: string;
  closes: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/** Group stored rows back into rules: days sharing a window become one rule. */
export function rulesFromHours(hours: MenuHoursWindow[]): HoursRule[] {
  const byWindow = new Map<string, HoursRule>();
  for (const h of hours) {
    const key = `${h.opens}-${h.closes}`;
    const rule = byWindow.get(key) ?? {
      days: [],
      opens: h.opens,
      closes: h.closes,
    };
    if (!rule.days.includes(h.day)) rule.days.push(h.day);
    byWindow.set(key, rule);
  }
  return [...byWindow.values()].map((r) => ({
    ...r,
    days: r.days.sort((a, b) => a - b),
  }));
}

export type HoursCheck =
  { ok: true; rows: MenuHoursWindow[] } | { ok: false; error: string };

/**
 * Turn rules into rows, refusing anything the database would: a window
 * that closes before it opens (overnight hours are two windows), a rule
 * with no days, or a badly formed time. Overlapping windows on the same
 * day are allowed — they just mean "on".
 */
export function rowsFromRules(rules: HoursRule[]): HoursCheck {
  const rows: MenuHoursWindow[] = [];
  for (const rule of rules) {
    if (rule.days.length === 0) {
      return {
        ok: false,
        error: "Pick at least one day for each set of hours.",
      };
    }
    if (!TIME.test(rule.opens) || !TIME.test(rule.closes)) {
      return { ok: false, error: "Times look like 11:00 or 17:30." };
    }
    if (rule.closes <= rule.opens) {
      return {
        ok: false,
        error:
          "Closing time has to be after opening time. For hours past midnight, add a second set starting at 00:00 the next day.",
      };
    }
    for (const day of rule.days) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        return { ok: false, error: "That day isn't valid." };
      }
      rows.push({ day, opens: rule.opens, closes: rule.closes });
    }
  }
  return { ok: true, rows };
}

// Holiday and special hours -----------------------------------------------------

/** One date the restaurant is closed, or open only between two times. */
export interface SpecialHours {
  id: string;
  /** "2026-12-25", in the restaurant's timezone. */
  day: string;
  closed: boolean;
  opens: string | null;
  closes: string | null;
  note: string | null;
}

export interface SpecialHoursInput {
  day: string;
  closed: boolean;
  opens: string;
  closes: string;
  note: string;
}

export type SpecialHoursCheck =
  | {
      ok: true;
      row: Omit<SpecialHours, "id">;
    }
  | { ok: false; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const SPECIAL_HOURS_NOTE_MAX = 80;

/** Today's date in a timezone, "2026-12-25". */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone });
}

/**
 * Checks a holiday or special-hours entry the way the database will
 * (restaurant_special_hours_shape), and refuses dates already past.
 */
export function checkSpecialHours(
  input: SpecialHoursInput,
  today: string,
): SpecialHoursCheck {
  if (!DATE.test(input.day) || Number.isNaN(Date.parse(input.day))) {
    return { ok: false, error: "Pick a date." };
  }
  if (input.day < today) {
    return { ok: false, error: "That date has already passed." };
  }
  const note = input.note.trim().replace(/\s+/g, " ");
  if (note.length > SPECIAL_HOURS_NOTE_MAX) {
    return {
      ok: false,
      error: `Keep the note to ${SPECIAL_HOURS_NOTE_MAX} characters.`,
    };
  }
  if (input.closed) {
    return {
      ok: true,
      row: {
        day: input.day,
        closed: true,
        opens: null,
        closes: null,
        note: note || null,
      },
    };
  }
  if (!TIME.test(input.opens) || !TIME.test(input.closes)) {
    return { ok: false, error: "Times look like 11:00 or 17:30." };
  }
  if (input.closes <= input.opens) {
    return { ok: false, error: "Closing time has to be after opening time." };
  }
  return {
    ok: true,
    row: {
      day: input.day,
      closed: false,
      opens: input.opens,
      closes: input.closes,
      note: note || null,
    },
  };
}

/** "Thu, Dec 25" for a stored date. The date is already local; no shifting. */
export function specialDayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "17:00" → "5:00 PM"; "24:00" → "midnight". */
export function clockLabel(time: string): string {
  if (time === "24:00") return "midnight";
  const [h, m] = time.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "Closed" or "5:00 PM – 9:00 PM". */
export function specialHoursLabel(entry: {
  closed: boolean;
  opens: string | null;
  closes: string | null;
}): string {
  if (entry.closed || !entry.opens || !entry.closes) return "Closed";
  return `${clockLabel(entry.opens)} – ${clockLabel(entry.closes)}`;
}

/** What a diner is told about today, from get_special_hours_today(). */
export function specialHoursNotice(data: unknown): string | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const r = data[0] as Record<string, unknown>;
  const note =
    typeof r.note === "string" && r.note.trim() ? ` (${r.note.trim()})` : "";
  if (r.closed === true) return `Closed today${note}.`;
  if (typeof r.opens_at === "string" && typeof r.closes_at === "string") {
    return `Special hours today${note}: ${specialHoursLabel({
      closed: false,
      opens: r.opens_at,
      closes: r.closes_at,
    })}.`;
  }
  return null;
}
