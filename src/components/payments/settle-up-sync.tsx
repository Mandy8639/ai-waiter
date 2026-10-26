"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  resolvePollIntervalMs,
  shouldPollNow,
} from "@/components/kitchen/kds-reconciliation";

/** How often to look again while a dialog is open. */
const DIALOG_RETRY_MS = 2_000;

/**
 * Renders nothing — keeps Settle up current: a new order, an adjusted bill,
 * or a diner paying on their phone shows up without anyone refreshing, so
 * staff never charge a table that already paid. Same shape as
 * OrderStatusSync: Realtime on this restaurant's orders and payments
 * (order_payments joined the publication in 20261113090000) triggers a
 * server refetch, with the kitchen board's polling safety net behind it.
 *
 * It waits while any dialog is open. A refresh mid-payment would re-render
 * the dialog's table out from under it — a Square Terminal payment that
 * just landed would take the table, and its "Paid" confirmation, off the
 * screen (the reason square-terminal-dialog.tsx refreshes only on Done).
 * Once the dialog closes, the waiting refresh runs.
 *
 * RLS scopes which rows reach this subscription; the filter only narrows
 * bandwidth (docs/security.md#realtime-security).
 */
export function SettleUpSync({ restaurantId }: { restaurantId: string }) {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleResync = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const run = () => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        timerRef.current = setTimeout(run, DIALOG_RETRY_MS);
        return;
      }
      timerRef.current = null;
      router.refresh();
    };
    timerRef.current = setTimeout(run, 250);
  }, [router]);

  useEffect(() => {
    const supabase = createClient();
    const filter = `restaurant_id=eq.${restaurantId}`;
    const channel = supabase
      .channel(`settle-up:${restaurantId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders", filter },
        () => scheduleResync(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "order_payments", filter },
        () => scheduleResync(),
      )
      .subscribe((status) => {
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
      });

    function handleWake() {
      if (document.visibilityState === "visible") scheduleResync();
    }
    document.addEventListener("visibilitychange", handleWake);
    window.addEventListener("online", handleWake);

    return () => {
      document.removeEventListener("visibilitychange", handleWake);
      window.removeEventListener("online", handleWake);
      if (timerRef.current) clearTimeout(timerRef.current);
      void supabase.removeChannel(channel);
    };
  }, [restaurantId, scheduleResync]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!shouldPollNow(document.visibilityState)) return;
      scheduleResync();
    }, resolvePollIntervalMs(connected));
    return () => clearInterval(timer);
  }, [connected, scheduleResync]);

  return null;
}
