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
 * halal and kosher ARE filterable, and are not an exception to the rule
 * above — they are flags the restaurant sets, exactly like `is_vegetarian`.
 * The filter means "dishes the restaurant states are halal", never "dishes
 * we worked out are halal". A dish without the flag is simply absent from
 * the filtered list, which is the honest outcome: the restaurant has not
 * said. Nothing derives these from ingredients; see the migration
 * 20260925090000_dietary_claims.sql for why that would be wrong.
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
  { key: "halal", label: "Halal" },
  { key: "kosher", label: "Kosher" },
  { key: "high-protein", label: "High protein" },
  { key: "spicy", label: "Spicy" },
  { key: "mild", label: "Not spicy" },
] as const;

export type DietFilterKey = (typeof DIET_FILTERS)[number]["key"];

export interface DietFlags {
  isVegetarian: boolean;
  isVegan: boolean;
  isSpicy: boolean;
  isHalal: boolean;
  isKosher: boolean;
  isHighProtein: boolean;
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
    case "halal":
      // Only what the restaurant asserted. Never inferred, and never the
      // negation: a dish without the flag is unstated, not "not halal".
      return item.isHalal;
    case "kosher":
      return item.isKosher;
    case "high-protein":
      return item.isHighProtein;
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

/* -------------------------------------------------------------------------
 * Claims
 *
 * A "claim" is something the restaurant has affirmatively stated about a
 * dish. The list is deliberately narrower than DIET_FILTERS: "Not spicy" is
 * a filter but not a claim (it is the absence of a flag), and spiciness is
 * a description rather than a dietary assertion.
 *
 * THE POINT OF THIS SHAPE. Everything below reports only what is TRUE.
 * There is no function here that returns "is this halal?" as a boolean,
 * because the honest answer has three states — stated, not stated, and (a
 * state this schema does not model) explicitly denied — and a boolean
 * collapses the first two into a denial. Callers get a list of what the
 * restaurant said; anything absent from that list is unstated, and the
 * caller must say so rather than negate it.
 *
 * That is also why the AI tools return `dietaryClaims: string[]` instead of
 * `isHalal: false`. A model handed `false` will eventually tell a diner
 * "no, that dish isn't halal" about a dish nobody ever assessed.
 * ---------------------------------------------------------------------- */

export const DIETARY_CLAIMS = [
  { key: "vegetarian", label: "Vegetarian" },
  { key: "vegan", label: "Vegan" },
  { key: "halal", label: "Halal" },
  { key: "kosher", label: "Kosher" },
  { key: "high-protein", label: "High protein" },
] as const;

export type DietaryClaimKey = (typeof DIETARY_CLAIMS)[number]["key"];

/**
 * Claims that must be shown as the restaurant's own statement rather than
 * as a bare badge.
 *
 * halal and kosher because they are religious certifications a diner may
 * act on for reasons far beyond preference, and the restaurant — not this
 * software — is the party making the claim. high-protein because it has no
 * agreed threshold and no nutrition data behind it (see
 * docs/COMPETITIVE_ROADMAP.md phase M); it is the restaurant's description,
 * not a measurement.
 *
 * Vegetarian and vegan are absent on purpose: they are conventional, and
 * this product has shown them as plain labels since the first menu.
 * Attributing those and not the allergen list would be inconsistent
 * theatre.
 */
const ATTRIBUTED: ReadonlySet<string> = new Set([
  "halal",
  "kosher",
  "high-protein",
]);

export function claimNeedsAttribution(key: DietaryClaimKey): boolean {
  return ATTRIBUTED.has(key);
}

/** Only what the restaurant has stated. Never a negation, never inferred. */
export function assertedClaims(item: DietFlags): DietaryClaimKey[] {
  const claimed: DietaryClaimKey[] = [];
  // A vegan dish is vegetarian even when only the vegan flag was ticked —
  // the same rule matchesDietFilter applies.
  if (item.isVegetarian || item.isVegan) claimed.push("vegetarian");
  if (item.isVegan) claimed.push("vegan");
  if (item.isHalal) claimed.push("halal");
  if (item.isKosher) claimed.push("kosher");
  if (item.isHighProtein) claimed.push("high-protein");
  return claimed;
}

/**
 * How a claim is worded to a diner when it needs attributing.
 *
 * "Nashta states this dish is halal" rather than a bare "Halal", so the
 * diner knows who is making the claim and can weigh it. The restaurant's
 * name is passed in rather than the word "restaurant", because the diner
 * is sitting in a specific one and a generic sentence reads like boilerplate.
 */
export function claimSentence(
  key: DietaryClaimKey,
  restaurantName: string,
): string | null {
  if (!claimNeedsAttribution(key)) return null;
  const what =
    key === "high-protein"
      ? "is high in protein"
      : `is ${DIETARY_CLAIMS.find((c) => c.key === key)!.label.toLowerCase()}`;
  return `${restaurantName} states this dish ${what}.`;
}
