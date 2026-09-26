"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { fetchActiveOrders } from "@/lib/orders/kitchen-actions";
import { transitionOrderStatus } from "@/lib/orders/transition";
import {
  transitionTicketGroupStatus,
  splitOrderIntoTickets,
  mergeOrdersIntoTicket,
} from "@/lib/orders/ticket-groups";
import type { KitchenOrder, KitchenStation } from "@/lib/orders/kitchen";
import { setStationDone } from "@/lib/kitchen/station-actions";
import {
  hasOwnLines,
  ordersForStation,
  stationProgress,
} from "@/lib/kitchen/stations-core";
import { STATUS_LABELS, type OrderStatus } from "@/lib/orders/status";
import { OrderCard } from "./order-card";
import { OrderDetailDialog } from "./order-detail-dialog";
import { SplitOrderDialog } from "./split-order-dialog";
import { MergeOrderDialog } from "./merge-order-dialog";
import { useNotificationSound } from "./use-notification-sound";

/**
 * How often to chime again while an order sits unaccepted.
 *
 * Twenty seconds is chosen to be answerable rather than ignorable. Faster
 * becomes noise a kitchen mutes on the first busy night, and a muted board
 * is the failure this exists to prevent — which is why the count is also
 * shown in writing, and why the banner says the alerts are muted when
 * they are.
 */
