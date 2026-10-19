/**
 * The Admin page's model Test (docs/admin.md, Phase 2): what each job's
 * test asks, and what counts as a pass. No `server-only` and no I/O, so
 * every rule here is unit-tested; src/lib/admin/model-test.ts makes the
 * calls.
 *
 * Each test sends one real request for its job, with the job's real
 * prompt, to the exact list being tried. Nothing is written anywhere: the
 * waiter answers from the sample menu below, the staff assistant's
 * command is read but never run, and drafts are thrown away.
 *
 * A pass means "does this job correctly in one clean try", the same bar
 * as scripts/vet-models-by-job.ts. It is not proof a model holds a long
 * conversation well (see that script's header), which is why the
 * catalogue notes which models have done that in the running app.
 */

import { isFreeModel } from "@/lib/translations/core";
import type { ParseOutcome } from "@/lib/menu-import/extraction";
import {
  ALLERGEN_VOCABULARY,
  SPICE_LEVELS,
  type SuggestionOutcome,
} from "@/lib/menu-import/suggestions";
import type { StaffIntent } from "@/lib/staff-assistant/intent";
import type { LoopToolOutcome } from "@/lib/ai/loop";
import {
  cleanModelList,
  jobInfo,
  type AiJob,
} from "@/lib/ai/model-settings-core";

export interface TestCheck {
  label: string;
  ok: boolean;
}

export interface ModelTestResult {
  job: AiJob;
  models: string[];
  passed: boolean;
  checks: TestCheck[];
  /** What the model said, shortened, so you can judge it yourself. */
  reply: string;
  /** The model that answered (a backup, when the main one was busy). */
  servedModel?: string;
  ms: number;
  /** In US dollars, as OpenRouter reports it. Null when it didn't say. */
  costUsd: number | null;
  /** Why it couldn't run at all (busy, timed out, not configured). */
  error?: string;
  /** It couldn't run because OpenRouter said the model was busy, which says nothing about the model. */
  busy?: true;
}

export const REPLY_EXCERPT_LENGTH = 600;

export function excerpt(text: string): string {
  const clean = text.trim();
  return clean.length > REPLY_EXCERPT_LENGTH
    ? `${clean.slice(0, REPLY_EXCERPT_LENGTH)}…`
    : clean;
}

// Waiter -------------------------------------------------------------------

export const WAITER_TEST_QUESTION = "What's vegetarian and not too spicy?";

/** The restaurant the waiter test runs against. Invented, not anyone's real menu. */
export const SAMPLE_RESTAURANT_NAME = "Sample Kitchen";

interface SampleDish {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  isVegetarian: boolean;
  isSpicy: boolean;
}

export const SAMPLE_MENU: readonly SampleDish[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Paneer Tikka",
    description: "Cottage cheese cubes marinated in yogurt, grilled.",
    price: 11.5,
    category: "Starters",
    isVegetarian: true,
    isSpicy: false,
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Dal Makhani",
    description: "Black lentils simmered overnight with butter and cream.",
    price: 10.25,
    category: "Mains",
    isVegetarian: true,
    isSpicy: false,
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    name: "Vegetable Korma",
    description: "Mixed vegetables in a mild cashew sauce.",
    price: 12,
    category: "Mains",
    isVegetarian: true,
    isSpicy: false,
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    name: "Chilli Paneer",
    description: "Paneer tossed with green chillies and peppers.",
    price: 12.5,
    category: "Mains",
    isVegetarian: true,
    isSpicy: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000005",
    name: "Chicken Chettinad",
    description: "Chicken in a fiery black-pepper masala.",
    price: 14.75,
    category: "Mains",
    isVegetarian: false,
    isSpicy: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000006",
    name: "Lamb Biryani",
    description: "Basmati rice layered with slow-cooked lamb.",
    price: 16.5,
    category: "Mains",
    isVegetarian: false,
    isSpicy: false,
  },
];

function dishSummary(d: SampleDish) {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    price: d.price,
    isVegetarian: d.isVegetarian,
    isVegan: false,
    isSpicy: d.isSpicy,
    dietaryClaims: [
      ...(d.isVegetarian ? ["vegetarian"] : []),
      ...(d.isSpicy ? ["spicy"] : []),
    ],
    category: d.category,
  };
}

/**
 * What the waiter's tools return during a Test: the sample menu, shaped
 * like the real tools' results. Anything that would change something (a
 * cart, an order, a call for staff) is refused, so a Test never can.
 */
