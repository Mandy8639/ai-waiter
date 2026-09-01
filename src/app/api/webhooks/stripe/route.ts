import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe, isStripeConfigured } from "@/lib/payments/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Stripe's webhook endpoint.
 *
 * THIS IS THE ONLY PLACE IN THE APPLICATION THAT USES THE RLS-BYPASSING
 * ADMIN CLIENT IN A REQUEST PATH, and it must stay that way. The reason is
 * structural rather than convenient: a webhook arrives from Stripe, not
 * from a signed-in person, so there is no `auth.uid()` for RLS to reason
 * about and no SECURITY DEFINER function that could authorise it. The
 * request signature is the entire authentication story — which is why the
 * signature check below happens before anything else touches the database,
 * and why this handler does exactly two things and nothing else: record
 * that an event was seen, and mirror Stripe's capability flags.
 *
 * See docs/security.md#payments. If a future change needs the admin client
 * somewhere else, that is a design discussion, not a detail.
 *
 * Idempotency is not optional. Stripe retries on any non-2xx and can
 * deliver the same event more than once even on success, so every event id
 * is claimed in `stripe_webhook_events` first; the primary key makes a
 * duplicate a no-op rather than a second effect. Phase 2 depends on this
 * being right, because a replayed `payment_intent.succeeded` must never
 * settle an order twice.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isStripeConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
    // Not configured is not an error worth retrying — tell Stripe plainly.
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  // The raw body, unparsed: signature verification is computed over the
  // exact bytes Stripe sent, so parsing before verifying would break it.
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = await getStripe().webhooks.constructEventAsync(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    // Deliberately opaque: a caller who cannot produce a valid signature
    // learns nothing about why theirs was rejected.
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Claim the event id. A duplicate delivery loses this race against its
  // own earlier self and is acknowledged without being processed again.
  const { error: claimError } = await admin
    .from("stripe_webhook_events")
    .insert({ stripe_event_id: event.id, event_type: event.type });

  if (claimError) {
    if (claimError.code === "23505") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    // Something else went wrong recording it — return non-2xx so Stripe
    // retries rather than dropping the event on the floor.
    //
    // TEMPORARY DIAGNOSTIC (remove once production settlement is verified):
    // the code/message are echoed so a failing delivery says WHY in Stripe's
    // own delivery log. Only a request carrying a valid Stripe signature can
    // reach this line — verification happens above — so this leaks nothing
    // to an unauthenticated caller. Revert to the opaque message after.
    return NextResponse.json(
      {
        error: "could not record event",
        code: claimError.code,
        detail: claimError.message,
        hint: claimError.hint ?? null,
      },
      { status: 500 },
    );
  }

  // Phase 2: a Checkout session that actually completed. THIS IS THE ONLY
  // PATH IN THE APPLICATION THAT MARKS AN ORDER PAID.
  //
  // The diner's browser also comes back from Stripe, to `?paid=1`, but
  // that is merely a URL — it can be typed, shared or replayed by anyone,
  // so it only ever refreshes the page. A signed event is the only thing
  // this system treats as evidence that money moved.
  //
  // `mark_order_payment_succeeded` is idempotent and returns false for a
  // session this database has never seen, rather than raising: an unknown
  // session must not produce a 500, because Stripe would then retry it
  // forever. A genuinely unknown session is far more likely to be another
  // integration on the same account than a lost payment.
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    // `complete` alone does not mean funds are captured — an async method
    // can complete the session while still unpaid. Only `paid` settles.
    if (session.payment_status === "paid") {
      const { error } = await admin.rpc("mark_order_payment_succeeded", {
        p_checkout_session_id: session.id,
        p_payment_intent_id:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null),
      });

      if (error) {
        return NextResponse.json(
          { error: "could not apply event" },
          { status: 500 },
        );
      }
    }
  }

  // An abandoned or failed checkout. Recorded so "has this order been
  // paid?" has an answer other than "still pending, forever", and so the
  // diner is offered a retry rather than a stuck screen. The function
  // only ever touches a payment that is still pending, so one of these
  // arriving late can never undo a payment that already succeeded.
  if (
    event.type === "checkout.session.expired" ||
    event.type === "checkout.session.async_payment_failed"
  ) {
    const session = event.data.object as Stripe.Checkout.Session;
    const { error } = await admin.rpc("mark_order_payment_failed", {
      p_checkout_session_id: session.id,
      p_status:
        event.type === "checkout.session.expired" ? "cancelled" : "failed",
    });

    if (error) {
      return NextResponse.json(
        { error: "could not apply event" },
        { status: 500 },
      );
    }
  }

  // `account.updated` is an Accounts v1 event. Connected accounts are now
  // created through Accounts v2 (v1 creation is rejected outright — see
  // src/lib/payments/actions.ts), and v2 accounts report changes through
  // v2 event destinations rather than this endpoint. So in practice this
  // branch does not fire today, and the "Refresh status" button on the
  // payments page — not this webhook — is what keeps the flags current.
  //
  // It is kept rather than deleted because it is correct for any v1
  // account and costs nothing, and because the surrounding endpoint
  // (signature verification and the replay-proof event ledger) is what
  // phase 2's charge events will arrive through. Do not describe account
  // status as automatically synced until a v2 event destination exists.
  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    const { error } = await admin
      .from("restaurant_payment_accounts")
      .update({
        charges_enabled: account.charges_enabled ?? false,
        payouts_enabled: account.payouts_enabled ?? false,
        details_submitted: account.details_submitted ?? false,
      })
      .eq("stripe_account_id", account.id);

    if (error) {
      return NextResponse.json(
        { error: "could not apply event" },
        { status: 500 },
      );
    }
  }

  await admin
    .from("stripe_webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("stripe_event_id", event.id);

  return NextResponse.json({ received: true });
}
