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
 * Settling every unpaid order in one go.
 *
 * The same rules as the single-order panel — the tip is chosen here and
 * trusted nowhere, and the amount comes from the database — with one
 * addition: the tip defaults to whatever a payment already in flight
 * carries. start_tab_payment() reuses an open payment only when the tip
 * matches, so a diner who abandoned Stripe, came back and nudged the tip
 * would otherwise be told a payment is already open with a different tip,
 * for changing a number this page invited them to change.
 */
export function PayTabPanel({
  unpaidCount,
  unpaidTotal,
  currency,
  tippingEnabled,
  pendingTip,
  payAction,
}: {
  unpaidCount: number;
  unpaidTotal: number;
  currency: string;
  tippingEnabled: boolean;
  pendingTip: number | null;
  payAction: Action;
}) {
  const [state, pay, paying] = useActionState(payAction, initialState);
  const [tip, setTip] = useState(
    pendingTip !== null ? pendingTip.toFixed(2) : "0",
  );

  const format = (value: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      value,
    );

  const tipNumber = Number(tip);
  const tipIsValid = /^\d+(\.\d{1,2})?$/.test(tip || "0");
  const total = tipIsValid ? unpaidTotal + (tipNumber || 0) : unpaidTotal;

  return (
    <form action={pay} className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Pay for everything</h2>
        {pendingTip !== null && <Badge variant="outline">Not paid yet</Badge>}
      </div>

      <p className="text-muted-foreground text-sm">
        {unpaidCount} orders, {format(unpaidTotal)} in total.
      </p>

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {tippingEnabled && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="tab-tip">Add a tip (optional)</Label>
          <div className="flex flex-wrap gap-2">
            {TIP_PERCENTAGES.map((pct) => {
              // Percentages only fill the box; the figure sent is the
              // resulting amount, so what the diner sees is what is
              // charged.
              const value = ((unpaidTotal * pct) / 100).toFixed(2);
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
            id="tab-tip"
            name="tip"
            inputMode="decimal"
            value={tip}
            onChange={(e) => setTip(e.target.value)}
            aria-describedby="tab-tip-hint"
          />
          <p id="tab-tip-hint" className="text-muted-foreground text-sm">
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
        You&apos;ll be taken to a secure checkout page to pay (Stripe or Square,
        depending on the restaurant). Your card details never reach this site.
      </p>
    </form>
  );
}
