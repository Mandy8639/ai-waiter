import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export interface SessionCreationRateLimitWindow {
  maxPerWindow: number;
  windowSeconds: number;
}

/**
 * Extracted from rate-limit.ts (no `server-only` import here) so it stays
 * directly unit-testable — see src/lib/ai/rate-limit-core.ts for the same
 * pattern applied first.
 */
export async function isSessionCreationRateLimited(
  supabase: SupabaseClient<Database>,
  tableId: string,
  window: SessionCreationRateLimitWindow,
): Promise<boolean> {
  const { data, error } = await supabase.rpc(
    "count_recent_sessions_for_table",
    {
      p_table_id: tableId,
      p_window_seconds: window.windowSeconds,
    },
  );

  // Fails open on an RPC error: this is an abuse throttle, not a security
  // boundary, and a transient failure here should never be the reason a
  // real customer can't get seated — see the "failure behavior" note in
  // docs/security.md#customer-session-creation-rate-limiting.
  if (error) return false;
  return (data ?? 0) >= window.maxPerWindow;
}
