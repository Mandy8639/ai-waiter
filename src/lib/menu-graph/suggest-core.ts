import type { AllergenGroup } from "./allergen-lexicon";
import type { MenuGraph } from "./core";

/**
 * Turns the menu knowledge graph's inferred allergens into suggestions for
 * the owner's review screen (/dashboard/menu/allergen-review,
 * suggest_menu_allergens(), 20261123090000).
 *
 * A dish gets a suggestion for a group only when the graph INFERRED it
 * (an ingredient or the dish's name) and nothing STATED it (a confirmed
 * allergen of that group, under any name, or a ticked "contains" box):
 * there's no point asking an owner to confirm what they already said.
 * Names are the review screen's own vocabulary
 * (src/lib/menu-import/suggestions.ts), so a suggestion and a tick are
 * the same thing.
 *
 * Pure, unit-tested in tests/unit/menu-graph.test.ts.
 */

/** The review screen's name for each group. */
export const VOCABULARY_NAME: Record<AllergenGroup, string> = {
  dairy: "Milk",
  egg: "Eggs",
  fish: "Fish",
  shellfish: "Shellfish",
  nuts: "Tree nuts",
  peanuts: "Peanuts",
  gluten: "Wheat",
  soy: "Soy",
  sesame: "Sesame",
  mustard: "Mustard",
};

export interface AllergenSuggestion {
  menu_item_id: string;
  allergen_name: string;
  /** Shown beside the tick: "its name mentions paneer". */
  reason: string;
}

export function allergenSuggestions(graph: MenuGraph): AllergenSuggestion[] {
  const out: AllergenSuggestion[] = [];
  for (const dish of graph.dishes.values()) {
    const node = `dish:${dish.id}`;
    const contains = graph.edges.filter(
      (e) => e.from === node && e.relation === "contains",
    );
    const stated = new Set(
      contains.filter((e) => e.source === "stated").map((e) => e.to),
    );
    const seen = new Set<string>();
    for (const edge of contains) {
      if (edge.source !== "inferred" || stated.has(edge.to)) continue;
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      const group = edge.to.slice("allergen:".length) as AllergenGroup;
      out.push({
        menu_item_id: dish.id,
        allergen_name: VOCABULARY_NAME[group],
        reason: edge.because,
      });
    }
  }
  return out;
}
