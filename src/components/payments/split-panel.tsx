"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/dashboard/native-select";
import { formatMoney } from "@/lib/orders/format";
import {
  cancelStaffSplit,
  paySplitInPerson,
  sendSplitPartsToTerminal,
} from "@/lib/payments/staff-split-actions";
import {
  cancelTerminalPayment,
  checkTerminalPayment,
} from "@/lib/pos/square/terminal-actions";
import type { OpenSplit } from "@/lib/payments/unpaid-orders";
import type { PairedTerminal } from "./square-terminal-dialog";

const POLL_MS = 3000;

const STATUS_LABEL = { paid: "Paid", pending: "Paying…" } as const;

/**
 * A table's bill being paid in parts, on its Settle up card: tick the
 * parts one guest is paying for, then take cash, the card machine or a
 * Square Terminal. A diner's own phone split shows here too, so the last
 * part can be paid at the table. The table leaves Settle up once every
 * part is paid; until anything is, the split can be cancelled.
 */
export function SplitPanel({
  restaurantId,
  tableLabel,
  split,
  acceptsCash,
  acceptsCardTerminal,
  terminals,
  tippingEnabled,
}: {
  restaurantId: string;
  tableLabel: string;
  split: OpenSplit;
  acceptsCash: boolean;
  acceptsCardTerminal: boolean;
  /** Paired Square Terminals; empty when cards don't go through Square. */
  terminals: PairedTerminal[];
  tippingEnabled: boolean;
}) {
  const router = useRouter();
  const money = (v: number) => formatMoney(v, split.currency);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tip, setTip] = useState("");
  const [deviceId, setDeviceId] = useState(terminals[0]?.deviceId ?? "");
  const [terminalPayment, setTerminalPayment] = useState<string | null>(null);
  // Kept from when it was sent: once the page refreshes, those parts are
  // "paying" rather than ticked.
  const [terminalAmount, setTerminalAmount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = split.parts.filter((p) => p.status === "open");
  const chosen = open.filter((p) => selected.has(p.id));
  const chosenTotal = chosen.reduce((s, p) => s + p.amount, 0);
  const untouched = split.parts.every((p) => p.status === "open");

  // While a part is on the Terminal, ask Square every few seconds.
  useEffect(() => {
    if (!terminalPayment) return;
    let stopped = false;
    const poll = async () => {
      const result = await checkTerminalPayment(restaurantId, terminalPayment);
      if (stopped) return;
      if (!result.ok) setError(result.error);
      else if (result.outcome.state !== "waiting") {
        if (result.outcome.state === "cancelled")
          setError("The payment was cancelled on the Terminal.");
        setTerminalPayment(null);
        setSelected(new Set());
        router.refresh();
        return;
      }
      timer.current = setTimeout(poll, POLL_MS);
    };
    timer.current = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [terminalPayment, restaurantId, router]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function payInPerson(method: "cash" | "card_terminal") {
    setError(null);
    startTransition(async () => {
      const result = await paySplitInPerson(
        restaurantId,
        split.id,
        chosen.map((p) => p.id),
        method,
        tip,
      );
      if (result.ok) {
        setSelected(new Set());
        setTip("");
      } else setError(result.error);
    });
  }

  function sendToTerminal() {
    setError(null);
    startTransition(async () => {
      const result = await sendSplitPartsToTerminal(
        restaurantId,
        split.id,
        chosen.map((p) => p.id),
        deviceId,
        tableLabel,
      );
      if (result.ok) {
        setTerminalAmount(chosenTotal);
        setTerminalPayment(result.paymentId);
      } else setError(result.error);
    });
  }

  function cancelTerminal() {
    if (!terminalPayment) return;
    startTransition(async () => {
      const result = await cancelTerminalPayment(restaurantId, terminalPayment);
      if (result.ok) {
        setTerminalPayment(null);
        router.refresh();
      } else setError(result.error);
    });
  }

  function cancelSplit() {
    setError(null);
    startTransition(async () => {
      const result = await cancelStaffSplit(restaurantId, split.id);
      if (!result.ok) setError(result.error);
    });
  }

  const busy = pending || terminalPayment !== null;

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">
          {split.byStaff ? "Split" : "Split on guests' phones"}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {money(split.paidTotal)} of {money(split.total)} paid
        </span>
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <ul className="flex flex-col gap-1 text-sm">
        {split.parts.map((part) => (
          <li key={part.id}>
            {part.status === "open" ? (
              <label className="hover:bg-muted flex cursor-pointer items-center justify-between gap-2 rounded-md p-1">
                <span className="flex items-center gap-2">
                  <Checkbox
                    checked={selected.has(part.id)}
                    onCheckedChange={() => toggle(part.id)}
                    disabled={busy}
                  />
                  {part.label}
                </span>
                <span className="tabular-nums">{money(part.amount)}</span>
              </label>
            ) : (
              <span className="text-muted-foreground flex items-center justify-between gap-2 p-1">
                <span className="flex items-center gap-2">
                  <Badge variant="outline">{STATUS_LABEL[part.status]}</Badge>
                  {part.label}
                </span>
                <span className="tabular-nums">{money(part.amount)}</span>
              </span>
            )}
          </li>
        ))}
      </ul>

      {terminalPayment ? (
        <div role="status" className="flex flex-col gap-2 text-sm">
          <p>
            {money(terminalAmount)} is on the Terminal. The guest taps their
            card and can add a tip there.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="self-start"
            onClick={cancelTerminal}
            disabled={pending}
          >
            Cancel on Terminal
          </Button>
        </div>
      ) : (
        chosen.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Paying {money(chosenTotal)}</p>
            {tippingEnabled && (acceptsCash || acceptsCardTerminal) && (
              <div className="flex items-center gap-2">
                <Label htmlFor={`split-tip-${split.id}`} className="text-sm">
                  Tip
                </Label>
                <Input
                  id={`split-tip-${split.id}`}
                  inputMode="decimal"
                  className="h-8 w-24"
                  placeholder="0.00"
                  value={tip}
                  onChange={(e) => setTip(e.target.value)}
                />
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {terminals.length > 0 && (
                <>
                  {terminals.length > 1 && (
                    <NativeSelect
                      aria-label="Terminal"
                      className="w-auto"
                      value={deviceId}
                      onChange={(e) => setDeviceId(e.target.value)}
                    >
                      {terminals.map((t) => (
                        <option key={t.deviceId} value={t.deviceId}>
                          {t.name}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    onClick={sendToTerminal}
                    disabled={pending}
                  >
                    Square Terminal
                  </Button>
                </>
              )}
              {acceptsCash && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => payInPerson("cash")}
                  disabled={pending}
                >
                  Take cash
                </Button>
              )}
              {acceptsCardTerminal && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => payInPerson("card_terminal")}
                  disabled={pending}
                >
                  Paid by card machine
                </Button>
              )}
            </div>
          </div>
        )
      )}

      {untouched && !terminalPayment && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={cancelSplit}
          disabled={pending}
        >
          Cancel split
        </Button>
      )}
    </div>
  );
}
