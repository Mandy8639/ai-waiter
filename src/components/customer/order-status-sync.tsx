"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { listenToTopic } from "@/lib/supabase/realtime";
import {
  resolvePagePollIntervalMs,
  shouldPollNow,
} from "@/components/kitchen/kds-reconciliation";

/**
 * Renders nothing — keeps the customer order confirmation page's status
 * live as staff move it through the kitchen workflow (Batch 6), by
 * triggering a server refetch (`router.refresh()`, which re-runs
 * getOrderById()) whenever this order's row changes, rather than
 * duplicating status-display logic into client-side state.
 *
 * Realtime + polling fallback, mirroring the kitchen board (a Broadcast
 * message can always be missed: a dropped socket, a phone asleep): a normal-interval
 * poll acts as a safety net while Realtime is healthy, a faster
 * degraded-interval poll takes over while it's disconnected. Both
 * intervals and the tab-hidden rule come from kds-reconciliation.ts, the
 * same pure logic the kitchen board uses, at the slower full-page
 * intervals (resolvePagePollIntervalMs): each tick here re-renders the
 * whole page. There's no dedup/staleness concern to port over from that
 * file's list-reconciliation logic: `router.refresh()` always re-fetches
 * current truth server-side, so redundant triggers are harmless, just
 * debounced (see scheduleResync) to avoid firing it needlessly often.
 *
 * RLS (`orders_select_own_or_staff`, unchanged since Batch 5) is what
 * actually scopes which row changes this subscription can ever receive —
 * the `filter` below narrows bandwidth, it isn't the security boundary,
 * the same as the kitchen board's subscription (see
 * docs/security.md#realtime-security). Also resyncs on tab-visible and
 * network-online, so a phone that was asleep or offline catches up rather
 * than assuming it didn't miss anything.
 */
export function OrderStatusSync({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleResync = useCallback(() => {
    if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
    resyncTimerRef.current = setTimeout(() => {
      router.refresh();
    }, 250);
  }, [router]);

  useEffect(() => {
    const supabase = createClient();
    // Broadcast from the database (20261127090000): this order's own
    // private topic, open to its diner and the restaurant's staff.
    const closeChannel = listenToTopic(supabase, `orders:order:${orderId}`, {
      onMessage: () => scheduleResync(),
      onStatus: (status) => {
        if (status === "SUBSCRIBED") {
          setConnected(true);
          scheduleResync();
        } else if (
          status === "CLOSED" ||
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT"
        ) {
          setConnected(false);
        }
      },
    });

    function handleWake() {
      if (document.visibilityState === "visible") scheduleResync();
    }
    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("online", handleWake);

    return () => {
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("online", handleWake);
      if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
      closeChannel();
    };
  }, [orderId, scheduleResync]);

  // Polling safety net — kitchen-board.tsx's pattern, at the full-page
  // intervals. A separate effect from the Realtime subscription
  // above so `connected` flipping never tears down/rebuilds the channel,
  // only restarts this timer.
  useEffect(() => {
    const intervalMs = resolvePagePollIntervalMs(connected);
    const timer = setInterval(() => {
      if (!shouldPollNow(document.visibilityState)) return;
      scheduleResync();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [connected, scheduleResync]);

  return null;
}
