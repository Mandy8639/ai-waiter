import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CUSTOMER_SESSION_DURATION_HOURS } from "@/lib/customer/session";
import { isSessionCreationRateLimited } from "@/lib/customer/rate-limit";

/**
 * The QR code's actual destination. Validates the table token (via the
 * SECURITY DEFINER get_table_by_token() RPC — see
 * supabase/migrations/20260822090000_table_public_tokens.sql), establishes
 * an anonymous customer identity + session bound to that restaurant/table,
 * and redirects into the menu. restaurant_id/table_id for the new session
 * always come from this validated lookup — never from the URL's slug
 * param, which is cosmetic only (see docs/security.md#customer-sessions).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ restaurantSlug: string; token: string }> },
) {
  const { restaurantSlug, token } = await params;
  const supabase = await createClient();

  const { data: lookupRows, error: lookupError } = await supabase.rpc(
    "get_table_by_token",
    {
      p_public_token: token,
    },
  );
  const table = lookupRows?.[0];

  if (lookupError || !table) {
    return NextResponse.redirect(new URL("/r/table-not-found", request.url));
  }

  // The URL's slug is cosmetic — if it doesn't match, send the customer to
  // the canonical URL for this token rather than treating it as an error.
  if (table.restaurant_slug !== restaurantSlug) {
    return NextResponse.redirect(
      new URL(`/r/${table.restaurant_slug}/table/${token}`, request.url),
    );
  }

  const {
    data: { user: existingUser },
  } = await supabase.auth.getUser();

  if (existingUser) {
    const { data: existingSession } = await supabase
      .from("customer_sessions")
      .select("id, restaurant_id, table_id, status, expires_at")
      .eq("user_id", existingUser.id)
      .maybeSingle();

    const isReusable =
      existingSession &&
      existingSession.status === "active" &&
      new Date(existingSession.expires_at).getTime() > Date.now() &&
      existingSession.restaurant_id === table.restaurant_id &&
      existingSession.table_id === table.table_id;

    if (isReusable && existingSession) {
      await supabase
        .from("customer_sessions")
        .update({ last_active_at: new Date().toISOString() })
        .eq("id", existingSession.id);
      return NextResponse.redirect(
        new URL(`/r/${restaurantSlug}/menu`, request.url),
      );
    }

    // A stale/expired session, or a session for a different table — start
    // fresh rather than trying to repurpose it.
    await supabase.auth.signOut();
  }

  // Only reached when a NEW session is actually about to be created — the
  // reuse path above already returned. Scoped to this table, not IP, so a
  // busy table's real diners are never throttled (see
  // src/lib/customer/rate-limit.ts).
  if (await isSessionCreationRateLimited(supabase, table.table_id)) {
    return NextResponse.redirect(
      new URL("/r/table-not-found?reason=busy", request.url),
    );
  }

  const { data: signInData, error: signInError } =
    await supabase.auth.signInAnonymously();

  if (signInError || !signInData.user) {
    return NextResponse.redirect(new URL("/r/table-not-found", request.url));
  }

  const expiresAt = new Date(
    Date.now() + CUSTOMER_SESSION_DURATION_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const { data: session, error: sessionError } = await supabase
    .from("customer_sessions")
    .insert({
      restaurant_id: table.restaurant_id,
      table_id: table.table_id,
      user_id: signInData.user.id,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (sessionError || !session) {
    return NextResponse.redirect(new URL("/r/table-not-found", request.url));
  }

  await supabase.from("carts").insert({
    customer_session_id: session.id,
    restaurant_id: table.restaurant_id,
  });

  return NextResponse.redirect(
    new URL(`/r/${restaurantSlug}/menu`, request.url),
  );
}
