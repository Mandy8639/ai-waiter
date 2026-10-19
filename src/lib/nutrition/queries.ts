import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  nutritionMismatch,
  nutritionState,
  type Nutrition,
  type NutritionState,
} from "./core";

// database.types.ts predates 20261005090000, so the new table is reached
// through an untyped handle.
interface NutritionRow {
  menu_item_id: string;
  calories: number;
  protein_g: number | string;
  carbs_g: number | string;
  fat_g: number | string;
  source: "ai" | "owner";
  confirmed_at: string | null;
}

interface NutritionQuery {
  select(columns: string): NutritionQuery;
  eq(column: string, value: unknown): NutritionQuery;
  in(column: string, values: unknown[]): NutritionQuery;
  not(column: string, operator: string, value: unknown): NutritionQuery;
  is(column: string, value: null): NutritionQuery;
  then<T>(
    resolve: (r: {
      data: NutritionRow[] | null;
      error: { message: string } | null;
    }) => T,
  ): Promise<T>;
}

type Client = Awaited<ReturnType<typeof createClient>>;

function table(supabase: Client): NutritionQuery {
  return (supabase as unknown as { from: (t: string) => NutritionQuery }).from(
    "menu_item_nutrition",
  );
}

const COLUMNS =
  "menu_item_id, calories, protein_g, carbs_g, fat_g, source, confirmed_at";

function toNutrition(row: NutritionRow): Nutrition {
  return {
    calories: row.calories,
    proteinG: Number(row.protein_g),
    carbsG: Number(row.carbs_g),
    fatG: Number(row.fat_g),
  };
}

// For the diner (and the AI waiter) -------------------------------------------

/**
 * Confirmed nutrition for these dishes. The confirmed_at filter is
 * deliberate even though RLS already hides drafts from diners: a
 * restaurant member reads through the members policy, which shows drafts,
 * and an owner previewing their own menu must see what a diner sees.
 */
export async function getConfirmedNutrition(
  itemIds: string[],
  supabase?: Client,
): Promise<Map<string, Nutrition>> {
  const out = new Map<string, Nutrition>();
  if (itemIds.length === 0) return out;
  const client = supabase ?? (await createClient());
  const { data } = await table(client)
    .select(COLUMNS)
    .in("menu_item_id", itemIds)
    .not("confirmed_at", "is", null);
  for (const row of data ?? []) out.set(row.menu_item_id, toNutrition(row));
  return out;
}

// For the owner ---------------------------------------------------------------

export interface NutritionReviewRow {
  itemId: string;
  name: string;
  description: string | null;
  category: string | null;
  state: NutritionState;
  source: "ai" | "owner" | null;
  values: Nutrition | null;
  /** Calories the macros account for, and whether the two disagree. */
  expected: number | null;
  mismatch: boolean;
}

/** Every dish, with its nutrition (draft or confirmed) beside it, menu order. */
export async function getNutritionReview(
  restaurantId: string,
): Promise<NutritionReviewRow[]> {
  const supabase = await createClient();
  const [{ data: items }, { data: categories }, { data: rows }] =
    await Promise.all([
      supabase
        .from("menu_items")
        .select("id, name, description, category_id, display_order")
        .eq("restaurant_id", restaurantId)
        .order("display_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("categories")
        .select("id, name, display_order")
        .eq("restaurant_id", restaurantId),
      table(supabase).select(COLUMNS).eq("restaurant_id", restaurantId),
    ]);

  const categoryById = new Map((categories ?? []).map((c) => [c.id, c]));
  const nutritionById = new Map((rows ?? []).map((r) => [r.menu_item_id, r]));

  return [...(items ?? [])]
    .sort((a, b) => {
      const ca = categoryById.get(a.category_id)?.display_order ?? 0;
      const cb = categoryById.get(b.category_id)?.display_order ?? 0;
      return ca - cb;
    })
    .map((item) => {
      const row = nutritionById.get(item.id) ?? null;
      const values = row ? toNutrition(row) : null;
      const check = values ? nutritionMismatch(values) : null;
      return {
        itemId: item.id,
        name: item.name,
        description: item.description,
        category: categoryById.get(item.category_id)?.name ?? null,
        state: nutritionState(row ? { confirmedAt: row.confirmed_at } : null),
        source: row?.source ?? null,
        values,
        expected: check?.expected ?? null,
        mismatch: check?.mismatch ?? false,
      };
    });
}

/** How many dishes have nutrition waiting for a person to confirm. */
export async function countDraftNutrition(
  restaurantId: string,
): Promise<number> {
  const supabase = await createClient();
  const { data } = await table(supabase)
    .select("menu_item_id")
    .eq("restaurant_id", restaurantId)
    .is("confirmed_at", null);
  return (data ?? []).length;
}

/**
 * The saved, unconfirmed numbers for these dishes — what "Confirm all
 * reviewed" compares against what the reviewer saw, so it never publishes
 * numbers that changed after they were marked.
 */
export async function getDraftNutrition(
  restaurantId: string,
  itemIds: string[],
): Promise<Map<string, Nutrition>> {
  if (itemIds.length === 0) return new Map();
  const supabase = await createClient();
  const { data } = await table(supabase)
    .select(COLUMNS)
    .eq("restaurant_id", restaurantId)
    .in("menu_item_id", itemIds)
    .is("confirmed_at", null);
  return new Map(
    (data ?? []).map((row) => [row.menu_item_id, toNutrition(row)]),
  );
}
