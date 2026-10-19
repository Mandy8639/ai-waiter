"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { ALLERGEN_VOCABULARY } from "@/lib/menu-import/suggestions";
import { getDraftNutrition } from "@/lib/nutrition/queries";
import { nutritionSignature } from "./reviewed-core";

/**
 * "Confirm all reviewed" for the allergen and nutrition screens. Each dish
 * is still confirmed on its own, by the same confirm_menu_item_*()
 * function the per-dish button calls, as the signed-in reviewer. Only the
 * dishes the reviewer marked are sent; see reviewed-core.ts.
 */

export interface ConfirmReviewedResult {
  /** Dishes now confirmed. */
  confirmedIds: string[];
  /** Nutrition only: dishes whose numbers changed after they were marked, left as drafts. */
  changedIds: string[];
  error?: string;
}

/** A whole menu, with room to spare; anything bigger is not a real request. */
const MAX_DISHES = 1000;
/** Confirmations in flight at once — quick for 200 dishes, gentle on the database. */
const AT_ONCE = 8;

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ error: { message: string } | null }>;

async function inBatches<T>(
  items: T[],
  run: (item: T) => Promise<boolean>,
): Promise<T[]> {
  const done: T[] = [];
  for (let i = 0; i < items.length; i += AT_ONCE) {
    const batch = items.slice(i, i + AT_ONCE);
    const results = await Promise.all(batch.map(run));
    batch.forEach((item, j) => {
      if (results[j]) done.push(item);
    });
  }
  return done;
}

const allergenItemsSchema = z
  .array(
    z.object({
      menuItemId: z.uuid(),
      allergenNames: z.array(
        z.enum(ALLERGEN_VOCABULARY as unknown as [string, ...string[]]),
      ),
    }),
  )
  .min(1)
  .max(MAX_DISHES);

export async function confirmReviewedAllergens(
  restaurantId: string,
  items: Array<{ menuItemId: string; allergenNames: string[] }>,
): Promise<ConfirmReviewedResult> {
  const empty = { confirmedIds: [], changedIds: [] };
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { ...empty, error: auth.error };

  const parsed = allergenItemsSchema.safeParse(items);
  if (!parsed.success) {
    return {
      ...empty,
      error: "Couldn't confirm. Please reload and try again.",
    };
  }

  const supabase = auth.context.supabase;
  // Only this restaurant's dishes; confirm_menu_item_allergens() checks
  // the caller's role per dish as well.
  const { data: owned } = await supabase
    .from("menu_items")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .in(
      "id",
      parsed.data.map((i) => i.menuItemId),
    );
  const ownedIds = new Set((owned ?? []).map((r) => r.id));

  const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;
  const confirmed = await inBatches(
    parsed.data.filter((i) => ownedIds.has(i.menuItemId)),
    async (item) => {
      const { error } = await rpc("confirm_menu_item_allergens", {
        p_menu_item_id: item.menuItemId,
        p_allergen_names: item.allergenNames,
      });
      return !error;
    },
  );

  revalidatePath("/dashboard/menu/allergen-review");
  const confirmedIds = confirmed.map((i) => i.menuItemId);
  return {
    confirmedIds,
    changedIds: [],
    error:
      confirmedIds.length < parsed.data.length
        ? "Some dishes couldn't be confirmed. They're still marked reviewed — try again."
        : undefined,
  };
}

const nutritionItemsSchema = z
  .array(z.object({ itemId: z.uuid(), signature: z.string().max(100) }))
  .min(1)
  .max(MAX_DISHES);

export async function confirmReviewedNutrition(
  restaurantId: string,
  items: Array<{ itemId: string; signature: string }>,
): Promise<ConfirmReviewedResult> {
  const empty = { confirmedIds: [], changedIds: [] };
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { ...empty, error: auth.error };

  const parsed = nutritionItemsSchema.safeParse(items);
  if (!parsed.success) {
    return {
      ...empty,
      error: "Couldn't confirm. Please reload and try again.",
    };
  }

  // Scoped to this restaurant's unconfirmed rows, and compared with what
  // the reviewer saw: numbers that changed since (an edit elsewhere, a new
  // estimate) are left as drafts for another look.
  const drafts = await getDraftNutrition(
    restaurantId,
    parsed.data.map((i) => i.itemId),
  );
  const unchanged = parsed.data.filter((i) => {
    const draft = drafts.get(i.itemId);
    return draft !== undefined && nutritionSignature(draft) === i.signature;
  });
  const changedIds = parsed.data
    .filter((i) => {
      const draft = drafts.get(i.itemId);
      return draft !== undefined && nutritionSignature(draft) !== i.signature;
    })
    .map((i) => i.itemId);

  const supabase = auth.context.supabase;
  const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;
  const confirmed = await inBatches(unchanged, async (item) => {
    const { error } = await rpc("confirm_menu_item_nutrition", {
      p_menu_item_id: item.itemId,
    });
    return !error;
  });

  revalidatePath("/dashboard/menu/nutrition");
  const confirmedIds = confirmed.map((i) => i.itemId);
  return {
    confirmedIds,
    changedIds,
    error:
      confirmedIds.length < unchanged.length
        ? "Some dishes couldn't be confirmed. They're still marked reviewed — try again."
        : undefined,
  };
}
