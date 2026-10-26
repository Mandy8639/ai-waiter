import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report";
import {
  completedPaymentFrom,
  verifySquareSignature,
} from "@/lib/pos/square/webhook-core";

/**
 * Square's webhook endpoint: the only place a Square card payment becomes
 * 'succeeded', the counterpart of src/app/api/webhooks/stripe/route.ts.
 *
 * The same rules as the Stripe webhook, for the same reasons:
 * - The signature is checked over the raw body before anything touches the
 *   database. A caller who can't sign learns nothing about why.
 * - The admin client is used because a webhook comes from Square, not a
 *   signed-in person; mark_square_payment_succeeded() is executable by
 *   service_role only.
 * - Settlement is idempotent in the database (a redelivered event is
 *   'already'), so no separate event-claim table is needed here.
 * - Anything this endpoint can't act on is acknowledged with 200: a 500
 *   would make Square retry forever for an event that will never apply.
 *
 * The diner's browser also comes back from Square, to `?paid=1`, but that
 * is only a URL anyone can type; it refreshes the page and proves nothing.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const notificationUrl = process.env.SQUARE_WEBHOOK_URL;
  if (!signatureKey || !notificationUrl) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const body = await request.text();
  if (
    !verifySquareSignature({
      body,
      signature: request.headers.get("x-square-hmacsha256-signature"),
      signatureKey,
      notificationUrl,
    })
  ) {
    // Reported because a wrong signature key looks exactly like this, and
    // it would silently stop every Square payment from settling.
    reportError(new Error("Square webhook signature rejected"), {
      scope: "square.webhook.signature",
    });
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ received: true, ignored: "unparseable" });
  }

  const payment = completedPaymentFrom(event);
  if (!payment) return NextResponse.json({ received: true, ignored: true });

  // One settlement path for online and Terminal payments
  // (20261111090000): a Terminal tip comes back on the payment.
  const { data, error } = await createAdminClient().rpc(
    // database.types.ts predates 20261111090000.
    "settle_square_payment" as never,
    {
      p_square_order_id: payment.orderId,
      p_square_payment_id: payment.paymentId,
      p_total_minor_units: payment.totalMinorUnits,
      p_tip_minor_units: payment.tipMinorUnits,
      p_currency: payment.currency,
    } as never,
  );
  if (error) {
    // A database failure is worth a retry: Square redelivers on non-2xx.
    reportError(error, {
      scope: "square.webhook.settle",
      extra: { squareOrderId: payment.orderId },
    });
    return NextResponse.json(
      { error: "could not apply event" },
      { status: 500 },
    );
  }

  const result = String(data);
  if (result === "mismatch") {
    // Square says a different amount was paid than Tableside asked for.
    // Never settle that silently; a person needs to look.
    reportError(new Error("Square payment amount doesn't match the bill"), {
      scope: "square.webhook.mismatch",
      extra: {
        squareOrderId: payment.orderId,
        squarePaymentId: payment.paymentId,
        totalMinorUnits: payment.totalMinorUnits,
        currency: payment.currency,
      },
    });
  }
  // 'unknown' is usually a payment the restaurant took in Square itself,
  // not through Tableside: nothing to do.
  return NextResponse.json({ received: true, result });
}