const REMINDER_INTERVAL_MS = 20_000;
import {
  resolvePollIntervalMs,
  shouldPollNow,
  isStaleResync,
  hasNewPendingOrder,
} from "./kds-reconciliation";

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
 *
 * Polling fallback (Supabase ticket SU-452145 — `postgres_changes` INSERT
 * delivery is not always reliable): a low-frequency safety-net timer calls
 * this exact same resync() on an interval, so a missed Realtime event is
 * still caught even if the channel never reports a problem. The interval
 * speeds up automatically while the channel is actually disconnected (see
 * kds-reconciliation.ts#resolvePollIntervalMs) and pauses while the tab is
 * hidden. Because every trigger — Realtime, polling, reconnect, visibility,
 * online — goes through this same full-replace resync(), "Realtime and
 * polling both discover the same order" and "a slow poll resolves after a
 * newer Realtime update" are not special cases either: see
 * kds-reconciliation.ts's header comment for why dedup is automatic, and
 * the resyncSeqRef guard below for why a stale response can never overwrite
 * fresher state.
 */
/** Roles that cook, and so can mark a station's part done — set_order_station_done()'s own list. */
const CAN_MARK_STATION: Role[] = ["owner", "manager", "kitchen"];

/** Stable default, so the remembered-station effect doesn't re-run every render. */
const NO_STATIONS: KitchenStation[] = [];

/** "all" is the pass: every line, every status step. */
type StationChoice = "all" | string;

function stationStorageKey(restaurantId: string) {
  return `tableside.kitchen.station.${restaurantId}`;
}

export function KitchenBoard({
  restaurantId,
  role,
  initialOrders,
  stations = NO_STATIONS,
}: {
  restaurantId: string;
  role: Role;
  initialOrders: KitchenOrder[];
  /** Phase I. With none, the board is exactly the one-screen board it always was. */
  stations?: KitchenStation[];
}) {
  const [orders, setOrders] = useState<KitchenOrder[]>(initialOrders);
  const [detailOrder, setDetailOrder] = useState<KitchenOrder | null>(null);
  const [splitOrder, setSplitOrder] = useState<KitchenOrder | null>(null);
  const [mergeOrder, setMergeOrder] = useState<KitchenOrder | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const { muted, toggleMuted, unlock, play } = useNotificationSound();
  const [stationChoice, setStationChoice] = useState<StationChoice>("all");

  // Each tablet is one station, so the choice is remembered per device.
  // Read after mount, like the mute preference, to avoid a hydration
  // mismatch; a remembered station that has since been deleted falls back
  // to the pass.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(stationStorageKey(restaurantId));
    } catch {
      // Private mode or blocked storage: start on the pass.
    }
    if (stored && stations.some((st) => st.id === stored)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStationChoice(stored);
    }
  }, [restaurantId, stations]);

  function chooseStation(choice: StationChoice) {
    setStationChoice(choice);
    try {
      window.localStorage.setItem(stationStorageKey(restaurantId), choice);
    } catch {
      // Not remembered; still applied.
    }
  }

  const activeStation =
    stationChoice === "all"
      ? null
      : (stations.find((st) => st.id === stationChoice) ?? null);
  const [, startTransitionAction] = useTransition();

  const knownIdsRef = useRef<Set<string>>(
    new Set(initialOrders.map((o) => o.id)),
  );
  const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped on every resync() call; a response is only applied if it's still the most recently issued one — see isStaleResync()/requirement 14. */
  const resyncSeqRef = useRef(0);
  const isMountedRef = useRef(true);

  const resync = useCallback(
    async (announceNew: boolean) => {
      const seq = (resyncSeqRef.current += 1);
      let fresh;
      try {
        fresh = await fetchActiveOrders(restaurantId);
      } catch (error) {
        // A transient Supabase/network failure must not crash the board or
        // show staff a scary error — leave existing state as-is and let
        // the next trigger (Realtime event, next poll tick, reconnect)
        // retry naturally.
        console.error("KDS resync failed, will retry on next trigger", error);
        return;
      }
      if (!isMountedRef.current) return;
      if (isStaleResync(seq, resyncSeqRef.current)) return;
      if (announceNew && hasNewPendingOrder(fresh, knownIdsRef.current)) {
        play();
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

  // Polling safety net (Supabase ticket SU-452145) — a separate effect
  // from the Realtime subscription above so that `connected` flipping
  // (which this effect depends on, to choose the interval) never tears
  // down and rebuilds the actual channel; it only ever restarts this
  // timer. Realtime stays the primary mechanism — this exists purely to
  // catch whatever it silently misses, on the interval kds-reconciliation.ts
  // defines (fast while disconnected, slow otherwise), skipping ticks while
  // the tab is hidden (requirement 11) — the existing visibilitychange
  // listener above already reconciles immediately the moment it becomes
  // visible again, so nothing extra is needed for that half.
  useEffect(() => {
    const intervalMs = resolvePollIntervalMs(connected);
    const timer = setInterval(() => {
      if (!shouldPollNow(document.visibilityState)) return;
      scheduleResync(true);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [connected, scheduleResync]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

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

  function handleGroupTransition(ticketGroupId: string, target: OrderStatus) {
    setActionError(null);
    startTransitionAction(async () => {
      const result = await transitionTicketGroupStatus(ticketGroupId, target);
      if (result.error) {
        setActionError(result.error);
      } else {
        void resync(false);
      }
    });
  }

  function handleStationDone(
    orderId: string,
    stationId: string,
    done: boolean,
  ) {
    setActionError(null);
    setPendingIds((prev) => new Set(prev).add(orderId));
    startTransitionAction(async () => {
      const result = await setStationDone(orderId, stationId, done);
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

  async function handleSplit(
    orderId: string,
    groups: { label?: string; itemIds: string[] }[],
  ) {
    const result = await splitOrderIntoTickets(orderId, groups);
    if (!result.error) void resync(false);
    return result;
  }

  async function handleMerge(orderIds: string[], label: string | null) {
    const result = await mergeOrdersIntoTicket(orderIds, label);
    if (!result.error) void resync(false);
    return result;
  }

  // Eligible per merge_orders_into_ticket()'s own rules (this is a UI
  // convenience filter, not the security boundary — the RPC re-validates
  // everything server-side regardless of what this list offers):  same
  // status as the order being merged, not itself, and not already
  // split/merged.
  const mergeCandidates = mergeOrder
    ? orders.filter(
        (o) =>
          o.id !== mergeOrder.id &&
          o.status === mergeOrder.status &&
          o.ticketGroups.length === 0,
      )
    : [];

  // order.mergedWithOrderIds holds other orders' ids, not their
  // customer-facing numbers — this map lets OrderCard render "#3" instead
  // of a raw uuid in the "Merged ticket — moves with order #…" line.
  const orderNumberById = useMemo(
    () => new Map(orders.map((o) => [o.id, o.orderNumber])),
    [orders],
  );

  // Orders nobody has accepted yet. `pending` already means exactly that —
  // the state machine's first transition is pending -> confirmed, which IS
  // the "Accept" a DoorDash tablet demands — so this needs no new column.
  const visibleOrders = useMemo(
    () => (activeStation ? ordersForStation(orders, activeStation.id) : orders),
    [orders, activeStation],
  );

  const unacceptedCount = visibleOrders.filter(
    (o) => o.status === "pending",
  ).length;

  // Keep chiming until someone accepts.
  //
  // The one-shot chime on arrival was not enough, and this restaurant has
  // the evidence: eleven orders sat at `pending` for hours because the
  // sound played once, into an empty room, and nothing ever asked again.
  // A single alert only works if a person happens to be standing there
  // when it fires. Service does not work like that.
  //
  // Stops the instant the last unaccepted order is accepted, so a kitchen
  // that is keeping up hears nothing at all.
  useEffect(() => {
    if (unacceptedCount === 0) return;
    const timer = setInterval(() => play(), REMINDER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [unacceptedCount, play]);

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

      {/*
        Said in words as well as sound, and it has to be. A kitchen mutes
        the board, or the tablet's volume is down, or the person nearest it
        cannot hear — and an alert that exists only as a noise has simply
        not happened for them (SC 1.4.1, and ordinary kitchen reality).
        aria-live announces it without stealing focus from whatever a cook
        is doing.
      */}
      {unacceptedCount > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="border-destructive/40 bg-destructive/5 text-foreground rounded-md border px-3 py-2 text-sm font-medium"
        >
          {unacceptedCount === 1
            ? "1 order is waiting to be accepted."
            : `${unacceptedCount} orders are waiting to be accepted.`}{" "}
          <span className="text-muted-foreground font-normal">
            {muted
              ? "Alerts are muted."
              : "This will keep chiming until you accept them."}
          </span>
        </div>
      )}

      {stations.length > 0 && (
        <div
          role="group"
          aria-label="Which station is this screen?"
          className="flex flex-wrap gap-2"
        >
          {[{ id: "all", name: "All stations" }, ...stations].map((st) => {
            const selected =
              st.id === "all"
                ? activeStation === null
                : activeStation?.id === st.id;
            return (
              <Button
                key={st.id}
                type="button"
                size="sm"
                variant={selected ? "default" : "outline"}
                aria-pressed={selected}
                onClick={() => chooseStation(st.id)}
              >
                {st.name}
              </Button>
            );
          })}
        </div>
      )}
      {activeStation && (
        <p className="text-muted-foreground text-sm">
          Showing {activeStation.name}&apos;s dishes and any dish with no
          station. Mark your part done here; the order is marked ready from All
          stations.
        </p>
      )}

      {actionError && (
        <div className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {actionError}
        </div>
      )}

      {/*
        Five columns never fit a phone, so the board scrolls sideways and
        snaps a column at a time — each column is its own panel, so a partly
        visible next column reads as "there's more", not as clipping.
      */}
      <div className="-mx-4 flex flex-1 snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:snap-none sm:px-0">
        {BOARD_COLUMNS.map((status) => {
          const columnOrders = visibleOrders.filter((o) => o.status === status);
          return (
            <section
              key={status}
              aria-label={`${STATUS_LABELS[status]} orders`}
              className="bg-muted/50 flex w-[85vw] max-w-80 shrink-0 snap-start flex-col gap-3 rounded-xl border p-3 sm:w-80"
            >
              <div className="flex items-center justify-between gap-2 px-1">
                <h2 className="type-overline text-foreground">
                  {STATUS_LABELS[status]}
                </h2>
                <Badge variant="outline" className="bg-card">
                  {columnOrders.length}
                </Badge>
              </div>
              <div className="flex flex-col gap-3">
                {columnOrders.length === 0 && (
                  <p className="type-caption text-muted-foreground px-1 py-4 text-center">
                    No orders.
                  </p>
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
                    onGroupTransition={handleGroupTransition}
                    onOpenSplit={setSplitOrder}
                    onOpenMerge={setMergeOrder}
                    orderNumberById={orderNumberById}
                    station={
                      activeStation
                        ? {
                            name: activeStation.name,
                            done: order.stationsDone.includes(activeStation.id),
                            // Only a station with its own lines has a part
                            // to finish; unassigned-only orders have none.
                            canMark:
                              CAN_MARK_STATION.includes(role) &&
                              hasOwnLines(order, activeStation.id),
                            onToggle: (done) =>
                              handleStationDone(
                                order.id,
                                activeStation.id,
                                done,
                              ),
                          }
                        : undefined
                    }
                    progress={
                      activeStation
                        ? undefined
                        : stationProgress(order, stations)
                    }
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <OrderDetailDialog
        order={detailOrder}
        onOpenChange={(open) => {
          if (!open) setDetailOrder(null);
        }}
      />
      <SplitOrderDialog
        order={splitOrder}
        open={splitOrder !== null}
        onOpenChange={(open) => {
          if (!open) setSplitOrder(null);
        }}
        onSplit={handleSplit}
      />
      <MergeOrderDialog
        order={mergeOrder}
        candidates={mergeCandidates}
        open={mergeOrder !== null}
        onOpenChange={(open) => {
          if (!open) setMergeOrder(null);
        }}
        onMerge={handleMerge}
      />
    </div>
  );
}
