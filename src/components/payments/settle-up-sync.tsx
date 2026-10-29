"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { listenToTopic } from "@/lib/supabase/realtime";
import {
  resolvePagePollIntervalMs,
  shouldPollNow,
} from "@/components/kitchen/kds-reconciliation";

/** How often to look again while a dialog is open. */
const DIALOG_RETRY_MS = 2_000;
/**
 * At most one refresh this often. Each one re-renders the whole page; on a
 * busy night orders and payments change every few seconds across the room,
 * and refreshing for each was a large part of the database's load.
 */
const MIN_REFRESH_GAP_MS = 2_500;

/**
 * Renders nothing — keeps Settle up current: a new order, an adjusted bill,
 * or a diner paying on their phone shows up without anyone refreshing, so
 * staff never charge a table that already paid. Same shape as
 * OrderStatusSync: a Broadcast message on this restaurant's private
 * `orders:restaurant:<id>` topic (orders and payments, 20261127090000)
 * triggers a server refetch, with a slower polling safety net behind it.
 *
 * Changes that arrive together share one refresh: one already waiting
 * absorbs the rest, and refreshes are at least MIN_REFRESH_GAP_MS apart.
 *
 * It waits while any dialog is open. A refresh mid-payment would re-render
 * the dialog's table out from under it — a Square Terminal payment that
 * just landed would take the table, and its "Paid" confirmation, off the
 * screen (the reason square-terminal-dialog.tsx refreshes only on Done).
 * Once the dialog closes, the waiting refresh runs.
 *
 * Only the restaurant's members may join the topic, and the refetch reads
 * through RLS (docs/security.md#realtime-security).
 */
export function SettleUpSync({ restaurantId }: { restaurantId: string }) {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshRef = useRef(0);

  const scheduleResync = useCallback(() => {
    if (timerRef.current) return; // the waiting refresh covers this too
    const run = () => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        timerRef.current = setTimeout(run, DIALOG_RETRY_MS);
        return;
      }
      timerRef.current = null;
      lastRefreshRef.current = Date.now();
      router.refresh();
    };
    const sinceLast = Date.now() - lastRefreshRef.current;
    timerRef.current = setTimeout(
      run,
      Math.max(250, MIN_REFRESH_GAP_MS - sinceLast),
    );
  }, [router]);

  useEffect(() => {
    const supabase = createClient();
    // Broadcast from the database (20261127090000): this restaurant's
    // orders and payments, on one private topic.
    const closeChannel = listenToTopic(
      supabase,
      `orders:restaurant:${restaurantId}`,
      {
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
      },
    );

    function handleWake() {
      if (document.visibilityState === "visible") scheduleResync();
    }
    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("online", handleWake);

    return () => {
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("online", handleWake);
      if (timerRef.current) clearTimeout(timerRef.current);
      closeChannel();
    };
  }, [restaurantId, scheduleResync]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!shouldPollNow(document.visibilityState)) return;
      scheduleResync();
    }, resolvePagePollIntervalMs(connected));
    return () => clearInterval(timer);
  }, [connected, scheduleResync]);

  return null;
}
