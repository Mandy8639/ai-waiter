"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getStripe, isStripeConfigured } from "./stripe";
import { toMinorUnits } from "./money";
import { parsePaymentError } from "./errors";
import { parseTip } from "./tip";

/**
 * Card payment for an order, via Stripe Checkout (hosted).
 *
 * Three properties matter more than anything else here, and each is
 * enforced somewhere it cannot be skipped:
 *
 *  1. The diner never names the price. `start_order_payment()` reads the
 *     amount from the order itself; the only number this action sends is
 *     the tip, which that function also validates. Nothing in this file
 *     accepts an amount from the browser.
 *
 *  2. The charge is DIRECT on the restaurant's connected account, via the
 *     `stripeAccount` request option. Money never touches a platform
 *     balance, so this platform is not a money transmitter — the reason
 *     phase 1 shaped the account the way it did.
 *
 *  3. Returning from Checkout proves nothing. The return URL is just a URL
 *     the diner can visit, share, or replay, so this action never marks
 *     anything paid. Only the signed webhook does, through a function
 *     granted to service_role alone.
 */

export interface CheckoutState {
  error?: string;
}

interface StartPaymentRow {
  payment_id: string;
  amount: string;
  tip_amount: string;
  total_amount: string;
  currency: string;
  stripe_account_id: string;
}

/** Absolute origin for Stripe's return URLs, derived from the live request. */
async function appOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export async function startOrderCheckout(
  orderId: string,
  restaurantSlug: string,
  _prevState: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  if (!isStripeConfigured()) {
    return { error: "Card payments aren't set up for this restaurant yet." };
  }

  const parsedTip = parseTip(formData.get("tip"));
  if (!parsedTip.ok) {
    return { error: parsedTip.message };
  }
  const tip = parsedTip.value;

  const supabase = await createClient();

  // Creates the pending payment row and hands back everything needed to
  // open a session — including the amount, which comes from the order.
  const { data, error } = await supabase.rpc("start_order_payment", {
    p_order_id: orderId,
    p_tip_amount: tip,
  });

  if (error) {
    return { error: parsePaymentError(error.message) };
  }

  const payment = (data as StartPaymentRow[] | null)?.[0];
  if (!payment) {
    return { error: "Couldn't start this payment. Please try again." };
  }

  const origin = await appOrigin();
  const orderUrl = `${origin}/r/${restaurantSlug}/order/${orderId}`;

  let checkoutUrl: string;
  try {
    const session = await getStripe().checkout.sessions.create(
      {
        mode: "payment",
        // One line item for the whole order rather than a copy of every
        // dish: the order is the source of truth for what was bought, and
        // duplicating the basket into Stripe would create a second version
        // of it that could disagree.
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: payment.currency.toLowerCase(),
              unit_amount: toMinorUnits(payment.amount, payment.currency),
              product_data: { name: "Your order" },
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
        success_url: `${orderUrl}?paid=1`,
        cancel_url: `${orderUrl}?cancelled=1`,
        // Carried back on the webhook event so settlement never has to
        // guess which payment a session belongs to.
        client_reference_id: payment.payment_id,
        metadata: { payment_id: payment.payment_id, order_id: orderId },
      },
      {
        // A direct charge on the restaurant's own account. Without this
        // the money would land on the platform account, which is exactly
        // the arrangement this design exists to avoid.
        stripeAccount: payment.stripe_account_id,
        // Stripe-side deduplication: a double-submitted form reuses the
        // same session instead of opening a second one against the same
        // payment row.
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
      // The session exists but this database cannot recognise it, so the
      // webhook would have nothing to settle. Better to refuse now than to
      // take a payment we cannot record.
      return {
        error: "Couldn't start this payment safely. Please try again.",
      };
    }
  } catch {
    return { error: "Couldn't reach Stripe. Please try again." };
  }

  // Outside the try: redirect() signals by throwing, and catching it here
  // would turn a successful checkout into an error message.
  redirect(checkoutUrl);
}
