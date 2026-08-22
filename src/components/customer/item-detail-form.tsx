"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CartActionState } from "@/lib/cart/actions";

const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
});

export interface ModifierOptionData {
  id: string;
  name: string;
  priceAdjustment: number;
  isAvailable: boolean;
}

export interface ModifierGroupData {
  id: string;
  name: string;
  description: string | null;
  isRequired: boolean;
  minSelections: number;
  maxSelections: number;
  options: ModifierOptionData[];
}

const initialState: CartActionState = {};

export function ItemDetailForm({
  action,
  menuItemId,
  basePrice,
  groups,
  restaurantSlug,
}: {
  action: (
    prevState: CartActionState,
    formData: FormData,
  ) => Promise<CartActionState>;
  menuItemId: string;
  basePrice: number;
  groups: ModifierGroupData[];
  restaurantSlug: string;
}) {
  const [selected, setSelected] = useState<Record<string, Set<string>>>(() =>
    Object.fromEntries(groups.map((g) => [g.id, new Set<string>()])),
  );
  const [quantity, setQuantity] = useState(1);
  const [state, formAction, isPending] = useActionState(action, initialState);

  function toggleOption(group: ModifierGroupData, optionId: string) {
    setSelected((prev) => {
      const current = new Set(prev[group.id]);
      if (current.has(optionId)) {
        current.delete(optionId);
      } else if (group.maxSelections === 1) {
        current.clear();
        current.add(optionId);
      } else if (current.size < group.maxSelections) {
        current.add(optionId);
      }
      return { ...prev, [group.id]: current };
    });
  }

  const modifiersPrice = groups.reduce((sum, group) => {
    const groupSelected = selected[group.id] ?? new Set();
    return (
      sum +
      group.options
        .filter((o) => groupSelected.has(o.id))
        .reduce((s, o) => s + o.priceAdjustment, 0)
    );
  }, 0);
  const unitTotal = basePrice + modifiersPrice;
  const total = unitTotal * quantity;

  const isValid = groups.every((group) => {
    const count = selected[group.id]?.size ?? 0;
    const effectiveMin = group.isRequired
      ? Math.max(1, group.minSelections)
      : group.minSelections;
    return count >= effectiveMin && count <= group.maxSelections;
  });

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="menuItemId" value={menuItemId} />
      <input type="hidden" name="quantity" value={quantity} />

      {groups.map((group) => {
        const groupSelected = selected[group.id] ?? new Set();
        return (
          <fieldset key={group.id} className="flex flex-col gap-2">
            <legend className="flex items-center gap-1.5 text-sm font-medium">
              {group.name}
              {group.isRequired && <span className="text-destructive">*</span>}
            </legend>
            {group.description && (
              <p className="text-muted-foreground text-xs">
                {group.description}
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              {group.maxSelections === 1
                ? "Choose 1"
                : `Choose up to ${group.maxSelections}`}
              {group.isRequired ? " — required" : " — optional"}
            </p>
            <div className="flex flex-col gap-1.5">
              {group.options.map((option) => {
                const checked = groupSelected.has(option.id);
                return (
                  <label
                    key={option.id}
                    className={cn(
                      "flex cursor-pointer items-center justify-between rounded-md border px-3 py-2.5 text-sm transition-colors",
                      checked && "border-primary bg-accent",
                      !option.isAvailable && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name="optionId"
                        value={option.id}
                        checked={checked}
                        disabled={!option.isAvailable || isPending}
                        onChange={() => toggleOption(group, option.id)}
                        className="accent-primary size-4"
                      />
                      {option.name}
                      {!option.isAvailable && (
                        <span className="text-muted-foreground text-xs">
                          (unavailable)
                        </span>
                      )}
                    </span>
                    {option.priceAdjustment !== 0 && (
                      <span className="text-muted-foreground text-xs">
                        {option.priceAdjustment > 0 ? "+" : ""}
                        {currency.format(option.priceAdjustment)}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Quantity</span>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={quantity <= 1 || isPending}
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            aria-label="Decrease quantity"
          >
            −
          </Button>
          <span className="w-6 text-center text-sm tabular-nums">
            {quantity}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={quantity >= 99 || isPending}
            onClick={() => setQuantity((q) => Math.min(99, q + 1))}
            aria-label="Increase quantity"
          >
            +
          </Button>
        </div>
      </div>

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.success && (
        <Alert>
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>Added to cart.</span>
            <Link
              href={`/r/${restaurantSlug}/cart`}
              className="font-medium underline-offset-4 hover:underline"
            >
              View cart
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <Button
        type="submit"
        disabled={!isValid || isPending}
        size="lg"
        className="w-full"
      >
        {isPending ? "Adding…" : `Add to cart · ${currency.format(total)}`}
      </Button>
    </form>
  );
}
