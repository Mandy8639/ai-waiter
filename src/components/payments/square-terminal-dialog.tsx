"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, CreditCard } from "lucide-react";
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
import { NativeSelect } from "@/components/dashboard/native-select";
import { formatMoney } from "@/lib/orders/format";
import type { UnpaidOrder } from "@/lib/payments/unpaid-orders";
import {
  cancelTerminalPayment,
  checkTerminalPayment,
  sendBillToTerminal,
} from "@/lib/pos/square/terminal-actions";

export interface PairedTerminal {
  deviceId: string;
  name: string;
}

/** How often to ask Square whether the diner has paid. */
const POLL_MS = 3000;

/**
 * Square Terminal for one table (Square restaurants, phase 3). The bill
 * goes to the Terminal itemised; the diner taps their card and, if the
 * restaurant takes tips, adds one there. Like cash, every outstanding
 * order starts selected and the amount comes from the orders. The table
 * is marked paid only after the server has read the payment from Square.
 */
export function SquareTerminalDialog({
  restaurantId,
  tableLabel,
  orders,
  currency,
  terminals,
  onPaid,
}: {
  restaurantId: string;
  tableLabel: string;
  orders: UnpaidOrder[];
  currency: string;
  terminals: PairedTerminal[];
  onPaid?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(orders.map((o) => o.id)),
  );
  const [deviceId, setDeviceId] = useState(terminals[0]?.deviceId ?? "");
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paidTip, setPaidTip] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedTotal = useMemo(
    () =>
      orders
        .filter((o) => selected.has(o.id))
        .reduce((sum, o) => sum + o.total, 0),
    [orders, selected],
  );
  const money = (v: number) => formatMoney(v, currency);
  const waiting = paymentId !== null && paidTip === null;

  // Ask Square every few seconds while the Terminal has the bill.
  useEffect(() => {
    if (!waiting || !paymentId) return;
    let stopped = false;
    const poll = async () => {
      const result = await checkTerminalPayment(restaurantId, paymentId);
      if (stopped) return;
      if (!result.ok) {
        setError(result.error);
      } else if (result.outcome.state === "paid") {
        // Not refreshed yet: on Settle up the paid table would drop out of
        // the list and take this confirmation with it. Done refreshes.
        setPaidTip(result.outcome.tip);
        onPaid?.();
        return;
      } else if (result.outcome.state === "cancelled") {
        setPaymentId(null);
        setError("The payment was cancelled on the Terminal.");
        return;
      }
      timer.current = setTimeout(poll, POLL_MS);
    };
    timer.current = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [waiting, paymentId, restaurantId, router, onPaid]);

  if (terminals.length === 0) return null;

  async function send() {
    setError(null);
    setSending(true);
    const result = await sendBillToTerminal(
      restaurantId,
      [...selected],
      deviceId,
    );
    setSending(false);
    if (result.ok) setPaymentId(result.paymentId);
    else setError(result.error);
  }

  async function cancel() {
    if (!paymentId) return;
    const result = await cancelTerminalPayment(restaurantId, paymentId);
    if (result.ok) {
      setPaymentId(null);
      setError(null);
    } else {
      setError(result.error);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (waiting || sending) return; // finish or cancel on the Terminal first
        if (!next) {
          if (paidTip !== null) router.refresh();
          setSelected(new Set(orders.map((o) => o.id)));
          setPaymentId(null);
          setPaidTip(null);
          setError(null);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" size="sm">
            <CreditCard className="size-4" aria-hidden="true" />
            Square Terminal
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Square Terminal for {tableLabel}</DialogTitle>
          <DialogDescription>
            The bill appears on the Terminal, itemised. The guest taps their
            card there and can add a tip. The table is marked paid once Square
            confirms.
          </DialogDescription>
        </DialogHeader>

        {paidTip !== null ? (
          <div role="status" className="flex flex-col items-center gap-2 py-6">
            <CircleCheck className="text-success size-10" aria-hidden="true" />
            <p className="font-medium">
              Paid {money(selectedTotal + paidTip)}
              {paidTip > 0 ? ` (includes ${money(paidTip)} tip)` : ""}
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
                      disabled={waiting || sending}
                    />
                    <span className="font-medium">#{order.orderNumber}</span>
                    <Badge variant="outline">{order.status}</Badge>
                  </span>
                  <span className="tabular-nums">{money(order.total)}</span>
                </label>
              ))}
            </div>
            {terminals.length > 1 && (
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="square-terminal"
                  className="text-sm font-medium"
                >
                  Terminal
                </label>
                <NativeSelect
                  id="square-terminal"
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  disabled={waiting || sending}
                >
                  {terminals.map((t) => (
                    <option key={t.deviceId} value={t.deviceId}>
                      {t.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            {waiting && (
              <p role="status" className="text-sm font-medium">
                Waiting for the guest to pay on the Terminal…
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {paidTip !== null ? (
            <Button
              type="button"
              onClick={() => {
                setOpen(false);
                router.refresh();
              }}
            >
              Done
            </Button>
          ) : waiting ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void cancel()}
            >
              Cancel on Terminal
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void send()}
              disabled={selected.size === 0 || sending || !deviceId}
            >
              {sending
                ? "Sending…"
                : `Send ${money(selectedTotal)} to Terminal`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
