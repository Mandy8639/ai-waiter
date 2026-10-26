"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import {
  cancelTerminal,
  checkTerminal,
  sendToTerminal,
  type TerminalOutcome,
} from "./in-person";

/**
 * Settle up → Square Terminal. Front of house may take payment, as with
 * cash and Tap to Pay; the database functions behind in-person.ts check
 * membership and settings again.
 */

const TAKERS = ["owner", "manager", "staff"] as const;

export async function sendBillToTerminal(
  restaurantId: string,
  orderIds: string[],
  deviceId: string,
): Promise<{ ok: true; paymentId: string } | { ok: false; error: string }> {
  const ids = z.array(z.uuid()).min(1).max(50).safeParse(orderIds);
  if (!ids.success) return { ok: false, error: "No orders to pay for." };
  if (!deviceId || deviceId.length > 100)
    return { ok: false, error: "Choose a Terminal." };

  const auth = await authorizeRestaurantAction(restaurantId, [...TAKERS]);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { data: restaurant } = await auth.context.supabase
    .from("restaurants")
    .select("name")
    .eq("id", restaurantId)
    .maybeSingle();

  return sendToTerminal({
    supabase: auth.context.supabase,
    restaurantId,
    restaurantName: restaurant?.name ?? "the restaurant",
    orderIds: ids.data,
    deviceId,
  });
}

export async function checkTerminalPayment(
  restaurantId: string,
  paymentId: string,
): Promise<
  { ok: true; outcome: TerminalOutcome } | { ok: false; error: string }
> {
  if (!z.uuid().safeParse(paymentId).success)
    return { ok: false, error: "That payment wasn't found." };
  const auth = await authorizeRestaurantAction(restaurantId, [...TAKERS]);
  if (!auth.ok) return { ok: false, error: auth.error };
  const result = await checkTerminal({
    supabase: auth.context.supabase,
    restaurantId,
    paymentId,
  });
  if (result.ok && result.outcome.state === "paid") {
    revalidatePath("/dashboard/checkout");
    revalidatePath("/dashboard/reports");
  }
  return result;
}

export async function cancelTerminalPayment(
  restaurantId: string,
  paymentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!z.uuid().safeParse(paymentId).success)
    return { ok: false, error: "That payment wasn't found." };
  const auth = await authorizeRestaurantAction(restaurantId, [...TAKERS]);
  if (!auth.ok) return { ok: false, error: auth.error };
  return cancelTerminal({
    supabase: auth.context.supabase,
    restaurantId,
    paymentId,
  });
}
