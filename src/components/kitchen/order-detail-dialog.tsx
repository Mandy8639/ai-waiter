"use client";

import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { KitchenOrder } from "@/lib/orders/kitchen";
import { fetchOrderStatusHistory } from "@/lib/orders/kitchen-actions";
import type { OrderStatusHistoryEntry } from "@/lib/orders/kitchen";
import { STATUS_LABELS } from "@/lib/orders/status";

const ACTOR_LABELS: Record<string, string> = {
  customer: "Customer",
  owner: "Owner",
  manager: "Manager",
  kitchen: "Kitchen",
  staff: "Staff",
  system: "System",
};

/** Order items/modifiers/notes are already loaded on the board — only the audit trail (status history) is fetched on open, so opening a card never re-fetches data it already has (spec section 15: "do not navigate away unnecessarily" and avoid unnecessary round trips). */
export function OrderDetailDialog({
  order,
  onOpenChange,
  onPrint,
}: {
  order: KitchenOrder | null;
  onOpenChange: (open: boolean) => void;
  /** Prints this order's ticket again; absent where the device can't print. */
  onPrint?: (order: KitchenOrder) => void;
}) {
  // Keyed by order id (rather than a bare "reset then fetch" effect) so a
  // newly-opened order never briefly shows the PREVIOUS order's history —
  // render treats anything but an exact id match as still loading.
  const [history, setHistory] = useState<{
    orderId: string;
    entries: OrderStatusHistoryEntry[];
  } | null>(null);

  useEffect(() => {
    if (!order) return;
    let cancelled = false;
    fetchOrderStatusHistory(order.id).then((rows) => {
      if (!cancelled) setHistory({ orderId: order.id, entries: rows });
    });
    return () => {
      cancelled = true;
    };
  }, [order]);

  const currentHistory =
    order && history?.orderId === order.id ? history.entries : null;

  return (
    <Dialog open={order !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {order && (
          <>
            <DialogHeader>
              <DialogTitle>
                Order #{order.orderNumber} — {order.tableLabel}
              </DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-4 text-sm">
              <div className="flex flex-col gap-2">
                {order.items.map((item) => (
                  <div key={item.id}>
                    <p className="font-medium">
                      {item.quantity}× {item.itemName}
                    </p>
                    {item.modifiers.length > 0 && (
                      <p className="text-muted-foreground text-xs">
                        {item.modifiers.map((m) => m.optionName).join(", ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {onPrint && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 self-start"
                  onClick={() => onPrint(order)}
                >
                  <Printer className="size-4" aria-hidden="true" />
                  Print ticket
                </Button>
              )}

              {order.customerNote && (
                <div className="bg-muted rounded-md p-2">
                  <p className="text-xs font-medium">Customer note</p>
                  <p>{order.customerNote}</p>
                </div>
              )}

              <div>
                <p className="mb-1.5 text-xs font-medium">Status history</p>
                {currentHistory === null ? (
                  <p className="text-muted-foreground text-xs">Loading…</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {currentHistory.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="flex items-center gap-1.5">
                          <Badge variant="outline">
                            {STATUS_LABELS[entry.status]}
                          </Badge>
                          <span className="text-muted-foreground">
                            by{" "}
                            {ACTOR_LABELS[entry.actorType] ?? entry.actorType}
                          </span>
                        </span>
                        <span className="text-muted-foreground">
                          {new Date(entry.createdAt).toLocaleTimeString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
