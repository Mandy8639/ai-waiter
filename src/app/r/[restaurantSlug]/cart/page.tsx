import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { DeleteButton } from "@/components/dashboard/delete-button";
import { CartLineItem } from "@/components/customer/cart-line-item";
import { PlaceOrderForm } from "@/components/customer/place-order-form";
import {
  getPublicOrderSettings,
  getPublicRestaurantBySlug,
} from "@/lib/customer/restaurant";
import { getActiveCustomerSession } from "@/lib/customer/session";
import { getCart } from "@/lib/cart/get-cart";
import { clearCart } from "@/lib/cart/actions";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);
  return { title: restaurant ? `Cart — ${restaurant.name}` : "Cart" };
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
  const currency = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  });

  if (!session || session.restaurantId !== restaurant.id) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
        <Badge variant="outline">No active session</Badge>
        <p className="text-muted-foreground max-w-xs text-sm">
          Scan the QR code at your table to start browsing and build a cart.
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

  const [cart, orderSettings] = await Promise.all([
    getCart(restaurant.id, session.id),
    getPublicOrderSettings(restaurant.id),
  ]);

  const canPlaceOrder =
    restaurant.isActive &&
    orderSettings.acceptingOrders &&
    cart.lines.length > 0 &&
    !cart.hasUnavailableItems;

  return (
    <div className="flex flex-1 flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">Your cart</h1>

      {!restaurant.isActive && (
        <p className="text-destructive text-sm">
          This restaurant is currently unavailable. You can still review or
          clear your cart, but new items can&apos;t be added right now.
        </p>
      )}

      {cart.hasUnavailableItems && (
        <p className="text-destructive text-sm">
          One or more items in your cart are no longer available — please remove
          them.
        </p>
      )}

      {restaurant.isActive && !orderSettings.acceptingOrders && (
        <p className="text-destructive text-sm">
          This restaurant isn&apos;t accepting new orders right now. You can
          still review or clear your cart.
        </p>
      )}

      {cart.lines.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
          <p className="text-muted-foreground text-sm">Your cart is empty.</p>
          <Link
            href={`/r/${restaurantSlug}/menu`}
            className={buttonVariants({ variant: "default" })}
          >
            Browse the menu
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-4">
            {cart.lines.map((line) => (
              <CartLineItem key={line.id} line={line} />
            ))}
          </div>

          <div className="flex flex-col gap-1 border-t pt-4 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{currency.format(cart.subtotal)}</span>
            </div>
            {cart.taxRate > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  Estimated tax ({(cart.taxRate * 100).toFixed(2)}%)
                </span>
                <span>{currency.format(cart.taxAmount)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-semibold">
              <span>Total</span>
              <span>{currency.format(cart.total)}</span>
            </div>
          </div>

          <PlaceOrderForm
            restaurantSlug={restaurantSlug}
            disabled={!canPlaceOrder}
            allowCustomerNotes={orderSettings.allowCustomerNotes}
          />

          <div className="flex flex-col gap-2">
            <Link
              href={`/r/${restaurantSlug}/menu`}
              className={buttonVariants({ variant: "outline" })}
            >
              Continue browsing
            </Link>
            <DeleteButton
              onDelete={clearCart}
              confirmTitle="Clear your cart?"
              confirmDescription="This removes every item currently in your cart. This can't be undone."
              triggerLabel="Clear cart"
            />
          </div>
        </>
      )}
    </div>
  );
}
