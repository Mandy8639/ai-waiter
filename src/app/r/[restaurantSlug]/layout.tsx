import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { AiWaiter } from "@/components/customer/ai-waiter";
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
  const aiWaiterAvailable =
    isThisRestaurant && (await isAiWaiterAvailable(restaurantSlug));

  return (
    <div className="mx-auto flex min-h-full w-full max-w-lg flex-1 flex-col">
      <header className="bg-background/95 sticky top-0 z-10 flex items-center justify-between border-b px-4 py-3 backdrop-blur-sm">
        <Link
          href={`/r/${restaurantSlug}`}
          className="truncate text-base font-semibold tracking-tight"
        >
          {restaurant.name}
        </Link>
        {isThisRestaurant && (
          <div className="flex items-center gap-4">
            <Link
              href={`/r/${restaurantSlug}/orders`}
              className="text-sm font-medium"
            >
              Orders
            </Link>
            <Link
              href={`/r/${restaurantSlug}/cart`}
              className="relative flex items-center gap-1.5 text-sm font-medium"
            >
              Cart
              {cartCount > 0 && (
                <Badge
                  variant="secondary"
                  className="min-w-5 justify-center px-1.5"
                >
                  {cartCount}
                </Badge>
              )}
            </Link>
          </div>
        )}
      </header>

      <main className="flex flex-1 flex-col px-4 py-4">{children}</main>

      {aiWaiterAvailable && <AiWaiter restaurantSlug={restaurantSlug} />}
    </div>
  );
}
