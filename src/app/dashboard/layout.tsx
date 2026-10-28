import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { ConciergeBell } from "lucide-react";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
import { KitchenTabs } from "@/components/dashboard/kitchen-tabs";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { isPlatformAdmin } from "@/lib/admin/access";
import { LogoutButton } from "@/components/dashboard/logout-button";
import { NativeAppBridge } from "@/components/kitchen/native-app-bridge";
import { RestaurantSwitcher } from "@/components/dashboard/restaurant-switcher";
import { TwoFactorReminder } from "@/components/dashboard/two-factor-reminder";
import { BillingBanner } from "@/components/dashboard/billing-banner";
import { getSwitchedOffFeatures } from "@/lib/admin/restaurant-switches";
import { switchedOffNotice } from "@/lib/admin/restaurant-switches-core";
import { StaffAssistantProvider } from "@/components/dashboard/staff-assistant";
import { billingNotice } from "@/lib/billing/trial-core";
import { getRestaurantBilling } from "@/lib/billing/trial-queries";
import { getPublicPricing } from "@/lib/billing/public-pricing";
import { starterTermsLine } from "@/lib/admin/plan-admin-core";
import { canSellPlans } from "@/lib/app-shell/core";
import { getAppShell } from "@/lib/app-shell/server";
import { hasVerifiedTwoFactor } from "@/lib/auth/two-factor-core";
import { getDashboardContext } from "@/lib/restaurants/require-current-restaurant";
import { countPendingReservationRequests } from "@/lib/notifications/pending-requests";
import { getExampleDish } from "@/lib/staff-assistant/examples";
import { selectRestaurant } from "@/lib/restaurants/actions";
import { PRIVATE_PAGE_ROBOTS } from "@/lib/seo/metadata";

