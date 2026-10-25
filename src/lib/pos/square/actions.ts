"use server";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportError } from "@/lib/observability/report";
import {
  SquareError,
  disconnect,
  listCatalog,
  listLocations,
  squareConfig,
} from "./api";
import {
  buildState,
  squareAuthorizeUrl,
  squareWebhookReady,
} from "./oauth-core";
import {
  SETTINGS_PATH,
  STATE_COOKIE,
  authorizeSquare,
  currentOrigin,
  squareRedirectUri,
} from "./connect";
import { mapSquareCatalog } from "./catalog-core";

/**
 * Owner-facing Square actions (Settings → Point of sale). Every one
 * re-checks the caller manages the restaurant before touching Square or
 * the service-key token store.
 */

export interface SquareActionState {
  error?: string;
  success?: string;
}

export async function startSquareConnect(
  restaurantId: string,
  _prev: SquareActionState,
  _formData: FormData,
): Promise<SquareActionState> {
  const auth = await authorizeSquare(restaurantId);
  if (!auth.ok) return { error: auth.error };
  const config = squareConfig();
  if (!config) {
    return { error: "Square isn't set up on this deployment yet." };
  }

  const redirectUri = await squareRedirectUri();
  const callbackOrigin = new URL(redirectUri).origin;
  if (callbackOrigin !== (await currentOrigin())) {
    // Signed in on the other domain: the state cookie would be set on this
    // host and never come back. Send them to the right one first.
    redirect(`${callbackOrigin}${SETTINGS_PATH}`);
  }

  const state = buildState(restaurantId, randomBytes(16).toString("base64url"));
  (await cookies()).set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: callbackOrigin.startsWith("https"),
    sameSite: "lax",
    path: "/api/pos/square",
    maxAge: 10 * 60,
  });

  redirect(
    squareAuthorizeUrl({
      environment: config.environment,
      applicationId: config.applicationId,
      state,
      redirectUri,
    }),
  );
}

/** database.types.ts predates 20261109090000; see api.ts. */
function loose(supabase: unknown): SupabaseClient {
  return supabase as SupabaseClient;
}

function report(e: unknown, scope: string, restaurantId: string): void {
  reportError(e, {
    scope,
    extra: {
      restaurantId,
      detail: e instanceof SquareError ? e.detail : undefined,
    },
  });
}

function friendly(e: unknown, fallback: string): string {
  return e instanceof SquareError ? e.message : fallback;
}

export async function chooseSquareLocation(
  restaurantId: string,
  _prev: SquareActionState,
  formData: FormData,
): Promise<SquareActionState> {
  const auth = await authorizeSquare(restaurantId);
  if (!auth.ok) return { error: auth.error };
  const locationId = String(formData.get("locationId") ?? "");
  try {
    const locations = await listLocations(restaurantId);
    // Only a location this Square account actually has.
    if (!locations.some((l) => l.id === locationId)) {
      return { error: "Pick one of your Square locations." };
    }
  } catch (e) {
    report(e, "square.locations", restaurantId);
    return { error: friendly(e, "Couldn't reach Square. Try again.") };
  }
  const { error } = await loose(auth.context.supabase)
    .from("restaurant_pos_integrations")
    .update({ external_location_id: locationId, is_enabled: true })
    .eq("restaurant_id", restaurantId);
  if (error) return { error: "Couldn't save the location." };
  revalidatePath(SETTINGS_PATH);
  return { success: "Location saved." };
}

