import {
  ALLERGEN_LABELS,
  groupOfAllergenName,
  suggestedGroups,
  type AllergenGroup,
} from "./allergen-lexicon";

/**
 * The menu knowledge graph: a restaurant's dishes and what they're
 * connected to, so the waiter can answer questions that cross the menu
 * ("I'm allergic to dairy, what can I eat?", "what goes with the butter
 * chicken?") from structure rather than from a list it has to read.
 *
 * Nodes: dishes, sections, ingredients, allergen groups, diets.
 * Edges carry where they came from, because that decides what the waiter
 * may say about them:
 * - "stated": the restaurant said it (a confirmed allergen, a ticked
 *   "contains dairy" box, a vegetarian flag, an ingredient it listed).
 * - "inferred": a word in an ingredient or the dish's name suggests an
 *   allergen ("paneer" → dairy). Only ever adds caution: see the one-way
 *   rule in allergen-lexicon.ts.
 * - "orders": guests ordered the two dishes together, counted over recent
 *   orders (menu_pairings(), 20261122090000), counts only.
 *
 * Pure: built from rows load.ts reads, unit-tested in
 * tests/unit/menu-graph.test.ts.
 */

export type NodeKind = "dish" | "section" | "ingredient" | "allergen" | "diet";
export type EdgeSource = "stated" | "inferred" | "orders";
export type Relation =
  "in_section" | "made_with" | "contains" | "suits" | "ordered_with";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
}

export interface GraphEdge {
  from: string;
  relation: Relation;
  to: string;
  source: EdgeSource;
  /** Why, in a few words: "made with paneer", "ordered together 14 times". */
  because: string;
  weight?: number;
}

export interface MenuGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  dishes: Map<string, GraphDish>;
}

export interface GraphDish {
  id: string;
  name: string;
  price: number;
  sectionId: string | null;
  dietaryClaims: string[];
  isSpicy: boolean;
  /** The restaurant listed this dish's ingredients. */
  hasIngredients: boolean;
}

export interface MenuGraphInput {
  currency: string;
  sections: { id: string; name: string }[];
  dishes: {
    id: string;
    name: string;
    price: number;
    sectionId: string | null;
    isVegetarian: boolean;
    isVegan: boolean;
    isHalal: boolean;
    isKosher: boolean;
    isSpicy: boolean;
    containsNuts: boolean;
    containsDairy: boolean;
    containsGluten: boolean;
  }[];
  /** Ingredients the restaurant listed per dish. */
  ingredients: { dishId: string; name: string }[];
  /** Confirmed allergens only. */
  allergens: { dishId: string; name: string }[];
  /** Dish pairs ordered together, with how often (already thresholded). */
  pairings: { dishId: string; otherId: string; orders: number }[];
}

const dishNode = (id: string) => `dish:${id}`;
const allergenNode = (g: AllergenGroup) => `allergen:${g}`;

export function buildMenuGraph(input: MenuGraphInput): MenuGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const dishes = new Map<string, GraphDish>();
  const add = (node: GraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addAllergen = (group: AllergenGroup) =>
    add({
      id: allergenNode(group),
      kind: "allergen",
      label: ALLERGEN_LABELS[group],
    });

  for (const s of input.sections) {
    add({ id: `section:${s.id}`, kind: "section", label: s.name });
  }

  const ingredientsByDish = new Map<string, string[]>();
  for (const i of input.ingredients) {
    ingredientsByDish.set(i.dishId, [
      ...(ingredientsByDish.get(i.dishId) ?? []),
      i.name,
    ]);
  }

  for (const d of input.dishes) {
    const claims = [
      (d.isVegetarian || d.isVegan) && "vegetarian",
      d.isVegan && "vegan",
      d.isHalal && "halal",
      d.isKosher && "kosher",
    ].filter((c): c is string => Boolean(c));
    const listed = ingredientsByDish.get(d.id) ?? [];
    dishes.set(d.id, {
      id: d.id,
      name: d.name,
      price: d.price,
      sectionId: d.sectionId,
      dietaryClaims: claims,
      isSpicy: d.isSpicy,
      hasIngredients: listed.length > 0,
    });
    const node = dishNode(d.id);
    add({ id: node, kind: "dish", label: d.name });

    if (d.sectionId && nodes.has(`section:${d.sectionId}`)) {
      edges.push({
        from: node,
        relation: "in_section",
        to: `section:${d.sectionId}`,
        source: "stated",
        because: "on the menu there",
      });
    }
    for (const claim of claims) {
      add({ id: `diet:${claim}`, kind: "diet", label: claim });
      edges.push({
        from: node,
        relation: "suits",
        to: `diet:${claim}`,
        source: "stated",
        because: `the restaurant marks it ${claim}`,
      });
    }

    // Stated allergens: the ticked boxes on the dish form.
    const ticked: [boolean, AllergenGroup, string][] = [
      [d.containsDairy, "dairy", "the restaurant marks it as containing dairy"],
      [d.containsNuts, "nuts", "the restaurant marks it as containing nuts"],
      [
        d.containsGluten,
        "gluten",
        "the restaurant marks it as containing gluten",
      ],
    ];
    for (const [on, group, because] of ticked) {
      if (!on) continue;
      addAllergen(group);
      edges.push({
        from: node,
        relation: "contains",
        to: allergenNode(group),
        source: "stated",
        because,
      });
    }

    // Listed ingredients, and what their names suggest.
    for (const name of listed) {
      const ingredient = `ingredient:${name.toLowerCase()}`;
      add({ id: ingredient, kind: "ingredient", label: name });
      edges.push({
        from: node,
        relation: "made_with",
        to: ingredient,
        source: "stated",
        because: "listed by the restaurant",
      });
      for (const { group, word } of suggestedGroups(name)) {
        addAllergen(group);
        edges.push({
          from: node,
          relation: "contains",
          to: allergenNode(group),
          source: "inferred",
          because: `made with ${name}${word === name.toLowerCase() ? "" : ` (${word})`}`,
        });
      }
    }
    // The dish's own name ("Paneer Tikka", "Butter Naan").
    for (const { group, word } of suggestedGroups(d.name)) {
      addAllergen(group);
      edges.push({
        from: node,
        relation: "contains",
        to: allergenNode(group),
        source: "inferred",
        because: `its name mentions ${word}`,
      });
    }
  }

  // Confirmed allergens, mapped to their group by name.
  for (const a of input.allergens) {
    const group = groupOfAllergenName(a.name);
    if (!group || !dishes.has(a.dishId)) continue;
    addAllergen(group);
    edges.push({
      from: dishNode(a.dishId),
      relation: "contains",
      to: allergenNode(group),
      source: "stated",
      because: `the restaurant lists ${a.name}`,
    });
  }

  for (const p of input.pairings) {
    if (!dishes.has(p.dishId) || !dishes.has(p.otherId)) continue;
    edges.push({
      from: dishNode(p.dishId),
      relation: "ordered_with",
      to: dishNode(p.otherId),
      source: "orders",
      because: `ordered together ${p.orders} times recently`,
      weight: p.orders,
    });
  }

  return { nodes, edges, dishes };
}