export function sampleToolOutcome(
  name: string,
  args: unknown,
): LoopToolOutcome {
  const input = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "search_menu": {
      const query =
        typeof input.query === "string" ? input.query.toLowerCase() : "";
      // No dish here is vegan, halal or kosher.
      const filtered = SAMPLE_MENU.filter(
        (d) =>
          (input.dietary === undefined ||
            (input.dietary === "vegetarian" && d.isVegetarian)) &&
          (!input.spicyOnly || d.isSpicy),
      );
      const matched = filtered.filter((d) =>
        `${d.name} ${d.description} ${d.category}`
          .toLowerCase()
          .includes(query),
      );
      return {
        toolName: name,
        result: {
          ok: true,
          // Words that match no dish ("not spicy") are ignored rather than
          // returning nothing: the Test is about using the tool, not about
          // phrasing a search.
          data: {
            currency: "USD",
            items: (matched.length > 0 ? matched : filtered).map(dishSummary),
          },
        },
      };
    }
    case "get_menu_item": {
      const dish = SAMPLE_MENU.find((d) => d.id === input.menuItemId);
      return dish
        ? {
            toolName: name,
            result: {
              ok: true,
              data: {
                currency: "USD",
                ...dishSummary(dish),
                isAvailable: true,
                spiceLevel: dish.isSpicy ? "hot" : "mild",
                ingredients: [],
                allergens: [],
                modifierGroups: [],
              },
            },
          }
        : { toolName: name, result: { ok: false, error: "Item not found." } };
    }
    case "get_restaurant_info":
      return {
        toolName: name,
        result: {
          ok: true,
          data: {
            name: SAMPLE_RESTAURANT_NAME,
            description: "A sample menu for testing.",
            categories: ["Starters", "Mains"],
            isActive: true,
          },
        },
      };
    default:
      return {
        toolName: name,
        result: {
          ok: false,
          error: "Not available during a test. Answer from the menu tools.",
        },
      };
  }
}

/**
 * Phrases that mean the model narrated its reasoning or repeated its
 * instructions to a diner. Found live (scripts/vet-models-by-job.ts): a
 * model can call every tool correctly and still do this.
 */
export const LEAK_MARKERS = [
  /system note/i,
  /system prompt/i,
  /\bthe instructions?\b/i,
  /let me (re-?read|look at|check)/i,
  /I should (follow|call|use)/i,
  /according to the instructions/i,
  /my instructions/i,
];

const MENU_TOOLS = new Set(["search_menu", "get_menu_item"]);

export function gradeWaiter(input: {
  toolOutcomes: LoopToolOutcome[];
  finalText: string;
  refused: boolean;
  guardCorrectionExhausted: boolean;
}): TestCheck[] {
  const text = input.finalText.toLowerCase();
  const named = SAMPLE_MENU.filter((d) => text.includes(d.name.toLowerCase()));
  return [
    {
      label: "Looked the dishes up with the menu tool",
      ok: input.toolOutcomes.some(
        (o) => MENU_TOOLS.has(o.toolName) && o.result.ok,
      ),
    },
    {
      label: "Answered instead of declining",
      ok:
        !input.refused &&
        !input.guardCorrectionExhausted &&
        input.finalText.trim() !== "",
    },
    {
      label: "Named vegetarian dishes from the menu, none that aren't",
      ok: named.length > 0 && named.every((d) => d.isVegetarian),
    },
    {
      label: "Kept its instructions to itself",
      ok: !LEAK_MARKERS.some((re) => re.test(input.finalText)),
    },
  ];
}

// Staff assistant ----------------------------------------------------------

/** Not one of the built-in phrases, so only the model can read it. */
export const STAFF_TEST_COMMAND = "we've run out of paneer tikka for tonight";

export function gradeStaff(intent: StaffIntent): TestCheck[] {
  return [
    {
      label: "Read it as “sold out”",
      ok: intent.kind === "sold_out",
    },
    {
      label: "Picked out the right dish",
      ok:
        intent.kind === "sold_out" &&
        intent.target.toLowerCase().includes("paneer tikka"),
    },
  ];
}

// Menu photo reader --------------------------------------------------------

/** Ground truth for tests/fixtures/menu-board.jpg, as in scripts/vet-models-by-job.ts. */
export const BOARD_ITEMS: ReadonlyArray<readonly [string, number]> = [
  ["Samosa", 4.99],
  ["Onion Bhaji", 5.49],
  ["Chicken 65", 8.95],
  ["Chicken Biryani", 14.5],
  ["Paneer Butter Masala", 12.99],
  ["Lamb Rogan Josh", 16.75],
  ["Dal Tadka", 9.25],
  ["Butter Naan", 3.5],
  ["Garlic Naan", 4.25],
  ["Tandoori Roti", 2.99],
  ["Mango Lassi", 4.5],
  ["Masala Chai", 2.75],
];

/** Prices that must be read right for a pass: all but one, as when the defaults were vetted. */
export const BOARD_PASS_MARK = BOARD_ITEMS.length - 1;

export function countBoardPrices(parsed: ParseOutcome): {
  correct: number;
  invented: boolean;
} {
  // Whole normalised names, not first words: "chicken" would match both
  // Chicken 65 and Chicken Biryani.
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  let correct = 0;
  for (const [name, price] of BOARD_ITEMS) {
    const target = norm(name);
    const hit = parsed.drafts.find((d) => {
      const got = norm(d.name);
      return got.includes(target) || target.includes(got);
    });
    if (hit && hit.price !== null && Math.abs(hit.price - price) < 0.005) {
      correct += 1;
    }
  }
  // The board's last line, "Market price today - ask at counter", has no
  // price and must not come back with one.
  const invented = parsed.drafts.some(
    (d) => /market|counter|ask/i.test(d.name) && d.price !== null,
  );
  return { correct, invented };
}

