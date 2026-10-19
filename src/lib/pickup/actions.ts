"use server";

import { requireUser } from "@/lib/auth/session";
import { pickupRpc } from "./queries";
import { parsePickupMoveError } from "./errors";

/**
 * Moves a pickup order later by `minutesLater` (the kitchen board offers
 * one or two slots). change_pickup_time() checks the caller's membership,
 * the order's state and the new slot, and recomputes when the kitchen
 * should start; requireUser() only makes a signed-out failure friendlier.
 */
export async function pushBackPickup(
  orderId: string,
  currentAt: string,
  minutesLater: number,
): Promise<{ error?: string }> {
  await requireUser();

  const from = new Date(currentAt);
  if (
    Number.isNaN(from.getTime()) ||
    !Number.isInteger(minutesLater) ||
    minutesLater < 5 ||
    minutesLater > 120
  ) {
    return { error: "Couldn't move that pickup time. Please try again." };
  }

  const rpc = await pickupRpc();
  const { error } = await rpc("change_pickup_time", {
    p_order_id: orderId,
    p_pickup_at: new Date(from.getTime() + minutesLater * 60_000).toISOString(),
  });
  return error ? { error: parsePickupMoveError(error.message ?? "") } : {};
}
