"use server";

import { z } from "zod";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { reportError } from "@/lib/observability/report";
import { emailConfig } from "@/lib/email/config";
import { sendWithResend } from "@/lib/email/resend";
import { renderReceiptEmail } from "@/lib/email/templates";
import { getReceipt } from "./receipt";
import { paymentMethodLabel } from "./method";

/**
 * Emailing a guest their receipt, from Settle up or Reports. Front of
 * house, as with taking the payment. The receipt is read through the
 * staff member's own access (getReceipt(), RLS), and the payment must be
 * this restaurant's.
 */

export type ReceiptEmailResult = { ok: true } | { ok: false; error: string };

const email = z.email().max(254);

export async function emailReceipt(
  restaurantId: string,
  paymentId: string,
  to: string,
): Promise<ReceiptEmailResult> {
  const address = email.safeParse(to.trim());
  if (!address.success)
    return { ok: false, error: "Enter the guest's email address." };
  if (!z.uuid().safeParse(paymentId).success)
    return { ok: false, error: "That payment wasn't found." };

  const config = emailConfig();
  if (!config)
    return { ok: false, error: "Email isn't set up for Tableside yet." };

  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
    "staff",
  ]);
  if (!auth.ok) return { ok: false, error: auth.error };
  const supabase = auth.context.supabase;

  const [{ data: payment }, { data: restaurant }, receipt] = await Promise.all([
    supabase
      .from("order_payments")
      .select("id")
      .eq("id", paymentId)
      .eq("restaurant_id", restaurantId)
      .maybeSingle(),
    supabase
      .from("restaurants")
      .select("name, address, city, state, postal_code, timezone")
      .eq("id", restaurantId)
      .maybeSingle(),
    getReceipt(paymentId),
  ]);
  if (!payment || !receipt || !restaurant)
    return { ok: false, error: "That payment wasn't found." };
  if (receipt.state === "unpaid" || receipt.state === "reversed")
    return {
      ok: false,
      error: "That payment has nothing to give a receipt for.",
    };

  const place = [restaurant.city, restaurant.state].filter(Boolean).join(", ");
  const paidAt = receipt.paidAt ? new Date(receipt.paidAt) : new Date();
  const message = renderReceiptEmail({
    restaurantName: restaurant.name,
    restaurantAddress:
      [restaurant.address, place, restaurant.postal_code]
        .filter(Boolean)
        .join(", ") || null,
    currency: receipt.currency,
    paidLabel: paidAt.toLocaleString("en-US", {
      timeZone: restaurant.timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    methodLabel: paymentMethodLabel(receipt.method),
    lines: receipt.orders.flatMap((o) =>
      o.lines.map((l) => ({
        name: l.itemName,
        quantity: l.quantity,
        amount: l.lineTotal,
      })),
    ),
    amount: receipt.amount,
    tip: receipt.tip,
    refunded: receipt.refunded,
    net: receipt.net,
  });

  const result = await sendWithResend({
    apiKey: config.apiKey,
    from: config.from,
    to: address.data,
    message,
    // A double tap within the minute sends one email, not two.
    idempotencyKey: `receipt:${paymentId}:${address.data}:${Math.floor(Date.now() / 60_000)}`,
  });
  if (!result.ok) {
    reportError(new Error(`Receipt email failed: ${result.error}`), {
      scope: "payments.receipt.email",
      extra: { paymentId },
    });
    return { ok: false, error: "The email didn't send. Try again." };
  }
  return { ok: true };
}
