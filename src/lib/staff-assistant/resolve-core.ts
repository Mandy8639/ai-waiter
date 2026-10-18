/**
 * Finding "the salmon" on this restaurant's menu. Never guesses: one clear
 * match is used, several mean "which one?", none means "not found". No
 * `server-only`, per the extract-the-core convention.
 */

export interface CatalogDish {
  id: string;
  name: string;
  price: number;
  available: boolean;
  /** When a dish sold out "until tomorrow" comes back (ISO), else null. */
  backAt: string | null;
}

export interface CatalogOption {
  id: string;
  name: string;
  /** The add-on group, e.g. "Milk". */
  groupName: string;
  /** The dish the group belongs to. */
  dishName: string;
  available: boolean;
}

export interface Catalog {
  dishes: CatalogDish[];
  options: CatalogOption[];
}

/**
 * Something a command can mean: one dish, or every add-on with one name —
 * "oat milk" is an option on every coffee, and running out of it means
 * all of them.
 */
export type Match =
  | { type: "dish"; dish: CatalogDish }
  | { type: "options"; name: string; options: CatalogOption[] };

export type Resolution =
  | { type: "one"; match: Match }
  | { type: "several"; matches: Match[] }
  /**
   * Nothing matched. `closest` are near-misses for a typo ("fries rice" →
   * "Veg Fried Rice"), offered as choices and never used on their own.
   */
  | { type: "none"; closest: Match[] };

/** For comparing names: lowercase words, no punctuation, no plural "s". */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && w !== "the")
    .map((w) =>
      w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w,
    )
    .join(" ");
}

function words(name: string): string[] {
  return normalizeName(name).split(" ").filter(Boolean);
}

/** Every word typed appears in the name, as a whole word. */
function containsAll(name: string, target: string[]): boolean {
  const have = new Set(words(name));
  return target.length > 0 && target.every((w) => have.has(w));
}

function optionGroups(options: CatalogOption[]): Match[] {
  const byName = new Map<string, CatalogOption[]>();
  for (const o of options) {
    const key = normalizeName(o.name);
    byName.set(key, [...(byName.get(key) ?? []), o]);
  }
  return [...byName.values()].map((list) => ({
    type: "options" as const,
    name: list[0].name,
    options: list,
  }));
}

/**
 * `dishesOnly`: prices are a dish's, so a price change never matches an
 * add-on. `prefer`: when several match, keep only those this command would
 * actually change ("86 the salmon" ignores a salmon that's already off).
 */
export function resolveTarget(
  catalog: Catalog,
  target: string,
  {
    dishesOnly = false,
    prefer,
  }: { dishesOnly?: boolean; prefer?: (m: Match) => boolean } = {},
): Resolution {
  const wanted = normalizeName(target);
  const wantedWords = wanted.split(" ").filter(Boolean);
  if (!wanted) return { type: "none", closest: [] };

  const options = dishesOnly ? [] : catalog.options;
  const pick = (matches: Match[]): Resolution | null => {
    if (matches.length === 1) return { type: "one", match: matches[0] };
    if (matches.length > 1) {
      const preferred = prefer ? matches.filter(prefer) : [];
      if (preferred.length === 1) return { type: "one", match: preferred[0] };
      return { type: "several", matches };
    }
    return null;
  };

  const exact = [
    ...catalog.dishes
      .filter((d) => normalizeName(d.name) === wanted)
      .map((dish) => ({ type: "dish" as const, dish })),
    ...optionGroups(options.filter((o) => normalizeName(o.name) === wanted)),
  ];
  const fromExact = pick(exact);
  if (fromExact) return fromExact;

  const partial = [
    ...catalog.dishes
      .filter((d) => containsAll(d.name, wantedWords))
      .map((dish) => ({ type: "dish" as const, dish })),
    ...optionGroups(options.filter((o) => containsAll(o.name, wantedWords))),
  ];
  const found = pick(partial);
  if (found) return found;

  // A typo: every word typed is within an edit or two of a word in the
  // name. Offered as "did you mean?", never acted on.
  const near = (name: string) =>
    wantedWords.length > 0 &&
    wantedWords.every((w) => words(name).some((n) => closeWords(w, n)));
  return {
    type: "none",
    closest: [
      ...catalog.dishes
        .filter((d) => near(d.name))
        .map((dish) => ({ type: "dish" as const, dish })),
      ...optionGroups(options.filter((o) => near(o.name))),
    ].slice(0, 6),
  };
}

/** Same word, or a typo of it: one edit for 4–6 letters, two from 7. */
export function closeWords(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  if (Math.min(a.length, b.length) < 4) return false;
  const allowed = longest >= 7 ? 2 : 1;
  if (Math.abs(a.length - b.length) > allowed) return false;
  return editDistance(a, b) <= allowed;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** "Grilled salmon" or "Oat milk (on 4 dishes)". */
export function matchLabel(match: Match): string {
  if (match.type === "dish") return match.dish.name;
  const dishes = new Set(match.options.map((o) => o.dishName)).size;
  return dishes === 1
    ? `${match.name} (on ${match.options[0].dishName})`
    : `${match.name} (on ${dishes} dishes)`;
}
