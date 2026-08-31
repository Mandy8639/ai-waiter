"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { PostgrestError } from "@supabase/supabase-js";
import { authorizeRestaurantAction } from "@/lib/restaurants/authorize";
import { getStripe, isStripeConfigured } from "./stripe";
import { parsePaymentError } from "./errors";
import { paymentSettingsSchema } from "./schema";
import { toBoolean } from "@/lib/forms/form-data";

export interface PaymentActionState {
  error?: string;
}

function toPaymentError(error: PostgrestError): PaymentActionState {
  return { error: parsePaymentError(error.message) };
}

/**
 * Absolute URLs for Stripe's hosted onboarding to come back to. Derived
 * from the incoming request rather than a configured base URL, so this
 * works unchanged on localhost, on a Vercel preview, and in production
 * without another environment variable to keep in sync.
 */
async function appOrigin(): Promise<string> {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const proto =
    headerList.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Creates the restaurant's Stripe connected account if it doesn't have
 * one, then sends the caller to Stripe's hosted onboarding.
 *
 * Uses the Accounts v2 API. Stripe now refuses v1 account creation for new
 * Connect integrations outright ("Stripe no longer recommends Accounts v1
 * ... Create connected accounts with POST /v2/core/accounts instead"), so
 * this is not a preference — v1 returns a 400.
 *
 * The configuration is chosen to match the liability model this feature
 * was scoped around, and Stripe validates the combination server-side:
 *
 *   dashboard: "full"        the restaurant gets a real Stripe account of
 *                            their own rather than a platform-managed one
 *   fees_collector: stripe   the restaurant pays its own Stripe fees
 *   losses_collector: stripe the restaurant, not this platform, carries
 *                            chargebacks and losses
 *
 * That combination makes the restaurant the merchant of record and keeps
 * this platform out of the money-transmitter position. Stripe rejects the
 * alternatives that would push fees or losses onto the platform while
 * still claiming this shape, so the model is enforced at their end too.
 *
 * Stripe collects and verifies identity and bank details on its own hosted
 * pages; none of it passes through this application.
 */
export async function startPaymentOnboarding(
  restaurantId: string,
  _prevState: PaymentActionState,
  _formData: FormData,
): Promise<PaymentActionState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  if (!isStripeConfigured()) {
    return {
      error:
        "Payments aren't configured on this deployment yet — STRIPE_SECRET_KEY is not set.",
    };
  }

  const stripe = getStripe();
  const origin = await appOrigin();
  const returnUrl = `${origin}/dashboard/payments`;

  const { data: existing } = await auth.context.supabase
    .from("restaurant_payment_accounts")
    .select("stripe_account_id")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  let stripeAccountId = existing?.stripe_account_id;

  if (!stripeAccountId) {
    const { data: restaurant } = await auth.context.supabase
      .from("restaurants")
      .select("name, country, currency")
      .eq("id", restaurantId)
      .maybeSingle();

    const account = await stripe.v2.core.accounts.create({
      display_name: restaurant?.name ?? undefined,
      dashboard: "full",
      // Required before a merchant configuration can be applied. Falls back
      // to US only because restaurants.country is nullable; a restaurant
      // that has set its country gets that instead.
      identity: { country: restaurant?.country ?? "US" },
      defaults: {
        currency: (restaurant?.currency ?? "USD").toLowerCase(),
        responsibilities: {
          fees_collector: "stripe",
          losses_collector: "stripe",
        },
      },
      configuration: {
        merchant: { capabilities: { card_payments: { requested: true } } },
      },
      metadata: { restaurant_id: restaurantId },
    });
    stripeAccountId = account.id;

    // Persisted through the RPC, not a direct insert: the table has no
    // write policy, and the function re-checks the caller's role itself.
    const { error } = await auth.context.supabase.rpc(
      "link_restaurant_payment_account",
      { p_restaurant_id: restaurantId, p_stripe_account_id: stripeAccountId },
    );
    if (error) return toPaymentError(error);
  }

  const link = await stripe.v2.core.accountLinks.create({
    account: stripeAccountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        configurations: ["merchant"],
        // Stripe sends the user here if the link expired before they
        // finished; pointing it back at our own page means they simply get
        // a fresh link rather than a dead end.
        refresh_url: `${origin}/dashboard/payments?refresh=1`,
        return_url: returnUrl,
      },
    },
  });

  // Outside any try/catch on purpose: redirect() signals by throwing, and
  // swallowing that would turn a successful redirect into a silent no-op.
  redirect(link.url);
}

