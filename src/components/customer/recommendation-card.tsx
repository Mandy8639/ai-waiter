"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Plus } from "lucide-react";
import { AllergenLine } from "@/components/customer/allergen-note";
import { DietBadges } from "@/components/customer/diet-badges";
import { addToCart } from "@/lib/cart/actions";
import type { RecommendationCard as RecommendationCardData } from "@/lib/ai/actions";
import { formatPrice } from "@/lib/format/price";
import { cn } from "@/lib/utils";

/**
 * A dish the waiter's reply named, as a card the diner can act on.
 *
 * Built from rows the server returned (src/lib/ai/recommendation-cards.ts),
 * never from the model's prose. "Add" goes through the same addToCart
 * server action as the item page, so pricing and availability are checked
 * exactly as they are there. A dish with a required option (a size, a
 * base) can't be added blind — its button opens the item page instead.
 */
export function RecommendationCard({
  item,
  restaurantSlug,
  onNavigate,
}: {
  item: RecommendationCardData;
  restaurantSlug: string;
  /** Called when a link leaves the chat, so the sheet can close. */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const href = `/r/${restaurantSlug}/item/${item.id}`;

  function add() {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("menuItemId", item.id);
      formData.set("quantity", "1");
      const result = await addToCart({}, formData);
      if (result.error || result.fieldErrors) {
        setError(
          result.error ??
            "Couldn't add that here — open the dish to try again.",
        );
        return;
      }
      setAdded(true);
      // The cart count in the dock is server-rendered; refresh it.
      router.refresh();
    });
  }

  return (
    <div className="bg-card shadow-card flex gap-3 rounded-xl border p-3">
      {item.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- restaurant-supplied remote URL
        <img
          src={item.imageUrl}
          alt={item.name}
          loading="lazy"
          decoding="async"
          width={64}
          height={64}
          className="bg-muted size-16 shrink-0 rounded-lg object-cover"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <p className="type-label text-foreground text-[0.875rem] leading-snug font-semibold">
            {item.name}
          </p>
          <span className="type-price shrink-0 text-[0.875rem]">
            {formatPrice(item.price, item.currency)}
          </span>
        </div>
        <DietBadges
          isVegetarian={item.isVegetarian}
          isVegan={item.isVegan}
          isSpicy={item.isSpicy}
        />
        <AllergenLine allergens={item.allergens} />
        {error && (
          <p className="type-caption text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="mt-1 flex items-center gap-2">
          <Link
            href={href}
            onClick={onNavigate}
            className="type-label text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 items-center rounded-lg px-2.5 transition-colors"
          >
            View dish
          </Link>
          {item.needsOptions ? (
            <Link
              href={href}
              onClick={onNavigate}
              className="type-label bg-secondary text-secondary-foreground hover:bg-accent inline-flex h-8 items-center rounded-lg px-3 transition-colors"
            >
              Choose options
            </Link>
          ) : (
            <button
              type="button"
              onClick={add}
              disabled={isPending || added}
              aria-label={
                added
                  ? `${item.name} added to your order`
                  : `Add ${item.name} to your order`
              }
              className={cn(
                "type-label inline-flex h-8 items-center gap-1 rounded-lg px-3 transition-colors disabled:cursor-default",
                added
                  ? "bg-success/12 text-success"
                  : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60",
              )}
            >
              {added ? (
                <>
                  <Check className="size-3.5" aria-hidden="true" /> Added
                </>
              ) : (
                <>
                  <Plus className="size-3.5" aria-hidden="true" />
                  {isPending ? "Adding…" : "Add"}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
