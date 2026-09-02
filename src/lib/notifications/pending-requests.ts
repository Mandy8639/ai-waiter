import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * How many booking requests are waiting for someone to accept them.
 *
 * This exists because /r/<slug>/reserve tells a diner "we'll confirm
 * shortly" and, until now, nothing told the restaurant. The request
 * appeared only if a staff member happened to open the reservations page,
 * so a promise made to a customer depended on somebody's habit.
 *
 * Counted rather than fetched: the nav needs a number, not rows, and a
 * head-count query stays cheap enough to run on every dashboard render.
 *
 * A failure returns 0 rather than throwing. That is the opposite of the
 * choice made in src/lib/reports/queries.ts, deliberately: a broken count
 * here would otherwise take down every dashboard page, and the cost of
 * being wrong is a missing badge — someone opens Reservations and sees the
 * request. The cost of being wrong about takings is a confident false
 * figure, which is why that one is loud.
 */
export async function countPendingReservationRequests(
  restaurantId: string,
): Promise<number> {
  const supabase = await createClient();

  const { count, error } = await supabase
    .from("reservations")
    .select("id", { count: "exact", head: true })
    .eq("restaurant_id", restaurantId)
    .eq("status", "pending");

  if (error) return 0;
  return count ?? 0;
}
