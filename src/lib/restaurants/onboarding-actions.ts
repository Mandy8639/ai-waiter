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
import { isValidTimeZone, slugCandidates, slugify } from "./slug-core";

const onboardingSchema = createRestaurantInputSchema.extend({
  // Optional here: left blank, it's made from the name.
  slug: createRestaurantInputSchema.shape.slug.optional(),
  phone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
});

export interface OnboardingFormState {
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
  /** What was submitted, so a failed attempt never wipes the form. */
  values?: Record<string, string>;
}

const FIELDS = [
  "name",
  "slug",
  "description",
  "phone",
  "address",
  "city",
  "state",
  "postalCode",
] as const;

function isDuplicateSlug(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  return (
    message.includes("duplicate key") ||
    message.includes("restaurants_slug_key")
  );
}

export async function createRestaurantAction(
  _prevState: OnboardingFormState,
  formData: FormData,
): Promise<OnboardingFormState> {
  await requireUser();

  const values = Object.fromEntries(
    FIELDS.map((f) => [f, String(formData.get(f) ?? "")]),
  );
  // The owner's own browser timezone, so menu hours and "back tomorrow"
  // are in their time, not New York's. Ignored unless it's a real zone.
  const timezoneRaw = String(formData.get("timezone") ?? "").trim();

  const parsed = onboardingSchema.safeParse({
    name: formData.get("name"),
    slug: emptyToUndefined(formData.get("slug")),
    description: emptyToUndefined(formData.get("description")),
    phone: emptyToUndefined(formData.get("phone")),
    address: emptyToUndefined(formData.get("address")),
    city: emptyToUndefined(formData.get("city")),
    state: emptyToUndefined(formData.get("state")),
    postalCode: emptyToUndefined(formData.get("postalCode")),
  });

  if (!parsed.success) {
    const fieldErrors = z.flattenError(parsed.error).fieldErrors;
    if (fieldErrors.name) fieldErrors.name = ["Enter your restaurant's name."];
    if (fieldErrors.slug) {
      fieldErrors.slug = [
        "Use only lowercase letters, numbers and dashes, like spice-garden.",
      ];
    }
    return { fieldErrors, values };
  }

  // An address the owner typed is theirs to change if taken; one made from
  // the name is ours, so the next free variant is used instead.
  const slugAuto = formData.get("slugAuto") === "1";
  const chosen = slugAuto ? undefined : parsed.data.slug;
  const candidates = chosen
    ? [chosen]
    : slugCandidates(parsed.data.slug ?? slugify(parsed.data.name));
  const timezone = isValidTimeZone(timezoneRaw) ? timezoneRaw : undefined;

  let restaurant;
  for (const slug of candidates) {
    try {
      restaurant = await createRestaurant({
        name: parsed.data.name,
        slug,
        description: parsed.data.description,
        timezone,
      });
      break;
    } catch (err) {
      if (isDuplicateSlug(err)) continue;
      return {
        error: "Could not create your restaurant. Please try again.",
        values,
      };
    }
  }
  if (!restaurant) {
    return {
      fieldErrors: {
        slug: [
          chosen
            ? "That web address is already taken. Try another, or clear it and one will be picked for you."
            : "Couldn't find a free web address. Type one you'd like.",
        ],
      },
      values,
    };
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
