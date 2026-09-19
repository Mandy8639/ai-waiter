/**
 * The diner menu's dietary filters, and which of them are worth offering.
 *
 * Only flags the restaurant itself sets on each dish are filterable:
 * `is_vegetarian`, `is_vegan`, `is_spicy`. There is deliberately no
 * "dairy-free", "nut-free" or "gluten-free" filter. Those would have to be
 * derived from the ABSENCE of a confirmed allergen, and an absent allergen
 * means "the restaurant hasn't said", not "safe" — a filter labelled
 * "Nut-free" would turn missing data into a promise a diner with an allergy
 * acts on. Allergens stay on every card instead, stated as the restaurant
 * lists them.
 *
 * A filter is offered only when it would actually narrow the menu: at
 * least one dish matches and at least one does not. An all-vegetarian
 * restaurant showing a "Vegetarian" chip that changes nothing is noise.
 *
 * Pure and free of `server-only` so it is unit-tested directly.
 */

export const DIET_FILTERS = [
  { key: "vegetarian", label: "Vegetarian" },
  { key: "vegan", label: "Vegan" },
  { key: "spicy", label: "Spicy" },
  { key: "mild", label: "Not spicy" },
] as const;

export type DietFilterKey = (typeof DIET_FILTERS)[number]["key"];

export interface DietFlags {
  isVegetarian: boolean;
  isVegan: boolean;
  isSpicy: boolean;
}

const KEYS = new Set<string>(DIET_FILTERS.map((f) => f.key));

function isDietFilterKey(value: string): value is DietFilterKey {
  return KEYS.has(value);
}

export function matchesDietFilter(
  item: DietFlags,
  key: DietFilterKey,
): boolean {
  switch (key) {
    case "vegetarian":
      // A vegan dish is vegetarian even if only the vegan flag was ticked.
      return item.isVegetarian || item.isVegan;
    case "vegan":
      return item.isVegan;
    case "spicy":
      return item.isSpicy;
    case "mild":
      return !item.isSpicy;
  }
}

/**
 * Reads `?diet=` (repeatable, or comma-separated) into a de-duplicated,
 * canonical list. "spicy" and "mild" contradict each other; asking for both
 * selects neither rather than an always-empty menu.
 */
export function parseDietFilters(
  raw: string | string[] | undefined,
): DietFilterKey[] {
  const values = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().toLowerCase())
    .filter(isDietFilterKey);

  const chosen = new Set(values);
  if (chosen.has("spicy") && chosen.has("mild")) {
    chosen.delete("spicy");
    chosen.delete("mild");
  }
  // Canonical order, so equivalent URLs are identical.
  return DIET_FILTERS.map((f) => f.key).filter((k) => chosen.has(k));
}

/** Filters that would narrow this menu, in display order. */
export function availableDietFilters(
  items: DietFlags[],
): (typeof DIET_FILTERS)[number][] {
  if (items.length === 0) return [];
  return DIET_FILTERS.filter((filter) => {
    const matching = items.filter((item) =>
      matchesDietFilter(item, filter.key),
    ).length;
    return matching > 0 && matching < items.length;
  });
}

/** Toggles one filter in a selection, keeping spicy/mild exclusive. */
export function toggleDietFilter(
  selected: DietFilterKey[],
  key: DietFilterKey,
): DietFilterKey[] {
  if (selected.includes(key)) return selected.filter((k) => k !== key);
  const opposite: Partial<Record<DietFilterKey, DietFilterKey>> = {
    spicy: "mild",
    mild: "spicy",
  };
  const next = selected.filter((k) => k !== opposite[key]);
  return parseDietFilters([...next, key]);
}

/** A menu URL with only the parameters that are set. */
export function menuHref(
  restaurantSlug: string,
  params: {
    category?: string | null;
    q?: string | null;
    diet?: DietFilterKey[];
  },
): string {
  const search = new URLSearchParams();
  if (params.category) search.set("category", params.category);
  if (params.q) search.set("q", params.q);
  if (params.diet && params.diet.length > 0) {
    search.set("diet", params.diet.join(","));
  }
  const query = search.toString();
  return `/r/${restaurantSlug}/menu${query ? `?${query}` : ""}`;
}
