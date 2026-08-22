import "server-only";
import { createClient } from "@/lib/supabase/server";
import { aiConfig } from "./config";

/**
 * Session-scoped sliding-window rate limit (spec section 27) — counts
 * this customer session's own `ai_conversation_messages` rows with
 * role = 'user' created within the trailing window. Uses the existing
 * customer session identity (the same `auth.uid()`-backed boundary every
 * other customer-facing check in this codebase uses), never an IP
 * address: a restaurant's customers are very often on the same shared
 * Wi-Fi network, so IP is neither precise enough (many customers, one IP)
 * nor necessary (Supabase Auth already gives every session a distinct,
 * unforgeable identity).
 *
 * Reads through the RLS-respecting client — a session can only ever see
 * its own message count (`ai_conversation_messages_select_own`), so this
 * check is itself tenant/session-safe with no extra scoping needed.
 */
export async function isRateLimited(
  customerSessionId: string,
): Promise<boolean> {
  const supabase = await createClient();
  const windowStart = new Date(
    Date.now() - aiConfig.rateLimit.windowMinutes * 60_000,
  ).toISOString();

  const { count } = await supabase
    .from("ai_conversation_messages")
    .select("id", { count: "exact", head: true })
    .eq("customer_session_id", customerSessionId)
    .eq("role", "user")
    .gte("created_at", windowStart);

  return (count ?? 0) >= aiConfig.rateLimit.maxMessagesPerWindow;
}
