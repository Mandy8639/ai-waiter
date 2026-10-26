"use client";

import { useState, useTransition } from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PrintButton } from "@/components/printing/print-button";
import { emailReceipt } from "@/lib/payments/receipt-actions";

/**
 * A guest's receipt after they've paid: printed again on the receipt
 * printer, or emailed to them. On Settle up's "Paid recently" and on
 * Reports.
 */
export function ReceiptActions({
  restaurantId,
  paymentId,
  canPrint,
}: {
  restaurantId: string;
  paymentId: string;
  /** A receipt printer is set up. */
  canPrint: boolean;
}) {
  const [emailing, setEmailing] = useState(false);
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  function send() {
    setResult(null);
    startTransition(async () => {
      const r = await emailReceipt(restaurantId, paymentId, address);
      if (r.ok) {
        setResult({ ok: true, text: `Sent to ${address.trim()}.` });
        setEmailing(false);
        setAddress("");
      } else setResult({ ok: false, text: r.error });
    });
  }

  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      {canPrint && (
        <PrintButton
          restaurantId={restaurantId}
          kind="receipt"
          paymentId={paymentId}
          label="Print receipt"
          className="h-7 px-2.5 text-[0.8rem]"
        />
      )}
      {emailing ? (
        <span className="flex items-center gap-1">
          <Input
            type="email"
            aria-label="Guest's email"
            placeholder="guest@example.com"
            className="h-7 w-48"
            value={address}
            autoFocus
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
          />
          <Button type="button" size="sm" onClick={send} disabled={pending}>
            {pending ? "Sending…" : "Send"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEmailing(false)}
            disabled={pending}
          >
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setResult(null);
            setEmailing(true);
          }}
        >
          <Mail className="size-3.5" aria-hidden="true" />
          Email receipt
        </Button>
      )}
      {result && (
        <span
          role="status"
          className={
            result.ok
              ? "text-muted-foreground text-xs"
              : "text-destructive text-xs"
          }
        >
          {result.text}
        </span>
      )}
    </span>
  );
}
