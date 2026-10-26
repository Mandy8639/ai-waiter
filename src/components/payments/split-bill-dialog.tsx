"use client";

import { useState, useTransition } from "react";
import { Split } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { NativeSelect } from "@/components/dashboard/native-select";
import { formatMoney } from "@/lib/orders/format";
import { createStaffSplit } from "@/lib/payments/staff-split-actions";

/**
 * Settle up → Split: freeze a table's orders into equal shares or one part
 * per dish (create_staff_split()). The parts then appear on the table's
 * card to be paid one by one.
 */
export function SplitBillDialog({
  restaurantId,
  tableLabel,
  orderIds,
  total,
  currency,
}: {
  restaurantId: string;
  tableLabel: string;
  orderIds: string[];
  total: number;
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"equal" | "by_dish">("equal");
  const [shares, setShares] = useState("2");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const count = Number(shares);
  const valid = mode === "by_dish" || (Number.isInteger(count) && count >= 2);

  function create() {
    if (!valid || (mode === "equal" && count > 20)) {
      setError("Split the bill between 2 and 20 people.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createStaffSplit(
        restaurantId,
        orderIds,
        mode,
        mode === "equal" ? count : null,
      );
      if (result.ok) setOpen(false);
      else setError(result.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        setOpen(next);
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" size="sm" variant="outline">
            <Split className="size-4" aria-hidden="true" />
            Split
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Split the bill for {tableLabel}</DialogTitle>
          <DialogDescription>
            {formatMoney(total, currency)} in parts, each paid separately. The
            table counts as paid once every part is.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="split-mode">How</Label>
            <NativeSelect
              id="split-mode"
              value={mode}
              onChange={(e) =>
                setMode(e.target.value === "by_dish" ? "by_dish" : "equal")
              }
            >
              <option value="equal">Equal shares</option>
              <option value="by_dish">By dish (each pays for theirs)</option>
            </NativeSelect>
          </div>
          {mode === "equal" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="split-shares">How many people</Label>
              <Input
                id="split-shares"
                inputMode="numeric"
                value={shares}
                onChange={(e) => setShares(e.target.value)}
              />
              {valid && count <= 20 && (
                <p className="text-muted-foreground text-sm">
                  About {formatMoney(total / count, currency)} each.
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" onClick={create} disabled={pending}>
            {pending ? "Splitting…" : "Split the bill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
