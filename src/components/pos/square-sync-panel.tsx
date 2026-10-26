"use client";

import { useState, useTransition } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { resendToSquare } from "@/lib/pos/square/sync-actions";

/**
 * What hasn't reached Square's reports yet, and a button to send it.
 * Shown on Settings → Point of sale only when something is missing.
 */
export function SquareSyncPanel({
  restaurantId,
  payments,
  refunds,
}: {
  restaurantId: string;
  payments: number;
  refunds: number;
}) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  function send() {
    setResult(null);
    startTransition(async () => {
      const r = await resendToSquare(restaurantId);
      if (!r.ok) setResult({ ok: false, text: r.error });
      else if (r.failed > 0)
        setResult({
          ok: false,
          text: `Sent ${r.sent}. ${r.failed} still didn't go through; Square may be busy, so try again in a few minutes.`,
        });
      else setResult({ ok: true, text: `Sent ${r.sent} to Square.` });
    });
  }

  const parts = [
    payments > 0 ? `${payments} ${payments === 1 ? "sale" : "sales"}` : null,
    refunds > 0 ? `${refunds} ${refunds === 1 ? "refund" : "refunds"}` : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-3 text-sm">
      {result && (
        <Alert variant={result.ok ? "default" : "destructive"}>
          <AlertDescription>{result.text}</AlertDescription>
        </Alert>
      )}
      <p>
        {parts.join(" and ")} taken at the table{" "}
        {payments + refunds === 1 ? "hasn't" : "haven't"} reached Square&apos;s
        reports yet, usually because Square couldn&apos;t be reached at the
        time.
      </p>
      <Button
        type="button"
        className="self-start"
        onClick={send}
        disabled={pending}
      >
        {pending ? "Sending…" : "Send to Square now"}
      </Button>
    </div>
  );
}
