import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";
import { getStripe, isStripeConfigured } from "@/lib/payments/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report";

/**
 * Stripe's webhook for the PLATFORM account's own events.
 *
 * Separate from /api/webhooks/stripe, which handles connected-account
 * events, for three reasons that all point the same way:
 *
 *  1. Different trust domain. That endpoint's secret authenticates events
 *     about restaurants' charges; this one authenticates events about the
 *     platform's own revenue. One secret verifying both would mean a leak
 *     of either compromises both.
 *  2. Different source. Connected-account events arrive from a
 *     destination configured with `events_from: ["@accounts"]`, and that
 *     field is create-only — platform events were never going to be
 *     delivered there without a second destination anyway.
 *  3. `checkout.session.completed` already means "a diner paid for an
 *     order" in the other route. A subscription checkout emits the same
 *     event type, and teaching one handler to branch on `mode` would put
 *     the platform's billing and a diner's dinner one missing condition
 *     apart.
 *
 * THE ADMIN CLIENT, AGAIN
 *
 * Like the other webhook, this uses the RLS-bypassing client because
 * Stripe is not a signed-in person. The signature check above is the
 * entire authentication, which is why an unverified request never reaches
 * a database call.
 */

export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_PLATFORM_WEBHOOK_SECRET;

  if (!isStripeConfigured() || !secret) {
    // 503 rather than 400: nothing is wrong with the request, the server
    // simply is not set up to receive it yet. Stripe retries a 503.
    return NextResponse.json(
      { error: "platform billing not configured" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = await getStripe().webhooks.constructEventAsync(
      payload,
      signature,
      secret,
    );
  } catch (verifyError) {
    // Reported for the same reason as the other endpoint: this is also
    // what a wrong STRIPE_PLATFORM_WEBHOOK_SECRET looks like, and that
    // silently stops every subscription from ever being recorded.
    reportError(verifyError, { scope: "billing.webhook.signature" });
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Claim the event id, sharing the other endpoint's dedupe table: event
  // ids are unique across the whole Stripe account, so a duplicate
  // delivery loses this race against its own earlier self.
  const { error: claimError } = await admin
    .from("stripe_webhook_events")
    .insert({ stripe_event_id: event.id, event_type: event.type });

  if (claimError) {
    if (claimError.code === "23505") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    reportError(claimError, {
      scope: "billing.webhook.claim",
      extra: { eventType: event.type },
    });
    return NextResponse.json(
      { error: "could not record event" },
      { status: 500 },
    );
  }

  // Every subscription event carries the complete current state, so they
  // are all handled identically: write what Stripe says. That is what
  // makes out-of-order and repeated delivery harmless rather than a
  // sequencing problem to solve.
  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const subscription = event.data.object as Stripe.Subscription;
    const restaurantId = subscription.metadata?.restaurant_id;
    const planId = subscription.metadata?.plan_id;

    if (!restaurantId || !planId) {
      // Acknowledged, not retried: a subscription created outside this
      // app has no restaurant to attribute it to, and retrying forever
      // will not give it one.
      reportError(
        new Error(`Subscription ${subscription.id} has no restaurant metadata`),
        {
          scope: "billing.webhook.unattributed",
          extra: { eventType: event.type },
        },
      );
      return NextResponse.json({ received: true, unattributed: true });
    }

    const periodEnd = (
      subscription as unknown as { current_period_end?: number }
    ).current_period_end;

    const { error } = await admin.rpc("record_restaurant_subscription", {
      p_restaurant_id: restaurantId,
      p_plan_id: planId,
      p_stripe_customer_id: String(subscription.customer),
      p_stripe_subscription_id: subscription.id,
      p_status: subscription.status,
      p_current_period_end: periodEnd
        ? new Date(periodEnd * 1000).toISOString()
        : null,
      p_cancel_at_period_end: subscription.cancel_at_period_end ?? false,
    });

    if (error) {
      // Non-2xx so Stripe retries: the alternative is a subscription this
      // database never learns about, which shows a restaurant as unpaid
      // while it is being charged.
      reportError(error, {
        scope: "billing.webhook.record",
        extra: { eventType: event.type, subscriptionId: subscription.id },
      });
      return NextResponse.json(
        { error: "could not record subscription" },
        { status: 500 },
      );
    }

    return NextResponse.json({ received: true, status: subscription.status });
  }

  // Anything else is acknowledged and ignored. Returning non-2xx for an
  // event type this app does not care about would have Stripe retry it
  // forever.
  return NextResponse.json({ received: true, ignored: event.type });
}
