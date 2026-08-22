import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getPublicRestaurantBySlug } from "@/lib/customer/restaurant";
import { getActiveCustomerSession } from "@/lib/customer/session";
import { getOrdersForSession } from "@/lib/orders/queries";
import { formatMoney } from "@/lib/orders/format";
import { CUSTOMER_STATUS_LABELS as STATUS_LABELS } from "@/lib/orders/status";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  return {
    title: restaurant ? `Your orders — ${restaurant.name}` : "Your orders",
  };
}

/**
 * Session-scoped order history — every order this exact customer session
 * has placed, nothing more. Not account-based (spec section 21: no
 * signup/login exists for customers) — a new QR scan starts a new session
 * with no history of its own, by design, the same way the cart itself is
 * scoped to a session rather than a person.
 */
export default async function OrderHistoryPage({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);

  if (!restaurant) {
    notFound();
  }

  const session = await getActiveCustomerSession();

  if (!session || session.restaurantId !== restaurant.id) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
        <Badge variant="outline">No active session</Badge>
        <p className="text-muted-foreground max-w-xs text-sm">
          Scan the QR code at your table to see your orders here.
        </p>
        <Link
          href={`/r/${restaurantSlug}`}
          className={buttonVariants({ variant: "outline" })}
        >
          Back to {restaurant.name}
        </Link>
      </div>
    );
  }

  const orders = await getOrdersForSession(session.id);

  return (
    <div className="flex flex-1 flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">Your orders</h1>

      {orders.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
          <p className="text-muted-foreground text-sm">
            You haven&apos;t placed an order yet.
          </p>
          <Link
            href={`/r/${restaurantSlug}/menu`}
            className={buttonVariants({ variant: "default" })}
          >
            Browse the menu
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {orders.map((order) => (
            <Link
              key={order.id}
              href={`/r/${restaurantSlug}/order/${order.id}`}
              className="flex items-center justify-between rounded-md border px-3 py-3 text-sm"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">Order #{order.orderNumber}</span>
                <span className="text-muted-foreground text-xs">
                  {new Date(order.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <span className="font-medium">
                  {formatMoney(order.total, order.currency)}
                </span>
                <Badge variant="secondary" className="text-xs">
                  {STATUS_LABELS[order.status as keyof typeof STATUS_LABELS] ??
                    order.status}
                </Badge>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
