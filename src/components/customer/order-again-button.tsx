"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { reorderToCart, type ReorderResult } from "@/lib/cart/reorder-actions";

/**
 * "Order another round": the last order back in the cart at today's
 * prices, for the diner to check and send. What couldn't be added (sold
 * out, off the menu right now) is named rather than silently dropped.
 */
export function OrderAgainButton({
  orderId,
  orderNumber,
  restaurantSlug,
}: {
  orderId: string;
  orderNumber: number;
  restaurantSlug: string;
}) {
  const [result, setResult] = useState<ReorderResult | null>(null);
  const [pending, start] = useTransition();

  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Another round?</h2>
          <p className="text-muted-foreground text-sm">
            Puts order #{orderNumber} back in your order to check and send.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => setResult(await reorderToCart(orderId)))
          }
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          {pending ? "Adding…" : "Order again"}
        </Button>
      </div>

      {result && (
        <div role="status" className="flex flex-col gap-2">
          {result.error && (
            <Alert variant="destructive">
              <AlertDescription>{result.error}</AlertDescription>
            </Alert>
          )}
          {result.notAdded && (
            <Alert>
              <AlertDescription>{result.notAdded}</AlertDescription>
            </Alert>
          )}
          {result.added && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{result.added}</span>
              <Link
                href={`/r/${restaurantSlug}/cart`}
                className={buttonVariants({ size: "sm" })}
              >
                Review and send
              </Link>
            </div>
          )}
          {!result.error && !result.added && (
            <p className="text-muted-foreground text-sm">
              Nothing from that order can be added right now.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
