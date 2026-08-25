import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export interface OrderSubmissionRateLimitWindow {
  maxPerWindow: number;
  windowSeconds: number;
}

/**
 * Extracted from rate-limit.ts (no `server-only` import here) so it stays
 * directly unit-testable — see src/lib/ai/rate-limit-core.ts for the same
 * pattern applied first.
 */
export async function isOrderSubmissionRateLimited(
  supabase: SupabaseClient<Database>,
  customerSessionId: string,
  window: OrderSubmissionRateLimitWindow,
): Promise<boolean> {
  const { data, error } = await supabase.rpc(
    "count_recent_orders_for_session",
    {
      p_customer_session_id: customerSessionId,
      p_window_seconds: window.windowSeconds,
    },
  );

  // Fails open on an RPC error, same reasoning as session-creation
  // throttling: this is an abuse throttle, not the idempotency guarantee,
  // and a transient failure here must never block a real order.
  if (error) return false;
  return (data ?? 0) >= window.maxPerWindow;
}