/**
 * Pulls the account's current capabilities straight from Stripe and caches
 * them. The account.updated webhook normally keeps these fresh, but a
 * developer running locally has no webhook endpoint Stripe can reach, and
 * webhook delivery can lag — so the dashboard offers this explicitly
 * rather than showing a stale "not ready yet" forever.
 */
export async function refreshPaymentAccountStatus(
  restaurantId: string,
  _prevState: PaymentActionState,
  _formData: FormData,
): Promise<PaymentActionState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  if (!isStripeConfigured()) {
    return { error: "Payments aren't configured on this deployment yet." };
  }

  const { data: account } = await auth.context.supabase
    .from("restaurant_payment_accounts")
    .select("stripe_account_id")
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (!account) {
    return { error: "Connect a Stripe account first." };
  }

  // Accounts v2 reports capabilities as a status enum
  // ('active' | 'pending' | 'restricted' | 'unsupported') rather than the
  // v1 booleans, and outstanding onboarding items as requirement entries.
  // The mapping to this app's three flags happens here, at the Stripe
  // boundary, so the database keeps a stable domain shape rather than
  // mirroring whatever Stripe's API looks like this year.
  const stripeAccount = await getStripe().v2.core.accounts.retrieve(
    account.stripe_account_id,
    {
      include: [
        "configuration.merchant",
        "configuration.recipient",
        "requirements",
      ],
    },
  );

  const merchant = stripeAccount.configuration?.merchant;
  const chargesEnabled =
    merchant?.capabilities?.card_payments?.status === "active";
  // Only the merchant configuration is applied in phase 1, so recipient is
  // normally absent; treated as "not enabled" rather than assumed.
  const payoutsEnabled =
    stripeAccount.configuration?.recipient?.capabilities?.stripe_balance
      ?.payouts?.status === "active";
  const detailsSubmitted =
    (stripeAccount.requirements?.entries ?? []).length === 0;

  const { error } = await auth.context.supabase.rpc(
    "sync_restaurant_payment_account_status",
    {
      p_restaurant_id: restaurantId,
      p_charges_enabled: chargesEnabled,
      p_payouts_enabled: payoutsEnabled,
      p_details_submitted: detailsSubmitted,
    },
  );
  if (error) return toPaymentError(error);

  revalidatePath("/dashboard/payments");
  return {};
}

/**
 * Per-restaurant payment configuration. Goes through the ordinary
 * RLS-respecting client rather than an RPC, because restaurant_settings
 * already carries an owner/manager UPDATE policy — matching
 * src/lib/settings/actions.ts.
 */
export async function updatePaymentSettings(
  restaurantId: string,
  _prevState: PaymentActionState,
  formData: FormData,
): Promise<PaymentActionState> {
  const auth = await authorizeRestaurantAction(restaurantId, [
    "owner",
    "manager",
  ]);
  if (!auth.ok) return { error: auth.error };

  const parsed = paymentSettingsSchema.safeParse({
    paymentTiming: formData.get("paymentTiming"),
    acceptCard: toBoolean(formData.get("acceptCard")),
    acceptCash: toBoolean(formData.get("acceptCash")),
    tippingEnabled: toBoolean(formData.get("tippingEnabled")),
  });
  if (!parsed.success) {
    return { error: "Those payment settings aren't valid." };
  }

  const { error } = await auth.context.supabase
    .from("restaurant_settings")
    .update({
      payment_timing: parsed.data.paymentTiming,
      accept_card: parsed.data.acceptCard,
      accept_cash: parsed.data.acceptCash,
      tipping_enabled: parsed.data.tippingEnabled,
    })
    .eq("restaurant_id", restaurantId);

  if (error) return toPaymentError(error);

  revalidatePath("/dashboard/payments");
  return {};
}
