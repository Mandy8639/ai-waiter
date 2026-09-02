import { createClient } from "@/lib/supabase/client";

/**
 * The browser-side twin of countPendingReservationRequests().
 *
 * Kept out of the server module (which imports `server-only`) so the nav
 * badge can refresh itself after a Realtime event without a round trip
 * through a server action. RLS is what scopes it — a client key cannot see
 * another restaurant's reservations regardless of the filter below.
 *
 * Returns null on failure rather than 0, so the caller can leave the last
 * known count on screen instead of flashing "no requests" at a staff
 * member because one query blipped.
 */
export async function countPendingRequestsFromBrowser(
  restaurantId: string,
): Promise<number | null> {
  const supabase = createClient();

  const { count, error } = await supabase
    .from("reservations")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", restaurantId)
    .eq("status", "pending");

  if (error) return null;
  return count ?? 0;
}
