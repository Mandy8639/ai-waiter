"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { toFriendlyError } from "@/lib/errors/database-error";
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

  const { error } = await auth.context.supabase.from("menu_items").insert({
    restaurant_id: restaurantId,
    category_id: parsed.data.categoryId,
    name: parsed.data.name,
    slug: parsed.data.slug,
    description: parsed.data.description ?? null,
    price: parsed.data.price,
    image_url: parsed.data.imageUrl ?? null,
    is_available: parsed.data.isAvailable,
    is_vegetarian: parsed.data.isVegetarian,
    is_vegan: parsed.data.isVegan,
    is_spicy: parsed.data.isSpicy,
    spice_level: parsed.data.spiceLevel ?? null,
    contains_nuts: parsed.data.containsNuts,
    contains_dairy: parsed.data.containsDairy,
    contains_gluten: parsed.data.containsGluten,
    preparation_time: parsed.data.preparationTime ?? null,
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

  const { error } = await auth.context.supabase
    .from("menu_items")
    .update({
      category_id: parsed.data.categoryId,
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description ?? null,
      price: parsed.data.price,
      image_url: parsed.data.imageUrl ?? null,
      is_available: parsed.data.isAvailable,
      is_vegetarian: parsed.data.isVegetarian,
      is_vegan: parsed.data.isVegan,
      is_spicy: parsed.data.isSpicy,
      spice_level: parsed.data.spiceLevel ?? null,
      contains_nuts: parsed.data.containsNuts,
      contains_dairy: parsed.data.containsDairy,
      contains_gluten: parsed.data.containsGluten,
      preparation_time: parsed.data.preparationTime ?? null,
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
