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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface CashState {
  error?: string;
  success?: string;
}

type Action = (state: CashState, formData: FormData) => Promise<CashState>;

const initialState: CashState = {};

/**
 * Reversing a recorded cash payment.
 *
 * The wording avoids "refund" throughout, because no money moves: reversing
 * says the cash was never actually taken. Calling it a refund would have
 * staff believe something was returned to a customer who is long gone.
 *
 * A dialog with a required sentence, rather than a one-click undo, for the
 * reason given in the migration — "unrecord this cash" is how a till gets
 * skimmed, so the correction is deliberately the part that leaves a trace.
 */
export function ReverseCashDialog({
  what = "cash",
  reverseAction,
  paymentLabel,
}: {
  /** "cash" or "the card-machine payment": what is being reversed. */
  what?: string;
  reverseAction: Action;
  /** e.g. "#12" — which payment this is, so the right row is obvious. */
  paymentLabel: string;
}) {
  const [state, submit, pending] = useActionState(reverseAction, initialState);
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button type="button" variant="outline" size="sm">
            Reverse
          </Button>
        }
      />
      <DialogContent>
        <form action={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              Reverse {what} for {paymentLabel}
            </DialogTitle>
            <DialogDescription>
              Marks this as never taken, and puts those orders back to unpaid.
              The record stays, showing that it was reversed and by whom.
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
            <Label htmlFor="reason">Why</Label>
            <Textarea
              id="reason"
              name="reason"
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
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Reversing…" : "Reverse"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
