"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { reportError } from "@/lib/observability/report";
import { loadMenuGraph } from "./load";
import { allergenSuggestions } from "./suggest-core";

export interface SuggestAllergensState {
  error?: string;
  success?: string;
}

/**
 * "Find likely allergens" on the allergen review screen: runs the menu
 * knowledge graph over the whole menu and adds what it infers ("Palak
 * Paneer" → milk) to the review queue as unconfirmed suggestions, with the
 * reason. Nothing reaches a diner until an owner or manager confirms it
 * there. suggest_menu_allergens() checks the role again, skips what's
 * already on a dish, and never re-asks a rejected suggestion.
 */
export async function suggestAllergensFromMenu(
  restaurantId: string,
  _prev: SuggestAllergensState,
  _formData: FormData,
): Promise<SuggestAllergensState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };
  const supabase = auth.context.supabase as unknown as SupabaseClient;

  const { graph } = await loadMenuGraph(supabase, restaurantId, {
    wholeMenu: true,
  });
  const suggestions = allergenSuggestions(graph);
  if (suggestions.length === 0) {
    return {
      success:
        "Nothing new to suggest: no dish name or listed ingredient points to an allergen you haven't already marked.",
    };
  }

  const { data, error } = await supabase.rpc("suggest_menu_allergens", {
    p_restaurant_id: restaurantId,
    p_suggestions: suggestions,
  });
  if (error) {
    reportError(error, {
      scope: "allergens.suggest",
      extra: { restaurantId },
    });
    return {
      error: error.message.includes("ALLERGEN_FORBIDDEN")
        ? "Only an owner or manager can review allergens."
        : "Couldn't add the suggestions. Nothing was changed.",
    };
  }
  revalidatePath("/dashboard/menu/allergen-review");
  const added = Number(data ?? 0);
  return {
    success:
      added === 0
        ? "Nothing new to suggest: everything found is already on its dish or was turned down before."
        : `Found ${added} likely ${added === 1 ? "allergen" : "allergens"} to check. Each one says why below; confirm what's right.`,
  };
}
