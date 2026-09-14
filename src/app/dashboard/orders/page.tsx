import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/dashboard/empty-state";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { getOrderHistory } from "@/lib/orders/history";
import {
  HISTORY_RANGES,
  HISTORY_RANGE_LABELS,
  ORDER_STATUSES,
  historyHref,
  parseHistoryFilters,
} from "@/lib/orders/history-filters";
import { STATUS_LABELS, type OrderStatus } from "@/lib/orders/status";
import { formatMoney } from "@/lib/orders/format";
import { formatReservationTime } from "@/lib/reservations/timezone";
import { OrderSearchForm } from "@/components/orders/order-search-form";

export const metadata = {
  title: "Orders — AI Waiter",
};

const STATUS_BADGE: Record<
  OrderStatus,
  "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  confirmed: "secondary",
  preparing: "secondary",
  ready: "secondary",
  served: "outline",
  cancelled: "destructive",
};

/**
 * Order history — every order this restaurant has taken, not just the
 * twelve hours the kitchen board keeps.
 *
 * Deliberately available to every role, unlike Reports: "what did table 6
 * order on Tuesday?" and "the customer says this was never served" are
 * floor questions, and a waiter holding the receipt is usually the person
 * asking. Takings stay owner/manager-only.
 */
export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    status?: string;
    q?: string;
    page?: string;
  }>;
}) {
  const { restaurant } = await requireCurrentRestaurant();
  const filters = parseHistoryFilters(await searchParams);
  const { orders, hasMore } = await getOrderHistory(
    restaurant.id,
    restaurant.timezone,
    filters,
  );

  const isFiltered = Boolean(filters.status || filters.search);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
        <p className="text-muted-foreground text-sm">
          Every order, searchable by number or dish. The kitchen board only
          shows the last twelve hours.
        </p>
      </div>

      <OrderSearchForm filters={filters} />

      <div className="flex flex-wrap items-center gap-2">
        {HISTORY_RANGES.map((option) => (
          <Link
            key={option}
            href={historyHref({ ...filters, range: option, page: 0 })}
            aria-current={option === filters.range ? "page" : undefined}
            className={
              option === filters.range
                ? "bg-secondary rounded-md px-3 py-1.5 text-sm font-medium"
                : "text-muted-foreground hover:bg-muted rounded-md px-3 py-1.5 text-sm"
            }
          >
            {HISTORY_RANGE_LABELS[option]}
          </Link>
        ))}

        <span className="text-muted-foreground mx-1 text-sm">·</span>

        <Link
          href={historyHref({ ...filters, status: null, page: 0 })}
          aria-current={filters.status ? undefined : "page"}
          className={
            filters.status
              ? "text-muted-foreground hover:bg-muted rounded-md px-3 py-1.5 text-sm"
              : "bg-secondary rounded-md px-3 py-1.5 text-sm font-medium"
          }
        >
          All statuses
        </Link>
        {ORDER_STATUSES.map((status) => (
          <Link
            key={status}
            href={historyHref({ ...filters, status, page: 0 })}
            aria-current={status === filters.status ? "page" : undefined}
            className={
              status === filters.status
                ? "bg-secondary rounded-md px-3 py-1.5 text-sm font-medium"
                : "text-muted-foreground hover:bg-muted rounded-md px-3 py-1.5 text-sm"
            }
          >
            {STATUS_LABELS[status]}
          </Link>
        ))}
      </div>

      {orders.length === 0 ? (
        <EmptyState
          title={isFiltered ? "No orders match" : "No orders yet"}
          description={
            isFiltered
              ? "Try a wider date range, a different status, or clear the search."
              : "Orders appear here as soon as diners start placing them."
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {orders.map((order) => (
            <Card key={order.id}>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">#{order.orderNumber}</span>
                    <Badge
                      variant={
                        STATUS_BADGE[order.status as OrderStatus] ?? "outline"
                      }
                    >
                      {STATUS_LABELS[order.status as OrderStatus] ??
                        order.status}
                    </Badge>
                    <span className="text-muted-foreground text-sm">
                      {order.tableLabel}
                    </span>
                  </div>
                  <span className="font-medium">
                    {formatMoney(order.total, order.currency)}
                  </span>
                </div>
                <p className="text-muted-foreground text-sm">
                  {order.itemSummary || "No items"}
                </p>
                <p className="text-muted-foreground text-xs">
                  {formatReservationTime(order.createdAt, restaurant.timezone)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {(filters.page > 0 || hasMore) && (
        <div className="flex items-center justify-between">
          {filters.page > 0 ? (
            <Link
              href={historyHref({ ...filters, page: filters.page - 1 })}
              className="text-muted-foreground hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
            >
              ← Newer
            </Link>
          ) : (
            <span />
          )}
          {hasMore && (
            <Link
              href={historyHref({ ...filters, page: filters.page + 1 })}
              className="text-muted-foreground hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
            >
              Older →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
