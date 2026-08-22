"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { fetchActiveOrders } from "@/lib/orders/kitchen-actions";
import { transitionOrderStatus } from "@/lib/orders/transition";
import type { KitchenOrder } from "@/lib/orders/kitchen";
import { STATUS_LABELS, type OrderStatus } from "@/lib/orders/status";
import { OrderCard } from "./order-card";
import { OrderDetailDialog } from "./order-detail-dialog";
import { useNotificationSound } from "./use-notification-sound";

type Role = "owner" | "manager" | "kitchen" | "staff";

const BOARD_COLUMNS: OrderStatus[] = [
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "served",
];

/**
 * Realtime strategy: every `postgres_changes` event on `orders` for this
 * restaurant (the `filter` below is a bandwidth/performance optimization —
 * NOT the security boundary; RLS, unchanged since Batch 5, is what
 * actually prevents another restaurant's rows from ever reaching this
 * client, filter or no filter — see docs/security.md#realtime-security)
 * triggers a full, authoritative re-fetch via fetchActiveOrders(), rather
 * than patching the bare changed row into local state. The realtime
 * payload for an INSERT/UPDATE on `orders` doesn't carry the row's
 * order_items/order_item_modifiers at all, so a partial patch couldn't
 * render a complete card anyway — and a full re-fetch, keyed by order id,
 * is naturally idempotent: duplicate events, an event that arrives after
 * a reconnect already resynced, or two events for the same order in quick
 * succession, all converge on the same correct state rather than
 * accumulating duplicates (spec section 22).
 *
 * The same re-fetch function is also what runs on channel (re)connect, on
 * the tab becoming visible again, and on the browser regaining network —
 * so "the KDS must resynchronize on reconnect, never assume no events were
 * missed" (spec section 21) isn't a special case, it's the same code path
 * as every other update.
 */
export function KitchenBoard({
  restaurantId,
  role,
  initialOrders,
}: {
  restaurantId: string;
  role: Role;
  initialOrders: KitchenOrder[];
}) {
  const [orders, setOrders] = useState<KitchenOrder[]>(initialOrders);
  const [detailOrder, setDetailOrder] = useState<KitchenOrder | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const { muted, toggleMuted, unlock, play } = useNotificationSound();
  const [, startTransitionAction] = useTransition();

  const knownIdsRef = useRef<Set<string>>(
    new Set(initialOrders.map((o) => o.id)),
  );
  const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resync = useCallback(
    async (announceNew: boolean) => {
      const fresh = await fetchActiveOrders(restaurantId);
      if (announceNew) {
        const hasNewPending = fresh.some(
          (o) => o.status === "pending" && !knownIdsRef.current.has(o.id),
        );
        if (hasNewPending) play();
      }
      knownIdsRef.current = new Set(fresh.map((o) => o.id));
      setOrders(fresh);
    },
    [restaurantId, play],
  );

  const scheduleResync = useCallback(
    (announceNew: boolean) => {
      if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
      resyncTimerRef.current = setTimeout(() => {
        void resync(announceNew);
      }, 250);
    },
    [resync],
  );

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`orders:restaurant:${restaurantId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        () => scheduleResync(true),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setConnected(true);
          scheduleResync(false);
        } else if (
          status === "CLOSED" ||
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT"
        ) {
          setConnected(false);
        }
      });

    function handleWake() {
      if (document.visibilityState === "visible") scheduleResync(false);
    }
    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("online", handleWake);

    return () => {
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("online", handleWake);
      if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
      void supabase.removeChannel(channel);
    };
  }, [restaurantId, scheduleResync]);

  function handleTransition(orderId: string, target: OrderStatus) {
    setActionError(null);
    setPendingIds((prev) => new Set(prev).add(orderId));
    startTransitionAction(async () => {
      const result = await transitionOrderStatus(orderId, target);
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(orderId);
        return next;
      });
      if (result.error) {
        setActionError(result.error);
      } else {
        void resync(false);
      }
    });
  }

  return (
    <div className="flex flex-1 flex-col gap-4" onClickCapture={unlock}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Kitchen</h1>
          <Badge variant={connected ? "secondary" : "outline"}>
            {connected ? "Live" : "Reconnecting…"}
          </Badge>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={toggleMuted}>
          {muted ? "Unmute alerts" : "Mute alerts"}
        </Button>
      </div>

      {actionError && (
        <div className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {actionError}
        </div>
      )}

      <div className="flex flex-1 gap-4 overflow-x-auto pb-2">
        {BOARD_COLUMNS.map((status) => {
          const columnOrders = orders.filter((o) => o.status === status);
          return (
            <div
              key={status}
              className="flex w-72 shrink-0 flex-col gap-3 sm:w-80"
            >
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold tracking-wide uppercase">
                  {STATUS_LABELS[status]}
                </h2>
                <Badge variant="outline">{columnOrders.length}</Badge>
              </div>
              <div className="flex flex-col gap-3">
                {columnOrders.length === 0 && (
                  <p className="text-muted-foreground text-xs">No orders.</p>
                )}
                {columnOrders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    role={role}
                    isPending={pendingIds.has(order.id)}
                    onTransition={handleTransition}
                    onCancel={(orderId) =>
                      handleTransition(orderId, "cancelled")
                    }
                    onOpenDetail={setDetailOrder}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <OrderDetailDialog
        order={detailOrder}
        onOpenChange={(open) => {
          if (!open) setDetailOrder(null);
        }}
      />
    </div>
  );
}
