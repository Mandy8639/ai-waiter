import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  ChefHat,
  CircleCheck,
  Circle,
  ImageUp,
  Plus,
  QrCode,
  ShieldAlert,
  UtensilsCrossed,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { getDashboardOverview } from "@/lib/dashboard/overview";
import { ServiceRequestQueue } from "@/components/dashboard/service-request-queue";
import { loadOpenRequests } from "@/lib/table-requests/actions";
import { formatPrice } from "@/lib/format/price";
import { STATUS_LABELS, type OrderStatus } from "@/lib/orders/status";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "Overview — AI Waiter",
};

const STATUS_TONE: Record<OrderStatus, string> = {
  pending: "bg-warning/15 text-warning-foreground",
  confirmed: "bg-info/12 text-info",
  preparing: "bg-info/12 text-info",
  ready: "bg-success/12 text-success",
  served: "bg-secondary text-muted-foreground",
  cancelled: "bg-secondary text-muted-foreground line-through",
};

function StatCard({
  label,
  value,
  detail,
  href,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <p className="type-label text-muted-foreground">{label}</p>
      <p className="type-price text-foreground mt-2 text-3xl tracking-tight">
        {value}
      </p>
      {detail && (
        <p className="type-caption text-muted-foreground mt-1">{detail}</p>
      )}
    </>
  );
  const className =
    "bg-card shadow-card flex flex-col rounded-xl border p-5 transition-colors";
  return href ? (
    <Link
      href={href}
      className={cn(
        className,
        "hover:border-foreground/15 focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none",
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

export default async function DashboardOverviewPage() {
  const { restaurant } = await requireCurrentRestaurant();
  const [overview, openRequests] = await Promise.all([
    getDashboardOverview(restaurant.id, restaurant.role),
    loadOpenRequests(restaurant.id),
  ]);

  const todayLabel = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: overview.timeZone,
  }).format(new Date());
  const timeFormat = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: overview.timeZone,
  });

  const serviceState = !overview.isActive
    ? {
        label: "Paused — hidden from diners",
        tone: "bg-destructive/10 text-destructive",
      }
    : !overview.acceptingOrders
      ? {
          label: "Not taking orders",
          tone: "bg-warning/15 text-warning-foreground",
        }
      : { label: "Open for orders", tone: "bg-success/12 text-success" };

  // Only things someone should act on, each linking to where they act.
  const attention = [
    overview.awaitingAcceptance > 0 && {
      icon: ChefHat,
      text: `${overview.awaitingAcceptance} ${overview.awaitingAcceptance === 1 ? "order is" : "orders are"} waiting to be accepted`,
      href: "/dashboard/kitchen",
      action: "Open kitchen",
    },
    overview.pendingBookings !== null &&
      overview.pendingBookings > 0 && {
        icon: CalendarClock,
        text: `${overview.pendingBookings} booking ${overview.pendingBookings === 1 ? "request needs" : "requests need"} an answer`,
        href: "/dashboard/reservations",
        action: "Review",
      },
    overview.allergenSuggestionsToConfirm > 0 && {
      icon: ShieldAlert,
      text: `${overview.allergenSuggestionsToConfirm} suggested ${overview.allergenSuggestionsToConfirm === 1 ? "allergen isn't" : "allergens aren't"} confirmed yet — diners don't see them until you confirm`,
      href: "/dashboard/menu/allergen-review",
      action: "Confirm",
    },
  ].filter((item): item is Exclude<typeof item, false> => Boolean(item));

  const setup = [
    {
      done: overview.menuItems > 0,
      label: "Add your dishes",
      href: "/dashboard/menu/import",
    },
    {
      done: overview.tables > 0,
      label: "Create tables and print their QR codes",
      href: "/dashboard/tables",
    },
    ...(overview.canTakeCardPayments === null
      ? []
      : [
          {
            done: overview.canTakeCardPayments,
            label: "Connect Stripe to take card payments",
            href: "/dashboard/payments",
          },
        ]),
    {
      done: overview.aiWaiterEnabled,
      label: "Turn on the AI waiter",
      href: "/dashboard/settings",
    },
    {
      done: overview.acceptingOrders,
      label: "Start accepting orders",
      href: "/dashboard/settings",
    },
  ];
  const setupDone = setup.filter((step) => step.done).length;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="type-overline text-muted-foreground">{todayLabel}</p>
          <h1 className="type-title">{restaurant.name}</h1>
        </div>
        <span
          className={cn(
            "type-label inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1.5",
            serviceState.tone,
          )}
        >
          <span
            className="size-1.5 rounded-full bg-current"
            aria-hidden="true"
          />
          {serviceState.label}
        </span>
      </div>

      {/* Above "needs attention" on purpose: everything in that list is a
          task, while this is a person sitting at a table waiting. */}
      <section
        aria-labelledby="service-requests-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="service-requests-heading" className="type-label">
          Tables waiting
        </h2>
        <ServiceRequestQueue
          restaurantId={restaurant.id}
          initial={openRequests}
        />
      </section>

      {attention.length > 0 && (
        <section
          aria-labelledby="attention-heading"
          className="flex flex-col gap-2"
        >
          <h2 id="attention-heading" className="sr-only">
            Needs attention
          </h2>
          {attention.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="border-warning/40 bg-warning/10 hover:bg-warning/15 focus-visible:ring-ring/50 flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors focus-visible:ring-3 focus-visible:outline-none"
              >
                <Icon
                  className="text-warning size-5 shrink-0"
                  aria-hidden="true"
                />
                <span className="type-body-sm flex-1">{item.text}</span>
                <span className="type-label inline-flex shrink-0 items-center gap-1">
                  {item.action}
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </span>
              </Link>
            );
          })}
        </section>
      )}

      <section aria-labelledby="today-heading" className="flex flex-col gap-3">
        <h2 id="today-heading" className="type-heading">
          Today
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Orders"
            value={overview.ordersToday}
            detail={
              overview.cancelledToday > 0
                ? `plus ${overview.cancelledToday} cancelled`
                : "since midnight"
            }
            href="/dashboard/orders"
          />
          <StatCard
            label="In the kitchen now"
            value={overview.inKitchenNow}
            detail={
              overview.awaitingAcceptance > 0
                ? `${overview.awaitingAcceptance} not accepted yet`
                : "new, confirmed, preparing or ready"
            }
            href="/dashboard/kitchen"
          />
          {overview.takingsToday && (
            <StatCard
              label="Taken today"
              value={formatPrice(
                Number(overview.takingsToday.net),
                overview.currency,
              )}
              detail={`${overview.takingsToday.paymentCount} ${overview.takingsToday.paymentCount === 1 ? "payment" : "payments"}, after refunds`}
              href="/dashboard/reports"
            />
          )}
          <StatCard
            label="On the menu"
            value={overview.menuItems - overview.unavailableItems}
            detail={
              overview.unavailableItems > 0
                ? `${overview.unavailableItems} marked unavailable · ${overview.categories} categories`
                : `${overview.categories} categories`
            }
            href="/dashboard/menu"
          />
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <section
          aria-labelledby="recent-heading"
          className="flex flex-col gap-3"
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="recent-heading" className="type-heading">
              Today&apos;s orders
            </h2>
            <Link
              href="/dashboard/orders"
              className="type-label text-primary hover:underline"
            >
              All orders
            </Link>
          </div>
          {overview.recentOrders.length === 0 ? (
            <div className="bg-card shadow-card flex flex-col items-center gap-1 rounded-xl border px-6 py-10 text-center">
              <p className="type-dish">No orders yet today</p>
              <p className="type-body-sm text-muted-foreground max-w-sm">
                Orders placed from table QR codes — by tapping or through the AI
                waiter — appear here and on the kitchen board.
              </p>
            </div>
          ) : (
            <ul className="bg-card shadow-card divide-y rounded-xl border">
              {overview.recentOrders.map((order) => (
                <li
                  key={order.id}
                  className="flex items-center gap-4 px-4 py-3"
                >
                  <span className="type-price text-muted-foreground w-10 shrink-0">
                    #{order.orderNumber}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <p className="type-body-sm truncate font-medium">
                      {order.itemSummary || "—"}
                    </p>
                    <p className="type-caption text-muted-foreground">
                      {order.tableLabel} ·{" "}
                      {timeFormat.format(new Date(order.createdAt))}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "type-caption hidden shrink-0 rounded-full px-2 py-0.5 font-medium sm:inline",
                      STATUS_TONE[order.status as OrderStatus] ??
                        "bg-secondary text-muted-foreground",
                    )}
                  >
                    {STATUS_LABELS[order.status as OrderStatus] ?? order.status}
                  </span>
                  <span className="type-price shrink-0">
                    {formatPrice(order.total, order.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-col gap-8">
          {setupDone < setup.length && (
            <section
              aria-labelledby="setup-heading"
              className="flex flex-col gap-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="setup-heading" className="type-heading">
                  Getting ready
                </h2>
                <Badge variant="secondary">
                  {setupDone} of {setup.length}
                </Badge>
              </div>
              <ol className="bg-card shadow-card flex flex-col rounded-xl border p-2">
                {setup.map((step) => (
                  <li key={step.label}>
                    <Link
                      href={step.href}
                      className="hover:bg-secondary/60 focus-visible:ring-ring/50 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors focus-visible:ring-3 focus-visible:outline-none"
                    >
                      {step.done ? (
                        <CircleCheck
                          className="text-success size-5 shrink-0"
                          aria-hidden="true"
                        />
                      ) : (
                        <Circle
                          className="text-muted-foreground/60 size-5 shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      <span
                        className={cn(
                          "type-body-sm flex-1",
                          step.done && "text-muted-foreground line-through",
                        )}
                      >
                        {step.label}
                      </span>
                      <span className="sr-only">
                        {step.done ? "(done)" : "(to do)"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section
            aria-labelledby="actions-heading"
            className="flex flex-col gap-3"
          >
            <h2 id="actions-heading" className="type-heading">
              Quick actions
            </h2>
            <div className="grid grid-cols-2 gap-2">
              {[
                {
                  href: "/dashboard/kitchen",
                  label: "Kitchen board",
                  icon: ChefHat,
                },
                {
                  href: "/dashboard/menu/new",
                  label: "Add a dish",
                  icon: Plus,
                },
                {
                  href: "/dashboard/menu/import",
                  label: "Import a menu",
                  icon: ImageUp,
                },
                {
                  href: "/dashboard/tables",
                  label: "Table QR codes",
                  icon: QrCode,
                },
              ].map((action) => {
                const Icon = action.icon;
                return (
                  <Link
                    key={action.href}
                    href={action.href}
                    className="bg-card shadow-card hover:border-foreground/15 focus-visible:ring-ring/50 type-label flex flex-col gap-2 rounded-xl border p-3.5 transition-colors focus-visible:ring-3 focus-visible:outline-none"
                  >
                    <Icon className="text-primary size-5" aria-hidden="true" />
                    {action.label}
                  </Link>
                );
              })}
            </div>
            <Link
              href="/dashboard/menu"
              className="type-label text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5"
            >
              <UtensilsCrossed className="size-3.5" aria-hidden="true" />
              Manage the full menu
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
