"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { reportError } from "@/lib/observability/report";
import {
  adjustSchema,
  adjustmentErrorMessage,
  type AdjustInput,
} from "./adjustment-core";

/**
 * Settle up → Adjust. Owners and managers directly; a waiter with a
 * manager's PIN (20261117090000). The PIN is checked first, on its own
 * (verify_approval_pin() counts wrong ones and locks a waiter out), and
 * only the single-use token it returns reaches adjust_order() /
 * remove_order_adjustment(), which check the role or token again (with
 * two-step verification, via current_restaurant_role()) and refuse an
 * order a payment has started on.
 */

export type AdjustResult = { ok: true } | { ok: false; error: string };

const FRONT_OF_HOUSE = ["owner", "manager", "staff"] as const;

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

/**
 * A token for one approved change, from a manager's PIN; null (no
 * approval needed) when no PIN was given, so an owner or manager acting
 * on their own login goes straight through.
 */
async function approval(
  rpc: Rpc,
  restaurantId: string,
  pin: string | undefined,
): Promise<{ ok: true; token: string | null } | { ok: false; error: string }> {
  if (!pin) return { ok: true, token: null };
  if (!/^[0-9]{4,6}$/.test(pin))
    return { ok: false, error: "A manager's PIN is 4 to 6 digits." };
  const { data, error } = await rpc("verify_approval_pin", {
    p_restaurant_id: restaurantId,
    p_pin: pin,
  });
  if (error) {
    reportError(error, { scope: "payments.adjust.pin" });
    return { ok: false, error: "Couldn't check the PIN. Try again." };
  }
  const row = (data as { outcome: string; token: string | null }[] | null)?.[0];
  if (row?.outcome === "ok" && row.token) return { ok: true, token: row.token };
  return {
    ok: false,
    error:
      row?.outcome === "locked"
        ? "Too many wrong PINs. Try again in 15 minutes."
        : "That PIN doesn't match a manager here.",
  };
}

function refresh() {
  revalidatePath("/dashboard/checkout");
  revalidatePath("/dashboard/reports");
}

export async function adjustOrder(
  input: AdjustInput,
  pin?: string,
): Promise<AdjustResult> {
  const parsed = adjustSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the details.",
    };
  }
  const p = parsed.data;
  if (p.kind === "discount" && (p.percent === null) === (p.amount === null)) {
    return { ok: false, error: "Give a percentage or an amount." };
  }

  const auth = await authorizeRestaurantAction(p.restaurantId, [
    ...FRONT_OF_HOUSE,
  ]);
  if (!auth.ok) return { ok: false, error: auth.error };
  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as Rpc;
  const approved = await approval(rpc, p.restaurantId, pin);
  if (!approved.ok) return approved;

  const { error } = await rpc("adjust_order", {
    p_order_id: p.orderId,
    p_kind: p.kind,
    p_reason: p.reason,
    p_order_item_id: p.kind === "discount" ? null : p.itemId,
    p_quantity: p.kind === "discount" ? null : p.quantity,
    p_percent: p.kind === "discount" ? p.percent : null,
    p_amount: p.kind === "discount" ? p.amount : null,
    p_approval_token: approved.token,
  });
  if (error) {
    if (!/^ADJUST_/.test(error.message))
      reportError(error, { scope: "payments.adjust", extra: { kind: p.kind } });
    return { ok: false, error: adjustmentErrorMessage(error.message) };
  }
  refresh();
  return { ok: true };
}

export async function removeAdjustment(
  restaurantId: string,
  adjustmentId: string,
  pin?: string,
): Promise<AdjustResult> {
  if (!z.uuid().safeParse(adjustmentId).success)
    return { ok: false, error: "That change wasn't found." };
  const auth = await authorizeRestaurantAction(restaurantId, [
    ...FRONT_OF_HOUSE,
  ]);
  if (!auth.ok) return { ok: false, error: auth.error };
  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as Rpc;
  const approved = await approval(rpc, restaurantId, pin);
  if (!approved.ok) return approved;

  const { error } = await rpc("remove_order_adjustment", {
    p_adjustment_id: adjustmentId,
    p_approval_token: approved.token,
  });
  if (error) {
    if (!/^ADJUST_/.test(error.message))
      reportError(error, { scope: "payments.adjust.remove" });
    return { ok: false, error: adjustmentErrorMessage(error.message) };
  }
  refresh();
  return { ok: true };
}
