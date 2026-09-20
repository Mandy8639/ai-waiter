import { describe, expect, it } from "vitest";
import {
  availableDietFilters,
  matchesDietFilter,
  menuHref,
  parseDietFilters,
  toggleDietFilter,
} from "@/lib/menu/diet-filters";
import { formatPrice } from "@/lib/format/price";

const veg = { isVegetarian: true, isVegan: false, isSpicy: false };
const vegan = { isVegetarian: false, isVegan: true, isSpicy: true };
const meat = { isVegetarian: false, isVegan: false, isSpicy: true };

describe("diet filters", () => {
  it("treats a vegan dish as vegetarian", () => {
    expect(matchesDietFilter(vegan, "vegetarian")).toBe(true);
    expect(matchesDietFilter(meat, "vegetarian")).toBe(false);
  });

  it("parses repeated and comma-separated values, ignoring unknown ones", () => {
    expect(parseDietFilters(["vegan", "nut-free,spicy"])).toEqual([
      "vegan",
      "spicy",
    ]);
    expect(parseDietFilters(undefined)).toEqual([]);
  });

  it("never offers a nut-free, dairy-free or gluten-free filter", () => {
    // Absence of a confirmed allergen is missing data, not a promise.
    expect(parseDietFilters("dairy-free,gluten-free,nut-free")).toEqual([]);
  });

  it("drops spicy and mild together instead of emptying the menu", () => {
    expect(parseDietFilters("spicy,mild,vegan")).toEqual(["vegan"]);
  });

  it("offers only filters that would narrow the menu", () => {
    // An all-vegetarian menu gets no Vegetarian chip.
    expect(
      availableDietFilters([veg, { ...veg, isSpicy: true }]).map((f) => f.key),
    ).toEqual(["spicy", "mild"]);
    expect(availableDietFilters([veg, vegan, meat]).map((f) => f.key)).toEqual([
      "vegetarian",
      "vegan",
      "spicy",
      "mild",
    ]);
    expect(availableDietFilters([])).toEqual([]);
  });

  it("toggles, keeping spicy and mild exclusive", () => {
    expect(toggleDietFilter(["spicy"], "mild")).toEqual(["mild"]);
    expect(toggleDietFilter(["vegan", "mild"], "mild")).toEqual(["vegan"]);
    expect(toggleDietFilter([], "vegan")).toEqual(["vegan"]);
  });

  it("builds clean menu URLs", () => {
    expect(menuHref("nashta", {})).toBe("/r/nashta/menu");
    expect(
      menuHref("nashta", { category: "c1", q: "a&b", diet: ["vegan", "mild"] }),
    ).toBe("/r/nashta/menu?category=c1&q=a%26b&diet=vegan%2Cmild");
  });
});

describe("formatPrice", () => {
  it("formats in the restaurant's currency, not always dollars", () => {
    expect(formatPrice(9.99, "USD")).toBe("$9.99");
    expect(formatPrice(9.99, "EUR")).toBe("€9.99");
    expect(formatPrice(250, "INR")).toBe("₹250.00");
  });

  it("shows the code rather than guessing a symbol it cannot format", () => {
    expect(formatPrice(3, "usd")).toBe("3.00 usd");
  });

  it("never renders NaN", () => {
    expect(formatPrice(Number.NaN, "USD")).toBe("$0.00");
  });
});
