import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getPublicRestaurantBySlug } from "@/lib/customer/restaurant";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/orders/format";
import { getReceipt } from "@/lib/payments/receipt";
import { paymentMethodLabel } from "@/lib/payments/method";
import {
  isReceiptable,
  type ReceiptState,
} from "@/lib/payments/receipt-status";
import { formatReservationTime } from "@/lib/reservations/timezone";
import { ShareReceipt } from "@/components/customer/share-receipt";
import { PRIVATE_PAGE_ROBOTS } from "@/lib/seo/metadata";

export const metadata = {
  title: "Receipt",
  robots: PRIVATE_PAGE_ROBOTS,
};

/**
 * Wording is chosen so the document cannot be read as claiming more than
 * happened. "Paid" only ever appears over money that was taken and kept.
 */
const STATE_LABELS: Record<ReceiptState, string> = {
  paid: "Paid",
  partly_refunded: "Partly refunded",
  fully_refunded: "Refunded",
  reversed: "Reversed",
  unpaid: "Not paid",
};

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ restaurantSlug: string; paymentId: string }>;
}) {
  const { restaurantSlug, paymentId } = await params;

  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  if (!restaurant) notFound();

  // Deliberately NOT gated on getActiveCustomerSession(): a session lasts
  // four hours, and a receipt that expires with the meal is not a receipt.
  // RLS is the gate — see the header of src/lib/payments/receipt.ts.
  const receipt = await getReceipt(paymentId);

  // Null covers three different situations — no such payment, someone
  // else's payment, and a signed-out visitor — and says the same thing for
  // all of them, so the page never confirms that an id exists to someone
  // who cannot see it.
  if (!receipt) notFound();

  if (!isReceiptable(receipt.state)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
        <Badge variant="outline">Not paid</Badge>
        <p className="text-muted-foreground max-w-xs text-sm">
          This payment was never completed, so there is no receipt for it.
        </p>
        <Link
          href={`/r/${restaurantSlug}/orders`}
          className={buttonVariants({ variant: "outline" })}
        >
          Your orders
        </Link>
      </div>
    );
  }

  const supabase = await createClient();
  const { data: row } = await supabase
    .from("restaurants")
    .select("timezone")
    .eq("id", restaurant.id)
    .maybeSingle();
  const timezone = row?.timezone ?? "UTC";

  const money = (value: number) => formatMoney(value, receipt.currency);
  const when = receipt.paidAt
    ? formatReservationTime(receipt.paidAt, timezone)
    : null;

  return (
    <div className="flex flex-1 flex-col gap-5">
      <div className="flex flex-col items-center gap-1 py-4 text-center">
        <Badge variant={receipt.state === "paid" ? "secondary" : "outline"}>
          {STATE_LABELS[receipt.state]}
        </Badge>
        <h1 className="text-2xl font-semibold tracking-tight">
          {money(receipt.net)}
        </h1>
        <p className="text-muted-foreground text-sm">
          {restaurant.name}
          {when ? ` · ${when}` : ""}
        </p>
        {restaurant.address && (
          <p className="text-muted-foreground text-xs">
            {[restaurant.address, restaurant.city, restaurant.state]
              .filter(Boolean)
              .join(", ")}
          </p>
        )}
      </div>

      {/* Said plainly rather than left to be inferred from a zero total: a
          reversal means the money was never taken, which is a different
          statement from a refund and the reader should not have to work
          out which one they are holding. */}
      {receipt.state === "reversed" && (
        <div className="rounded-md border p-3 text-sm">
          <p className="font-medium">This payment was reversed.</p>
          <p className="text-muted-foreground">
            It was recorded in error and cancelled
            {receipt.reversedAt
              ? ` on ${formatReservationTime(receipt.reversedAt, timezone)}`
              : ""}
            . No money was taken.
          </p>
        </div>
      )}

      {receipt.orders.map((order) => (
        <div key={order.id} className="flex flex-col gap-2">
          {receipt.orders.length > 1 && (
            <p className="text-sm font-medium">Order #{order.orderNumber}</p>
          )}
          <div className="flex flex-col gap-2">
            {order.lines.map((line) => (
              <div key={line.id} className="flex justify-between gap-3 text-sm">
                <div className="flex flex-col gap-0.5">
                  <span>
                    {line.quantity} × {line.itemName}
                  </span>
                  {line.modifiers.length > 0 && (
                    <span className="text-muted-foreground text-xs">
                      {line.modifiers.join(", ")}
                    </span>
                  )}
                </div>
                <span className="shrink-0">{money(line.lineTotal)}</span>
              </div>
            ))}
          </div>
          {(order.tax > 0 || order.serviceCharge > 0) && (
            <div className="text-muted-foreground flex flex-col gap-0.5 text-xs">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{money(order.subtotal)}</span>
              </div>
              {order.tax > 0 && (
                <div className="flex justify-between">
                  <span>Tax</span>
                  <span>{money(order.tax)}</span>
                </div>
              )}
              {order.serviceCharge > 0 && (
                <div className="flex justify-between">
                  <span>Service charge</span>
                  <span>{money(order.serviceCharge)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      <div className="flex flex-col gap-1 border-t pt-4 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">
            {receipt.orders.length > 1
              ? `${receipt.orders.length} orders`
              : "Order"}
          </span>
          <span>{money(receipt.amount)}</span>
        </div>
        {receipt.tip > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tip</span>
            <span>{money(receipt.tip)}</span>
          </div>
        )}
        <div className="flex justify-between font-medium">
          <span>Charged</span>
          <span>{money(receipt.total)}</span>
        </div>
        {receipt.refunded > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Refunded</span>
            <span>−{money(receipt.refunded)}</span>
          </div>
        )}
        {/* Both figures are shown whenever they differ. A single number
            would leave the reader guessing whether refunds had already
            been taken off, which is the ambiguity that makes a receipt
            untrustworthy. */}
        <div className="flex justify-between text-base font-semibold">
          <span>{receipt.refunded > 0 ? "You paid" : "Total"}</span>
          <span>{money(receipt.net)}</span>
        </div>
        <p className="text-muted-foreground pt-1 text-xs">
          Paid by {paymentMethodLabel(receipt.method).toLowerCase()}
        </p>
      </div>

      <p className="text-muted-foreground text-center text-xs">
        Receipt {receipt.paymentId}
      </p>

      <div className="flex flex-col gap-2">
        {/*
          Offered, never required. A diner who wants nothing simply walks
          away from this page, and "Your orders" below is an ordinary link
          rather than a dismissal they have to find — there is no step to
          skip because sharing was never in the way.
        */}
        <ShareReceipt
          restaurantName={restaurant.name}
          total={money(receipt.net)}
        />
        <Link
          href={`/r/${restaurantSlug}/orders`}
          className={buttonVariants({ variant: "outline" })}
        >
          Your orders
        </Link>
      </div>
    </div>
  );
}
