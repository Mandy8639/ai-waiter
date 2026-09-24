import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RestaurantProfileForm } from "@/components/settings/restaurant-profile-form";
import { OperationalSettingsForm } from "@/components/settings/operational-settings-form";
import { HeroVideoManager } from "@/components/dashboard/hero-video-manager";
import { loadOwnerHeroVideoState } from "@/lib/hero-video/owner-state";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import {
  updateOperationalSettings,
  updateRestaurantProfile,
} from "@/lib/settings/actions";

export const metadata = {
  title: "Settings — Tableside",
};

export default async function SettingsPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const supabase = await createClient();

  const [{ data: profile }, { data: settings }] = await Promise.all([
    supabase
      .from("restaurants")
      .select(
        "name, description, phone, address, city, state, postal_code, timezone, currency, tax_rate, service_charge",
      )
      .eq("id", restaurant.id)
      .single(),
    supabase
      .from("restaurant_settings")
      .select(
        "accepting_orders, allow_customer_notes, allow_ai_recommendations, allow_upselling, max_order_items",
      )
      .eq("restaurant_id", restaurant.id)
      .single(),
  ]);

  const heroVideoState = await loadOwnerHeroVideoState(
    supabase,
    restaurant.id,
    env.NEXT_PUBLIC_SUPABASE_URL,
  );

  const canManage =
    restaurant.role === "owner" || restaurant.role === "manager";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">
          {canManage
            ? "Manage your restaurant's profile and operations."
            : "View-only — owners and managers can edit."}
        </p>
      </div>

      {profile && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Restaurant profile</CardTitle>
            <CardDescription>
              Basic information about your restaurant.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RestaurantProfileForm
              action={updateRestaurantProfile.bind(null, restaurant.id)}
              defaultValues={{
                name: profile.name,
                description: profile.description,
                phone: profile.phone,
                address: profile.address,
                city: profile.city,
                state: profile.state,
                postalCode: profile.postal_code,
                timezone: profile.timezone,
                currency: profile.currency,
                taxRate: Number(profile.tax_rate),
                serviceCharge: Number(profile.service_charge),
              }}
              disabled={!canManage}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Menu video</CardTitle>
          <CardDescription>
            A short video at the top of your menu. Diners see a still image
            first and only download the video if they tap it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HeroVideoManager
            restaurantId={restaurant.id}
            initial={heroVideoState}
            disabled={!canManage}
          />
        </CardContent>
      </Card>

      {settings && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Operational settings</CardTitle>
            <CardDescription>
              How diners order from their table, and what the AI waiter is
              allowed to do.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OperationalSettingsForm
              action={updateOperationalSettings.bind(null, restaurant.id)}
              defaultValues={{
                acceptingOrders: settings.accepting_orders,
                allowCustomerNotes: settings.allow_customer_notes,
                allowAiRecommendations: settings.allow_ai_recommendations,
                allowUpselling: settings.allow_upselling,
                maxOrderItems: settings.max_order_items,
              }}
              disabled={!canManage}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
