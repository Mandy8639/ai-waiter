import { z } from "zod";
import { extractJsonObject } from "./extraction";

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

/**
 * The heat ladder, matching the menu_items.spice_level check constraint.
 *
 * Suggested, never asserted. A dish name is decent evidence of heat —
 * "Peri Peri Fries" is not mild anywhere — but how hot a kitchen actually
 * makes its chaat is a fact about that kitchen. So the restaurant sees the
 * suggestion pre-selected and either confirms it or picks another, the
 * same shape as the allergen review, minus the confirmation gate: getting
 * heat wrong spoils a meal, it does not send anyone to hospital.
 */
export const SPICE_LEVELS = [
  "none",
  "mild",
  "medium",
  "hot",
  "very_hot",
] as const;

export type SpiceLevel = (typeof SPICE_LEVELS)[number];

const suggestionSchema = z.object({
  items: z.array(
    z.object({
      name: z.string().trim().min(1).max(200),
      // Defaulted rather than required so the same parser can read a
      // narrower answer — PORTION_PROMPT below asks for portion notes
      // alone, and an absent list there means "not asked", not "none".
      ingredients: z
        .array(z.string().trim().min(1).max(80))
        .max(30)
        .default([]),
      allergens: z.array(z.string().trim().min(1).max(60)).max(15).default([]),
      /**
       * One appetising sentence for the menu. Nullable because a model that
       * has nothing to say should say nothing rather than pad — an empty
       * description is honest, a generic one is noise on every dish.
       */
      description: z.string().trim().max(300).nullable().optional(),
      /**
       * Rough minutes from order to service. Capped at two hours: anything
       * beyond that is the model misreading the dish, not a slow kitchen.
       */
      prepTimeMinutes: z.number().int().min(1).max(120).nullable().optional(),
      /**
       * "How many people does this feed?", answered the way a waiter
       * answers it. Capped to match the database check constraint.
       */
      portionNote: z.string().trim().max(200).nullable().optional(),
      /**
       * How hot the dish is. Constrained to the ladder the database
       * already stores, because a free-text heat level is one the app
       * cannot filter on — the same reason allergens use a fixed
       * vocabulary. Never written as fact: a restaurant confirms or
       * changes it before it reaches a diner.
       */
      spiceLevel: z.enum(SPICE_LEVELS).nullable().optional(),
    }),
  ),
});

