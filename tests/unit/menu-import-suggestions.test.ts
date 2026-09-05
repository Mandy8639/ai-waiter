import { describe, it, expect } from "vitest";
import {
  parseSuggestions,
  canonicalAllergen,
  ALLERGEN_VOCABULARY,
  SUGGESTION_PROMPT,
  PORTION_PROMPT,
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

describe("descriptions and prep times", () => {
  const raw = JSON.stringify({
    items: [
      {
        name: "Mango Lassi (16 oz)",
        description:
          "  Fresh mango blended with yogurt and a touch of cardamom.  ",
        prepTimeMinutes: 4,
        ingredients: ["mango"],
        allergens: ["Milk"],
      },
      {
        name: "Mystery Special",
        description: "   ",
        prepTimeMinutes: null,
        ingredients: [],
        allergens: [],
      },
    ],
  });

  it("keeps a description, trimmed", () => {
    const out = parseSuggestions(raw);
    expect(out.suggestions[0].description).toBe(
      "Fresh mango blended with yogurt and a touch of cardamom.",
    );
    expect(out.suggestions[0].prepTimeMinutes).toBe(4);
  });

  it("treats a blank description as none at all", () => {
    // A blank line on a menu looks like the restaurant forgot, where an
    // absent one looks like a choice.
    const out = parseSuggestions(raw);
    expect(out.suggestions[1].description).toBeNull();
    expect(out.suggestions[1].prepTimeMinutes).toBeNull();
  });

  it("still parses when the model omits the new fields entirely", () => {
    // Older/shorter completions must not fail the whole batch.
    const out = parseSuggestions(
      JSON.stringify({
        items: [{ name: "Plain Dosa", ingredients: ["rice"], allergens: [] }],
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.suggestions[0].description).toBeNull();
    expect(out.suggestions[0].prepTimeMinutes).toBeNull();
  });

  it("rejects an absurd prep time rather than writing it to the menu", () => {
    const out = parseSuggestions(
      JSON.stringify({
        items: [
          { name: "X", prepTimeMinutes: 9000, ingredients: [], allergens: [] },
        ],
      }),
    );
    expect(out.ok).toBe(false);
  });

  it("asks for one sentence, not a recipe", () => {
    expect(SUGGESTION_PROMPT).toMatch(/ONE short, appetising sentence/);
    expect(SUGGESTION_PROMPT).toMatch(/Do NOT write a recipe/);
  });

  it("keeps a portion note as the sentence it is", () => {
    const out = parseSuggestions(
      JSON.stringify({
        items: [
          {
            name: "Chicken Biryani",
            ingredients: ["rice"],
            allergens: [],
            portionNote:
              "One hungry person will finish it, or two can share it.",
          },
        ],
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.suggestions[0].portionNote).toBe(
      "One hungry person will finish it, or two can share it.",
    );
  });

  it("treats a blank portion note as no answer at all", () => {
    // Most dishes feed one person. Saying so on every line is noise, and
    // an empty string would print as an empty "Portion:" row.
    const out = parseSuggestions(
      JSON.stringify({
        items: [
          { name: "Samosa", ingredients: [], allergens: [], portionNote: "  " },
        ],
      }),
    );
    expect(out.suggestions[0].portionNote).toBeNull();
  });

  it("rejects a portion note longer than the column allows", () => {
    // The database has a 200-character check constraint. Failing here
    // beats failing on the INSERT halfway through a menu.
    const out = parseSuggestions(
      JSON.stringify({
        items: [
          {
            name: "X",
            ingredients: [],
            allergens: [],
            portionNote: "a".repeat(201),
          },
        ],
      }),
    );
    expect(out.ok).toBe(false);
  });

  it("reads a portion-only answer, which omits ingredients entirely", () => {
    // PORTION_PROMPT asks for name and portionNote alone. An absent
    // ingredient list there means "not asked", not "this dish has none".
    const out = parseSuggestions(
      JSON.stringify({
        items: [{ name: "Thali", portionNote: "Plenty for one." }],
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.suggestions[0].ingredients).toEqual([]);
    expect(out.suggestions[0].portionNote).toBe("Plenty for one.");
  });

  it("forbids the bare number in both prompts that ask for a portion", () => {
    // The whole reason this is text and not a serves-N integer: "Serves 2"
    // is wrong for half the table.
    for (const prompt of [SUGGESTION_PROMPT, PORTION_PROMPT]) {
      expect(prompt).toMatch(/NEVER answer with just "Serves 2"/);
      expect(prompt).toMatch(/how many people does this feed/);
    }
  });
});
