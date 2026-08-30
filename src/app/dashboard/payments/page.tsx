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

export const metadata = {
  title: "Payments — AI Waiter",
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

  const [{ data: account }, { data: settings }] = await Promise.all([
    supabase
      .from("restaurant_payment_accounts")
      .select("charges_enabled, payouts_enabled, details_submitted")
      .eq("restaurant_id", restaurant.id)
      .maybeSingle(),
    supabase
      .from("restaurant_settings")
      .select("payment_timing, accept_card, accept_cash, tipping_enabled")
      .eq("restaurant_id", restaurant.id)
      .maybeSingle(),
  ]);

  const stripeConfigured = isStripeConfigured();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <p className="text-muted-foreground text-sm">
          How {restaurant.name} gets paid.
        </p>
      </div>

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
              tippingEnabled: settings?.tipping_enabled ?? false,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
