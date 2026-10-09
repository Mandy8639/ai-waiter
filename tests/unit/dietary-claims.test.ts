// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DIETARY_CLAIMS,
  DIET_FILTERS,
  assertedClaims,
  claimNeedsAttribution,
  claimSentence,
  matchesDietFilter,
  parseDietFilters,
  type DietFlags,
  statedAllergens,
} from "@/lib/menu/diet-filters";

/**
 * Phase B: claims a restaurant makes about a dish.
 *
 * Almost every test here is a negative one, and that is the point. The
 * feature's whole risk is a "no" nobody said: a diner who keeps halal
 * being told a dish is not halal because a column was left at its default.
 * So these assert what the system must NOT do at least as hard as what it
 * must.
 */

const nothingClaimed: DietFlags = {
  isVegetarian: false,
  isVegan: false,
  isSpicy: false,
  isHalal: false,
  isKosher: false,
};

describe("assertedClaims", () => {
  it("reports nothing for a dish the restaurant has said nothing about", () => {
    expect(assertedClaims(nothingClaimed)).toEqual([]);
  });

  it("never reports a claim as false — absent means unstated", () => {
    // The shape itself is the safety property: there is no `halal: false`
    // in the output for anything downstream to read as a denial.
    const claims = assertedClaims({ ...nothingClaimed, isHalal: true });
    expect(claims).toEqual(["halal"]);
    expect(JSON.stringify(claims)).not.toContain("false");
    expect(claims).not.toContain("kosher");
  });

  it("reports each claim the restaurant did make", () => {
    expect(
      assertedClaims({ ...nothingClaimed, isHalal: true, isKosher: true }),
    ).toEqual(["halal", "kosher"]);
  });

  it("treats a vegan dish as vegetarian, like the filter does", () => {
    expect(assertedClaims({ ...nothingClaimed, isVegan: true })).toEqual([
      "vegetarian",
      "vegan",
    ]);
  });

  it("does not treat spiciness as a dietary claim", () => {
    // Spicy is a description, not something a diner filters on for belief
    // or health reasons, and it is not attributed to anyone.
    expect(assertedClaims({ ...nothingClaimed, isSpicy: true })).toEqual([]);
  });
});

describe("attribution", () => {
  it("attributes exactly the claims a diner may act on for belief or health", () => {
    expect(claimNeedsAttribution("halal")).toBe(true);
    expect(claimNeedsAttribution("kosher")).toBe(true);
  });

  it("leaves the conventional labels unattributed", () => {
    // Vegetarian and vegan have been plain labels since the first menu.
    // Attributing those while the allergen list stays plain would be
    // inconsistent theatre.
    expect(claimNeedsAttribution("vegetarian")).toBe(false);
    expect(claimNeedsAttribution("vegan")).toBe(false);
  });

  it("names the restaurant, so the diner knows who is claiming it", () => {
    expect(claimSentence("halal", "Nashta")).toBe(
      "Nashta states this dish is halal.",
    );
    expect(claimSentence("kosher", "Nashta")).toBe(
      "Nashta states this dish is kosher.",
    );
  });

  it("returns nothing to print for a claim that needs no attribution", () => {
    expect(claimSentence("vegetarian", "Nashta")).toBeNull();
  });

  it("has wording for every claim that needs attributing", () => {
    for (const { key } of DIETARY_CLAIMS) {
      if (!claimNeedsAttribution(key)) continue;
      expect(claimSentence(key, "Nashta")).toMatch(/^Nashta states/);
    }
  });
});

describe("filtering", () => {
  it("matches only dishes the restaurant marked", () => {
    expect(
      matchesDietFilter({ ...nothingClaimed, isHalal: true }, "halal"),
    ).toBe(true);
    expect(matchesDietFilter(nothingClaimed, "halal")).toBe(false);
  });

  it("does not infer halal from a dish being vegetarian", () => {
    // The trap this feature exists to avoid: no meat is not the same as
    // halal, which depends on sourcing and handling.
    const vegetarian = { ...nothingClaimed, isVegetarian: true };
    expect(matchesDietFilter(vegetarian, "halal")).toBe(false);
    expect(matchesDietFilter(vegetarian, "kosher")).toBe(false);
    expect(assertedClaims(vegetarian)).not.toContain("halal");
  });

  it("does not infer kosher from halal, or the reverse", () => {
    expect(
      matchesDietFilter({ ...nothingClaimed, isHalal: true }, "kosher"),
    ).toBe(false);
    expect(
      matchesDietFilter({ ...nothingClaimed, isKosher: true }, "halal"),
    ).toBe(false);
  });

  it("accepts the new keys in the URL", () => {
    expect(parseDietFilters("halal,kosher")).toEqual(["halal", "kosher"]);
  });

  it("keeps the canonical order stable so equivalent URLs are identical", () => {
    expect(parseDietFilters("kosher,halal")).toEqual(
      parseDietFilters("halal,kosher"),
    );
  });

  it("offers every claim as a filter", () => {
    // A claim a restaurant can make but a diner cannot filter by is a
    // column nobody benefits from.
    const filterKeys = new Set<string>(DIET_FILTERS.map((f) => f.key));
    for (const { key } of DIETARY_CLAIMS) {
      expect(filterKeys.has(key)).toBe(true);
    }
  });
});

describe("statedAllergens", () => {
  const none = {
    containsNuts: false,
    containsDairy: false,
    containsGluten: false,
  };

  it("adds nothing for unticked boxes — 'not stated', never 'doesn't contain'", () => {
    // Found live: the AI waiter, handed containsDairy: false for a yoghurt
    // dish, told a diner it "doesn't contain nuts, dairy, or gluten".
    expect(statedAllergens([], none)).toEqual([]);
    expect(statedAllergens(["Sesame"], none)).toEqual(["Sesame"]);
  });

  it("adds the boxes the restaurant ticked, after its confirmed allergens", () => {
    expect(
      statedAllergens(["Sesame"], {
        containsNuts: true,
        containsDairy: true,
        containsGluten: true,
      }),
    ).toEqual(["Sesame", "Dairy", "Nuts", "Gluten"]);
  });

  it("skips a ticked box a confirmed allergen already says more precisely", () => {
    expect(
      statedAllergens(["Milk", "Peanuts", "Gluten"], {
        containsNuts: true,
        containsDairy: true,
        containsGluten: true,
      }),
    ).toEqual(["Milk", "Peanuts", "Gluten"]);
  });
});
