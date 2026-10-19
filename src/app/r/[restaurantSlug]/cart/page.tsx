import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertCircle, QrCode, ShoppingBag } from "lucide-react";
import { AskWaiterButton } from "@/components/customer/ask-waiter-card";
import { isChefEnabled } from "@/lib/chef/feature";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatPrice } from "@/lib/format/price";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { CartLineItem } from "@/components/customer/cart-line-item";
import { PlaceOrderForm } from "@/components/customer/place-order-form";
import {
  getPublicOrderSettings,
  getPublicRestaurantBySlug,
} from "@/lib/customer/restaurant";
import { getActiveCustomerSession } from "@/lib/customer/session";
import { getCart } from "@/lib/cart/get-cart";
import { getKitchenStatus } from "@/lib/kitchen/busy-queries";
import { clearCart } from "@/lib/cart/actions";
import { getPickupOptions } from "@/lib/pickup/queries";
import { PRIVATE_PAGE_ROBOTS } from "@/lib/seo/metadata";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  return {
    title: restaurant ? `Cart — ${restaurant.name}` : "Cart",
    robots: PRIVATE_PAGE_ROBOTS,
  };
}

export default async function CartPage({
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
  const price = (amount: number) => formatPrice(amount, restaurant.currency);

  if (!session || session.restaurantId !== restaurant.id) {
    return (
      <EmptyState
        icon={<QrCode />}
        title="Scan the code on your table"
        description="Your order is tied to your table. Scan its QR code to start one."
      >
        <Link
          href={`/r/${restaurantSlug}`}
          className={buttonVariants({ variant: "outline", size: "lg" })}
        >
          Back to {restaurant.name}
        </Link>
      </EmptyState>
    );
  }

  const [cart, orderSettings, kitchen, pickup] = await Promise.all([
    getCart(restaurant.id, session.id),
    getPublicOrderSettings(restaurant.id),
    getKitchenStatus(restaurant.id),
    getPickupOptions(),
  ]);

  const canPlaceOrder =
    restaurant.isActive &&
    orderSettings.acceptingOrders &&
    !kitchen.paused &&
    cart.lines.length > 0 &&
    !cart.hasUnavailableItems;

  const itemCount = cart.lines.reduce((sum, line) => sum + line.quantity, 0);

  const notices = [
    !restaurant.isActive &&
      "This restaurant is currently unavailable. You can still review or clear your order, but new items can't be added right now.",
    cart.hasUnavailableItems &&
      "One or more dishes in your order are no longer available — please remove them.",
    restaurant.isActive &&
      !orderSettings.acceptingOrders &&
      "The kitchen isn't taking new orders right now. You can still review or clear your order.",
    // Busy mode's pause. Its wording (with how long) is already in the
    // banner at the top of the page; this says what it means for the cart.
    restaurant.isActive &&
      orderSettings.acceptingOrders &&
      kitchen.paused &&
      "New orders are paused for a little while. Your order is saved here, so you can place it as soon as the kitchen opens again.",
  ].filter((notice): notice is string => Boolean(notice));

  if (cart.lines.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingBag />}
        title="Your order is empty"
        description={`Browse the menu, or ask the ${isChefEnabled(restaurantSlug) ? "Chef" : "waiter"} for a suggestion — dishes you add will show up here.`}
      >
        <Link
          href={`/r/${restaurantSlug}/menu`}
          className={buttonVariants({ size: "lg" })}
        >
          Browse the menu
        </Link>
        <AskWaiterButton
          prompt="What do you recommend?"
          chefLabel="Ask the Chef"
        >
          Ask the waiter
        </AskWaiterButton>
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="type-title">Your order</h1>
        <p className="type-body-sm text-muted-foreground">
          {itemCount} {itemCount === 1 ? "item" : "items"} · review and place it
          when you&apos;re ready
        </p>
      </div>

      {notices.map((notice) => (
        <p
          key={notice}
          role="alert"
          className="border-destructive/30 bg-destructive/5 type-body-sm flex items-start gap-2 rounded-xl border px-4 py-3"
        >
          <AlertCircle
            className="text-destructive mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {notice}
        </p>
      ))}

      <ul className="flex flex-col gap-3" aria-label="Dishes in your order">
        {cart.lines.map((line) => (
          <CartLineItem
            key={line.id}
            line={line}
            currency={restaurant.currency}
          />
        ))}
      </ul>

      <section
        aria-label="Order total"
        className="bg-card shadow-card flex flex-col gap-4 rounded-xl border p-4"
      >
        <dl className="type-body-sm flex flex-col gap-2">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="type-price">{price(cart.subtotal)}</dd>
          </div>
          {cart.taxRate > 0 && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">
                Estimated tax ({(cart.taxRate * 100).toFixed(2)}%)
              </dt>
              <dd className="type-price">{price(cart.taxAmount)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t pt-3 text-base">
            <dt className="font-semibold">Total</dt>
            <dd className="type-price text-lg">{price(cart.total)}</dd>
          </div>
        </dl>

        <PlaceOrderForm
          restaurantSlug={restaurantSlug}
          disabled={!canPlaceOrder}
          allowCustomerNotes={orderSettings.allowCustomerNotes}
          pickup={pickup.isCounter ? pickup : undefined}
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href={`/r/${restaurantSlug}/menu`}
          className={buttonVariants({ variant: "outline" })}
        >
          Add more dishes
        </Link>
        <DeleteButton
          onDelete={clearCart}
          confirmTitle="Clear your order?"
          confirmDescription="This removes every dish from your order. This can't be undone."
          triggerLabel="Clear order"
        />
      </div>
    </div>
  );
}
