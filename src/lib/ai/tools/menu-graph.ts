import "server-only";
import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { loadMenuGraph } from "@/lib/menu-graph/load";
import {
  allergenCheckResult,
  pairingsResult,
} from "@/lib/menu-graph/tool-results";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";
import { checkMenuAllergensSchema, getPairingsSchema } from "./schemas";

/**
 * The waiter's two menu knowledge graph tools (src/lib/menu-graph):
 *
 * - check_menu_allergens: the whole menu sorted for a guest avoiding an
 *   allergen, each dish with the reason. "Not marked as containing" is
 *   handed over as exactly that, with the rule beside it, never as "free
 *   of": only the restaurant can say a dish is free of something.
 * - get_pairings: what this restaurant's guests actually order with a
 *   dish, as counts over recent visits.
 *
 * Both read through the diner's own RLS session, scoped by the context's
 * restaurant, like every other menu tool. The result shapes live in
 * tool-results.ts, shared with the waiter evaluation.
 */

async function checkMenuAllergens(
  args: z.infer<typeof checkMenuAllergensSchema>,
  context: ToolContext,
): Promise<ToolResult> {
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const { graph, currency } = await loadMenuGraph(
    supabase,
    context.restaurantId,
  );
  return allergenCheckResult(graph, currency, args);
}

async function getPairings(
  args: z.infer<typeof getPairingsSchema>,
  context: ToolContext,
): Promise<ToolResult> {
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const { graph, currency } = await loadMenuGraph(
    supabase,
    context.restaurantId,
  );
  return pairingsResult(graph, currency, args.menuItemId);
}

export const menuGraphTools: ToolDefinition[] = [
  {
    name: "check_menu_allergens",
    description:
      "Check the whole menu for a guest avoiding one or more allergens (e.g. 'I'm allergic to dairy, what can I eat?', 'anything without nuts?'). Returns the dishes the restaurant says contain them, dishes whose ingredients or name suggest them (with the reason), and dishes not marked as containing them. Use this for any allergy or 'without X' question about the menu as a whole; use get_menu_item for one specific dish.",
    schema: checkMenuAllergensSchema,
    execute: checkMenuAllergens as ToolDefinition["execute"],
  },
  {
    name: "get_pairings",
    description:
      "What this restaurant's guests most often order with a dish, from real orders (e.g. 'what goes well with the butter chicken?', 'what should I have with this?'). Takes a menu item id from search_menu.",
    schema: getPairingsSchema,
    execute: getPairings as ToolDefinition["execute"],
  },
];
