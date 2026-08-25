import "server-only";
import { createClient } from "@/lib/supabase/server";
import { envInt } from "@/lib/env-helpers";
import { isOrderSubmissionRateLimited as isOrderSubmissionRateLimitedCore } from "./rate-limit-core";

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
 *
 * Production entry point — the actual logic lives in rate-limit-core.ts
 * (no `server-only` import there) so it stays directly unit-testable.
 */
export const ORDER_SUBMISSION_RATE_LIMIT = {
  maxPerWindow: envInt("ORDER_SUBMISSION_RATE_LIMIT_MAX", 10),
  windowSeconds: envInt("ORDER_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS", 600),
};

export async function isOrderSubmissionRateLimited(
  customerSessionId: string,
): Promise<boolean> {
  const supabase = await createClient();
  return isOrderSubmissionRateLimitedCore(
    supabase,
    customerSessionId,
    ORDER_SUBMISSION_RATE_LIMIT,
  );
}
