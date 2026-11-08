"use server";

import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";

export interface WaitGamesFormState {
  error?: string;
  success?: boolean;
}

/** Settings: switch the while-you-wait games on or off. */
export async function updateWaitGames(
  restaurantId: string,
  _prev: WaitGamesFormState,
  formData: FormData,
): Promise<WaitGamesFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  // show_wait_games (20261202090000) postdates database.types.ts.
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
  const { error } = await from("restaurant_settings")
    .update({ show_wait_games: formData.get("enabled") === "on" })
    .eq("restaurant_id", restaurantId);
  if (error) return { error: "That couldn't be saved. Please try again." };

  revalidatePath("/dashboard/settings");
  return { success: true };
}
