"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { reportError } from "@/lib/observability/report";
import { sendSplitToTerminal } from "@/lib/pos/square/in-person";
import { parsePaymentError } from "./errors";
import { parseTip } from "./tip";

/**
 * Settle up → Split (20261115090000). Front of house, as with taking any
 * payment; the database functions check the role, the restaurant's
 * settings and the parts again. A part on a Square Terminal is then
 * checked and cancelled with the ordinary Terminal actions
 * (src/lib/pos/square/terminal-actions.ts), since it is an ordinary
 * Terminal payment.
 */

export type SplitResult = { ok: true } | { ok: false; error: string };

const TAKERS = ["owner", "manager", "staff"] as const;

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

const ids = z.array(z.uuid()).min(1).max(50);

async function authorized(restaurantId: string) {
  const auth = await authorizeRestaurantAction(restaurantId, [...TAKERS]);
  if (!auth.ok) return auth;
  return {
    ok: true as const,
    supabase: auth.context.supabase,
    rpc: auth.context.supabase.rpc.bind(
      auth.context.supabase,
    ) as unknown as Rpc,
  };
}

function done(): SplitResult {
  revalidatePath("/dashboard/checkout");
  return { ok: true };
}

function failed(error: { message: string }, scope: string): SplitResult {
  if (!/^(SPLIT|PAYMENT)_/.test(error.message)) reportError(error, { scope });
  return { ok: false, error: parsePaymentError(error.message) };
}

export async function createStaffSplit(
  restaurantId: string,
  orderIds: string[],
  mode: "equal" | "by_dish",
  shares: number | null,
): Promise<SplitResult> {
  const orders = ids.safeParse(orderIds);
  if (!orders.success) return { ok: false, error: "No orders to split." };
  if (mode !== "equal" && mode !== "by_dish")
    return { ok: false, error: "Choose how to split the bill." };
  if (
    mode === "equal" &&
    (!Number.isInteger(shares) || shares! < 2 || shares! > 20)
  )
    return { ok: false, error: "Split the bill between 2 and 20 people." };

  const auth = await authorized(restaurantId);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { error } = await auth.rpc("create_staff_split", {
    p_order_ids: orders.data,
    p_mode: mode,
    p_share_count: mode === "equal" ? shares : null,
  });
  if (error) return failed(error, "payments.split.create");
  return done();
}

export async function cancelStaffSplit(
  restaurantId: string,
  splitId: string,
): Promise<SplitResult> {
  if (!z.uuid().safeParse(splitId).success)
    return { ok: false, error: "That split wasn't found." };
  const auth = await authorized(restaurantId);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { error } = await auth.rpc("cancel_staff_split", {
    p_split_id: splitId,
  });
  if (error) return failed(error, "payments.split.cancel");
  return done();
}

export async function paySplitInPerson(
  restaurantId: string,
  splitId: string,
  unitIds: string[],
  method: "cash" | "card_terminal",
  tip: string,
): Promise<SplitResult> {
  const units = ids.safeParse(unitIds);
  if (!z.uuid().safeParse(splitId).success || !units.success)
    return { ok: false, error: "Choose what's being paid for." };
  if (method !== "cash" && method !== "card_terminal")
    return {
      ok: false,
      error: "Record either cash or a card-machine payment.",
    };
  const parsedTip = parseTip(tip);
  if (!parsedTip.ok) return { ok: false, error: parsedTip.message };

  const auth = await authorized(restaurantId);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { error } = await auth.rpc("pay_split_in_person", {
    p_split_id: splitId,
    p_unit_ids: units.data,
    p_method: method,
    p_tip_amount: parsedTip.value,
  });
  if (error) return failed(error, "payments.split.pay");
  revalidatePath("/dashboard/reports");
  return done();
}

export async function sendSplitPartsToTerminal(
  restaurantId: string,
  splitId: string,
  unitIds: string[],
  deviceId: string,
  tableLabel: string,
): Promise<{ ok: true; paymentId: string } | { ok: false; error: string }> {
  const units = ids.safeParse(unitIds);
  if (!z.uuid().safeParse(splitId).success || !units.success)
    return { ok: false, error: "Choose what's being paid for." };
  if (!deviceId || deviceId.length > 100)
    return { ok: false, error: "Choose a Terminal." };

  const auth = await authorized(restaurantId);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { data: restaurant } = await auth.supabase
    .from("restaurants")
    .select("name")
    .eq("id", restaurantId)
    .maybeSingle();
  return sendSplitToTerminal({
    supabase: auth.supabase,
    restaurantId,
    restaurantName: restaurant?.name ?? "the restaurant",
    tableLabel: tableLabel.slice(0, 80),
    splitId,
    unitIds: units.data,
    deviceId,
  });
}
