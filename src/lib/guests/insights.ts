import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { ReportRange } from "@/lib/reports/range";
import { parseInsights, type GuestInsights } from "./insights-core";

/**
 * The Guests page's one read (get_guest_insights, 20261029090000), as the
 * signed-in owner or manager: the function checks the role itself.
 * Errors are thrown, as the Reports page's are, so a failed read shows an
 * error rather than a confident page of zeros.
 */
export async function getGuestInsights(
  restaurantId: string,
  range: ReportRange,
): Promise<GuestInsights> {
  const supabase = await createClient();
  // database.types.ts predates 20261029090000.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc("get_guest_insights", {
    target_restaurant_id: restaurantId,
    p_from: range.from,
    p_to: range.to,
  });
  if (error) throw new Error(error.message);
  return parseInsights(data);
}
