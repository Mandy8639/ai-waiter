"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { getStripe, isStripeConfigured } from "@/lib/payments/stripe";
import { reportError } from "@/lib/observability/report";
import { canSellPlans } from "@/lib/app-shell/core";
import { getAppShell } from "@/lib/app-shell/server";

/**
 * Subscribing a restaurant to a paid plan.
 *
 * The opposite direction to every other charge in this app. Order
 * payments are DIRECT charges on the restaurant's connected account — the
 * diner pays the restaurant — so they pass `stripeAccount`. Here the
 * restaurant pays the platform, so there is deliberately no
 * `stripeAccount` option: the customer and subscription belong to the
 * platform account. Passing one would put the platform's own revenue on
 * the restaurant's books.
 */

export interface SubscribeState {
  error?: string;
}

export async function startSubscriptionCheckout(
  restaurantId: string,
  planSlug: string,
  _prevState: SubscribeState,
  _formData: FormData,
): Promise<SubscribeState> {
  // Owner and manager only. Committing a restaurant to a recurring bill is
  // a commercial decision, not day-to-day floor work — the same boundary
  // the Payments settings page draws.
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  // The store apps never show this button (src/lib/app-shell/core.ts);
  // refuse there too rather than open a Stripe checkout inside an app.
  if (!canSellPlans(await getAppShell())) {
    return { error: "Plans can't be changed in this app." };
  }

  if (!isStripeConfigured()) {
    return { error: "Stripe isn't configured, so plans can't be changed yet." };
  }

  const { data: plan } = await auth.context.supabase
    .from("platform_plans")
    .select("id, slug, name, stripe_price_id, monthly_price_cents")
    .eq("slug", planSlug)
    .maybeSingle();

  if (!plan) return { error: "That plan doesn't exist." };

  if (plan.monthly_price_cents === 0) {
    return {
      error: "That plan is free — there's nothing to subscribe to.",
    };
  }

  // The check the database deliberately does not make: a paid plan has no
  // price id until scripts/setup-stripe-prices.ts has run, and opening a
  // checkout without one fails inside Stripe with a message meant for a
  // developer rather than for the person clicking Subscribe.
  if (!plan.stripe_price_id) {
    reportError(new Error(`Plan ${plan.slug} has no stripe_price_id`), {
      scope: "billing.subscribe.missing_price",
      extra: { restaurantId, planSlug },
    });
    return {
      error: "That plan isn't ready to subscribe to yet. Please try later.",
    };
  }

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const settingsUrl = `${proto}://${host}/dashboard/payments`;

  let checkoutUrl: string;
  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: `${settingsUrl}?subscribed=1`,
      cancel_url: `${settingsUrl}?subscribe_cancelled=1`,
      // Carried back on the webhook event. Without these the handler would
      // have to guess which restaurant a subscription belongs to, and a
      // wrong guess bills the wrong business.
      client_reference_id: restaurantId,
      metadata: { restaurant_id: restaurantId, plan_id: plan.id },
      subscription_data: {
        metadata: { restaurant_id: restaurantId, plan_id: plan.id },
      },
    });

    if (!session.url) {
      return { error: "Stripe didn't return a checkout page. Please retry." };
    }
    checkoutUrl = session.url;
  } catch (stripeError) {
    reportError(stripeError, {
      scope: "billing.subscribe.stripe",
      extra: { restaurantId, planSlug },
    });
    return { error: "Couldn't reach Stripe. Please try again." };
  }

  // Outside the try: redirect() signals by throwing.
  redirect(checkoutUrl);
}
