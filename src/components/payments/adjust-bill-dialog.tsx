"use client";

import { useState, useTransition } from "react";
import { Percent, Undo2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/dashboard/native-select";
import { formatMoney } from "@/lib/orders/format";
import {
  ADJUSTMENT_LABELS,
  ADJUSTMENT_REASONS,
  OTHER_REASON,
  chosenReason,
  parsePositive,
  type AdjustmentKind,
} from "@/lib/payments/adjustment-core";
import {
  adjustOrder,
  removeAdjustment,
} from "@/lib/payments/adjustment-actions";
import type { BillItem, BillOrder } from "@/lib/payments/unpaid-orders";

type Editing =
  | { kind: "void" | "comp"; orderId: string; item: BillItem; left: number }
  | { kind: "discount"; orderId: string; writeOff: boolean };

/**
 * Settle up → Adjust, for owners and managers: void or comp dishes, take
 * money off an order, or write it off, each with a reason, and undo any of
 * them until the table pays. The database (adjust_order()) re-checks the
 * role and refuses an order a payment has started on; the new totals reach
 * every way of paying from there.
 */
export function AdjustBillDialog({
  restaurantId,
  tableLabel,
  orders,
  currency,
}: {
  restaurantId: string;
  tableLabel: string;
  orders: BillOrder[];
  currency: string;
}) {
  const money = (v: number) => formatMoney(v, currency);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [reasonPick, setReasonPick] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [mode, setMode] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function start(next: Editing) {
    setEditing(next);
    setQuantity(1);
    setError(null);
    setReasonText("");
    if (next.kind === "discount" && next.writeOff) {
      setMode("percent");
      setValue("100");
      setReasonPick("Walked out");
    } else {
      setValue("");
      setReasonPick(ADJUSTMENT_REASONS[next.kind][0]);
    }
  }

  function apply() {
    if (!editing) return;
    const reason = chosenReason(reasonPick, reasonText);
    if (!reason) {
      setError("Say what the reason is.");
      return;
    }
    let request: Parameters<typeof adjustOrder>[0];
    if (editing.kind === "discount") {
      const n = parsePositive(value);
      if (n === null || (mode === "percent" && n > 100)) {
        setError(
          mode === "percent"
            ? "Enter a percentage between 1 and 100."
            : "Enter an amount above zero.",
        );
        return;
      }
      request = {
        kind: "discount",
        restaurantId,
        orderId: editing.orderId,
        percent: mode === "percent" ? n : null,
        amount: mode === "amount" ? n : null,
        reason,
      };
    } else {
      request = {
        kind: editing.kind,
        restaurantId,
        orderId: editing.orderId,
        itemId: editing.item.id,
        quantity,
        reason,
      };
    }
    setError(null);
    startTransition(async () => {
      const result = await adjustOrder(request);
      if (result.ok) setEditing(null);
      else setError(result.error);
    });
  }

  function undo(adjustmentId: string) {
    setError(null);
    startTransition(async () => {
      const result = await removeAdjustment(restaurantId, adjustmentId);
      if (!result.ok) setError(result.error);
    });
  }

  function form(order: BillOrder) {
    if (!editing || editing.orderId !== order.id) return null;
    const kind: AdjustmentKind = editing.kind;
    const reasons = ADJUSTMENT_REASONS[kind];
    const title =
      editing.kind === "discount"
        ? editing.writeOff
          ? `Write off #${order.orderNumber}`
          : `Discount #${order.orderNumber}`
        : `${editing.kind === "void" ? "Void" : "Comp"} ${editing.item.name}`;
    return (
      <div className="bg-muted/50 flex flex-col gap-3 rounded-md border p-3">
        <p className="text-sm font-medium">{title}</p>
        {editing.kind !== "discount" && editing.left > 1 && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="adjust-qty">How many</Label>
            <NativeSelect
              id="adjust-qty"
              value={String(quantity)}
              onChange={(e) => setQuantity(Number(e.target.value))}
            >
              {Array.from({ length: editing.left }, (_, i) => i + 1).map(
                (n) => (
                  <option key={n} value={n}>
                    {n} — {money(editing.item.unitAmount * n)}
                  </option>
                ),
              )}
            </NativeSelect>
          </div>
        )}
        {editing.kind === "discount" && !editing.writeOff && (
          <div className="flex gap-2">
            <div className="flex w-32 flex-col gap-1">
              <Label htmlFor="adjust-mode">Take off</Label>
              <NativeSelect
                id="adjust-mode"
                value={mode}
                onChange={(e) =>
                  setMode(e.target.value === "amount" ? "amount" : "percent")
                }
              >
                <option value="percent">Percent</option>
                <option value="amount">Amount</option>
              </NativeSelect>
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label htmlFor="adjust-value">
                {mode === "percent" ? "Percent off" : "Amount off"}
              </Label>
              <Input
                id="adjust-value"
                inputMode="decimal"
                value={value}
                placeholder={mode === "percent" ? "10" : "5.00"}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="adjust-reason">Reason</Label>
          <NativeSelect
            id="adjust-reason"
            value={reasonPick}
            onChange={(e) => setReasonPick(e.target.value)}
          >
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </NativeSelect>
          {reasonPick === OTHER_REASON && (
            <Input
              aria-label="Reason"
              value={reasonText}
              maxLength={200}
              placeholder="What happened"
              onChange={(e) => setReasonText(e.target.value)}
            />
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={apply} disabled={pending}>
            {pending ? "Saving…" : "Apply"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEditing(null)}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setEditing(null);
          setError(null);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" size="sm" variant="outline">
            <Percent className="size-4" aria-hidden="true" />
            Adjust
          </Button>
        }
      />
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Adjust the bill for {tableLabel}</DialogTitle>
          <DialogDescription>
            Void a dish rung in by mistake, comp one the house is paying for, or
            take money off an order. Every change keeps its reason and can be
            undone until the table pays.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-5">
          {orders.map((order) => (
            <section key={order.id} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">
                  Order #{order.orderNumber}
                </h3>
                <span className="text-sm tabular-nums">
                  {order.discountTotal > 0 && (
                    <span className="text-muted-foreground mr-2">
                      {money(order.discountTotal)} off
                    </span>
                  )}
                  <span className="font-medium">{money(order.total)}</span>
                </span>
              </div>

              <ul className="flex flex-col divide-y rounded-md border text-sm">
                {order.items.map((item) => {
                  const left = item.quantity - item.voided - item.comped;
                  return (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-2 p-2"
                    >
                      <span className="flex flex-col">
                        <span className={left === 0 ? "line-through" : ""}>
                          {item.quantity}× {item.name}
                        </span>
                        {item.options && (
                          <span className="text-muted-foreground text-xs">
                            {item.options}
                          </span>
                        )}
                        {(item.voided > 0 || item.comped > 0) && (
                          <span className="text-muted-foreground text-xs">
                            {[
                              item.voided > 0 ? `${item.voided} voided` : null,
                              item.comped > 0 ? `${item.comped} comped` : null,
                            ]
                              .filter(Boolean)
                              .join(", ")}
                          </span>
                        )}
                      </span>
                      <span className="flex gap-1">
                        {(["void", "comp"] as const).map((kind) => (
                          <Button
                            key={kind}
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={left === 0 || pending}
                            aria-label={`${kind === "void" ? "Void" : "Comp"} ${item.name}`}
                            onClick={() =>
                              start({ kind, orderId: order.id, item, left })
                            }
                          >
                            {kind === "void" ? "Void" : "Comp"}
                          </Button>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>

              {order.adjustments.length > 0 && (
                <ul className="flex flex-col gap-1 text-sm">
                  {order.adjustments.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="text-muted-foreground">
                        {ADJUSTMENT_LABELS[a.kind]}
                        {a.itemName ? ` ${a.quantity}× ${a.itemName}` : ""}
                        {a.percent !== null ? ` ${a.percent}%` : ""} ·{" "}
                        {a.reason}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="tabular-nums">−{money(a.amount)}</span>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          disabled={pending}
                          aria-label={`Undo: ${ADJUSTMENT_LABELS[a.kind]}${a.itemName ? ` ${a.itemName}` : ""}`}
                          onClick={() => undo(a.id)}
                        >
                          <Undo2 className="size-4" aria-hidden="true" />
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {form(order)}

              {(!editing || editing.orderId !== order.id) &&
                order.total > 0 && (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        start({
                          kind: "discount",
                          orderId: order.id,
                          writeOff: false,
                        })
                      }
                    >
                      Discount
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() =>
                        start({
                          kind: "discount",
                          orderId: order.id,
                          writeOff: true,
                        })
                      }
                    >
                      Write off
                    </Button>
                  </div>
                )}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