export function gradeVision(parsed: ParseOutcome): TestCheck[] {
  const { correct, invented } = countBoardPrices(parsed);
  return [
    { label: "Returned a readable menu", ok: parsed.ok },
    {
      label: `Read ${correct} of ${BOARD_ITEMS.length} prices right (needs ${BOARD_PASS_MARK})`,
      ok: parsed.ok && correct >= BOARD_PASS_MARK,
    },
    { label: "Invented no price", ok: parsed.ok && !invented },
  ];
}

// Menu suggestions ---------------------------------------------------------

export const SUGGESTION_TEST_DISHES = [
  "Chicken Biryani",
  "Mango Lassi",
  "Paneer Tikka",
  "Masala Dosa",
  "Gulab Jamun",
];

export function gradeSuggestions(outcome: SuggestionOutcome): TestCheck[] {
  const returned = new Set(
    outcome.suggestions.map((s) => s.name.toLowerCase()),
  );
  const matched = SUGGESTION_TEST_DISHES.filter((d) =>
    returned.has(d.toLowerCase()),
  ).length;
  const allergensOk = outcome.suggestions.every((s) =>
    s.allergens.every((a) =>
      (ALLERGEN_VOCABULARY as readonly string[]).includes(a),
    ),
  );
  const spiceOk = outcome.suggestions.every(
    (s) =>
      s.spiceLevel === null ||
      (SPICE_LEVELS as readonly string[]).includes(s.spiceLevel),
  );
  const withIngredients = outcome.suggestions.filter(
    (s) => s.ingredients.length > 0,
  ).length;
  return [
    { label: "Returned readable suggestions", ok: outcome.ok },
    {
      label: `Covered ${matched} of ${SUGGESTION_TEST_DISHES.length} dishes`,
      ok: outcome.ok && matched === SUGGESTION_TEST_DISHES.length,
    },
    {
      label: "Listed ingredients for every dish",
      ok: outcome.ok && withIngredients >= SUGGESTION_TEST_DISHES.length,
    },
    {
      label: "Kept allergens and spice levels to the allowed lists",
      ok: outcome.ok && allergensOk && spiceOk,
    },
  ];
}

// AI drafts ----------------------------------------------------------------

export const DRAFT_TEST_FIELD = {
  key: "d1",
  kind: "dish description" as const,
  text: "Cottage cheese cubes marinated in yogurt and spices, grilled in the tandoor.",
};

export function gradeDraft(translations: Map<string, string>): TestCheck[] {
  const text = translations.get(DRAFT_TEST_FIELD.key) ?? "";
  return [
    {
      label: "Translated the description into Spanish",
      ok: text.trim() !== "" && text.trim() !== DRAFT_TEST_FIELD.text,
    },
  ];
}

// Shared -------------------------------------------------------------------

export function allPassed(checks: TestCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.ok);
}

/** "free", "0.8¢", "$1.20"; "cost unknown" when OpenRouter didn't report one. */
export function formatCost(usd: number | null): string {
  if (usd === null) return "cost unknown";
  if (usd === 0) return "free";
  const cents = usd * 100;
  if (cents < 100) {
    return `${cents < 0.1 ? cents.toFixed(2) : cents.toFixed(1)}¢`;
  }
  return `$${usd.toFixed(2)}`;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function sameModelList(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

/** OpenRouter's "any free model" alias: a different model each request, so a Test of it proves nothing. */
const UNTESTABLE = new Set(["openrouter/free"]);

/**
 * Why this list can't be tested or saved, or null if it can. Checked
 * before a Test (so no credit is spent on a list that couldn't be saved)
 * and again on Save. `known` is OpenRouter's current model list; null
 * means it couldn't be fetched.
 */
export function listProblem(input: {
  job: AiJob;
  models: readonly string[];
  provider: string;
  known: ReadonlySet<string> | null;
}): string | null {
  const named = input.models.map((m) => m.trim()).filter((m) => m !== "");
  const models = cleanModelList(named);
  if (models.length === 0) return "Choose a main model.";
  if (models.length !== named.length) return "The same model is listed twice.";
  if (models.length > 3) return "Choose at most three models.";
  if (input.job === "waiter" && input.provider !== "openrouter") {
    return "The waiter runs on Anthropic directly (AI_PROVIDER=anthropic), so its model is set in Vercel.";
  }
  const alias = models.find((m) => UNTESTABLE.has(m));
  if (alias) {
    return `${alias} picks a different model each time, so a Test can't vouch for it. Choose a specific model.`;
  }
  if (jobInfo(input.job).freeOnly) {
    const paid = models.find((m) => !isFreeModel(input.provider, m));
    if (paid) {
      return `${jobInfo(input.job).label} only uses free models, and ${paid} isn't free.`;
    }
  }
  if (input.known === null) {
    return "Couldn't check the model names with OpenRouter just now. Try again in a minute.";
  }
  const unknown = models.find((m) => !input.known!.has(m));
  if (unknown) {
    return `OpenRouter doesn't list ${unknown}. Check the spelling, or pick from the list.`;
  }
  return null;
}
