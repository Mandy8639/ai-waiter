import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { OrderStatusSync } from "@/components/customer/order-status-sync";
import { getOrderById } from "@/lib/orders/queries";
import { formatMoney } from "@/lib/orders/format";
import { CUSTOMER_STATUS_LABELS as STATUS_LABELS } from "@/lib/orders/status";
import { getOrderPaymentState } from "@/lib/payments/queries";
import { startOrderCheckout } from "@/lib/payments/checkout";
import { PayOrderPanel } from "@/components/customer/pay-order-panel";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const order = await getOrderById(orderId);
  return { title: order ? `Order #${order.orderNumber}` : "Order" };
}

export default async function OrderConfirmationPage({
  params,
}: {
  params: Promise<{ restaurantSlug: string; orderId: string }>;
}) {
  const { restaurantSlug, orderId } = await params;

  // getOrderById is RLS-scoped (orders_select_own_or_staff) — a customer
  // who isn't this order's own session, or staff at a different
  // restaurant, gets `null` here, indistinguishable from "doesn't exist"
  // (see docs/security.md#customer-order-access).
  const order = await getOrderById(orderId);
  if (!order) {
    notFound();
  }

  if (order.restaurantSlug && order.restaurantSlug !== restaurantSlug) {
    redirect(`/r/${order.restaurantSlug}/order/${orderId}`);
  }

  const money = (amount: number) => formatMoney(amount, order.currency);

  // Payment is offered only when a card could actually be charged: the
  // restaurant has switched card payments on AND its Stripe account can
  // take them. A cancelled order is never payable.
  const payment = await getOrderPaymentState(order.id, order.restaurantId);
  const payable =
    payment.canTakeCard && !payment.paid && order.status !== "cancelled";

  const payForThisOrder = startOrderCheckout.bind(
    null,
    order.id,
    restaurantSlug,
  );

  return (
    <div className="flex flex-1 flex-col gap-5">
      <OrderStatusSync orderId={order.id} />

      <div className="flex flex-col items-center gap-1 py-4 text-center">
        {/*
          role="status" (an implicit polite live region) so the kitchen
          moving this order from "received" to "preparing" to "ready" is
          ANNOUNCED, not just repainted.

          OrderStatusSync renders nothing and drives updates with
          router.refresh(), so the badge text is replaced by a server
          re-render. Visually that's obvious; to a screen reader it was
          silent — on the one screen a diner sits and watches. SC 4.1.3.

          The label is duplicated into a visually-hidden sentence because a
          live region announces its whole contents: "Preparing" alone is
          ambiguous out of context, where "Order status: Preparing" is not.
        */}
        <div role="status">
          <span className="sr-only">
            Order status:{" "}
            {STATUS_LABELS[order.status as keyof typeof STATUS_LABELS] ??
              order.status}
          </span>
          <Badge
            aria-hidden="true"
            variant={order.status === "cancelled" ? "destructive" : "secondary"}
          >
            {STATUS_LABELS[order.status as keyof typeof STATUS_LABELS] ??
              order.status}
          </Badge>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Order #{order.orderNumber}
        </h1>
        <p className="text-muted-foreground text-sm">
          {order.restaurantName} · {order.tableLabel}
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {order.items.map((item) => (
          <div
            key={item.id}
            className="flex flex-col gap-1 border-b pb-3 last:border-b-0"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium">
                  {item.quantity} × {item.itemName}
                </p>
                {item.modifiers.length > 0 && (
                  <p className="text-muted-foreground text-xs">
                    {item.modifiers.map((m) => m.optionName).join(", ")}
                  </p>
                )}
              </div>
              <p className="shrink-0 text-sm font-medium">
                {money(item.lineTotal)}
              </p>
            </div>
          </div>
        ))}
      </div>

      {order.customerNote && (
        <div className="bg-muted rounded-md p-3 text-sm">
          <p className="text-muted-foreground text-xs font-medium">Your note</p>
          <p>{order.customerNote}</p>
        </div>
      )}

      <div className="flex flex-col gap-1 border-t pt-4 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span>{money(order.subtotal)}</span>
        </div>
        {order.tax > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Tax</span>
            <span>{money(order.tax)}</span>
          </div>
        )}
        {order.serviceCharge > 0 && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Service charge</span>
            <span>{money(order.serviceCharge)}</span>
          </div>
        )}
        <div className="flex justify-between text-base font-semibold">
          <span>Total</span>
          <span>{money(order.total)}</span>
        </div>
      </div>

      {payment.paid && (
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <span className="font-medium">Paid</span>
            <span className="text-muted-foreground text-sm">
              {money(Number(payment.paid.totalAmount))}
              {Number(payment.paid.tipAmount) > 0 &&
                ` (includes ${money(Number(payment.paid.tipAmount))} tip)`}
            </span>
          </div>
          {/* The receipt outlives this page's usefulness: it stays
              readable after the four-hour session expires, which is when
              someone actually goes looking for it. */}
          <Link
            href={`/r/${restaurantSlug}/receipt/${payment.paid.paymentId}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            View receipt
          </Link>
        </div>
      )}

      {payable && (
        <PayOrderPanel
          orderTotal={order.total}
          currency={order.currency}
          tippingEnabled={payment.tippingEnabled}
          hasFailedAttempt={payment.hasFailedAttempt}
          payAction={payForThisOrder}
        />
      )}

      <p className="text-muted-foreground text-center text-xs">
        Placed {new Date(order.createdAt).toLocaleString()}
      </p>

      <div className="flex flex-col gap-2">
        <Link
          href={`/r/${restaurantSlug}/menu`}
          className={buttonVariants({ variant: "outline" })}
        >
          Back to menu
        </Link>
        <Link
          href={`/r/${restaurantSlug}/orders`}
          className={buttonVariants({ variant: "ghost" })}
        >
          View your orders
        </Link>
      </div>
    </div>
  );
}
