import Link from "next/link";
import { notFound } from "next/navigation";
import { Receipt, ShoppingBag } from "lucide-react";
import { AiWaiterProvider } from "@/components/customer/ai-waiter";
import { DinerDock } from "@/components/customer/diner-dock";
import { getPublicRestaurantBySlug } from "@/lib/customer/restaurant";
import { getActiveCustomerSession } from "@/lib/customer/session";
import { getCartItemCount } from "@/lib/cart/get-cart";
import { isAiWaiterAvailable } from "@/lib/ai/actions";

export default async function CustomerRestaurantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ restaurantSlug: string }>;
}) {
  const { restaurantSlug } = await params;
  const restaurant = await getPublicRestaurantBySlug(restaurantSlug);

  if (!restaurant) {
    notFound();
  }

  const session = await getActiveCustomerSession();
  const isThisRestaurant = session && session.restaurantId === restaurant.id;
  const cartCount = isThisRestaurant ? await getCartItemCount(session.id) : 0;
  // Requires an active session (the AI waiter's tools operate on this
  // customer's own cart/orders) and the restaurant's own opt-in — see
  // docs/ai.md#restaurant-opt-in.
  const aiWaiterAvailable = Boolean(
    isThisRestaurant && (await isAiWaiterAvailable(restaurantSlug)),
  );

  return (
    <AiWaiterProvider
      available={aiWaiterAvailable}
      restaurantSlug={restaurantSlug}
      restaurantName={restaurant.name}
    >
      <div className="flex min-h-full w-full flex-1 flex-col">
        <header className="bg-background/90 supports-backdrop-filter:bg-background/75 sticky top-0 z-20 border-b backdrop-blur-md">
          <div className="mx-auto flex h-14 w-full max-w-2xl items-center justify-between gap-3 px-4 sm:px-6">
            <Link
              href={`/r/${restaurantSlug}`}
              className="flex min-w-0 items-center gap-2.5"
            >
              {restaurant.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- restaurant-supplied remote URL
                <img
                  src={restaurant.logoUrl}
                  alt=""
                  width={28}
                  height={28}
                  className="size-7 shrink-0 rounded-full border object-cover"
                />
              )}
              <span className="truncate text-[0.9375rem] font-semibold tracking-tight">
                {restaurant.name}
              </span>
            </Link>
            {isThisRestaurant && (
              <nav aria-label="Your visit" className="flex items-center gap-1">
                <Link
                  href={`/r/${restaurantSlug}/orders`}
                  className="type-label text-muted-foreground hover:text-foreground hover:bg-muted flex h-9 items-center gap-1.5 rounded-lg px-2.5 transition-colors"
                >
                  <Receipt className="size-4" aria-hidden="true" />
                  <span>Orders</span>
                </Link>
                <Link
                  href={`/r/${restaurantSlug}/cart`}
                  aria-label={
                    cartCount > 0
                      ? `Your order, ${cartCount} ${cartCount === 1 ? "item" : "items"}`
                      : "Your order"
                  }
                  className="type-label hover:bg-muted relative flex h-9 items-center gap-1.5 rounded-lg px-2.5 transition-colors"
                >
                  <ShoppingBag className="size-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Order</span>
                  {cartCount > 0 && (
                    <span
                      aria-hidden="true"
                      className="bg-primary text-primary-foreground type-price flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[0.6875rem]"
                    >
                      {cartCount}
                    </span>
                  )}
                </Link>
              </nav>
            )}
          </div>
        </header>

        {/* Bottom padding keeps the last dish clear of the floating dock. */}
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pt-5 pb-32 sm:px-6">
          {children}
        </main>

        {isThisRestaurant && (
          <DinerDock restaurantSlug={restaurantSlug} cartCount={cartCount} />
        )}
      </div>
    </AiWaiterProvider>
  );
}
