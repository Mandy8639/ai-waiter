import Link from "next/link";
import { ApprovalPinForm } from "@/components/settings/approval-pin-form";
import { Download } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { SECURITY_PATH } from "@/lib/legal/security";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RestaurantProfileForm } from "@/components/settings/restaurant-profile-form";
import { OperationalSettingsForm } from "@/components/settings/operational-settings-form";
import { AiPersonaForm } from "@/components/settings/ai-persona-form";
import { EmailPreferencesForm } from "@/components/settings/email-preferences-form";
import { toAiPersona } from "@/lib/ai/persona";
import { HeroVideoManager } from "@/components/dashboard/hero-video-manager";
import { loadOwnerHeroVideoState } from "@/lib/hero-video/owner-state";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import {
  updateAiPersona,
  updateEmailPreferences,
  updateOperationalSettings,
  updatePickupSettings,
  updateRestaurantProfile,
} from "@/lib/settings/actions";
import { PickupSettingsForm } from "@/components/settings/pickup-settings-form";

export const metadata = {
  title: "Settings — Tableside",
};

export default async function SettingsPage() {
  const { user, restaurant } = await requireCurrentRestaurant();
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

  // A separate read because database.types.ts predates 20260927090000 and
  // would type these two columns as a query error. toAiPersona() turns
  // whatever comes back into a valid persona, defaulting on anything odd.
  const { data: personaRow } = await supabase
    .from("restaurant_settings")
    .select("ai_tone, ai_instructions" as "restaurant_id")
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();
  const persona = toAiPersona({
    tone: (personaRow as { ai_tone?: unknown } | null)?.ai_tone,
    instructions: (personaRow as { ai_instructions?: unknown } | null)
      ?.ai_instructions,
  });

  // Pickup slot rules (20261022090000, newer than database.types.ts).
  const { data: pickupRow } = await supabase
    .from("restaurant_settings")
    .select(
      "pickup_slot_minutes, pickup_slot_capacity, pickup_lead_minutes" as "restaurant_id",
    )
    .eq("restaurant_id", restaurant.id)
    .maybeSingle();
  const pickup = pickupRow as {
    pickup_slot_minutes?: number;
    pickup_slot_capacity?: number;
    pickup_lead_minutes?: number;
  } | null;

  // Your own row: email preferences are per person (20260929090000, also
  // newer than database.types.ts). A missing value reads as the default, on.
  const { data: myMembership } = await supabase
    .from("restaurant_users")
    .select("email_daily_summary, email_payment_alerts" as "role")
    .eq("restaurant_id", restaurant.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const emailPrefs = myMembership as {
    email_daily_summary?: boolean;
    email_payment_alerts?: boolean;
  } | null;

  const heroVideoState = await loadOwnerHeroVideoState(
    supabase,
    restaurant.id,
    env.NEXT_PUBLIC_SUPABASE_URL,
  );

  const canManage =
    restaurant.role === "owner" || restaurant.role === "manager";
  // 20261117090000 is newer than database.types.ts.
  const { data: hasPin } = canManage
    ? await (
        supabase.rpc as unknown as (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown }>
      )("my_approval_pin_set", { p_restaurant_id: restaurant.id })
    : { data: false };

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pickup</CardTitle>
          <CardDescription>
            For a pickup counter, where diners order ahead and choose a time.
            Add one under Tables → New table → Pickup counter.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PickupSettingsForm
            action={updatePickupSettings.bind(null, restaurant.id)}
            defaultValues={{
              slotMinutes: pickup?.pickup_slot_minutes ?? 15,
              slotCapacity: pickup?.pickup_slot_capacity ?? 6,
              leadMinutes: pickup?.pickup_lead_minutes ?? 20,
            }}
            disabled={!canManage}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI waiter voice</CardTitle>
          <CardDescription>
            How the AI waiter sounds to your diners. This changes its style,
            never its facts — answers about your menu always come from your
            menu.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AiPersonaForm
            action={updateAiPersona.bind(null, restaurant.id)}
            defaultValues={persona}
            disabled={!canManage}
          />
        </CardContent>
      </Card>

      {restaurant.role === "owner" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Emails</CardTitle>
            <CardDescription>
              What Tableside emails you about this restaurant. These are your
              own settings — other owners choose their own.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EmailPreferencesForm
              action={updateEmailPreferences.bind(null, restaurant.id)}
              defaultValues={{
                dailySummary: emailPrefs?.email_daily_summary !== false,
                paymentAlerts: emailPrefs?.email_payment_alerts !== false,
              }}
              email={user.email ?? null}
            />
          </CardContent>
        </Card>
      )}

      {/* In basic mode (20261125090000) the point of sale is for importing
          the menu only; the manager PIN is about taking money, so it's
          hidden. Printers stay: kitchen tickets are part of basic. */}
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Point of sale</CardTitle>
            <CardDescription>
              {restaurant.basicMode
                ? "Use Square? Connect it to import your menu, and import again whenever it changes."
                : "Connect your Square account to use the same menu in Tableside."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/dashboard/settings/pos"
              className={buttonVariants({ variant: "outline" })}
            >
              Open point of sale settings
            </Link>
          </CardContent>
        </Card>
      )}

      {canManage && !restaurant.basicMode && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Manager PIN</CardTitle>
            <CardDescription>
              Waiters can void, comp and discount on Settle up once a manager
              types their PIN on the waiter&apos;s tablet. Each change records
              who approved it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ApprovalPinForm
              restaurantId={restaurant.id}
              hasPin={hasPin === true}
            />
          </CardContent>
        </Card>
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Printers</CardTitle>
            <CardDescription>
              Star network printers for kitchen tickets, bills and receipts, and
              the cash drawer. They print on their own, with no tablet or app in
              between.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/dashboard/settings/printers"
              className={buttonVariants({ variant: "outline" })}
            >
              Open printer settings
            </Link>
          </CardContent>
        </Card>
      )}

      {restaurant.role === "owner" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your data</CardTitle>
            <CardDescription>
              Everything Tableside holds for this restaurant, in one file you
              can keep or move elsewhere: menu, tables, every order and payment,
              reservations, feedback, staff and the change history. It&apos;s
              yours, and you can download it any time.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            {/* A plain link, not next/link: it's a file download, and a
                prefetch would build the whole export in the background. */}
            <a
              href="/dashboard/settings/export"
              download
              className={buttonVariants({ variant: "outline" })}
            >
              <Download className="size-4" aria-hidden="true" />
              Download all data (JSON)
            </a>
            <a
              href={SECURITY_PATH}
              className="text-muted-foreground text-sm underline underline-offset-4"
            >
              How we keep it safe
            </a>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
