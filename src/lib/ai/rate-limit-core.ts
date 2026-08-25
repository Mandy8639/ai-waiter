import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export interface RateLimitWindow {
  windowMinutes: number;
  maxMessagesPerWindow: number;
}

/**
 * Session-scoped sliding-window rate limit (spec section 27) — counts
 * this customer session's own `ai_conversation_messages` rows with
 * role = 'user' created within the trailing window.
 *
 * No `import "server-only"` here — the guard lives in rate-limit.ts (the
 * production entry point every caller actually imports), so this file
 * stays directly unit-testable with a fake Supabase client, matching the
 * loop.ts/*-mapping.ts/validate-core.ts split from their server-only
 * hosts elsewhere in this codebase.
 */
export async function isRateLimited(
  supabase: SupabaseClient<Database>,
  customerSessionId: string,
  window: RateLimitWindow,
): Promise<boolean> {
  const windowStart = new Date(
    Date.now() - window.windowMinutes * 60_000,
  ).toISOString();

  const { count } = await supabase
    .from("ai_conversation_messages")
    .select("id", { count: "exact", head: true })
    .eq("customer_session_id", customerSessionId)
    .eq("role", "user")
    .gte("created_at", windowStart);

  return (count ?? 0) >= window.maxMessagesPerWindow;
}
