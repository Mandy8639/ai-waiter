import "server-only";
import { createClient } from "@/lib/supabase/server";
import { envInt } from "@/lib/env-helpers";

/**
 * Throttles distinct order-submission *attempts* per customer session
 * (Batch 8 — flagged as a known gap in the Batch 7 final report). This is
 * deliberately separate from, and does not replace, submit_order()'s own
 * idempotency guarantee: idempotency makes repeated calls with the SAME
 * key collapse into ONE order (protects against double-click/retry/
 * refresh); this check limits how many DIFFERENT order attempts one
 * session can make in a window (protects against a script generating a
 * fresh idempotency key per call to spam many distinct orders). Neither
 * mechanism can substitute for the other — see docs/security.md#order-submission-abuse-protection.
 *
 * The default (10 orders per 10-minute window) is far above any real
 * dining session's order count (a couple of rounds during a meal), so no
 * legitimate customer should ever observe this.
 */
export const ORDER_SUBMISSION_RATE_LIMIT = {
  maxPerWindow: envInt("ORDER_SUBMISSION_RATE_LIMIT_MAX", 10),
  windowSeconds: envInt("ORDER_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS", 600),
};

export async function isOrderSubmissionRateLimited(
  customerSessionId: string,
): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "count_recent_orders_for_session",
    {
      p_customer_session_id: customerSessionId,
      p_window_seconds: ORDER_SUBMISSION_RATE_LIMIT.windowSeconds,
    },
  );

  // Fails open on an RPC error, same reasoning as session-creation
  // throttling: this is an abuse throttle, not the idempotency guarantee,
  // and a transient failure here must never block a real order.
  if (error) return false;
  return (data ?? 0) >= ORDER_SUBMISSION_RATE_LIMIT.maxPerWindow;
}
