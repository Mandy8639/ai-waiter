"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observability/report";
import { getStripe, isStripeConfigured } from "./stripe";
import { toMinorUnits } from "./money";
import { parsePaymentError } from "./errors";
import { parseTip } from "./tip";
import { SPLIT_MAX_SHARES, SPLIT_MIN_SHARES } from "./split";

/**
 * Split bill (phase J). The same three rules as every other card path in
 * this app (see tab-checkout.ts):
 *
 *  1. Nobody names a price. The browser sends which parts and a tip; the
 *     database adds up the parts (start_split_payment) and computes the
 *     platform fee.
 *  2. The charge is DIRECT on the restaurant's connected account, so
 *     Checkout shows the payer's own Apple Pay or Google Pay.
 *  3. Only Stripe's signed webhook moves money state. Nothing here marks a
 *     part paid or releases one: abandoning a Checkout asks Stripe to
 *     expire it, and Stripe's own event does the rest.
 */

export interface SplitActionState {
  error?: string;
}

type Untyped = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

async function db(): Promise<Untyped> {
  // database.types.ts predates 20261002090000.
  return (await createClient()) as unknown as Untyped;
}

async function appOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

const splitPath = (slug: string, token: string) =>
  `/r/${encodeURIComponent(slug)}/split/${encodeURIComponent(token)}`;

/** Asks Stripe to expire a Checkout; true if it can no longer be paid. */
async function expireCheckout(
  checkoutSessionId: string,
  stripeAccountId: string,
): Promise<boolean> {
  try {
    await getStripe().checkout.sessions.expire(
      checkoutSessionId,
      {},
      { stripeAccount: stripeAccountId },
    );
    return true;
  } catch (error) {
    // Already expired is fine; already COMPLETE is not — that payment
    // went through, and the webhook will settle it.
    const message = error instanceof Error ? error.message : String(error);
    if (/expired/i.test(message)) return true;
    reportError(error, {
      scope: "payments.split.expire",
      extra: { checkoutSessionId },
    });
    return false;
  }
}

const createSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("equal"),
    shares: z.coerce.number().int().min(SPLIT_MIN_SHARES).max(SPLIT_MAX_SHARES),
  }),
  z.object({ mode: z.literal("by_dish") }),
]);

/** The diner holding the tab freezes it into a split, then goes to its page. */
export async function createSplit(
  restaurantSlug: string,
  _prev: SplitActionState,
  formData: FormData,
): Promise<SplitActionState> {
  if (!isStripeConfigured()) {
    return { error: "Card payments aren't set up for this restaurant yet." };
  }
  const parsed = createSchema.safeParse({
    mode: formData.get("mode"),
    shares: formData.get("shares") ?? undefined,
  });
  if (!parsed.success) {
    return {
      error: `Split the bill between ${SPLIT_MIN_SHARES} and ${SPLIT_MAX_SHARES} people.`,
    };
  }

  const supabase = await db();

  // A Checkout already open on this tab could still be paid, so the split
  // is refused until Stripe says it has expired. Ask Stripe to expire it
  // now; the webhook marks it cancelled, usually within a second or two.
  const { data: pending } = await supabase.rpc("get_my_tab_pending_checkouts");
  const openCheckouts = (pending ?? []) as Array<{
    pending_checkout_session_id: string;
    pending_stripe_account_id: string;
  }>;
  for (const c of openCheckouts) {
    const expired = await expireCheckout(
      c.pending_checkout_session_id,
      c.pending_stripe_account_id,
    );
    if (!expired) {
      return {
        error:
          "A payment for this bill may have just gone through. Reload the page to check.",
      };
    }
  }

  const { data, error } = await supabase.rpc("create_tab_split", {
    p_mode: parsed.data.mode,
    p_share_count: parsed.data.mode === "equal" ? parsed.data.shares : null,
  });

  if (error) {
    if (error.message.includes("PAYMENT_IN_PROGRESS")) {
      return {
        error:
          openCheckouts.length > 0
            ? "Closing the earlier payment first. Try again in a few seconds."
            : parsePaymentError(error.message),
      };
    }
    reportError(error, { scope: "payments.split.create" });
    return { error: parsePaymentError(error.message) };
  }

  const row = (data as Array<{ new_split_token: string }> | null)?.[0];
  if (!row) return { error: "Couldn't split the bill. Please try again." };
  redirect(splitPath(restaurantSlug, row.new_split_token));
}

/** The diner who made the split cancels it, before anyone has started paying. */
export async function cancelSplit(
  restaurantSlug: string,
): Promise<SplitActionState> {
  const supabase = await db();
  const { error } = await supabase.rpc("cancel_tab_split");
  if (error) return { error: parsePaymentError(error.message) };
  redirect(`/r/${encodeURIComponent(restaurantSlug)}/orders`);
}

const tokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Anyone holding the link pays for the parts they chose, on their own phone. */
export async function startSplitCheckout(
  token: string,
  _prev: SplitActionState,
  formData: FormData,
): Promise<SplitActionState> {
  if (!isStripeConfigured()) {
    return { error: "Card payments aren't set up for this restaurant yet." };
  }
  if (!tokenSchema.safeParse(token).success) {
    return { error: "This split link isn't valid any more." };
  }
  const partIds = formData.getAll("part").map(String);
  if (
    partIds.length === 0 ||
    !partIds.every((id) => z.uuid().safeParse(id).success)
  ) {
    return { error: "Choose what you're paying for." };
  }
  const tip = parseTip(formData.get("tip"));
  if (!tip.ok) return { error: tip.message };

  const supabase = await db();
  const { data, error } = await supabase.rpc("start_split_payment", {
    p_token: token,
    p_unit_ids: partIds,
    p_tip_amount: tip.value,
  });
  if (error) {
    return { error: parsePaymentError(error.message) };
  }

  const payment = (
    data as Array<{
      split_payment_id: string;
      split_amount: string;
      split_tip: string;
      split_currency: string;
      split_stripe_account_id: string;
      split_restaurant_slug: string;
      split_part_count: number;
      split_fee_minor_units: number;
    }> | null
  )?.[0];
  if (!payment)
    return { error: "Couldn't start this payment. Please try again." };

  const back = `${await appOrigin()}${splitPath(payment.split_restaurant_slug, token)}`;
  const currency = payment.split_currency.toLowerCase();

  let checkoutUrl: string;
  try {
    const session = await getStripe().checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: toMinorUnits(
                payment.split_amount,
                payment.split_currency,
              ),
              product_data: {
                name:
                  payment.split_part_count === 1
                    ? "Your part of the bill"
                    : `Your part of the bill (${payment.split_part_count} items)`,
              },
            },
          },
          ...(Number(payment.split_tip) > 0
            ? [
                {
                  quantity: 1,
                  price_data: {
                    currency,
                    unit_amount: toMinorUnits(
                      payment.split_tip,
                      payment.split_currency,
                    ),
                    product_data: { name: "Tip" },
                  },
                },
              ]
            : []),
        ],
        ...(payment.split_fee_minor_units > 0
          ? {
              payment_intent_data: {
                application_fee_amount: payment.split_fee_minor_units,
              },
            }
          : {}),
        // The shortest Stripe allows. A payer who wanders off holds their
        // parts for at most this long before the table can pay them.
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
        success_url: `${back}?paid=1`,
        cancel_url: `${back}?left=${payment.split_payment_id}`,
        client_reference_id: payment.split_payment_id,
        metadata: {
          payment_id: payment.split_payment_id,
          split: "1",
        },
      },
      {
        stripeAccount: payment.split_stripe_account_id,
        idempotencyKey: `checkout:${payment.split_payment_id}`,
      },
    );
    if (!session.url) {
      return { error: "Stripe didn't return a payment page. Please retry." };
    }
    checkoutUrl = session.url;

    const { error: attachError } = await supabase.rpc(
      "attach_split_checkout_session",
      {
        p_token: token,
        p_payment_id: payment.split_payment_id,
        p_checkout_session_id: session.id,
      },
    );
    if (attachError) {
      reportError(attachError, {
        scope: "payments.split.attach",
        extra: { paymentId: payment.split_payment_id },
      });
      return { error: "Couldn't start this payment safely. Please try again." };
    }
  } catch (stripeError) {
    reportError(stripeError, {
      scope: "payments.split.stripe",
      extra: { paymentId: payment.split_payment_id },
    });
    return { error: "Couldn't reach Stripe. Please try again." };
  }

  redirect(checkoutUrl);
}

/**
 * A payer came back from Checkout without paying. Ask Stripe to expire that
 * Checkout, so their parts are given back to the table as soon as Stripe's
 * event arrives rather than after the Checkout times out.
 */
export async function leaveSplitCheckout(
  token: string,
  paymentId: string,
): Promise<void> {
  if (
    !isStripeConfigured() ||
    !tokenSchema.safeParse(token).success ||
    !z.uuid().safeParse(paymentId).success
  ) {
    return;
  }
  const supabase = await db();
  const { data } = await supabase.rpc("get_split_payment_checkout", {
    p_token: token,
    p_payment_id: paymentId,
  });
  const row = (
    data as Array<{
      split_checkout_session_id: string;
      split_stripe_account_id: string;
    }> | null
  )?.[0];
  if (!row) return;
  await expireCheckout(
    row.split_checkout_session_id,
    row.split_stripe_account_id,
  );
}
