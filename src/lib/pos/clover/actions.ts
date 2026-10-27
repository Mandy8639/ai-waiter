"use server";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportError } from "@/lib/observability/report";
import { currentOrigin, SETTINGS_PATH } from "../square/connect";
import { buildState } from "../square/oauth-core";
import {
  CloverError,
  cloverConfig,
  disconnectClover,
  listCloverInventory,
} from "./api";
import { cloverAuthorizeUrl } from "./oauth-core";
import { mapCloverInventory } from "./catalog-core";
import {
  CLOVER_COOKIE_PATH,
  CLOVER_STATE_COOKIE,
  authorizeClover,
  cloverRedirectUri,
} from "./connect";

/**
 * Owner-facing Clover actions (Settings → Point of sale). Every one
 * re-checks the caller manages the restaurant before touching Clover or
 * the service-key token store.
 */

export interface CloverActionState {
  error?: string;
  success?: string;
}

/** restaurant_pos_integrations columns are newer than database.types.ts. */
function loose(supabase: unknown): SupabaseClient {
  return supabase as SupabaseClient;
}

function report(e: unknown, scope: string, restaurantId: string): void {
  reportError(e, {
    scope,
    extra: {
      restaurantId,
      detail: e instanceof CloverError ? e.detail : undefined,
    },
  });
}

export async function startCloverConnect(
  restaurantId: string,
  _prev: CloverActionState,
  _formData: FormData,
): Promise<CloverActionState> {
  const auth = await authorizeClover(restaurantId);
  if (!auth.ok) return { error: auth.error };
  const config = cloverConfig();
  if (!config) return { error: "Clover isn't set up on this deployment yet." };

  const redirectUri = await cloverRedirectUri();
  const callbackOrigin = new URL(redirectUri).origin;
  if (callbackOrigin !== (await currentOrigin())) {
    // Signed in on the other domain: the cookie would never come back.
    redirect(`${callbackOrigin}${SETTINGS_PATH}`);
  }

  const state = buildState(restaurantId, randomBytes(16).toString("base64url"));
  (await cookies()).set(CLOVER_STATE_COOKIE, state, {
    httpOnly: true,
    secure: callbackOrigin.startsWith("https"),
    sameSite: "lax",
    path: CLOVER_COOKIE_PATH,
    maxAge: 10 * 60,
  });

  redirect(
    cloverAuthorizeUrl({
      environment: config.environment,
      appId: config.appId,
      state,
      redirectUri,
    }),
  );
}

export async function syncCloverMenu(
  restaurantId: string,
  _prev: CloverActionState,
  _formData: FormData,
): Promise<CloverActionState> {
  const auth = await authorizeClover(restaurantId);
  if (!auth.ok) return { error: auth.error };

  const { data: integration } = await loose(auth.context.supabase)
    .from("restaurant_pos_integrations")
    .select("provider, connected_at")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (integration?.provider !== "clover" || !integration.connected_at) {
    return { error: "Connect Clover first." };
  }

  let mapped;
  try {
    mapped = mapCloverInventory(await listCloverInventory(restaurantId));
  } catch (e) {
    report(e, "clover.inventory", restaurantId);
    return {
      error:
        e instanceof CloverError
          ? e.message
          : "Couldn't read your Clover menu. Try again.",
    };
  }
  if (mapped.menu.items.length === 0) {
    // Importing nothing would hide every dish that came from Clover.
    return {
      error: "Clover has no items with a fixed price, so nothing was changed.",
    };
  }

  // Through the signed-in user's client: the function re-checks the role.
  const { data, error } = await loose(auth.context.supabase).rpc(
    "apply_pos_menu_sync",
    { p_restaurant_id: restaurantId, p_menu: mapped.menu },
  );
  if (error) {
    report(error, "clover.apply_sync", restaurantId);
    return {
      error: error.message.includes("POS_SYNC_FORBIDDEN")
        ? "You don't have permission to change this menu."
        : "Couldn't update the menu. Nothing was changed.",
    };
  }

  const row = Array.isArray(data) ? data[0] : data;
  revalidatePath(SETTINGS_PATH);
  revalidatePath("/dashboard/menu");
  const skipped = mapped.skipped.length
    ? ` Skipped ${mapped.skipped.length} (${mapped.skipped
        .slice(0, 5)
        .map((s) => `${s.name}: ${s.reason}`)
        .join("; ")}${mapped.skipped.length > 5 ? "…" : ""}).`
    : "";
  return {
    success: `Menu imported from Clover: ${row?.items_created ?? 0} added, ${row?.items_updated ?? 0} updated, ${row?.items_hidden ?? 0} hidden.${skipped}`,
  };
}

export async function disconnectCloverAction(
  restaurantId: string,
  _prev: CloverActionState,
  _formData: FormData,
): Promise<CloverActionState> {
  const auth = await authorizeClover(restaurantId);
  if (!auth.ok) return { error: auth.error };
  // Disable first, through RLS, so a role the database rejects stops here
  // before the token store is touched. Orders stop going to Clover.
  const { error } = await loose(auth.context.supabase)
    .from("restaurant_pos_integrations")
    .update({
      is_enabled: false,
      payments_enabled: false,
      connected_at: null,
      external_location_id: null,
    })
    .eq("restaurant_id", restaurantId);
  if (error) return { error: "Couldn't disconnect Clover." };
  try {
    await disconnectClover(restaurantId);
  } catch (e) {
    report(e, "clover.disconnect", restaurantId);
    return { error: "Couldn't disconnect Clover. Try again." };
  }
  revalidatePath(SETTINGS_PATH);
  return {
    success:
      "Clover disconnected. Dishes imported from it stay on your menu. To remove Tableside's access fully, uninstall the app in Clover.",
  };
}