export interface ItemSuggestion {
  name: string;
  ingredients: string[];
  /** Always unconfirmed when written. Never shown to a diner until confirmed. */
  allergens: string[];
  /** One menu sentence, or null when the model had nothing worth saying. */
  description: string | null;
  /** Rough minutes, or null. */
  prepTimeMinutes: number | null;
  /** Plain-language portion answer, or null when the dish plainly feeds one. */
  portionNote: string | null;
  /** Suggested heat, or null when the dish name gives no clue. Always reviewed. */
  spiceLevel: SpiceLevel | null;
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

/**
 * The one rule in this file that exists because of how a person asked the
 * question, not because of a data shape.
 *
 * Asked "how many does the biryani feed?", a waiter does not say "two".
 * They say it depends on you — one big appetite finishes it, two smaller
 * ones share it. A model told to estimate a number produces the flatly
 * confident answer that is wrong for half the table, so the instruction
 * asks for the hedge explicitly and forbids the bare number.
 *
 * Shared by both prompts below so the two paths cannot drift apart.
 */
const PORTION_RULE = `a ONE-sentence, plain answer to "how many people does this feed?", written the way a waiter would say it out loud.

- Allow for appetite instead of stating a bare number. NEVER answer with just "Serves 2" or a number on its own.
- Ground it in what the dish actually IS. If the name gives you a count or a size — "9 pcs", "with 2 Roti", "16 oz" — build the answer around it: "Nine pieces, so comfortably two people picking, or one if you're making a meal of it." A dish whose name tells you nothing specific about quantity should usually get null instead of a vague answer.
- VARY THE WORDING. These sentences sit next to each other on one menu; the same sentence repeated across twenty dishes reads like a fault, not a service.
- Single-serving drinks are NOT shared. A cup of tea, a glass of juice, a shake, a 16 oz anything — use null. Only a jug, pitcher or an explicitly large sharing format gets a note.
- Only fill this in where the question genuinely comes up: biryanis, thalis, platters, piece counts, family-size dishes, combos that arrive with bread. For anything obviously one person's order — a single samosa, one roti, a cup of chai — use null. Most dishes should be null.`;

/**
 * Portion notes ALONE, for a menu whose ingredients, allergens and
 * descriptions are already written.
 *
 * Re-running the full prompt over such a menu would cost nothing in
 * database writes (only empty fields are filled) but a great deal in human
 * attention: every re-asked dish yields fresh allergen suggestions, and
 * each one puts a row back in front of a person who has already reviewed
 * that dish. Asking a narrower question is the cheaper thing to do.
 */
export const PORTION_PROMPT = `For each dish name, say how much food it is.

Return ONLY JSON, no prose:
{"items":[{"name":"...","portionNote":"..."}]}

Rules:
- "name" must exactly match the dish name you were given.
- "portionNote": ${PORTION_RULE}
- Return one entry per dish name given, in the same order. Do not invent dishes.`;

/**
 * Heat levels ALONE, for a menu whose other details are already written.
 * Same trade as PORTION_PROMPT: a narrower question costs less and puts
 * nothing new in front of a reviewer who has finished with those dishes.
 */
export const SPICE_PROMPT = `For each dish name, say how hot it is.

Return ONLY JSON, no prose:
{"items":[{"name":"...","spiceLevel":"..."}]}

Rules:
- "name" must exactly match the dish name you were given.
- "spiceLevel": one of ${SPICE_LEVELS.join(", ")}. "none" means not spicy at all, "very_hot" means punishing. Judge the dish, not the cuisine — a mango lassi, a plain roti and a sweet dessert are all "none" no matter which country the menu comes from, and a dish is only "hot" if a typical version really is. Use null only if the name genuinely tells you nothing.
- Return one entry per dish name given, in the same order. Do not invent dishes.`;

export const SUGGESTION_PROMPT = `For each dish name, describe it and list its likely ingredients and likely allergens.

Return ONLY JSON, no prose:
{"items":[{"name":"...","description":"...","prepTimeMinutes":0,"portionNote":"...","spiceLevel":"...","ingredients":["..."],"allergens":["..."]}]}

Rules:
- "name" must exactly match the dish name you were given.
- "description": ONE short, appetising sentence a customer would read on a menu — what it is and what it tastes like. For example: "Fresh mango blended with yogurt and a touch of cardamom." Do NOT write a recipe, cooking steps, quantities, or marketing superlatives like "best" or "famous". If the dish name tells you nothing useful, use null rather than padding.
- "prepTimeMinutes": roughly how long this takes from order to serving, as a whole number. A blended drink is 2-5, a fried snack 10-15, a thali 20-30. Use null if you genuinely cannot tell.
- "portionNote": ${PORTION_RULE}
- "spiceLevel": how hot a typical version of this dish is, as one of: ${SPICE_LEVELS.join(", ")}. "none" means not spicy at all, "very_hot" means punishing. Judge the dish, not the cuisine — a mango lassi is "none" on any menu. Use null only if the name genuinely gives you nothing to go on.
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
  // The balanced-brace scanner from extraction.ts, not indexOf/lastIndexOf:
  // this model reasons before answering, and a stray brace in that prose
  // would otherwise swallow or truncate the real object.
  const json = extractJsonObject(rawText);
  if (!json) {
    return {
      ok: false,
      suggestions: [],
      error: "No suggestions were returned.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
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
    // Empty string is treated as "nothing to say", the same as null: a
    // blank description on a menu is worse than none, because it looks
    // like the restaurant forgot rather than chose not to.
    description: item.description?.trim() ? item.description.trim() : null,
    prepTimeMinutes: item.prepTimeMinutes ?? null,
    portionNote: item.portionNote?.trim() ? item.portionNote.trim() : null,
    spiceLevel: item.spiceLevel ?? null,
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