// ── Queries ──────────────────────────────────────────────────────────

export interface DishVerdict {
  id: string;
  name: string;
  price: number;
  dietaryClaims: string[];
  /** Why the waiter must warn, strongest first. Empty for "not stated". */
  reasons: string[];
}

export interface AllergenReport {
  allergens: string[];
  /** The restaurant states the dish contains one of them. */
  contains: DishVerdict[];
  /** An ingredient or the name suggests one. Treat as containing it. */
  likely: DishVerdict[];
  /**
   * Nothing stated or suggested. NOT "free of": the restaurant hasn't
   * said, so the diner must confirm with staff.
   */
  notStated: DishVerdict[];
}

/**
 * Sorts the menu for a diner avoiding these allergens. Every dish lands in
 * exactly one bucket, and a dish only reaches "not stated" when no edge,
 * stated or inferred, connects it to any of them.
 */
export function allergenReport(
  graph: MenuGraph,
  groups: AllergenGroup[],
  options: {
    dishIds?: Set<string>;
    dietaryClaim?: string;
    notSpicy?: boolean;
  } = {},
): AllergenReport {
  const targets = new Set(groups.map(allergenNode));
  const report: AllergenReport = {
    allergens: groups.map((g) => ALLERGEN_LABELS[g]),
    contains: [],
    likely: [],
    notStated: [],
  };
  for (const dish of graph.dishes.values()) {
    if (options.dishIds && !options.dishIds.has(dish.id)) continue;
    if (
      options.dietaryClaim &&
      !dish.dietaryClaims.includes(options.dietaryClaim)
    )
      continue;
    if (options.notSpicy && dish.isSpicy) continue;
    const hits = graph.edges.filter(
      (e) =>
        e.from === dishNode(dish.id) &&
        e.relation === "contains" &&
        targets.has(e.to),
    );
    const stated = hits.filter((e) => e.source === "stated");
    const inferred = hits.filter((e) => e.source === "inferred");
    const verdict = (edges: GraphEdge[]): DishVerdict => ({
      id: dish.id,
      name: dish.name,
      price: dish.price,
      dietaryClaims: dish.dietaryClaims,
      reasons: [
        ...new Set(
          edges.map((e) => `${graph.nodes.get(e.to)!.label}: ${e.because}`),
        ),
      ],
    });
    if (stated.length > 0)
      report.contains.push(verdict([...stated, ...inferred]));
    else if (inferred.length > 0) report.likely.push(verdict(inferred));
    else report.notStated.push(verdict([]));
  }
  return report;
}

export interface Pairing {
  id: string;
  name: string;
  price: number;
  orderedTogether: number;
}

/** What guests most often order with this dish, most often first. */
export function pairingsFor(
  graph: MenuGraph,
  dishId: string,
  limit = 5,
): Pairing[] {
  return graph.edges
    .filter((e) => e.relation === "ordered_with" && e.from === dishNode(dishId))
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, limit)
    .map((e) => {
      const dish = graph.dishes.get(e.to.slice("dish:".length))!;
      return {
        id: dish.id,
        name: dish.name,
        price: dish.price,
        orderedTogether: e.weight ?? 0,
      };
    });
}
