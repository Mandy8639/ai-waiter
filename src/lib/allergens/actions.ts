"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { toFriendlyError } from "@/lib/errors/database-error";
import { emptyToUndefined } from "@/lib/forms/form-data";
import { allergenSchema } from "./schema";

export interface AllergenFormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

function parse(formData: FormData) {
  return allergenSchema.safeParse({
    name: formData.get("name"),
    description: emptyToUndefined(formData.get("description")),
  });
}

export async function createAllergen(
  restaurantId: string,
  _prevState: AllergenFormState,
  formData: FormData,
): Promise<AllergenFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parse(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase.from("allergens").insert({
    restaurant_id: restaurantId,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
  });

  if (error) return { error: toFriendlyError(error, "allergen") };

  revalidatePath("/dashboard/allergens");
  redirect("/dashboard/allergens");
}

export async function updateAllergen(
  restaurantId: string,
  allergenId: string,
  _prevState: AllergenFormState,
  formData: FormData,
): Promise<AllergenFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parse(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase
    .from("allergens")
    .update({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
    })
    .eq("id", allergenId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "allergen") };

  revalidatePath("/dashboard/allergens");
  revalidatePath(`/dashboard/allergens/${allergenId}/edit`);
  return {};
}

export async function deleteAllergen(
  restaurantId: string,
  allergenId: string,
): Promise<{ error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.context.supabase
    .from("allergens")
    .delete()
    .eq("id", allergenId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "allergen") };

  revalidatePath("/dashboard/allergens");
  return {};
}

export async function setAllergenMenuItemLink(
  restaurantId: string,
  allergenId: string,
  menuItemId: string,
  linked: boolean,
): Promise<void> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return;

  if (linked) {
    // A person ticking this box in the dashboard IS the confirmation —
    // there is no weaker state to record. Suggestions arrive unconfirmed
    // through a different path (menu import) and must be confirmed
    // per-item before any diner sees them.
    await auth.context.supabase.from("menu_item_allergens").insert({
      restaurant_id: restaurantId,
      menu_item_id: menuItemId,
      allergen_id: allergenId,
      confirmed_at: new Date().toISOString(),
      confirmed_by: auth.context.userId,
    });
  } else {
    await auth.context.supabase
      .from("menu_item_allergens")
      .delete()
      .eq("menu_item_id", menuItemId)
      .eq("allergen_id", allergenId);
  }

  revalidatePath(`/dashboard/allergens/${allergenId}/edit`);
}
