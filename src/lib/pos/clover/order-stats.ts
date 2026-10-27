import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Settings → Point of sale's view of orders sent to Clover: delivered in
 * the last day, still retrying, and given up on in the last week (so staff
 * ring those up by hand). Read through the owner's or manager's own client:
 * pos_outbox is readable to them by RLS, and to nobody else.
 */
export async function getCloverOrderStats(
  supabase: SupabaseClient,
  restaurantId: string,
  now: Date = new Date(),
): Promise<{ delivered: number; retrying: number; failed: number[] }> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();
  const [{ count: delivered }, { count: retrying }, { data: failed }] =
    await Promise.all([
      supabase
        .from("pos_outbox")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", restaurantId)
        .eq("status", "delivered")
        .gte("delivered_at", since),
      supabase
        .from("pos_outbox")
        .select("id", { count: "exact", head: true })
        .eq("restaurant_id", restaurantId)
        .eq("status", "pending")
        .gt("attempts", 0),
      supabase
        .from("pos_outbox")
        .select("orders(order_number)")
        .eq("restaurant_id", restaurantId)
        .eq("status", "abandoned")
        .gte("created_at", weekAgo)
        .limit(20),
    ]);
  return {
    delivered: delivered ?? 0,
    retrying: retrying ?? 0,
    failed: (
      (failed ?? []) as unknown as { orders: { order_number: number } | null }[]
    )
      .map((f) => f.orders?.order_number)
      .filter((n): n is number => typeof n === "number"),
  };
}
