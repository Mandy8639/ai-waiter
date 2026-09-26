import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PayTabPanel } from "@/components/customer/pay-tab-panel";
import { getPublicRestaurantBySlug } from "@/lib/customer/restaurant";
import { getActiveCustomerSession } from "@/lib/customer/session";
import { getOrdersForSession } from "@/lib/orders/queries";
import { formatMoney } from "@/lib/orders/format";
import { CUSTOMER_STATUS_LABELS as STATUS_LABELS } from "@/lib/orders/status";
import { getTabPaymentState } from "@/lib/payments/tab-queries";
import { startTabCheckout } from "@/lib/payments/tab-checkout";
import { SplitBillStart } from "@/components/customer/split-bill-start";
import { createSplit } from "@/lib/payments/split-actions";
import { createClient } from "@/lib/supabase/server";

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
 *
 * It is also where a tab gets settled, because this is the only screen
 * that shows the whole session at once. Paying per order still works from
 * each order's own page; this is the shortcut for the common case of
 * ordering three times across an evening and paying once at the end.
 */
export default async function OrderHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ restaurantSlug: string }>;
  searchParams: Promise<{ paid?: string; cancelled?: string }>;
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

  const supabase = (await createClient()) as unknown as {
    rpc: (fn: string) => Promise<{ data: unknown }>;
  };
  const [orders, tab, returned, openSplitResult] = await Promise.all([
    getOrdersForSession(session.id),
    getTabPaymentState(session.id, restaurant.id),
    searchParams,
    // Phase J; database.types.ts predates it.
    supabase.rpc("get_my_open_split"),
  ]);
  const openSplitToken =
    (openSplitResult.data as Array<{ open_split_token: string }> | null)?.[0]
      ?.open_split_token ?? null;

  const paidOrderIds = new Set(
    tab.orders.filter((o) => o.paid).map((o) => o.id),
  );

  // A tab is worth offering only for two or more unpaid orders — one is
  // what the order's own page already does, and a second button for the
  // same charge would just be a way to get it wrong.
  // While the bill is being split, the split is the way to pay it: the
  // tab's total would include orders the split has taken over.
  const canPayTab =
    !openSplitToken &&
    tab.canTakeCard &&
    tab.unpaidCount >= 2 &&
    !tab.mixedCurrency;
  // One big order is the classic bill to split, so one unpaid order is
  // enough to offer it.
  const canSplit =
    !openSplitToken &&
    tab.canTakeCard &&
    tab.unpaidCount >= 1 &&
    !tab.mixedCurrency;

  return (
    <div className="flex flex-1 flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">Your orders</h1>

      {/* Coming back from Stripe proves only that the diner came back:
          settlement is the webhook's job, and it may not have arrived yet.
          So this says a payment was made without claiming it has cleared,
          and the list below shows the truth as the database knows it. */}
      {returned.paid && (
        <Alert>
          <AlertDescription>
            Thanks — your payment went through. It can take a moment to show
            against each order.
          </AlertDescription>
        </Alert>
      )}
      {returned.cancelled && (
        <Alert variant="destructive">
          <AlertDescription>
            That payment was cancelled. Nothing has been charged.
          </AlertDescription>
        </Alert>
      )}

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
                <div className="flex items-center gap-1">
                  {paidOrderIds.has(order.id) && (
                    <Badge variant="outline" className="text-xs">
                      Paid
                    </Badge>
                  )}
                  <Badge variant="secondary" className="text-xs">
                    {STATUS_LABELS[
                      order.status as keyof typeof STATUS_LABELS
                    ] ?? order.status}
                  </Badge>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {canPayTab && (
        <PayTabPanel
          unpaidCount={tab.unpaidCount}
          unpaidTotal={tab.unpaidTotal}
          currency={tab.currency}
          tippingEnabled={tab.tippingEnabled}
          pendingTip={tab.pendingTip}
          payAction={startTabCheckout.bind(null, restaurantSlug)}
        />
      )}

      {openSplitToken && (
        <section className="flex flex-col gap-2 rounded-lg border p-4">
          <h2 className="font-medium">This bill is being split</h2>
          <p className="text-muted-foreground text-sm">
            Everyone pays their part from the split page.
          </p>
          <Link
            href={`/r/${restaurantSlug}/split/${openSplitToken}`}
            className={buttonVariants({ variant: "default" })}
          >
            Open the split
          </Link>
        </section>
      )}

      {canSplit && (
        <SplitBillStart createAction={createSplit.bind(null, restaurantSlug)} />
      )}

      {/* Orders freeze their own currency, so a restaurant that changed
          currency mid-session leaves a tab no single charge can cover.
          start_tab_payment() refuses it; saying so beats a button that
          fails. */}
      {tab.canTakeCard && tab.unpaidCount >= 2 && tab.mixedCurrency && (
        <p className="text-muted-foreground text-sm">
          These orders are in different currencies, so they have to be paid one
          at a time.
        </p>
      )}
    </div>
  );
}
