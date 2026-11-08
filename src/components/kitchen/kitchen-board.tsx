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
import { listenToTopic } from "@/lib/supabase/realtime";
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
import { orderColumn } from "@/lib/pickup/board-core";
import { OrderDetailDialog } from "./order-detail-dialog";
import { SplitOrderDialog } from "./split-order-dialog";
import { MergeOrderDialog } from "./merge-order-dialog";
import { useNotificationSound } from "./use-notification-sound";
import { useWakeLock } from "./use-wake-lock";
import { UNDO_WINDOW_MS, offersUndo, undoMessage } from "./undo-core";
import { withOverrides } from "./optimistic-core";
import { printTicket, usePrinterSettings } from "./ticket-printer";
import { PrinterSettingsButton } from "./printer-settings";
import {
  TEST_TICKET,
  kitchenTicketHtml,
  ordersToAutoPrint,
} from "@/lib/kitchen/ticket-core";

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
import {
  KITCHEN_NOT_SENT,
  dropLaterTapsFor,
  enqueueTap,
  queuedTapsLabel,
  shouldShowOfflineBanner,
  type QueuedTap,
} from "@/lib/offline/core";

type Role = "owner" | "manager" | "kitchen" | "staff";

const BOARD_COLUMNS: OrderStatus[] = [
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "served",
];

