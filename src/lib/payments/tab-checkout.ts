"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getStripe, isStripeConfigured } from "./stripe";
import { toMinorUnits } from "./money";
import { parsePaymentError } from "./errors";
import { parseTip } from "./tip";
import { reportError } from "@/lib/observability/report";
import { openSquareCheckout } from "@/lib/pos/square/checkout";

/**
 * Paying a whole tab by card — every unpaid order in this diner's session,
 * in one Stripe Checkout.
 *
 * Deliberately the same shape as startOrderCheckout(), because the three
 * properties that matter are the same and are worth being the same in both
 * places:
 *
 *  1. The diner never names the price. `start_tab_payment()` gathers the
 *     orders and sums them itself; the only number sent from here is the
 *     tip. Nothing in this file accepts an amount from the browser — and
 *     note that no order ids are sent either. The session comes from
 *     auth.uid() inside the function, so a diner cannot enumerate someone
 *     else's table into their own tab.
 *
 *  2. The charge is DIRECT on the restaurant's connected account.
 *
 *  3. Returning from Checkout proves nothing; only the signed webhook
 *     settles. That already handles a tab without change — settlement
 *     keys on the checkout session, and coverage lives in payment_orders,
 *     so marking one payment succeeded settles every order it covers.
 */

export interface CheckoutState {
  error?: string;
}

interface StartTabPaymentRow {
  payment_id: string;
  amount: string;
  tip_amount: string;
  total_amount: string;
  currency: string;
  /** NULL when the restaurant takes cards through Square. */
  stripe_account_id: string | null;
  order_count: number;
}

/** Absolute origin for Stripe's return URLs, derived from the live request. */
async function appOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function startTabCheckout(
  restaurantSlug: string,
  _prevState: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const parsedTip = parseTip(formData.get("tip"));
  if (!parsedTip.ok) {
    return { error: parsedTip.message };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("start_tab_payment", {
    p_tip_amount: parsedTip.value,
  });

  if (error) {
    // Exactly where the unqualified DELETE surfaced as "21000" and went
    // no further than the diner's screen.
    reportError(error, {
      scope: "payments.tab.start",
      extra: { restaurantSlug },
    });
    return { error: parsePaymentError(error.message) };
  }

  const payment = (data as StartTabPaymentRow[] | null)?.[0];
  if (!payment) {
    return { error: "Couldn't start this payment. Please try again." };
  }

  // A NULL Stripe account means this restaurant takes cards through Square
  // (start_tab_payment, 20261110090000).
  if (payment.stripe_account_id === null) {
    const square = await openSquareCheckout({
      supabase,
      payment,
      redirectUrl: `${await appOrigin()}/r/${restaurantSlug}/orders?paid=1`,
      scope: "payments.tab.square",
    });
    if ("error" in square) return { error: square.error };
    // Outside any try: redirect() signals by throwing.
    redirect(square.url);
  }

  if (!isStripeConfigured()) {
    return { error: "Card payments aren't set up for this restaurant yet." };
  }

  // The platform's cut — same rule as the single-order path: computed on
  // `amount` and not `total_amount`, because the tip belongs to the staff.
  // A billing lookup must never fail a diner's checkout.
  let applicationFeeMinorUnits = 0;
  try {
    const { data: feeData, error: feeError } = await supabase.rpc(
      "platform_fee_for_payment",
      {
        p_payment_id: payment.payment_id,
        p_amount_minor_units: toMinorUnits(payment.amount, payment.currency),
      },
    );
    if (feeError) throw feeError;
    applicationFeeMinorUnits = Number(feeData ?? 0);
  } catch (feeLookupError) {
    reportError(feeLookupError, {
      scope: "platform.fee.tab",
      extra: { paymentId: payment.payment_id },
    });
  }

  const origin = await appOrigin();
  const ordersUrl = `${origin}/r/${restaurantSlug}/orders`;

  let checkoutUrl: string;
  try {
    const session = await getStripe().checkout.sessions.create(
      {
        mode: "payment",
        // One line for the tab rather than one per order, matching the
        // single-order case: the orders are the source of truth for what
        // was bought, and copying them into Stripe would create a second
        // version that could disagree. The count is named so the diner can
        // see on Stripe's own page what they are settling.
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: payment.currency.toLowerCase(),
              unit_amount: toMinorUnits(payment.amount, payment.currency),
              product_data: {
                name:
                  payment.order_count === 1
                    ? "Your order"
                    : `Your tab (${payment.order_count} orders)`,
              },
            },
          },
          ...(Number(payment.tip_amount) > 0
            ? [
                {
                  quantity: 1,
                  price_data: {
                    currency: payment.currency.toLowerCase(),
                    unit_amount: toMinorUnits(
                      payment.tip_amount,
                      payment.currency,
                    ),
                    product_data: { name: "Tip" },
                  },
                },
              ]
            : []),
        ],
        ...(applicationFeeMinorUnits > 0
          ? {
              payment_intent_data: {
                application_fee_amount: applicationFeeMinorUnits,
              },
            }
          : {}),
        success_url: `${ordersUrl}?paid=1`,
        cancel_url: `${ordersUrl}?cancelled=1`,
        client_reference_id: payment.payment_id,
        // No order_id here, unlike the single-order case: a tab has many,
        // and payment_orders is the only place that answers which.
        metadata: {
          payment_id: payment.payment_id,
          order_count: String(payment.order_count),
        },
      },
      {
        stripeAccount: payment.stripe_account_id,
        // Keyed on the payment row, so a double submit reuses the session
        // rather than opening a second one against the same tab.
        idempotencyKey: `checkout:${payment.payment_id}`,
      },
    );

    if (!session.url) {
      return { error: "Stripe didn't return a payment page. Please retry." };
    }
    checkoutUrl = session.url;

    const { error: attachError } = await supabase.rpc(
      "attach_payment_checkout_session",
      { p_payment_id: payment.payment_id, p_checkout_session_id: session.id },
    );
    if (attachError) {
      reportError(attachError, {
        scope: "payments.tab.attach",
        extra: { paymentId: payment.payment_id },
      });
      return { error: "Couldn't start this payment safely. Please try again." };
    }
  } catch (stripeError) {
    reportError(stripeError, {
      scope: "payments.tab.stripe",
      extra: { paymentId: payment.payment_id },
    });
    return { error: "Couldn't reach Stripe. Please try again." };
  }

  // Outside the try: redirect() signals by throwing, and catching it here
  // would turn a successful checkout into an error message.
  redirect(checkoutUrl);
}
