"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import {
  ChevronRight,
  CircleCheck,
  Minus,
  Plus,
  ShoppingBag,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatPrice } from "@/lib/format/price";
import { cn } from "@/lib/utils";
import type { CartActionState } from "@/lib/cart/actions";
import { ADD_NOT_CONFIRMED } from "@/lib/offline/core";

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

function spiceWord(level: string): string {
  if (level === "very_hot") return "very hot";
  return level;
}

const SPICE_CHOICES = [
  { value: "", label: "As you normally make it" },
  { value: "none", label: "Not spicy" },
  { value: "mild", label: "Mild" },
  { value: "medium", label: "Medium" },
  { value: "hot", label: "Hot" },
] as const;

export function ItemDetailForm({
  action,
  menuItemId,
  basePrice,
  groups,
  restaurantSlug,
  dishSpiceLevel,
  allowNotes,
  currency,
  offerSpiceChoice = true,
}: {
  /**
   * False for dishes the restaurant marks as neither spicy nor given a
   * heat level — a cold coffee should not ask how hot you'd like it.
   */
  offerSpiceChoice?: boolean;
  /** The restaurant's currency code — see src/lib/format/price.ts. */
  currency: string;
  action: (
    prevState: CartActionState,
    formData: FormData,
  ) => Promise<CartActionState>;
  menuItemId: string;
  /** What the kitchen normally does, used to label the default choice. */
  dishSpiceLevel?: string | null;
  /** The restaurant's allow_customer_notes setting. */
  allowNotes?: boolean;
  basePrice: number;
  groups: ModifierGroupData[];
  restaurantSlug: string;
}) {
  const [selected, setSelected] = useState<Record<string, Set<string>>>(() =>
    Object.fromEntries(groups.map((g) => [g.id, new Set<string>()])),
  );
  const [quantity, setQuantity] = useState(1);
  // A dropped connection makes the action throw rather than answer, which
  // would replace the page with an error. Say what happened instead, and
  // don't retry: if the first attempt did arrive, a retry would add the
  // dish twice (src/lib/offline/core.ts).
  const [state, formAction, isPending] = useActionState(
    async (prev: CartActionState, formData: FormData) => {
      try {
        return await action(prev, formData);
      } catch {
        return { error: ADD_NOT_CONFIRMED };
      }
    },
    initialState,
  );

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

  const price = (amount: number) => formatPrice(amount, currency);

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="menuItemId" value={menuItemId} />
      <input type="hidden" name="quantity" value={quantity} />

      {groups.map((group) => {
        const groupSelected = selected[group.id] ?? new Set();
        return (
          <fieldset
            key={group.id}
            className="bg-card shadow-card flex flex-col gap-3 rounded-xl border p-4"
          >
            <legend className="sr-only">{group.name}</legend>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <p className="type-dish" aria-hidden="true">
                  {group.name}
                </p>
                <p className="type-caption text-muted-foreground">
                  {group.description ? `${group.description} · ` : ""}
                  {group.maxSelections === 1
                    ? "Choose 1"
                    : `Choose up to ${group.maxSelections}`}
                </p>
              </div>
              <span
                className={cn(
                  "type-overline shrink-0 rounded-full px-2 py-1",
                  group.isRequired
                    ? "bg-foreground text-background"
                    : "bg-secondary text-muted-foreground",
                )}
              >
                {group.isRequired ? "Required" : "Optional"}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {group.options.map((option) => {
                const checked = groupSelected.has(option.id);
                return (
                  <label
                    key={option.id}
                    className={cn(
                      "type-body-sm flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 transition-colors duration-150",
                      "has-focus-visible:ring-ring/50 has-focus-visible:ring-3",
                      checked
                        ? "border-primary bg-primary/5"
                        : "hover:bg-secondary/60",
                      !option.isAvailable && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <span className="flex items-center gap-2.5">
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
                        <span className="type-caption text-muted-foreground">
                          (unavailable)
                        </span>
                      )}
                    </span>
                    {option.priceAdjustment !== 0 && (
                      <span className="type-price type-caption text-muted-foreground">
                        {option.priceAdjustment > 0 ? "+" : ""}
                        {price(option.priceAdjustment)}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      {/*
        How the DINER wants it, which is not the same question as how the
        dish is normally made. The default is deliberately "as you normally
        make it" rather than the dish's own level: pre-selecting "mild"
        would make every order look like a special request, and a kitchen
        that sees a heat request on all 200 tickets stops reading them.
      */}
      {offerSpiceChoice && (
        <fieldset className="flex flex-col gap-2.5">
          <legend className="type-dish">How spicy would you like it?</legend>
          {dishSpiceLevel && dishSpiceLevel !== "none" && (
            <p className="type-caption text-muted-foreground -mt-1">
              This dish is normally {spiceWord(dishSpiceLevel)}.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {SPICE_CHOICES.map((choice) => (
              <label
                key={choice.value}
                className={cn(
                  "type-label flex h-10 cursor-pointer items-center rounded-full border px-4 transition-colors duration-150",
                  "hover:bg-secondary has-checked:bg-foreground has-checked:text-background has-checked:border-transparent",
                  "has-focus-visible:ring-ring/50 has-focus-visible:ring-3",
                )}
              >
                <input
                  type="radio"
                  name="spicePreference"
                  value={choice.value}
                  defaultChecked={choice.value === ""}
                  className="sr-only"
                />
                {choice.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {allowNotes && (
        <div className="flex flex-col gap-2">
          <label htmlFor="notes" className="type-dish">
            Anything else for the kitchen?
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={2}
            maxLength={200}
            placeholder="e.g. no onions, extra chutney"
            className="bg-card border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/40 type-body w-full rounded-xl border px-3.5 py-2.5 transition-colors focus-visible:ring-3 focus-visible:outline-none"
          />
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="type-dish" id="quantity-label">
          Quantity
        </span>
        <div
          className="flex items-center gap-1 rounded-full border p-1"
          role="group"
          aria-labelledby="quantity-label"
        >
          <button
            type="button"
            disabled={quantity <= 1 || isPending}
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            aria-label="Decrease quantity"
            className="hover:bg-secondary focus-visible:ring-ring/50 flex size-9 items-center justify-center rounded-full transition-colors focus-visible:ring-3 focus-visible:outline-none disabled:opacity-40"
          >
            <Minus className="size-4" aria-hidden="true" />
          </button>
          <span
            className="type-price w-8 text-center text-base"
            aria-live="polite"
          >
            {quantity}
          </span>
          <button
            type="button"
            disabled={quantity >= 99 || isPending}
            onClick={() => setQuantity((q) => Math.min(99, q + 1))}
            aria-label="Increase quantity"
            className="hover:bg-secondary focus-visible:ring-ring/50 flex size-9 items-center justify-center rounded-full transition-colors focus-visible:ring-3 focus-visible:outline-none disabled:opacity-40"
          >
            <Plus className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/*
        The action lives in a bar pinned to the bottom of the screen: on a
        phone the form is taller than the viewport, and a button below the
        fold is a button people don't find. It is still inside the form, so
        it submits it natively. The layout's bottom padding keeps the last
        field clear of it.
      */}
      <div className="bg-background/95 supports-backdrop-filter:bg-background/85 fixed inset-x-0 bottom-0 z-30 border-t backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          {state.error && (
            <p className="type-caption text-destructive" role="alert">
              {state.error}
            </p>
          )}
          {!isValid && !state.error && (
            <p className="type-caption text-muted-foreground">
              Choose the required options above to add this dish.
            </p>
          )}
          {state.success && (
            <p
              className="type-label text-success motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 flex items-center justify-between gap-3"
              role="status"
            >
              <span className="flex items-center gap-1.5">
                <CircleCheck className="size-4" aria-hidden="true" />
                Added to your order
              </span>
              {/* A real button, not a text link: after adding, this is the
                  step most diners want next (2026-10-20). */}
              <Link
                href={`/r/${restaurantSlug}/cart`}
                className={buttonVariants({
                  variant: "outline",
                  className: "text-foreground h-10 gap-1.5",
                })}
              >
                <ShoppingBag className="size-4" aria-hidden="true" />
                View order
                <ChevronRight className="size-4" aria-hidden="true" />
              </Link>
            </p>
          )}
          <Button
            type="submit"
            disabled={!isValid || isPending}
            size="lg"
            className="w-full justify-between"
          >
            <span>
              {isPending
                ? "Adding…"
                : state.success
                  ? "Add another"
                  : "Add to order"}
            </span>
            <span className="type-price">{price(total)}</span>
          </Button>
        </div>
      </div>
    </form>
  );
}
