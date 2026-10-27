import { allergenReport, pairingsFor, type MenuGraph } from "./core";
import {
  ALLERGEN_GROUPS,
  ALLERGEN_LABELS,
  allergenGroupsIn,
} from "./allergen-lexicon";

/**
 * What the waiter's check_menu_allergens and get_pairings tools return,
 * from a built graph. Pure, so the production tools
 * (src/lib/ai/tools/menu-graph.ts) and the waiter evaluation's in-memory
 * restaurant (evals/waiter/world.ts) hand the model the same shape and
 * the same wording.
 */

export interface GraphToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Enough to answer from; a whole menu of names would drown the reply. */
const MAX_LISTED = 25;

export function allergenCheckResult(
  graph: MenuGraph,
  currency: string,
  args: { allergens: string; dietary?: string; notSpicy?: boolean },
): GraphToolResult {
  const groups = allergenGroupsIn(args.allergens);
  if (groups.length === 0) {
    return {
      ok: false,
      error: `I can check the menu for these: ${ALLERGEN_GROUPS.map((g) => ALLERGEN_LABELS[g]).join(", ")}. For anything else, ask the staff.`,
    };
  }
  const report = allergenReport(graph, groups, {
    dietaryClaim: args.dietary,
    notSpicy: args.notSpicy,
  });
  return {
    ok: true,
    data: {
      currency,
      allergens: report.allergens,
      containsPerRestaurant: report.contains.slice(0, MAX_LISTED),
      likelyContains: report.likely.slice(0, MAX_LISTED),
      notMarkedAsContaining: report.notStated
        .slice(0, MAX_LISTED)
        .map(({ id, name, price, dietaryClaims }) => ({
          id,
          name,
          price,
          dietaryClaims,
        })),
      dishesWithIngredientLists: [...graph.dishes.values()].filter(
        (d) => d.hasIngredients,
      ).length,
      totalDishesServedNow: graph.dishes.size,
      rule: "Never call a dish free of these allergens. Name the dishes to avoid (containsPerRestaurant, and likelyContains with its reason). Dishes in notMarkedAsContaining only aren't marked: offer them as ones to ask staff to confirm, not as safe.",
    },
  };
}

export function pairingsResult(
  graph: MenuGraph,
  currency: string,
  dishId: string,
): GraphToolResult {
  const dish = graph.dishes.get(dishId);
  if (!dish) {
    return {
      ok: false,
      error: "That item isn't on the menu (or isn't being served right now).",
    };
  }
  const pairings = pairingsFor(graph, dish.id);
  return {
    ok: true,
    data: {
      currency,
      dish: { id: dish.id, name: dish.name, price: dish.price },
      pairings,
      basis: "Separate visits that ordered both, over the last 90 days.",
      ...(pairings.length === 0
        ? {
            note: "Not enough orders yet to say what guests have with it. You may suggest a bread, side or drink from search_menu as an idea, without saying it's popular.",
          }
        : {}),
    },
  };
}
