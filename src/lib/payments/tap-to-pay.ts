"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report";
import { getStripe, isStripeConfigured } from "./stripe";
import { toMinorUnits } from "./money";
import { parsePaymentError } from "./errors";
import { parseTip } from "./tip";
import {
  tapOutcome,
  terminalLocationAddress,
  isTestModeKey,
  type TapOutcome,
} from "./tap-to-pay-core";

/**
 * Tap to Pay in the staff app (Stripe Terminal on the phone itself).
 *
 * The phone never decides anything about money. The server opens the
 * payment from the orders' own totals (start_tap_to_pay_payment), creates
 * the PaymentIntent DIRECTLY on the restaurant's Stripe account with the
 * platform fee — exactly like an online card payment (checkout.ts) — and
 * after the tap reads the PaymentIntent back from Stripe before anything
 * is marked paid. The webhook does the same as a backstop.
 */

/** Who may take payment: front of house, as on Settle up. Not the kitchen screen. */
const TAKERS = ["owner", "manager", "staff"] as const;

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

async function ready(restaurantId: string) {
  if (!isStripeConfigured()) {
    return { ok: false as const, error: "Card payments aren't set up yet." };
  }
  const auth = await authorizeRestaurantAction(restaurantId, [...TAKERS]);
  if (!auth.ok) return { ok: false as const, error: auth.error };
  const rpc = auth.context.supabase.rpc.bind(
    auth.context.supabase,
  ) as unknown as Rpc;
  return { ok: true as const, auth, rpc };
}

/**
 * A connection token for the phone's Stripe Terminal SDK, scoped to the
 * restaurant's Stripe account and its Terminal Location (created on first
 * use from the restaurant's address).
 */
export async function getTapToPayConnection(
  restaurantId: string,
): Promise<
  | { ok: true; secret: string; locationId: string; simulated: boolean }
  | { ok: false; error: string }
> {
  const r = await ready(restaurantId);
  if (!r.ok) return r;

  const admin = createAdminClient();
  const [{ data: account }, { data: restaurant }] = await Promise.all([
    admin
      .from("restaurant_payment_accounts")
      .select("stripe_account_id, charges_enabled")
      .eq("restaurant_id", restaurantId)
      .maybeSingle(),
    admin
      .from("restaurants")
      .select("name, address, city, state, postal_code, country")
      .eq("id", restaurantId)
      .maybeSingle(),
  ]);
  if (!account?.stripe_account_id || !account.charges_enabled || !restaurant) {
    return {
      ok: false,
      error: "This restaurant's Stripe account isn't ready to take cards yet.",
    };
  }
  const stripeAccount = account.stripe_account_id;

  // database.types.ts predates terminal_location_id (20261105090000).
  const { data: loc } = await (
    admin.from.bind(admin) as unknown as (t: string) => {
      select: (c: string) => {
        eq: (
          c: string,
          v: string,
        ) => {
          maybeSingle: () => Promise<{
            data: { terminal_location_id: string | null } | null;
          }>;
        };
      };
    }
  )("restaurant_payment_accounts")
    .select("terminal_location_id")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  let locationId = loc?.terminal_location_id ?? null;

  try {
    const stripe = getStripe();
    if (!locationId) {
      const address = terminalLocationAddress(restaurant);
      if (!address.ok) {
        return {
          ok: false,
          error: `Stripe needs the restaurant's full address for Tap to Pay. Add the ${address.missing.join(", ")} in Settings → Restaurant profile.`,
        };
      }
      const created = await stripe.terminal.locations.create(
        { display_name: restaurant.name, address: address.address },
        { stripeAccount, idempotencyKey: `terminal-location:${restaurantId}` },
      );
      locationId = created.id;
      const { error } = await (admin.rpc.bind(admin) as unknown as Rpc)(
        "set_terminal_location",
        {
          p_restaurant_id: restaurantId,
          p_location_id: locationId,
        },
      );
      if (error) throw new Error(error.message);
    }
    const token = await stripe.terminal.connectionTokens.create(
      { location: locationId },
      { stripeAccount },
    );
    return {
      ok: true,
      secret: token.secret,
      locationId,
      simulated: isTestModeKey(process.env.STRIPE_SECRET_KEY),
    };
  } catch (error) {
    reportError(error, {
      scope: "tap_to_pay.connection",
      extra: { restaurantId },
    });
    return {
      ok: false,
      error: "Couldn't connect to Stripe. Please try again.",
    };
  }
}

/**
 * Opens a Tap to Pay payment for a table's orders and creates its
 * PaymentIntent. Returns the client secret the phone collects against.
 */
export async function startTapToPay(
  restaurantId: string,
  orderIds: string[],
  tip: string,
): Promise<
  | { ok: true; paymentId: string; clientSecret: string }
  | { ok: false; error: string }
