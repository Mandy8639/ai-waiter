"use client";

import { useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CheckoutState {
  error?: string;
}

type Action = (
  state: CheckoutState,
  formData: FormData,
) => Promise<CheckoutState>;

const initialState: CheckoutState = {};

/** Conventional presets; a diner can always type an exact figure instead. */
const TIP_PERCENTAGES = [0, 10, 12.5, 15] as const;

/**
 * Pay for an order by card.
 *
 * The tip is chosen here but never trusted here: the server action
 * re-validates it, and the amount being charged is read from the order in
 * the database, not sent from this component. Nothing on this page can
 * change what the meal costs.
 */
export function PayOrderPanel({
  orderTotal,
  currency,
  tippingEnabled,
  hasFailedAttempt,
  payAction,
}: {
  orderTotal: number;
  currency: string;
  tippingEnabled: boolean;
  hasFailedAttempt: boolean;
  payAction: Action;
}) {
  const [state, pay, paying] = useActionState(payAction, initialState);
  const [tip, setTip] = useState("0");

  const format = (value: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      value,
    );

  const tipNumber = Number(tip);
  const tipIsValid = /^\d+(\.\d{1,2})?$/.test(tip || "0");
  const total = tipIsValid ? orderTotal + (tipNumber || 0) : orderTotal;

  return (
    <form action={pay} className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Pay for your order</h2>
        {hasFailedAttempt && <Badge variant="outline">Not paid yet</Badge>}
      </div>

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {tippingEnabled && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="tip">Add a tip (optional)</Label>
          <div className="flex flex-wrap gap-2">
            {TIP_PERCENTAGES.map((pct) => {
              // Percentages are a convenience for filling the box; the
              // amount sent is always the resulting figure, so what the
              // diner sees is exactly what is charged.
              const value = ((orderTotal * pct) / 100).toFixed(2);
              return (
                <Button
                  key={pct}
                  type="button"
                  variant={tip === value ? "secondary" : "outline"}
                  size="sm"
                  onClick={() => setTip(value)}
                >
                  {pct === 0 ? "No tip" : `${pct}%`}
                </Button>
              );
            })}
          </div>
          <Input
            id="tip"
            name="tip"
            inputMode="decimal"
            value={tip}
            onChange={(e) => setTip(e.target.value)}
            aria-describedby="tip-hint"
          />
          <p id="tip-hint" className="text-muted-foreground text-sm">
            {tipIsValid
              ? `You'll pay ${format(total)} in total.`
              : "Enter a tip like 4 or 4.50."}
          </p>
        </div>
      )}

      {!tippingEnabled && <input type="hidden" name="tip" value="0" />}

      <Button type="submit" disabled={paying || !tipIsValid}>
        {paying ? "Opening Stripe…" : `Pay ${format(total)}`}
      </Button>

      <p className="text-muted-foreground text-sm">
        You&apos;ll be taken to Stripe to pay. Your card details never reach
        this site.
      </p>
    </form>
  );
}
