/**
 * Nutrition (phase M), the parts with no database and no network: what a
 * valid set of numbers is, when numbers don't add up, how they're shown,
 * and how an AI estimate is asked for and checked. Unit-tested.
 *
 * The database refuses impossible numbers itself (20261005090000); the
 * limits here mirror it so the owner gets a sentence, not a constraint
 * name.
 */

export interface Nutrition {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export const NUTRITION_LIMITS = {
  calories: 5000,
  grams: 500,
} as const;

export type NutritionParse =
  { ok: true; value: Nutrition } | { ok: false; error: string };

function grams(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  // numeric(5,1): one decimal place.
  return Math.round(n * 10) / 10;
}

/** Checks numbers a person typed (or the AI returned) against the hard limits. */
export function parseNutrition(input: {
  calories: unknown;
  proteinG: unknown;
  carbsG: unknown;
  fatG: unknown;
}): NutritionParse {
  const calories = grams(input.calories);
  const proteinG = grams(input.proteinG);
  const carbsG = grams(input.carbsG);
  const fatG = grams(input.fatG);
  if (
    calories === null ||
    proteinG === null ||
    carbsG === null ||
    fatG === null
  ) {
    return { ok: false, error: "Fill in calories, protein, carbs and fat." };
  }
  if (calories !== Math.round(calories)) {
    return { ok: false, error: "Calories are a whole number." };
  }
  if (calories < 0 || calories > NUTRITION_LIMITS.calories) {
    return {
      ok: false,
      error: `Calories have to be between 0 and ${NUTRITION_LIMITS.calories.toLocaleString("en-US")} for one serving.`,
    };
  }
  for (const g of [proteinG, carbsG, fatG]) {
    if (g < 0 || g > NUTRITION_LIMITS.grams) {
      return {
        ok: false,
        error: `Protein, carbs and fat have to be between 0 and ${NUTRITION_LIMITS.grams} g for one serving.`,
      };
    }
  }
  return { ok: true, value: { calories, proteinG, carbsG, fatG } };
}

/** Calories the macronutrients account for: 4 kcal/g protein and carbohydrate, 9 kcal/g fat. */
export function atwaterCalories(n: Omit<Nutrition, "calories">): number {
  return Math.round(n.proteinG * 4 + n.carbsG * 4 + n.fatG * 9);
}

/**
 * Do the numbers add up? Fibre, sugar alcohols, alcohol and rounding all
 * move real labels off 4/4/9, so this allows 20% (and 30 kcal, for small
 * servings) before flagging. A flag is shown to the owner, never refused:
 * they may know better. The likely causes of a flag are a typo or a
 * made-up AI number, which is exactly what a person should look at twice.
 */
export function nutritionMismatch(n: Nutrition): {
  expected: number;
  mismatch: boolean;
} {
  const expected = atwaterCalories(n);
  const tolerance = Math.max(30, expected * 0.2);
  return { expected, mismatch: Math.abs(n.calories - expected) > tolerance };
}

function trimGrams(g: number): string {
  return Number.isInteger(g) ? String(g) : g.toFixed(1);
}

/** "520 kcal · 18 g protein · 64 g carbs · 21 g fat" */
export function nutritionSummary(n: Nutrition): string {
  return `${n.calories} kcal · ${trimGrams(n.proteinG)} g protein · ${trimGrams(n.carbsG)} g carbs · ${trimGrams(n.fatG)} g fat`;
}

export function nutritionRows(
  n: Nutrition,
): Array<{ label: string; value: string }> {
  return [
    { label: "Calories", value: `${n.calories} kcal` },
    { label: "Protein", value: `${trimGrams(n.proteinG)} g` },
    { label: "Carbohydrate", value: `${trimGrams(n.carbsG)} g` },
    { label: "Fat", value: `${trimGrams(n.fatG)} g` },
  ];
}

/** Where a row came from, and whether anyone has looked at it. */
export type NutritionState = "missing" | "draft" | "confirmed";

export function nutritionState(
  row: { confirmedAt: string | null } | null,
): NutritionState {
  if (!row) return "missing";
  return row.confirmedAt ? "confirmed" : "draft";
}

// AI estimates ------------------------------------------------------------------

export interface EstimateDish {
  key: string;
  name: string;
  description: string | null;
  category: string | null;
}

export function estimatePrompt(dishes: EstimateDish[]) {
  const system = [
    "You estimate nutrition for one restaurant serving of each dish.",
    "Return ONLY a JSON object mapping each key to",
    '{"calories": integer kcal, "protein_g": number, "carbs_g": number, "fat_g": number},',
    "with no other text.",
    "Rules:",
    "- One typical restaurant serving, as described. If the description gives a size or count, use it.",
    "- Calories must agree with 4 kcal per gram of protein and carbohydrate and 9 per gram of fat.",
    "- If you cannot make a reasonable estimate (for example the name alone says nothing about the dish), use null for that key.",
    "- These are rough drafts a person will check against their recipe before anyone sees them.",
  ].join("\n");
  const user = JSON.stringify(
    Object.fromEntries(
      dishes.map((d) => [
        d.key,
        {
          dish: d.name,
          ...(d.description ? { description: d.description } : {}),
          ...(d.category ? { section: d.category } : {}),
        },
      ]),
    ),
  );
  return { system, user };
}

/**
 * Pulls the estimates out of a model's reply. Anything missing, null,
 * outside the hard limits — or that doesn't add up, which for a model is
 * the tell of a number it made up rather than worked out — is dropped. A
 * dropped dish just stays "no nutrition" for the owner to fill in.
 */
export function parseEstimateReply(
  reply: string,
  dishes: EstimateDish[],
): Map<string, Nutrition> {
  const out = new Map<string, Nutrition>();
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;

  for (const dish of dishes) {
    const raw = (parsed as Record<string, unknown>)[dish.key];
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const calories =
      typeof r.calories === "number" ? Math.round(r.calories) : r.calories;
    const result = parseNutrition({
      calories,
      proteinG: r.protein_g,
      carbsG: r.carbs_g,
      fatG: r.fat_g,
    });
    if (!result.ok) continue;
    if (result.value.calories === 0) continue;
    if (nutritionMismatch(result.value).mismatch) continue;
    out.set(dish.key, result.value);
  }
  return out;
}
