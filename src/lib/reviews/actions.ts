"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { createClient } from "@/lib/supabase/server";
import { parseGoogleReviewUrl } from "./core";

export interface ReviewLinkFormState {
  error?: string;
  success?: boolean;
}

/** Settings: save or clear the restaurant's Google review link. */
export async function updateGoogleReviewUrl(
  restaurantId: string,
  _prev: ReviewLinkFormState,
  formData: FormData,
): Promise<ReviewLinkFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parseGoogleReviewUrl(String(formData.get("url") ?? ""));
  if (!parsed.ok) return { error: parsed.error };

  // google_review_url postdates database.types.ts.
  const from = auth.context.supabase.from.bind(
    auth.context.supabase,
  ) as unknown as (table: string) => {
    update: (values: Record<string, unknown>) => {
      eq: (
        column: string,
        value: string,
      ) => Promise<{ error: { message: string } | null }>;
    };
  };
  const { error } = await from("restaurants")
    .update({ google_review_url: parsed.url })
    .eq("id", restaurantId);
  if (error) return { error: "That link couldn't be saved. Please try again." };

  revalidatePath("/dashboard/settings");
  return { success: true };
}

/**
 * A diner opened the review link from an order page. Fire and forget: the
 * database records it only if the caller can see that order, and never
 * says why not.
 */
export async function recordGoogleReviewTap(orderId: string): Promise<void> {
  if (!z.string().uuid().safeParse(orderId).success) return;
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  await rpc("record_google_review_tap", { p_order_id: orderId });
}
