"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Share2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cancelSplit,
  leaveSplitCheckout,
  startSplitCheckout,
  type SplitActionState,
} from "@/lib/payments/split-actions";
import {
  chosenAmount,
  progressLabel,
  remainingAmount,
  type SplitView,
} from "@/lib/payments/split";
import { cn } from "@/lib/utils";

const initial: SplitActionState = {};
const TIP_PERCENTAGES = [0, 10, 15, 20] as const;
/** How often an open split re-reads itself, so a phone sees others' payments land. */
const REFRESH_MS = 5_000;

/**
 * A split bill, as everyone at the table sees it (phase J). Each person
 * picks what they're paying for and pays on their own phone — so with their
 * own Apple Pay or Google Pay. The person who split the bill also sees the
 * link and QR code to share, and can cancel before anyone pays.
 */
export function SplitBillPanel({
  view,
  token,
  shareUrl,
  qrDataUrl,
  leftPaymentId,
  justPaid,
}: {
  view: SplitView;
  token: string;
  shareUrl: string;
  /** Only for the person who split the bill. */
  qrDataUrl: string | null;
  /** Set when a payer came back from Checkout without paying. */
  leftPaymentId: string | null;
  justPaid: boolean;
}) {
  const router = useRouter();
  const [state, pay, paying] = useActionState(
    startSplitCheckout.bind(null, token),
    initial,
  );
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [tip, setTip] = useState("0");
  const [copied, setCopied] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Came back without paying: have Stripe close that Checkout so the parts
  // go back to the table now rather than in half an hour.
  useEffect(() => {
    if (leftPaymentId) void leaveSplitCheckout(token, leftPaymentId);
  }, [leftPaymentId, token]);

  // Others at the table are paying too; keep this phone current.
  useEffect(() => {
    if (view.status !== "open") return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [view.status, router]);

  const format = (value: string | number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: view.currency,
    }).format(Number(value));

  // A part someone else claimed since it was chosen drops out.
  const openChosen = useMemo(
    () =>
      new Set(
        [...chosen].filter(
          (id) => view.parts.find((p) => p.id === id)?.status === "open",
        ),
      ),
    [chosen, view.parts],
  );
  const amount = chosenAmount(view.parts, openChosen, view.currency);
  const tipIsValid = /^\d+(\.\d{1,2})?$/.test(tip || "0");
  const totalToPay = Number(amount) + (tipIsValid ? Number(tip || 0) : 0);

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function share() {
    try {
      if (navigator.share) {
        await navigator.share({
          title: `Split bill at ${view.restaurantName}`,
          url: shareUrl,
        });
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The person closed the share sheet; nothing to do.
    }
  }

  const nobodyStarted = view.parts.every((p) => p.status === "open");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Split bill</h1>
        <p className="text-muted-foreground text-sm">
          {view.restaurantName} · order
          {view.orderNumbers.length > 1 ? "s" : ""} #
          {view.orderNumbers.join(", #")} · {format(view.total)} in total
        </p>
      </div>

      {justPaid && view.status === "open" && (
        <Alert>
          <AlertDescription>
            Thanks, your payment went through. It can take a moment to show
            below.
          </AlertDescription>
        </Alert>
      )}
      {leftPaymentId && view.status === "open" && (
        <Alert>
          <AlertDescription>
            That payment was cancelled. Nothing was charged, and what you chose
            is free for anyone to pay again.
          </AlertDescription>
        </Alert>
      )}

      {view.status === "paid" && (
        <Alert>
          <AlertDescription>
            The whole bill is paid. Thank you!
          </AlertDescription>
        </Alert>
      )}
      {view.status === "cancelled" && (
        <Alert variant="destructive">
          <AlertDescription>
            This split was cancelled. The bill can be paid from the table&apos;s
            orders page.
          </AlertDescription>
        </Alert>
      )}

      {view.status === "open" && (
        <p className="text-sm font-medium">
          {progressLabel(view)} · {format(remainingAmount(view))} left to pay
        </p>
      )}

      {view.status === "open" && view.isOwner && (
        <section className="flex flex-col gap-3 rounded-lg border p-4">
          <h2 className="font-medium">Share with the table</h2>
          <p className="text-muted-foreground text-sm">
            Everyone opens this link or scans the code on their own phone and
            pays for their part, with their own card, Apple Pay or Google Pay.
          </p>
          {qrDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- a data: URL generated on the server
            <img
              src={qrDataUrl}
              alt="QR code for this split bill"
              width={192}
              height={192}
              className="self-center rounded-md border"
            />
          )}
          <Button type="button" variant="outline" onClick={share}>
            {copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Share2 className="size-4" aria-hidden="true" />
            )}
            {copied ? "Link copied" : "Share the link"}
          </Button>
          {nobodyStarted && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await cancelSplit(view.restaurantSlug);
                if (result?.error) setCancelError(result.error);
              }}
            >
              Cancel the split
            </Button>
          )}
          {cancelError && (
            <p className="text-destructive text-sm">{cancelError}</p>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">
          {view.mode === "equal" ? "Shares" : "What was ordered"}
        </h2>
        <ul className="flex flex-col gap-2">
          {view.parts.map((part) => {
            const selectable = view.status === "open" && part.status === "open";
            const selected = openChosen.has(part.id);
            return (
              <li key={part.id}>
                <label
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-md border px-3 py-3 text-sm",
                    selectable ? "cursor-pointer" : "opacity-60",
                    selected && "border-primary bg-primary/5",
                  )}
                >
                  <span className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      className="size-4"
                      disabled={!selectable}
                      checked={selected}
                      onChange={() => toggle(part.id)}
                    />
                    <span className="font-medium">{part.label}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {part.status === "paid" && (
                      <Badge variant="secondary">Paid</Badge>
                    )}
                    {part.status === "pending" && (
                      <Badge variant="outline">Being paid</Badge>
                    )}
                    <span className="tabular-nums">{format(part.amount)}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {view.mode === "by_dish" && (
          <p className="text-muted-foreground text-xs">
            Each dish includes its share of tax and service charge.
          </p>
        )}
      </section>

      {view.status === "open" && (
        <form
          action={pay}
          className="flex flex-col gap-4 rounded-lg border p-4"
        >
          {[...openChosen].map((id) => (
            <input key={id} type="hidden" name="part" value={id} />
          ))}

          {state.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}

          {view.tippingEnabled ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="split-tip">Add a tip (optional)</Label>
              <div className="flex flex-wrap gap-2">
                {TIP_PERCENTAGES.map((pct) => {
                  const value = ((Number(amount) * pct) / 100).toFixed(2);
                  return (
                    <Button
                      key={pct}
                      type="button"
                      size="sm"
                      variant={tip === value ? "secondary" : "outline"}
                      disabled={openChosen.size === 0}
                      onClick={() => setTip(value)}
                    >
                      {pct === 0 ? "No tip" : `${pct}%`}
                    </Button>
                  );
                })}
              </div>
              <Input
                id="split-tip"
                name="tip"
                inputMode="decimal"
                value={tip}
                onChange={(e) => setTip(e.target.value)}
              />
              {!tipIsValid && (
                <p className="text-destructive text-sm">
                  Enter a tip like 4 or 4.50.
                </p>
              )}
            </div>
          ) : (
            <input type="hidden" name="tip" value="0" />
          )}

          <Button
            type="submit"
            disabled={paying || openChosen.size === 0 || !tipIsValid}
          >
            {paying
              ? "Opening Stripe…"
              : openChosen.size === 0
                ? "Choose what you're paying for"
                : `Pay ${format(totalToPay)}`}
          </Button>
          <p className="text-muted-foreground text-sm">
            You&apos;ll pay on Stripe, with a card, Apple Pay or Google Pay.
            Your card details never reach this site.
          </p>
        </form>
      )}
    </div>
  );
}
