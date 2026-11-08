import "server-only";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { resolveDinerImage, type ImageSource } from "@/lib/menu-images/resolve";
import {
  MENU_ITEM_IMAGE_COLUMNS,
  asRowsWithNewColumns,
  type MenuItemImageFields,
} from "@/lib/menu-images/menu-item-rows";
import type { GameDish } from "./core";

/**
 * The dishes the while-you-wait games draw on, or null when the
 * restaurant has them switched off. Any error reads as "off", so an order
 * page never breaks over a game.
 */
export async function getWaitGameDishes(
  restaurantId: string,
): Promise<GameDish[] | null> {
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  const { data: enabled, error } = await rpc("wait_games_enabled", {
    p_restaurant_id: restaurantId,
  });
  if (error || enabled !== true) return null;

  const [{ data: items }, { data: categories }] = await Promise.all([
    supabase
      .from("menu_items")
      .select(
        `id, name, category_id, is_vegan, is_vegetarian, spice_level, preparation_time, ${MENU_ITEM_IMAGE_COLUMNS}` as "id, name, category_id, is_vegan, is_vegetarian, spice_level, preparation_time",
      )
      .eq("restaurant_id", restaurantId)
      .eq("is_available", true)
      .limit(200),
    supabase
      .from("categories")
      .select("id, name")
      .eq("restaurant_id", restaurantId),
  ]);
  const categoryName = new Map((categories ?? []).map((c) => [c.id, c.name]));

  type Row = {
    id: string;
    name: string;
    category_id: string | null;
    is_vegan: boolean | null;
    is_vegetarian: boolean | null;
    spice_level: string | null;
    preparation_time: number | null;
  } & MenuItemImageFields;

  return asRowsWithNewColumns<Row>(items ?? []).map((row) => {
    const photo = resolveDinerImage({
      activeImageId: row.active_image_id,
      imageSource: row.image_source as ImageSource | null,
      imageVariants: row.image_variants,
      legacyImageUrl: row.image_url,
      supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    });
    return {
      id: row.id,
      name: row.name,
      category: row.category_id
        ? (categoryName.get(row.category_id) ?? null)
        : null,
      isVegan: Boolean(row.is_vegan),
      isVegetarian: Boolean(row.is_vegetarian),
      spiceLevel: row.spice_level,
      prepMinutes: row.preparation_time,
      photoUrl: photo?.src ?? null,
    };
  });
}

/**
 * The Settings switch's current value, read on its own so the rest of
 * Settings never depends on this newer column. Unreadable reads as on,
 * the default.
 */
export async function getWaitGamesSetting(
  restaurantId: string,
): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("restaurant_settings")
    .select("show_wait_games" as "restaurant_id")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (error || !data) return true;
  return (
    (data as unknown as { show_wait_games?: boolean }).show_wait_games !== false
  );
}