> {
  const ids = z.array(z.uuid()).min(1).max(50).safeParse(orderIds);
  if (!ids.success) return { ok: false, error: "No orders to pay for." };
  const parsedTip = parseTip(tip);
  if (!parsedTip.ok) return { ok: false, error: parsedTip.message };

  const r = await ready(restaurantId);
  if (!r.ok) return r;

  const { data, error } = await r.rpc("start_tap_to_pay_payment", {
    p_order_ids: ids.data,
    p_tip_amount: parsedTip.value,
  });
  if (error) return { ok: false, error: parsePaymentError(error.message) };
  const payment = (
    data as
      | {
          payment_id: string;
          amount: string;
          total_amount: string;
          currency: string;
          stripe_account_id: string;
        }[]
      | null
  )?.[0];
  if (!payment) return { ok: false, error: "Couldn't start the payment." };

  // The platform's cut, on the food only, never the tip (as checkout.ts).
  let fee = 0;
  try {
    const { data: feeData, error: feeError } = await r.rpc(
      "platform_fee_for_payment",
      {
        p_payment_id: payment.payment_id,
        p_amount_minor_units: toMinorUnits(payment.amount, payment.currency),
      },
    );
    if (feeError) throw new Error(feeError.message);
    fee = Number(feeData ?? 0);
  } catch (feeLookupError) {
    reportError(feeLookupError, {
      scope: "platform.fee.tap_to_pay",
      extra: { paymentId: payment.payment_id },
    });
  }

  try {
    const intent = await getStripe().paymentIntents.create(
      {
        amount: toMinorUnits(payment.total_amount, payment.currency),
        currency: payment.currency.toLowerCase(),
        payment_method_types: ["card_present"],
        capture_method: "automatic",
        ...(fee > 0 ? { application_fee_amount: fee } : {}),
        description: "Table payment (Tap to Pay)",
        metadata: { payment_id: payment.payment_id, source: "tap_to_pay" },
      },
      {
        stripeAccount: payment.stripe_account_id,
        idempotencyKey: `tap-to-pay:${payment.payment_id}`,
      },
    );
    const { error: attachError } = await r.rpc("attach_tap_to_pay_intent", {
      p_payment_id: payment.payment_id,
      p_payment_intent_id: intent.id,
    });
    if (attachError) throw new Error(attachError.message);
    if (!intent.client_secret) throw new Error("no client secret");
    return {
      ok: true,
      paymentId: payment.payment_id,
      clientSecret: intent.client_secret,
    };
  } catch (stripeError) {
    reportError(stripeError, {
      scope: "tap_to_pay.start",
      extra: { paymentId: payment.payment_id },
    });
    await r.rpc("cancel_tap_to_pay_payment", {
      p_payment_id: payment.payment_id,
    });
    return { ok: false, error: "Couldn't start the payment with Stripe." };
  }
}

/** Where a payment and its intent are, read through the member's own RLS view. */
async function loadTap(
  r: Extract<Awaited<ReturnType<typeof ready>>, { ok: true }>,
  restaurantId: string,
  paymentId: string,
) {
  const { data } = await (
    r.auth.context.supabase.from.bind(r.auth.context.supabase) as unknown as (
      t: string,
    ) => {
      select: (c: string) => {
        eq: (
          c: string,
          v: string,
        ) => {
          eq: (
            c: string,
            v: string,
          ) => {
            maybeSingle: () => Promise<{
              data: {
                status: string;
                card_present: boolean;
                stripe_payment_intent_id: string | null;
              } | null;
            }>;
          };
        };
      };
    }
  )("order_payments")
    .select("status, card_present, stripe_payment_intent_id")
    .eq("id", paymentId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  if (!data?.card_present) return null;
  const { data: account } = await createAdminClient()
    .from("restaurant_payment_accounts")
    .select("stripe_account_id")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();
  return account?.stripe_account_id
    ? { ...data, stripeAccount: account.stripe_account_id }
    : null;
}

/**
 * After the phone says the tap went through: read the PaymentIntent from
 * Stripe and, only if Stripe says succeeded, mark it paid.
 */
export async function finishTapToPay(
  restaurantId: string,
  paymentId: string,
): Promise<{ ok: true; outcome: TapOutcome } | { ok: false; error: string }> {
  const r = await ready(restaurantId);
  if (!r.ok) return r;
  const tap = await loadTap(r, restaurantId, paymentId);
  if (!tap?.stripe_payment_intent_id) {
    return { ok: false, error: "That payment wasn't found." };
  }
  if (tap.status === "succeeded") return { ok: true, outcome: "paid" };

  try {
    const intent = await getStripe().paymentIntents.retrieve(
      tap.stripe_payment_intent_id,
      {},
      { stripeAccount: tap.stripeAccount },
    );
    const outcome = tapOutcome(intent.status);
    if (outcome === "paid") {
      const { error } = await (
        createAdminClient().rpc.bind(createAdminClient()) as unknown as Rpc
      )("mark_tap_to_pay_succeeded", { p_payment_intent_id: intent.id });
      if (error) {
        // Money was taken but the table was already settled another way
        // (e.g. the diner paid online at the same moment).
        reportError(new Error(error.message), {
          scope: "tap_to_pay.settle",
          extra: { paymentId },
        });
        return {
          ok: false,
          error:
            "The card was charged, but this table was already paid another way. Refund this payment from Reports.",
        };
      }
      revalidatePath("/dashboard/checkout");
    }
    return { ok: true, outcome };
  } catch (error) {
    reportError(error, { scope: "tap_to_pay.finish", extra: { paymentId } });
    return { ok: false, error: "Couldn't check the payment with Stripe." };
  }
}

/** Stops a tap that hasn't gone through: the intent is cancelled at Stripe too. */
export async function cancelTapToPay(
  restaurantId: string,
  paymentId: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await ready(restaurantId);
  if (!r.ok) return r;
  const tap = await loadTap(r, restaurantId, paymentId);
  if (!tap) return { ok: false, error: "That payment wasn't found." };
  if (tap.status === "succeeded") {
    return {
      ok: false,
      error: "It already went through. Refund it from Reports.",
    };
  }
  if (tap.stripe_payment_intent_id) {
    try {
      await getStripe().paymentIntents.cancel(
        tap.stripe_payment_intent_id,
        {},
        { stripeAccount: tap.stripeAccount },
      );
    } catch {
      // Already succeeded or cancelled at Stripe: finishTapToPay settles
      // the first, and the second is what we want anyway.
    }
  }
  const { error } = await r.rpc("cancel_tap_to_pay_payment", {
    p_payment_id: paymentId,
  });
  return error
    ? { ok: false, error: parsePaymentError(error.message) }
    : { ok: true };
}
