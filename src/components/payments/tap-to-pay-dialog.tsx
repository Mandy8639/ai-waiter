"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, Nfc } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { formatMoney } from "@/lib/orders/format";
import type { UnpaidOrder } from "@/lib/payments/unpaid-orders";
import {
  cancelTapCollection,
  collectTapPayment,
  tapToPayAvailable,
  type TapStep,
} from "./tap-to-pay-native";

const STEP_TEXT: Record<TapStep, string> = {
  preparing: "Getting the phone ready…",
  tap: "Hand the phone to the guest: they tap their card, phone or watch on the back.",
  checking: "Checking with the bank…",
};

/**
 * Tap to Pay for one table, in the staff app only: the phone itself is the
 * card reader. Shown nowhere else — in a browser `tapToPayAvailable()` is
 * false and this renders nothing. As with cash, every outstanding order
 * starts selected and the amount comes from the orders, never from here.
 */
export function TapToPayDialog({
  restaurantId,
  tableLabel,
  orders,
  currency,
  tippingEnabled,
  onPaid,
}: {
  restaurantId: string;
  tableLabel: string;
  orders: UnpaidOrder[];
  currency: string;
  tippingEnabled: boolean;
  /** Told once the bank approves: the POS screen marks its order paid. */
  onPaid?: () => void;
}) {
  const router = useRouter();
  // Known only in the browser, after mount: the server can't tell.
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAvailable(tapToPayAvailable());
  }, []);

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(orders.map((o) => o.id)),
  );
  const [tip, setTip] = useState("");
  const [step, setStep] = useState<TapStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);

  const selectedTotal = useMemo(
    () =>
      orders
        .filter((o) => selected.has(o.id))
        .reduce((sum, o) => sum + o.total, 0),
    [orders, selected],
  );
  const tipValue = Number(tip);
  const tipAmount = Number.isFinite(tipValue) && tipValue > 0 ? tipValue : 0;
  const money = (v: number) => formatMoney(v, currency);
  const busy = step !== null;

  if (!available) return null;

  async function take() {
    setError(null);
    try {
      await collectTapPayment({
        restaurantId,
        orderIds: [...selected],
        tip: tip.trim() === "" ? "0" : tip,
        onStep: setStep,
      });
      setPaid(true);
      onPaid?.();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The tap didn't go through.");
    } finally {
      setStep(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return; // finish or cancel the tap first
        if (!next) {
          setSelected(new Set(orders.map((o) => o.id)));
          setTip("");
          setError(null);
          setPaid(false);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" size="sm">
            <Nfc className="size-4" aria-hidden="true" />
            Tap to Pay
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tap to Pay for {tableLabel}</DialogTitle>
          <DialogDescription>
            This phone takes the card. The money goes to your Stripe account,
            and the table is marked paid as soon as the bank approves.
          </DialogDescription>
        </DialogHeader>

        {paid ? (
          <div role="status" className="flex flex-col items-center gap-2 py-6">
            <CircleCheck className="text-success size-10" aria-hidden="true" />
            <p className="font-medium">
              Paid {money(selectedTotal + tipAmount)}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Orders</span>
              {orders.map((order) => (
                <label
                  key={order.id}
                  className="hover:bg-muted flex cursor-pointer items-center justify-between gap-3 rounded-md border p-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Checkbox
                      checked={selected.has(order.id)}
                      onCheckedChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(order.id)) next.delete(order.id);
                          else next.add(order.id);
                          return next;
                        })
                      }
                      disabled={busy}
                    />
                    <span className="font-medium">#{order.orderNumber}</span>
                    <Badge variant="outline">{order.status}</Badge>
                  </span>
                  <span className="tabular-nums">{money(order.total)}</span>
                </label>
              ))}
            </div>
            {tippingEnabled && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="tip-tap-to-pay">Tip</Label>
                <Input
                  id="tip-tap-to-pay"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={tip}
                  onChange={(e) => setTip(e.target.value)}
                  disabled={busy}
                />
              </div>
            )}
            {step && (
              <p role="status" className="text-sm font-medium">
                {STEP_TEXT[step]}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {paid ? (
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          ) : busy ? (
            <Button
              type="button"
              variant="outline"
              disabled={step === "checking"}
              onClick={() => void cancelTapCollection()}
            >
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void take()}
              disabled={selected.size === 0}
            >
              Charge {money(selectedTotal + tipAmount)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
