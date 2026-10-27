import { describe, expect, it } from "vitest";
import {
  allergenGroupsIn,
  groupOfAllergenName,
  suggestedGroups,
} from "@/lib/menu-graph/allergen-lexicon";
import {
  allergenReport,
  buildMenuGraph,
  pairingsFor,
  type MenuGraphInput,
} from "@/lib/menu-graph/core";
import { allergenSuggestions } from "@/lib/menu-graph/suggest-core";
import { hasAllergenSource } from "@/lib/ai/tools/menu-fact-detection";
import { collectToolMenuItems } from "@/lib/ai/recommendations";
import type { LoopToolOutcome } from "@/lib/ai/loop";

// The menu knowledge graph (src/lib/menu-graph): what the waiter reasons
// over for allergy and pairing questions, and the one-way rule that keeps
// a gap in the data from becoming a promise.

describe("the allergen vocabulary", () => {
  it("reads the allergens a guest names in their own words", () => {
    expect(allergenGroupsIn("I can't have milk or peanuts")).toEqual([
      "dairy",
      "peanuts",
    ]);
    expect(allergenGroupsIn("anything without gluten?")).toEqual(["gluten"]);
    expect(allergenGroupsIn("I'm allergic to cats")).toEqual([]);
  });

  it("files a restaurant's own allergen names under a group", () => {
    expect(groupOfAllergenName("Milk")).toBe("dairy");
    expect(groupOfAllergenName("Peanuts")).toBe("peanuts");
    expect(groupOfAllergenName("Tree nuts")).toBe("nuts");
    expect(groupOfAllergenName("Crustaceans")).toBe("shellfish");
    expect(groupOfAllergenName("Lupin")).toBeNull();
  });

  it("spots allergens in ingredient and dish names, whole words only", () => {
    expect(suggestedGroups("Paneer Butter Masala")).toEqual([
      { group: "dairy", word: "butter" },
    ]);
    expect(suggestedGroups("Garlic Naan")).toEqual([
      { group: "gluten", word: "naan" },
    ]);
    // "Tilapia" is fish, and must not read as sesame ("til").
    expect(suggestedGroups("Tilapia fry").map((s) => s.group)).toEqual([
      "fish",
    ]);
    expect(suggestedGroups("Masala Chai")).toEqual([]);
  });
});

const dish = (
  id: string,
  name: string,
  extra: Partial<MenuGraphInput["dishes"][number]> = {},
): MenuGraphInput["dishes"][number] => ({
  id,
  name,
  price: 10,
  sectionId: "S1",
  isVegetarian: false,
  isVegan: false,
  isHalal: false,
  isKosher: false,
  isSpicy: false,
  containsNuts: false,
  containsDairy: false,
  containsGluten: false,
  ...extra,
});

const graph = buildMenuGraph({
  currency: "USD",
  sections: [{ id: "S1", name: "Mains" }],
  dishes: [
    dish("butter", "Butter Chicken", { containsDairy: true }),
    dish("palak", "Palak Paneer", { isVegetarian: true }),
    dish("korma", "Veg Korma", { isVegetarian: true }),
    dish("dal", "Dal Tadka", { isVegetarian: true, isSpicy: true }),
    dish("chana", "Chana Masala", { isVegan: true }),
    dish("naan", "Garlic Naan", { isVegetarian: true }),
    dish("lassi", "Sweet Drink"),
  ],
  ingredients: [
    { dishId: "dal", name: "Ghee" },
    { dishId: "chana", name: "Chickpeas" },
  ],
  allergens: [{ dishId: "lassi", name: "Milk" }],
  pairings: [
    { dishId: "butter", otherId: "naan", orders: 14 },
    { dishId: "butter", otherId: "lassi", orders: 5 },
    { dishId: "butter", otherId: "gone", orders: 9 },
  ],
});

