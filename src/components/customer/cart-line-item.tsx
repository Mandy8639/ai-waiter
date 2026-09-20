"use client";

import { useState, useTransition } from "react";
import { Minus, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { removeCartItem, updateCartItemQuantity } from "@/lib/cart/actions";
import type { CartLine } from "@/lib/cart/get-cart";
import { formatPrice } from "@/lib/format/price";

const SPICE_WORDS: Record<string, string> = {
  none: "without spice",
  mild: "mild",
  medium: "medium",
  hot: "hot",
  very_hot: "very hot",
};

const stepperButton =
  "hover:bg-secondary focus-visible:ring-ring/50 flex size-9 items-center justify-center rounded-full transition-colors focus-visible:ring-3 focus-visible:outline-none disabled:opacity-40";

export function CartLineItem({
  line,
  currency,
}: {
  line: CartLine;
  /** The restaurant's currency code — see src/lib/format/price.ts. */
  currency: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function changeQuantity(next: number) {
    if (next < 1) return;
    setError(null);
    startTransition(async () => {
      const result = await updateCartItemQuantity(line.id, next);
      if (result.error) setError(result.error);
    });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await removeCartItem(line.id);
      if (result.error) setError(result.error);
    });
  }

  return (
    <li
      className={
        "bg-card shadow-card flex flex-col gap-3 rounded-xl border p-4 transition-opacity " +
        (isPending ? "opacity-60" : "")
      }
      aria-busy={isPending || undefined}
    >
      <div className="flex items-start gap-3">
        {line.menuItemImageUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- restaurant-supplied remote URL
          <img
            src={line.menuItemImageUrl}
            alt=""
            width={56}
            height={56}
            loading="lazy"
            className="bg-muted size-14 shrink-0 rounded-lg object-cover"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-3">
            <p className="type-dish">{line.menuItemName}</p>
            <p className="type-price shrink-0">
              {formatPrice(line.lineTotal, currency)}
            </p>
          </div>
          {!line.stillAvailable && (
            <Badge variant="destructive" className="w-fit">
              No longer available
            </Badge>
          )}
          {line.modifiers.length > 0 && (
            <p className="type-caption text-muted-foreground">
              {line.modifiers.map((m) => m.name).join(", ")}
            </p>
          )}
          {/*
            Shown back to the diner because it is the only chance they get
            to notice a request that didn't land the way they meant — once
            the order is submitted this line is immutable.
          */}
          {line.spicePreference && (
            <p className="type-caption">
              Cooked {SPICE_WORDS[line.spicePreference] ?? line.spicePreference}
            </p>
          )}
          {line.notes && (
            <p className="type-caption">
              <span className="text-muted-foreground">Note: </span>
              {line.notes}
            </p>
          )}
          <p className="type-caption text-muted-foreground">
            {formatPrice(line.unitPrice + line.modifiersPrice, currency)} each
          </p>
        </div>
      </div>

      {error && (
        <p className="type-caption text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between">
        <div
          className="flex items-center gap-1 rounded-full border p-0.5"
          role="group"
          aria-label={`Quantity of ${line.menuItemName}`}
        >
          <button
            type="button"
            className={stepperButton}
            disabled={isPending || line.quantity <= 1}
            onClick={() => changeQuantity(line.quantity - 1)}
            aria-label={`One fewer ${line.menuItemName}`}
          >
            <Minus className="size-4" aria-hidden="true" />
          </button>
          <span className="type-price w-7 text-center" aria-live="polite">
            {line.quantity}
          </span>
          <button
            type="button"
            className={stepperButton}
            disabled={isPending || line.quantity >= 99}
            onClick={() => changeQuantity(line.quantity + 1)}
            aria-label={`One more ${line.menuItemName}`}
          >
            <Plus className="size-4" aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          disabled={isPending}
          onClick={remove}
          className="type-label text-muted-foreground hover:text-destructive hover:bg-destructive/5 focus-visible:ring-ring/50 inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 transition-colors focus-visible:ring-3 focus-visible:outline-none"
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Remove
          <span className="sr-only"> {line.menuItemName}</span>
        </button>
      </div>
    </li>
  );
}
