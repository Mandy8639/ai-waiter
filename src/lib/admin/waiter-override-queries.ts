import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SampleDish, TestMenu } from "./model-test-core";

/**
 * Phase 7 reads for /admin: one restaurant's menu for a waiter Test, and
 * the per-restaurant and per-plan waiter lists. Service role: the menu is
 * read whatever the restaurant's publish state, and the override tables
 * are server-only.
 */

type Rows = Promise<{ data: unknown[] | null; error: unknown }>;
type Store = {
  from: (t: string) => {
    select: (c: string) => Rows & {
      eq: (
        c: string,
        v: string | boolean,
      ) => Rows & {
        eq: (c: string, v: string | boolean) => Rows;
      };
      order: (c: string, o: { ascending: boolean }) => Rows;
    };
  };
};

/** Enough of a menu to judge a waiter by; a huge menu is sampled from the top. */
const MAX_DISHES = 250;

export async function loadTestMenu(
  restaurantId: string,
): Promise<TestMenu | null> {
  try {
    const store = createAdminClient() as unknown as Store;
    const [restaurant, items, categories] = await Promise.all([
      store.from("restaurants").select("name").eq("id", restaurantId),
      store
        .from("menu_items")
        .select(
          "id, name, description, price, category_id, is_vegetarian, is_spicy",
        )
        .eq("restaurant_id", restaurantId)
        .eq("is_available", true),
      store
        .from("categories")
        .select("id, name")
        .eq("restaurant_id", restaurantId)
        .eq("is_active", true),
    ]);
    const name = (restaurant.data?.[0] as { name?: string } | undefined)?.name;
    if (!name || items.error || categories.error) return null;
    const categoryName = new Map(
      (categories.data as { id: string; name: string }[]).map((c) => [
        c.id,
        c.name,
      ]),
    );
    const dishes: SampleDish[] = (
      items.data as Array<{
        id: string;
        name: string;
        description: string | null;
        price: number;
        category_id: string;
        is_vegetarian: boolean;
        is_spicy: boolean;
      }>
    )
      .filter((d) => categoryName.has(d.category_id))
      .slice(0, MAX_DISHES)
      .map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description ?? "",
        price: Number(d.price),
        category: categoryName.get(d.category_id)!,
        isVegetarian: d.is_vegetarian,
        isSpicy: d.is_spicy,
      }));
    if (dishes.length === 0) return null;
    return {
      restaurantName: name,
      dishes,
      categories: [...new Set(dishes.map((d) => d.category))],
    };
  } catch {
    return null;
  }
}

export interface PlanRow {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  models: string[] | null;
}

export interface WaiterOverrides {
  byRestaurant: Map<string, string[]>;
  plans: PlanRow[];
}

export async function getWaiterOverridesForAdmin(): Promise<WaiterOverrides | null> {
  try {
    const store = createAdminClient() as unknown as Store;
    const [rows, plans] = await Promise.all([
      store
        .from("waiter_model_overrides")
        .select("restaurant_id, plan_id, models"),
      store
        .from("platform_plans")
        .select("id, slug, name, is_default, monthly_price_cents")
        .order("monthly_price_cents", { ascending: true }),
    ]);
    if (rows.error || plans.error) return null;
    const byRestaurant = new Map<string, string[]>();
    const byPlan = new Map<string, string[]>();
    for (const r of rows.data as Array<{
      restaurant_id: string | null;
      plan_id: string | null;
      models: string[];
    }>) {
      if (r.restaurant_id) byRestaurant.set(r.restaurant_id, r.models);
      else if (r.plan_id) byPlan.set(r.plan_id, r.models);
    }
    return {
      byRestaurant,
      plans: (
        plans.data as Array<{
          id: string;
          slug: string;
          name: string;
          is_default: boolean;
        }>
      ).map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        isDefault: p.is_default,
        models: byPlan.get(p.id) ?? null,
      })),
    };
  } catch {
    return null;
  }
}
