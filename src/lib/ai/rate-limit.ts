import "server-only";
import { createClient } from "@/lib/supabase/server";
import { aiConfig } from "./config";
import { isRateLimited as isRateLimitedCore } from "./rate-limit-core";

/**
 * Production entry point — the actual logic lives in rate-limit-core.ts
 * (no `server-only` import there) so it stays directly unit-testable.
 * Uses the RLS-respecting per-request client — a session can only ever
 * see its own message count (`ai_conversation_messages_select_own`), so
 * this check is itself tenant/session-safe with no extra scoping needed.
 */
export async function isRateLimited(
  customerSessionId: string,
): Promise<boolean> {
  const supabase = await createClient();
  return isRateLimitedCore(supabase, customerSessionId, aiConfig.rateLimit);
}
