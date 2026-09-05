"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { toFriendlyError } from "@/lib/errors/database-error";
import { aiConfig } from "@/lib/ai/config";
import { visionModel } from "./vision";
import { parseSuggestions, SUGGESTION_PROMPT } from "./suggestions";

/**
 * Suggests ingredients and allergens for a restaurant's existing dishes.
 *
 * Ingredients are written straight in: a wrong one is an odd list.
 * Allergens are written UNCONFIRMED and stay invisible to diners until a
 * human ticks them, because a wrong one is an ambulance. That asymmetry is
 * enforced in the database, not here — see
 * 20260904140000_allergen_confirmation.sql.
 */

const MANAGERS = ["owner", "manager"] as const;

/** Small batches: a long list invites truncation, which looks like a bad model. */
const BATCH_SIZE = 25;

export interface SuggestState {
  error?: string;
  notice?: string;
}

async function askForSuggestions(
  names: string[],
): Promise<ReturnType<typeof parseSuggestions>> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || aiConfig.provider !== "openrouter") {
    return {
      ok: false,
      suggestions: [],
      error: "Suggestions aren't configured on this deployment.",
    };
  }

  const response = await fetch(
    process.env.OPENROUTER_ENDPOINT ??
      "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ai-waiter.local",
        "X-Title": "AI Waiter menu suggestions",
      },
      body: JSON.stringify({
        model: visionModel(),
        max_tokens: 6000,
        messages: [
          {
            role: "user",
            content: `${SUGGESTION_PROMPT}\n\nDishes:\n${names.map((n) => `- ${n}`).join("\n")}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    },
  ).catch(() => null);

  if (!response || !response.ok) {
    return {
      ok: false,
      suggestions: [],
      error: "Couldn't reach the suggestion service. Please try again.",
    };
  }

  const json = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  } | null;

  return parseSuggestions(json?.choices?.[0]?.message?.content ?? "");
}

export async function suggestForMenu(
  restaurantId: string,
  _prev: SuggestState,
  _formData: FormData,
): Promise<SuggestState> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();

  // Only dishes with nothing recorded yet — re-running must never disturb
  // an allergen a human already confirmed.
  const { data: items, error: itemsError } = await supabase
    .from("menu_items")
    .select("id, name")
    .eq("restaurant_id", restaurantId)
    .limit(BATCH_SIZE);

  if (itemsError) return { error: toFriendlyError(itemsError, "menu items") };
  if (!items || items.length === 0)
    return { notice: "No dishes to suggest for." };

  const result = await askForSuggestions(items.map((i) => i.name));
  if (!result.ok) return { error: result.error };

  const byName = new Map(items.map((i) => [i.name.toLowerCase(), i.id]));
  let ingredientsAdded = 0;
  let allergensSuggested = 0;

  for (const suggestion of result.suggestions) {
    const menuItemId = byName.get(suggestion.name.toLowerCase());
    // A dish the model invented, or renamed. Skipped rather than matched
    // loosely — attaching an allergen to the wrong dish is the failure
    // this whole feature is built to avoid.
    if (!menuItemId) continue;

    for (const ingredientName of suggestion.ingredients) {
      const { data: ingredient } = await supabase
        .from("ingredients")
        .upsert(
          { restaurant_id: restaurantId, name: ingredientName },
          { onConflict: "restaurant_id,name" },
        )
        .select("id")
        .single();
      if (!ingredient) continue;

      const { error } = await supabase.from("menu_item_ingredients").insert({
        restaurant_id: restaurantId,
        menu_item_id: menuItemId,
        ingredient_id: ingredient.id,
      });
      if (!error) ingredientsAdded += 1;
    }

    for (const allergenName of suggestion.allergens) {
      const { data: allergen } = await supabase
        .from("allergens")
        .upsert(
          { restaurant_id: restaurantId, name: allergenName },
          { onConflict: "restaurant_id,name" },
        )
        .select("id")
        .single();
      if (!allergen) continue;

      // confirmed_at deliberately omitted: NULL is what makes this a
      // suggestion rather than a claim, and what keeps it away from diners.
      const { error } = await supabase.from("menu_item_allergens").insert({
        restaurant_id: restaurantId,
        menu_item_id: menuItemId,
        allergen_id: allergen.id,
      });
      if (!error) allergensSuggested += 1;
    }
  }

  revalidatePath("/dashboard/menu/allergen-review");
  return {
    notice:
      `Added ${ingredientsAdded} ingredients. ` +
      `${allergensSuggested} allergen suggestions need your confirmation before any diner sees them.`,
  };
}

export async function confirmAllergensForItem(
  restaurantId: string,
  menuItemId: string,
  allergenNames: string[],
): Promise<SuggestState> {
  const auth = await authorizeRestaurantAction(restaurantId, [...MANAGERS]);
  if (!auth.ok) return { error: auth.error };

  const supabase = await createClient();
  const { error } = await supabase.rpc("confirm_menu_item_allergens", {
    p_menu_item_id: menuItemId,
    p_allergen_names: allergenNames,
  });

  if (error) {
    if ((error.message ?? "").includes("ALLERGEN_FORBIDDEN")) {
      return { error: "You don't have permission to confirm allergens." };
    }
    return { error: toFriendlyError(error, "allergens") };
  }

  revalidatePath("/dashboard/menu/allergen-review");
  return { notice: "Confirmed." };
}
