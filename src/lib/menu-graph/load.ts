import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicMenus } from "@/lib/menus/queries";
import { onNowFilter } from "@/lib/menus/core";
import { buildMenuGraph, type MenuGraph } from "./core";

/**
 * Reads what the menu knowledge graph is built from, through the caller's
 * own client (a diner's RLS session, the same reads search_menu and
 * get_menu_item make), for the dishes being served right now. Confirmed
 * allergens only. "Ordered together" comes from menu_pairings(), which
 * returns counts and nothing else.
 */
export async function loadMenuGraph(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<{ graph: MenuGraph; currency: string }> {
  const [{ data: categories }, menus, { data: restaurant }] = await Promise.all(
    [
      supabase
        .from("categories")
        .select("id, name")
        .eq("restaurant_id", restaurantId)
        .eq("is_active", true),
      getPublicMenus(restaurantId, supabase as never),
      supabase
        .from("restaurants")
        .select("currency")
        .eq("id", restaurantId)
        .maybeSingle<{ currency: string }>(),
    ],
  );
  const onNow = onNowFilter(menus);
  const sections = (
    (categories ?? []) as { id: string; name: string }[]
  ).filter((c) => !onNow || onNow.has(c.id));
  const sectionIds = new Set(sections.map((s) => s.id));

  const { data: itemRows } = await supabase
    .from("menu_items")
    .select(
      "id, name, price, category_id, is_vegetarian, is_vegan, is_halal, is_kosher, is_spicy, contains_nuts, contains_dairy, contains_gluten",
    )
    .eq("restaurant_id", restaurantId)
    .eq("is_available", true);
  type ItemRow = {
    id: string;
    name: string;
    price: number | string;
    category_id: string | null;
    is_vegetarian: boolean;
    is_vegan: boolean;
    is_halal: boolean;
    is_kosher: boolean;
    is_spicy: boolean;
    contains_nuts: boolean;
    contains_dairy: boolean;
    contains_gluten: boolean;
  };
  const items = ((itemRows ?? []) as ItemRow[]).filter(
    (i) => i.category_id && sectionIds.has(i.category_id),
  );
  const ids = items.map((i) => i.id);
  if (ids.length === 0) {
    return {
      graph: buildMenuGraph({
        currency: restaurant?.currency ?? "USD",
        sections,
        dishes: [],
        ingredients: [],
        allergens: [],
        pairings: [],
      }),
      currency: restaurant?.currency ?? "USD",
    };
  }

  const [{ data: ingredientLinks }, { data: allergenLinks }, { data: pairs }] =
    await Promise.all([
      supabase
        .from("menu_item_ingredients")
        .select("menu_item_id, ingredients(name)")
        .in("menu_item_id", ids),
      supabase
        .from("menu_item_allergens")
        .select("menu_item_id, allergens(name)")
        .in("menu_item_id", ids)
        // Confirmed only: an unconfirmed row is an import suggestion, and
        // this platform never states an allergen on its own authority.
        .not("confirmed_at", "is", null),
      supabase.rpc("menu_pairings", { p_restaurant_id: restaurantId }),
    ]);

  const nameOf = (v: unknown) =>
    (Array.isArray(v) ? v[0] : v) as { name?: string } | null;

  return {
    currency: restaurant?.currency ?? "USD",
    graph: buildMenuGraph({
      currency: restaurant?.currency ?? "USD",
      sections,
      dishes: items.map((i) => ({
        id: i.id,
        name: i.name,
        price: Number(i.price),
        sectionId: i.category_id,
        isVegetarian: i.is_vegetarian,
        isVegan: i.is_vegan,
        isHalal: i.is_halal,
        isKosher: i.is_kosher,
        isSpicy: i.is_spicy,
        containsNuts: i.contains_nuts,
        containsDairy: i.contains_dairy,
        containsGluten: i.contains_gluten,
      })),
      ingredients: (
        (ingredientLinks ?? []) as {
          menu_item_id: string;
          ingredients: unknown;
        }[]
      )
        .map((l) => ({
          dishId: l.menu_item_id,
          name: nameOf(l.ingredients)?.name ?? "",
        }))
        .filter((l) => l.name),
      allergens: (
        (allergenLinks ?? []) as { menu_item_id: string; allergens: unknown }[]
      )
        .map((l) => ({
          dishId: l.menu_item_id,
          name: nameOf(l.allergens)?.name ?? "",
        }))
        .filter((l) => l.name),
      pairings: (
        (pairs ?? []) as {
          menu_item_id: string;
          other_menu_item_id: string;
          visits: number;
        }[]
      ).map((p) => ({
        dishId: p.menu_item_id,
        otherId: p.other_menu_item_id,
        orders: Number(p.visits),
      })),
    }),
  };
}
