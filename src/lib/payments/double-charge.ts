import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report";
import { getPayment, refundSquarePayment } from "@/lib/pos/square/api";
import { buildSquareRefund } from "@/lib/pos/square/refund-core";
import { getStripe, isStripeConfigured } from "./stripe";

/**
 * Gives a guest their money back when their card payment landed on a bill
 * that was already settled another way (20261120090000): the settle
 * functions answered 'double_paid' and recorded a payment_conflicts row.
 *
 * Refunds the whole charge, Tableside's fee included — the restaurant
 * shouldn't pay a fee on money it gives back, and the guest owes nothing.
 * Keyed on the conflict, so a webhook retry never refunds twice. Whatever
 * happens is recorded on the conflict, which Settle up shows the
 * restaurant: "refunded", or "refund this yourself" when it couldn't be.
 * Never throws: the webhook must still answer 200, or the provider keeps
 * retrying a payment nothing can settle.
 */
export async function refundDoubleCharge(
  provider: "stripe" | "square",
  providerPaymentId: string,
): Promise<void> {
  // payment_conflicts is newer than database.types.ts.
  const admin = createAdminClient() as unknown as SupabaseClient;
  const { data: conflict } = await admin
    .from("payment_conflicts")
    .select("id, restaurant_id, amount, currency, refund_status")
    .eq("provider", provider)
    .eq("provider_payment_id", providerPaymentId)
    .maybeSingle<{
      id: string;
      restaurant_id: string;
      amount: string;
      currency: string;
      refund_status: string;
    }>();

  reportError(new Error("A guest paid for a bill that was already settled"), {
    scope: "payments.double_charge",
    extra: { provider, providerPaymentId, conflictId: conflict?.id },
  });
  if (!conflict || conflict.refund_status === "refunded") return;

  let refundId: string | null = null;
  let failure: string | null = null;
  try {
    refundId =
      provider === "stripe"
        ? await refundStripe(
            admin,
            conflict.restaurant_id,
            conflict.id,
            providerPaymentId,
          )
        : await refundSquare(
            conflict.restaurant_id,
            conflict.id,
            providerPaymentId,
          );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    reportError(error, {
      scope: "payments.double_charge.refund",
      extra: { provider, conflictId: conflict.id },
    });
  }

  const { error } = await admin.rpc("record_payment_conflict_refund", {
    p_conflict_id: conflict.id,
    p_refund_id: refundId,
    p_error: failure,
  });
  if (error) {
    reportError(error, {
      scope: "payments.double_charge.record",
      extra: { conflictId: conflict.id, refundId },
    });
  }
}

async function refundStripe(
  admin: SupabaseClient,
  restaurantId: string,
  conflictId: string,
  paymentIntentId: string,
): Promise<string> {
  if (!isStripeConfigured()) throw new Error("Stripe isn't configured");
  if (!paymentIntentId.startsWith("pi_")) {
    throw new Error("Stripe didn't say which payment to refund");
  }
  const { data: account } = await admin
    .from("restaurant_payment_accounts")
    .select("stripe_account_id")
    .eq("restaurant_id", restaurantId)
    .maybeSingle<{ stripe_account_id: string }>();
  if (!account) throw new Error("The restaurant has no Stripe account");

  const refund = await getStripe().refunds.create(
    {
      payment_intent: paymentIntentId,
      reason: "duplicate",
      refund_application_fee: true,
      metadata: { payment_conflict_id: conflictId },
    },
    {
      // A direct charge is refunded on the restaurant's account.
      stripeAccount: account.stripe_account_id,
      idempotencyKey: `double-charge:${conflictId}`,
    },
  );
  return refund.id;
}

async function refundSquare(
  restaurantId: string,
  conflictId: string,
  squarePaymentId: string,
): Promise<string> {
  const payment = await getPayment(restaurantId, squarePaymentId);
  const refund = await refundSquarePayment(
    restaurantId,
    buildSquareRefund({
      // The idempotency key Square sees, from our row.
      refundId: conflictId,
      squarePaymentId,
      amountMinorUnits: payment.totalMinorUnits,
      currency: payment.currency,
      paymentTotalMinorUnits: payment.totalMinorUnits,
      appFeeMinorUnits: payment.appFeeMinorUnits,
      reason: "Paid twice: the bill was already settled",
    }),
  );
  return refund.id;
}