// Signed in only; never listed. Pages below set just their title, which
// the shallow metadata merge keeps alongside this.
export const metadata = { robots: PRIVATE_PAGE_ROBOTS };

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, state } = await getDashboardContext();
  const showAdmin = isPlatformAdmin(user);

  if (state.status === "none") {
    // A platform admin needn't run a restaurant: their home is the Admin
    // page, which checks two-step verification itself.
    if (showAdmin) redirect("/admin");
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <h1 className="font-heading text-base leading-snug font-medium">
              Create your restaurant
            </h1>
            <CardDescription>
              You don&apos;t have a restaurant yet — let&apos;s set one up.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/onboarding"
              className={buttonVariants({ variant: "default" })}
            >
              Create your restaurant
            </Link>
            <AccountLink />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state.status === "needs-selection") {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <Card className="w-full max-w-md">
          <CardHeader>
            <h1 className="font-heading text-base leading-snug font-medium">
              Choose a restaurant
            </h1>
            <CardDescription>
              You belong to more than one restaurant.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {state.all.map((r) => (
              <form key={r.id} action={selectRestaurant}>
                <input type="hidden" name="restaurantId" value={r.id} />
                <button
                  type="submit"
                  className={
                    buttonVariants({ variant: "outline" }) +
                    " w-full justify-between"
                  }
                >
                  <span>{r.name}</span>
                  <Badge variant="secondary" className="capitalize">
                    {r.role}
                  </Badge>
                </button>
              </form>
            ))}
            <AccountLink />
          </CardContent>
        </Card>
      </div>
    );
  }

  const { restaurant } = state;

  const hasChef = ["owner", "manager", "kitchen"].includes(restaurant.role);
  // Reservations are front-of-house only, and closed in basic mode — a kitchen viewer has no RLS
  // visibility into the table at all, so counting for them would always
  // return 0 and the query would be pure waste.
  const canSeeReservations =
    !restaurant.basicMode &&
    ["owner", "manager", "staff"].includes(restaurant.role);

  // Loaded together, not one after another: every dashboard click re-renders
  // this layout, so each sequential database trip adds to the wait.
  const [
    pricing,
    billing,
    appShell,
    switchedOff,
    exampleDish,
    pendingRequestCount,
  ] = await Promise.all([
    getPublicPricing(),
    getRestaurantBilling(restaurant.id),
    getAppShell(),
    getSwitchedOffFeatures(restaurant.id),
    hasChef ? getExampleDish(restaurant.id) : Promise.resolve(null),
    canSeeReservations
      ? countPendingReservationRequests(restaurant.id)
      : Promise.resolve(undefined),
  ]);

  // The free month / plan notice (20261018120000). Plans can't be offered
  // for purchase inside the store apps, so there it carries no price or link.
  // What Starter costs, as set on /admin (Phase 8).
  const starter = pricing.plans.find((p) => p.slug === "starter");
  const notice = billingNotice(billing, {
    canManage: ["owner", "manager"].includes(restaurant.role),
    canSell: canSellPlans(appShell),
    timeZone: restaurant.timezone,
    ...(starter ? { starterTerms: starterTermsLine(starter) } : {}),
  });

  // Admin Phase 6: what Tableside has switched off for this restaurant.
  const aiOffNotice = switchedOffNotice(switchedOff);

  // The Waiter (staff assistant) floats on every page for the roles that
  // can use it; see src/components/dashboard/staff-assistant.tsx.
  const withChef = (content: React.ReactNode) =>
    hasChef ? (
      <StaffAssistantProvider
        restaurantId={restaurant.id}
        canChangePrices={["owner", "manager"].includes(restaurant.role)}
        exampleDish={exampleDish}
      >
        {content}
      </StaffAssistantProvider>
    ) : (
      content
    );

  // The kitchen account is a screen on the pass: no sidebar, no money, no
  // settings — the board at full width and its two tabs. Which pages it
  // may open at all is decided in src/lib/dashboard/access-core.ts.
  if (restaurant.role === "kitchen") {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/90 supports-backdrop-filter:bg-background/75 sticky top-0 z-20 flex min-h-14 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 backdrop-blur-md sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="type-label hidden truncate font-semibold sm:block">
              {restaurant.name}
            </span>
            <KitchenTabs basicMode={restaurant.basicMode} />
          </div>
          <div className="flex items-center gap-2">
            {state.all.length > 1 && (
              <RestaurantSwitcher
                restaurants={state.all}
                currentId={restaurant.id}
              />
            )}
            <Link
              href="/account"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Account
            </Link>
            <LogoutButton />
          </div>
        </header>
        {/* Bottom padding keeps the last ticket clear of the "Waiter" button. */}
        <main className="w-full flex-1 px-3 pt-4 pb-24 sm:px-4">
          {notice && <BillingBanner notice={notice} />}
          {aiOffNotice && <BillingBanner notice={aiOffNotice} />}
          {withChef(children)}
        </main>
        <NativeAppBridge />
      </div>
    );
  }

  return (
    <div className="flex flex-1">
      <aside className="bg-sidebar sticky top-0 hidden h-dvh w-62 shrink-0 flex-col gap-6 overflow-y-auto border-r px-3 py-5 lg:flex">
        <Link href="/dashboard" className="flex items-center gap-2.5 px-3">
          <span
            aria-hidden="true"
            className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg"
          >
            <ConciergeBell className="size-4" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="type-label text-sidebar-foreground truncate text-[0.875rem] font-semibold">
              {restaurant.name}
            </span>
            <span className="type-caption text-muted-foreground">
              Tableside
            </span>
          </span>
        </Link>
        <DashboardNav
          role={restaurant.role}
          basicMode={restaurant.basicMode}
          restaurantId={canSeeReservations ? restaurant.id : undefined}
          pendingRequestCount={pendingRequestCount}
          showAdmin={showAdmin}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/90 supports-backdrop-filter:bg-background/75 sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b px-4 backdrop-blur-md sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <MobileNav
              role={restaurant.role}
              basicMode={restaurant.basicMode}
              restaurantId={canSeeReservations ? restaurant.id : undefined}
              pendingRequestCount={pendingRequestCount}
              showAdmin={showAdmin}
              restaurantName={restaurant.name}
            />
            <RestaurantSwitcher
              restaurants={state.all}
              currentId={restaurant.id}
            />
          </div>

          <div className="flex items-center gap-3">
            <div className="type-caption text-muted-foreground hidden items-center gap-2 md:flex">
              <span className="text-foreground max-w-56 truncate font-medium">
                {user.email}
              </span>
              <Badge variant="secondary" className="capitalize">
                {restaurant.role}
              </Badge>
            </div>
            <Link
              href="/account"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Account
            </Link>
            <LogoutButton />
          </div>
        </header>

        <main
          className={
            hasChef
              ? "mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-24 sm:px-6 sm:pt-8"
              : "mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8"
          }
        >
          {notice && <BillingBanner notice={notice} />}
          {aiOffNotice && <BillingBanner notice={aiOffNotice} />}
          {["owner", "manager"].includes(restaurant.role) &&
            !hasVerifiedTwoFactor(user.factors) && <TwoFactorReminder />}
          {withChef(children)}
        </main>
        <NativeAppBridge />
      </div>
    </div>
  );
}

/**
 * For the screens that come before a dashboard exists (no restaurant yet,
 * or several to choose from): the Account page, with account deletion, is
 * still reachable from them.
 */
function AccountLink() {
  return (
    <p className="text-muted-foreground mt-4 text-center text-xs">
      <Link href="/account" className="underline underline-offset-4">
        Account settings
      </Link>
    </p>
  );
}
