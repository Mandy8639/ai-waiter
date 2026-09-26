"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { toFriendlyError } from "@/lib/errors/database-error";
import { emptyToUndefined, toBoolean, toNumber } from "@/lib/forms/form-data";
import {
  aiPersonaSchema,
  operationalSettingsSchema,
  restaurantProfileSchema,
} from "./schema";

export interface SettingsFormState {
  error?: string;
  success?: boolean;
  fieldErrors?: Record<string, string[] | undefined>;
}

export async function updateRestaurantProfile(
  restaurantId: string,
  _prevState: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = restaurantProfileSchema.safeParse({
    name: formData.get("name"),
    description: emptyToUndefined(formData.get("description")),
    phone: emptyToUndefined(formData.get("phone")),
    address: emptyToUndefined(formData.get("address")),
    city: emptyToUndefined(formData.get("city")),
    state: emptyToUndefined(formData.get("state")),
    postalCode: emptyToUndefined(formData.get("postalCode")),
    timezone: formData.get("timezone"),
    currency: formData.get("currency"),
    taxRate: toNumber(formData.get("taxRate"), Number.NaN),
    serviceCharge: toNumber(formData.get("serviceCharge"), Number.NaN),
  });

  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase
    .from("restaurants")
    .update({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      phone: parsed.data.phone ?? null,
      address: parsed.data.address ?? null,
      city: parsed.data.city ?? null,
      state: parsed.data.state ?? null,
      postal_code: parsed.data.postalCode ?? null,
      timezone: parsed.data.timezone,
      currency: parsed.data.currency,
      tax_rate: parsed.data.taxRate,
      service_charge: parsed.data.serviceCharge,
    })
    .eq("id", restaurantId);

  if (error) return { error: toFriendlyError(error, "restaurant") };

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  return { success: true };
}

export async function updateOperationalSettings(
  restaurantId: string,
  _prevState: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = operationalSettingsSchema.safeParse({
    acceptingOrders: toBoolean(formData.get("acceptingOrders")),
    allowCustomerNotes: toBoolean(formData.get("allowCustomerNotes")),
    allowAiRecommendations: toBoolean(formData.get("allowAiRecommendations")),
    allowUpselling: toBoolean(formData.get("allowUpselling")),
    maxOrderItems: toNumber(formData.get("maxOrderItems"), Number.NaN),
  });

  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  const { error } = await auth.context.supabase
    .from("restaurant_settings")
    .update({
      accepting_orders: parsed.data.acceptingOrders,
      allow_customer_notes: parsed.data.allowCustomerNotes,
      allow_ai_recommendations: parsed.data.allowAiRecommendations,
      allow_upselling: parsed.data.allowUpselling,
      max_order_items: parsed.data.maxOrderItems,
    })
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "settings") };

  revalidatePath("/dashboard/settings");
  return { success: true };
}

/**
 * The AI waiter's tone and the owner's note (phase D). A separate action
 * from updateOperationalSettings so saving one card cannot silently
 * overwrite what someone else just changed in the other.
 */
export async function updateAiPersona(
  restaurantId: string,
  _prevState: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = aiPersonaSchema.safeParse({
    tone: formData.get("tone"),
    instructions: emptyToUndefined(formData.get("instructions")),
  });

  if (!parsed.success)
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };

  // database.types.ts predates 20260927090000, so the new columns are not
  // in the generated Update type. Cast confined to this one call.
  const { error } = await auth.context.supabase
    .from("restaurant_settings")
    .update({
      ai_tone: parsed.data.tone,
      ai_instructions: parsed.data.instructions,
    } as never)
    .eq("restaurant_id", restaurantId);

  if (error) return { error: toFriendlyError(error, "settings") };

  revalidatePath("/dashboard/settings");
  return { success: true };
}

/**
 * The signing-in owner's own email preferences (phase F). Owners only, since
 * only owners receive these emails; set_my_email_preferences() writes the
 * caller's own membership row and nobody else's.
 */
export async function updateEmailPreferences(
  restaurantId: string,
  _prevState: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, ["owner"]);
  if (!auth.ok) return { error: auth.error };

  // database.types.ts predates 20260929090000.
  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ error: { message: string } | null }>;
  const { error } = await rpc("set_my_email_preferences", {
    target_restaurant_id: restaurantId,
    p_daily_summary: toBoolean(formData.get("emailDailySummary")),
    p_payment_alerts: toBoolean(formData.get("emailPaymentAlerts")),
  });

  if (error)
    return { error: "Couldn't save your email settings. Please try again." };

  revalidatePath("/dashboard/settings");
  return { success: true };
}
