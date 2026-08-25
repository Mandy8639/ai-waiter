import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { envInt } from "@/lib/env-helpers";
import type { Database } from "@/lib/supabase/database.types";
import { isSessionCreationRateLimited as isSessionCreationRateLimitedCore } from "./rate-limit-core";

/**
 * Throttles new customer session creation per table (Batch 8 — flagged as
 * a known gap in the Batch 7 final report). Deliberately scoped to
 * `table_id`, not IP address: a restaurant's real customers are commonly
 * on the same shared Wi-Fi (one IP, many legitimate diners), and several
 * people scanning the same table's QR code within the same minute is
 * completely normal — the identity boundary that actually distinguishes
 * "a busy table" from "something is hammering this endpoint" is how many
 * *new* sessions one table accumulates, not who's asking. The default
 * (30 new sessions per 5-minute window) is generous enough that no real
 * table should ever hit it — a table realistically seats a handful of
 * people, not thirty new arrivals in five minutes.
 *
 * This check only ever runs before creating a NEW session (the QR route
 * handler's reuse path for an already-active session never reaches it),
 * so a returning customer re-scanning or refreshing is never throttled.
 *
 * Production entry point — the actual logic lives in rate-limit-core.ts
 * (no `server-only` import there) so it stays directly unit-testable.
 */
export const SESSION_CREATION_RATE_LIMIT = {
  maxPerWindow: envInt("CUSTOMER_SESSION_RATE_LIMIT_MAX", 30),
  windowSeconds: envInt("CUSTOMER_SESSION_RATE_LIMIT_WINDOW_SECONDS", 300),
};

export async function isSessionCreationRateLimited(
  supabase: SupabaseClient<Database>,
  tableId: string,
): Promise<boolean> {
  return isSessionCreationRateLimitedCore(
    supabase,
    tableId,
    SESSION_CREATION_RATE_LIMIT,
  );
}
