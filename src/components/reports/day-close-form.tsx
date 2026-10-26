"use client";

import { useState, useTransition } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney } from "@/lib/orders/format";
import {
  expectedCash,
  overShortLabel,
  parseCash,
  type DayCloseSummary,
} from "@/lib/reports/day-close-core";
import { closeDay } from "@/lib/reports/day-close-actions";

/**
 * Counting the drawer and closing the day. What the drawer should hold is
 * shown as the cash is typed in, so a difference is seen before it's
 * recorded; close_day() works it out again from the database.
 */
export function DayCloseForm({
  restaurantId,
  summary,
  lastFloat,
}: {
  restaurantId: string;
  summary: DayCloseSummary;
  /** Yesterday's float, the usual starting cash. */
  lastFloat: number | null;
}) {
  const money = (v: number) => formatMoney(v, summary.currency);
  const [float, setFloat] = useState(
    lastFloat !== null ? lastFloat.toFixed(2) : "",
  );
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const floatValue = parseCash(float || "0");
  const countedValue = parseCash(counted);
  const expected =
    floatValue === null ? null : expectedCash(floatValue, summary);
  const diff =
    expected !== null && countedValue !== null ? countedValue - expected : null;

  function close() {
    setError(null);
    startTransition(async () => {
      const result = await closeDay(restaurantId, {
        openingFloat: float,
        countedCash: counted,
        note,
      });
      setConfirming(false);
      if (!result.ok) setError(result.error);
      else {
        setCounted("");
        setNote("");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="close-float">Starting cash (float)</Label>
          <Input
            id="close-float"
            inputMode="decimal"
            placeholder="0.00"
            value={float}
            onChange={(e) => setFloat(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="close-counted">Cash counted in the drawer</Label>
          <Input
            id="close-counted"
            inputMode="decimal"
            placeholder="0.00"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
          />
        </div>
      </div>

      <dl className="flex flex-col gap-1 text-sm tabular-nums">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Cash taken</dt>
          <dd>{money(summary.cash.taken)}</dd>
        </div>
        {summary.cash.refunded > 0 && (
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Cash refunded</dt>
            <dd>-{money(summary.cash.refunded)}</dd>
          </div>
        )}
        <div className="flex justify-between font-medium">
          <dt>Should be in the drawer</dt>
          <dd>{expected === null ? "—" : money(expected)}</dd>
        </div>
        {diff !== null && (
          <div
            role="status"
            className={
              Math.round(diff * 100) === 0
                ? "flex justify-between font-medium"
                : "text-destructive flex justify-between font-medium"
            }
          >
            <dt>Difference</dt>
            <dd>{overShortLabel(diff, money)}</dd>
          </div>
        )}
      </dl>

      <div className="flex flex-col gap-1">
        <Label htmlFor="close-note">Note (optional)</Label>
        <Textarea
          id="close-note"
          rows={2}
          maxLength={500}
          placeholder="Anything to explain, like a difference in the drawer"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">
            Close the day? This can&apos;t be undone.
          </span>
          <Button type="button" onClick={close} disabled={pending}>
            {pending ? "Closing…" : "Yes, close the day"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirming(false)}
            disabled={pending}
          >
            Not yet
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          className="self-start"
          disabled={countedValue === null || floatValue === null}
          onClick={() => setConfirming(true)}
        >
          Close the day
        </Button>
      )}
    </div>
  );
}
