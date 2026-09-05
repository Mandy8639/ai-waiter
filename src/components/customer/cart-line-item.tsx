"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { removeCartItem, updateCartItemQuantity } from "@/lib/cart/actions";
import type { CartLine } from "@/lib/cart/get-cart";

const SPICE_WORDS: Record<string, string> = {
  none: "without spice",
  mild: "mild",
  medium: "medium",
  hot: "hot",
  very_hot: "very hot",
};

const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
});

export function CartLineItem({ line }: { line: CartLine }) {
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
    <div className="flex flex-col gap-2 border-b pb-4 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium">{line.menuItemName}</p>
          {!line.stillAvailable && (
            <Badge variant="destructive" className="w-fit">
              No longer available
            </Badge>
          )}
          {line.modifiers.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {line.modifiers.map((m) => m.name).join(", ")}
            </p>
          )}
          {/*
            Shown back to the diner because it is the only chance they get
            to notice a request that didn't land the way they meant — once
            the order is submitted this line is immutable.
          */}
          {line.spicePreference && (
            <p className="text-xs">
              Cooked {SPICE_WORDS[line.spicePreference] ?? line.spicePreference}
            </p>
          )}
          {line.notes && <p className="text-xs">Note: {line.notes}</p>}
          <p className="text-muted-foreground text-xs">
            {currency.format(line.unitPrice + line.modifiersPrice)} each
          </p>
        </div>
        <p className="shrink-0 text-sm font-medium">
          {currency.format(line.lineTotal)}
        </p>
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={isPending || line.quantity <= 1}
            onClick={() => changeQuantity(line.quantity - 1)}
            aria-label="Decrease quantity"
          >
            −
          </Button>
          <span className="w-6 text-center text-sm tabular-nums">
            {line.quantity}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={isPending || line.quantity >= 99}
            onClick={() => changeQuantity(line.quantity + 1)}
            aria-label="Increase quantity"
          >
            +
          </Button>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={remove}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}
