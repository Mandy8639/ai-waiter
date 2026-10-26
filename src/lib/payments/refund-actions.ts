"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getStripe, isStripeConfigured } from "./stripe";
import { toMinorUnits } from "./money";
import { formatMoney } from "@/lib/orders/format";
import { parsePaymentError } from "./errors";
import { parseRefundReason, parseRefundAmount } from "./refund-reason";
import { reportError } from "@/lib/observability/report";
import { copyRefundToSquare, sendSquareRefund } from "@/lib/pos/square/refunds";

/**
 * Refunding a payment.
 *
 * The order of operations is the whole design, and it is deliberately the
 * same shape as taking a payment, inverted:
 *
 *   1. `start_refund()` records our intent FIRST, as a pending row. It
 *      also enforces everything that matters — owner/manager only, card
 *      only, settled payments only, and never more than was charged.
 *   2. Only then do we ask Stripe.
 *   3. `attach_refund_stripe_id()` links the Stripe refund back and
 *      settles it.
 *
 * Recording first is what makes a crash survivable. If step 2 or 3 fails,
 * a pending refund row remains and someone can see that money was meant to
 * go back. The reverse order — refund at Stripe, then write a row — loses
 * the record entirely if the process dies in between, and a refund nobody
 * knows about is indistinguishable from money that simply vanished.
 *
 * The cost of this order is that a failed Stripe call leaves a pending row
 * holding budget against the payment (pending refunds count as committed),
 * so it is explicitly cancelled below rather than left to rot.
 */

export interface RefundState {
  error?: string;
  success?: string;
}

interface StartRefundRow {
  refund_id: string;
  amount: string;
  currency: string;
  /** Where the money goes back through (20261114090000). */
  provider: "stripe" | "square" | "none";
  stripe_payment_intent_id: string | null;
  stripe_account_id: string | null;
  square_payment_id: string | null;
  restaurant_id: string;
}

export async function refundPayment(
  paymentId: string,
  _prevState: RefundState,
  formData: FormData,
): Promise<RefundState> {
  const reason = parseRefundReason(
    formData.get("category"),
    formData.get("note"),
  );
  if (!reason.ok) return { error: reason.message };

  const amount = parseRefundAmount(formData.get("amount"));
  if (!amount.ok) return { error: amount.message };

  const supabase = await createClient();

  // Step 1 — record the intent, and let the database enforce the rules.
  const { data, error } = await supabase.rpc("start_refund", {
    p_payment_id: paymentId,
    p_amount: amount.value,
    p_reason: reason.storedReason,
  });

  if (error) {
    reportError(error, {
      scope: "payments.refund.start",
      extra: { paymentId },
    });
    return { error: parsePaymentError(error.message) };
  }

  const refund = (data as StartRefundRow[] | null)?.[0];
  if (!refund) {
    return { error: "Couldn't start that refund. Please try again." };
  }

  // Formatted through the same helper the rest of the app uses, so the
  // confirmation reads in the currency the staff member has been looking
  // at all along rather than a raw code and an unpadded number.
  const formatted = formatMoney(Number(refund.amount), refund.currency);

  // Cash or a card machine: the restaurant hands the money back itself;
  // start_refund() has already recorded it as done.
  if (refund.provider === "none") {
    // A sale copied into Square gets the refund there too (20261118090000).
    if (refund.square_payment_id) {
      const squarePaymentId = refund.square_payment_id;
      const client = supabase as unknown as SupabaseClient;
      after(() =>
        copyRefundToSquare({
          supabase: client,
          restaurantId: refund.restaurant_id,
          refundId: refund.refund_id,
          squarePaymentId,
          amount: refund.amount,
          currency: refund.currency,
          reason: reason.storedReason,
        }),
      );
    }
    revalidatePath("/dashboard/reports");
    return {
      success: `Recorded a refund of ${formatted}.`,
    };
  }

  if (refund.provider === "square") {
    const outcome = await sendSquareRefund({
      supabase: supabase as unknown as SupabaseClient,
      restaurantId: refund.restaurant_id,
      refundId: refund.refund_id,
      squarePaymentId: refund.square_payment_id!,
      amount: refund.amount,
      currency: refund.currency,
      reason: reason.storedReason,
    });
    revalidatePath("/dashboard/reports");
    if (!outcome.ok) return { error: outcome.error };
    if (outcome.status === "failed")
      return { error: "Square declined that refund. Nothing was sent." };
    return {
      success:
        outcome.status === "succeeded"
          ? `Refunded ${formatted} to the guest's card.`
          : `Refund of ${formatted} sent. Square is finishing it; Reports will show when it's done.`,
    };
  }

  if (!isStripeConfigured()) {
    await supabase.rpc("cancel_pending_refund", {
      p_refund_id: refund.refund_id,
    });
    return { error: "Stripe isn't configured, so refunds can't be issued." };
  }

  // Step 2 — ask Stripe.
  let succeeded = false;
  let stripeRefundId: string;
  try {
    const created = await getStripe().refunds.create(
      {
        payment_intent: refund.stripe_payment_intent_id!,
        amount: toMinorUnits(refund.amount, refund.currency),
        reason: reason.category,
        // Our own row id travels with it, so a Stripe-side investigation
        // can be tied back to the record that authorised it.
        metadata: { refund_id: refund.refund_id, note: reason.note },
      },
      {
        // The refund must go back through the account the charge was made
        // on — a direct charge lives on the restaurant's account, not the
        // platform's.
        stripeAccount: refund.stripe_account_id!,
        // Keyed on our row, so a double-submitted form returns the same
        // Stripe refund instead of sending the money twice.
        idempotencyKey: `refund:${refund.refund_id}`,
      },
    );

    stripeRefundId = created.id;
    succeeded = created.status === "succeeded";
  } catch (stripeError) {
    reportError(stripeError, {
      scope: "payments.refund.stripe",
      extra: { paymentId, refundId: refund.refund_id },
    });
    // Stripe refused or was unreachable. Release the amount this pending
    // row was holding against the payment, or it silently blocks a later
    // retry for money that never actually moved.
    await supabase.rpc("cancel_pending_refund", {
      p_refund_id: refund.refund_id,
    });
    return {
      error: "Stripe wouldn't process that refund. Nothing has been sent.",
    };
  }

  // Step 3 — link it, and settle if Stripe already did.
  const { error: attachError } = await supabase.rpc("attach_refund_stripe_id", {
    p_refund_id: refund.refund_id,
    p_stripe_refund_id: stripeRefundId,
    p_succeeded: succeeded,
  });

  if (attachError) {
    // Money left the restaurant's account and this database does not know
    // it. The most consequential failure in the payment code, and until now
    // the only trace was a sentence on one person's screen.
    reportError(attachError, {
      scope: "payments.refund.attach",
      extra: { paymentId, refundId: refund.refund_id, stripeRefundId },
    });
    // The money HAS gone back; only our link failed. Say so plainly rather
    // than reporting a failure the customer's bank will contradict.
    return {
      error:
        "The refund was sent, but recording it failed. Check the payment before retrying.",
    };
  }

  revalidatePath("/dashboard/reports");

  return {
    success: succeeded
      ? `Refunded ${formatted}.`
      : `Refund of ${formatted} sent — awaiting confirmation from Stripe.`,
  };
}
