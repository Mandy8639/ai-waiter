"use client";

import { useState, useTransition } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestPrint } from "@/lib/printing/actions";

/**
 * Sends one job to the restaurant's network printers (CloudPRNT) and says
 * how it went beside the button. The printer collects it on its next
 * check, a few seconds later.
 */
export function PrintButton({
  restaurantId,
  kind,
  orderIds,
  paymentId,
  dayCloseId,
  label,
  className,
}: {
  restaurantId: string;
  kind: "kitchen_ticket" | "bill" | "receipt" | "drawer" | "day_close";
  orderIds?: string[];
  paymentId?: string;
  dayCloseId?: string;
  label: string;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  function send() {
    setResult(null);
    startTransition(async () => {
      const r = await requestPrint({
        restaurantId,
        kind,
        orderIds,
        paymentId,
        dayCloseId,
      });
      if (!r.ok) setResult({ ok: false, text: r.error });
      else if (r.printers === 0)
        setResult({ ok: false, text: "No printer is set up for that." });
      else setResult({ ok: true, text: "Sent to the printer." });
    });
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        className={className}
        disabled={pending}
        onClick={send}
      >
        <Printer className="size-4" aria-hidden="true" />
        {pending ? "Sending…" : label}
      </Button>
      <span
        role="status"
        aria-live="polite"
        className={
          result?.ok === false
            ? "text-destructive text-xs"
            : "text-muted-foreground text-xs"
        }
      >
        {result?.text}
      </span>
    </span>
  );
}
