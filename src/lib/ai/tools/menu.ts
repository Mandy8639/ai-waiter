import "server-only";
import type { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getPublicRestaurantBySlug } from "@/lib/customer/restaurant";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";
import {
  searchMenuSchema,
  getMenuItemSchema,
  getRestaurantInfoSchema,
} from "./schemas";

/**
 * Every query below is scoped to `context.restaurantId` and reads through
 * the ordinary RLS-respecting per-request client — the exact same
 * active/available-only public storefront policies the customer-facing
 * menu pages already use (see docs/database.md#public-storefront-rls-batch-4).
 * An unavailable item or an inactive category is invisible here the same
 * way it's invisible on `/r/[restaurantSlug]/menu` — there is no
 * "AI-only" view of the menu that sees more than a customer browsing
 * normally would.
 */

async function searchMenu(
  args: z.infer<typeof searchMenuSchema>,
  context: ToolContext,
): Promise<ToolResult> {
  const supabase = await createClient();
  let query = supabase
    .from("menu_items")
    .select(
      "id, name, description, price, category_id, is_vegetarian, is_vegan, is_spicy",
    )
    .eq("restaurant_id", context.restaurantId)
    .eq("is_available", true)
    .order("display_order", { ascending: true })
    .limit(25);

  const search = args.query?.trim();
  if (search) {
    // Same deterministic ILIKE search the customer-facing menu page uses
    // — no embeddings, no vector search (spec: menu search must be
    // deterministic).
    const escaped = search.replace(/[%_]/g, (m) => `\\${m}`);
    query = query.or(`name.ilike.%${escaped}%,description.ilike.%${escaped}%`);
  }
  if (args.dietary === "vegetarian") query = query.eq("is_vegetarian", true);
  if (args.dietary === "vegan") query = query.eq("is_vegan", true);
  if (args.spicyOnly) query = query.eq("is_spicy", true);

  const { data } = await query;

  return {
    ok: true,
    data: {
      items: (data ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        price: Number(item.price),
        isVegetarian: item.is_vegetarian,
        isVegan: item.is_vegan,
        isSpicy: item.is_spicy,
      })),
    },
  };
}

async function getMenuItem(
  args: z.infer<typeof getMenuItemSchema>,
  context: ToolContext,
): Promise<ToolResult> {
  const supabase = await createClient();

  // .eq("restaurant_id", ...) is the tenant boundary here — a menu item
  // id belonging to a DIFFERENT restaurant simply matches zero rows, the
  // same "not found" a customer browsing that restaurant's own menu would
  // get for a bad id. There is no way for this tool to leak another
  // restaurant's item, no matter what id the model supplies.
  const { data: item } = await supabase
    .from("menu_items")
    .select(
      "id, name, description, price, is_available, category_id, is_vegetarian, is_vegan, is_spicy, spice_level, contains_nuts, contains_dairy, contains_gluten, preparation_time",
    )
    .eq("id", args.menuItemId)
    .eq("restaurant_id", context.restaurantId)
    .eq("is_available", true)
    .maybeSingle();

  if (!item) {
    return {
      ok: false,
      error: "That item isn't on the menu (or isn't currently available).",
    };
  }

  const [{ data: allergenLinks }, { data: groupRows }] = await Promise.all([
    supabase
      .from("menu_item_allergens")
      .select("allergen_id")
      .eq("menu_item_id", item.id),
    supabase
      .from("menu_item_modifiers")
      .select(
        "id, name, description, is_required, min_selections, max_selections",
      )
      .eq("menu_item_id", item.id)
      .order("display_order", { ascending: true }),
  ]);

  const allergenIds = (allergenLinks ?? []).map((l) => l.allergen_id);
  const groupIds = (groupRows ?? []).map((g) => g.id);

  const [{ data: allergens }, { data: optionRows }] = await Promise.all([
    allergenIds.length > 0
      ? supabase.from("allergens").select("name").in("id", allergenIds)
      : Promise.resolve({ data: [] as { name: string }[] }),
    groupIds.length > 0
      ? supabase
          .from("modifier_options")
          .select("id, modifier_id, name, price_adjustment, is_available")
          .in("modifier_id", groupIds)
      : Promise.resolve({
          data: [] as {
            id: string;
            modifier_id: string;
            name: string;
            price_adjustment: number;
            is_available: boolean;
          }[],
        }),
  ]);

  return {
    ok: true,
    data: {
      id: item.id,
      name: item.name,
      description: item.description,
      price: Number(item.price),
      isVegetarian: item.is_vegetarian,
      isVegan: item.is_vegan,
      isSpicy: item.is_spicy,
      spiceLevel: item.spice_level,
      containsNuts: item.contains_nuts,
      containsDairy: item.contains_dairy,
      containsGluten: item.contains_gluten,
      preparationTimeMinutes: item.preparation_time,
      // Empty array here means "the restaurant hasn't listed any
      // allergens for this item" — the model must treat that as
      // "unknown/not specified," never as "confirmed allergen-free" (see
      // the system prompt and docs/security.md#allergen-safety).
      declaredAllergens: (allergens ?? []).map((a) => a.name),
      modifierGroups: (groupRows ?? []).map((group) => ({
        id: group.id,
        name: group.name,
        isRequired: group.is_required,
        minSelections: group.min_selections,
        maxSelections: group.max_selections,
        options: (optionRows ?? [])
          .filter((o) => o.modifier_id === group.id && o.is_available)
          .map((o) => ({
            id: o.id,
            name: o.name,
            priceAdjustment: Number(o.price_adjustment),
          })),
      })),
    },
  };
}

async function getRestaurantInfo(
  _args: z.infer<typeof getRestaurantInfoSchema>,
  context: ToolContext,
): Promise<ToolResult> {
  const restaurant = await getPublicRestaurantBySlug(context.restaurantSlug);
  if (!restaurant)
    return { ok: false, error: "Restaurant information is unavailable." };

  return {
    ok: true,
    data: {
      name: restaurant.name,
      description: restaurant.description,
      address: restaurant.address,
      city: restaurant.city,
      state: restaurant.state,
      phone: restaurant.phone,
      isActive: restaurant.isActive,
    },
  };
}

export const menuTools: ToolDefinition[] = [
  {
    name: "search_menu",
    description:
      "Search this restaurant's currently available menu items by name/description text, dietary preference, or spiciness. Returns only items that are actually orderable right now.",
    schema: searchMenuSchema,
    execute: searchMenu as ToolDefinition["execute"],
  },
  {
    name: "get_menu_item",
    description:
      "Get full detail for one menu item by id (from a prior search_menu result) — description, price, dietary flags, declared allergens, and its modifier groups/options. Use this before adding an item to the cart if you need to know its required modifiers.",
    schema: getMenuItemSchema,
    execute: getMenuItem as ToolDefinition["execute"],
  },
  {
    name: "get_restaurant_info",
    description:
      "Get this restaurant's name, description, address, and phone number.",
    schema: getRestaurantInfoSchema,
    execute: getRestaurantInfo as ToolDefinition["execute"],
  },
];
