import "server-only";
import { createClient } from "@/lib/supabase/server";
import { generateTableQrDataUrl, getRequestOrigin } from "@/lib/tables/qr";

/**
 * Whether this person has the staff app on a phone for this restaurant:
 * the app records each phone that turns on its alerts (native_push_tokens,
 * readable by its own user only). An error reads as "yes", so a hiccup
 * never puts the nudge in front of someone who has the app.
 */
export async function hasStaffAppOnAPhone(
  restaurantId: string,
  userId: string,
): Promise<boolean> {
  const supabase = await createClient();
  const from = supabase.from.bind(supabase) as unknown as (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        eq: (
          column: string,
          value: string,
        ) => {
          limit: (
            n: number,
          ) => Promise<{ data: unknown[] | null; error: unknown }>;
        };
      };
    };
  };
  const { data, error } = await from("native_push_tokens")
    .select("id")
    .eq("restaurant_id", restaurantId)
    .eq("user_id", userId)
    .limit(1);
  if (error) return true;
  return (data ?? []).length > 0;
}

/** A QR code for tableside.menu/get-app, for scanning from a computer screen. */
export async function getAppQrDataUrl(): Promise<string> {
  return generateTableQrDataUrl(`${await getRequestOrigin()}/get-app`);
}
