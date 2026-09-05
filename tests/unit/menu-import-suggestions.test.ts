import { describe, it, expect } from "vitest";
import {
  parseSuggestions,
  canonicalAllergen,
  ALLERGEN_VOCABULARY,
  SUGGESTION_PROMPT,
} from "@/lib/menu-import/suggestions";

describe("canonicalAllergen", () => {
  it.each([
    ["tree nuts", "Tree nuts"],
    ["TREE NUTS", "Tree nuts"],
    ["  Milk  ", "Milk"],
  ])("matches %s case- and space-insensitively", (input, expected) => {
    expect(canonicalAllergen(input)).toBe(expected);
  });

  it.each(["may contain traces of nuts", "nuts?", "possibly dairy", ""])(
    "rejects free text like %s",
    (input) => {
      // An allergen the app can't match is one a diner filtering for it
      // will never see — worse than none, because it looks like coverage.
      expect(canonicalAllergen(input)).toBeNull();
    },
  );
});

describe("parseSuggestions", () => {
  const raw = JSON.stringify({
    items: [
      {
        name: "Paneer Paratha",
        ingredients: ["Paneer", "wheat flour", "paneer", "Potato"],
        allergens: ["Milk", "Wheat", "may contain traces of nuts"],
      },
    ],
  });

  it("keeps only allergens from the fixed vocabulary", () => {
    const out = parseSuggestions(raw);
    expect(out.ok).toBe(true);
    expect(out.suggestions[0].allergens).toEqual(["Milk", "Wheat"]);
    expect(out.suggestions[0].allergens).not.toContain(
      "may contain traces of nuts",
    );
  });

  it("deduplicates and lowercases ingredients", () => {
    const out = parseSuggestions(raw);
    expect(out.suggestions[0].ingredients).toEqual([
      "paneer",
      "wheat flour",
      "potato",
    ]);
  });

  it("returns an empty allergen list rather than guessing when none are given", () => {
    const out = parseSuggestions(
      JSON.stringify({
        items: [{ name: "Plain Roti", ingredients: ["flour"], allergens: [] }],
      }),
    );
    expect(out.suggestions[0].allergens).toEqual([]);
  });

  it.each([
    ["prose", "I'm not sure what these dishes contain."],
    ["malformed JSON", '{"items": [ }'],
    ["wrong shape", '{"dishes": []}'],
  ])("fails safely on %s, suggesting nothing", (_label, input) => {
    const out = parseSuggestions(input);
    expect(out.ok).toBe(false);
    expect(out.suggestions).toHaveLength(0);
    expect(out.error).toBeTruthy();
  });
});

describe("SUGGESTION_PROMPT", () => {
  it("tells the model to leave an allergen out when unsure", () => {
    // The instruction the whole safety argument rests on: under-suggesting
    // is recoverable, over-suggesting is what hurts someone.
    expect(SUGGESTION_PROMPT).toMatch(/unsure/i);
    expect(SUGGESTION_PROMPT).toMatch(/LEAVE IT OUT/);
  });

  it("constrains allergens to the vocabulary the app can actually match", () => {
    for (const allergen of ALLERGEN_VOCABULARY) {
      expect(SUGGESTION_PROMPT).toContain(allergen);
    }
  });

  it("says a human reviews every allergen", () => {
    expect(SUGGESTION_PROMPT).toMatch(/human will review/i);
  });
});
