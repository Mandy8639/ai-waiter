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
  | { type: "none" };

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
  if (!wanted) return { type: "none" };

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
  return pick(partial) ?? { type: "none" };
}

/** "Grilled salmon" or "Oat milk (on 4 dishes)". */
export function matchLabel(match: Match): string {
  if (match.type === "dish") return match.dish.name;
  const dishes = new Set(match.options.map((o) => o.dishName)).size;
  return dishes === 1
    ? `${match.name} (on ${match.options[0].dishName})`
    : `${match.name} (on ${dishes} dishes)`;
}
