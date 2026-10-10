import Link from "next/link";
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
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { LogoutButton } from "@/components/dashboard/logout-button";
import { RestaurantSwitcher } from "@/components/dashboard/restaurant-switcher";
import { getDashboardContext } from "@/lib/restaurants/require-current-restaurant";
import { countPendingReservationRequests } from "@/lib/notifications/pending-requests";
import { selectRestaurant } from "@/lib/restaurants/actions";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, state } = await getDashboardContext();

  if (state.status === "none") {
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

  // Reservations are front-of-house only — a kitchen viewer has no RLS
  // visibility into the table at all, so counting for them would always
  // return 0 and the query would be pure waste.
  const canSeeReservations = ["owner", "manager", "staff"].includes(
    restaurant.role,
  );
  const pendingRequestCount = canSeeReservations
    ? await countPendingReservationRequests(restaurant.id)
    : undefined;

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
          restaurantId={canSeeReservations ? restaurant.id : undefined}
          pendingRequestCount={pendingRequestCount}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="bg-background/90 supports-backdrop-filter:bg-background/75 sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b px-4 backdrop-blur-md sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <MobileNav
              role={restaurant.role}
              restaurantId={canSeeReservations ? restaurant.id : undefined}
              pendingRequestCount={pendingRequestCount}
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

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
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
