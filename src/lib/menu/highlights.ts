/**
 * The two highlight sections at the top of the diner menu, and the badge a
 * dish carries everywhere on the page. Pure, so it's unit-tested.
 *
 * - House favorites: dishes the restaurant starred, in menu order.
 * - Most ordered this month: from get_most_ordered_dishes(), in rank
 *   order, leaving out house favorites already shown just above it.
 */
export type DishHighlight = "house_favorite" | "most_ordered";

/** A long starred list stops being a highlight; the rest stay badged. */
export const MAX_HOUSE_FAVORITES = 8;

export function highlightSections<
  T extends { id: string; isHouseFavorite: boolean },
>(cards: T[], mostOrderedIds: string[]): { favorites: T[]; mostOrdered: T[] } {
  const favorites = cards
    .filter((c) => c.isHouseFavorite)
    .slice(0, MAX_HOUSE_FAVORITES);
  const shown = new Set(favorites.map((c) => c.id));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const mostOrdered = mostOrderedIds
    .map((id) => byId.get(id))
    .filter((c): c is T => c !== undefined && !shown.has(c.id));
  return { favorites, mostOrdered };
}

/** The badge for one dish: the restaurant's own star wins. */
export function highlightFor(
  card: { id: string; isHouseFavorite: boolean },
  mostOrdered: ReadonlySet<string>,
): DishHighlight | null {
  if (card.isHouseFavorite) return "house_favorite";
  return mostOrdered.has(card.id) ? "most_ordered" : null;
}
