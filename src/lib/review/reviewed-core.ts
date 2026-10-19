import type { Nutrition } from "@/lib/nutrition/core";

/**
 * "Reviewed, then confirm all" for allergens and nutrition.
 *
 * A person still looks at every dish: each one gets its own Reviewed mark,
 * and only marked dishes are confirmed by "Confirm all reviewed". What
 * that click publishes is exactly what was on screen when the dish was
 * marked: the allergen ticks are frozen while a dish is marked, and
 * nutrition is confirmed only if its saved numbers still match the ones
 * that were reviewed. A dish nobody marked is never confirmed by it.
 *
 * Marks live in this browser (localStorage) so a long review survives a
 * reload. They are a convenience, not a record: confirming is still the
 * database's own confirm_menu_item_*() call, per dish, as the reviewer.
 * No `server-only`, so the screens and the unit tests share it.
 */

/** The numbers as reviewed, in one comparable string. */
export function nutritionSignature(values: Nutrition): string {
  return [values.calories, values.proteinG, values.carbsG, values.fatG]
    .map((n) => String(Number(n)))
    .join("|");
}

export type ReviewedMarks = Record<string, string>;

/**
 * Stored marks → the ones still valid: the dish is still waiting, and
 * (for nutrition) its numbers haven't changed since it was marked — the
 * caller says which. A mark on numbers that changed is dropped, so the new
 * numbers get looked at.
 */
export function restoreMarks(
  raw: string | null,
  stillValid: (id: string, signature: string) => boolean,
): ReviewedMarks {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const marks: ReviewedMarks = {};
  for (const [id, signature] of Object.entries(parsed)) {
    if (typeof signature === "string" && stillValid(id, signature)) {
      marks[id] = signature;
    }
  }
  return marks;
}

/** An allergen dish's ticks, in one comparable string (order doesn't matter). */
export function allergenSignature(names: Iterable<string>): string {
  return [...names].sort().join("|");
}

export function namesFromSignature(signature: string): string[] {
  return signature === "" ? [] : signature.split("|");
}

export function storageKey(
  kind: "allergens" | "nutrition",
  restaurantId: string,
) {
  return `tableside:reviewed:${kind}:${restaurantId}`;
}

/** localStorage, failing quietly: a private window or blocked storage just means marks don't survive a reload. */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, marks: ReviewedMarks): void {
  try {
    if (Object.keys(marks).length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(marks));
  } catch {
    // Nothing to do: the marks still work for this visit.
  }
}
