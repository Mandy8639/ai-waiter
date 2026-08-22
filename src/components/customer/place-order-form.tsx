"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { submitOrder } from "@/lib/orders/submit-order";

/**
 * idempotencyKey is generated once, when this component mounts (a fresh
 * cart page load), and reused for every submit attempt during that mount —
 * a double-tap or a slow-network retry before the redirect lands resends
 * the same key, which submit_order() treats as "the same order" rather
 * than creating a second one (docs/security.md#idempotency). Navigating
 * here again after a successful order (or a hard refresh) mounts a new
 * instance with a new key, which is correct: that's a new order attempt.
 */
export function PlaceOrderForm({
  restaurantSlug,
  disabled,
  allowCustomerNotes,
}: {
  restaurantSlug: string;
  disabled: boolean;
  allowCustomerNotes: boolean;
}) {
  const router = useRouter();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const result = await submitOrder(
        idempotencyKey,
        note.trim() || undefined,
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

  return (
    <div className="flex flex-col gap-3">
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
        disabled={disabled || isPending}
        onClick={handleSubmit}
      >
        {isPending ? "Placing order…" : "Place order"}
      </Button>
    </div>
  );
}
