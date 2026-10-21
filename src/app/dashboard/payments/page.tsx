import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectAccountPanel } from "@/components/payments/connect-account-panel";
import { PaymentSettingsForm } from "@/components/payments/payment-settings-form";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import {
  refreshPaymentAccountStatus,
  startPaymentOnboarding,
  updatePaymentSettings,
} from "@/lib/payments/actions";
import { isStripeConfigured } from "@/lib/payments/stripe";
import { getRestaurantPlan } from "@/lib/billing/plan";
import { formatFeeBps, formatMonthlyPrice } from "@/lib/billing/format";
import {
  getRestaurantSubscription,
  SUBSCRIPTION_STATUS_LABELS,
} from "@/lib/billing/subscription";
import { startSubscriptionCheckout } from "@/lib/billing/subscription-actions";
import { cancelControlsFor } from "@/lib/billing/subscription-cancel-core";
import { PlanCancelControls } from "@/components/billing/plan-cancel-controls";
import { SubscribeButton } from "@/components/payments/subscribe-button";
import { canSellPlans } from "@/lib/app-shell/core";
import { getAppShell } from "@/lib/app-shell/server";
import { getRestaurantBilling } from "@/lib/billing/trial-queries";

export const metadata = {
  title: "Payments — Tableside",
};

/**
 * Payment configuration is owner/manager only — it names an external
 * financial account and decides how money is taken, which is commercial
 * configuration rather than day-to-day floor or kitchen work. RLS on
 * restaurant_payment_accounts enforces the same boundary independently, so
 * a staff viewer would see nothing even if they reached this route.
 */
