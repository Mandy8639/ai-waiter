"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { KitchenOrder } from "@/lib/orders/kitchen";
import {
  canCancel,
  nextActionFor,
  type OrderStatus,
} from "@/lib/orders/status";
import { useElapsedLabel } from "./use-elapsed-label";

type Role = "owner" | "manager" | "kitchen" | "staff";

export function OrderCard({
  order,
  role,
  isPending,
  onTransition,
  onCancel,
  onOpenDetail,
}: {
  order: KitchenOrder;
  role: Role;
  isPending: boolean;
  onTransition: (orderId: string, target: OrderStatus) => void;
  onCancel: (orderId: string) => void;
  onOpenDetail: (order: KitchenOrder) => void;
}) {
  const elapsed = useElapsedLabel(order.createdAt);
  const action = nextActionFor(role, order.status);
  const cancellable = canCancel(role, order.status);
  const [cancelOpen, setCancelOpen] = useState(false);

  return (
    <div
      data-order-number={order.orderNumber}
      className="bg-card flex flex-col gap-3 rounded-lg border p-3 shadow-sm"
    >
      <button
        type="button"
        onClick={() => onOpenDetail(order)}
        className="flex items-start justify-between gap-2 text-left"
      >
        <div>
          <p className="text-lg font-semibold tabular-nums">
            #{order.orderNumber}
          </p>
          <p className="text-muted-foreground text-sm">{order.tableLabel}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {order.status === "pending" && (
            <Badge variant="destructive">New</Badge>
          )}
          <span
            className="text-muted-foreground text-xs"
            aria-label="Time since order was placed"
          >
            {elapsed}
          </span>
        </div>
      </button>

      <ul className="flex flex-col gap-1.5 text-sm">
        {order.items.map((item) => (
          <li key={item.id}>
            <span className="font-medium">
              {item.quantity}× {item.itemName}
            </span>
            {item.modifiers.length > 0 && (
              <span className="text-muted-foreground block text-xs">
                {item.modifiers.map((m) => m.optionName).join(", ")}
              </span>
            )}
          </li>
        ))}
      </ul>

      {order.customerNote && (
        <p className="bg-muted rounded-md p-2 text-xs">
          <span className="font-medium">Note: </span>
          {order.customerNote}
        </p>
      )}

      <div className="mt-auto flex items-center gap-2">
        {action && (
          <Button
            type="button"
            className="flex-1"
            disabled={isPending}
            onClick={() => onTransition(order.id, action.targetStatus)}
          >
            {isPending ? "Updating…" : action.label}
          </Button>
        )}
        {cancellable && (
          <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
            <AlertDialogTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                >
                  Cancel
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Cancel order #{order.orderNumber}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This tells the customer their order was cancelled. This
                  can&apos;t be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep order</AlertDialogCancel>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isPending}
                  onClick={() => {
                    onCancel(order.id);
                    setCancelOpen(false);
                  }}
                >
                  {isPending ? "Cancelling…" : "Cancel order"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}
