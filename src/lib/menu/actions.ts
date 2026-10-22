"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { toFriendlyError } from "@/lib/errors/database-error";

/** Exactly what toFriendlyError accepts, so the casts below need no second cast. */
type DatabaseError = Parameters<typeof toFriendlyError>[0] | null;
import { emptyToUndefined, toBoolean, toNumber } from "@/lib/forms/form-data";
import { menuItemSchema, spiceLevels } from "./schema";

export interface MenuItemFormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

function parse(formData: FormData) {
  const spiceLevelRaw = formData.get("spiceLevel");
  const preparationTimeRaw = emptyToUndefined(formData.get("preparationTime"));

  return menuItemSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    categoryId: formData.get("categoryId"),
    description: emptyToUndefined(formData.get("description")),
    price: toNumber(formData.get("price"), Number.NaN),
    imageUrl: emptyToUndefined(formData.get("imageUrl")),
    isAvailable: toBoolean(formData.get("isAvailable")),
    isVegetarian: toBoolean(formData.get("isVegetarian")),
    isHalal: toBoolean(formData.get("isHalal")),
    isKosher: toBoolean(formData.get("isKosher")),
    isVegan: toBoolean(formData.get("isVegan")),
    isSpicy: toBoolean(formData.get("isSpicy")),
    spiceLevel:
      typeof spiceLevelRaw === "string" &&
      (spiceLevels as readonly string[]).includes(spiceLevelRaw)
        ? spiceLevelRaw
        : undefined,
    containsNuts: toBoolean(formData.get("containsNuts")),
    containsDairy: toBoolean(formData.get("containsDairy")),
    containsGluten: toBoolean(formData.get("containsGluten")),
    preparationTime:
      preparationTimeRaw === undefined ? undefined : Number(preparationTimeRaw),
    portionNote: emptyToUndefined(formData.get("portionNote")),
    displayOrder: toNumber(formData.get("displayOrder"), 0),
  });
}

export async function createMenuItem(
  restaurantId: string,
  _prevState: MenuItemFormState,
  formData: FormData,
): Promise<MenuItemFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parse(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  // is_halal / is_kosher postdate database.types.ts, so
  // the generated insert payload types them as `never`. Asserted here
  // against 20260925090000_dietary_claims.sql; the Zod schema above is
  // what actually validates the values.
  const { error } = await (
    auth.context.supabase.from("menu_items") as unknown as {
      insert: (row: Record<string, unknown>) => Promise<{
        error: DatabaseError;
      }>;
    }
  ).insert({
    restaurant_id: restaurantId,
    category_id: parsed.data.categoryId,
    name: parsed.data.name,
    slug: parsed.data.slug,
    description: parsed.data.description ?? null,
    price: parsed.data.price,
    image_url: parsed.data.imageUrl ?? null,
    is_available: parsed.data.isAvailable,
    is_vegetarian: parsed.data.isVegetarian,
    is_halal: parsed.data.isHalal,
    is_kosher: parsed.data.isKosher,
    is_vegan: parsed.data.isVegan,
    is_spicy: parsed.data.isSpicy,
    spice_level: parsed.data.spiceLevel ?? null,
    contains_nuts: parsed.data.containsNuts,
    contains_dairy: parsed.data.containsDairy,
    contains_gluten: parsed.data.containsGluten,
    preparation_time: parsed.data.preparationTime ?? null,
    portion_note: parsed.data.portionNote ?? null,
    display_order: parsed.data.displayOrder,
  });

  if (error) return { error: toFriendlyError(error, "menu item") };

  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function updateMenuItem(
  restaurantId: string,
  menuItemId: string,
  _prevState: MenuItemFormState,
  formData: FormData,
): Promise<MenuItemFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parse(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  // Same assertion as the insert above.
  const { error } = await (
    auth.context.supabase.from("menu_items") as unknown as {
      update: (row: Record<string, unknown>) => {
        eq: (
          column: string,
          value: string,
        ) => {
          eq: (
            column: string,
            value: string,
          ) => Promise<{ error: DatabaseError }>;
        };
      };
    }
  )
    .update({
      category_id: parsed.data.categoryId,
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description ?? null,
      price: parsed.data.price,
      image_url: parsed.data.imageUrl ?? null,
      // A person editing this item owns its text from now on, so it stops
      // being flagged as an unreviewed AI draft. Set on save rather than on
      // change: opening the form and pressing save IS the review.
      details_source: "restaurant",
      // Same reasoning, separate column: the spice review lists drafts,
      // and someone who has just chosen a spice level in this form has
      // reviewed it whether or not they came from that page.
      spice_level_source: "restaurant",
      is_available: parsed.data.isAvailable,
      is_vegetarian: parsed.data.isVegetarian,
      is_halal: parsed.data.isHalal,
      is_kosher: parsed.data.isKosher,
      is_vegan: parsed.data.isVegan,
      is_spicy: parsed.data.isSpicy,
      spice_level: parsed.data.spiceLevel ?? null,
      contains_nuts: parsed.data.containsNuts,
      contains_dairy: parsed.data.containsDairy,
      contains_gluten: parsed.data.containsGluten,
      preparation_time: parsed.data.preparationTime ?? null,
      portion_note: parsed.data.portionNote ?? null,
      display_order: parsed.data.displayOrder,
    })
    .eq("id", menuItemId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "menu item") };

  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function deleteMenuItem(
  restaurantId: string,
  menuItemId: string,
): Promise<{ error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.context.supabase
    .from("menu_items")
    .delete()
    .eq("id", menuItemId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "menu item") };

  revalidatePath("/dashboard/menu");
  return {};
}

/**
 * Stars or unstars a dish as a house favorite: shown in "House favorites"
 * at the top of the diner menu, with a badge (20261106090000).
 */
export async function toggleHouseFavorite(
  restaurantId: string,
  menuItemId: string,
  nextValue: boolean,
): Promise<void> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return;

  // database.types.ts predates the column.
  await (
    auth.context.supabase.from("menu_items") as unknown as {
      update: (v: Record<string, unknown>) => {
        eq: (
          c: string,
          v: string,
        ) => { eq: (c: string, v: string) => Promise<unknown> };
      };
    }
  )
    .update({ is_house_favorite: nextValue })
    .eq("id", menuItemId)
    .eq("restaurant_id", restaurantId);

  revalidatePath("/dashboard/menu");
  revalidatePath("/r/[restaurantSlug]", "layout");
}

export async function toggleMenuItemAvailability(
  restaurantId: string,
  menuItemId: string,
  nextValue: boolean,
): Promise<void> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return;

  await auth.context.supabase
    .from("menu_items")
    .update({ is_available: nextValue })
    .eq("id", menuItemId)
    .eq("restaurant_id", restaurantId);

  revalidatePath("/dashboard/menu");
}
