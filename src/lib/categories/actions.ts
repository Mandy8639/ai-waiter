"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { toFriendlyError } from "@/lib/errors/database-error";
import { emptyToUndefined, toBoolean, toNumber } from "@/lib/forms/form-data";
import { categorySchema } from "./schema";

export interface CategoryFormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

function parse(formData: FormData) {
  return categorySchema.safeParse({
    name: formData.get("name"),
    description: emptyToUndefined(formData.get("description")),
    displayOrder: toNumber(formData.get("displayOrder"), 0),
    isActive: toBoolean(formData.get("isActive")),
  });
}

export async function createCategory(
  restaurantId: string,
  _prevState: CategoryFormState,
  formData: FormData,
): Promise<CategoryFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parse(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase.from("categories").insert({
    restaurant_id: restaurantId,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    display_order: parsed.data.displayOrder,
    is_active: parsed.data.isActive,
  });

  if (error) return { error: toFriendlyError(error, "category") };

  revalidatePath("/dashboard/categories");
  redirect("/dashboard/categories");
}

export async function updateCategory(
  restaurantId: string,
  categoryId: string,
  _prevState: CategoryFormState,
  formData: FormData,
): Promise<CategoryFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parse(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase
    .from("categories")
    .update({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      display_order: parsed.data.displayOrder,
      is_active: parsed.data.isActive,
    })
    .eq("id", categoryId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "category") };

  revalidatePath("/dashboard/categories");
  redirect("/dashboard/categories");
}

export async function deleteCategory(
  restaurantId: string,
  categoryId: string,
): Promise<{ error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.context.supabase
    .from("categories")
    .delete()
    .eq("id", categoryId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "category") };

  revalidatePath("/dashboard/categories");
  return {};
}

export async function toggleCategoryActive(
  restaurantId: string,
  categoryId: string,
  nextValue: boolean,
): Promise<void> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return;

  await auth.context.supabase
    .from("categories")
    .update({ is_active: nextValue })
    .eq("id", categoryId)
    .eq("restaurant_id", restaurantId);

  revalidatePath("/dashboard/categories");
}
