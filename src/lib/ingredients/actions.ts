"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { toFriendlyError } from "@/lib/errors/database-error";
import { emptyToUndefined } from "@/lib/forms/form-data";
import { ingredientSchema } from "./schema";

export interface IngredientFormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

function parse(formData: FormData) {
  return ingredientSchema.safeParse({
    name: formData.get("name"),
    description: emptyToUndefined(formData.get("description")),
  });
}

export async function createIngredient(
  restaurantId: string,
  _prevState: IngredientFormState,
  formData: FormData,
): Promise<IngredientFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parse(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase.from("ingredients").insert({
    restaurant_id: restaurantId,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
  });

  if (error) return { error: toFriendlyError(error, "ingredient") };

  revalidatePath("/dashboard/ingredients");
  redirect("/dashboard/ingredients");
}

export async function updateIngredient(
  restaurantId: string,
  ingredientId: string,
  _prevState: IngredientFormState,
  formData: FormData,
): Promise<IngredientFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parse(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase
    .from("ingredients")
    .update({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
    })
    .eq("id", ingredientId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "ingredient") };

  revalidatePath("/dashboard/ingredients");
  revalidatePath(`/dashboard/ingredients/${ingredientId}/edit`);
  return {};
}

export async function deleteIngredient(
  restaurantId: string,
  ingredientId: string,
): Promise<{ error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.context.supabase
    .from("ingredients")
    .delete()
    .eq("id", ingredientId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "ingredient") };

  revalidatePath("/dashboard/ingredients");
  return {};
}

export async function setIngredientMenuItemLink(
  restaurantId: string,
  ingredientId: string,
  menuItemId: string,
  linked: boolean,
): Promise<void> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return;

  if (linked) {
    await auth.context.supabase.from("menu_item_ingredients").insert({
      restaurant_id: restaurantId,
      menu_item_id: menuItemId,
      ingredient_id: ingredientId,
    });
  } else {
    await auth.context.supabase
      .from("menu_item_ingredients")
      .delete()
      .eq("menu_item_id", menuItemId)
      .eq("ingredient_id", ingredientId);
  }

  revalidatePath(`/dashboard/ingredients/${ingredientId}/edit`);
}
