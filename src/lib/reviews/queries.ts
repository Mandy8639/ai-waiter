import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * restaurants.google_review_url (20261130090000) postdates
 * database.types.ts. Read on its own, and any error reads as "no link",
 * so a page never breaks over it (for instance in the minute between a
 * deploy and its migration).
 */
export async function getGoogleReviewUrl(
  restaurantId: string,
): Promise<string | null> {
  const supabase = await createClient();
  const from = supabase.from.bind(supabase) as unknown as (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        maybeSingle: () => Promise<{
          data: { google_review_url?: string | null } | null;
          error: unknown;
        }>;
      };
    };
  };
  const { data, error } = await from("restaurants")
    .select("google_review_url")
    .eq("id", restaurantId)
    .maybeSingle();
  if (error) return null;
  return data?.google_review_url ?? null;
}

/** Orders whose diners opened the link, for owners and managers; null for anyone else. */
export async function getGoogleReviewTapCount(
  restaurantId: string,
  days: number,
): Promise<number | null> {
  const supabase = await createClient();
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  const { data, error } = await rpc("google_review_tap_count", {
    p_restaurant_id: restaurantId,
    p_days: days,
  });
  if (error || typeof data !== "number") return null;
  return data;
}
