"use server";

import { revalidatePath } from "next/cache";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { reportError } from "@/lib/observability/report";

/**
 * Settings → Manager PIN (20261117090000): the PIN an owner or manager
 * types on a waiter's tablet to approve a void, comp or discount.
 * set_approval_pin() checks the role again and refuses a PIN another
 * manager here already uses.
 */

export type PinResult = { ok: true } | { ok: false; error: string };

const MESSAGES: Record<string, string> = {
  PIN_FORBIDDEN: "Only an owner or manager can approve with a PIN.",
  PIN_INVALID: "Use 4 to 6 digits.",
  PIN_TAKEN: "Another manager here uses that PIN. Choose a different one.",
};

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

async function managerRpc(restaurantId: string) {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return auth;
  return {
    ok: true as const,
    rpc: auth.context.supabase.rpc.bind(
      auth.context.supabase,
    ) as unknown as Rpc,
  };
}

export async function setApprovalPin(
  restaurantId: string,
  pin: string,
): Promise<PinResult> {
  if (!/^[0-9]{4,6}$/.test(pin))
    return { ok: false, error: "Use 4 to 6 digits." };
  const auth = await managerRpc(restaurantId);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { error } = await auth.rpc("set_approval_pin", {
    p_restaurant_id: restaurantId,
    p_pin: pin,
  });
  if (error) {
    const code = /^(PIN_[A-Z_]+):/.exec(error.message)?.[1];
    if (!code) reportError(error, { scope: "settings.pin.set" });
    return {
      ok: false,
      error: (code && MESSAGES[code]) || "Couldn't save the PIN. Try again.",
    };
  }
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

export async function clearApprovalPin(
  restaurantId: string,
): Promise<PinResult> {
  const auth = await managerRpc(restaurantId);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { error } = await auth.rpc("clear_approval_pin", {
    p_restaurant_id: restaurantId,
  });
  if (error) {
    reportError(error, { scope: "settings.pin.clear" });
    return { ok: false, error: "Couldn't remove the PIN. Try again." };
  }
  revalidatePath("/dashboard/settings");
  return { ok: true };
}
