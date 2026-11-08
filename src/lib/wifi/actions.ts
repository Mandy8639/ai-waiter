"use server";

import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { parseWifiForm } from "./core";

export interface WifiFormState {
  error?: string;
  success?: boolean;
}

/** Settings: save or clear the restaurant's guest Wi-Fi. */
export async function updateRestaurantWifi(
  restaurantId: string,
  _prev: WifiFormState,
  formData: FormData,
): Promise<WifiFormState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = parseWifiForm({
    ssid: String(formData.get("ssid") ?? ""),
    password: String(formData.get("password") ?? ""),
    security: String(formData.get("security") ?? "WPA"),
    hidden: formData.get("hidden") === "on",
  });
  if (!parsed.ok) return { error: parsed.error };

  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ error: { message: string } | null }>;
  const wifi = parsed.wifi;
  const { error } = await rpc("set_restaurant_wifi", {
    p_restaurant_id: restaurantId,
    p_ssid: wifi?.ssid ?? null,
    p_password: wifi?.password ?? null,
    p_security: wifi?.security ?? "WPA",
    p_hidden: wifi?.hidden ?? false,
  });
  if (error)
    return { error: "The Wi-Fi details couldn't be saved. Please try again." };

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/tables/print");
  return { success: true };
}
