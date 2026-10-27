import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportError } from "@/lib/observability/report";
import {
  CloverError,
  exchangeCloverCode,
  getCloverMerchant,
  saveCloverTokens,
} from "@/lib/pos/clover/api";
import {
  isCloverMerchantId,
  parseCloverState,
} from "@/lib/pos/clover/oauth-core";
import {
  CLOVER_COOKIE_PATH,
  CLOVER_STATE_COOKIE,
  authorizeClover,
} from "@/lib/pos/clover/connect";
import { SETTINGS_PATH } from "@/lib/pos/square/connect";

/**
 * Where Clover sends the owner back after "Connect Clover" (registered as
 * the app's Alternate Launch Path). Clover adds `code` and `merchant_id`.
 *
 * Order matters, as for Square:
 * 1. The httpOnly cookie set when this owner pressed Connect must be
 *    there (and match `state` if Clover echoes it), so a link someone else
 *    started can't attach their Clover account to this restaurant.
 * 2. The signed-in user must still manage the restaurant, two-step
 *    verification included.
 * 3. The integration row is written through the RLS-respecting client
 *    BEFORE any token is stored.
 *
 * A Clover merchant is one location, so the connection is enabled at
 * once: orders start reaching the register straight away.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const back = (status: string) => {
    const response = NextResponse.redirect(
      new URL(`${SETTINGS_PATH}?clover=${status}`, url.origin),
    );
    response.cookies.delete({
      name: CLOVER_STATE_COOKIE,
      path: CLOVER_COOKIE_PATH,
    });
    return response;
  };

  const parsed = parseCloverState(
    url.searchParams.get("state"),
    request.cookies.get(CLOVER_STATE_COOKIE)?.value,
  );
  if (!parsed) return back("expired");
  const code = url.searchParams.get("code");
  const merchantId = url.searchParams.get("merchant_id");
  if (!code || !isCloverMerchantId(merchantId)) return back("cancelled");

  const { restaurantId } = parsed;
  const auth = await authorizeClover(restaurantId);
  if (!auth.ok) return back("forbidden");
  const supabase = auth.context.supabase as unknown as SupabaseClient;

  const { error: rowError } = await supabase
    .from("restaurant_pos_integrations")
    .upsert(
      {
        restaurant_id: restaurantId,
        provider: "clover",
        external_location_id: null,
        is_enabled: false,
        payments_enabled: false,
      },
      { onConflict: "restaurant_id" },
    );
  if (rowError) {
    reportError(rowError, {
      scope: "clover.callback.row",
      extra: { restaurantId },
    });
    return back("forbidden");
  }

  try {
    const tokens = await exchangeCloverCode(code);
    await saveCloverTokens(restaurantId, merchantId, tokens);
    // Proves the token works for this merchant before turning orders on.
    const merchant = await getCloverMerchant(restaurantId);
    await supabase
      .from("restaurant_pos_integrations")
      .update({
        external_merchant_id: merchant.id,
        external_location_id: merchant.id,
        connected_at: new Date().toISOString(),
        is_enabled: true,
      })
      .eq("restaurant_id", restaurantId);
  } catch (e) {
    reportError(e, {
      scope: "clover.callback",
      extra: {
        restaurantId,
        detail: e instanceof CloverError ? e.detail : undefined,
      },
    });
    return back("error");
  }

  return back("connected");
}
