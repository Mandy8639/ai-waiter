"use client";

import { useActionState, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SplitActionState } from "@/lib/payments/split-actions";
import { SPLIT_MAX_SHARES, SPLIT_MIN_SHARES } from "@/lib/payments/split";

const initial: SplitActionState = {};

type Action = (
  state: SplitActionState,
  formData: FormData,
) => Promise<SplitActionState>;

/**
 * Starting a split, from the tab (phase J): equally between N people, or
 * each paying for their own dishes. Everyone then pays on their own phone.
 */
export function SplitBillStart({ createAction }: { createAction: Action }) {
  const [state, submit, pending] = useActionState(createAction, initial);
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState(2);

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Split the bill
      </Button>
    );
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">Split the bill</h2>
        <p className="text-muted-foreground text-sm">
          Everyone pays their part on their own phone, with their own card,
          Apple Pay or Google Pay.
        </p>
      </div>

      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <form action={submit} className="flex flex-col gap-3">
        <input type="hidden" name="mode" value="equal" />
        <input type="hidden" name="shares" value={shares} />
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Split equally between</span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Fewer people"
              disabled={shares <= SPLIT_MIN_SHARES}
              onClick={() =>
                setShares((n) => Math.max(SPLIT_MIN_SHARES, n - 1))
              }
            >
              <Minus className="size-4" aria-hidden="true" />
            </Button>
            <span
              className="w-16 text-center text-sm tabular-nums"
              aria-live="polite"
            >
              {shares} people
            </span>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="More people"
              disabled={shares >= SPLIT_MAX_SHARES}
              onClick={() =>
                setShares((n) => Math.min(SPLIT_MAX_SHARES, n + 1))
              }
            >
              <Plus className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Splitting…" : `Split ${shares} ways`}
        </Button>
      </form>

      <form action={submit}>
        <input type="hidden" name="mode" value="by_dish" />
        <Button
          type="submit"
          variant="outline"
          className="w-full"
          disabled={pending}
        >
          Each pays for what they had
        </Button>
      </form>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(false)}
      >
        Not now
      </Button>
    </section>
  );
}
