import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportError } from "@/lib/observability/report";
import {
  SquareError,
  exchangeCode,
  listLocations,
  saveTokens,
} from "@/lib/pos/square/api";
import { SQUARE_SCOPES, parseState } from "@/lib/pos/square/oauth-core";
import {
  SETTINGS_PATH,
  STATE_COOKIE,
  authorizeSquare,
  squareRedirectUri,
} from "@/lib/pos/square/connect";

/**
 * Where Square sends the owner back after "Connect Square".
 *
 * Order matters:
 * 1. The state must match the httpOnly cookie set when the flow started,
 *    so a link someone else started can't attach their Square account to
 *    this restaurant.
 * 2. The signed-in user must still manage the restaurant, two-step
 *    verification included (authorizeSquare).
 * 3. The integration row is written through the RLS-respecting client
 *    BEFORE any token is stored, so if the database refuses this user,
 *    nothing reaches the service-key token store.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const back = (status: string) => {
    const response = NextResponse.redirect(
      new URL(`${SETTINGS_PATH}?square=${status}`, url.origin),
    );
    response.cookies.delete({ name: STATE_COOKIE, path: "/api/pos/square" });
    return response;
  };

  const parsed = parseState(
    url.searchParams.get("state"),
    request.cookies.get(STATE_COOKIE)?.value,
  );
  if (!parsed) return back("expired");
  // The owner pressed "Deny" on Square's screen.
  if (url.searchParams.get("error")) return back("cancelled");
  const code = url.searchParams.get("code");
  if (!code) return back("expired");

  const { restaurantId } = parsed;
  const auth = await authorizeSquare(restaurantId);
  if (!auth.ok) return back("forbidden");
  // database.types.ts predates 20261109090000; see src/lib/pos/square/api.ts.
  const supabase = auth.context.supabase as unknown as SupabaseClient;

  const { error: rowError } = await supabase
    .from("restaurant_pos_integrations")
    .upsert(
      {
        restaurant_id: restaurantId,
        provider: "square",
        // A fresh connection starts disabled until a location is chosen.
        external_location_id: null,
        is_enabled: false,
        // Payments need an enabled connection; the owner switches them back on.
        payments_enabled: false,
      },
      { onConflict: "restaurant_id" },
    );
  if (rowError) {
    reportError(rowError, {
      scope: "square.callback.row",
      extra: { restaurantId },
    });
    return back("forbidden");
  }

  try {
    const tokens = await exchangeCode(code, await squareRedirectUri());
    await saveTokens(restaurantId, tokens, SQUARE_SCOPES);

    // One location (most small restaurants): pick it now and skip a step.
    const locations = (await listLocations(restaurantId)).filter(
      (l) => l.status === "ACTIVE",
    );
    const only = locations.length === 1 ? locations[0].id : null;
    await supabase
      .from("restaurant_pos_integrations")
      .update({
        external_merchant_id: tokens.merchantId,
        connected_at: new Date().toISOString(),
        external_location_id: only,
        is_enabled: only !== null,
      })
      .eq("restaurant_id", restaurantId);
  } catch (e) {
    reportError(e, {
      scope: "square.callback",
      extra: {
        restaurantId,
        detail: e instanceof SquareError ? e.detail : undefined,
      },
    });
    return back("error");
  }

  return back("connected");
}