export async function syncSquareMenu(
  restaurantId: string,
  _prev: SquareActionState,
  _formData: FormData,
): Promise<SquareActionState> {
  const auth = await authorizeSquare(restaurantId);
  if (!auth.ok) return { error: auth.error };

  const { data: integration } = await loose(auth.context.supabase)
    .from("restaurant_pos_integrations")
    .select("provider, external_location_id")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (integration?.provider !== "square" || !integration.external_location_id) {
    return { error: "Connect Square and pick a location first." };
  }

  let mapped;
  try {
    mapped = mapSquareCatalog(
      await listCatalog(restaurantId),
      integration.external_location_id,
    );
  } catch (e) {
    report(e, "square.catalog", restaurantId);
    return { error: friendly(e, "Couldn't read your Square menu. Try again.") };
  }
  if (mapped.menu.items.length === 0) {
    // Square answered with nothing for this location. Importing that would
    // hide every dish that came from Square, so stop and say so instead.
    return {
      error:
        "Square has no items with a fixed price at this location, so nothing was changed.",
    };
  }

  // Through the signed-in user's client: the function re-checks the role
  // (and two-step verification) itself.
  const { data, error } = await loose(auth.context.supabase).rpc(
    "apply_pos_menu_sync",
    { p_restaurant_id: restaurantId, p_menu: mapped.menu },
  );
  if (error) {
    report(error, "square.apply_sync", restaurantId);
    return {
      error: error.message.includes("POS_SYNC_FORBIDDEN")
        ? "You don't have permission to change this menu."
        : "Couldn't update the menu. Nothing was changed.",
    };
  }

  const row = Array.isArray(data) ? data[0] : data;
  revalidatePath(SETTINGS_PATH);
  revalidatePath("/dashboard/menu");
  const parts = [
    `${row?.items_created ?? 0} added`,
    `${row?.items_updated ?? 0} updated`,
    `${row?.items_hidden ?? 0} hidden`,
  ];
  const skipped = mapped.skipped.length
    ? ` Skipped ${mapped.skipped.length} without a fixed price: ${mapped.skipped
        .slice(0, 5)
        .map((s) => s.name)
        .join(", ")}${mapped.skipped.length > 5 ? "…" : ""}.`
    : "";
  return {
    success: `Menu imported from Square: ${parts.join(", ")}.${skipped}`,
  };
}

export async function disconnectSquare(
  restaurantId: string,
  _prev: SquareActionState,
  _formData: FormData,
): Promise<SquareActionState> {
  const auth = await authorizeSquare(restaurantId);
  if (!auth.ok) return { error: auth.error };
  // Disable first, through RLS, so a role the database rejects stops here
  // before the service-key token store is touched.
  const { error } = await loose(auth.context.supabase)
    .from("restaurant_pos_integrations")
    // Payments go with the connection: card payments fall back to Stripe.
    .update({ is_enabled: false, payments_enabled: false })
    .eq("restaurant_id", restaurantId);
  if (error) return { error: "Couldn't disconnect Square." };
  try {
    await disconnect(restaurantId);
  } catch (e) {
    report(e, "square.disconnect", restaurantId);
    return { error: friendly(e, "Couldn't disconnect Square. Try again.") };
  }
  revalidatePath(SETTINGS_PATH);
  return {
    success:
      "Square disconnected. Dishes imported from it stay on your menu; reconnect any time to sync again.",
  };
}

export async function setSquarePayments(
  restaurantId: string,
  _prev: SquareActionState,
  formData: FormData,
): Promise<SquareActionState> {
  const auth = await authorizeSquare(restaurantId);
  if (!auth.ok) return { error: auth.error };
  const enable = formData.get("enable") === "1";

  if (enable && !squareWebhookReady(process.env)) {
    // Without the webhook a Square payment would go through and never be
    // marked paid in Tableside, so it can't be switched on yet.
    return {
      error:
        "Square payments aren't fully set up on this deployment yet (Square's payment notifications). Nothing was changed.",
    };
  }

  const supabase = loose(auth.context.supabase);
  const { data: integration } = await supabase
    .from("restaurant_pos_integrations")
    .select("provider, is_enabled, external_location_id")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (
    enable &&
    (integration?.provider !== "square" || !integration.is_enabled)
  ) {
    return { error: "Connect Square and pick a location first." };
  }

  const { error } = await supabase
    .from("restaurant_pos_integrations")
    .update({ payments_enabled: enable })
    .eq("restaurant_id", restaurantId);
  if (error) {
    report(error, "square.payments_toggle", restaurantId);
    return { error: "Couldn't change the payment setting." };
  }

  revalidatePath(SETTINGS_PATH);
  if (!enable) {
    return { success: "Card payments are back on Stripe (if it's set up)." };
  }
  const { data: settings } = await auth.context.supabase
    .from("restaurant_settings")
    .select("accept_card")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  return {
    success: settings?.accept_card
      ? "Diners now pay by card through Square."
      : "Square will take card payments once you turn on card payments under Payments.",
  };
}
