"use server";

import { switchedOffMessage } from "@/lib/admin/restaurant-switches-core";
import { isAiFeatureAllowed } from "@/lib/admin/restaurant-switches";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { parseNutrition, type EstimateDish } from "./core";
import { estimateNutrition } from "./estimate";
import { getNutritionReview } from "./queries";

/**
 * Nutrition (phase M). Owners and managers only; every write goes through
 * save_menu_item_nutrition()/confirm_menu_item_nutrition(). Saving always
 * makes a draft; only confirming publishes.
 */

export interface NutritionActionResult {
  error?: string;
  message?: string;
}

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

const PATH = "/dashboard/menu/nutrition";

async function authorize(restaurantId: string) {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { ok: false as const, error: auth.error };
  const supabase = auth.context.supabase;
  return {
    ok: true as const,
    rpc: supabase.rpc.bind(supabase) as unknown as Rpc,
    supabase,
  };
}

function friendly(message: string): string {
  if (message.includes("NUTRITION_FORBIDDEN")) {
    return "Only an owner or manager can edit nutrition.";
  }
  if (message.includes("NUTRITION_DISH_NOT_FOUND")) {
    return "That dish has been removed. Reload the page.";
  }
  if (message.includes("NUTRITION_NOT_FOUND")) {
    return "There's nothing to confirm yet — enter the numbers first.";
  }
  if (message.includes("calories_range")) {
    return "Calories have to be between 0 and 5,000 for one serving.";
  }
  if (message.includes("macros_range")) {
    return "Protein, carbs and fat have to be between 0 and 500 g for one serving.";
  }
  return "Couldn't save. Please try again.";
}

/** Rejects ids that aren't this restaurant's, before any write. */
type Authorized = Extract<Awaited<ReturnType<typeof authorize>>, { ok: true }>;

async function ownsDish(
  auth: Authorized,
  restaurantId: string,
  itemId: string,
): Promise<boolean> {
  const { data } = await auth.supabase
    .from("menu_items")
    .select("id")
    .eq("id", itemId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  return Boolean(data);
}

/**
 * A person types or edits the numbers. Saved as a draft; with `confirm`,
 * confirmed in the same step — the person is looking at the numbers they
 * just typed, which is what confirming means.
 */
export async function saveNutrition(
  restaurantId: string,
  itemId: string,
  input: {
    calories: string;
    proteinG: string;
    carbsG: string;
    fatG: string;
  },
  confirm: boolean,
): Promise<NutritionActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  if (!z.uuid().safeParse(itemId).success) {
    return { error: "Couldn't save. Please reload and try again." };
  }
  const parsed = parseNutrition(input);
  if (!parsed.ok) return { error: parsed.error };
  if (!(await ownsDish(auth, restaurantId, itemId))) {
    return { error: "That dish has been removed. Reload the page." };
  }

  const { error } = await auth.rpc("save_menu_item_nutrition", {
    p_menu_item_id: itemId,
    p_calories: parsed.value.calories,
    p_protein_g: parsed.value.proteinG,
    p_carbs_g: parsed.value.carbsG,
    p_fat_g: parsed.value.fatG,
    p_source: "owner",
  });
  if (error) return { error: friendly(error.message) };

  if (confirm) {
    const { error: confirmError } = await auth.rpc(
      "confirm_menu_item_nutrition",
      { p_menu_item_id: itemId },
    );
    if (confirmError) return { error: friendly(confirmError.message) };
  }
  revalidatePath(PATH);
  return {};
}

/** A person confirms the values as they stand (typically an AI estimate). Only this publishes. */
export async function confirmNutrition(
  restaurantId: string,
  itemId: string,
): Promise<NutritionActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  if (!z.uuid().safeParse(itemId).success) {
    return { error: "Couldn't confirm. Please reload and try again." };
  }
  if (!(await ownsDish(auth, restaurantId, itemId))) {
    return { error: "That dish has been removed. Reload the page." };
  }
  const { error } = await auth.rpc("confirm_menu_item_nutrition", {
    p_menu_item_id: itemId,
  });
  if (error) return { error: friendly(error.message) };
  revalidatePath(PATH);
  return {};
}