export default async function PaymentsPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const canManage =
    restaurant.role === "owner" || restaurant.role === "manager";

  if (!canManage) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <Card>
          <CardContent className="py-6">
            <p className="text-muted-foreground text-sm">
              Only an owner or manager can manage payment settings.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const supabase = await createClient();
  // Inside the store apps, plans aren't offered for purchase at all (Apple
  // and Google billing rules, src/lib/app-shell/core.ts). The current plan
  // still shows; changing it happens on the website.
  const plansForSale = canSellPlans(await getAppShell());

  const [{ data: account }, { data: settings }] = await Promise.all([
    supabase
      .from("restaurant_payment_accounts")
      .select("charges_enabled, payouts_enabled, details_submitted")
      .eq("restaurant_id", restaurant.id)
      .maybeSingle(),
    supabase
      .from("restaurant_settings")
      .select(
        "payment_timing, accept_card, accept_cash, accept_card_terminal, tipping_enabled",
      )
      .eq("restaurant_id", restaurant.id)
      .maybeSingle(),
  ]);

  const stripeConfigured = isStripeConfigured();
  const plan = await getRestaurantPlan(restaurant.id);
  const subscription = await getRestaurantSubscription(restaurant.id);
  const billing = await getRestaurantBilling(restaurant.id);
  const exempt = billing?.state === "exempt";
  const inTrial = billing?.state === "trial" && billing.trialEndsAt;

  // Every plan, so a restaurant can see what it could move to. Read
  // through RLS: platform_plans is readable by any signed-in user because
  // a price list is not a secret.
  const { data: allPlans } = await supabase
    .from("platform_plans")
    .select(
      "slug, name, monthly_price_cents, currency, fee_bps, stripe_price_id",
    )
    .order("monthly_price_cents");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <p className="text-muted-foreground text-sm">
          How {restaurant.name} gets paid.
        </p>
      </div>

      {/* Shown before the Stripe panels: what this restaurant pays the
          platform is a different question from how it takes money from
          diners, and burying it under the connect flow would read as an
          afterthought. */}
      {plan && (
        <Card>
          <CardHeader>
            <CardTitle>Your plan</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">
                {plan.name}
                {plan.isDefault && (
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    (default)
                  </span>
                )}
              </span>
              <span className="text-muted-foreground">
                {exempt
                  ? "No monthly fee"
                  : `${formatMonthlyPrice(plan.monthlyPriceCents, plan.currency)} per month`}
              </span>
            </div>
            <p className="text-muted-foreground">
              {/* Stated exactly: a restaurant reading "1% of card payments"
                  should not have to wonder whether its staff's tips are
                  included. They are not. */}
              The platform takes {formatFeeBps(plan.feeBps)} of each card
              payment, excluding tips. Cash payments are not charged.
            </p>
            {exempt && (
              <p className="text-muted-foreground">
                Founding restaurant: Starter stays free for you, with no monthly
                fee.
              </p>
            )}
            {inTrial && billing.trialEndsAt && (
              <p className="font-medium">
                Your first month is free: no fee on card payments until{" "}
                {billing.trialEndsAt.toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  timeZone: restaurant.timezone,
                })}
                . Subscribing now doesn&apos;t cut it short: the first charge
                comes when it ends.
              </p>
            )}
            {subscription ? (
              <p className="text-muted-foreground text-xs">
                Subscription:{" "}
                {SUBSCRIPTION_STATUS_LABELS[subscription.status] ??
                  subscription.status}
                {subscription.currentPeriodEnd &&
                  !subscription.cancelAtPeriodEnd &&
                  ` · renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`}
                {subscription.cancelAtPeriodEnd && " · cancelled"}
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                {exempt ? "No subscription needed." : "No subscription yet."}
              </p>
            )}
            {plansForSale && (
              <PlanCancelControls
                restaurantId={restaurant.id}
                controls={cancelControlsFor(subscription)}
                timeZone={restaurant.timezone}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* The other plans. This page is already owner/manager only, and
          startSubscriptionCheckout() enforces the same boundary regardless
          of what renders here. */}
      {plansForSale && (allPlans ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Change plan</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {(allPlans ?? []).map((p) => {
              const isCurrent = plan?.slug === p.slug;
              const isFree = p.monthly_price_cents === 0;
              return (
                <div
                  key={p.slug}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {formatMonthlyPrice(p.monthly_price_cents, p.currency)}
                      {" · "}
                      {formatFeeBps(p.fee_bps)} of each card payment
                    </span>
                  </div>
                  {exempt && p.slug === "starter" ? (
                    <span className="text-muted-foreground text-xs">
                      Free for you
                    </span>
                  ) : isCurrent && (exempt || subscription) ? (
                    <span className="text-muted-foreground text-xs">
                      Current plan
                    </span>
                  ) : isFree ? (
                    <span className="text-muted-foreground text-xs">
                      Cancel your plan above to return to this
                    </span>
                  ) : !p.stripe_price_id ? (
                    /* Said plainly rather than offering a button that opens
                       a checkout Stripe cannot build. */
                    <span className="text-muted-foreground text-xs">
                      Not available yet
                    </span>
                  ) : (
                    <SubscribeButton
                      action={startSubscriptionCheckout.bind(
                        null,
                        restaurant.id,
                        p.slug,
                      )}
                      label={`Subscribe to ${p.name}`}
                    />
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {!stripeConfigured && (
        <Card>
          <CardContent className="py-4">
            <p className="text-muted-foreground text-sm">
              Payments aren&apos;t configured on this deployment yet. Everything
              else keeps working — orders, the kitchen display and reservations
              are unaffected.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stripe account</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4 text-sm">
            Payments go straight to your own Stripe account — this platform
            never holds your money. Stripe collects your business and bank
            details on its own pages; they never pass through here.
          </p>
          <ConnectAccountPanel
            status={{
              connected: !!account,
              chargesEnabled: account?.charges_enabled ?? false,
              payoutsEnabled: account?.payouts_enabled ?? false,
              detailsSubmitted: account?.details_submitted ?? false,
            }}
            onboardAction={startPaymentOnboarding.bind(null, restaurant.id)}
            refreshAction={refreshPaymentAccountStatus.bind(
              null,
              restaurant.id,
            )}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How you take payment</CardTitle>
        </CardHeader>
        <CardContent>
          <PaymentSettingsForm
            action={updatePaymentSettings.bind(null, restaurant.id)}
            chargesEnabled={account?.charges_enabled ?? false}
            defaultValues={{
              paymentTiming: settings?.payment_timing ?? "at_end",
              acceptCard: settings?.accept_card ?? false,
              acceptCash: settings?.accept_cash ?? false,
              acceptCardTerminal: settings?.accept_card_terminal ?? false,
              tippingEnabled: settings?.tipping_enabled ?? false,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
