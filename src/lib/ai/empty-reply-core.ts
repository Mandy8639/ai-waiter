import type { LoopToolOutcome } from "./loop";
import type { FoundDishesKind } from "./fallback-text";
import { collectToolMenuItems } from "./recommendations";

/**
 * Which dishes to offer when the model returned an empty reply after its
 * lookups: the restaurant's own picks (house favorites, then the
 * most-ordered dishes) if get_restaurant_info returned any, otherwise what
 * search_menu / get_menu_item found, in the order they found it. Only rows
 * a tool returned this turn, so nothing here is the model's. No
 * `server-only`: unit-tested directly.
 */

export const MAX_EMPTY_REPLY_DISHES = 5;

export interface EmptyReplyDish {
  name: string;
  price: number;
  currency: string;
}

interface HighlightRow {
  id?: unknown;
  name?: unknown;
  price?: unknown;
}

export function dishesForEmptyReply(toolOutcomes: LoopToolOutcome[]): {
  kind: FoundDishesKind;
  dishes: EmptyReplyDish[];
} {
  const picks = new Map<string, EmptyReplyDish>();
  for (const outcome of toolOutcomes) {
    if (outcome.toolName !== "get_restaurant_info" || !outcome.result.ok) {
      continue;
    }
    const data = outcome.result.data as Record<string, unknown> | undefined;
    const currency = typeof data?.currency === "string" ? data.currency : "USD";
    for (const key of ["houseFavorites", "mostOrderedThisMonth"]) {
      const rows = Array.isArray(data?.[key])
        ? (data[key] as HighlightRow[])
        : [];
      for (const row of rows) {
        if (
          typeof row.id === "string" &&
          typeof row.name === "string" &&
          typeof row.price === "number" &&
          !picks.has(row.id)
        ) {
          picks.set(row.id, { name: row.name, price: row.price, currency });
        }
      }
    }
  }
  if (picks.size > 0) {
    return {
      kind: "favorites",
      dishes: [...picks.values()].slice(0, MAX_EMPTY_REPLY_DISHES),
    };
  }
  return {
    kind: "found",
    dishes: collectToolMenuItems(toolOutcomes)
      .slice(0, MAX_EMPTY_REPLY_DISHES)
      .map(({ name, price, currency }) => ({ name, price, currency })),
  };
}
