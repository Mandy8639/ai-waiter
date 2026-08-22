import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * V1 default: a session lasts 4 hours from creation — long enough for a
 * full sit-down meal, short enough that a lost/forgotten phone doesn't
 * leave an indefinitely-valid session. Fixed at creation (no sliding
 * extension on activity) — a deliberate simplification for this batch, see
 * docs/security.md#session-lifetime.
 */
export const CUSTOMER_SESSION_DURATION_HOURS = 4;

export interface CustomerSession {
  id: string;
  restaurantId: string;
  tableId: string;
  userId: string;
  status: "active" | "expired" | "closed";
  expiresAt: string;
}

/**
 * The caller's own active, unexpired customer session, if any — derived
 * entirely from auth.uid() via RLS (customer_sessions_select_own), never
 * from a client-supplied id. Returns null for staff, signed-out visitors,
 * or a customer with no session (or an expired one, even if the row's
 * `status` column hasn't been flipped to 'expired' yet).
 *
 * cache()-wrapped so pages that both need "do we have a session" and "what
 * restaurant/table" don't issue the query twice in the same request.
 */
export const getActiveCustomerSession = cache(
  async (): Promise<CustomerSession | null> => {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return null;

    const { data } = await supabase
      .from("customer_sessions")
      .select("id, restaurant_id, table_id, user_id, status, expires_at")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!data) return null;
    if (data.status !== "active") return null;
    if (new Date(data.expires_at).getTime() <= Date.now()) return null;

    return {
      id: data.id,
      restaurantId: data.restaurant_id,
      tableId: data.table_id,
      userId: data.user_id,
      status: data.status,
      expiresAt: data.expires_at,
    };
  },
);

export interface SessionRequiredError {
  ok: false;
  error: string;
}

/**
 * For cart mutations: returns the caller's active session or a structured
 * error to show them — never throws/redirects, since "add to cart" is
 * called from a form action where a plain error message is more useful
 * than a hard navigation.
 */
export async function requireActiveCustomerSession(): Promise<
  { ok: true; session: CustomerSession } | SessionRequiredError
> {
  const session = await getActiveCustomerSession();
  if (!session) {
    return {
      ok: false,
      error: "Your session has expired. Please scan the table's QR code again.",
    };
  }
  return { ok: true, session };
}

/** Bumps last_active_at — call on cart mutations so staleness is observable, even though expiry itself is fixed. */
export async function touchCustomerSession(sessionId: string): Promise<void> {
  const supabase = await createClient();
  await supabase
    .from("customer_sessions")
    .update({ last_active_at: new Date().toISOString() })
    .eq("id", sessionId);
}
