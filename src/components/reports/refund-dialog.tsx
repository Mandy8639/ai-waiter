"use client";

import { useActionState, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/dashboard/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  REFUND_CATEGORIES,
  REFUND_CATEGORY_LABELS,
} from "@/lib/payments/refund-reason";

interface RefundState {
  error?: string;
  success?: string;
}

type Action = (state: RefundState, formData: FormData) => Promise<RefundState>;

const initialState: RefundState = {};

/**
 * Refunding one payment.
 *
 * Deliberately a dialog rather than an inline button: refunding moves real
 * money outward and cannot be undone, so it should take a decision and a
 * sentence, not a stray click in a table row.
 *
 * Nothing here is trusted. The amount, the category and the note are all
 * re-validated server-side, and the database independently enforces
 * owner/manager access and the "never more than was charged" limit — this
 * component only decides what to *show*.
 */
export function RefundDialog({
  refundAction,
  paymentLabel,
  refundableAmount,
  currency,
  method = "card",
}: {
  refundAction: Action;
  /** e.g. "#12" — what the payment settled, so the right one is obvious. */
  paymentLabel: string;
  /** What is left to refund, after anything already returned. */
  refundableAmount: string;
  currency: string;
  /** How it was paid: a card refund moves money; cash and a card machine are refunded by the restaurant and recorded here. */
  method?: "card" | "cash" | "card_terminal";
}) {
  const [state, submit, pending] = useActionState(refundAction, initialState);
  const [open, setOpen] = useState(false);

  const format = (value: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      value,
    );

  const remaining = Number(refundableAmount);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm">
            Refund
          </Button>
        }
      />
      <DialogContent>
        <form action={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Refund {paymentLabel}</DialogTitle>
            <DialogDescription>
              {format(remaining)} can still be refunded.{" "}
              {method === "cash"
                ? "Hand the cash back to the guest and record it here, so the day's takings match. This cannot be undone."
                : method === "card_terminal"
                  ? "Refund it on your card machine first, then record it here so the day's takings match. This cannot be undone."
                  : "The money goes back to the card it came from, and this cannot be undone."}
            </DialogDescription>
          </DialogHeader>

          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {state.success && (
            <Alert>
              <AlertDescription>{state.success}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="amount">Amount</Label>
            <Input
              id="amount"
              name="amount"
              inputMode="decimal"
              placeholder={remaining.toFixed(2)}
              disabled={pending}
            />
            <p className="text-muted-foreground text-sm">
              Leave blank to refund the full {format(remaining)}.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="category">Why</Label>
            {/* Stripe accepts only these three values and rejects anything
                else, so it is a fixed list rather than free text. */}
            <NativeSelect id="category" name="category" disabled={pending}>
              {REFUND_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {REFUND_CATEGORY_LABELS[c]}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="note">Note</Label>
            <Textarea
              id="note"
              name="note"
              rows={2}
              placeholder="What happened — for whoever asks in a month."
              disabled={pending}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Refunding…" : "Refund"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
