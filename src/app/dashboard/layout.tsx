import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { DashboardNav } from "@/components/dashboard/dashboard-nav";
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
    <div className="flex flex-1 flex-col md:flex-row">
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r px-4 py-6 md:flex">
        <Link
          href="/dashboard"
          className="text-lg font-semibold tracking-tight"
        >
          AI Waiter
        </Link>
        <DashboardNav
          role={restaurant.role}
          restaurantId={canSeeReservations ? restaurant.id : undefined}
          pendingRequestCount={pendingRequestCount}
        />
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <details className="relative md:hidden">
              <summary className="border-input cursor-pointer list-none rounded-md border px-3 py-1.5 text-sm font-medium">
                Menu
              </summary>
              <div className="bg-popover absolute z-10 mt-2 w-56 rounded-md border p-2 shadow-md">
                <DashboardNav
                  role={restaurant.role}
                  restaurantId={canSeeReservations ? restaurant.id : undefined}
                  pendingRequestCount={pendingRequestCount}
                />
              </div>
            </details>
            <RestaurantSwitcher
              restaurants={state.all}
              currentId={restaurant.id}
            />
          </div>

          <div className="flex items-center gap-3">
            <div className="text-muted-foreground hidden text-sm sm:block">
              <span className="text-foreground font-medium">{user.email}</span>
              <Badge variant="secondary" className="ml-2 capitalize">
                {restaurant.role}
              </Badge>
            </div>
            <LogoutButton />
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
