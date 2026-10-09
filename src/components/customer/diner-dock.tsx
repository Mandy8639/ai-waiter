"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConciergeBell, ShoppingBag } from "lucide-react";
import { useAiWaiter } from "./ai-waiter";
import { ChefArt } from "./chef-art";
import { cn } from "@/lib/utils";

/**
 * The diner's bottom bar: the two things they come back to all meal —
 * asking the waiter, and their order so far.
 *
 * Replaces an unlabelled 56px chat bubble in the corner. The waiter is
 * named in words because an icon alone never told anyone there was a
 * waiter to ask. The cart side only appears once something is in it, and
 * it is hidden on the cart page itself (it would link to where you are)
 * and on dish pages, where the sticky "Add to order" button owns the
 * bottom of the screen.
 */
export function DinerDock({
  restaurantSlug,
  cartCount,
}: {
  restaurantSlug: string;
  cartCount: number;
}) {
  const pathname = usePathname();
  const { available, chef, openWaiter } = useAiWaiter();

  const onItemPage = pathname.includes(`/r/${restaurantSlug}/item/`);
  const onCartPage = pathname === `/r/${restaurantSlug}/cart`;
  const showCart = cartCount > 0 && !onCartPage;

  if (onItemPage || (!available && !showCart)) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-end gap-2 px-4 sm:px-6">
        {available && (
          <button
            type="button"
            onClick={(event) => openWaiter(undefined, event.currentTarget)}
            aria-label={
              showCart ? (chef ? "Ask the Chef" : "Ask the waiter") : undefined
            }
            className={cn(
              "shadow-float pointer-events-auto flex h-12 items-center gap-2 rounded-full border px-4 transition-[transform,background-color] duration-150 active:scale-[0.98]",
              "bg-card text-foreground hover:bg-ai-soft focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none",
              !showCart &&
                "bg-foreground text-background hover:bg-foreground/90 border-transparent",
            )}
          >
            {chef ? (
              <span className="bg-card flex size-7 items-center justify-center overflow-hidden rounded-full">
                <ChefArt pose="neutral" size={28} />
              </span>
            ) : (
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-full",
                  showCart
                    ? "bg-ai-soft text-ai"
                    : "bg-background/15 text-background",
                )}
                aria-hidden="true"
              >
                <ConciergeBell className="size-4" />
              </span>
            )}
            {/* Shortened when the cart shares the bar, so both fit a 320px phone on one line. */}
            <span className="type-label text-[0.9375rem] font-semibold whitespace-nowrap">
              {chef ? (
                showCart ? (
                  // PROTOTYPE: the full name from about 360px, where it fits
                  // beside a shortened "Order"; "Chef" on the narrowest phones.
                  <>
                    <span className="min-[360px]:hidden">Chef</span>
                    <span className="hidden min-[360px]:inline">
                      Ask the Chef
                    </span>
                  </>
                ) : (
                  "Ask the Chef"
                )
              ) : showCart ? (
                "Ask"
              ) : (
                "Ask the waiter"
              )}
            </span>
          </button>
        )}

        {showCart && (
          <Link
            href={`/r/${restaurantSlug}/cart`}
            aria-label={`View your order, ${cartCount} ${cartCount === 1 ? "item" : "items"}`}
            className="bg-primary text-primary-foreground shadow-float hover:bg-primary/90 focus-visible:ring-ring/50 pointer-events-auto flex h-12 flex-1 items-center justify-between gap-3 rounded-full px-5 transition-[transform,background-color] duration-150 focus-visible:ring-3 focus-visible:outline-none active:scale-[0.98] sm:min-w-56 sm:flex-none"
          >
            <span className="flex items-center gap-2">
              <ShoppingBag className="size-4" aria-hidden="true" />
              <span className="type-label text-[0.9375rem] font-semibold whitespace-nowrap">
                {chef ? (
                  <>
                    <span className="min-[360px]:hidden">View order</span>
                    <span className="hidden min-[360px]:inline">Order</span>
                  </>
                ) : (
                  "View order"
                )}
              </span>
            </span>
            <span
              aria-hidden="true"
              className="type-price bg-primary-foreground text-primary flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[0.8125rem]"
            >
              {cartCount}
            </span>
          </Link>
        )}
      </div>
    </div>
  );
}
