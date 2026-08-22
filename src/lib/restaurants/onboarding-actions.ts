"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { emptyToUndefined } from "@/lib/forms/form-data";
import {
  createRestaurant,
  createRestaurantInputSchema,
} from "./create-restaurant";

const onboardingSchema = createRestaurantInputSchema.extend({
  phone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
});

export interface OnboardingFormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

export async function createRestaurantAction(
  _prevState: OnboardingFormState,
  formData: FormData,
): Promise<OnboardingFormState> {
  await requireUser();

  const parsed = onboardingSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: emptyToUndefined(formData.get("description")),
    phone: emptyToUndefined(formData.get("phone")),
    address: emptyToUndefined(formData.get("address")),
    city: emptyToUndefined(formData.get("city")),
    state: emptyToUndefined(formData.get("state")),
    postalCode: emptyToUndefined(formData.get("postalCode")),
  });

  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  let restaurant;
  try {
    restaurant = await createRestaurant({
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (
      message.includes("duplicate key") ||
      message.includes("restaurants_slug_key")
    ) {
      return {
        fieldErrors: {
          slug: ["That slug is already taken — try a different one."],
        },
      };
    }
    return { error: "Could not create your restaurant. Please try again." };
  }

  const hasContactFields =
    parsed.data.phone ||
    parsed.data.address ||
    parsed.data.city ||
    parsed.data.state ||
    parsed.data.postalCode;

  if (hasContactFields) {
    const supabase = await createClient();
    // Best-effort: the restaurant already exists and its owner membership
    // is already created at this point, so a failure here (unlikely — it's
    // the same owner updating their own new restaurant) shouldn't block
    // onboarding. The restaurant/settings pages let them fill this in
    // later regardless.
    await supabase
      .from("restaurants")
      .update({
        phone: parsed.data.phone ?? null,
        address: parsed.data.address ?? null,
        city: parsed.data.city ?? null,
        state: parsed.data.state ?? null,
        postal_code: parsed.data.postalCode ?? null,
      })
      .eq("id", restaurant.id);
  }

  redirect("/dashboard");
}
