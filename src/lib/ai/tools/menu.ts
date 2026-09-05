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

/**
 * The restaurant's own currency code, for any tool that returns a price.
 *
 * Read per call rather than threaded through ToolContext: it is one
 * indexed lookup on a row these queries already touch, and putting it in
 * the context would mean every future tool has to remember to include it.
 */
async function restaurantCurrency(
  supabase: Awaited<ReturnType<typeof createClient>>,
  restaurantId: string,
): Promise<string> {
  const { data } = await supabase
    .from("restaurants")
    .select("currency")
    .eq("id", restaurantId)
    .maybeSingle();
  return data?.currency ?? "USD";
}

async function searchMenu(
  args: z.infer<typeof searchMenuSchema>,
  context: ToolContext,
): Promise<ToolResult> {
  const supabase = await createClient();

  // Categories are how a restaurant already groups its own menu, which
  // makes them the only vocabulary available for "something light" or
  // "just a snack" that isn't the model's opinion about the food. Read
  // first so the name the model passed can be resolved to an id, and so
  // every result can carry the category it belongs to.
  const { data: categoryRows } = await supabase
    .from("categories")
    .select("id, name")
    .eq("restaurant_id", context.restaurantId)
    .eq("is_active", true);

  const wanted = args.category?.trim().toLowerCase();
  const matchedCategory = wanted
    ? (categoryRows ?? []).find((c) => c.name.toLowerCase() === wanted)
    : undefined;

  // An unrecognised category name returns nothing rather than silently
  // ignoring the filter and answering about the whole menu — a waiter
  // that says "we don't have a category called that" is recoverable, one
  // that lists desserts when asked for soups is not.
  if (wanted && !matchedCategory) {
    return {
      ok: true,
      data: {
        items: [],
        note: `This restaurant has no menu category called "${args.category}". Its categories are: ${(categoryRows ?? []).map((c) => c.name).join(", ")}.`,
      },
    };
  }

  let query = supabase
    .from("menu_items")
    .select(
      "id, name, description, price, category_id, is_vegetarian, is_vegan, is_spicy",
    )
    .eq("restaurant_id", context.restaurantId)
    .eq("is_available", true)
    .order("display_order", { ascending: true })
    .limit(25);

  if (matchedCategory) query = query.eq("category_id", matchedCategory.id);

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

  const categoryName = new Map((categoryRows ?? []).map((c) => [c.id, c.name]));

  return {
    ok: true,
    data: {
      // Sent with every price-bearing result, because a bare number is an
      // invitation to guess. Asked to recommend from an Indian menu, the
      // model quoted "₹9.99" for a dish the app prices at $9.99 — it
      // inferred a currency from the cuisine. A customer reading that in
      // chat and seeing dollars on the menu has been told a wrong price.
      currency: await restaurantCurrency(supabase, context.restaurantId),
      items: (data ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        price: Number(item.price),
        isVegetarian: item.is_vegetarian,
        isVegan: item.is_vegan,
        isSpicy: item.is_spicy,
        // The restaurant's own grouping, carried through so the model can
        // say "that's one of their chaats" without guessing.
        category: categoryName.get(item.category_id) ?? null,
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
  const { data: item, error } = await supabase
    .from("menu_items")
    .select(
      "id, name, description, price, is_available, category_id, is_vegetarian, is_vegan, is_spicy, spice_level, contains_nuts, contains_dairy, contains_gluten, preparation_time, portion_note",
    )
    .eq("id", args.menuItemId)
    .eq("restaurant_id", context.restaurantId)
    .eq("is_available", true)
    .maybeSingle();

  // A genuine query failure (network/DB error) is distinct from a clean
  // zero-row result — never surface the raw Postgres/Supabase error (which
  // could include schema/column details) to the model or customer; this
  // is deliberately a different message from the "not found" one below so
  // the model can tell "try again" apart from "this ID is wrong."
  if (error) {
    return {
      ok: false,
      error: "Couldn't look up that item right now — please try again.",
    };
  }

  if (!item) {
    return {
      ok: false,
      error: "That item isn't on the menu (or isn't currently available).",
    };
  }

  const [
    { data: ingredientLinks },
    { data: allergenLinks },
    { data: groupRows },
  ] = await Promise.all([
    // Ingredients, unlike allergens, are NOT confirmation-gated. They are
    // written directly (see docs/menu-import.md): a wrong ingredient is an
    // odd list a restaurant corrects, where a wrong allergen is an
    // ambulance. Different stakes, different gate.
    supabase
      .from("menu_item_ingredients")
      .select("ingredient_id")
      .eq("menu_item_id", item.id),
    supabase
      .from("menu_item_allergens")
      .select("allergen_id")
      .eq("menu_item_id", item.id)
      // Confirmed allergens only. An unconfirmed row is a SUGGESTION —
      // typically inferred from a dish name during menu import — and this
      // platform never states an allergen on its own authority. Omitting it
      // makes the app say "the menu doesn't specify, check with staff",
      // which is the safe answer; including it would be an assertion a
      // diner with an allergy acts on. See
      // supabase/migrations/20260904140000_allergen_confirmation.sql.
      .not("confirmed_at", "is", null),
    supabase
      .from("menu_item_modifiers")
      .select(
        "id, name, description, is_required, min_selections, max_selections",
      )
      .eq("menu_item_id", item.id)
      .order("display_order", { ascending: true }),
  ]);

  const ingredientIds = (ingredientLinks ?? []).map((l) => l.ingredient_id);
  const allergenIds = (allergenLinks ?? []).map((l) => l.allergen_id);
  const groupIds = (groupRows ?? []).map((g) => g.id);

  const [{ data: ingredients }, { data: allergens }, { data: optionRows }] =
    await Promise.all([
      ingredientIds.length > 0
        ? supabase.from("ingredients").select("name").in("id", ingredientIds)
        : Promise.resolve({ data: [] as { name: string }[] }),
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
      currency: await restaurantCurrency(supabase, context.restaurantId),
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
      // The restaurant's own answer to "how many people does this feed?",
      // written as a sentence because that question has no numeric answer.
      // Null means they have not said — the model must ask the customer to
      // check with staff rather than estimating from the dish name.
      portionNote: item.portion_note,
      // What the dish is made from, as recorded by the restaurant. Empty
      // means the restaurant hasn't listed any — say so plainly rather than
      // describing the dish from general knowledge, which would be a
      // recipe from the internet and not this kitchen's.
      ingredients: (ingredients ?? []).map((i) => i.name),
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

  // The category list belongs here rather than in a tool of its own: it is
  // a fact about the restaurant, it is small, and the model needs it
  // BEFORE it can use search_menu's category filter sensibly. Categories
  // differ completely between restaurants — "Chaat" and "Fasting Food"
  // mean nothing at a pizzeria — so this cannot be hardcoded anywhere.
  const supabase = await createClient();
  const { data: categoryRows } = await supabase
    .from("categories")
    .select("name")
    .eq("restaurant_id", context.restaurantId)
    .eq("is_active", true)
    .order("display_order", { ascending: true });

  return {
    ok: true,
    data: {
      menuCategories: (categoryRows ?? []).map((c) => c.name),
      currency: await restaurantCurrency(supabase, context.restaurantId),
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
      "Search this restaurant's currently available menu items by name/description text, dietary preference, spiciness, or menu category. Returns only items that are actually orderable right now, each with the category it belongs to. Call this for ANY customer question about what's on the menu, recommendations, or dietary options — even if the same topic came up earlier in this conversation; never answer from memory.",
    schema: searchMenuSchema,
    execute: searchMenu as ToolDefinition["execute"],
  },
  {
    name: "get_menu_item",
    description:
      "Get full detail for one menu item by id (from a prior search_menu result) — description, price, dietary flags, ingredients, declared allergens, preparation time, portion size, and its modifier groups/options. Use this before adding an item to the cart if you need to know its required modifiers, and any time a customer asks about a specific item's price, ingredients, dietary suitability, how long it takes, or how many people it feeds — never state these from memory.",
    schema: getMenuItemSchema,
    execute: getMenuItem as ToolDefinition["execute"],
  },
  {
    name: "get_restaurant_info",
    description:
      "Get this restaurant's name, description, address, phone number, and the list of menu categories it groups its food into (e.g. Snacks, Chaat, Thali Special). Call this before using search_menu's category filter — every restaurant's categories are different.",
    schema: getRestaurantInfoSchema,
    execute: getRestaurantInfo as ToolDefinition["execute"],
  },
];
