import { z } from "zod";

/**
 * Turning a dish name into suggested ingredients and allergens.
 *
 * Pure and `server-only`-free so it is directly unit testable, like the
 * rest of this module.
 *
 * The two are treated very differently on purpose, and the difference is
 * not stylistic:
 *
 *   Ingredients are low stakes. "Paneer Paratha" almost certainly contains
 *   paneer and wheat flour; getting one wrong produces an odd list, and the
 *   restaurant fixes it. These are written straight in.
 *
 *   Allergens are not. A dish name cannot tell you whether THIS kitchen
 *   thickens its tikka masala with cashew paste. A confident "no nuts" to
 *   someone with a nut allergy is an ambulance. These are written as
 *   UNCONFIRMED and stay invisible to diners until a human ticks them —
 *   see 20260904140000_allergen_confirmation.sql.
 */

const suggestionSchema = z.object({
  items: z.array(
    z.object({
      name: z.string().trim().min(1).max(200),
      ingredients: z.array(z.string().trim().min(1).max(80)).max(30),
      allergens: z.array(z.string().trim().min(1).max(60)).max(15),
    }),
  ),
});

export interface ItemSuggestion {
  name: string;
  ingredients: string[];
  /** Always unconfirmed when written. Never shown to a diner until confirmed. */
  allergens: string[];
}

export interface SuggestionOutcome {
  ok: boolean;
  suggestions: ItemSuggestion[];
  error?: string;
}

/**
 * The allergen vocabulary suggestions are held to. A free-text allergen is
 * worse than none: "may contain traces" and "nuts?" cannot be matched,
 * filtered, or acted on, and a diner scanning for one word will miss them.
 */
export const ALLERGEN_VOCABULARY = [
  "Milk",
  "Eggs",
  "Fish",
  "Shellfish",
  "Tree nuts",
  "Peanuts",
  "Wheat",
  "Soy",
  "Sesame",
  "Mustard",
  "Celery",
  "Sulphites",
] as const;

export const SUGGESTION_PROMPT = `For each dish name, list its likely ingredients and likely allergens.

Return ONLY JSON, no prose:
{"items":[{"name":"...","ingredients":["..."],"allergens":["..."]}]}

Rules:
- "name" must exactly match the dish name you were given.
- "ingredients": the main components a typical version of this dish contains. Keep them short and singular, like "paneer", "wheat flour", "potato".
- "allergens": ONLY values from this list, and only where a typical version of the dish would contain them: ${ALLERGEN_VOCABULARY.join(", ")}.
- If you are unsure whether a dish contains an allergen, LEAVE IT OUT. A human will review every allergen before it is shown to anyone, and a missing suggestion is easy to add — a wrong one is dangerous.
- Do not invent dishes. Return one entry per dish name given, in the same order.`;

/**
 * Normalised for matching against a restaurant's existing allergen rows,
 * so "tree nuts", "Tree Nuts" and "TREE NUTS" are one thing.
 */
export function canonicalAllergen(raw: string): string | null {
  const needle = raw.trim().toLowerCase();
  const match = ALLERGEN_VOCABULARY.find((a) => a.toLowerCase() === needle);
  return match ?? null;
}

export function parseSuggestions(rawText: string): SuggestionOutcome {
  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return {
      ok: false,
      suggestions: [],
      error: "No suggestions were returned.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    return {
      ok: false,
      suggestions: [],
      error: "The suggestions came back unreadable. Please try again.",
    };
  }

  const result = suggestionSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      suggestions: [],
      error: "The suggestions came back in an unexpected shape.",
    };
  }

  const suggestions: ItemSuggestion[] = result.data.items.map((item) => ({
    name: item.name.trim(),
    // Deduplicated and lowercased: ingredient lists are free text, and
    // "Potato" twice in one dish is noise a reviewer has to clean up.
    ingredients: [
      ...new Set(
        item.ingredients.map((i) => i.trim().toLowerCase()).filter(Boolean),
      ),
    ],
    // Anything outside the vocabulary is DROPPED rather than passed
    // through. An allergen the app cannot match is one a diner filtering
    // for it will never see, which is the failure that matters here.
    allergens: [
      ...new Set(
        item.allergens
          .map((a) => canonicalAllergen(a))
          .filter((a): a is string => a !== null),
      ),
    ],
  }));

  return { ok: true, suggestions };
}
