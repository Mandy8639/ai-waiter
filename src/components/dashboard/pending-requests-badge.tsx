"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { listenToTopic } from "@/lib/supabase/realtime";
import { countPendingRequestsFromBrowser } from "@/lib/notifications/count-pending";
import {
  resolvePollIntervalMs,
  shouldPollNow,
} from "@/components/kitchen/kds-reconciliation";

/**
 * A live count of booking requests waiting to be accepted, shown in the
 * nav beside Reservations.
 *
 * In the nav rather than on the reservations page on purpose: a staff
 * member who is on Kitchen or Menu is exactly the person who would
 * otherwise never learn a request arrived, and they are the reason this
 * exists at all.
 *
 * Realtime is the primary signal: a Broadcast message on the restaurant's
 * private `reservations:restaurant:<id>` topic (20261127090000). A message
 * can always be missed, so the count is also re-read when the tab
 * becomes visible and when the browser regains network. A missed event
 * then costs a staff member a tab switch, not a lost booking.
 *
 * Only owners, managers and front of house may join the topic, the same
 * rule as reading bookings, and the count reads through RLS
 * (docs/security.md#realtime-security).
 */
export function PendingRequestsBadge({
  restaurantId,
  initialCount,
}: {
  restaurantId: string;
  initialCount: number;
}) {
  const [count, setCount] = useState(initialCount);
  const [connected, setConnected] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The nav is rendered twice (the desktop aside and the mobile drawer),
  // so two badges can be mounted at once. listenToTopic() shares one
  // channel between them and closes it with the last.

  const refresh = useCallback(async () => {
    const next = await countPendingRequestsFromBrowser(restaurantId);
    // null means the query failed. Keeping the previous number is better
    // than flashing "none" at someone because one request blipped.
    if (next !== null) setCount(next);
  }, [restaurantId]);

  // Several rows can change at once — accepting a request updates one row
  // and a diner may submit while staff are working — so events are
  // coalesced rather than each triggering its own count.
  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void refresh(), 250);
  }, [refresh]);

  useEffect(() => {
    const supabase = createClient();
    const closeChannel = listenToTopic(
      supabase,
      `reservations:restaurant:${restaurantId}`,
      {
        onMessage: scheduleRefresh,
        onStatus: (status) => {
          // Tracking the status is what lets the poll below speed up when
          // the channel isn't live.
          if (status === "SUBSCRIBED") {
            setConnected(true);
            scheduleRefresh();
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
      if (document.visibilityState === "visible") scheduleRefresh();
    }
    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("online", handleWake);

    return () => {
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("online", handleWake);
      if (timerRef.current) clearTimeout(timerRef.current);
      closeChannel();
    };
  }, [restaurantId, scheduleRefresh]);

  // Polling safety net, the same one the kitchen board runs and for the
  // same reason (a live message can always be missed). Without it, a subscription that
  // silently fails to deliver leaves the badge frozen until the next full
  // page load — which is exactly what was observed before this was added,
  // with the table correctly in the publication the whole time.
  //
  // A separate effect from the subscription above so that `connected`
  // flipping restarts only this timer, never the channel itself.
  useEffect(() => {
    const intervalMs = resolvePollIntervalMs(connected);
    const timer = setInterval(() => {
      if (!shouldPollNow(document.visibilityState)) return;
      void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [connected, refresh]);

  if (count === 0) return null;

  return (
    <span
      className="bg-primary text-primary-foreground ml-2 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums"
      // Read out as words rather than a bare number, which on its own
      // tells a screen-reader user nothing about what it counts.
      aria-label={`${count} booking ${count === 1 ? "request" : "requests"} waiting`}
    >
      {count}
    </span>
  );
}
