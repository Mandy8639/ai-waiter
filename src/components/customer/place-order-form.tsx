"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/dashboard/native-select";
import { submitOrder } from "@/lib/orders/submit-order";
import { submitTableGroupOrder } from "@/lib/table-groups/actions";
import { formatPickupTime, type PickupOptions } from "@/lib/pickup/format-core";

/**
 * idempotencyKey is generated once, when this component mounts (a fresh
 * cart page load), and reused for every submit attempt during that mount —
 * a double-tap or a slow-network retry before the redirect lands resends
 * the same key, which submit_order() treats as "the same order" rather
 * than creating a second one (docs/security.md#idempotency). Navigating
 * here again after a successful order (or a hard refresh) mounts a new
 * instance with a new key, which is correct: that's a new order attempt.
 *
 * At a pickup counter the form also asks when, and whose name to call.
 * Full slots stay in the list, marked, so a diner can see why their usual
 * time is missing; the database re-checks the time when the order is
 * placed, because a slot can fill while this page is open.
 *
 * With `group`, it sends the whole table's shared order instead
 * (submit_table_group_order(), 20261129090000). Groups exist only at
 * tables, so a group never has a pickup choice.
 */
export function PlaceOrderForm({
  restaurantSlug,
  disabled,
  allowCustomerNotes,
  pickup,
  group = false,
}: {
  restaurantSlug: string;
  disabled: boolean;
  allowCustomerNotes: boolean;
  pickup?: Extract<PickupOptions, { isCounter: true }>;
  group?: boolean;
}) {
  const router = useRouter();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState("");
  const [pickupAt, setPickupAt] = useState(() => {
    const chosen = pickup?.slots.find(
      (s) => s.at === pickup.chosenAt && s.placesLeft > 0,
    );
    return chosen?.at ?? pickup?.slots.find((s) => s.placesLeft > 0)?.at ?? "";
  });
  const [pickupName, setPickupName] = useState(pickup?.chosenName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const result = group
        ? await submitTableGroupOrder(idempotencyKey, note.trim() || undefined)
        : await submitOrder(
            idempotencyKey,
            note.trim() || undefined,
            pickup ? { at: pickupAt, name: pickupName.trim() } : undefined,
          );
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.orderId) {
        router.push(`/r/${restaurantSlug}/order/${result.orderId}`);
      }
    });
  }

  const noSlots = pickup !== undefined && pickup.slots.length === 0;
  const pickupIncomplete =
    pickup !== undefined && (!pickupAt || !pickupName.trim());

  return (
    <div className="flex flex-col gap-3">
      {pickup && (
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Pickup</legend>
          {noSlots ? (
            <p role="alert" className="type-body-sm text-muted-foreground">
              There are no pickup times open right now. Please ask at the
              counter.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="pickup-time" className="text-sm font-medium">
                Pickup time
              </label>
              <NativeSelect
                id="pickup-time"
                value={pickupAt}
                onChange={(e) => setPickupAt(e.target.value)}
                disabled={isPending || disabled}
                className="h-11 text-base"
              >
                {pickup.slots.map((slot) => (
                  <option
                    key={slot.at}
                    value={slot.at}
                    disabled={slot.placesLeft === 0}
                  >
                    {formatPickupTime(slot.at, pickup.timeZone)}
                    {slot.placesLeft === 0 ? " (full)" : ""}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="pickup-name" className="text-sm font-medium">
              Name for pickup
            </label>
            <Input
              id="pickup-name"
              value={pickupName}
              onChange={(e) => setPickupName(e.target.value)}
              maxLength={40}
              autoComplete="given-name"
              placeholder="We'll call this out when it's ready"
              disabled={isPending || disabled}
              className="h-11 text-base"
            />
          </div>
        </fieldset>
      )}

      {allowCustomerNotes && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="customer-note" className="text-sm font-medium">
            Note for the kitchen (optional)
          </label>
          <Textarea
            id="customer-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="e.g. Please make it less spicy."
            disabled={isPending || disabled}
          />
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={disabled || isPending || noSlots || pickupIncomplete}
        onClick={handleSubmit}
      >
        {isPending
          ? group
            ? "Sending…"
            : "Placing order…"
          : group
            ? "Send to kitchen"
            : pickup
              ? "Place pickup order"
              : "Place order"}
      </Button>
    </div>
  );
}
