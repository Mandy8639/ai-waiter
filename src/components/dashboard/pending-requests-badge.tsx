"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { openAuthorizedChannel } from "@/lib/supabase/realtime";
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
 * Realtime is the primary signal, with the same caveat the kitchen board
 * documents (Supabase ticket SU-452145: postgres_changes INSERT delivery
 * is not always reliable), so the count is also re-read when the tab
 * becomes visible and when the browser regains network. A missed event
 * then costs a staff member a tab switch, not a lost booking.
 *
 * The `filter` below is a bandwidth optimisation, NOT the security
 * boundary — RLS is what stops another restaurant's rows ever reaching
 * this client (docs/security.md#realtime-security).
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

  // The nav is rendered TWICE — once in the desktop aside, once inside the
  // mobile dropdown — and both are mounted at the same time, hidden only by
  // CSS. supabase.channel(topic) returns the EXISTING channel when one with
  // that topic is already open, so two badges sharing a topic meant the
  // second called .on() on an already-subscribed channel, which throws:
  //
  //   cannot add `postgres_changes` callbacks ... after `subscribe()`
  //
  // A per-instance topic keeps the two subscriptions distinct. The cost is
  // one extra subscription on small viewports; the alternative — lifting
  // this into a shared provider so the nav subscribes once — is the right
  // shape if a second badge ever appears, but is more machinery than one
  // count needs today.
  //
  // The topic is display-only: RLS and the filter below are what scope the
  // data, and neither depends on this string.
  const instanceId = useId();

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
    const closeChannel = openAuthorizedChannel(supabase, () =>
      supabase
        .channel(`reservations:restaurant:${restaurantId}:${instanceId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "reservations",
            filter: `restaurant_id=eq.${restaurantId}`,
          },
          scheduleRefresh,
        )
        .subscribe((status) => {
          // Previously `.subscribe()` with no callback, which meant a
          // subscription that never connected was completely invisible —
          // the badge simply sat there looking correct. Tracking the status
          // is what lets the poll below speed up instead.
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
        }),
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
  }, [restaurantId, scheduleRefresh, instanceId]);

  // Polling safety net, the same one the kitchen board runs and for the
  // same documented reason (Supabase ticket SU-452145: postgres_changes
  // delivery is not always reliable). Without it, a subscription that
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