/**
 * Realtime strategy: every change to this restaurant's orders arrives as
 * a Broadcast message on its private `orders:restaurant:<id>` topic
 * (20261127090000; joining is limited to the restaurant's members, the
 * same rule as reading orders) and triggers a full, authoritative
 * re-fetch via fetchActiveOrders(), rather than patching the changed row
 * into local state. The message carries only the order's id, number and
 * status, not its items, so a partial patch couldn't render a complete
 * card anyway — and a full re-fetch, keyed by order id,
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
 * Polling fallback (a message can always be missed: a dropped socket, a
 * sleeping tablet, a deploy): a low-frequency safety-net timer calls
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
  restaurantName,
  timeZone,
  role,
  initialOrders,
  stations = NO_STATIONS,
  toolbar,
  kitchenPrinter = false,
}: {
  restaurantId: string;
  /** For printed tickets. */
  restaurantName: string;
  /** The restaurant's zone, so a ticket's time matches the kitchen clock. */
  timeZone: string;
  role: Role;
  initialOrders: KitchenOrder[];
  /** Phase I. With none, the board is exactly the one-screen board it always was. */
  stations?: KitchenStation[];
  /** The page's own controls (busy mode, alerts, stations), in the header's button row. */
  toolbar?: React.ReactNode;
  /** A network kitchen printer is set up, so a ticket can be reprinted on it. */
  kitchenPrinter?: boolean;
}) {
  const [orders, setOrders] = useState<KitchenOrder[]>(initialOrders);
  const [detailOrder, setDetailOrder] = useState<KitchenOrder | null>(null);
  const [splitOrder, setSplitOrder] = useState<KitchenOrder | null>(null);
  const [mergeOrder, setMergeOrder] = useState<KitchenOrder | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  /** "Order #12 was cancelled by the guest", shown for a while. */
  const [guestCancelNotice, setGuestCancelNotice] = useState<string | null>(
    null,
  );
  const [connected, setConnected] = useState(false);
  // Offline mode, phase 1 (src/lib/offline/core.ts). Set by a server call
  // that couldn't get through or the browser's offline event; cleared by
  // the next resync that does. Not the badge's `connected`, which also
  // blips while live updates (re)join.
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const markOffline = useCallback(
    () => setOfflineSince((since) => since ?? Date.now()),
    [],
  );
  // Taps made while offline, sent in order once the board reconnects.
  const tapQueueRef = useRef<QueuedTap[]>([]);
  const [queuedTaps, setQueuedTaps] = useState(0);
  // The latest drainTapQueue(), for resync() above it to call.
  const drainRef = useRef<() => Promise<void>>(async () => undefined);
  const { muted, toggleMuted, unlock, play } = useNotificationSound();
  const [stationChoice, setStationChoice] = useState<StationChoice>("all");
  // A pickup order's "start at" passes on its own, with no event to say
  // so; this moves it up its column within half a minute of that time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useWakeLock();
  const {
    settings: printer,
    update: updatePrinter,
    available: canPrint,
  } = usePrinterSettings(restaurantId);
  // Read inside resync() without making it (and the Realtime channel built
  // on it) depend on these.
  const printRef = useRef({ printer, canPrint, restaurantName, timeZone });
  useEffect(() => {
    printRef.current = { printer, canPrint, restaurantName, timeZone };
  });

  function ticketFor(order: KitchenOrder, reprint: boolean) {
    return kitchenTicketHtml(order, {
      restaurantName,
      timeZone,
      paper: printer.paper,
      reprint,
    });
  }
  /** The status tap waiting out its undo window (undo-core.ts), if any. */
  const [undo, setUndo] = useState<{
    orderId: string;
    target: OrderStatus;
  } | null>(null);
  const undoRef = useRef<{
    orderId: string;
    target: OrderStatus;
    /** Where the card was before the tap, for Undo. */
    from: OrderStatus;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  /** Taps shown on the board but not yet saved; see optimistic-core.ts. */
  const overridesRef = useRef(new Map<string, OrderStatus>());

  /** Moves a card on this screen now, ahead of the server. */
  function showStatus(orderId: string, status: OrderStatus) {
    overridesRef.current.set(orderId, status);
    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, status } : o)),
    );
  }

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

  // One resync at a time. A browser sends server actions one at a time,
  // so ticks that pile up behind a slow resync also hold up every tap;
  // instead a tick during a resync asks for one more afterwards (found in
  // the 2026-10-28 busy-night simulation, with fetch-timeout.ts).
  const resyncInFlightRef = useRef(false);
  const resyncAgainRef = useRef<boolean | null>(null);

  const resync = useCallback(
    async (announceNew: boolean): Promise<void> => {
      if (resyncInFlightRef.current) {
        resyncAgainRef.current =
          (resyncAgainRef.current ?? false) || announceNew;
        return;
      }
      resyncInFlightRef.current = true;
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
        markOffline();
        return;
      } finally {
        resyncInFlightRef.current = false;
        const again = resyncAgainRef.current;
        resyncAgainRef.current = null;
        if (again !== null && isMountedRef.current) {
          queueMicrotask(() => void resyncRef.current(again));
        }
      }
      if (!isMountedRef.current) return;
      if (isStaleResync(seq, resyncSeqRef.current)) return;
      if (announceNew && hasNewPendingOrder(fresh, knownIdsRef.current)) {
        play();
      }
      // Auto-print, on the device that has it on. Not tied to announceNew:
      // an order that arrived while the screen was asleep is still new to
      // this printer when the board wakes and catches up.
      const print = printRef.current;
      if (print.canPrint && print.printer.autoPrint) {
        for (const order of ordersToAutoPrint(fresh, knownIdsRef.current)) {
          printTicket(
            kitchenTicketHtml(order, {
              restaurantName: print.restaurantName,
              timeZone: print.timeZone,
              paper: print.printer.paper,
            }),
          );
        }
      }
      knownIdsRef.current = new Set(fresh.map((o) => o.id));
      setOrders(withOverrides(fresh, overridesRef.current));
      // Reached the server: back online, and any taps made offline go now.
      setOfflineSince(null);
      if (tapQueueRef.current.length > 0) void drainRef.current();
    },
    [restaurantId, play, markOffline],
  );
  // The latest resync(), for the follow-up run above.
  const resyncRef = useRef(resync);
  useEffect(() => {
    resyncRef.current = resync;
  }, [resync]);

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
    // Broadcast from the database (20261127090000): orders and payments
    // for this restaurant. Payments don't change the board.
    const closeChannel = listenToTopic(
      supabase,
      `orders:restaurant:${restaurantId}`,
      {
        onMessage: (change) => {
          if (change.table !== "orders") return;
          scheduleResync(true);
          if (change.status === "cancelled" && typeof change.id === "string") {
            void noticeGuestCancel(
              change.id,
              typeof change.order_number === "number"
                ? change.order_number
                : undefined,
            );
          }
        },
        onStatus: (status) => {
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
        },
      },
    );

    /**
     * A diner can cancel their own order before it's accepted
     * (customer_cancel_order). Its card just disappears, so say why —
     * only when it was the guest, read from the order's history.
     */
    async function noticeGuestCancel(orderId: string, orderNumber?: number) {
      const { data } = await supabase
        .from("order_status_history")
        .select("actor_type")
        .eq("order_id", orderId)
        .eq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data?.actor_type !== "customer") return;
      setGuestCancelNotice(
        `Order${orderNumber ? ` #${orderNumber}` : ""} was cancelled by the guest before it was accepted.`,
      );
    }

    function handleWake() {
      if (document.visibilityState === "visible") scheduleResync(false);
    }
    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("online", handleWake);

    return () => {
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("online", handleWake);
      if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
      closeChannel();
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
    // Only one tap waits at a time: a second one sends the first now.
    flushUndo();
    const from = orders.find((o) => o.id === orderId)?.status;
    setActionError(null);
    // The card moves now; the server is told after the undo window.
    showStatus(orderId, target);
    if (!offersUndo(target) || !from) {
      sendTransition(orderId, target);
      return;
    }
    const timer = setTimeout(() => {
      undoRef.current = null;
      setUndo(null);
      sendTransition(orderId, target);
    }, UNDO_WINDOW_MS);
    undoRef.current = { orderId, target, from, timer };
    setUndo({ orderId, target });
  }

  function cancelUndo() {
    const waiting = undoRef.current;
    if (!waiting) return;
    clearTimeout(waiting.timer);
    undoRef.current = null;
    setUndo(null);
    // Nothing was sent: put the card back where it was.
    overridesRef.current.delete(waiting.orderId);
    setOrders((prev) =>
      prev.map((o) =>
        o.id === waiting.orderId ? { ...o, status: waiting.from } : o,
      ),
    );
  }

  /** Sends the waiting tap now rather than losing it. */
  function flushUndo() {
    const waiting = undoRef.current;
    if (!waiting) return;
    clearTimeout(waiting.timer);
    undoRef.current = null;
    setUndo(null);
    sendTransition(waiting.orderId, waiting.target);
  }

  // A tablet put to sleep, or the page left, mid-window: the cook meant
  // the tap, so it is sent rather than dropped.
  const flushRef = useRef(flushUndo);
  useEffect(() => {
    flushRef.current = flushUndo;
  });
  useEffect(() => {
    const flush = () => flushRef.current();
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  function queueTap(orderId: string, target: OrderStatus) {
    tapQueueRef.current = enqueueTap(tapQueueRef.current, { orderId, target });
    setQueuedTaps(tapQueueRef.current.length);
  }

  /**
   * Sends the taps made offline, oldest first, one at a time: the server
   * only accepts a card's steps in order. Stops at the first one that
   * still can't get through. One the server refuses (the card moved on
   * elsewhere meanwhile) drops that card's later taps; the resync after
   * shows the card where it really is.
   */
  const drainingRef = useRef(false);
  async function drainTapQueue() {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (tapQueueRef.current.length > 0) {
        const tap = tapQueueRef.current[0];
        let result;
        try {
          result = await transitionOrderStatus(
            tap.orderId,
            tap.target as OrderStatus,
          );
        } catch {
          markOffline();
          return;
        }
        tapQueueRef.current = result.error
          ? dropLaterTapsFor(tapQueueRef.current, tap.orderId)
          : tapQueueRef.current.slice(1);
        if (
          result.error ||
          !tapQueueRef.current.some((t) => t.orderId === tap.orderId)
        ) {
          overridesRef.current.delete(tap.orderId);
        }
        setQueuedTaps(tapQueueRef.current.length);
      }
    } finally {
      drainingRef.current = false;
      setQueuedTaps(tapQueueRef.current.length);
      if (isMountedRef.current) void resyncRef.current(false);
    }
  }
  useEffect(() => {
    drainRef.current = drainTapQueue;
  });

  useEffect(() => {
    window.addEventListener("offline", markOffline);
    return () => window.removeEventListener("offline", markOffline);
  }, [markOffline]);

  // While offline, keep the banner's clock moving.
  useEffect(() => {
    if (offlineSince === null) return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [offlineSince]);

  function sendTransition(orderId: string, target: OrderStatus) {
    // Taps already waiting go first, so this one waits behind them.
    if (tapQueueRef.current.length > 0) {
      queueTap(orderId, target);
      return;
    }
    startTransitionAction(async () => {
      let result;
      try {
        result = await transitionOrderStatus(orderId, target);
      } catch {
        // Couldn't reach the server. The card stays where the cook put
        // it, and the tap is sent when the board reconnects.
        queueTap(orderId, target);
        markOffline();
        return;
      }
      // Saved or refused, this tap no longer needs holding on screen —
      // unless a newer tap on the same card has replaced it.
      if (overridesRef.current.get(orderId) === target) {
        overridesRef.current.delete(orderId);
      }
      if (result.error) setActionError(result.error);
      // On an error this puts the card back where the server has it.
      void resync(false);
    });
  }

  function handleGroupTransition(ticketGroupId: string, target: OrderStatus) {
    setActionError(null);
    startTransitionAction(async () => {
      let result;
      try {
        result = await transitionTicketGroupStatus(ticketGroupId, target);
      } catch {
        markOffline();
        setActionError(KITCHEN_NOT_SENT);
        return;
      }
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
      let result;
      try {
        result = await setStationDone(orderId, stationId, done);
      } catch {
        result = { error: KITCHEN_NOT_SENT };
        markOffline();
      }
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
    let result;
    try {
      result = await splitOrderIntoTickets(orderId, groups);
    } catch {
      markOffline();
      return { error: KITCHEN_NOT_SENT };
    }
    if (!result.error) void resync(false);
    return result;
  }

  async function handleMerge(orderIds: string[], label: string | null) {
    let result;
    try {
      result = await mergeOrdersIntoTicket(orderIds, label);
    } catch {
      markOffline();
      return { error: KITCHEN_NOT_SENT };
    }
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
        <div className="flex flex-wrap items-center gap-2">
          {toolbar}
          {canPrint && (
            <PrinterSettingsButton
              settings={printer}
              onChange={updatePrinter}
              onTestPrint={() =>
                printTicket(
                  kitchenTicketHtml(
                    { ...TEST_TICKET, createdAt: new Date().toISOString() },
                    { restaurantName, timeZone, paper: printer.paper },
                  ),
                )
              }
            />
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={toggleMuted}
          >
            {muted ? "Unmute alerts" : "Mute alerts"}
          </Button>
        </div>
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

      {shouldShowOfflineBanner(offlineSince, now) && offlineSince && (
        <div
          role="alert"
          className="border-destructive bg-destructive/10 text-destructive flex flex-col gap-1 rounded-md border-2 px-4 py-3 text-sm"
        >
          <p className="font-semibold">
            Offline since{" "}
            {new Date(offlineSince).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
            . New orders can&apos;t reach this screen until the connection is
            back.
          </p>
          <p>
            Check the restaurant&apos;s internet. Staff phones on mobile data
            still get order alerts.
            {queuedTapsLabel(queuedTaps) &&
              ` ${queuedTapsLabel(queuedTaps)}; they'll go as soon as it's back.`}
          </p>
        </div>
      )}

      {actionError && (
        <div className="border-destructive/50 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {actionError}
        </div>
      )}

      {guestCancelNotice && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm font-medium"
        >
          {guestCancelNotice}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setGuestCancelNotice(null)}
          >
            OK
          </Button>
        </div>
      )}

      {/*
        Five columns never fit a phone, so the board scrolls sideways and
        snaps a column at a time — each column is its own panel, so a partly
        visible next column reads as "there's more", not as clipping.
      */}
      <div className="-mx-4 flex flex-1 snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:snap-none sm:px-0">
        {BOARD_COLUMNS.map((status) => {
          const columnOrders = orderColumn(
            visibleOrders.filter((o) => o.status === status),
            now,
          );
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
                    now={now}
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

      {undo && (
        <div
          role="status"
          aria-live="polite"
          className="bg-foreground text-background fixed inset-x-3 bottom-4 z-30 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl px-4 py-3 shadow-lg"
        >
          <span className="text-sm font-medium">
            {undoMessage(orderNumberById.get(undo.orderId), undo.target)}
          </span>
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 px-5 font-semibold"
            onClick={cancelUndo}
          >
            Undo
          </Button>
        </div>
      )}

      <OrderDetailDialog
        networkPrintFor={kitchenPrinter ? restaurantId : undefined}
        onPrint={
          canPrint ? (order) => printTicket(ticketFor(order, true)) : undefined
        }
        // The latest copy, so a pickup time moved from the dialog shows its
        // new time there too, and a second push starts from it.
        order={
          detailOrder
            ? (orders.find((o) => o.id === detailOrder.id) ?? detailOrder)
            : null
        }
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
