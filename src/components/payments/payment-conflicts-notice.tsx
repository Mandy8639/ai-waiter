"use client";

import { useState, useTransition } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/orders/format";
import { acknowledgePaymentConflict } from "@/lib/payments/payment-conflict-actions";
import type { PaymentConflict } from "@/lib/payments/payment-conflicts";

/**
 * Guests who paid on their phone for a bill that was already settled
 * (20261120090000). Tableside refunds them by itself; this says so, or
 * says what to do when the refund didn't go through. Stays until an owner
 * or manager closes it, so whoever took the cash hears about it too.
 */
export function PaymentConflictsNotice({
  conflicts,
  canClose,
}: {
  conflicts: PaymentConflict[];
  canClose: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (conflicts.length === 0) return null;

  function close(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await acknowledgePaymentConflict(id);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {conflicts.map((c) => {
        const orders =
          c.orderNumbers.length > 0
            ? c.orderNumbers.map((n) => `#${n}`).join(", ")
            : "a bill";
        const money = formatMoney(c.amount, c.currency);
        const where = c.provider === "square" ? "Square" : "Stripe";
        return (
          <Alert
            key={c.id}
            variant={c.refundStatus === "failed" ? "destructive" : "default"}
          >
            <AlertTitle>A guest paid twice for {orders}</AlertTitle>
            <AlertDescription>
              <p>
                They paid {money} on their phone after the bill was already
                settled.{" "}
                {c.refundStatus === "refunded"
                  ? "Tableside refunded it to their card. There's nothing to do."
                  : c.refundStatus === "failed"
                    ? `The automatic refund didn't go through: refund ${money} to the guest in your ${where} dashboard.`
                    : "Tableside is refunding it to their card."}
              </p>
              {canClose && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={pending}
                  onClick={() => close(c.id)}
                >
                  Got it
                </Button>
              )}
            </AlertDescription>
          </Alert>
        );
      })}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
