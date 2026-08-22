"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { toFriendlyError } from "@/lib/errors/database-error";
import { emptyToUndefined, toBoolean, toNumber } from "@/lib/forms/form-data";
import { modifierGroupSchema, modifierOptionSchema } from "./schema";

export interface ModifierFormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

function parseGroup(formData: FormData) {
  return modifierGroupSchema.safeParse({
    menuItemId: formData.get("menuItemId"),
    name: formData.get("name"),
    description: emptyToUndefined(formData.get("description")),
    isRequired: toBoolean(formData.get("isRequired")),
    minSelections: toNumber(formData.get("minSelections"), 0),
    maxSelections: toNumber(formData.get("maxSelections"), 1),
    displayOrder: toNumber(formData.get("displayOrder"), 0),
  });
}

export async function createModifierGroup(
  restaurantId: string,
  _prevState: ModifierFormState,
  formData: FormData,
): Promise<ModifierFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parseGroup(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { data, error } = await auth.context.supabase
    .from("menu_item_modifiers")
    .insert({
      restaurant_id: restaurantId,
      menu_item_id: parsed.data.menuItemId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      is_required: parsed.data.isRequired,
      min_selections: parsed.data.minSelections,
      max_selections: parsed.data.maxSelections,
      display_order: parsed.data.displayOrder,
    })
    .select("id")
    .single();

  if (error || !data)
    return { error: toFriendlyError(error!, "modifier group") };

  revalidatePath("/dashboard/modifiers");
  redirect(`/dashboard/modifiers/${data.id}`);
}

export async function updateModifierGroup(
  restaurantId: string,
  groupId: string,
  _prevState: ModifierFormState,
  formData: FormData,
): Promise<ModifierFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parseGroup(formData);
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase
    .from("menu_item_modifiers")
    .update({
      menu_item_id: parsed.data.menuItemId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      is_required: parsed.data.isRequired,
      min_selections: parsed.data.minSelections,
      max_selections: parsed.data.maxSelections,
      display_order: parsed.data.displayOrder,
    })
    .eq("id", groupId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "modifier group") };

  revalidatePath("/dashboard/modifiers");
  revalidatePath(`/dashboard/modifiers/${groupId}`);
  return {};
}

export async function deleteModifierGroup(
  restaurantId: string,
  groupId: string,
): Promise<{ error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.context.supabase
    .from("menu_item_modifiers")
    .delete()
    .eq("id", groupId)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "modifier group") };

  revalidatePath("/dashboard/modifiers");
  redirect("/dashboard/modifiers");
}

export async function createModifierOption(
  restaurantId: string,
  modifierId: string,
  _prevState: ModifierFormState,
  formData: FormData,
): Promise<ModifierFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = modifierOptionSchema.safeParse({
    name: formData.get("name"),
    priceAdjustment: toNumber(formData.get("priceAdjustment"), 0),
    isAvailable: toBoolean(formData.get("isAvailable")),
    displayOrder: toNumber(formData.get("displayOrder"), 0),
  });
  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase
    .from("modifier_options")
    .insert({
      modifier_id: modifierId,
      name: parsed.data.name,
      price_adjustment: parsed.data.priceAdjustment,
      is_available: parsed.data.isAvailable,
      display_order: parsed.data.displayOrder,
    });

  if (error) return { error: toFriendlyError(error, "modifier option") };

  revalidatePath(`/dashboard/modifiers/${modifierId}`);
  return {};
}

export async function deleteModifierOption(
  restaurantId: string,
  optionId: string,
): Promise<{ error?: string }> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const { error } = await auth.context.supabase
    .from("modifier_options")
    .delete()
    .eq("id", optionId);

  if (error) return { error: toFriendlyError(error, "modifier option") };

  revalidatePath("/dashboard/modifiers");
  return {};
}

export async function toggleModifierOptionAvailability(
  restaurantId: string,
  optionId: string,
  nextValue: boolean,
): Promise<void> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return;

  await auth.context.supabase
    .from("modifier_options")
    .update({ is_available: nextValue })
    .eq("id", optionId);

  revalidatePath("/dashboard/modifiers");
}
