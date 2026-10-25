import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toMinorUnits } from "@/lib/payments/money";
import { reportError } from "@/lib/observability/report";
import { SquareError, createPaymentLink, squarePaymentContext } from "./api";
import {
  BillMismatchError,
  buildSquarePaymentLink,
  requestTotalMinorUnits,
  type BillLine,
} from "./checkout-core";

/**
 * Opens Square's hosted checkout for a payment the diner has just started
 * (src/lib/payments/checkout.ts and tab-checkout.ts call this when the
 * restaurant's card provider is Square). Returns the URL to send the diner
 * to, or a message they can act on.
 *
 * Like the Stripe path, nothing here marks anything paid. Coming back from
 * Square proves nothing; only Square's signed webhook settles
 * (src/app/api/webhooks/square/route.ts).
 */
export async function openSquareCheckout(args: {
  /** The diner's own client: bill lines and the fee go through their RLS and ownership checks. */
  supabase: unknown;
  payment: {
    payment_id: string;
    amount: string;
    tip_amount: string;
    total_amount: string;
    currency: string;
  };
  redirectUrl: string;
  scope: string;
}): Promise<{ url: string } | { error: string }> {
  const supabase = args.supabase as SupabaseClient;
  const { payment } = args;
  const fail = (e: unknown, message: string) => {
    reportError(e, {
      scope: args.scope,
      extra: {
        paymentId: payment.payment_id,
        detail:
          e instanceof SquareError
            ? e.detail
            : e instanceof Error
              ? e.message
              : undefined,
      },
    });
    return { error: message };
  };

  let context;
  try {
    context = await squarePaymentContext(payment.payment_id);
  } catch (e) {
    return fail(
      e,
      e instanceof SquareError ? e.message : "Couldn't start this payment.",
    );
  }
  // A checkout already open for this payment (the diner went back, or
  // double-tapped): send them to the same one.
  if (context.existingCheckoutUrl) return { url: context.existingCheckoutUrl };

  const { data: lines, error: linesError } = await supabase.rpc(
    "payment_bill_lines",
    {
      p_payment_id: payment.payment_id,
    },
  );
  if (linesError)
    return fail(linesError, "Couldn't load your bill. Please try again.");

  // Same rule as the Stripe path: the fee is on the bill without the tip,
  // and a failure to work it out never stops a diner paying.
  let appFeeMinorUnits = 0;
  try {
    const { data: fee, error: feeError } = await supabase.rpc(
      "platform_fee_for_payment",
      {
        p_payment_id: payment.payment_id,
        p_amount_minor_units: toMinorUnits(payment.amount, payment.currency),
      },
    );
    if (feeError) throw feeError;
    appFeeMinorUnits = Number(fee ?? 0);
  } catch (feeLookupError) {
    reportError(feeLookupError, {
      scope: "platform.fee.square",
      extra: { paymentId: payment.payment_id },
    });
  }

  let request;
  try {
    request = buildSquarePaymentLink({
      paymentId: payment.payment_id,
      locationId: context.locationId,
      currency: payment.currency,
      amount: payment.amount,
      tipAmount: payment.tip_amount,
      lines: (lines ?? []) as BillLine[],
      appFeeMinorUnits,
      redirectUrl: args.redirectUrl,
      note: `Tableside: ${context.restaurantName}`,
    });
    // Belt and braces: what Square will charge must be what the database
    // froze, to the cent.
    if (
      requestTotalMinorUnits(request) !==
      toMinorUnits(payment.total_amount, payment.currency)
    ) {
      throw new BillMismatchError(
        "Square request total differs from the payment total.",
      );
    }
  } catch (e) {
    return fail(e, "Couldn't prepare your bill. Please ask your server.");
  }

  let link;
  try {
    link = await createPaymentLink(context.restaurantId, request);
  } catch (e) {
    return fail(e, "Couldn't reach Square. Please try again.");
  }

  // Record which Square order this checkout created; the webhook settles
  // on it. If this can't be recorded, the payment could never be settled,
  // so refuse now rather than take money we can't match.
  const { error: attachError } = await supabase.rpc("attach_square_checkout", {
    p_payment_id: payment.payment_id,
    p_square_order_id: link.orderId,
    p_checkout_url: link.url,
  });
  if (attachError)
    return fail(
      attachError,
      "Couldn't start this payment safely. Please try again.",
    );

  return { url: link.url };
}