describe("sorting the menu for a guest avoiding dairy", () => {
  const report = allergenReport(graph, ["dairy"]);
  const names = (list: { name: string }[]) => list.map((d) => d.name).sort();

  it("puts what the restaurant states first, whichever way it said it", () => {
    // A ticked "contains dairy" box, and a confirmed allergen named Milk.
    expect(names(report.contains)).toEqual(["Butter Chicken", "Sweet Drink"]);
    expect(report.contains.find((d) => d.id === "lassi")!.reasons).toEqual([
      "Dairy: the restaurant lists Milk",
    ]);
  });

  it("flags what ingredients or names suggest, with the reason", () => {
    expect(names(report.likely)).toEqual(["Dal Tadka", "Palak Paneer"]);
    expect(report.likely.find((d) => d.id === "dal")!.reasons).toEqual([
      "Dairy: made with Ghee",
    ]);
    expect(report.likely.find((d) => d.id === "palak")!.reasons).toEqual([
      "Dairy: its name mentions paneer",
    ]);
  });

  it("calls the rest 'not stated', never free of it", () => {
    expect(names(report.notStated)).toEqual([
      "Chana Masala",
      "Garlic Naan",
      "Veg Korma",
    ]);
    expect(report.notStated.every((d) => d.reasons.length === 0)).toBe(true);
    expect(Object.keys(report)).not.toContain("free");
  });

  it("puts every dish in exactly one bucket", () => {
    const all = [...report.contains, ...report.likely, ...report.notStated];
    expect(all).toHaveLength(graph.dishes.size);
    expect(new Set(all.map((d) => d.id)).size).toBe(graph.dishes.size);
  });

  it("narrows by the restaurant's own diet claims and spice", () => {
    const vegan = allergenReport(graph, ["dairy"], { dietaryClaim: "vegan" });
    expect(names(vegan.notStated)).toEqual(["Chana Masala"]);
    const mild = allergenReport(graph, ["dairy"], { notSpicy: true });
    expect(names(mild.likely)).toEqual(["Palak Paneer"]);
  });

  it("checks several allergens at once", () => {
    const both = allergenReport(graph, ["dairy", "gluten"]);
    expect(names(both.likely)).toContain("Garlic Naan");
    expect(names(allergenReport(graph, ["nuts"]).likely)).toEqual([
      "Veg Korma",
    ]);
  });
});

describe("what guests order with a dish", () => {
  it("lists real pairings, most often first, skipping dishes not served", () => {
    expect(pairingsFor(graph, "butter")).toEqual([
      { id: "naan", name: "Garlic Naan", price: 10, orderedTogether: 14 },
      { id: "lassi", name: "Sweet Drink", price: 10, orderedTogether: 5 },
    ]);
    expect(pairingsFor(graph, "chana")).toEqual([]);
  });
});

describe("the waiter's guards and dish cards", () => {
  const outcome = (toolName: string, data: unknown) =>
    ({ toolName, result: { ok: true, data } }) as unknown as LoopToolOutcome;

  it("accepts the allergy check as an allergen source", () => {
    expect(hasAllergenSource([outcome("check_menu_allergens", {})])).toBe(true);
  });

  it("only offers cards for dishes not marked, never ones to avoid", () => {
    const items = collectToolMenuItems([
      outcome("check_menu_allergens", {
        currency: "USD",
        containsPerRestaurant: [
          { id: "butter", name: "Butter Chicken", price: 18 },
        ],
        likelyContains: [{ id: "palak", name: "Palak Paneer", price: 15 }],
        notMarkedAsContaining: [
          { id: "chana", name: "Chana Masala", price: 13 },
        ],
      }),
      outcome("get_pairings", {
        currency: "USD",
        pairings: [{ id: "naan", name: "Garlic Naan", price: 4 }],
      }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["chana", "naan"]);
  });
});

describe("allergen suggestions for the owner's review", () => {
  it("suggests what the graph infers and nothing the restaurant already stated", () => {
    const byDish = new Map<
      string,
      { allergen_name: string; reason: string }[]
    >();
    for (const s of allergenSuggestions(graph)) {
      byDish.set(s.menu_item_id, [...(byDish.get(s.menu_item_id) ?? []), s]);
    }
    expect(byDish.get("palak")).toEqual([
      {
        menu_item_id: "palak",
        allergen_name: "Milk",
        reason: "its name mentions paneer",
      },
    ]);
    expect(byDish.get("dal")).toEqual([
      { menu_item_id: "dal", allergen_name: "Milk", reason: "made with Ghee" },
    ]);
    expect(byDish.get("naan")?.map((s) => s.allergen_name)).toEqual(["Wheat"]);
    expect(byDish.get("korma")?.map((s) => s.allergen_name)).toEqual([
      "Tree nuts",
    ]);
    // Butter Chicken is marked "contains dairy"; the drink has a confirmed
    // Milk: nothing to ask about either.
    expect(byDish.has("butter")).toBe(false);
    expect(byDish.has("lassi")).toBe(false);
    expect(byDish.has("chana")).toBe(false);
  });

  it("asks once per allergen even when the name and an ingredient both point to it", () => {
    const g = buildMenuGraph({
      currency: "USD",
      sections: [],
      dishes: [dish("pbm", "Paneer Butter Masala")],
      ingredients: [{ dishId: "pbm", name: "Cream" }],
      allergens: [],
      pairings: [],
    });
    expect(allergenSuggestions(g).map((s) => s.allergen_name)).toEqual([
      "Milk",
    ]);
  });
});
