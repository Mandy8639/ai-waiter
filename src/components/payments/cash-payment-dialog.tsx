"use client";

import { useActionState, useMemo, useState } from "react";
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
import type { InPersonMethod } from "@/lib/payments/method";
import type { UnpaidOrder } from "@/lib/payments/unpaid-orders";

interface CashState {
  error?: string;
  success?: string;
}

type Action = (state: CashState, formData: FormData) => Promise<CashState>;

const initialState: CashState = {};

const COPY: Record<
  InPersonMethod,
  { trigger: string; title: string; description: string; tip: string }
> = {
  cash: {
    trigger: "Take cash",
    title: "Cash for",
    description:
      "Records money already taken at the table. Nothing is charged to a card.",
    tip: "Tip",
  },
  card_terminal: {
    trigger: "Paid by card machine",
    title: "Card machine for",
    description:
      "Records a payment already taken on your own card machine at the register. Nothing is charged here.",
    tip: "Tip (as entered on the machine)",
  },
};

/**
 * Recording money taken in person for one table: cash, or the
 * restaurant's own card machine at the register (`method`). Both are
 * records rather than charges, so the dialog is the same and only its
 * words change.
 *
 * Every outstanding order for the table starts selected, because settling
 * the whole table is what usually happens and the alternative — starting
 * with nothing ticked — makes the common case the most work. Unticking is
 * for the split-the-bill case.
 *
 * The total is computed from the selected orders and shown before
 * submitting, but it is display only: record_cash_payment() sums the
 * amount from the orders themselves and ignores anything this form might
 * claim. That is deliberate — the one number staff can get wrong here
 * should not be a number they can type.
 */
export function CashPaymentDialog({
  method = "cash",
  recordAction,
  tableLabel,
  orders,
  currency,
  tippingEnabled,
}: {
  method?: InPersonMethod;
  recordAction: Action;
  tableLabel: string;
  orders: UnpaidOrder[];
  currency: string;
  tippingEnabled: boolean;
}) {
  const [state, submit, pending] = useActionState(recordAction, initialState);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(orders.map((o) => o.id)),
  );
  const [tip, setTip] = useState("");

  const selectedTotal = useMemo(
    () =>
      orders
        .filter((o) => selected.has(o.id))
        .reduce((sum, o) => sum + o.total, 0),
    [orders, selected],
  );

  // A half-typed tip ("4.") should not blank the total out, so anything
  // unparseable counts as nothing rather than as NaN.
  const tipValue = Number(tip);
  const tipAmount = Number.isFinite(tipValue) && tipValue > 0 ? tipValue : 0;

  function toggle(orderId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  const money = (value: number) => formatMoney(value, currency);
  const copy = COPY[method];
  const tipId = `tip-${method}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reopening after a part-payment should reflect what is still
        // outstanding, not whatever was ticked last time.
        if (!next) {
          setSelected(new Set(orders.map((o) => o.id)));
          setTip("");
        }
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant={method === "cash" ? "default" : "outline"}
          >
            {copy.trigger}
          </Button>
        }
      />
      <DialogContent>
        <form action={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {copy.title} {tableLabel}
            </DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
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
            <span className="text-sm font-medium">Orders</span>
            {orders.map((order) => (
              <label
                key={order.id}
                className="hover:bg-muted flex cursor-pointer items-center justify-between gap-3 rounded-md border p-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <Checkbox
                    checked={selected.has(order.id)}
                    onCheckedChange={() => toggle(order.id)}
                    disabled={pending}
                  />
                  <span className="font-medium">#{order.orderNumber}</span>
                  <Badge variant="outline">{order.status}</Badge>
                </span>
                <span className="tabular-nums">{money(order.total)}</span>
              </label>
            ))}
            {/* The checkboxes above are Base UI components rather than
                native inputs, so the selection is posted explicitly. */}
            {[...selected].map((id) => (
              <input key={id} type="hidden" name="orderIds" value={id} />
            ))}
          </div>

          {tippingEnabled && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={tipId}>{copy.tip}</Label>
              <Input
                id={tipId}
                name="tip"
                inputMode="decimal"
                placeholder="0.00"
                value={tip}
                onChange={(e) => setTip(e.target.value)}
                disabled={pending}
              />
            </div>
          )}

          <div className="flex items-center justify-between border-t pt-3 text-sm">
            <span className="font-medium">Total</span>
            <span className="text-lg font-semibold tabular-nums">
              {money(selectedTotal + tipAmount)}
            </span>
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
            <Button type="submit" disabled={pending || selected.size === 0}>
              {pending
                ? "Recording…"
                : `Record ${money(selectedTotal + tipAmount)}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
