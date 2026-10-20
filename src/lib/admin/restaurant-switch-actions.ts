"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { platformAdminForAction } from "./access";
import { clearRestaurantSwitchCache } from "./restaurant-switches";
import {
  isRestaurantAiFeature,
  SWITCH_REASON_MAX,
  type RestaurantAiFeature,
} from "./restaurant-switches-core";

/** The Restaurants card on /admin: one restaurant's AI feature on or off (Phase 6, docs/admin.md). */

const NOT_ALLOWED =
  "Only the platform admin can do this, with two-step verification entered.";

type Result = Promise<{ error: { message: string; code?: string } | null }>;
type Store = {
  from: (t: "restaurant_ai_switches" | "restaurant_ai_switch_history") => {
    upsert: (row: Record<string, unknown>) => Result;
    insert: (row: Record<string, unknown>) => Result;
    delete: () => {
      eq: (c: string, v: string) => { eq: (c: string, v: string) => Result };
    };
  };
};

export async function setRestaurantAiFeature(
  restaurantId: string,
  feature: RestaurantAiFeature,
  enabled: boolean,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (
    !z.uuid().safeParse(restaurantId).success ||
    !isRestaurantAiFeature(feature) ||
    typeof enabled !== "boolean"
  ) {
    return { ok: false, error: "That isn't a valid setting." };
  }
  const note = (reason ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, SWITCH_REASON_MAX);
  const user = await platformAdminForAction();
  if (!user) return { ok: false, error: NOT_ALLOWED };

  const store = createAdminClient() as unknown as Store;
  const { error } = enabled
    ? await store
        .from("restaurant_ai_switches")
        .delete()
        .eq("restaurant_id", restaurantId)
        .eq("feature", feature)
    : await store.from("restaurant_ai_switches").upsert({
        restaurant_id: restaurantId,
        feature,
        reason: note || null,
        switched_off_by: user.id,
        switched_off_at: new Date().toISOString(),
      });
  if (error) {
    return {
      ok: false,
      error:
        error.code === "23503"
          ? "That restaurant no longer exists."
          : "Couldn't save. Please try again.",
    };
  }

  // The history line is a record, not the switch: a failed write is
  // logged rather than undoing a switch that already took effect.
  const { error: historyError } = await store
    .from("restaurant_ai_switch_history")
    .insert({
      restaurant_id: restaurantId,
      feature,
      action: enabled ? "on" : "off",
      reason: note || null,
      changed_by: user.id,
    });
  console.info(
    JSON.stringify({
      event: "restaurant_ai_switched",
      restaurantId,
      feature,
      enabled,
      by: user.id,
      historyWritten: !historyError,
    }),
  );

  clearRestaurantSwitchCache(restaurantId);
  revalidatePath("/admin");
  return { ok: true };
}