/** Remove a dish's nutrition; diners see none for it. */
export async function clearNutrition(
  restaurantId: string,
  itemId: string,
): Promise<NutritionActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  if (!z.uuid().safeParse(itemId).success) return {};
  const untyped = auth.supabase as unknown as {
    from: (table: string) => {
      delete: () => {
        eq: (
          c: string,
          v: string,
        ) => {
          eq: (
            c: string,
            v: string,
          ) => Promise<{ error: { message: string } | null }>;
        };
      };
    };
  };
  const { error } = await untyped
    .from("menu_item_nutrition")
    .delete()
    .eq("menu_item_id", itemId)
    .eq("restaurant_id", restaurantId);
  if (error) return { error: friendly(error.message) };
  revalidatePath(PATH);
  return {};
}

/**
 * How many dishes one press estimates, so a large menu can't outrun the
 * request: two batches at up to 45 s each fit the page's maxDuration.
 */
// Per press: four batches of 15, about 7-15 s each with thinking off
// (src/lib/ai/free-draft.ts), inside the page's 120 s.
const ESTIMATE_LIMIT = 60;
const BATCH_SIZE = 15;

/**
 * Estimates every dish that has no nutrition yet, using the free model.
 * Never touches numbers a person entered or confirmed, and never
 * publishes: every estimate lands as a draft.
 */
export async function estimateMissingNutrition(
  restaurantId: string,
): Promise<NutritionActionResult> {
  const auth = await authorize(restaurantId);
  if (!auth.ok) return { error: auth.error };
  if (!(await isAiFeatureAllowed(restaurantId, "owner_tools"))) {
    return { error: switchedOffMessage("owner_tools") };
  }

  const rows = await getNutritionReview(restaurantId);
  const todo = rows.filter((r) => r.state === "missing");
  if (todo.length === 0) {
    return { message: "Every dish already has nutrition to review." };
  }

  const batch = todo.slice(0, ESTIMATE_LIMIT);
  let saved = 0;
  let skipped = 0;
  let failedBatches = 0;
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    const chunk = batch.slice(i, i + BATCH_SIZE);
    const dishes: EstimateDish[] = chunk.map((row, j) => ({
      key: `d${i + j}`,
      name: row.name,
      description: row.description,
      category: row.category,
    }));
    const result = await estimateNutrition(dishes, restaurantId);
    if (!result.ok) {
      if (result.reason === "not_free") {
        return {
          error:
            "Estimating only runs on a free AI model, and a paid one is configured. Enter the numbers instead, or switch the AI back to a free model.",
        };
      }
      if (result.reason === "not_configured") {
        return { error: "The AI isn't set up for this restaurant." };
      }
      failedBatches += 1;
      continue;
    }
    for (const [j, row] of chunk.entries()) {
      const value = result.estimates.get(`d${i + j}`);
      if (!value) {
        skipped += 1;
        continue;
      }
      const { error } = await auth.rpc("save_menu_item_nutrition", {
        p_menu_item_id: row.itemId,
        p_calories: value.calories,
        p_protein_g: value.proteinG,
        p_carbs_g: value.carbsG,
        p_fat_g: value.fatG,
        p_source: "ai",
      });
      if (!error) saved += 1;
    }
  }

  revalidatePath(PATH);
  const left = todo.length - batch.length;
  if (saved === 0) {
    return {
      error:
        failedBatches > 0
          ? "The free AI model didn't answer. Try again in a minute."
          : "The AI couldn't give usable estimates for these dishes. Enter them from your recipes instead.",
    };
  }
  const parts = [
    `Estimated ${saved} ${saved === 1 ? "dish" : "dishes"}. Check each one against your recipe and confirm it — nothing is shown to diners until you do.`,
  ];
  if (skipped > 0) {
    parts.push(
      `${skipped} couldn't be estimated sensibly and ${skipped === 1 ? "is" : "are"} left for you to fill in.`,
    );
  }
  if (left > 0) parts.push(`${left} still to estimate — press again.`);
  return { message: parts.join(" ") };
}
